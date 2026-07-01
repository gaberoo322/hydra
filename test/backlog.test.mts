/**
 * Regression tests for src/backlog/ — Redis-backed Kanban state machine.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — cleaned up between tests via hydra:backlog:* key flush.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set REDIS_URL before any import of backlog modules so the singleton picks up DB 1.
// Safe to set before the static namespace imports below: the Redis singleton in
// src/redis/connection.ts reads process.env.REDIS_URL lazily on first connect (inside
// a function), not at module-eval time, and no backlog module opens a connection at
// import scope — so import order does not pin the DB.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

// Static namespace imports (not a dynamic-import spread) so knip can trace that these
// exports are live test infrastructure. The prior `admin = { ...await import(...) }`
// spread was untraceable by knip, which repeatedly mis-filed these exports as unused
// (issues #1573–#1581).
import * as reads from "../src/backlog/reads.ts";
import * as items from "../src/backlog/items.ts";
import * as lanes from "../src/backlog/lanes.ts";
import * as claims from "../src/backlog/claims.ts";
import * as wip from "../src/backlog/wip.ts";
import * as reaper from "../src/backlog/reaper.ts";
// applyLaneTransition is a Module-internal helper (issue #2142 clock seam) — the
// pure-function tests call it directly rather than through the lane wrappers.
import { applyLaneTransition as applyLaneTransitionDirect } from "../src/backlog/internal.ts";

const admin: any = { ...reads, ...items, ...lanes, ...claims, ...wip, ...reaper };
let redis: any;
let redisAvailable = false;

async function cleanBacklogKeys() {
  const keys = await redis.keys("hydra:backlog:*");
  if (keys.length > 0) await redis.del(...keys);
}

/** Call at top of each test — skips the test if Redis is unreachable. */
function requireRedis(t: any) {
  if (!redisAvailable) {
    t.skip("Redis unavailable");
  }
}

