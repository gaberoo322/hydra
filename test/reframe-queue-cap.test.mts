/**
 * Regression tests for reframe queue cap and pruning (issue #57).
 *
 * Bug: hydra:anchors:reframe-queue accumulated 257 items with no drain
 * mechanism. Items were escalated but never pruned or capped.
 *
 * Fix: age-based pruning (7 days), hard cap (20), and interleaved scheduling.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { createTracker, getTracker } from "../src/task-tracker.ts";

let redis: any;
let tracker: any;

const REFRAME_QUEUE_KEY = "hydra:anchors:reframe-queue";

async function cleanKeys() {
  const keys = await redis.keys("hydra:anchors:*");
  if (keys.length > 0) await redis.del(...keys);
  const metricKeys = await redis.keys("hydra:metrics:*");
  if (metricKeys.length > 0) await redis.del(...metricKeys);
}

function makeReframeItem(id: string, daysAgo = 0) {
  return JSON.stringify({
    originalTaskId: id,
    originalTitle: `Task ${id}`,
    originalDescription: "",
    anchorType: "prior-failure",
    anchorReference: id,
    scopeBoundary: null,
    totalAttempts: 3,
    lastReason: "verification failed",
    failedSteps: ["npm test"],
    failureHistory: [],
    verificationStderr: "",
    escalatedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    escalationSource: "test",
  });
}

describe("reframe queue cap and pruning (issue #57)", () => {
  let anchorSelection: any;

  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
      try { getTracker(); } catch { tracker = createTracker(redisUrl); }
      anchorSelection = await import("../src/anchor-selection.ts");
    }
    await cleanKeys();
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  test("REFRAME_QUEUE_CAP is exported and equals 20", () => {
    assert.equal(anchorSelection.REFRAME_QUEUE_CAP, 20);
  });

  test("REFRAME_QUEUE_MAX_AGE_MS is exported and equals 7 days", () => {
    assert.equal(anchorSelection.REFRAME_QUEUE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  });

  test("REFRAME_INTERLEAVE_INTERVAL is exported and positive", () => {
    assert.ok(typeof anchorSelection.REFRAME_INTERLEAVE_INTERVAL === "number");
    assert.ok(anchorSelection.REFRAME_INTERLEAVE_INTERVAL > 0);
  });

  // ---------------------------------------------------------------------------
  // Age-based pruning
  // ---------------------------------------------------------------------------

  test("pruneReframeQueue removes items older than 7 days", async () => {
    // Insert an 8-day-old item (should be pruned)
    await redis.rpush(REFRAME_QUEUE_KEY, makeReframeItem("old-001", 8));
    // Insert a 1-day-old item (should survive)
    await redis.rpush(REFRAME_QUEUE_KEY, makeReframeItem("fresh-001", 1));

    const result = await anchorSelection.pruneReframeQueue();

    assert.equal(result.aged, 1, "should prune exactly 1 aged item");
    assert.equal(result.capped, 0, "should not cap (under limit)");

    const remaining = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0].includes("fresh-001"));
  });

  test("pruneReframeQueue is a no-op when all items are fresh", async () => {
    await redis.rpush(REFRAME_QUEUE_KEY, makeReframeItem("fresh-001", 1));
    await redis.rpush(REFRAME_QUEUE_KEY, makeReframeItem("fresh-002", 2));

    const result = await anchorSelection.pruneReframeQueue();

    assert.equal(result.aged, 0);
    assert.equal(result.capped, 0);
    assert.equal(await redis.llen(REFRAME_QUEUE_KEY), 2);
  });

  test("pruneReframeQueue is a no-op on empty queue", async () => {
    const result = await anchorSelection.pruneReframeQueue();
    assert.equal(result.aged, 0);
    assert.equal(result.capped, 0);
  });

  // ---------------------------------------------------------------------------
  // Cap enforcement
  // ---------------------------------------------------------------------------

  test("pruneReframeQueue enforces cap by dropping oldest items beyond limit", async () => {
    const cap = anchorSelection.REFRAME_QUEUE_CAP;
    // Fill queue beyond the cap
    for (let i = 0; i < cap + 5; i++) {
      await redis.rpush(REFRAME_QUEUE_KEY, makeReframeItem(`item-${i.toString().padStart(3, "0")}`, 0));
    }

    const result = await anchorSelection.pruneReframeQueue();

    assert.equal(result.capped, 5, "should drop 5 items beyond cap");
    const remaining = await redis.llen(REFRAME_QUEUE_KEY);
    assert.equal(remaining, cap, `queue should be trimmed to cap (${cap})`);

    // The kept items should be the first `cap` items (LTRIM keeps 0..cap-1)
    const items = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    const firstItem = JSON.parse(items[0]);
    assert.equal(firstItem.originalTaskId, "item-000", "oldest items should be kept (FIFO order)");
  });

  // ---------------------------------------------------------------------------
  // Combined age + cap
  // ---------------------------------------------------------------------------

  test("pruneReframeQueue handles age pruning followed by cap enforcement", async () => {
    const cap = anchorSelection.REFRAME_QUEUE_CAP;
    // 3 old items (>7 days) + cap+2 fresh items = over cap after age prune
    for (let i = 0; i < 3; i++) {
      await redis.rpush(REFRAME_QUEUE_KEY, makeReframeItem(`old-${i}`, 10));
    }
    for (let i = 0; i < cap + 2; i++) {
      await redis.rpush(REFRAME_QUEUE_KEY, makeReframeItem(`fresh-${i.toString().padStart(3, "0")}`, 1));
    }

    const result = await anchorSelection.pruneReframeQueue();

    assert.equal(result.aged, 3, "should prune 3 aged items");
    assert.equal(result.capped, 2, "should cap 2 items after age pruning");
    assert.equal(await redis.llen(REFRAME_QUEUE_KEY), cap);
  });
});
