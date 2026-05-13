/**
 * Regression tests for issue #363 — plan-cache miss reasons + broadened
 * cacheable scope.
 *
 * Bug: lifetime hit rate stuck at 0% (4 misses, 110 stored, 1 stale) across
 * persisted history. Operators had no signal for WHY hits weren't happening.
 *
 * Fix: every cache miss is attributed to a reason label and persisted as a
 * histogram in Redis under `hydra:plans:cache:miss-reasons`. Bookkeeping
 * misses (reflection-bypass, non-cacheable-type, actionability-skipped) are
 * also recorded so the histogram explains the gap between stored and hits.
 *
 * The "same anchor planned twice -> cache hit" assertion proves the cache
 * mechanism itself works (rules out a regression in normalization or key
 * computation).
 *
 * Requires Redis on localhost:6379. Uses DB 1 for test isolation.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;
let planCache: typeof import("../src/plan-cache.ts");

async function cleanTestKeys() {
  // Covers plan entries, stats counters, AND the miss-reason histogram.
  const planKeys = await redis.keys("hydra:plans:cache:*");
  if (planKeys.length > 0) await redis.del(...planKeys);
}

/**
 * The persisted miss-reason increment is fire-and-forget. Poll briefly for it
 * to land instead of sleeping a fixed duration — tests stay fast on quiet
 * boxes and reliable on slow ones.
 */
async function waitForMissReasonAtLeast(
  view: "lifetime" | "last24h" | "thisProcess",
  reason: import("../src/redis/plan-cache.ts").PlanCacheMissReason,
  threshold: number,
  timeoutMs: number = 1500,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const stats = await planCache.getPlanCacheStatsFull();
    last = stats[view].missReasons[reason];
    if (last >= threshold) return last;
    await new Promise((r) => setTimeout(r, 20));
  }
  return last;
}