describe("backlog state machine", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch (err) {
        console.error("Redis unavailable at localhost:6379/1, skipping backlog tests");
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
    // Close the shared redis-adapter connection used by backlog.ts
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("addToBacklog → getBacklogCounts round-trip", async (t) => {
    requireRedis(t);
    const result = await admin.addToBacklog({
      title: "Test item 1",
      category: "reliability",
    });
    assert.equal(result.added, true);

    const counts = await admin.getBacklogCounts();
    assert.equal(counts.backlog, 1);
    assert.equal(counts.queued, 0);
    assert.equal(counts.total, 1);
  });

  test("addToBacklog dedups items with the same title", async (t) => {
    requireRedis(t);
    const first = await admin.addToBacklog({
      title: "Duplicate test",
      category: "test",
    });
    const second = await admin.addToBacklog({
      title: "Duplicate test",
      category: "test",
    });
    assert.equal(first.added, true);
    assert.equal(second.added, false);
    assert.equal(second.reason, "duplicate");
  });

  test("promoteToQueued moves items backlog → queued", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Promote me A", category: "test" });
    await admin.addToBacklog({ title: "Promote me B", category: "test" });

    const promoted = await admin.promoteToQueued(2);
    assert.equal(promoted.length, 2);

    const counts = await admin.getBacklogCounts();
    assert.equal(counts.backlog, 0);
    assert.equal(counts.queued, 2);
  });

  test("promoteToQueued with count > backlog length moves only what exists", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Only one", category: "test" });
    const promoted = await admin.promoteToQueued(5);
    assert.equal(promoted.length, 1);
  });

  test("regression (2026-04-08): moveToInProgress requires EXACT title match", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({
      title: "Exact title required",
      category: "test",
    });
    await admin.promoteToQueued(1);

    // Mismatched title → no-op, returns false
    const mismatchResult = await admin.moveToInProgress(
      "Rephrased exact title required",
    );
    assert.equal(
      mismatchResult,
      false,
      "mismatched title must silently return false",
    );

    // Exact title → succeeds, returns true
    const exactResult = await admin.moveToInProgress(
      "Exact title required",
    );
    assert.equal(exactResult, true, "exact title must succeed");

    const counts = await admin.getBacklogCounts();
    assert.equal(counts.queued, 0);
    assert.equal(counts.inProgress, 1);
  });

  test("moveToInProgress can also pull directly from Backlog lane", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({
      title: "Direct from backlog",
      category: "test",
    });
    const result = await admin.moveToInProgress("Direct from backlog");
    assert.equal(result, true);
    const counts = await admin.getBacklogCounts();
    assert.equal(counts.backlog, 0);
    assert.equal(counts.inProgress, 1);
  });

  test("moveToDone moves items from any lane", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({
      title: "Lifecycle item",
      category: "test",
    });
    // Can complete directly from backlog (e.g. merged while blocked/queued)
    const fromBacklog = await admin.moveToDone("Lifecycle item", "merged");
    assert.equal(fromBacklog, true);

    const counts = await admin.getBacklogCounts();
    assert.equal(counts.backlog, 0);
    assert.equal(counts.done, 1);
  });

  test("moveToDone moves in-progress items to done", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({
      title: "In-progress item",
      category: "test",
    });
    await admin.promoteToQueued(1);
    await admin.moveToInProgress("In-progress item");
    const done = await admin.moveToDone("In-progress item", "merged");
    assert.equal(done, true);

    const counts = await admin.getBacklogCounts();
    assert.equal(counts.inProgress, 0);
    assert.equal(counts.done, 1);
  });

  test("returnToBacklog moves in-progress items back with reason", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Will fail", category: "test" });
    await admin.promoteToQueued(1);
    await admin.moveToInProgress("Will fail");
    const result = await admin.returnToBacklog(
      "Will fail",
      "rolled-back",
    );
    assert.equal(result, true);

    const counts = await admin.getBacklogCounts();
    assert.equal(counts.backlog, 1);
    assert.equal(counts.inProgress, 0);
  });

  test("full lifecycle: add → promote → inProgress → done", async (t) => {
    requireRedis(t);
    const title = "End-to-end item";
    await admin.addToBacklog({ title, category: "e2e" });

    let counts = await admin.getBacklogCounts();
    assert.equal(counts.backlog, 1);

    await admin.promoteToQueued(1);
    counts = await admin.getBacklogCounts();
    assert.equal(counts.queued, 1);

    await admin.moveToInProgress(title);
    counts = await admin.getBacklogCounts();
    assert.equal(counts.inProgress, 1);

    await admin.moveToDone(title, "merged");
    counts = await admin.getBacklogCounts();
    assert.equal(counts.done, 1);
    assert.equal(counts.backlog, 0);
    assert.equal(counts.queued, 0);
    assert.equal(counts.inProgress, 0);
  });

  // --- Linear-inspired upgrade tests ---

  test("addToBacklog with priority and description populates fields", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({
      title: "Urgent fix",
      category: "execution",
      priority: 1,
      description: "## Fix\nThis is urgent",
      labels: ["execution", "kalshi"],
      estimate: 3,
    });
    const lanes = await admin.loadBacklog();
    const item = lanes.backlog[0];
    assert.equal(item.priority, 1);
    assert.equal(item.description, "## Fix\nThis is urgent");
    assert.deepEqual(item.labels, ["execution", "kalshi"]);
    assert.equal(item.estimate, 3);
    assert.equal(item.parentId, null);
  });

  test("existing items without new fields get defaults (backward compat)", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Legacy item", category: "test" });
    const lanes = await admin.loadBacklog();
    const item = lanes.backlog[0];
    assert.equal(item.priority, 0);
    assert.equal(item.description, "");
    assert.deepEqual(item.labels, []);
    assert.equal(item.estimate, null);
    assert.equal(item.parentId, null);
  });

  test("promoteToQueued promotes by priority (urgent before low before none)", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "No priority", category: "test" });
    await admin.addToBacklog({ title: "Low priority", category: "test", priority: 4 });
    await admin.addToBacklog({ title: "Urgent", category: "test", priority: 1 });

    const promoted = await admin.promoteToQueued(3);
    assert.equal(promoted[0].title, "Urgent");
    assert.equal(promoted[1].title, "Low priority");
    assert.equal(promoted[2].title, "No priority");
  });

  test("promoteToQueued falls back to score for equal priority", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Low score", category: "test", priority: 2, adjustedScore: 10 });
    await admin.addToBacklog({ title: "High score", category: "test", priority: 2, adjustedScore: 90 });

    const promoted = await admin.promoteToQueued(2);
    assert.equal(promoted[0].title, "High score");
    assert.equal(promoted[1].title, "Low score");
  });

  test("triage lane in loadBacklog and getBacklogCounts", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Triage item", category: "test", lane: "triage" });
    const lanes = await admin.loadBacklog();
    assert.equal(lanes.triage.length, 1);
    assert.equal(lanes.triage[0].title, "Triage item");

    const counts = await admin.getBacklogCounts();
    assert.equal(counts.triage, 1);
    assert.equal(counts.total, 1); // triage counts toward total
  });

  test("addToBacklog with lane: triage places item in triage", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Research finding", category: "research", lane: "triage" });
    const counts = await admin.getBacklogCounts();
    assert.equal(counts.triage, 1);
    assert.equal(counts.backlog, 0);
  });

  test("updateItem modifies allowed fields", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "Update me", category: "test" });
    const result = await admin.updateItem(id, { priority: 2, description: "Updated desc", labels: ["infra"] });
    assert.equal(result.ok, true);
    assert.equal(result.item.priority, 2);
    assert.equal(result.item.description, "Updated desc");
    assert.deepEqual(result.item.labels, ["infra"]);
    assert.equal(result.item.title, "Update me"); // unchanged
  });

  test("updateItem rejects unknown item IDs", async (t) => {
    requireRedis(t);
    const result = await admin.updateItem("item-99999", { priority: 1 });
    assert.equal(result.ok, false);
  });

  // --- WIP limit tests ---

  test("isWipLimitReached returns false when no items in-progress", async (t) => {
    requireRedis(t);
    const wip = await admin.isWipLimitReached();
    assert.equal(wip.atLimit, false);
    assert.equal(wip.count, 0);
    assert.equal(typeof wip.limit, "number");
  });

  test("isWipLimitReached returns true when in-progress count >= WIP_LIMIT", async (t) => {
    requireRedis(t);
    // Move WIP_LIMIT items to in-progress
    const limit = admin.WIP_LIMIT;
    for (let i = 0; i < limit; i++) {
      await admin.addToBacklog({ title: `WIP item ${i}`, category: "test" });
      await admin.moveToInProgress(`WIP item ${i}`);
    }

    const wip = await admin.isWipLimitReached();
    assert.equal(wip.atLimit, true);
    assert.equal(wip.count, limit);
  });

  test("getInProgressCount returns correct count", async (t) => {
    requireRedis(t);
    assert.equal(await admin.getInProgressCount(), 0);

    await admin.addToBacklog({ title: "Count test A", category: "test" });
    await admin.moveToInProgress("Count test A");
    assert.equal(await admin.getInProgressCount(), 1);

    await admin.addToBacklog({ title: "Count test B", category: "test" });
    await admin.moveToInProgress("Count test B");
    assert.equal(await admin.getInProgressCount(), 2);
  });

  test("getInProgressItems returns items sorted from inProgress lane", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "IP item 1", category: "test", priority: 2 });
    await admin.moveToInProgress("IP item 1");
    await admin.addToBacklog({ title: "IP item 2", category: "test", priority: 1 });
    await admin.moveToInProgress("IP item 2");

    const items = await admin.getInProgressItems();
    assert.equal(items.length, 2);
    const titles = items.map((i: any) => i.title);
    assert.ok(titles.includes("IP item 1"));
    assert.ok(titles.includes("IP item 2"));
  });

  // -------------------------------------------------------------------------
  // Issue #191 — every lane transition must record movedAt; inProgress
  // transitions must also record claimedAt + claimedBy; WIP cap must be
  // enforced at claim time so stalled items can't silently exceed the limit.
  // -------------------------------------------------------------------------

  test("issue #191: addToBacklog stamps movedAt on initial lane assignment", async (t) => {
    requireRedis(t);
    const before = Date.now();
    const { id } = await admin.addToBacklog({ title: "Initial stamp", category: "test" });
    const after = Date.now();

    const lanes = await admin.loadBacklog();
    const item = lanes.backlog.find((i: any) => i.id === id);
    assert.ok(item, "added item should be in backlog lane");
    assert.ok(typeof item.movedAt === "string", "movedAt must be a string");
    const ts = new Date(item.movedAt).getTime();
    assert.ok(Number.isFinite(ts), `movedAt "${item.movedAt}" must parse as a timestamp`);
    assert.ok(ts >= before - 1 && ts <= after + 1, `movedAt ${ts} must fall within [${before},${after}]`);
    // Items not in inProgress should have null claim metadata.
    assert.equal(item.claimedAt, null);
    assert.equal(item.claimedBy, null);
  });

  test("issue #191: lifecycle queued → inProgress → done writes movedAt on every transition", async (t) => {
    requireRedis(t);
    const title = "Lifecycle 191";
    await admin.addToBacklog({ title, category: "test" });
    await admin.promoteToQueued(1);

    const queuedLanes = await admin.loadBacklog();
    const queuedItem = queuedLanes.queued.find((i: any) => i.title === title);
    assert.ok(queuedItem.movedAt, "queued transition must set movedAt");
    const queuedTs = new Date(queuedItem.movedAt).getTime();

    // Force a small gap so movedAt strictly increases across transitions.
    await new Promise(r => setTimeout(r, 5));

    await admin.moveToInProgress(title, { claimedBy: "claude" });
    const inProgLanes = await admin.loadBacklog();
    const inProgItem = inProgLanes.inProgress.find((i: any) => i.title === title);
    assert.ok(inProgItem.movedAt, "inProgress transition must set movedAt");
    assert.equal(inProgItem.claimedBy, "claude", "inProgress transition must set claimedBy");
    assert.ok(inProgItem.claimedAt, "inProgress transition must set claimedAt");
    const inProgTs = new Date(inProgItem.movedAt).getTime();
    assert.ok(inProgTs > queuedTs, `movedAt must strictly increase: ${inProgTs} > ${queuedTs}`);
    // claimedAt should match movedAt at the moment of claim.
    assert.equal(inProgItem.claimedAt, inProgItem.movedAt);

    await new Promise(r => setTimeout(r, 5));

    await admin.moveToDone(title, "merged");
    const doneLanes = await admin.loadBacklog();
    const doneItem = doneLanes.done.find((i: any) => i.title === title);
    assert.ok(doneItem.movedAt, "done transition must set movedAt");
    const doneTs = new Date(doneItem.movedAt).getTime();
    assert.ok(doneTs > inProgTs, `movedAt must strictly increase across all transitions: ${doneTs} > ${inProgTs}`);
    // Leaving inProgress must clear the claim fields so stale claimedBy
    // doesn't confuse downstream consumers (e.g. ownership audits).
    assert.equal(doneItem.claimedBy, null);
    assert.equal(doneItem.claimedAt, null);
  });

  test("issue #191: returnToBacklog refreshes movedAt and clears claim fields", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Return claim 191", category: "test" });
    await admin.moveToInProgress("Return claim 191", { claimedBy: "codex" });
    await new Promise(r => setTimeout(r, 5));
    await admin.returnToBacklog("Return claim 191", "rolled-back");

    const lanes = await admin.loadBacklog();
    const item = lanes.backlog.find((i: any) => i.title === "Return claim 191");
    assert.ok(item, "returned item should be back in backlog lane");
    assert.ok(item.movedAt, "returnToBacklog must set movedAt");
    assert.equal(item.claimedBy, null, "returning to backlog must clear claimedBy");
    assert.equal(item.claimedAt, null, "returning to backlog must clear claimedAt");
  });

  test("issue #191: blockByTitle stamps movedAt", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Block stamp 191", category: "test" });
    await admin.blockByTitle("Block stamp 191", "needs-info");
    const lanes = await admin.loadBacklog();
    const item = lanes.blocked.find((i: any) => i.title === "Block stamp 191");
    assert.ok(item.movedAt, "blockByTitle must set movedAt");
  });

  test("issue #191: moveToInProgress refuses claim when WIP cap is reached", async (t) => {
    requireRedis(t);
    const limit = admin.WIP_LIMIT;
    // Fill the inProgress lane to the cap.
    for (let i = 0; i < limit; i++) {
      await admin.addToBacklog({ title: `WIP cap fill ${i}`, category: "test" });
      const ok = await admin.moveToInProgress(`WIP cap fill ${i}`);
      assert.equal(ok, true, `pre-cap claim ${i} must succeed`);
    }
    // One more item — claim must be refused.
    await admin.addToBacklog({ title: "WIP cap overflow", category: "test" });
    const refusedLegacy = await admin.moveToInProgress("WIP cap overflow");
    assert.equal(refusedLegacy, false, "legacy signature must return false when WIP cap is reached");

    // The structured signature should report the wip-limit reason.
    const refusedStructured = await admin.moveToInProgress("WIP cap overflow", { claimedBy: "claude" });
    assert.equal(refusedStructured.blocked, "wip-limit");
    assert.equal(refusedStructured.count, limit);
    assert.equal(refusedStructured.limit, limit);

    // The overflow item must still be in its original lane (backlog), not inProgress.
    const counts = await admin.getBacklogCounts();
    assert.equal(counts.inProgress, limit);
    assert.equal(counts.backlog, 1);
  });

  test("issue #191: GET /api/backlog surfaces movedAt, claimedAt, claimedBy on every item", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "API queued visible", category: "test" });
    await admin.addToBacklog({ title: "API in-progress visible", category: "test" });
    await admin.moveToInProgress("API in-progress visible", { claimedBy: "codex" });

    const { createBacklogRouter } = await import("../src/api/backlog.ts");
    const router = createBacklogRouter();

    // Find the GET /backlog handler in the router stack.
    let handler: Function | null = null;
    for (const layer of router.stack) {
      if (layer.route && layer.route.path === "/backlog" && layer.route.methods.get) {
        const stack = layer.route.stack;
        handler = stack[stack.length - 1].handle;
        break;
      }
    }
    assert.ok(handler, "GET /backlog handler should exist");

    let body: any = null;
    const res: any = {
      status() { return res; },
      json(b: any) { body = b; return res; },
    };
    await handler!({ method: "GET", url: "/backlog", headers: {}, query: {}, params: {}, body: {} }, res, () => {});

    assert.ok(body, "handler must respond with a body");
    assert.ok(Array.isArray(body.backlog));
    assert.ok(Array.isArray(body.inProgress));

    // Every backlog item must expose movedAt.
    for (const item of body.backlog) {
      assert.ok(typeof item.movedAt === "string", `backlog item ${item.id} must expose movedAt`);
    }
    // Every inProgress item must expose movedAt + claimedAt + claimedBy.
    for (const item of body.inProgress) {
      assert.ok(typeof item.movedAt === "string", `inProgress item ${item.id} must expose movedAt`);
      assert.ok(typeof item.claimedAt === "string", `inProgress item ${item.id} must expose claimedAt`);
      assert.ok(item.claimedBy, `inProgress item ${item.id} must expose claimedBy`);
    }

    const ipItem = body.inProgress.find((i: any) => i.title === "API in-progress visible");
    assert.equal(ipItem.claimedBy, "codex");
  });

  test("issue #191: claimNextQueuedItem stamps movedAt + claimedAt + claimedBy", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Lua claim 191", category: "test" });
    await admin.promoteToQueued(1);

    const before = Date.now();
    const result = await admin.claimNextQueuedItem("claude");
    const after = Date.now();

    assert.equal(result.claimed, true);
    assert.equal(result.item.lane, "inProgress");
    assert.equal(result.item.claimedBy, "claude");
    assert.ok(result.item.movedAt, "claimNextQueuedItem must set movedAt");
    assert.ok(result.item.claimedAt, "claimNextQueuedItem must set claimedAt");
    const ts = new Date(result.item.movedAt).getTime();
    assert.ok(ts >= before - 1 && ts <= after + 1, `movedAt ${ts} must fall within [${before},${after}]`);
    assert.equal(result.item.claimedAt, result.item.movedAt);
  });

  // -------------------------------------------------------------------------
  // Issue #1122 — a corrupt `hydra:backlog:items` entry must surface a logged
  // error rather than silently stalling the queue with `parse-error`.
  // -------------------------------------------------------------------------
  test("issue #1122: corrupt queue item logs an error rather than silently returning parse-error", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "Corrupt claim 1122", category: "test" });
    await admin.promoteToQueued(1);

    // Find the queued item's id, then poison its `hydra:backlog:items` hash
    // entry with non-JSON so the Lua claim returns a value JSON.parse chokes on.
    const queued = await admin.peekNextQueuedItem();
    assert.ok(queued && queued.id, "test setup: a queued item must exist");
    await redis.hset("hydra:backlog:items", queued.id, "{not valid json");

    // Capture console.error for the duration of the claim.
    const original = console.error;
    const calls: any[][] = [];
    console.error = (...args: any[]) => {
      calls.push(args);
    };
    let result: any;
    try {
      result = await admin.claimNextQueuedItem("claude");
    } finally {
      console.error = original;
    }

    assert.equal(result.claimed, false);
    assert.equal(result.reason, "parse-error");
    assert.ok(
      calls.length >= 1,
      "a corrupt queue item must trigger at least one console.error, not a silent parse-error",
    );
    const logged = calls.flat().map(String).join(" ");
    assert.ok(
      /backlog\/claim/.test(logged) && /parse/i.test(logged),
      `the logged error must identify the claim-path parse failure (got: ${logged})`,
    );
  });

  // --- moveItemToLane blocked-reason schedulability guard (issue #1920) ---

  test("moveItemToLane refuses blocked transition when no blockedReason exists", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "Unexplained block 1920", category: "test" });

    const result = await admin.moveItemToLane(id, "blocked");

    assert.equal(result.ok, false, "a reasonless block move must be refused, not silently applied");
    assert.equal(result.error, "missing-blocked-reason");

    // The item must NOT have moved to the blocked lane.
    const lanes = await admin.loadBacklog();
    assert.ok(
      !lanes.blocked.some((i: any) => i.title === "Unexplained block 1920"),
      "the unschedulable item must stay out of the blocked lane",
    );
    assert.ok(
      lanes.backlog.some((i: any) => i.title === "Unexplained block 1920"),
      "the item must remain in its original lane",
    );
  });

  test("moveItemToLane accepts a blocked transition when a reason is supplied via opts", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "Explained block 1920", category: "test" });

    const result = await admin.moveItemToLane(id, "blocked", { reason: "waiting on operator key" });

    assert.equal(result.ok, true);
    const lanes = await admin.loadBacklog();
    const blocked = lanes.blocked.find((i: any) => i.title === "Explained block 1920");
    assert.ok(blocked, "an explained item must land in the blocked lane");
    assert.equal(
      blocked.meta?.blockedReason,
      "waiting on operator key",
      "the supplied reason must be stamped on meta.blockedReason for downstream actionability",
    );
  });

  test("moveItemToLane accepts a blocked transition when the item already carries a blockedReason", async (t) => {
    requireRedis(t);
    // blockByTitle already stamps meta.blockedReason; once blocked, a later
    // re-block (e.g. dashboard drag) must not be refused for missing reason.
    await admin.addToBacklog({ title: "Pre-blocked 1920", category: "test" });
    await admin.blockByTitle("Pre-blocked 1920", "original reason");
    let lanes = await admin.loadBacklog();
    const blockedId = lanes.blocked.find((i: any) => i.title === "Pre-blocked 1920").id;

    // Move out and back without a reason — the pre-existing reason satisfies the guard.
    await admin.moveItemToLane(blockedId, "queued");
    const result = await admin.moveItemToLane(blockedId, "blocked");

    assert.equal(result.ok, true, "an item that already has a blockedReason may re-enter blocked");
    lanes = await admin.loadBacklog();
    assert.ok(lanes.blocked.some((i: any) => i.id === blockedId));
  });

  test("moveItemToLane blocked-reason guard does not affect non-blocked transitions", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "Plain move 1920", category: "test" });

    // Moving to a non-blocked lane never requires a reason.
    const result = await admin.moveItemToLane(id, "queued");
    assert.equal(result.ok, true);
    const lanes = await admin.loadBacklog();
    assert.ok(lanes.queued.some((i: any) => i.title === "Plain move 1920"));
  });

  // Issue #2142 — clock seam: each public lanes.ts transition (and the shared
  // applyLaneTransition helper) takes an optional trailing `now: number =
  // Date.now()`, so a test can pin a fixed instant and assert EXACT
  // movedAt/claimedAt/date-only meta with zero clock tolerance. Production
  // callers that pass no `now` must behave byte-identically (default-path
  // identity). The pattern mirrors stale-escalation.ts (itemAgeMs(item, now)).
  // Nested inside the parent suite so it shares the parent's beforeEach (Redis
  // clean) and after (closeRedisConnections) lifecycle — a sibling top-level
  // describe would run after the parent's `after` closed the shared connection.

  // A fixed instant well in the past so derivations are unambiguous and stable.
  const PINNED = Date.UTC(2026, 0, 2, 3, 4, 5); // 2026-01-02T03:04:05.000Z
  const PINNED_ISO = "2026-01-02T03:04:05.000Z";
  const PINNED_DATE = "2026-01-02";

  async function laneItemByTitle(lane: string, title: string) {
    const lanes = await admin.loadBacklog();
    return (lanes[lane] || []).find((i: any) => i.title === title);
  }

  test("applyLaneTransition derives movedAt from the injected now (queued)", (t) => {
    const item: any = { id: 1, title: "pin", lane: "backlog" };
    const { movedAt } = applyLaneTransitionDirect(item, "queued", {}, PINNED);
    assert.equal(movedAt, PINNED_ISO, "movedAt must come from the injected now, not the wall clock");
    assert.equal(item.movedAt, PINNED_ISO);
    assert.equal(item.claimedAt, null, "non-inProgress transition clears claimedAt");
    assert.equal(item.claimedBy, null);
  });

  test("applyLaneTransition pins claimedAt=movedAt on inProgress entry", (t) => {
    const item: any = { id: 1, title: "pin", lane: "queued" };
    applyLaneTransitionDirect(item, "inProgress", { claimedBy: "agent-x" }, PINNED);
    assert.equal(item.movedAt, PINNED_ISO);
    assert.equal(item.claimedAt, PINNED_ISO, "inProgress entry sets claimedAt = movedAt from the same now");
    assert.equal(item.claimedBy, "agent-x");
  });

  test("applyLaneTransition default-path identity: omitting now uses the wall clock", (t) => {
    const before = Date.now();
    const item: any = { id: 1, title: "now-default", lane: "backlog" };
    const { movedAt } = applyLaneTransitionDirect(item, "queued");
    const after = Date.now();
    const ts = new Date(movedAt).getTime();
    assert.ok(ts >= before && ts <= after, "default movedAt must be a current wall-clock timestamp");
  });

  test("promoteToQueued stamps queuedAt + movedAt from the injected now", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "promote-pin", category: "test" });
    await admin.promoteToQueued(1, PINNED);
    const item = await laneItemByTitle("queued", "promote-pin");
    assert.ok(item, "item must be in queued lane");
    assert.equal(item.movedAt, PINNED_ISO, "movedAt pinned to injected now");
    assert.equal(item.meta.queuedAt, PINNED_DATE, "queuedAt date-only pinned to injected now");
  });

  test("moveToInProgress pins startedAt, movedAt, and claimedAt from one now", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "inprog-pin", category: "test" });
    await admin.moveToInProgress("inprog-pin", { claimedBy: "agent-y" }, PINNED);
    const item = await laneItemByTitle("inProgress", "inprog-pin");
    assert.ok(item, "item must be in inProgress lane");
    assert.equal(item.meta.startedAt, PINNED_DATE, "startedAt date-only pinned");
    assert.equal(item.movedAt, PINNED_ISO, "movedAt pinned");
    assert.equal(item.claimedAt, PINNED_ISO, "claimedAt pinned to the same now");
    assert.equal(item.claimedBy, "agent-y");
  });

  test("moveToDone pins completedAt + movedAt from the injected now", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "done-pin", category: "test" });
    await admin.moveToInProgress("done-pin");
    await admin.moveToDone("done-pin", "merged", PINNED);
    const item = await laneItemByTitle("done", "done-pin");
    assert.ok(item, "item must be in done lane");
    assert.equal(item.meta.completedAt, PINNED_DATE, "completedAt date-only pinned");
    assert.equal(item.movedAt, PINNED_ISO, "movedAt pinned");
  });

  test("blockByTitle pins blockedAt + movedAt from the injected now", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "block-pin", category: "test" });
    await admin.blockByTitle("block-pin", "waiting", PINNED);
    const item = await laneItemByTitle("blocked", "block-pin");
    assert.ok(item, "item must be in blocked lane");
    assert.equal(item.meta.blockedAt, PINNED_DATE, "blockedAt date-only pinned");
    assert.equal(item.meta.blockedReason, "waiting");
    assert.equal(item.movedAt, PINNED_ISO, "movedAt pinned");
  });

  test("returnToBacklog pins returnedAt + movedAt from the injected now", async (t) => {
    requireRedis(t);
    await admin.addToBacklog({ title: "return-pin", category: "test" });
    await admin.moveToInProgress("return-pin");
    await admin.returnToBacklog("return-pin", "abandoned", PINNED);
    const item = await laneItemByTitle("backlog", "return-pin");
    assert.ok(item, "item must be back in backlog lane");
    assert.equal(item.meta.returnedAt, PINNED_DATE, "returnedAt date-only pinned");
    assert.equal(item.meta.returnReason, "abandoned");
    assert.equal(item.movedAt, PINNED_ISO, "movedAt pinned");
  });

  test("moveItemToLane (blocked path / moveToBlocked alias) pins blockedAt + movedAt", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "movelane-block-pin", category: "test" });
    const result = await admin.moveItemToLane(id, "blocked", { reason: "needs key" }, PINNED);
    assert.equal(result.ok, true);
    const item = await laneItemByTitle("blocked", "movelane-block-pin");
    assert.ok(item, "item must be in blocked lane");
    assert.equal(item.meta.blockedAt, PINNED_DATE, "blockedAt date-only pinned");
    assert.equal(item.meta.blockedReason, "needs key");
    assert.equal(item.movedAt, PINNED_ISO, "movedAt pinned");
  });

  test("moveItemToLane inProgress path pins claimedAt from the injected now", async (t) => {
    requireRedis(t);
    const { id } = await admin.addToBacklog({ title: "movelane-inprog-pin", category: "test" });
    const result = await admin.moveItemToLane(id, "inProgress", { claimedBy: "agent-z" }, PINNED);
    assert.equal(result.ok, true);
    const item = await laneItemByTitle("inProgress", "movelane-inprog-pin");
    assert.ok(item, "item must be in inProgress lane");
    assert.equal(item.movedAt, PINNED_ISO, "movedAt pinned");
    assert.equal(item.claimedAt, PINNED_ISO, "claimedAt pinned to the same now");
    assert.equal(item.claimedBy, "agent-z");
  });

  test("pruneOldDoneItems honors the injected now for its retention cutoff", async (t) => {
    requireRedis(t);
    // An item completed at PINNED is 'old' relative to a now 30 days later,
    // but 'fresh' relative to a now equal to PINNED. DONE_RETENTION_DAYS = 7.
    const DAY_MS = 24 * 60 * 60 * 1000;
    await admin.addToBacklog({ title: "prune-pin", category: "test" });
    await admin.moveToInProgress("prune-pin");
    await admin.moveToDone("prune-pin", "merged", PINNED);

    // now == PINNED: completedAt is not yet past the 7-day cutoff → not pruned.
    await admin.pruneOldDoneItems(PINNED);
    let item = await laneItemByTitle("done", "prune-pin");
    assert.ok(item, "item completed 'now' must survive pruning at now == completedAt");

    // now == PINNED + 30 days: completedAt is well past the cutoff → pruned.
    await admin.pruneOldDoneItems(PINNED + 30 * DAY_MS);
    item = await laneItemByTitle("done", "prune-pin");
    assert.equal(item, undefined, "item completed 30 days before now must be pruned");
  });
});

