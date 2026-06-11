/**
 * Regression tests for src/backlog/reconciler.ts — merge→done reconciler
 * (issue #1715).
 *
 * Background: marking a target-backlog item `done` after its PR merges
 * depends on the build flow doing it. When that path is missed (agent crash
 * after merge, reaper interference, manual merges) the item lingers in a
 * non-done lane as phantom work — `item-490` sat in `queued` for 9+ hours
 * after hydra-betting PR #109 merged (2026-06-11). The reaper's merged-PR
 * guard (#1714) only covers stale `inProgress` claims; the reconciler closes
 * the general hole across all non-done lanes.
 *
 * Each test corresponds to an acceptance criterion in the issue:
 *   - merged PR ref, item in queued/backlog/inProgress → moved to done with
 *     reconciledAt/reconciledFrom/outcome stamps
 *   - merge-commit ref (cycle merge bypassing PRs) → moved to done
 *   - item without a merged ref → untouched
 *   - feed outage (both fetchers null) → guaranteed no-op
 *   - idempotent: re-running over the same window is a no-op
 *   - closure emits a `merged-item-reconciled` alert (auditable)
 *
 * Feeds are injected via `opts.fetchMergedPrRefs` / `opts.fetchMergeCommitRefs`
 * (same seam style as `reaper.ts` `opts.fetchOpenPrBlobs`) so no test shells
 * out to `gh`.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let admin: any;
let redis: any;
let redisAvailable = false;

// This file shares the `hydra:backlog:*` keyspace shape with backlog.test.mts
// and the two reaper suites. Those are pinned to dedicated logical DBs
// (1/5/6 — see the #1446 note in backlog-stale-claim-reaper.test.mts); pin
// this file to its own DB so concurrent invocations can never clobber a
// sibling's fixtures.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/8";

async function cleanBacklogKeys() {
  const patterns = ["hydra:backlog:*", "hydra:alerts"];
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

/** Inject-nothing feeds: both fetchers report a `gh` outage. */
const OUTAGE_FEEDS = {
  fetchMergedPrRefs: async () => null,
  fetchMergeCommitRefs: async () => null,
};