describe("plan cache miss-reason histogram (issue #363)", () => {
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

  // -----------------------------------------------------------------------
  // Acceptance criterion: "same anchor planned twice -> second hits cache".
  // Proves the cache wiring works at all, independent of the actionability
  // gate or reflection bypass that block reads in production.
  // -----------------------------------------------------------------------
  test("same anchor planned twice: second invocation returns a cache hit", async () => {
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Add tests for foo",
      scopeBoundary: { in: ["src/foo.ts"] },
      acceptanceCriteria: ["coverage rises"],
    };
    const anchor = {
      type: "user-request" as const,
      reference: "Add tests for src/foo.ts coverage gap",
    };

    // First call: miss (no entry yet), then store.
    const firstLookup = await planCache.getCachedPlan(anchor, grounding);
    assert.equal(firstLookup, null, "first lookup must miss");
    await planCache.cachePlan(anchor, task, grounding);

    // Second call: must hit.
    const secondLookup = await planCache.getCachedPlan(anchor, grounding);
    assert.ok(secondLookup, "second lookup must hit cached plan");
    assert.equal(secondLookup!.title, "Add tests for foo");
  });

  // -----------------------------------------------------------------------
  // Acceptance criteria: missReasons histogram surfaces in getPlanCacheStatsFull
  // and individual reason buckets increment on the appropriate code paths.
  // -----------------------------------------------------------------------

  test("getPlanCacheStatsFull exposes missReasons for lifetime + last24h + thisProcess", async () => {
    const stats = await planCache.getPlanCacheStatsFull();
    for (const view of ["lifetime", "last24h", "thisProcess"] as const) {
      assert.ok(stats[view].missReasons, `${view}.missReasons present`);
      for (const reason of [
        "not-found",
        "non-cacheable-type",
        "reflection-bypass",
        "actionability-skipped",
        "stale-tests",
        "stale-files",
        "get-error",
      ] as const) {
        assert.equal(
          typeof stats[view].missReasons[reason],
          "number",
          `${view}.missReasons.${reason} is number`,
        );
        assert.ok(
          stats[view].missReasons[reason] >= 0,
          `${view}.missReasons.${reason} is non-negative`,
        );
      }
    }
  });

  test("miss on empty key records 'not-found' reason", async () => {
    const before = await planCache.getPlanCacheStatsFull();
    const beforeCount = before.lifetime.missReasons["not-found"];

    const anchor = {
      type: "user-request" as const,
      reference: "Brand new anchor for miss-reason test",
    };
    const lookup = await planCache.getCachedPlan(anchor, { testReport: { passed: 100 } });
    assert.equal(lookup, null);

    const after = await waitForMissReasonAtLeast("lifetime", "not-found", beforeCount + 1);
    assert.ok(
      after >= beforeCount + 1,
      `lifetime.missReasons['not-found'] must increment (before=${beforeCount} after=${after})`,
    );
  });

  test("non-cacheable anchor type records 'non-cacheable-type' reason", async () => {
    const before = await planCache.getPlanCacheStatsFull();
    const beforeCount = before.lifetime.missReasons["non-cacheable-type"];

    // Anchor type NOT in CACHEABLE_TYPES (e.g. reframe/prior-failure).
    const anchor = {
      type: "reframe" as const,
      reference: "Reframe anchor — must not be cached",
    };
    const lookup = await planCache.getCachedPlan(anchor, { testReport: { passed: 100 } });
    assert.equal(lookup, null);

    const after = await waitForMissReasonAtLeast(
      "lifetime",
      "non-cacheable-type",
      beforeCount + 1,
    );
    assert.ok(
      after >= beforeCount + 1,
      `non-cacheable-type miss must increment (before=${beforeCount} after=${after})`,
    );
  });

  test("recordPlanCacheMiss('reflection-bypass') increments the histogram", async () => {
    const before = await planCache.getPlanCacheStatsFull();
    const beforeCount = before.lifetime.missReasons["reflection-bypass"];

    planCache.recordPlanCacheMiss("reflection-bypass");

    const after = await waitForMissReasonAtLeast(
      "lifetime",
      "reflection-bypass",
      beforeCount + 1,
    );
    assert.ok(
      after >= beforeCount + 1,
      `reflection-bypass miss must increment (before=${beforeCount} after=${after})`,
    );
  });

  test("recordPlanCacheMiss('actionability-skipped') increments the histogram", async () => {
    const before = await planCache.getPlanCacheStatsFull();
    const beforeCount = before.lifetime.missReasons["actionability-skipped"];

    planCache.recordPlanCacheMiss("actionability-skipped");

    const after = await waitForMissReasonAtLeast(
      "lifetime",
      "actionability-skipped",
      beforeCount + 1,
    );
    assert.ok(
      after >= beforeCount + 1,
      `actionability-skipped miss must increment (before=${beforeCount} after=${after})`,
    );
  });

  test("stale test-count eviction records 'stale-tests' reason", async () => {
    // Cache a plan with a high test count, then look it up with a lower one
    // -> isStale evicts and records stale-tests.
    const anchor = {
      type: "user-request" as const,
      reference: "Stale-tests reason regression check",
    };
    const task = {
      title: "Stale test",
      scopeBoundary: { in: [] }, // empty -> areScopeFilesUnmodified short-circuits true
      acceptanceCriteria: ["x"],
    };

    await planCache.cachePlan(anchor, task, { testReport: { passed: 100 } });

    const before = await planCache.getPlanCacheStatsFull();
    const beforeCount = before.lifetime.missReasons["stale-tests"];

    // Test count dropped -> stale-tests path.
    const lookup = await planCache.getCachedPlan(anchor, { testReport: { passed: 99 } });
    assert.equal(lookup, null, "lower test count must produce a stale miss");

    const after = await waitForMissReasonAtLeast(
      "lifetime",
      "stale-tests",
      beforeCount + 1,
    );
    assert.ok(
      after >= beforeCount + 1,
      `stale-tests miss must increment (before=${beforeCount} after=${after})`,
    );
  });

  test("thisProcess view tracks miss reasons in-memory (no Redis round-trip needed)", async () => {
    // Generate a deterministic miss.
    const anchor = {
      type: "reframe" as const,
      reference: "In-memory thisProcess miss-reason check",
    };
    await planCache.getCachedPlan(anchor, { testReport: { passed: 1 } });

    const stats = await planCache.getPlanCacheStatsFull();
    assert.ok(
      stats.thisProcess.missReasons["non-cacheable-type"] >= 1,
      "thisProcess view must reflect the in-memory miss reason",
    );
  });
});
