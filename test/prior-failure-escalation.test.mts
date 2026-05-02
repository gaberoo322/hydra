/**
 * Regression tests for prior-failure escalation (issue #18).
 *
 * Bug: hydra:anchors:prior-failures accumulated unbounded (87 items) because
 * higher-priority sources always had items, starving prior-failures. Items
 * stuck at retryCount=1 never reached the escalation threshold.
 *
 * Fix: age-based auto-escalation in selectAnchor() + hard cap in storePriorFailure().
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

const PRIOR_FAILURES_KEY = "hydra:anchors:prior-failures";
const REFRAME_QUEUE_KEY = "hydra:anchors:reframe-queue";

async function cleanKeys() {
  const keys = await redis.keys("hydra:anchors:*");
  if (keys.length > 0) await redis.del(...keys);
  // Also clean task keys used by storePriorFailure
  const taskKeys = await redis.keys("hydra:task:*");
  if (taskKeys.length > 0) await redis.del(...taskKeys);
}

describe("prior-failure escalation (issue #18)", () => {
  let anchorSelection: any;

  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
      // Initialize TaskTracker singleton — required by anchor-selection.ts
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
  // Age-based escalation
  // ---------------------------------------------------------------------------

  test("escalateStalePriorFailures moves items older than age limit to reframe queue", async () => {
    // Insert an item with a timestamp 48 hours ago (exceeds 24h default limit)
    const staleItem = JSON.stringify({
      taskId: "task-stale-001",
      reason: "verification failed",
      failedSteps: ["npm test"],
      retryCount: 1,
      timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    await redis.rpush(PRIOR_FAILURES_KEY, staleItem);

    // Insert a fresh item (should NOT be escalated)
    const freshItem = JSON.stringify({
      taskId: "task-fresh-001",
      reason: "build failed",
      failedSteps: ["tsc"],
      retryCount: 1,
      timestamp: new Date().toISOString(),
    });
    await redis.rpush(PRIOR_FAILURES_KEY, freshItem);

    const escalated = await anchorSelection.escalateStalePriorFailures();

    assert.equal(escalated, 1, "should escalate exactly 1 stale item");

    // Prior-failures queue should only have the fresh item
    const remaining = await redis.lrange(PRIOR_FAILURES_KEY, 0, -1);
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0].includes("task-fresh-001"));

    // Reframe queue should have the escalated item
    const reframed = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    assert.equal(reframed.length, 1);
    const reframedItem = JSON.parse(reframed[0]);
    assert.equal(reframedItem.originalTaskId, "task-stale-001");
    assert.equal(reframedItem.escalationSource, "prior-failure-age-limit");
    assert.ok(reframedItem.escalationReason.includes("aged"));
  });

  test("escalateStalePriorFailures is a no-op when all items are fresh", async () => {
    const freshItem = JSON.stringify({
      taskId: "task-fresh-002",
      reason: "build failed",
      failedSteps: [],
      retryCount: 1,
      timestamp: new Date().toISOString(),
    });
    await redis.rpush(PRIOR_FAILURES_KEY, freshItem);

    const escalated = await anchorSelection.escalateStalePriorFailures();
    assert.equal(escalated, 0);

    const remaining = await redis.lrange(PRIOR_FAILURES_KEY, 0, -1);
    assert.equal(remaining.length, 1);

    const reframed = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    assert.equal(reframed.length, 0);
  });

  test("escalateStalePriorFailures is a no-op on empty queue", async () => {
    const escalated = await anchorSelection.escalateStalePriorFailures();
    assert.equal(escalated, 0);
  });

  // ---------------------------------------------------------------------------
  // Cap-based escalation in storePriorFailure
  // ---------------------------------------------------------------------------

  test("storePriorFailure escalates oldest items when cap is exceeded", async () => {
    // Fill queue to exactly the cap
    const cap = anchorSelection.PRIOR_FAILURE_CAP;
    for (let i = 0; i < cap; i++) {
      await redis.rpush(PRIOR_FAILURES_KEY, JSON.stringify({
        taskId: `task-fill-${i.toString().padStart(3, "0")}`,
        reason: "fill item",
        failedSteps: [],
        retryCount: 1,
        timestamp: new Date(Date.now() - (cap - i) * 1000).toISOString(),
      }));
    }

    // Store one more — should trigger cap overflow, escalating the oldest
    await anchorSelection.storePriorFailure("task-overflow-001", "new failure", null);

    const remaining = await redis.llen(PRIOR_FAILURES_KEY);
    assert.equal(remaining, cap, `queue should be trimmed back to cap (${cap})`);

    // The reframe queue should have the oldest item that was pushed out
    const reframed = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    assert.equal(reframed.length, 1, "exactly 1 item should overflow to reframe");
    const reframedItem = JSON.parse(reframed[0]);
    assert.equal(reframedItem.originalTaskId, "task-fill-000");
    assert.equal(reframedItem.escalationSource, "prior-failure-cap-overflow");
    assert.ok(reframedItem.escalationReason.includes("cap"));
  });

  test("storePriorFailure does not escalate when under the cap", async () => {
    // Store a single item — well under the cap
    await anchorSelection.storePriorFailure("task-under-cap", "some failure", null);

    const remaining = await redis.llen(PRIOR_FAILURES_KEY);
    assert.equal(remaining, 1);

    const reframed = await redis.llen(REFRAME_QUEUE_KEY);
    assert.equal(reframed, 0, "no items should be escalated when under cap");
  });

  // ---------------------------------------------------------------------------
  // Constants are exported and configurable
  // ---------------------------------------------------------------------------

  test("PRIOR_FAILURE_AGE_LIMIT_MS is exported and positive", () => {
    assert.ok(typeof anchorSelection.PRIOR_FAILURE_AGE_LIMIT_MS === "number");
    assert.ok(anchorSelection.PRIOR_FAILURE_AGE_LIMIT_MS > 0);
  });

  test("PRIOR_FAILURE_CAP is exported and positive", () => {
    assert.ok(typeof anchorSelection.PRIOR_FAILURE_CAP === "number");
    assert.ok(anchorSelection.PRIOR_FAILURE_CAP > 0);
  });
});
