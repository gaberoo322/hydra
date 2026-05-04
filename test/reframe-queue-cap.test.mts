/**
 * Regression tests for reframe queue cap + TTL pruning (issue #57).
 *
 * Bug: hydra:anchors:reframe-queue accumulated 257 items unbounded.
 * Tasks that fail 3 times get escalated to reframe but the queue was
 * never drained or capped.
 *
 * Fix: pruneReframeQueue() enforces a 20-item cap and 7-day age limit.
 * Called from selectAnchor() before consuming reframe items.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;

const REFRAME_QUEUE_KEY = "hydra:anchors:reframe-queue";

async function cleanKeys() {
  const keys = await redis.keys("hydra:anchors:*");
  if (keys.length > 0) await redis.del(...keys);
}

describe("reframe queue cap (issue #57)", () => {
  let anchorSelection: any;

  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
    }
    await cleanKeys();
    // Fresh import each time to pick up env changes
    anchorSelection = await import("../src/anchor-selection.ts");
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  test("pruneReframeQueue removes items older than 7 days", async () => {
    // Insert a stale item (8 days old)
    const staleItem = JSON.stringify({
      originalTaskId: "stale-task",
      originalTitle: "Stale reframe",
      escalatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    // Insert a fresh item (1 hour old)
    const freshItem = JSON.stringify({
      originalTaskId: "fresh-task",
      originalTitle: "Fresh reframe",
      escalatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    await redis.rpush(REFRAME_QUEUE_KEY, staleItem, freshItem);

    const result = await anchorSelection._testing.pruneReframeQueue();

    assert.equal(result.pruned, 1, "should prune 1 stale item");
    const remaining = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    assert.equal(remaining.length, 1, "should have 1 item left");
    assert.ok(remaining[0].includes("fresh-task"), "fresh item should remain");
  });

  test("pruneReframeQueue enforces hard cap of 20", async () => {
    // Insert 25 fresh items
    for (let i = 0; i < 25; i++) {
      await redis.rpush(REFRAME_QUEUE_KEY, JSON.stringify({
        originalTaskId: `task-${i}`,
        originalTitle: `Reframe ${i}`,
        escalatedAt: new Date(Date.now() - i * 60 * 1000).toISOString(), // each 1 min apart
      }));
    }

    const result = await anchorSelection._testing.pruneReframeQueue();

    assert.equal(result.dropped, 5, "should drop 5 overflow items");
    const remaining = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    assert.equal(remaining.length, 20, "should have exactly 20 items");
    // Oldest items (0-4) should have been dropped
    assert.ok(remaining[0].includes("task-5"), "oldest items should be dropped first");
  });

  test("pruneReframeQueue drops corrupt items", async () => {
    await redis.rpush(REFRAME_QUEUE_KEY, "not-valid-json");
    await redis.rpush(REFRAME_QUEUE_KEY, JSON.stringify({
      originalTaskId: "good-task",
      originalTitle: "Good reframe",
      escalatedAt: new Date().toISOString(),
    }));

    const result = await anchorSelection._testing.pruneReframeQueue();

    assert.equal(result.pruned, 1, "should prune 1 corrupt item");
    const remaining = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    assert.equal(remaining.length, 1, "should have 1 good item left");
  });

  test("pruneReframeQueue no-ops on empty queue", async () => {
    const result = await anchorSelection._testing.pruneReframeQueue();
    assert.equal(result.pruned, 0);
    assert.equal(result.dropped, 0);
  });

  test("REFRAME_QUEUE_CAP is 20", () => {
    assert.equal(anchorSelection._testing.REFRAME_QUEUE_CAP, 20);
  });

  test("REFRAME_QUEUE_MAX_AGE_MS is 7 days", () => {
    assert.equal(anchorSelection._testing.REFRAME_QUEUE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  });

  test("REFRAME_INTERLEAVE_INTERVAL is 5", () => {
    assert.equal(anchorSelection._testing.REFRAME_INTERLEAVE_INTERVAL, 5);
  });
});
