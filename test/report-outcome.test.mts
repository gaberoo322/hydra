/**
 * Regression tests for reportOutcome() (issue #69).
 *
 * reportOutcome is the unified post-cycle anchor bookkeeping function that
 * dispatches to trackAbandonment, storePriorFailure, clearAbandonmentCounter,
 * and clearProcessingItem based on the outcome status.
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
const PROCESSING_KEY = "hydra:anchors:processing";
const ABANDONMENT_PREFIX = "hydra:anchors:abandonment-count:";

async function cleanKeys() {
  const keys = await redis.keys("hydra:anchors:*");
  if (keys.length > 0) await redis.del(...keys);
  const taskKeys = await redis.keys("hydra:task:*");
  if (taskKeys.length > 0) await redis.del(...taskKeys);
  const planKeys = await redis.keys("hydra:plan-cache:*");
  if (planKeys.length > 0) await redis.del(...planKeys);
}

describe("reportOutcome (issue #69)", () => {
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

  test("merged status clears abandonment counter and processing item", async () => {
    const anchor = { reference: "test-merge-anchor", _workQueueRaw: '{"ref":"test"}' };

    // Set up abandonment counter and processing item
    await redis.set(`${ABANDONMENT_PREFIX}test-merge-anchor`, "2");
    await redis.rpush(PROCESSING_KEY, anchor._workQueueRaw);

    await anchorSelection.reportOutcome(anchor, { status: "merged" });

    // Abandonment counter should be cleared
    const counter = await redis.get(`${ABANDONMENT_PREFIX}test-merge-anchor`);
    assert.equal(counter, null, "abandonment counter should be cleared after merge");

    // Processing item should be removed
    const processing = await redis.lrange(PROCESSING_KEY, 0, -1);
    assert.equal(processing.length, 0, "processing queue should be empty after merge");
  });

  test("failed status stores prior failure and clears processing item", async () => {
    const anchor = { reference: "test-fail-anchor", _workQueueRaw: '{"ref":"fail"}' };
    await redis.rpush(PROCESSING_KEY, anchor._workQueueRaw);

    await anchorSelection.reportOutcome(anchor, {
      status: "failed",
      reason: "Verification failed: tests",
      taskId: "task-001",
    });

    // Prior failure should be stored
    const failures = await redis.lrange(PRIOR_FAILURES_KEY, 0, -1);
    assert.ok(failures.length > 0, "prior failure should be stored");
    const failure = JSON.parse(failures[0]);
    assert.equal(failure.taskId, "task-001");
    assert.equal(failure.reason, "Verification failed: tests");

    // Processing item should be removed
    const processing = await redis.lrange(PROCESSING_KEY, 0, -1);
    assert.equal(processing.length, 0, "processing queue should be empty after failure");
  });

  test("abandoned status tracks abandonment and clears processing item", async () => {
    const anchor = { reference: "test-abandon-anchor", _workQueueRaw: '{"ref":"abandon"}' };
    await redis.rpush(PROCESSING_KEY, anchor._workQueueRaw);

    const { escalated } = await anchorSelection.reportOutcome(anchor, {
      status: "abandoned",
      reason: "Drift detected",
      task: { title: "test task", taskId: "task-002" },
    });

    assert.equal(escalated, false, "should not escalate on first abandonment");

    // Abandonment counter should be incremented
    const counter = await redis.get(`${ABANDONMENT_PREFIX}test-abandon-anchor`);
    assert.equal(counter, "1", "abandonment counter should be 1");

    // Processing item should be removed
    const processing = await redis.lrange(PROCESSING_KEY, 0, -1);
    assert.equal(processing.length, 0, "processing queue should be empty after abandonment");
  });

  test("circuit breaker escalates after 3 consecutive abandonments", async () => {
    const anchor = { reference: "test-breaker-anchor" };
    const task = { title: "breaker task", taskId: "task-003" };

    // First two abandonments — no escalation
    for (let i = 0; i < 2; i++) {
      const { escalated } = await anchorSelection.reportOutcome(anchor, {
        status: "abandoned",
        reason: `attempt ${i + 1}`,
        task,
      });
      assert.equal(escalated, false, `should not escalate on attempt ${i + 1}`);
    }

    // Third abandonment — should escalate
    const { escalated } = await anchorSelection.reportOutcome(anchor, {
      status: "abandoned",
      reason: "attempt 3",
      task,
    });
    assert.equal(escalated, true, "should escalate after 3 abandonments");

    // Reframe queue should have the escalated item
    const reframe = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    assert.equal(reframe.length, 1, "reframe queue should have 1 item");
    const item = JSON.parse(reframe[0]);
    assert.equal(item.originalTitle, "breaker task");
    assert.equal(item.escalationSource, "abandonment-circuit-breaker");
  });
});
