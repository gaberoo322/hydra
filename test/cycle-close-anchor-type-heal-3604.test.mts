/**
 * Enrichment-path anchorType HEAL (issue #3604, follow-up to #3585/#3579).
 *
 * # The gap this pins
 *
 * reap.py is the SOLE cycle-record first-writer and files a record at
 * `status='completed'` the moment a dispatch reaps — BEFORE the merge is known.
 * For a bare-UUID cycleId (a relay / dropped-arm first-write whose cycleId
 * carries no `-t{N}-<slot>` fence and whose worktree branch was empty), reap has
 * no decode source, so `classifyAnchorType` stamps the honest `unclassified`
 * sentinel onto the metrics hash.
 *
 * When that PR later LANDS, a follow-up enrichment write arrives — from
 * `holdback-merge-watch.ts` (forwarding the merged PR's `worktreeBranch`) or the
 * `cycle-merge-reconcile.ts` backstop. That follow-up frequently carries a
 * NEWLY-decodable source: an explicit `anchorType`, or a fenced head-branch ref
 * (`worktree-agent-<tok>-t{N}-<slot>`) that decodes the class the bare cycleId
 * lacks. But before #3604 the dedup/enrichment arm of `recordCycle` only ever
 * enriched `filesChanged`/`prNumber`/`totalDurationMs` + the completed→merged
 * status upgrade — it NEVER re-evaluated the stored `anchorType`. So a cycle that
 * first-wrote `unclassified` stayed `unclassified` forever, even once a decodable
 * source arrived. That is the 24%-unclassified rate #3585's deploy failed to move
 * (issue #3604): the fix added the decode source but the enrichment path threw it
 * away.
 *
 * # The heal (this suite pins it)
 *
 * On the enrichment path, when the STORED anchorType is a data-quality sentinel
 * (`unclassified`, or absent/`unknown`), re-run the same never-guess
 * `classifyAnchorType` parser over the newly-arrived sources (explicit
 * `anchorType`, `worktreeBranch` head ref, the cycleId) and, if a REAL class is
 * recovered, upgrade the stored anchorType in place (metrics-hash-only HSET, no
 * counter re-fire). NEVER-GUESS (#2822) and NEVER-DOWNGRADE are preserved: a
 * genuine stored class is never overwritten, and an undecodable follow-up leaves
 * the sentinel untouched.
 *
 * Exercises `recordCycle` against real Redis DB 1 (never production DB 0), like
 * the sibling `cycle-close.test.mts` suite.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const { recordCycle } = await import("../src/autopilot/cycle-close.ts");
const { getCycleMetrics } = await import("../src/redis/cycle-metrics.ts");

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

describe("enrichment-path anchorType heal (issue #3604)", () => {
  beforeEach(async () => {
    if (!redis) redis = new Redis(REDIS_URL);
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  test("a bare-UUID cycle first-written 'unclassified' HEALS when a later merged enrichment forwards a decodable worktreeBranch", async () => {
    // A bare-UUID cycleId — no -t{N}-<slot> fence, so reap could not decode it.
    const cycleId = "4a2fc33e-9478-49dc-88cd-69dd393787dd";

    // First write (reap-time 'completed'): no anchorType, no decodable cycleId →
    // stamps the honest `unclassified` sentinel.
    const first = await recordCycle({
      cycleId,
      status: "completed",
      source: "claude",
      tasksAttempted: 1,
      tasksMerged: 0,
    });
    assert.equal(first.ok, true);
    let m = await getCycleMetrics(cycleId);
    assert.equal(m.anchorType, "unclassified", "first write stamps the sentinel");

    // Later enrichment (merge landed): merge-watch forwards the merged PR's
    // fenced head branch, which decodes the dispatch class the bare cycleId lacks.
    const second = await recordCycle({
      cycleId,
      status: "merged",
      tasksMerged: 1,
      prNumber: 3600,
      worktreeBranch: "worktree-agent-4a2fc33e-t2-dev_orch-3600",
    });
    assert.equal(second.ok, true);
    assert.equal(second.deduped, true, "second post is a dedup/enrichment, not a first write");

    m = await getCycleMetrics(cycleId);
    assert.equal(
      m.anchorType,
      "work-queue",
      "the stored sentinel HEALS to the class decoded from the forwarded head branch",
    );
    // The completed→merged upgrade still fires alongside the heal (tasksMerged
    // is on the metrics hash; the cycle-hash `status` transition is pinned by the
    // #2860 suite — here we assert the heal did not disturb it).
    assert.equal(m.tasksMerged, "1", "the completed→merged tasksMerged bump still fired");
  });

  test("a bare-UUID cycle first-written 'unclassified' HEALS when a later enrichment forwards an explicit anchorType", async () => {
    const cycleId = "5959d1f2-a804-4a2b-ab11-2b40d0b3a026";
    const first = await recordCycle({
      cycleId,
      status: "completed",
      source: "claude",
      tasksAttempted: 1,
    });
    assert.equal(first.ok, true);
    assert.equal((await getCycleMetrics(cycleId)).anchorType, "unclassified");

    // The reconcile/self-arm path can forward the real anchorType off the pending
    // entry — a genuine class must heal the sentinel.
    const second = await recordCycle({
      cycleId,
      status: "merged",
      tasksMerged: 1,
      prNumber: 3592,
      anchorType: "grill",
    });
    assert.equal(second.ok, true);
    assert.equal(
      (await getCycleMetrics(cycleId)).anchorType,
      "grill",
      "an explicit forwarded anchorType heals the sentinel",
    );
  });

  test("NEVER-GUESS: an undecodable follow-up leaves the sentinel untouched", async () => {
    const cycleId = "afa22ef1-7e11-41e6-a78f-c725b46c7870";
    await recordCycle({ cycleId, status: "completed", source: "claude" });
    assert.equal((await getCycleMetrics(cycleId)).anchorType, "unclassified");

    // Follow-up carries a bare-hash head branch with NO -t{N}-<slot> fence and no
    // explicit anchorType — undecodable, so the honest sentinel must stand.
    const second = await recordCycle({
      cycleId,
      status: "merged",
      tasksMerged: 1,
      prNumber: 3581,
      worktreeBranch: "worktree-agent-ab91ac60dc99081cd",
    });
    assert.equal(second.ok, true);
    assert.equal(
      (await getCycleMetrics(cycleId)).anchorType,
      "unclassified",
      "an undecodable follow-up never fabricates a class (#2822)",
    );
  });

  test("NEVER-DOWNGRADE: a genuine stored class is not overwritten by a later sentinel-only enrichment", async () => {
    const cycleId = "worktree-agent-3604aaaa-t1-dev_orch";
    // First write carries a real class.
    await recordCycle({
      cycleId,
      status: "completed",
      source: "claude",
      anchorType: "work-queue",
    });
    assert.equal((await getCycleMetrics(cycleId)).anchorType, "work-queue");

    // A later enrichment with NO anchorType and NO decodable branch must NOT
    // clobber the genuine stored class down to the sentinel.
    await recordCycle({
      cycleId,
      status: "merged",
      tasksMerged: 1,
      prNumber: 3574,
      worktreeBranch: "worktree-agent-ab91ac60dc99081cd", // undecodable
    });
    assert.equal(
      (await getCycleMetrics(cycleId)).anchorType,
      "work-queue",
      "a genuine class is never downgraded by a later enrichment",
    );
  });

  test("NEVER-OVERWRITE a genuine class with a DIFFERENT decodable source (stored real class is authoritative)", async () => {
    const cycleId = "worktree-agent-3604bbbb-t1-qa_orch";
    // First write: a real qa-review class.
    await recordCycle({
      cycleId,
      status: "completed",
      source: "claude",
      anchorType: "qa-review",
    });
    assert.equal((await getCycleMetrics(cycleId)).anchorType, "qa-review");

    // A later enrichment forwards a branch that would decode differently — the
    // heal only fires for a SENTINEL stored value, so the genuine class stands.
    await recordCycle({
      cycleId,
      status: "merged",
      tasksMerged: 1,
      prNumber: 3572,
      worktreeBranch: "worktree-agent-3604bbbb-t2-dev_orch-3572",
    });
    assert.equal(
      (await getCycleMetrics(cycleId)).anchorType,
      "qa-review",
      "the heal never touches a non-sentinel stored anchorType",
    );
  });
});
