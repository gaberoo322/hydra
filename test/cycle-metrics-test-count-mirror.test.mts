/**
 * `recordCycleMetrics` no longer runs a cross-key test-count mirror (issue #3391,
 * retiring the #3252 mirror).
 *
 * The #3252 mirror existed because reap keyed its test-count-bearing cycle-record
 * on the bare worktree-hash `task_id` while the merge-watch enrichment + the
 * dashboards read the SEPARATE `worktreeBranch`-keyed record — two un-joinable
 * ids — so `testsAfter` recorded 0 on the sampled record every cycle. The mirror
 * copied the four test fields across, but it surfaced a 2-field, cycleId-less
 * twin the trend read (`if (!raw.cycleId) continue`) discarded anyway, and it
 * risked minting a phantom partial index entry.
 *
 * #3391 removes the root cause instead: reap now POSTs its cycle-record under the
 * synthesised `worktreeBranch` itself, so the test counts and the merge fields
 * land on ONE indexed record per dispatch. There is no branch twin to mirror
 * onto, so `recordCycleMetrics` performs a single `setCycleMetrics` write and
 * NEVER fans out a second cross-key write.
 *
 * These tests pin the NEW invariant against real Redis: a write carrying a
 * `worktreeBranch` field records exactly one metrics key (its own cycleId) — no
 * separate branch record is ever created by the write path.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { recordCycleMetrics } = await import("../src/metrics/record.ts");
const { getCycleMetrics } = await import("../src/redis/cycle-metrics.ts");

let testRedis: any;

async function cleanTestKeys() {
  const keys = await testRedis.keys("hydra:metrics:*");
  if (keys.length > 0) await testRedis.del(...keys);
  await testRedis.del("hydra:metrics:index");
}

function cycleKeyCount(keys: string[]): number {
  return keys.filter((k: string) => k !== "hydra:metrics:index").length;
}

describe("recordCycleMetrics no longer mirrors test counts cross-key (issue #3391)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL!);
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  test("reap's write is now keyed on the branch itself — the counts live on that one record", async () => {
    // Post-#3391 reap keys its cycle-record ON the branch, so `cycleId` here IS
    // the synthesised branch and it also (harmlessly) carries the same value in
    // the worktreeBranch metadata field.
    const branch = "worktree-agent-15dc1488-t3-dev_orch";
    await recordCycleMetrics(branch, {
      testsBefore: 6100,
      testsAfter: 6120,
      testsPassingBefore: 6098,
      testsPassingAfter: 6117,
      worktreeBranch: branch,
      tasksMerged: 1,
    });

    // The record the merge-watch enrichment + dashboards read carries the counts
    // directly — no mirror needed.
    const b = await getCycleMetrics(branch);
    assert.equal(b.testsAfter, "6120", "the branch record carries testsAfter");
    assert.equal(b.testsBefore, "6100");
    assert.equal(b.testsPassingBefore, "6098");
    assert.equal(b.testsPassingAfter, "6117");

    // Exactly one metrics key exists — the write never fans out a second record.
    const keys = await testRedis.keys("hydra:metrics:*");
    assert.equal(cycleKeyCount(keys), 1, "no phantom second record from the write path");
  });

  test("a bare-hash write carrying a DIFFERENT worktreeBranch does NOT create a branch record", async () => {
    // Even if a legacy caller still passes a worktreeBranch that differs from the
    // cycleId, the retired mirror must not resurrect: only the write's own key is
    // ever written.
    const cycleId = "a5aa4787b38567ce5"; // a bare worktree-hash (legacy shape)
    const branch = "worktree-agent-35fea1b1-t10-dev_orch";
    await recordCycleMetrics(cycleId, {
      testsAfter: 5955,
      testsPassingAfter: 5950,
      worktreeBranch: branch, // differs from cycleId
    });

    // The write's own record carries the counts...
    const own = await getCycleMetrics(cycleId);
    assert.equal(own.testsAfter, "5955", "the write's own record carries testsAfter");

    // ...and the branch key was NEVER written (no mirror).
    const b = await getCycleMetrics(branch);
    assert.deepEqual(b, {}, "no cross-key mirror onto the differing branch id");

    const keys = await testRedis.keys("hydra:metrics:*");
    assert.equal(cycleKeyCount(keys), 1, "exactly one record — the write's own key");
  });

  test("the merge-watch enrichment and reap's write now converge on the same branch record", async () => {
    // This is the join #3391 restores end-to-end: merge-watch enriches the branch
    // record with prNumber/filesChanged, reap's test-count write lands on the
    // SAME branch key, and both sets of fields coexist on one indexed record.
    const branch = "worktree-agent-6fd1300b-t1-dev_orch";
    // merge-watch enrichment (prNumber, no test counts).
    await recordCycleMetrics(branch, {
      prNumber: "3391",
      filesChanged: 4,
      anchorReference: "issue-3391",
      status: "merged",
      tasksMerged: 1,
    });
    // reap's test-count write, keyed on the SAME branch (#3391).
    await recordCycleMetrics(branch, {
      testsAfter: 6001,
      testsPassingAfter: 5998,
      worktreeBranch: branch,
    });

    const b = await getCycleMetrics(branch);
    // Merge fields survive (additive HSET)...
    assert.equal(b.prNumber, "3391", "merge-watch prNumber untouched");
    assert.equal(b.filesChanged, "4");
    assert.equal(b.anchorReference, "issue-3391");
    // ...alongside the test counts on the SAME record.
    assert.equal(b.testsAfter, "6001", "testsAfter on the same indexed record");
    assert.equal(b.testsPassingAfter, "5998");

    // The record IS indexed (setCycleMetrics zadds it) and carries a cycleId, so
    // the trend read (`if (!raw.cycleId) continue`) will surface it.
    assert.equal(b.cycleId, branch, "the record carries a cycleId the trend read requires");
    const indexed = await testRedis.zrange("hydra:metrics:index", 0, -1);
    assert.ok(indexed.includes(branch), "the branch record is indexed");

    // Only the one branch record exists.
    const keys = await testRedis.keys("hydra:metrics:*");
    assert.equal(cycleKeyCount(keys), 1, "one converged record, no twin");
  });

  test("no worktreeBranch → a single record, unchanged (signal-class case)", async () => {
    const cycleId = "a0d65a4c6a614ae6f";
    await recordCycleMetrics(cycleId, { testsAfter: 6040, tasksMerged: 1 });
    const m = await getCycleMetrics(cycleId);
    assert.equal(m.testsAfter, "6040");
    const keys = await testRedis.keys("hydra:metrics:*");
    assert.equal(cycleKeyCount(keys), 1, "one record for a branch-less write");
  });
});
