/**
 * Regression tests for the targeted backlog claim (issue #1682).
 *
 * POST /backlog/claim used to read only `claimedBy` and silently discard any
 * `itemId` the caller sent, always popping the queue head (run 60a0624c
 * claimed item-319 when the agent asked for item-318). These tests pin the
 * new contract:
 *
 *   - itemId absent  → pop-head claim, byte-compatible with pre-#1682.
 *   - itemId present → claim exactly that queued item, atomically.
 *   - not-found / not-queued surface as result objects (the route maps them
 *     to 404/409 — HTTP mapping is route-only, not tested here).
 *   - WIP limit applies identically to targeted claims.
 *   - The body schema is strict: typo'd keys (itemID) fail loudly.
 *
 * Claim-path tests require Redis on localhost:6379 (DB 1, cleaned between
 * tests) and skip when unavailable — matching test/backlog.test.mts. Schema
 * tests are pure and always run.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set REDIS_URL before any import of backlog modules so the singleton picks
// up DB 1 (lazy connect — import order does not pin the DB; see
// test/backlog.test.mts for the full rationale).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { claimNextQueuedItem } from "../src/backlog/claims.ts";
import { addToBacklog } from "../src/backlog/items.ts";
import { BacklogClaimBodySchema } from "../src/schemas/backlog.ts";

let redis: any;
let redisAvailable = false;

async function cleanBacklogKeys() {
  const keys = await redis.keys("hydra:backlog:*");
  if (keys.length > 0) await redis.del(...keys);
}

/** Call at top of each claim-path test — skips the test if Redis is unreachable. */
function requireRedis(t: any) {
  if (!redisAvailable) {
    t.skip("Redis unavailable");
  }
}

/** Seed one backlog item directly into a lane; returns its id. */
async function seed(title: string, lane: string): Promise<string> {
  const result = await addToBacklog({ title, category: "test", lane });
  assert.equal(result.added, true, `seed item "${title}" must add cleanly`);
  return String(result.id);
}

