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

process.env.REDIS_URL = "redis://localhost:6379/1";

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
    const result = await admin.reapStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000, fetchOpenPrBlobs: async () => null });

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
    const result = await admin.reapStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000, fetchOpenPrBlobs: async () => null });
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

    await admin.reapStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000, fetchOpenPrBlobs: async () => null });

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
    const result = await admin.reapStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000, fetchOpenPrBlobs: async () => null });
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
    const result = await admin.reapStaleClaims({ maxAgeMs: 2 * 60 * 60 * 1000, fetchOpenPrBlobs: async () => null });
    assert.deepEqual(result.reaped, []);
  });
});
