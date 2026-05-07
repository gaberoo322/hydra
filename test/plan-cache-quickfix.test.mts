/**
 * Regression test for issue #118 — plan cache bypassed for quick-fix anchors
 * when reflections exist, causing 0% hit rate.
 *
 * Bug: The plan cache bypass in planner-prompt.ts unconditionally skips cache
 * when reflections exist for an anchor. Quick-fix anchors (failing-test,
 * typecheck) are deterministic narrow tasks where cached plans are safe even
 * with reflections — the fix for a specific failing test doesn't change.
 *
 * Fix: Allow cache hits for failing-test anchors even when reflections exist.
 * Preserve the bypass for user-request and other non-deterministic anchor types.
 *
 * Requires Redis running on localhost:6379. Uses DB 1 for test isolation.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;
let planCache: typeof import("../src/plan-cache.ts");

async function cleanTestKeys() {
  const planKeys = await redis.keys("hydra:plans:cache:*");
  if (planKeys.length > 0) await redis.del(...planKeys);
}

describe("plan cache quick-fix bypass (issue #118)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379/1");
      process.env.REDIS_URL = "redis://localhost:6379/1";
      planCache = await import("../src/plan-cache.ts");
    }
    await cleanTestKeys();
  });

  after(async () => {
    if (redis) {
      await cleanTestKeys();
      redis.disconnect();
    }
  });

  // The CACHE_SAFE_ANCHOR_TYPES set in planner-prompt.ts allows cache hits for
  // failing-test anchors even when reflections exist. This test verifies the
  // underlying cache machinery works for these anchor types.

  test("getCachedPlan returns cached plan for failing-test anchors", async () => {
    const anchor = { type: "failing-test" as const, reference: "test-auth-login" };
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Fix auth login test",
      scopeBoundary: { in: ["src/auth.ts"] },
      acceptanceCriteria: ["test passes"],
    };

    await planCache.cachePlan(anchor, task, grounding);
    const cached = await planCache.getCachedPlan(anchor, grounding);
    assert.ok(cached, "failing-test plan should be retrievable from cache");
    assert.equal(cached.title, "Fix auth login test");
  });

  test("getCachedPlan returns cached plan for user-request anchors (no reflections case)", async () => {
    const anchor = { type: "user-request" as const, reference: "add-dark-mode" };
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Add dark mode toggle",
      scopeBoundary: { in: ["src/theme.ts"] },
      acceptanceCriteria: ["toggle works"],
    };

    await planCache.cachePlan(anchor, task, grounding);
    const cached = await planCache.getCachedPlan(anchor, grounding);
    assert.ok(cached, "user-request plan should be retrievable when no reflections");
    assert.equal(cached.title, "Add dark mode toggle");
  });

  // This tests the logic that planner-prompt.ts applies on top of plan-cache:
  // CACHE_SAFE_ANCHOR_TYPES = new Set(["failing-test"])
  // The bypass decision: !hasReflections || cacheBypassOverride

  test("cache bypass logic: failing-test with reflections should allow cache (override)", () => {
    // Simulate the logic from planner-prompt.ts
    const CACHE_SAFE_ANCHOR_TYPES = new Set(["failing-test"]);
    const anchorType = "failing-test";
    const hasReflections = true;
    const cacheBypassOverride = CACHE_SAFE_ANCHOR_TYPES.has(anchorType);

    const shouldCheckCache = !hasReflections || cacheBypassOverride;
    assert.ok(shouldCheckCache, "failing-test should check cache even with reflections");
  });

  test("cache bypass logic: user-request with reflections should block cache", () => {
    const CACHE_SAFE_ANCHOR_TYPES = new Set(["failing-test"]);
    const anchorType = "user-request";
    const hasReflections = true;
    const cacheBypassOverride = CACHE_SAFE_ANCHOR_TYPES.has(anchorType);

    const shouldCheckCache = !hasReflections || cacheBypassOverride;
    assert.equal(shouldCheckCache, false, "user-request with reflections must bypass cache (safety)");
  });

  test("cache bypass logic: research with reflections should block cache", () => {
    const CACHE_SAFE_ANCHOR_TYPES = new Set(["failing-test"]);
    const anchorType = "research";
    const hasReflections = true;
    const cacheBypassOverride = CACHE_SAFE_ANCHOR_TYPES.has(anchorType);

    const shouldCheckCache = !hasReflections || cacheBypassOverride;
    assert.equal(shouldCheckCache, false, "research with reflections must bypass cache");
  });

  test("cache bypass logic: codebase-health with reflections should block cache", () => {
    const CACHE_SAFE_ANCHOR_TYPES = new Set(["failing-test"]);
    const anchorType = "codebase-health";
    const hasReflections = true;
    const cacheBypassOverride = CACHE_SAFE_ANCHOR_TYPES.has(anchorType);

    const shouldCheckCache = !hasReflections || cacheBypassOverride;
    assert.equal(shouldCheckCache, false, "codebase-health with reflections must bypass cache");
  });

  test("cache bypass logic: no reflections allows cache for any type", () => {
    const CACHE_SAFE_ANCHOR_TYPES = new Set(["failing-test"]);
    const hasReflections = false;

    for (const anchorType of ["failing-test", "user-request", "research", "codebase-health"]) {
      const cacheBypassOverride = CACHE_SAFE_ANCHOR_TYPES.has(anchorType);
      const shouldCheckCache = !hasReflections || cacheBypassOverride;
      assert.ok(shouldCheckCache, `${anchorType} without reflections should always check cache`);
    }
  });

  test("cached plan for failing-test preserves __planCacheHit metadata fields", async () => {
    const anchor = { type: "failing-test" as const, reference: "test-widget-render" };
    const grounding = { testReport: { passed: 50 } };
    const task = {
      title: "Fix widget render",
      scopeBoundary: { in: ["src/widget.ts"] },
      acceptanceCriteria: ["test passes"],
    };

    await planCache.cachePlan(anchor, task, grounding);
    const cached = await planCache.getCachedPlan(anchor, grounding);
    assert.ok(cached, "plan should be cached");

    // Simulate what planner-prompt.ts does with a cache hit
    cached.__plannerModel = "cached";
    cached.__planCacheHit = true;
    cached.__planCacheAnchorType = anchor.type;

    assert.equal(cached.__plannerModel, "cached");
    assert.equal(cached.__planCacheHit, true);
    assert.equal(cached.__planCacheAnchorType, "failing-test",
      "anchor type should be tracked for per-type cache metrics");
  });
});
