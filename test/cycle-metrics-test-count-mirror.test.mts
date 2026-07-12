/**
 * Cross-key test-count mirror contract for recordCycleMetrics (issue #3252).
 *
 * `testsAfter` recorded 0 on every sampled cycle because the grounding test
 * counts and the record dashboards read live under DIFFERENT, un-joinable
 * cycleIds:
 *   - reap keys its cycle-record on the bare worktree-hash `task_id` — the
 *     deposit key it can read the grounding test counts from. So testsAfter
 *     lands on THAT record.
 *   - the merge-watch enrichment (holdback-merge-watch.ts) + the dashboards read
 *     the SEPARATE record keyed on the synthesised `worktreeBranch`
 *     (`worktree-agent-<runToken>-t<N>-<slot>`, a run-token-shaped id) — which
 *     never received the counts.
 * The two tokens (worktree-hash vs run-token) cannot be derived from each other,
 * so no read-side join recovers testsAfter. reap now forwards `worktreeBranch`
 * and `recordCycleMetrics` mirrors just the four test-count fields onto the
 * branch-keyed record, so the sampled record finally carries them.
 *
 * These tests pin that mirror against real Redis.
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

describe("recordCycleMetrics test-count mirror (issue #3252)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  test("reap's bare-hash write mirrors testsAfter onto the branch-keyed record", async () => {
    const cycleId = "a8d148355c9c2211f"; // bare worktree-hash task_id (reap's key)
    const branch = "worktree-agent-15dc1488-t3-dev_orch"; // the sampled record's key
    await recordCycleMetrics(cycleId, {
      testsBefore: 6100,
      testsAfter: 6120,
      testsPassingBefore: 6098,
      testsPassingAfter: 6117,
      worktreeBranch: branch,
      tasksMerged: 1,
    });

    // The bare-hash record still carries the counts (reap's own write).
    const bare = await getCycleMetrics(cycleId);
    assert.equal(bare.testsAfter, "6120", "reap's own record keeps testsAfter");

    // The branch record — the one dashboards read — now carries them too.
    const b = await getCycleMetrics(branch);
    assert.equal(b.testsAfter, "6120", "testsAfter mirrored onto the branch record");
    assert.equal(b.testsBefore, "6100");
    assert.equal(b.testsPassingBefore, "6098");
    assert.equal(b.testsPassingAfter, "6117");
  });

  test("the mirror enriches a branch record already written by merge-watch", async () => {
    const cycleId = "a5aa4787b38567ce5";
    const branch = "worktree-agent-35fea1b1-t10-dev_orch";
    // merge-watch enriched the branch record FIRST (prNumber, no testsAfter).
    await recordCycleMetrics(branch, {
      prNumber: "3136",
      filesChanged: 2,
      anchorReference: "issue-3136",
      status: "merged",
      tasksMerged: 1,
    });
    // reap's later write (bare-hash key) carries the counts + the branch pointer.
    await recordCycleMetrics(cycleId, {
      testsAfter: 5955,
      testsPassingAfter: 5950,
      worktreeBranch: branch,
    });

    const b = await getCycleMetrics(branch);
    // The merge-watch metadata survives (additive HSET, disjoint fields)...
    assert.equal(b.prNumber, "3136", "merge-watch prNumber untouched");
    assert.equal(b.anchorReference, "issue-3136");
    assert.equal(b.filesChanged, "2");
    // ...and the mirror added the counts the branch record was missing.
    assert.equal(b.testsAfter, "5955", "testsAfter mirrored onto the enriched record");
    assert.equal(b.testsPassingAfter, "5950");
  });

  test("mirror is skipped when worktreeBranch equals the cycleId (no self-mirror)", async () => {
    // holdback-merge-watch writes cycleId == the branch and carries no
    // worktreeBranch field — but even if it did, a branch == cycleId write must
    // not fan out a redundant self-write.
    const branch = "worktree-agent-c314c734-t3-dev_orch";
    await recordCycleMetrics(branch, {
      testsAfter: 6000,
      worktreeBranch: branch, // same key
      prNumber: "9999",
    });
    const b = await getCycleMetrics(branch);
    assert.equal(b.testsAfter, "6000", "the write itself still records testsAfter");
    // Only one metrics key exists — no phantom second record was minted.
    const keys = await testRedis.keys("hydra:metrics:*");
    const cycleKeys = keys.filter((k: string) => k !== "hydra:metrics:index");
    assert.equal(cycleKeys.length, 1, "no extra record created by a self-referential branch");
  });

  test("no worktreeBranch → no mirror (unchanged prior behaviour)", async () => {
    const cycleId = "a0d65a4c6a614ae6f";
    await recordCycleMetrics(cycleId, { testsAfter: 6040, tasksMerged: 1 });
    const m = await getCycleMetrics(cycleId);
    assert.equal(m.testsAfter, "6040");
    // Exactly one cycle record — the mirror never fired.
    const keys = await testRedis.keys("hydra:metrics:*");
    const cycleKeys = keys.filter((k: string) => k !== "hydra:metrics:index");
    assert.equal(cycleKeys.length, 1, "no branch mirror without a worktreeBranch");
  });

  test("a write with a branch but NO test counts mirrors nothing", async () => {
    const cycleId = "aba8bd9aaef722217";
    const branch = "worktree-agent-deadbeef-t1-dev_orch";
    // A duration/token-only enrichment carrying a branch pointer but no test
    // counts must not create a partial branch record.
    await recordCycleMetrics(cycleId, {
      totalDurationMs: 12345,
      worktreeBranch: branch,
    });
    const b = await getCycleMetrics(branch);
    assert.deepEqual(b, {}, "no mirror write when there are no test counts to copy");
  });

  test("the mirror does NOT add the branch cycleId to the metrics index", async () => {
    const cycleId = "a753548ad9c3885b3";
    const branch = "worktree-agent-6fd1300b-t1-dev_orch";
    await recordCycleMetrics(cycleId, {
      testsAfter: 6001,
      worktreeBranch: branch,
    });
    // reap's own key is indexed (setCycleMetrics zadds it); the mirrored branch
    // key must NOT be — the mirror is an enrich, never a fresh index entry.
    const indexed = await testRedis.zrange("hydra:metrics:index", 0, -1);
    assert.ok(indexed.includes(cycleId), "reap's own record is indexed");
    assert.ok(
      !indexed.includes(branch),
      "the mirror never mints a phantom index entry for the branch key",
    );
  });
});