describe("backlog merge→done reconciler (issue #1715)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch (err) {
        console.error("Redis unavailable, skipping merge-reconciler tests");
        return;
      }
      const reads = await import("../src/backlog/reads.ts");
      const items = await import("../src/backlog/items.ts");
      const lanes = await import("../src/backlog/lanes.ts");
      const reconciler = await import("../src/backlog/reconciler.ts");
      admin = { ...reads, ...items, ...lanes, ...reconciler };
    }
    if (!redisAvailable) return;
    await cleanBacklogKeys();
  });

  after(async () => {
    if (redis) {
      if (redisAvailable) await cleanBacklogKeys();
      redis.disconnect();
    }
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("merged PR ref moves a queued item to done with reconciled stamps (item-490 repro)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Wire scanner output", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-109", blob: `feat(scanner): wire output (${id})\ncloses ${id}` },
      ],
      fetchMergeCommitRefs: async () => [],
    });

    assert.equal(result.feedsAvailable, true);
    assert.equal(result.reconciled.length, 1, "exactly one item reconciled");
    assert.equal(result.reconciled[0].id, id);
    assert.equal(result.reconciled[0].fromLane, "queued");
    assert.equal(result.reconciled[0].ref, "pr-109");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 0, "item must leave queued");
    assert.equal(lanes.done.length, 1);

    const done = lanes.done[0];
    assert.equal(done.id, id);
    assert.equal(done.lane, "done");
    assert.equal(done.meta.reconciledFrom, "pr-109");
    assert.ok(done.meta.reconciledAt, "reconciledAt must be stamped");
    assert.equal(done.meta.outcome, "merged");
    assert.ok(done.meta.completedAt, "completedAt must be set so done-retention prunes it");
    assert.equal(done.checked, true);
  });

  test("merge-commit ref (cycle merge bypassing PRs) moves a backlog-lane item to done", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Calibrate odds feed", category: "test" }); // default lane: backlog

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [],
      fetchMergeCommitRefs: async () => [
        { ref: "commit-f61e9ed", blob: `merge: claude cycle — calibrate odds feed (${id})` },
      ],
    });

    assert.equal(result.reconciled.length, 1);
    assert.equal(result.reconciled[0].fromLane, "backlog");
    assert.equal(result.reconciled[0].ref, "commit-f61e9ed");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.backlog.length, 0);
    assert.equal(lanes.done.length, 1);
    assert.equal(lanes.done[0].meta.reconciledFrom, "commit-f61e9ed");
  });

  test("merged ref moves an inProgress item to done and clears its claim", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Backfill run history", category: "test" });
    await admin.moveToInProgress("Backfill run history", { claimedBy: "claude" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-117", blob: `feat: run history page\n\ncloses ${id}` },
      ],
      fetchMergeCommitRefs: async () => null, // commit feed down — PR feed alone suffices
    });

    assert.equal(result.feedsAvailable, true);
    assert.equal(result.reconciled.length, 1);
    assert.equal(result.reconciled[0].fromLane, "inProgress");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.inProgress.length, 0);
    assert.equal(lanes.done.length, 1);
    // claimedAt/claimedBy cleared by the lane transition out of inProgress.
    assert.equal(lanes.done[0].claimedAt, null);
    assert.equal(lanes.done[0].claimedBy, null);
  });

  test("items without a merged reference are untouched", async (t) => {
    requireRedis(t);

    const { id: untouchedId } = await admin.addToBacklog({ title: "Unrelated future work", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-200", blob: "feat: something about item-99999 only" },
      ],
      fetchMergeCommitRefs: async () => [
        { ref: "commit-abc1234", blob: "merge: claude cycle — other thing (item-88888)" },
      ],
    });

    assert.equal(result.reconciled.length, 0, "nothing may move without a concrete reference");
    assert.ok(result.scanned >= 1, "the untouched item was scanned");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 1);
    assert.equal(lanes.queued[0].id, untouchedId);
    assert.equal(lanes.done.length, 0);
  });

  test("whole-word ID matching: item-3 must not match a PR referencing item-30", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Prefix collision guard", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-300", blob: `feat: superstring ref ${id}0 — different item` },
      ],
      fetchMergeCommitRefs: async () => [],
    });

    assert.equal(result.reconciled.length, 0, "superstring ID must not match");
    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 1);
  });

  test("feed outage (both fetchers null) is a guaranteed no-op", async (t) => {
    requireRedis(t);

    await admin.addToBacklog({ title: "Survives the outage", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems(OUTAGE_FEEDS);

    assert.equal(result.feedsAvailable, false, "both feeds down must be reported");
    assert.equal(result.reconciled.length, 0);

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 1, "no item may move on a feed outage");
    assert.equal(lanes.done.length, 0);
  });

  test("idempotent: a second run over the same window reconciles nothing", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Once and only once", category: "test", lane: "queued" });
    const feeds = {
      fetchMergedPrRefs: async () => [{ ref: "pr-110", blob: `fix: done (${id})` }],
      fetchMergeCommitRefs: async () => [] as any[],
    };

    const first = await admin.reconcileMergedItems(feeds);
    assert.equal(first.reconciled.length, 1);

    const second = await admin.reconcileMergedItems(feeds);
    assert.equal(second.reconciled.length, 0, "done items are not re-reconciled");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.done.length, 1, "item stays done");
  });

  test("each closure emits a merged-item-reconciled alert (auditable)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Audit trail check", category: "test", lane: "queued" });

    await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [{ ref: "pr-111", blob: `chore: cleanup (${id})` }],
      fetchMergeCommitRefs: async () => [],
    });

    const alerts = await redis.lrange("hydra:alerts", 0, -1);
    const matching = alerts
      .map((a: string) => JSON.parse(a))
      .filter((a: any) => a.type === "merged-item-reconciled");
    assert.equal(matching.length, 1);
    assert.equal(matching[0].payload.itemId, id);
    assert.equal(matching[0].payload.fromLane, "queued");
    assert.equal(matching[0].payload.reconciledFrom, "pr-111");
    assert.ok(matching[0].ts, "alert carries a timestamp");
  });

  test("empty feeds (available but nothing merged) is a no-op without scanning movement", async (t) => {
    requireRedis(t);

    await admin.addToBacklog({ title: "Quiet repo day", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [],
      fetchMergeCommitRefs: async () => [],
    });

    assert.equal(result.feedsAvailable, true);
    assert.equal(result.reconciled.length, 0);
    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 1);
  });
});
