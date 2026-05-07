/**
 * Regression tests for src/backlog.mjs — Redis-backed Kanban state machine.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — cleaned up between tests via hydra:backlog:* key flush.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let backlog;
let admin;
let redis: any;
let redisAvailable = false;

// Set REDIS_URL before any import of backlog.ts so the singleton picks up DB 1
process.env.REDIS_URL = "redis://localhost:6379/1";

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
      const mod = await import("../src/backlog.ts");
      backlog = mod;
      admin = mod._admin;
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
    const { closeRedisConnections } = await import("../src/redis-adapter.ts");
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

  test("requeueStaleInProgressItems requeues old items, leaves fresh ones", async (t) => {
    requireRedis(t);
    // Add two items to in-progress
    await admin.addToBacklog({ title: "Fresh item", category: "test" });
    await admin.moveToInProgress("Fresh item");

    await admin.addToBacklog({ title: "Stale item", category: "test" });
    await admin.moveToInProgress("Stale item");

    // Manually backdate the stale item's startedAt to 10 days ago
    const inProgressItems = await admin.getInProgressItems();
    const staleEntry = inProgressItems.find((i: any) => i.title === "Stale item");
    const raw = await redis.hget("hydra:backlog:items", staleEntry.id);
    const staleItem = JSON.parse(raw);
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    staleItem.meta.startedAt = tenDaysAgo;
    await redis.hset("hydra:backlog:items", staleItem.id, JSON.stringify(staleItem));

    const requeued = await admin.requeueStaleInProgressItems();
    assert.equal(requeued.length, 1);
    assert.equal(requeued[0].title, "Stale item");
    assert.equal(requeued[0].lane, "queued");

    // Fresh item should still be in-progress
    const counts = await admin.getBacklogCounts();
    assert.equal(counts.inProgress, 1);
    assert.equal(counts.queued, 1);
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
});