// Pure type-narrowing tests for the loadBacklog() `Backlog` return type
// (issue #2230). These touch NO Redis — they exercise the compiler-enforced
// lane-key shape that replaced the old `Promise<Record<string, any[]>>`. Kept
// as a separate top-level describe with no before/after lifecycle so it cannot
// race the shared-Redis teardown of the suite above.
describe("loadBacklog Backlog return type (issue #2230)", () => {
  test("named lanes are accessible without an `as any` cast", () => {
    // The whole point of the type: each lane is reachable by name and is an
    // array — no cast, no `|| []` defensive fallback. If a lane were renamed
    // in the `Backlog` type, this destructure would be a compile error.
    const backlog: reads.Backlog = {
      triage: [],
      backlog: [{ id: 1, title: "t" }],
      queued: [],
      blocked: [],
      inProgress: [{ id: 2, title: "p" }],
      done: [],
    };

    const { inProgress, triage, blocked } = backlog;
    assert.ok(Array.isArray(inProgress));
    assert.ok(Array.isArray(triage));
    assert.ok(Array.isArray(blocked));
    assert.equal(backlog.backlog[0].title, "t");
    assert.equal(backlog.inProgress[0].id, 2);
  });

  test("the historical string-indexed access pattern still type-checks", () => {
    // addToBacklog/getItemsByParent iterate `LANES` and index `lanes[lane]`
    // with a `string`. The index signature on `Backlog` preserves that.
    const backlog: reads.Backlog = {
      triage: [{ id: 1 }],
      backlog: [],
      queued: [],
      blocked: [],
      inProgress: [],
      done: [],
    };
    const laneName: string = "triage";
    const got = backlog[laneName];
    assert.equal(got.length, 1);
  });
});
