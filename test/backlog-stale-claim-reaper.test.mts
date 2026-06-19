/**
 * Regression tests for src/backlog/reaper.ts — stale-claim reaper (issue #374).
 *
 * Background: three inProgress items (240, 243, 244) were wedged in the
 * `inProgress` lane with `claimedBy: codex` after the Phase-A codex-removal
 * refactor effectively killed the claimant agents. With WIP_LIMIT=3 this
 * saturated the cap and caused 142 spec-lane starvations. The reaper
 * releases claims whose `claimedAt` is older than HYDRA_CLAIM_MAX_AGE_MS
 * so the WIP lane stays drainable.
 *
 * Each test corresponds to an acceptance criterion in the issue:
 *   - older-than-maxAge item is reaped
 *   - younger-than-maxAge item is left alone
 *   - reap emits a `stale-claim-reaped` alert
 *   - reap increments the lifetime metric
 *   - repeatedly-reaped items escalate to the `blocked` lane
 *   - `getStaleClaims()` reports without mutating state
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let admin: any;
let redis: any;
let redisAvailable = false;

// issue #1446 — this file shares the `hydra:backlog:*` keyspace with
// backlog.test.mts and backlog-reaper-open-pr-guard.test.mts. Under the
// canonical `npm test` (`--test-concurrency=1`) serial ordering hides the
// collision, but any invocation that runs these files concurrently (an agent
// running a subset without the flag, a future concurrency bump) had them
// clobber each other's fixtures on the shared DB-1 — the recurring
// "redis-shared-backlog-tests-flaky-in-full-run" friction. Pin this file to a
// DEDICATED non-zero logical DB so its keyspace can never be touched by a
// sibling backlog file, regardless of concurrency. (#1231 rejected unique-DB
// allocation for the ~28-file DB-1 set on the 16-DB budget; only 3 backlog
// files actually collide, so 3 dedicated DBs is well inside the budget.)
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/5";

async function cleanBacklogKeys() {
  const patterns = ["hydra:backlog:*", "hydra:alerts", "hydra:metrics:claims-reaped*"];
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

/** Backdate the claimedAt of an inProgress item by `ageMs` so the reaper sees it as stale. */
async function backdateClaim(itemId: string, ageMs: number) {
  const raw = await redis.hget("hydra:backlog:items", itemId);
  const item = JSON.parse(raw);
  const backdated = new Date(Date.now() - ageMs).toISOString();
  item.claimedAt = backdated;
  item.movedAt = backdated;
  await redis.hset("hydra:backlog:items", itemId, JSON.stringify(item));
}

