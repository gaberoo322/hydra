/**
 * Regression tests for src/backlog/index-reconciler.ts (issue #2056).
 *
 * The lane-index reconciler repairs the lane sorted-set indices FROM the
 * canonical items hash: re-adds hash items missing from their lane zset, and
 * removes orphan zset members with no surviving hash entry. It is the
 * load-bearing self-heal for the #1990 restart desync (HSET written first, so
 * the hash survives while a ZADD can be lost on a crash).
 *
 * Requires Redis running on localhost:6379. Uses DB 1, cleaned between tests via
 * a hydra:backlog:* flush — same harness as backlog.test.mts.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { reconcileLaneIndices, auditLaneIndices } from "../src/backlog/index-reconciler.ts";

const ITEMS_KEY = "hydra:backlog:items";
const laneKey = (lane: string) => `hydra:backlog:lane:${lane}`;

let redis: any;
let redisAvailable = false;

async function cleanBacklogKeys() {
  const keys = await redis.keys("hydra:backlog:*");
  if (keys.length > 0) await redis.del(...keys);
}

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

/** Write an item into the canonical hash (the source of truth). */
async function putItem(item: any) {
  await redis.hset(ITEMS_KEY, item.id, JSON.stringify(item));
}

describe("lane-index reconciler", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch {
        console.error("Redis unavailable at localhost:6379/1, skipping reconciler tests");
        return;
      }
    }
    if (!redisAvailable) return;
    await cleanBacklogKeys();
  });

  test("re-indexes a hash item missing from its lane zset (#1990 restart desync)", async (t) => {
    requireRedis(t);
    // Simulate a lost ZADD: the item is in the hash with lane="queued" but the
    // queued zset is empty (the restart failure mode).
    await putItem({ id: "item-1", lane: "queued", title: "orphaned-from-index", movedAt: new Date(1000).toISOString() });
    assert.equal(await redis.zcard(laneKey("queued")), 0);

    const res = await reconcileLaneIndices();

    assert.equal(res.reindexed, 1);
    assert.equal(res.orphansRemoved, 0);
    assert.equal(res.scanned, 1);
    assert.equal(await redis.zcard(laneKey("queued")), 1);
    assert.equal(await redis.zscore(laneKey("queued"), "item-1"), "1000");
  });

  test("re-indexes a done item at a NEGATED score (done-lane ordering convention)", async (t) => {
    requireRedis(t);
    // The done lane sorts on -timestamp (moveToDone / moveItemToLane ZADD done
    // items at -Date.now()), so an ascending ZRANGE lists most-recently-done
    // first. A re-indexed done item must follow that convention — a positive
    // score would bury a recently-done item at the absolute tail (oldest).
    await putItem({ id: "item-done", lane: "done", movedAt: new Date(1000).toISOString() });
    assert.equal(await redis.zcard(laneKey("done")), 0);

    const res = await reconcileLaneIndices();

    assert.equal(res.reindexed, 1);
    assert.equal(await redis.zcard(laneKey("done")), 1);
    // Score is negated for the done lane (-1000), NOT the raw positive timestamp.
    assert.equal(await redis.zscore(laneKey("done"), "item-done"), "-1000");
  });

  test("removes an orphan zset member with no surviving hash entry", async (t) => {
    requireRedis(t);
    // A zset member whose hash item was deleted (half-completed removal).
    await redis.zadd(laneKey("done"), Date.now(), "item-ghost");

    const res = await reconcileLaneIndices();

    assert.equal(res.orphansRemoved, 1);
    assert.equal(res.reindexed, 0);
    assert.equal(await redis.zcard(laneKey("done")), 0);
  });

  test("is a no-op on a healthy board (idempotent)", async (t) => {
    requireRedis(t);
    await putItem({ id: "item-2", lane: "backlog", movedAt: new Date(2000).toISOString() });
    await redis.zadd(laneKey("backlog"), 2000, "item-2");

    const first = await reconcileLaneIndices();
    assert.equal(first.reindexed, 0);
    assert.equal(first.orphansRemoved, 0);
    assert.equal(first.scanned, 1);

    // A second immediate run is a guaranteed no-op.
    const second = await reconcileLaneIndices();
    assert.equal(second.reindexed, 0);
    assert.equal(second.orphansRemoved, 0);
  });

  test("does NOT re-stamp movedAt or clear claims (index repair, not a transition)", async (t) => {
    requireRedis(t);
    const movedAt = new Date(5000).toISOString();
    const claimedAt = new Date(6000).toISOString();
    await putItem({
      id: "item-3",
      lane: "inProgress",
      movedAt,
      claimedAt,
      claimedBy: "claude",
    });
    // zset missing — forces a re-index.
    assert.equal(await redis.zcard(laneKey("inProgress")), 0);

    await reconcileLaneIndices();

    const raw = await redis.hget(ITEMS_KEY, "item-3");
    const item = JSON.parse(raw);
    // The transition fields are untouched — repair changed only the index.
    assert.equal(item.movedAt, movedAt);
    assert.equal(item.claimedAt, claimedAt);
    assert.equal(item.claimedBy, "claude");
    assert.equal(await redis.zscore(laneKey("inProgress"), "item-3"), "5000");
  });

  test("tolerates un-laned / unknown-lane items — counts, never drops or guesses", async (t) => {
    requireRedis(t);
    await putItem({ id: "item-nolane", title: "no lane field" });
    await putItem({ id: "item-badlane", lane: "not-a-real-lane" });

    const res = await reconcileLaneIndices();

    assert.equal(res.unLaned, 2);
    assert.equal(res.reindexed, 0);
    // Both items remain in the hash, indexed nowhere.
    assert.ok(await redis.hexists(ITEMS_KEY, "item-nolane"));
    assert.ok(await redis.hexists(ITEMS_KEY, "item-badlane"));
  });

  test("repairs both directions in one sweep", async (t) => {
    requireRedis(t);
    // Missing-from-index item.
    await putItem({ id: "item-a", lane: "queued", movedAt: new Date(1000).toISOString() });
    // Healthy item.
    await putItem({ id: "item-b", lane: "backlog", movedAt: new Date(2000).toISOString() });
    await redis.zadd(laneKey("backlog"), 2000, "item-b");
    // Orphan zset member.
    await redis.zadd(laneKey("done"), 3000, "item-orphan");

    const res = await reconcileLaneIndices();

    assert.equal(res.reindexed, 1);
    assert.equal(res.orphansRemoved, 1);
    assert.equal(await redis.zcard(laneKey("queued")), 1);
    assert.equal(await redis.zcard(laneKey("done")), 0);
  });

  test("a malformed hash entry is tolerated and never orphan-removed elsewhere", async (t) => {
    requireRedis(t);
    await redis.hset(ITEMS_KEY, "item-broken", "{not valid json");

    const res = await reconcileLaneIndices();

    assert.equal(res.unLaned, 1);
    assert.equal(res.scanned, 1);
    // Still in the hash (never dropped).
    assert.ok(await redis.hexists(ITEMS_KEY, "item-broken"));
  });

  test("auditLaneIndices reports divergences without mutating", async (t) => {
    requireRedis(t);
    await putItem({ id: "item-x", lane: "queued", movedAt: new Date(1000).toISOString() });
    await redis.zadd(laneKey("done"), 3000, "item-orphan");
    await putItem({ id: "item-nolane" });

    const audit = await auditLaneIndices();

    assert.equal(audit.hashCount, 2);
    assert.deepEqual(audit.missingFromIndex, [{ id: "item-x", lane: "queued" }]);
    assert.deepEqual(audit.orphanZsetEntries, [{ id: "item-orphan", lane: "done" }]);
    assert.deepEqual(audit.unLaned, ["item-nolane"]);

    // Audit is read-only — the divergences are still present afterwards.
    assert.equal(await redis.zcard(laneKey("queued")), 0);
    assert.equal(await redis.zcard(laneKey("done")), 1);
  });
});
