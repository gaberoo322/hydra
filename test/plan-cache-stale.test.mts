/**
 * Regression test for issue #22 — stale plan cache served to prior-failure retries.
 *
 * Bug: When a task fails and goes to prior-failures, the cached plan (12h TTL)
 * would be served on retry, bypassing reflections and dooming retries to repeat
 * the same failure.
 *
 * Fix: storePriorFailure() invalidates the plan cache entry. Additionally,
 * getCachedPlan() is bypassed when reflections exist for the anchor.
 *
 * Requires Redis running on localhost:6379. Uses DB 1 for test isolation.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;
let planCache: typeof import("../src/plan-cache.ts");
let anchorSelection: typeof import("../src/anchor-selection.ts");

async function cleanTestKeys() {
  const planKeys = await redis.keys("hydra:plans:cache:*");
  const failureKeys = await redis.keys("hydra:anchors:prior-failures");
  const reframeKeys = await redis.keys("hydra:anchors:reframe-queue");
  const reflKeys = await redis.keys("hydra:reflections:*");
  const allKeys = [...planKeys, ...failureKeys, ...reframeKeys, ...reflKeys];
  if (allKeys.length > 0) await redis.del(...allKeys);
}

describe("plan cache invalidation on failure (issue #22)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379/1");
      process.env.REDIS_URL = "redis://localhost:6379/1";
      planCache = await import("../src/plan-cache.ts");
      anchorSelection = await import("../src/anchor-selection.ts");
    }
    await cleanTestKeys();
  });

  after(async () => {
    if (redis) {
      await cleanTestKeys();
      redis.disconnect();
    }
  });

  test("storePriorFailure invalidates cached plan for the same anchor", async () => {
    const anchor = { type: "failing-test" as const, reference: "test-widget-render" };
    const grounding = { testReport: { passed: 50 } };
    const task = {
      title: "Fix widget render test",
      taskId: "task-001",
      scopeBoundary: { in: ["src/widget.ts"] },
      acceptanceCriteria: ["test passes"],
    };

    // Cache a plan
    await planCache.cachePlan(anchor, task, grounding);

    // Verify plan is cached
    const cached = await planCache.getCachedPlan(anchor, grounding);
    assert.ok(cached, "plan should be cached before failure");
    assert.equal(cached.title, "Fix widget render test");

    // Store a prior failure for the same task reference
    await anchorSelection.storePriorFailure("test-widget-render", "No code changes produced", null);

    // Plan cache should now be invalidated
    const afterFailure = await planCache.getCachedPlan(anchor, grounding);
    assert.equal(afterFailure, null, "cached plan must be invalidated after storePriorFailure");
  });

  test("invalidatePlanCacheForAnchor removes only the targeted entry", async () => {
    const anchor1 = { type: "failing-test" as const, reference: "test-alpha" };
    const anchor2 = { type: "failing-test" as const, reference: "test-beta" };
    const grounding = { testReport: { passed: 50 } };
    const task1 = { title: "Fix alpha", scopeBoundary: { in: [] }, acceptanceCriteria: ["passes"] };
    const task2 = { title: "Fix beta", scopeBoundary: { in: [] }, acceptanceCriteria: ["passes"] };

    await planCache.cachePlan(anchor1, task1, grounding);
    await planCache.cachePlan(anchor2, task2, grounding);

    // Invalidate only anchor1
    const result = await planCache.invalidatePlanCacheForAnchor(anchor1);
    assert.ok(result, "should return true when entry existed");

    // anchor1 gone, anchor2 still present
    assert.equal(await planCache.getCachedPlan(anchor1, grounding), null);
    const beta = await planCache.getCachedPlan(anchor2, grounding);
    assert.ok(beta, "anchor2 should still be cached");
    assert.equal(beta.title, "Fix beta");
  });

  test("invalidatePlanCacheForAnchor returns false when no entry exists", async () => {
    const result = await planCache.invalidatePlanCacheForAnchor({ type: "failing-test", reference: "nonexistent" });
    assert.equal(result, false);
  });
});
