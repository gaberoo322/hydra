/**
 * Regression tests for the by-title secondary index (issue #2500).
 *
 * The four title-based lane mutations in src/backlog/lanes.ts
 * (moveToInProgress / moveToDone / blockByTitle / returnToBacklog) used to scan
 * whole lanes (one HGET per item) to resolve an id from a title. They now do a
 * single HGET against `hydra:backlog:title-index`, falling back to a bounded
 * scan (with index back-fill) on a miss. These tests assert:
 *   1. the index is maintained on create / title-change / delete,
 *   2. the title-based mutations resolve via the index (constant Redis reads
 *      regardless of lane depth),
 *   3. correctness is preserved on a stale / missing index entry (scan fallback),
 *   4. the lane-index reconciler rebuilds the title-index FROM the hash.
 *
 * Requires Redis on localhost:6379. Uses DB 1, cleaned between tests via a
 * hydra:backlog:* flush — same harness as backlog.test.mts. Top-level describe
 * with its own lifecycle (CLAUDE.md authoring rule: do not piggyback on a
 * sibling suite's shared-Redis teardown).
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { addToBacklog, updateItem } from "../src/backlog/items.ts";
import {
  moveToInProgress, moveToDone, blockByTitle, returnToBacklog, deleteItem,
} from "../src/backlog/lanes.ts";
import { reconcileLaneIndices } from "../src/backlog/index-reconciler.ts";
import { getItem } from "../src/backlog/internal.ts";

const TITLE_INDEX_KEY = "hydra:backlog:title-index";
const ITEMS_KEY = "hydra:backlog:items";

let redis: any;
let redisAvailable = false;

async function cleanBacklogKeys() {
  const keys = await redis.keys("hydra:backlog:*");
  if (keys.length > 0) await redis.del(...keys);
}

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

describe("backlog by-title index (issue #2500)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch {
        console.error("Redis unavailable at localhost:6379/1, skipping title-index tests");
        return;
      }
    }
    if (!redisAvailable) return;
    await cleanBacklogKeys();
  });

  test("addToBacklog populates the by-title index", async (t) => {
    requireRedis(t);
    const { id } = await addToBacklog({ title: "Indexed on create", lane: "backlog" });
    assert.equal(await redis.hget(TITLE_INDEX_KEY, "Indexed on create"), String(id));
  });

  test("updateItem retitles: old entry dropped, new entry added", async (t) => {
    requireRedis(t);
    const { id } = await addToBacklog({ title: "Old title", lane: "backlog" });
    await updateItem(id, { title: "New title" });
    assert.equal(await redis.hget(TITLE_INDEX_KEY, "Old title"), null);
    assert.equal(await redis.hget(TITLE_INDEX_KEY, "New title"), String(id));
  });

  test("deleteItem clears the by-title index entry", async (t) => {
    requireRedis(t);
    const { id } = await addToBacklog({ title: "To be deleted", lane: "backlog" });
    assert.equal(await redis.hget(TITLE_INDEX_KEY, "To be deleted"), String(id));
    await deleteItem(id);
    assert.equal(await redis.hget(TITLE_INDEX_KEY, "To be deleted"), null);
  });

  test("moveToInProgress resolves via the index with a bounded number of item reads", async (t) => {
    requireRedis(t);
    // Seed a deep backlog so a scan would HGET every preceding item; the index
    // makes the lookup O(1) regardless of depth.
    for (let i = 0; i < 25; i++) {
      await addToBacklog({ title: `Filler ${i}`, lane: "backlog" });
    }
    const { id } = await addToBacklog({ title: "Target item", lane: "queued" });

    // Count HGETs against the items hash during the move: the index path reads
    // the resolved item once (resolveItemIdByTitle verify) + once in the mover.
    let itemHgets = 0;
    const orig = Redis.prototype.hget;
    (Redis.prototype as any).hget = function (key: string, ...rest: any[]) {
      if (key === ITEMS_KEY) itemHgets++;
      return orig.apply(this, [key, ...rest] as any);
    };
    try {
      const moved = await moveToInProgress("Target item");
      assert.equal(moved, true);
    } finally {
      (Redis.prototype as any).hget = orig;
    }

    // A full lane scan would read ~26 items; the index keeps it tiny and
    // independent of backlog depth. Allow a small constant for the verify + mover.
    assert.ok(itemHgets <= 4, `expected bounded item reads, got ${itemHgets}`);
    const item = await getItem(id);
    assert.equal(item.lane, "inProgress");
  });

  test("moveToDone / blockByTitle / returnToBacklog still find items via the index", async (t) => {
    requireRedis(t);
    const a = await addToBacklog({ title: "Done me", lane: "inProgress" });
    assert.equal(await moveToDone("Done me"), true);
    assert.equal((await getItem(a.id)).lane, "done");

    const b = await addToBacklog({ title: "Block me", lane: "backlog" });
    assert.equal(await blockByTitle("Block me", "needs review"), true);
    const blocked = await getItem(b.id);
    assert.equal(blocked.lane, "blocked");
    assert.equal(blocked.meta.blockedReason, "needs review");

    const c = await addToBacklog({ title: "Return me", lane: "inProgress" });
    assert.equal(await returnToBacklog("Return me", "abandoned"), true);
    assert.equal((await getItem(c.id)).lane, "backlog");
  });

  test("missing index entry: scan fallback still finds the item and back-fills", async (t) => {
    requireRedis(t);
    const { id } = await addToBacklog({ title: "No index entry", lane: "queued" });
    // Simulate a pre-existing item whose index entry was never written.
    await redis.hdel(TITLE_INDEX_KEY, "No index entry");
    assert.equal(await redis.hget(TITLE_INDEX_KEY, "No index entry"), null);

    const moved = await moveToInProgress("No index entry");
    assert.equal(moved, true);
    assert.equal((await getItem(id)).lane, "inProgress");
    // Back-filled during the fallback scan.
    assert.equal(await redis.hget(TITLE_INDEX_KEY, "No index entry"), String(id));
  });

  test("stale index entry (points at wrong id): degrades to scan, mutates correct item", async (t) => {
    requireRedis(t);
    const { id } = await addToBacklog({ title: "Real item", lane: "queued" });
    // Corrupt the index to point at a non-existent id.
    await redis.hset(TITLE_INDEX_KEY, "Real item", "item-99999");

    const moved = await moveToInProgress("Real item");
    assert.equal(moved, true);
    assert.equal((await getItem(id)).lane, "inProgress");
  });

  test("not-found title returns false / not-found without throwing", async (t) => {
    requireRedis(t);
    assert.equal(await moveToDone("does not exist"), false);
    assert.equal(await blockByTitle("does not exist", "x"), false);
    assert.equal(await returnToBacklog("does not exist", "x"), false);
    const structured = await moveToInProgress("does not exist", { claimedBy: "tester" });
    assert.deepEqual(structured, { ok: false, reason: "not-found" });
  });

  test("reconcileLaneIndices rebuilds the title-index FROM the hash", async (t) => {
    requireRedis(t);
    // Write items straight into the canonical hash with NO index entries.
    await redis.hset(ITEMS_KEY, "item-1", JSON.stringify({ id: "item-1", lane: "backlog", title: "Rebuilt A" }));
    await redis.hset(ITEMS_KEY, "item-2", JSON.stringify({ id: "item-2", lane: "queued", title: "Rebuilt B" }));
    // And a stale index entry that no longer matches any item.
    await redis.hset(TITLE_INDEX_KEY, "Ghost title", "item-404");

    const res = await reconcileLaneIndices();
    assert.equal(res.titleIndexed, 2);
    assert.equal(await redis.hget(TITLE_INDEX_KEY, "Rebuilt A"), "item-1");
    assert.equal(await redis.hget(TITLE_INDEX_KEY, "Rebuilt B"), "item-2");
    // The stale entry is gone (DEL + rebuild).
    assert.equal(await redis.hget(TITLE_INDEX_KEY, "Ghost title"), null);
  });
});
