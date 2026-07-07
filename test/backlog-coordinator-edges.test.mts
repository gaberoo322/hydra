/**
 * Edge-branch coverage for the three Redis-backed backlog COORDINATOR modules
 * (issue #2973): `src/backlog/lanes.ts`, `src/backlog/reaper.ts`,
 * `src/backlog/reconciler.ts`.
 *
 * These coordinators already have broad happy-path + guard coverage
 * (`backlog-atomic-transition`, `backlog-lane-guard`, `backlog-stale-claim-reaper`,
 * `backlog-reaper-open-pr-guard`, `backlog-merge-reconciler`). Per the #2973
 * design-concept artifact (add coverage ONLY for demonstrably-untested branches,
 * don't duplicate) this file pins the remaining defensive/degradation branches
 * that those suites leave uncovered:
 *
 *   lanes.moveItemToLane   — the two pure pre-flight guards: an invalid target
 *                            lane and an unknown item id both return an
 *                            {ok:false,error} result and never throw.
 *   lanes.deleteItem       — not-found returns {ok:false} rather than throwing.
 *   reaper.getStaleClaims  — an inProgress item with a NULL / unparseable
 *                            `claimedAt` is annotated ageMs=0 (never stale),
 *                            not NaN — the Number.isFinite fail-open branch.
 *   reaper.reapStaleClaims — the same never-/badly-claimed item is SKIPPED
 *                            (the `!claimedAt` / non-finite `continue` guards),
 *                            so a manually-parked inProgress row is never reaped.
 *   reconciler.reconcileMergedItems — a feed fetcher that THROWS (rather than
 *                            returning null per contract) is caught by `runFeed`
 *                            and degrades to a failed feed; both throwing =>
 *                            both-feeds-down alert, never a thrown sweep.
 *
 * Isolation (CLAUDE.md test-isolation pitfalls): this is its OWN top-level
 * describe with its OWN before/after lifecycle on a DEDICATED logical DB (10 —
 * the colliding backlog files use 1/5/6/8/9), `beforeEach` cleans only the
 * `hydra:backlog:*` / `hydra:alerts` keys it owns, and it never piggybacks a
 * sibling suite's shared-Redis teardown.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let admin: any;
let getItem: any;
let redis: any;
let redisAvailable = false;

// Dedicated logical DB so a concurrent invocation can never clobber (or be
// clobbered by) the other `hydra:backlog:*` suites (1/5/6/8/9). See the #1446
// note in backlog-stale-claim-reaper.test.mts for the shared-keyspace rationale.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/10";

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

/** Overwrite an item's raw hash so `claimedAt` is a chosen value (or removed). */
async function setClaimedAt(itemId: string, value: string | null | undefined) {
  const raw = await redis.hget("hydra:backlog:items", itemId);
  const item = JSON.parse(raw);
  if (value === undefined) {
    delete item.claimedAt;
  } else {
    item.claimedAt = value;
  }
  await redis.hset("hydra:backlog:items", itemId, JSON.stringify(item));
}

