/**
 * Regression tests for the anchor-selection module split (issue #288).
 *
 * After splitting src/anchor-selection.ts (1,176 lines, 13-tier monolith)
 * into focused sub-modules under src/anchor-selection/, these tests pin the
 * new public surface area: each sub-module must be independently importable
 * and behave the same as the legacy facade path.
 *
 * Covered sub-modules:
 *   - src/anchor-selection/constants.ts       — keys, thresholds, key helpers
 *   - src/anchor-selection/drift-filter.ts    — pre-planner drift counter
 *   - src/anchor-selection/reframe.ts   — queue length helper
 *   - src/anchor-selection/abandonment.ts     — clearProcessingItem idempotency
 *   - src/anchor-selection/low-confidence.ts  — perm-skip non-applicable types
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

// Single shared connection across all describe blocks. The `after` hook in
// node:test fires per-describe and would disconnect the shared client mid-run
// if each block owned its own cleanup — so we centralise setup/teardown here.
before(async () => {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
  process.env.REDIS_URL = redisUrl;
  redis = new Redis(redisUrl);
});

after(async () => {
  if (redis) {
    await cleanKeys();
    redis.disconnect();
  }
});

describe("anchor-selection/constants — key helpers (issue #288)", () => {
  test("anchorKey produces stable Redis keys", async () => {
    const { anchorKey, ABANDONMENT_COUNTER_PREFIX } = await import(
      "../src/anchor-selection/constants.ts"
    );
    assert.equal(
      anchorKey("Rank Polymarket reward windows"),
      `${ABANDONMENT_COUNTER_PREFIX}Rank-Polymarket-reward-windows`,
    );
  });

  test("anchorKey handles undefined / empty reference", async () => {
    const { anchorKey, ABANDONMENT_COUNTER_PREFIX } = await import(
      "../src/anchor-selection/constants.ts"
    );
    assert.equal(anchorKey(undefined), `${ABANDONMENT_COUNTER_PREFIX}unknown`);
    assert.equal(anchorKey(null), `${ABANDONMENT_COUNTER_PREFIX}unknown`);
    assert.equal(anchorKey(""), `${ABANDONMENT_COUNTER_PREFIX}unknown`);
  });

  test("anchorKey truncates very long references to 120 chars", async () => {
    const { anchorKey, ABANDONMENT_COUNTER_PREFIX } = await import(
      "../src/anchor-selection/constants.ts"
    );
    const longRef = "x".repeat(500);
    const key = anchorKey(longRef);
    // The slug body must not exceed 120 chars (the prefix is added separately).
    assert.equal(key.length, ABANDONMENT_COUNTER_PREFIX.length + 120);
  });

  test("taskKey produces hydra:task:<id> format", async () => {
    const { taskKey } = await import("../src/anchor-selection/constants.ts");
    assert.equal(taskKey("abc123"), "hydra:task:abc123");
  });

  test("re-exporting constants stays in sync with the facade", async () => {
    // The facade _testing surface must expose the same values as the
    // direct sub-module — otherwise tests that import from either path
    // will silently disagree.
    const direct = await import("../src/anchor-selection/constants.ts");
    const facade = await import("../src/anchor-selection.ts");
    assert.equal(direct.MAX_PRIOR_FAILURE_RETRIES, facade._testing.MAX_PRIOR_FAILURE_RETRIES);
    assert.equal(direct.MAX_CONSECUTIVE_ABANDONMENTS, facade._testing.MAX_CONSECUTIVE_ABANDONMENTS);
    assert.equal(direct.REFRAME_QUEUE_CAP, facade._testing.REFRAME_QUEUE_CAP);
    assert.equal(direct.PRIOR_FAILURE_CAP, facade._testing.PRIOR_FAILURE_CAP);
    assert.equal(direct.HEALTH_CONFIDENCE_THRESHOLD, facade._testing.HEALTH_CONFIDENCE_THRESHOLD);
  });
});

describe("anchor-selection/drift-filter — counter consumption (issue #288)", () => {
  test("consumeDriftPreFilteredCount returns then resets to zero", async () => {
    const { consumeDriftPreFilteredCount } = await import(
      "../src/anchor-selection/drift-filter.ts"
    );
    // Two consecutive consumes must return zero — no leaks from prior tests.
    consumeDriftPreFilteredCount();
    assert.equal(consumeDriftPreFilteredCount(), 0);
    assert.equal(consumeDriftPreFilteredCount(), 0);
  });

  test("isAnchorDriftDuplicate is a no-op for failing-test anchors", async () => {
    const { isAnchorDriftDuplicate } = await import(
      "../src/anchor-selection/drift-filter.ts"
    );
    // failing-test / typecheck anchors are exempt — they legitimately repeat.
    const result = await isAnchorDriftDuplicate({
      type: "failing-test",
      reference: "anything",
    });
    assert.equal(result.drift, false);
  });

  test("isAnchorDriftDuplicate is a no-op for missing reference", async () => {
    const { isAnchorDriftDuplicate } = await import(
      "../src/anchor-selection/drift-filter.ts"
    );
    const result = await isAnchorDriftDuplicate({ type: "user-request" });
    assert.equal(result.drift, false);
  });

  test("facade re-export matches direct module (same closure / counter)", async () => {
    // The drift counter is a module-local — the facade must re-export the
    // same closure or a shared module mutation will be lost.
    const direct = await import("../src/anchor-selection/drift-filter.ts");
    const facade = await import("../src/anchor-selection.ts");
    assert.equal(direct.consumeDriftPreFilteredCount, facade.consumeDriftPreFilteredCount);
    assert.equal(direct.isAnchorDriftDuplicate, facade._testing.isAnchorDriftDuplicate);
  });
});

describe("anchor-selection/reframe-queue — length helper (issue #288)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("getReframeQueueLen returns 0 for empty queue", async () => {
    const { getReframeQueueLen } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    const len = await getReframeQueueLen();
    assert.equal(len, 0);
  });

  test("getReframeQueueLen counts items pushed to the queue", async () => {
    const { getReframeQueueLen } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    const { REFRAME_QUEUE } = await import("../src/anchor-selection/constants.ts");
    await redis.rpush(REFRAME_QUEUE, JSON.stringify({ originalTitle: "a", totalAttempts: 1 }));
    await redis.rpush(REFRAME_QUEUE, JSON.stringify({ originalTitle: "b", totalAttempts: 2 }));
    const len = await getReframeQueueLen();
    assert.equal(len, 2);
  });

  test("pruneReframeQueue is a no-op on an empty queue", async () => {
    const { pruneReframeQueue } = await import(
      "../src/anchor-selection/reframe.ts"
    );
    const result = await pruneReframeQueue();
    assert.deepEqual(result, { pruned: 0, dropped: 0 });
  });
});

describe("anchor-selection/abandonment — processing cleanup (issue #288)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("clearProcessingItem is a no-op when the anchor has no _workQueueRaw", async () => {
    const { clearProcessingItem } = await import(
      "../src/anchor-selection/abandonment.ts"
    );
    // Should not throw and not touch Redis.
    await clearProcessingItem({ type: "doc", reference: "x" });
    await clearProcessingItem(null);
    await clearProcessingItem(undefined);
  });

  test("clearProcessingItem removes the marker when present", async () => {
    const { clearProcessingItem } = await import(
      "../src/anchor-selection/abandonment.ts"
    );
    const { PROCESSING_QUEUE } = await import("../src/anchor-selection/constants.ts");
    const raw = JSON.stringify({ id: "work-queue-001" });
    await redis.rpush(PROCESSING_QUEUE, raw);
    assert.equal(await redis.llen(PROCESSING_QUEUE), 1);
    await clearProcessingItem({ type: "user-request", _workQueueRaw: raw });
    assert.equal(await redis.llen(PROCESSING_QUEUE), 0);
  });

  test("clearAbandonmentCounter wipes the per-anchor counter", async () => {
    const { clearAbandonmentCounter } = await import(
      "../src/anchor-selection/abandonment.ts"
    );
    const { anchorKey } = await import("../src/anchor-selection/constants.ts");
    const ref = "doc-anchor-test";
    await redis.set(anchorKey(ref), "2");
    assert.equal(await redis.get(anchorKey(ref)), "2");
    await clearAbandonmentCounter(ref);
    assert.equal(await redis.get(anchorKey(ref)), null);
  });
});

describe("anchor-selection/low-confidence — perm-skip gating (issue #288)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("markLowConfidenceSkip ignores non-codebase-health anchors", async () => {
    const { markLowConfidenceSkip } = await import(
      "../src/anchor-selection/low-confidence.ts"
    );
    // Only codebase-health anchors should bump the perm-skip counter — other
    // types fall through with no Redis write. Verified by checking the key
    // namespace is empty after the call.
    await markLowConfidenceSkip({ type: "doc", reference: "direction/priorities.md" });
    await markLowConfidenceSkip({ type: "research", reference: "anything" });
    const keys = await redis.keys("hydra:anchors:perm-skip:*");
    assert.equal(keys.length, 0);
  });

  test("markLowConfidenceSkip is a no-op for empty reference", async () => {
    const { markLowConfidenceSkip } = await import(
      "../src/anchor-selection/low-confidence.ts"
    );
    await markLowConfidenceSkip({ type: "codebase-health", reference: "" });
    await markLowConfidenceSkip({ type: "codebase-health" });
    const keys = await redis.keys("hydra:anchors:perm-skip:*");
    assert.equal(keys.length, 0);
  });

  test("markLowConfidenceSkip increments counter for codebase-health", async () => {
    const { markLowConfidenceSkip } = await import(
      "../src/anchor-selection/low-confidence.ts"
    );
    const ref = "codebase-health: large-file in src/foo.ts";
    await markLowConfidenceSkip({ type: "codebase-health", reference: ref });
    await markLowConfidenceSkip({ type: "codebase-health", reference: ref });
    const keys = await redis.keys("hydra:anchors:perm-skip:*");
    assert.equal(keys.length, 1);
    const value = await redis.get(keys[0]);
    assert.equal(value, "2");
  });
});
