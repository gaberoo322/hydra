/**
 * Regression tests for the atomic lane transition (issue #1990).
 *
 * Every transition in src/backlog/lanes.ts used to run as THREE separate Redis
 * round-trips — removeFromBacklogLane (ZREM old) → saveItem (HSET hash) →
 * addToBacklogLane (ZADD new). A crash / Redis restart between the HSET and the
 * ZADD lost the zset entry while the hash item survived, leaving item.lane=done
 * with the done zset short by that id — the 166 "phantom done" items.
 *
 * The fix routes the {ZREM old-lane(s), HSET item, ZADD new-lane} write-commit
 * through applyAtomicLaneTransition (a single Lua eval). These tests pin the
 * post-condition the atomicity guarantees: after ANY transition the hash
 * item.lane and the lane-zset membership AGREE — zero divergence — so the
 * lane-index reconciler is a guaranteed no-op on the board the transitions
 * left behind. The invariants carried verbatim:
 *
 *   - hash item.lane is canonical, zset is the derived index; they must match.
 *   - the item is present in EXACTLY its lane's zset and no other.
 *   - the done lane ZADDs at a NEGATED score (-now), so an ascending ZRANGE
 *     lists most-recently-done first.
 *   - the #1920 blocked-reason guard still gates a blocked transition; a
 *     rejected guard is side-effect free (no half-write).
 *
 * Requires Redis on localhost:6379 (DB 1, cleaned between tests) and skips when
 * unavailable — matching test/backlog.test.mts and test/backlog-claim.test.mts.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set REDIS_URL before any import of backlog modules so the singleton picks
// up DB 1 (lazy connect — see test/backlog.test.mts for the full rationale).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { addToBacklog } from "../src/backlog/items.ts";
import {
  promoteToQueued, moveToInProgress, moveToDone, blockByTitle,
  returnToBacklog, moveItemToLane,
} from "../src/backlog/lanes.ts";
import { reconcileLaneIndices, auditLaneIndices } from "../src/backlog/index-reconciler.ts";

const LANES = ["triage", "backlog", "queued", "blocked", "inProgress", "done"];

let redis: any;
let redisAvailable = false;

async function cleanBacklogKeys() {
  const keys = await redis.keys("hydra:backlog:*");
  if (keys.length > 0) await redis.del(...keys);
}

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

/** Seed one backlog item directly into a lane; returns its id. */
async function seed(title: string, lane: string): Promise<string> {
  const result = await addToBacklog({ title, category: "test", lane });
  assert.equal(result.added, true, `seed item "${title}" must add cleanly`);
  return String(result.id);
}

/** Read the canonical lane from the items hash. */
async function hashLane(id: string): Promise<string | undefined> {
  const raw = await redis.hget("hydra:backlog:items", id);
  if (!raw) return undefined;
  return JSON.parse(raw).lane;
}

/** Return the set of lanes whose zset contains `id`. */
async function zsetLanes(id: string): Promise<string[]> {
  const present: string[] = [];
  for (const lane of LANES) {
    const score = await redis.zscore(`hydra:backlog:lane:${lane}`, id);
    if (score !== null) present.push(lane);
  }
  return present;
}

/**
 * The load-bearing post-condition: the hash item.lane and the zset membership
 * agree — the item is in EXACTLY one lane zset and it is the lane the hash
 * names. This is precisely what a half-write would violate.
 */
async function assertHashZsetAgree(id: string, expectedLane: string) {
  assert.equal(await hashLane(id), expectedLane, `hash item.lane must be ${expectedLane}`);
  assert.deepEqual(
    await zsetLanes(id), [expectedLane],
    `item must be in EXACTLY the ${expectedLane} zset and no other`,
  );
}