describe("backlog stale-claim reaper (issue #374)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch (err) {
        console.error("Redis unavailable at localhost:6379/1, skipping reaper tests");
        return;
      }
      const reads = await import("../src/backlog/reads.ts");
      const items = await import("../src/backlog/items.ts");
      const lanes = await import("../src/backlog/lanes.ts");
      const claims = await import("../src/backlog/claims.ts");
      const wip = await import("../src/backlog/wip.ts");
      const reaper = await import("../src/backlog/reaper.ts");
      admin = { ...reads, ...items, ...lanes, ...claims, ...wip, ...reaper };
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

  test("reapStaleClaims releases claims older than maxAgeMs and leaves fresh ones", async (t) => {
    requireRedis(t);

    // One fresh claim (1 minute old) and one stale (3 hours old, default threshold 2h).
    const { id: freshId } = await admin.addToBacklog({ title: "Fresh claim", category: "test" });
    await admin.moveToInProgress("Fresh claim", { claimedBy: "claude" });
    await backdateClaim(freshId, 60 * 1000);

    const { id: staleId } = await admin.addToBacklog({ title: "Stale claim", category: "test" });
    await admin.moveToInProgress("Stale claim", { claimedBy: "codex" });
    await backdateClaim(staleId, 3 * 60 * 60 * 1000);

    // Inject a null PR fetcher so tests don't shell out to `gh` (issue #490).
    const result = await admin.reapStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000, fetchOpenPrRefs: async () => null, fetchMergedPrRefs: async () => null });

    assert.equal(result.reaped.length, 1, "exactly one item reaped");
    assert.equal(result.reaped[0].id, staleId);
    assert.equal(result.reaped[0].escalated, false);
    assert.ok(result.reaped[0].ageMs >= 2 * 60 * 60 * 1000);

    // Fresh item still inProgress, stale item back in queued.
    const lanes = await admin.loadBacklog();
    assert.equal(lanes.inProgress.length, 1);
    assert.equal(lanes.inProgress[0].id, freshId);
    assert.equal(lanes.queued.length, 1);
    assert.equal(lanes.queued[0].id, staleId);

    // Reaped item carries audit metadata.
    const reaped = lanes.queued[0];
    assert.equal(reaped.meta.reapReason, "stale-claim");
    assert.equal(reaped.meta.previousClaimedBy, "codex");
    assert.equal(reaped.meta.reapCount, 1);
    assert.ok(reaped.meta.reapedAt, "reapedAt must be set");
    // claimedAt/claimedBy cleared by lane transition out of inProgress.
    assert.equal(reaped.claimedAt, null);
    assert.equal(reaped.claimedBy, null);
  });

  test("reapStaleClaims is a no-op when no claims are stale", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Recent claim", category: "test" });
    await admin.moveToInProgress("Recent claim", { claimedBy: "codex" });
    // 30 minutes old — well under the 2h default.
    await backdateClaim(id, 30 * 60 * 1000);

    // Inject a null PR fetcher so tests don't shell out to `gh` (issue #490).
    const result = await admin.reapStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000, fetchOpenPrRefs: async () => null, fetchMergedPrRefs: async () => null });
    assert.equal(result.reaped.length, 0);

    const counts = await admin.getBacklogCounts();
    assert.equal(counts.inProgress, 1);
    assert.equal(counts.queued, 0);
  });

  test("reapStaleClaims emits a stale-claim-reaped alert and increments the lifetime metric", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Metric victim", category: "test" });
    await admin.moveToInProgress("Metric victim", { claimedBy: "codex" });
    await backdateClaim(id, 3 * 60 * 60 * 1000);

    const lifetimeBefore = await redis.get("hydra:metrics:claims-reaped");
    assert.equal(lifetimeBefore, null, "metric should start unset");

    await admin.reapStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000, fetchOpenPrRefs: async () => null, fetchMergedPrRefs: async () => null });

    const lifetimeAfter = await redis.get("hydra:metrics:claims-reaped");
    assert.equal(parseInt(lifetimeAfter, 10), 1, "lifetime counter incremented by 1");

    const isoDate = new Date().toISOString().split("T")[0];
    const dayAfter = await redis.get(`hydra:metrics:claims-reaped:${isoDate}`);
    assert.equal(parseInt(dayAfter, 10), 1, "per-day counter incremented");
    const dayTtl = await redis.ttl(`hydra:metrics:claims-reaped:${isoDate}`);
    assert.ok(dayTtl > 0 && dayTtl <= 7 * 24 * 60 * 60, "per-day counter has a 7-day TTL");

    // Alert pushed to LIST hydra:alerts.
    const alerts = await redis.lrange("hydra:alerts", 0, -1);
    const matching = alerts
      .map((a: string) => JSON.parse(a))
      .filter((a: any) => a.type === "stale-claim-reaped");
    assert.equal(matching.length, 1, "exactly one stale-claim-reaped alert");
    assert.equal(matching[0].payload.itemId, id);
    assert.equal(matching[0].payload.previousClaimedBy, "codex");
    assert.equal(matching[0].payload.targetLane, "queued");
    assert.equal(matching[0].payload.escalated, false);
  });

  test("reapStaleClaims escalates to blocked after CLAIM_REAP_ESCALATE_AFTER (default 3) reaps", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Crash loop victim", category: "test" });

    // Simulate two prior reaps already recorded on the item.
    await admin.moveToInProgress("Crash loop victim", { claimedBy: "codex" });
    const raw = await redis.hget("hydra:backlog:items", id);
    const item = JSON.parse(raw);
    item.meta = { ...item.meta, reapCount: 2 };
    await redis.hset("hydra:backlog:items", id, JSON.stringify(item));

    // Backdate so this run reaps it (which will bring reapCount to 3 → escalate).
    await backdateClaim(id, 3 * 60 * 60 * 1000);

    // Inject a null PR fetcher so tests don't shell out to `gh` (issue #490).
    const result = await admin.reapStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000, fetchOpenPrRefs: async () => null, fetchMergedPrRefs: async () => null });
    assert.equal(result.reaped.length, 1);
    assert.equal(result.reaped[0].escalated, true);

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.inProgress.length, 0);
    assert.equal(lanes.queued.length, 0);
    assert.equal(lanes.blocked.length, 1);
    const blocked = lanes.blocked[0];
    assert.equal(blocked.id, id);
    assert.equal(blocked.meta.reapCount, 3);
    assert.match(blocked.meta.blockedReason || "", /repeatedly-reaped/);
  });

  test("getStaleClaims annotates inProgress items with ageMs without mutating state", async (t) => {
    requireRedis(t);

    const { id: oldId } = await admin.addToBacklog({ title: "Old claim", category: "test" });
    await admin.moveToInProgress("Old claim", { claimedBy: "codex" });
    await backdateClaim(oldId, 3 * 60 * 60 * 1000);

    const { id: youngId } = await admin.addToBacklog({ title: "Young claim", category: "test" });
    await admin.moveToInProgress("Young claim", { claimedBy: "claude" });
    await backdateClaim(youngId, 60 * 1000);

    const { all, stale, maxAgeMs } = await admin.getStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000 });

    assert.equal(maxAgeMs, 2 * 60 * 60 * 1000);
    assert.equal(all.length, 2);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].id, oldId);
    assert.equal(stale[0].claimedBy, "codex");
    assert.ok(stale[0].claimedAgeMs >= 2 * 60 * 60 * 1000);

    // No lane changes.
    const counts = await admin.getBacklogCounts();
    assert.equal(counts.inProgress, 2);
    assert.equal(counts.queued, 0);
  });

  test("reapStaleClaims is safe to call when inProgress is empty", async (t) => {
    requireRedis(t);
    // Inject a null PR fetcher so tests don't shell out to `gh` (issue #490).
    const result = await admin.reapStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000, fetchOpenPrRefs: async () => null, fetchMergedPrRefs: async () => null });
    assert.deepEqual(result.reaped, []);
  });

  // ---------------------------------------------------------------------
  // Merged-PR guard (issue #1714) — stale claims on merged work go to done,
  // not queued. Repro of the item-490 phantom-requeue incident (2026-06-10).
  // ---------------------------------------------------------------------

  test("reapStaleClaims moves a stale claim with a MERGED PR to done, not queued (issue #1714 repro)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Merged orphan", category: "test" });
    await admin.moveToInProgress("Merged orphan", { claimedBy: "pr-109" });
    await backdateClaim(id, 3 * 60 * 60 * 1000);

    const result = await admin.reapStaleClaims({
      maxAgeMs: 2 * 60 * 60 * 1000,
      fetchOpenPrRefs: async () => [],
      fetchMergedPrRefs: async () => [
        { ref: "pr-1", blob: `cleanup(target): demote stuff\ncloses ${id} — verified complete` },
      ],
    });

    assert.equal(result.reaped.length, 0, "nothing re-queued");
    assert.equal(result.reapedToDone.length, 1, "exactly one item completed");
    assert.equal(result.reapedToDone[0].id, id);
    assert.ok(result.reapedToDone[0].ageMs >= 2 * 60 * 60 * 1000);

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.inProgress.length, 0);
    assert.equal(lanes.queued.length, 0, "item must NOT return to queued");
    assert.equal(lanes.done.length, 1);

    const done = lanes.done[0];
    assert.equal(done.id, id);
    assert.equal(done.meta.reapReason, "stale-claim-merged");
    assert.equal(done.meta.previousClaimedBy, "pr-109");
    assert.equal(done.meta.reapCount, 1);
    assert.ok(done.meta.reapedAt, "reapedAt must be set");
    assert.equal(done.meta.outcome, "merged");
    assert.ok(done.meta.completedAt, "completedAt must be set so done-retention prunes it");
    assert.equal(done.checked, true);
    // claimedAt/claimedBy cleared by lane transition out of inProgress.
    assert.equal(done.claimedAt, null);
    assert.equal(done.claimedBy, null);

    // Alert is emitted with the done lane so the resolution is auditable.
    const alerts = await redis.lrange("hydra:alerts", 0, -1);
    const matching = alerts
      .map((a: string) => JSON.parse(a))
      .filter((a: any) => a.type === "stale-claim-reaped");
    assert.equal(matching.length, 1);
    assert.equal(matching[0].payload.itemId, id);
    assert.equal(matching[0].payload.reapReason, "stale-claim-merged");
    assert.equal(matching[0].payload.targetLane, "done");
    assert.equal(matching[0].payload.escalated, false);

    // Reap metrics still count it (it IS a reaped claim).
    const lifetime = await redis.get("hydra:metrics:claims-reaped");
    assert.equal(parseInt(lifetime, 10), 1);
  });

  test("open-PR skip takes precedence over the merged-PR guard (work in flight wins)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Reopened work", category: "test" });
    await admin.moveToInProgress("Reopened work", { claimedBy: "claude" });
    await backdateClaim(id, 3 * 60 * 60 * 1000);

    // Item referenced by BOTH an open PR (follow-up in flight) and a merged
    // PR (earlier attempt). The open-PR skip must win — order of checks is
    // open-skip first, then merged → done, then re-queue.
    const result = await admin.reapStaleClaims({
      maxAgeMs: 2 * 60 * 60 * 1000,
      fetchOpenPrRefs: async () => [{ ref: "pr-2", blob: `fix: ${id} follow-up` }],
      fetchMergedPrRefs: async () => [{ ref: "pr-3", blob: `feat: ${id} first pass` }],
    });

    assert.equal(result.reaped.length, 0);
    assert.equal(result.reapedToDone.length, 0);
    assert.equal(result.skippedOpenPr.length, 1);
    assert.equal(result.skippedOpenPr[0].id, id);

    const counts = await admin.getBacklogCounts();
    assert.equal(counts.inProgress, 1, "item stays inProgress while the open PR is in flight");
  });

  test("reapStaleClaims falls back to time-only re-queue when the merged-PR fetcher returns null (gh outage)", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Outage victim", category: "test" });
    await admin.moveToInProgress("Outage victim", { claimedBy: "codex" });
    await backdateClaim(id, 3 * 60 * 60 * 1000);

    const result = await admin.reapStaleClaims({
      maxAgeMs: 2 * 60 * 60 * 1000,
      fetchOpenPrRefs: async () => null,
      fetchMergedPrRefs: async () => null,
    });

    assert.equal(result.reapedToDone.length, 0);
    assert.equal(result.reaped.length, 1, "falls back to the pre-#1714 time-only reap");
    assert.equal(result.reaped[0].id, id);

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.queued.length, 1, "outage fallback re-queues (never silently completes)");
    assert.equal(lanes.queued[0].meta.reapReason, "stale-claim");
  });

  // ---------------------------------------------------------------------
  // Clock seam (issue #2157) — the stale-age predicate's reference clock is an
  // injectable `opts.now`, so the age threshold can be exercised against a
  // freshly-stamped (NOT backdated) claim purely by advancing the synthetic
  // clock. This decouples the reaper-logic test from the Redis claimedAt
  // storage format, which is the whole point of the seam.
  // ---------------------------------------------------------------------

  test("reapStaleClaims uses opts.now (not Date.now) for the stale-age predicate", async (t) => {
    requireRedis(t);

    // A claim stamped at real wall-clock — NOT backdated. We never touch its
    // claimedAt in Redis; the synthetic clock alone decides staleness.
    const { id } = await admin.addToBacklog({ title: "Clock-seam victim", category: "test" });
    await admin.moveToInProgress("Clock-seam victim", { claimedBy: "codex" });

    const raw = await redis.hget("hydra:backlog:items", id);
    const claimedAtMs = new Date(JSON.parse(raw).claimedAt).getTime();
    const maxAgeMs = 2 * 60 * 60 * 1000;

    // 1) now just before the threshold → item is fresh, nothing reaped.
    const fresh = await admin.reapStaleClaims({
      maxAgeMs,
      now: claimedAtMs + maxAgeMs - 1000,
      fetchOpenPrRefs: async () => null,
      fetchMergedPrRefs: async () => null,
    });
    assert.equal(fresh.reaped.length, 0, "under-threshold synthetic now leaves the claim alone");
    const stillInProgress = await admin.getBacklogCounts();
    assert.equal(stillInProgress.inProgress, 1, "fresh claim stays inProgress");

    // 2) now well past the threshold → the SAME un-backdated item is now stale.
    const stale = await admin.reapStaleClaims({
      maxAgeMs,
      now: claimedAtMs + maxAgeMs + 60 * 1000,
      fetchOpenPrRefs: async () => null,
      fetchMergedPrRefs: async () => null,
    });
    assert.equal(stale.reaped.length, 1, "over-threshold synthetic now reaps the claim");
    assert.equal(stale.reaped[0].id, id);
    // ageMs is derived from the injected clock, so it equals exactly the offset.
    assert.equal(stale.reaped[0].ageMs, maxAgeMs + 60 * 1000);

    const lanes = await admin.loadBacklog();
    assert.equal(lanes.inProgress.length, 0);
    assert.equal(lanes.queued.length, 1);
    assert.equal(lanes.queued[0].id, id);
  });

  test("record-stamping wall-clock (reapedAt) is NOT taken from opts.now", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Stamp victim", category: "test" });
    await admin.moveToInProgress("Stamp victim", { claimedBy: "codex" });

    const raw = await redis.hget("hydra:backlog:items", id);
    const claimedAtMs = new Date(JSON.parse(raw).claimedAt).getTime();
    const maxAgeMs = 2 * 60 * 60 * 1000;

    // A synthetic `now` far in the past relative to real wall-clock. It must
    // only drive the stale predicate (we offset past the threshold so the item
    // reaps), and must NOT leak into the reapedAt audit stamp.
    const syntheticNow = claimedAtMs + maxAgeMs + 1;
    const before = Date.now();
    const result = await admin.reapStaleClaims({
      maxAgeMs,
      now: syntheticNow,
      fetchOpenPrRefs: async () => null,
      fetchMergedPrRefs: async () => null,
    });
    const afterT = Date.now();
    assert.equal(result.reaped.length, 1);

    const lanes = await admin.loadBacklog();
    const reapedAtMs = new Date(lanes.queued[0].meta.reapedAt).getTime();
    // reapedAt is a true wall-clock stamp taken during the call, not syntheticNow.
    assert.ok(
      reapedAtMs >= before && reapedAtMs <= afterT,
      `reapedAt (${reapedAtMs}) must be real wall-clock in [${before}, ${afterT}], not syntheticNow (${syntheticNow})`,
    );
    assert.notEqual(reapedAtMs, syntheticNow, "reapedAt must not equal the injected clock");
  });

  test("getStaleClaims uses opts.now for the age annotation and stale filter", async (t) => {
    requireRedis(t);

    // Fresh wall-clock claim, never backdated.
    const { id } = await admin.addToBacklog({ title: "Preview victim", category: "test" });
    await admin.moveToInProgress("Preview victim", { claimedBy: "claude" });

    const raw = await redis.hget("hydra:backlog:items", id);
    const claimedAtMs = new Date(JSON.parse(raw).claimedAt).getTime();
    const maxAgeMs = 2 * 60 * 60 * 1000;

    // Under-threshold synthetic now: annotated but not stale.
    const youngView = await admin.getStaleClaims({ maxAgeMs, now: claimedAtMs + 1000 });
    assert.equal(youngView.all.length, 1);
    assert.equal(youngView.all[0].claimedAgeMs, 1000, "age derived from injected clock");
    assert.equal(youngView.stale.length, 0);

    // Over-threshold synthetic now: same item, now flagged stale, no mutation.
    const oldView = await admin.getStaleClaims({ maxAgeMs, now: claimedAtMs + maxAgeMs + 5000 });
    assert.equal(oldView.stale.length, 1);
    assert.equal(oldView.stale[0].id, id);
    assert.equal(oldView.stale[0].claimedAgeMs, maxAgeMs + 5000);

    // getStaleClaims never mutates — item is still inProgress after both views.
    const counts = await admin.getBacklogCounts();
    assert.equal(counts.inProgress, 1);
    assert.equal(counts.queued, 0);
  });

  test("merged-PR guard ignores merged PRs that mention a different item ID", async (t) => {
    requireRedis(t);

    const { id } = await admin.addToBacklog({ title: "Unrelated to merged PR", category: "test" });
    await admin.moveToInProgress("Unrelated to merged PR", { claimedBy: "codex" });
    await backdateClaim(id, 3 * 60 * 60 * 1000);

    const result = await admin.reapStaleClaims({
      maxAgeMs: 2 * 60 * 60 * 1000,
      fetchOpenPrRefs: async () => [],
      // item-3020 must not whole-word-match e.g. item-302 (and vice versa).
      fetchMergedPrRefs: async () => [{ ref: "pr-4", blob: `feat: ${id}0 something else entirely` }],
    });

    assert.equal(result.reapedToDone.length, 0);
    assert.equal(result.reaped.length, 1, "unmatched stale claim re-queues normally");

    const counts = await admin.getBacklogCounts();
    assert.equal(counts.queued, 1);
    assert.equal(counts.done, 0);
  });
});
