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
 *   - blocked-lane items are NEVER reconciled even with a merged ref
 *     (design-concept invariant 3 — operator-attention lane)
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

  test("blocked-lane items are NEVER reconciled, even with a matching merged ref (invariant 3)", async (t) => {
    requireRedis(t);

    // The blocked lane is an operator-attention lane: a blocked item with a
    // merged PR still needs its blocker resolved by a human/agent decision,
    // never a silent auto-done (approved design-concept invariant 3).
    const { id } = await admin.addToBacklog({ title: "Blocked despite merge", category: "test", lane: "queued" });
    await admin.blockByTitle("Blocked despite merge", "waiting on operator decision");

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-112", blob: `feat: lands the work anyway (${id})\ncloses ${id}` },
      ],
      fetchMergeCommitRefs: async () => [
        { ref: "commit-beef123", blob: `merge: claude cycle — blocked item work (${id})` },
      ],
    });

    assert.equal(result.reconciled.length, 0, "a blocked item must never be auto-reconciled");
    assert.equal(result.scanned, 0, "the blocked lane must not even be scanned");

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.blocked.length, 1, "item stays in blocked");
    assert.equal(lanes.blocked[0].id, id);
    assert.equal(lanes.blocked[0].lane, "blocked");
    assert.equal(lanes.blocked[0].meta.reconciledFrom, undefined, "no reconciled stamp may be written");
    assert.equal(lanes.done.length, 0);

    const alerts = await redis.lrange("hydra:alerts", 0, -1);
    const matching = alerts
      .map((a: string) => JSON.parse(a))
      .filter((a: any) => a.type === "merged-item-reconciled");
    assert.equal(matching.length, 0, "no reconciliation alert for a blocked item");
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

  // -------------------------------------------------------------------------
  // Observability: feed liveness + batch metrics + alerting (issue #2057)
  // -------------------------------------------------------------------------

  test("result carries per-feed examined counts + batch metrics (issue #2057)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Metric coverage", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-501", blob: `feat: lands it (${id})` },
        { ref: "pr-502", blob: "feat: unrelated other PR" },
      ],
      fetchMergeCommitRefs: async () => [
        { ref: "commit-aaa1111", blob: "merge: unrelated cycle" },
      ],
    });

    // Feed liveness: both feeds answered, examined counts reflect the arrays.
    assert.equal(result.feed.prs.examined, 2);
    assert.equal(result.feed.prs.failed, undefined, "a healthy feed has no failed reason");
    assert.equal(result.feed.commits.examined, 1);
    assert.equal(result.feed.commits.failed, undefined);

    // Batch metrics: one reference matched, no move failed, duration present.
    assert.equal(result.metrics.referencesFound, 1);
    assert.equal(result.metrics.movesFailed, 0);
    assert.equal(typeof result.metrics.durationMs, "number");
    assert.ok(result.metrics.durationMs >= 0);
    assert.equal(result.alert, undefined, "a healthy run raises no alert");
  });

  test("single-feed failure is reported in feed state but still does NOT alert (issue #2057)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Partial coverage", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => null, // PR feed down
      fetchMergeCommitRefs: async () => [
        { ref: "commit-bbb2222", blob: `merge: claude cycle — partial coverage (${id})` },
      ],
    });

    assert.equal(result.feedsAvailable, true, "one live feed keeps feedsAvailable true");
    assert.ok(result.feed.prs.failed, "the down feed must carry a failed reason");
    assert.equal(result.feed.prs.examined, 0);
    assert.equal(result.feed.commits.examined, 1);
    assert.equal(result.feed.commits.failed, undefined);
    assert.equal(result.alert, undefined, "a single-feed failure is WARN-only, not a critical alert");
    // The live feed still reconciled the matching item.
    assert.equal(result.reconciled.length, 1);
  });

  test("both feeds down raises a reconciler:both-feeds-down alert + pushes it (issue #2057)", async (t) => {
    requireRedis(t);

    await admin.addToBacklog({ title: "Blind reconciler", category: "test", lane: "queued" });

    const result = await admin.reconcileMergedItems(OUTAGE_FEEDS);

    assert.equal(result.feedsAvailable, false);
    assert.ok(result.alert, "both feeds down must surface a critical alert object");
    assert.equal(result.alert.code, "reconciler:both-feeds-down");
    assert.ok(result.feed.prs.failed, "PR feed failure reason present");
    assert.ok(result.feed.commits.failed, "commit feed failure reason present");

    // The alert is also pushed to hydra:alerts so the operator is notified.
    const alerts = await redis.lrange("hydra:alerts", 0, -1);
    const matching = alerts
      .map((a: string) => JSON.parse(a))
      .filter((a: any) => a.type === "reconciler:both-feeds-down");
    assert.equal(matching.length, 1, "exactly one both-feeds-down alert pushed");
    assert.ok(matching[0].payload.message, "alert carries a human-readable message");
    assert.ok(matching[0].ts, "alert carries a timestamp");

    // No item moved — the merged→done sweep stays fail-closed on a total outage.
    const lanes = await admin.loadBacklog();
    assert.equal(lanes.done.length, 0);
  });

  test("metrics.referencesFound equals reconciled count on a clean run (issue #2057)", async (t) => {
    requireRedis(t);

    const a = await admin.addToBacklog({ title: "First match", category: "test", lane: "queued" });
    const b = await admin.addToBacklog({ title: "Second match", category: "test", lane: "backlog" });

    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => [
        { ref: "pr-601", blob: `feat: a (${a.id})` },
        { ref: "pr-602", blob: `feat: b (${b.id})` },
      ],
      fetchMergeCommitRefs: async () => [],
    });

    assert.equal(result.metrics.referencesFound, 2);
    assert.equal(result.metrics.movesFailed, 0);
    // On a clean run referencesFound - movesFailed == items reconciled.
    assert.equal(result.reconciled.length, result.metrics.referencesFound - result.metrics.movesFailed);
  });
});