describe("atomic lane transition — hash/zset stay in lock-step (issue #1990)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch {
        console.error("Redis unavailable at localhost:6379/1, skipping atomic-transition tests");
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

  test("promoteToQueued: backlog → queued leaves no divergence", async (t) => {
    requireRedis(t);
    const id = await seed("Atomic promote alpha 1990", "backlog");
    const moved = await promoteToQueued(1);
    assert.equal(moved.length, 1);
    await assertHashZsetAgree(id, "queued");
  });

  test("moveToInProgress: queued → inProgress leaves no divergence", async (t) => {
    requireRedis(t);
    const id = await seed("Atomic in-progress bravo 1990", "queued");
    const result = await moveToInProgress("Atomic in-progress bravo 1990", { claimedBy: "claude" });
    assert.equal(result.ok, true);
    await assertHashZsetAgree(id, "inProgress");
    // Claim metadata still stamped (applyLaneTransition path preserved).
    const raw = JSON.parse(await redis.hget("hydra:backlog:items", id));
    assert.equal(raw.claimedBy, "claude");
    assert.ok(raw.claimedAt);
  });

  test("moveToDone: inProgress → done uses a NEGATED score and stays in lock-step", async (t) => {
    requireRedis(t);
    const id = await seed("Atomic done charlie 1990", "inProgress");
    const ok = await moveToDone("Atomic done charlie 1990", "merged");
    assert.equal(ok, true);
    await assertHashZsetAgree(id, "done");
    // Done-lane ordering invariant: ZADD at a negated score → score < 0.
    const score = Number(await redis.zscore("hydra:backlog:lane:done", id));
    assert.ok(score < 0, `done items must ZADD at a negated score, got ${score}`);
  });

  test("blockByTitle: inProgress → blocked stamps reason and stays in lock-step", async (t) => {
    requireRedis(t);
    const id = await seed("Atomic block delta 1990", "inProgress");
    const ok = await blockByTitle("Atomic block delta 1990", "waiting on upstream");
    assert.equal(ok, true);
    await assertHashZsetAgree(id, "blocked");
    const raw = JSON.parse(await redis.hget("hydra:backlog:items", id));
    assert.equal(raw.meta.blockedReason, "waiting on upstream");
  });

  test("returnToBacklog: inProgress → backlog leaves no divergence", async (t) => {
    requireRedis(t);
    const id = await seed("Atomic return echo 1990", "inProgress");
    const ok = await returnToBacklog("Atomic return echo 1990", "abandoned");
    assert.equal(ok, true);
    await assertHashZsetAgree(id, "backlog");
  });

  test("moveItemToLane: id-based move purges every other lane atomically", async (t) => {
    requireRedis(t);
    const id = await seed("Atomic move-by-id foxtrot 1990", "queued");
    const result = await moveItemToLane(id, "inProgress");
    assert.equal(result.ok, true);
    await assertHashZsetAgree(id, "inProgress");
  });

  test("moveItemToLane to done uses a negated score", async (t) => {
    requireRedis(t);
    const id = await seed("Atomic move-by-id done golf 1990", "inProgress");
    const result = await moveItemToLane(id, "done");
    assert.equal(result.ok, true);
    await assertHashZsetAgree(id, "done");
    const score = Number(await redis.zscore("hydra:backlog:lane:done", id));
    assert.ok(score < 0, `move-by-id to done must ZADD at a negated score, got ${score}`);
  });

  test("blocked guard (#1920): a reasonless block is rejected with NO half-write", async (t) => {
    requireRedis(t);
    const id = await seed("Atomic block-guard hotel 1990", "queued");
    const result = await moveItemToLane(id, "blocked"); // no reason supplied
    assert.equal(result.ok, false);
    assert.equal(result.error, "missing-blocked-reason");
    // Rejected guard must be side-effect free: item still queued, no divergence.
    await assertHashZsetAgree(id, "queued");
  });

  test("reconciler is a guaranteed no-op on the board atomic transitions leave behind", async (t) => {
    requireRedis(t);
    // Drive a representative spread of transitions, then assert the index is
    // already perfectly consistent — the reconciler finds nothing to repair.
    // Titles must be mutually dissimilar — addToBacklog fuzzy-dedups by title.
    await seed("Refactor websocket reconnect strategy india 1990", "backlog");
    await promoteToQueued(1);
    const jTitle = "Audit dashboard bundle size budget juliet 1990";
    const jId = await seed(jTitle, "inProgress");
    await moveToDone(jTitle, "merged");
    const kTitle = "Migrate scheduler heartbeat metrics kilo 1990";
    const kId = await seed(kTitle, "inProgress");
    await blockByTitle(kTitle, "needs decision");

    const audit = await auditLaneIndices();
    assert.equal(audit.missingFromIndex.length, 0, "no hash item should be missing from its zset");
    assert.equal(audit.orphanZsetEntries.length, 0, "no zset member should lack a hash entry");

    const recon = await reconcileLaneIndices();
    assert.equal(recon.reindexed, 0, "atomic transitions leave nothing to re-index");
    assert.equal(recon.orphansRemoved, 0, "atomic transitions leave no orphans");

    // Sanity: the items landed where expected.
    assert.equal(await hashLane(jId), "done");
    assert.equal(await hashLane(kId), "blocked");
  });
});