describe("backlog coordinators — defensive edge branches (#2973)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch (err) {
        console.error("Redis unavailable, skipping backlog-coordinator-edges tests");
        return;
      }
      const reads = await import("../src/backlog/reads.ts");
      const items = await import("../src/backlog/items.ts");
      const lanes = await import("../src/backlog/lanes.ts");
      const reaper = await import("../src/backlog/reaper.ts");
      const reconciler = await import("../src/backlog/reconciler.ts");
      const internal = await import("../src/backlog/internal.ts");
      getItem = internal.getItem;
      admin = { ...reads, ...items, ...lanes, ...reaper, ...reconciler };
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

  // -------------------------------------------------------------------------
  // lanes.ts — pure pre-flight guards on the id-based mutation boundary.
  // -------------------------------------------------------------------------

  test("moveItemToLane rejects an invalid target lane with an {ok:false} result (never throws)", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "Lane-guard subject", category: "test" });

    const res = await admin.moveItemToLane(id, "no-such-lane");
    assert.equal(res.ok, false);
    assert.match(res.error, /Invalid lane: no-such-lane/);

    // The item did not move — still in its original lane.
    const item = await getItem(id);
    assert.equal(item.lane, "backlog");
  });

  test("moveItemToLane on an unknown item id returns {ok:false, error:'Item not found'}", async (t) => {
    requireRedis(t);
    const res = await admin.moveItemToLane("does-not-exist-999", "queued");
    assert.equal(res.ok, false);
    assert.equal(res.error, "Item not found");
  });

  test("deleteItem on an unknown item id returns {ok:false} rather than throwing", async (t) => {
    requireRedis(t);
    const res = await admin.deleteItem("does-not-exist-999");
    assert.equal(res.ok, false);
    assert.equal(res.error, "Item not found");
  });

  test("deleteItem removes an existing item and reports ok", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "Delete me", category: "test" });
    const res = await admin.deleteItem(id);
    assert.equal(res.ok, true);
    assert.equal(await getItem(id), null);
  });

  // -------------------------------------------------------------------------
  // reaper.ts — the never-/badly-claimed inProgress item fail-open branches.
  // -------------------------------------------------------------------------

  test("getStaleClaims annotates a NULL-claimedAt inProgress item ageMs=0 (never stale, not NaN)", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "Parked no-claim", category: "test" });
    await admin.moveToInProgress("Parked no-claim", { claimedBy: "claude" });
    // Simulate a manually-parked / migrated row that carries no claimedAt.
    await setClaimedAt(id, null);

    const { all, stale } = await admin.getStaleClaims({ maxAgeMs: 1 });
    const view = all.find((c: any) => c.id === id);
    assert.ok(view, "item must appear in the all[] annotation");
    assert.equal(view.claimedAt, null);
    assert.equal(view.claimedAgeMs, 0, "non-finite claimedAt collapses to ageMs=0, not NaN");
    assert.ok(!stale.some((c: any) => c.id === id), "ageMs=0 can never exceed any positive threshold");
  });

  test("getStaleClaims treats an UNPARSEABLE claimedAt the same way (ageMs=0, fail-open)", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "Garbage claim ts", category: "test" });
    await admin.moveToInProgress("Garbage claim ts", { claimedBy: "claude" });
    await setClaimedAt(id, "not-a-real-date");

    const { all, stale } = await admin.getStaleClaims({ maxAgeMs: 1 });
    const view = all.find((c: any) => c.id === id);
    assert.equal(view.claimedAgeMs, 0);
    assert.ok(!stale.some((c: any) => c.id === id));
  });

  test("reapStaleClaims SKIPS a NULL-claimedAt inProgress item (the !claimedAt continue guard)", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "Never-claimed WIP", category: "test" });
    await admin.moveToInProgress("Never-claimed WIP", { claimedBy: "claude" });
    await setClaimedAt(id, null);

    const result = await admin.reapStaleClaims({
      maxAgeMs: 1, // aggressively low: anything with a real age would reap
      fetchOpenPrRefs: async () => null,
      fetchMergedPrRefs: async () => null,
    });

    assert.equal(result.reaped.length, 0, "a null-claimedAt item is never reaped");
    assert.equal(result.reapedToDone.length, 0);
    const item = await getItem(id);
    assert.equal(item.lane, "inProgress", "the item stays put in inProgress");
  });

  test("reapStaleClaims SKIPS an UNPARSEABLE-claimedAt inProgress item (non-finite continue guard)", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "Garbage-claim WIP", category: "test" });
    await admin.moveToInProgress("Garbage-claim WIP", { claimedBy: "claude" });
    await setClaimedAt(id, "garbage");

    const result = await admin.reapStaleClaims({
      maxAgeMs: 1,
      fetchOpenPrRefs: async () => null,
      fetchMergedPrRefs: async () => null,
    });

    assert.equal(result.reaped.length, 0);
    const item = await getItem(id);
    assert.equal(item.lane, "inProgress");
  });

  // -------------------------------------------------------------------------
  // reconciler.ts — a feed fetcher that THROWS must be caught (never-throw).
  // -------------------------------------------------------------------------

  test("reconcileMergedItems catches a THROWING feed fetcher and degrades it to a failed feed", async (t) => {
    requireRedis(t);
    // One good feed (commits) still available so this is a single-feed failure,
    // not both-down; the sweep proceeds on the surviving feed and never throws.
    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => {
        throw new Error("gh exploded");
      },
      fetchMergeCommitRefs: async () => [],
    });

    assert.ok(result.feed.prs.failed, "the throwing feed is marked failed");
    assert.match(result.feed.prs.failed, /merged-PR feed threw: gh exploded/);
    assert.equal(result.feed.commits.failed, undefined, "the surviving feed is not marked failed");
    assert.equal(result.feedsAvailable, true, "one live feed keeps the sweep available");
    assert.equal(result.alert, undefined, "a single-feed failure does not raise the both-down alert");
  });

  test("reconcileMergedItems: BOTH feeds throwing => both-feeds-down alert, still no throw", async (t) => {
    requireRedis(t);
    const result = await admin.reconcileMergedItems({
      fetchMergedPrRefs: async () => {
        throw new Error("pr feed down");
      },
      fetchMergeCommitRefs: async () => {
        throw new Error("commit feed down");
      },
    });

    assert.equal(result.feedsAvailable, false, "both feeds failed");
    assert.ok(result.feed.prs.failed);
    assert.ok(result.feed.commits.failed);
    assert.ok(result.alert, "both-down raises an alert");
    assert.equal(result.alert.code, "reconciler:both-feeds-down");
    assert.equal(result.reconciled.length, 0, "nothing is moved to done when the sweep is blind");
  });
});