describe("claimNextQueuedItem — targeted claim (issue #1682)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch (err) {
        console.error("Redis unavailable at localhost:6379/1, skipping backlog-claim tests");
        return;
      }
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

  test("itemId claims that exact item, not the queue head", async (t) => {
    requireRedis(t);
    const headId = await seed("Claim 1682 queue head alpha", "queued");
    const targetId = await seed("Claim 1682 non-head target bravo", "queued");

    const result = await claimNextQueuedItem("claude", targetId);
    assert.equal(result.claimed, true, "targeted claim of a queued item must succeed");
    assert.equal(result.item.id, targetId, "must claim the REQUESTED item, not the head");
    assert.equal(result.item.lane, "inProgress");
    assert.equal(result.item.claimedBy, "claude", "targeted claim must stamp claimedBy");
    assert.ok(result.item.claimedAt, "targeted claim must stamp claimedAt");
    assert.ok(result.item.movedAt, "targeted claim must stamp movedAt");
    assert.ok(result.item.meta.startedAt, "targeted claim must stamp meta.startedAt");

    // The head must be untouched — still in the queued lane.
    const queuedIds = await redis.zrange("hydra:backlog:lane:queued", 0, -1);
    assert.deepEqual(queuedIds, [headId], "queue head must remain queued");
    const inProgressIds = await redis.zrange("hydra:backlog:lane:inProgress", 0, -1);
    assert.deepEqual(inProgressIds, [targetId]);
  });

  test("itemId absent keeps pop-head behavior (pre-#1682 contract)", async (t) => {
    requireRedis(t);
    const headId = await seed("Claim 1682 pop head charlie", "queued");
    await seed("Claim 1682 pop second delta", "queued");

    const result = await claimNextQueuedItem("claude");
    assert.equal(result.claimed, true);
    assert.equal(result.item.id, headId, "no itemId → claim the queue head");
  });

  test("itemId for an item in another lane → claimed:false, reason not-queued", async (t) => {
    requireRedis(t);
    const backlogId = await seed("Claim 1682 wrong lane echo", "backlog");

    const result = await claimNextQueuedItem("claude", backlogId);
    assert.equal(result.claimed, false);
    assert.equal(result.reason, "not-queued", "existing item in wrong lane must report not-queued");

    // Must NOT have moved the item — claim failure is side-effect free.
    const inProgressIds = await redis.zrange("hydra:backlog:lane:inProgress", 0, -1);
    assert.deepEqual(inProgressIds, [], "failed targeted claim must not mutate lanes");
  });

  test("itemId for a nonexistent item → claimed:false, reason not-found", async (t) => {
    requireRedis(t);
    await seed("Claim 1682 lonely queued foxtrot", "queued");

    const result = await claimNextQueuedItem("claude", "item-999999");
    assert.equal(result.claimed, false);
    assert.equal(result.reason, "not-found");

    const queuedCount = await redis.zcard("hydra:backlog:lane:queued");
    assert.equal(queuedCount, 1, "failed targeted claim must not consume the queue");
  });

  test("targeted claim respects the WIP limit (targeting never bypasses claim policy)", async (t) => {
    requireRedis(t);
    // WIP_LIMIT defaults to 3 (src/backlog/internal.ts). Fill inProgress.
    // Titles must be mutually dissimilar — addToBacklog fuzzy-dedups by title.
    const fillerTitles = [
      "Refactor websocket reconnect strategy golf",
      "Audit dashboard bundle size budget india",
      "Migrate scheduler heartbeat metrics juliet",
      "Harden redis seam typed accessors kilo",
      "Document anchor selection scoring lima",
      "Consolidate tier classifier fixtures mike",
    ];
    const wipLimit = parseInt(process.env.HYDRA_WIP_LIMIT ?? "") || 3;
    assert.ok(wipLimit <= fillerTitles.length, `test supports WIP_LIMIT up to ${fillerTitles.length}`);
    for (let i = 0; i < wipLimit; i++) {
      await seed(fillerTitles[i], "inProgress");
    }
    const targetId = await seed("Claim 1682 wip blocked target hotel", "queued");

    const result = await claimNextQueuedItem("claude", targetId);
    assert.equal(result.claimed, false);
    assert.equal(result.reason, "wip-limit", "targeted claim must hit the same WIP check");

    const queuedIds = await redis.zrange("hydra:backlog:lane:queued", 0, -1);
    assert.deepEqual(queuedIds, [targetId], "wip-blocked targeted claim must leave the item queued");
  });
});

describe("BacklogClaimBodySchema (issue #1682)", () => {
  test("accepts an empty body (both fields optional)", () => {
    const result = BacklogClaimBodySchema.safeParse({});
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.claimedBy, undefined);
      assert.equal(result.data.itemId, undefined);
    }
  });

  test("accepts claimedBy + itemId", () => {
    const result = BacklogClaimBodySchema.safeParse({ claimedBy: "claude", itemId: "item-318" });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.claimedBy, "claude");
      assert.equal(result.data.itemId, "item-318");
    }
  });

  test("rejects unknown keys — the typo'd itemID must 400 loudly, not silently pop-head", () => {
    const result = BacklogClaimBodySchema.safeParse({ claimedBy: "claude", itemID: "item-318" });
    assert.equal(result.success, false, "silent discard of a mistyped field is this bug's failure class");
    if (!result.success) {
      const codes = result.error.issues.map((i: any) => i.code);
      assert.ok(codes.includes("unrecognized_keys"), `expected unrecognized_keys, got ${codes}`);
    }
  });

  test("rejects a whitespace-only itemId", () => {
    const result = BacklogClaimBodySchema.safeParse({ itemId: "   " });
    assert.equal(result.success, false);
  });

  test("rejects a non-string itemId", () => {
    const result = BacklogClaimBodySchema.safeParse({ itemId: 318 });
    assert.equal(result.success, false);
  });
});
