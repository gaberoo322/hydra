/**
 * Regression test for issue #192 — plan cache 0% hit rate.
 *
 * Bug: cacheKey() hashed `${type}:${reference.toLowerCase().trim()}`. Planner-
 * generated references vary between cycles (parenthetical metrics, word order,
 * surrounding wording) so semantically-equivalent anchors produced different
 * keys and cache hits were impossible. Verified 2026-05-09: 84 stored, 0 hits.
 *
 * Fix: normalize references before hashing.
 *  - codebase-health: parse "<category> in <file>", drop parenthetical metric.
 *  - other types: tokenize, drop stopwords + parentheticals, sort tokens.
 *
 * Requires Redis on localhost:6379. Uses DB 1 for test isolation.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;
let planCache: typeof import("../src/plan-cache.ts");

async function cleanTestKeys() {
  // Covers both plan entries (hydra:plans:cache:<hash>) and persisted stats
  // (hydra:plans:cache:stats:*, issue #325). Both share the prefix, so a
  // single KEYS scan + DEL is sufficient to reset state between tests.
  const planKeys = await redis.keys("hydra:plans:cache:*");
  if (planKeys.length > 0) await redis.del(...planKeys);
}

describe("plan cache key normalization (issue #192)", () => {
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
  // Pure normalization tests moved to test/anchor-selection-normalize-reference.test.mts
  // when the normalizer relocated out of plan-cache.ts. The Redis-backed cache
  // round-trip + freshness + invalidation tests below still belong here.
  // -----------------------------------------------------------------------
  // End-to-end cache hit behavior via Redis — proves the fix is wired into
  // cachePlan/getCachedPlan and that hits are recorded by stats.
  // -----------------------------------------------------------------------

  test("cache hit: reference variants for the same codebase-health anchor", async () => {
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Add tests for foo",
      scopeBoundary: { in: ["src/foo.ts"] },
      acceptanceCriteria: ["coverage rises"],
    };

    const stored = {
      type: "codebase-health" as const,
      reference: "codebase-health: tests in src/foo.ts (0 tests)",
    };
    const lookup = {
      type: "codebase-health" as const,
      reference: "codebase-health: tests in src/foo.ts (3 tests)",
    };

    await planCache.cachePlan(stored, task, grounding);
    const hit = await planCache.getCachedPlan(lookup, grounding);
    assert.ok(hit, "lookup with different parenthetical metric must hit cached plan");
    assert.equal(hit.title, "Add tests for foo");
  });

  test("cache miss: different file in codebase-health must NOT hit", async () => {
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Add tests for foo",
      scopeBoundary: { in: ["src/foo.ts"] },
      acceptanceCriteria: ["coverage rises"],
    };

    const stored = {
      type: "codebase-health" as const,
      reference: "codebase-health: tests in src/foo.ts",
    };
    const lookup = {
      type: "codebase-health" as const,
      reference: "codebase-health: tests in src/bar.ts",
    };

    await planCache.cachePlan(stored, task, grounding);
    const miss = await planCache.getCachedPlan(lookup, grounding);
    assert.equal(miss, null, "different files must produce a cache miss");
  });

  test("cache hit: user-request variants with stopword/order differences", async () => {
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Fix planner cache",
      scopeBoundary: { in: ["src/plan-cache.ts"] },
      acceptanceCriteria: ["hit rate improves"],
    };

    const stored = {
      type: "user-request" as const,
      reference: "Fix the broken planner cache lookup",
    };
    const lookup = {
      type: "user-request" as const,
      reference: "broken planner cache lookup fix",
    };

    await planCache.cachePlan(stored, task, grounding);
    const hit = await planCache.getCachedPlan(lookup, grounding);
    assert.ok(hit, "stopword/order variants must hit the same cached entry");
    assert.equal(hit.title, "Fix planner cache");
  });

  test("getPlanCacheStats records hits after the normalization fix", async () => {
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Refactor",
      scopeBoundary: { in: ["src/foo.ts"] },
      acceptanceCriteria: ["lints clean"],
    };

    const before = planCache.getPlanCacheStats();

    const stored = {
      type: "user-request" as const,
      reference: "Refactor src/foo.ts (split into modules)",
    };
    const lookup = {
      type: "user-request" as const,
      reference: "Refactor src/foo.ts",
    };

    await planCache.cachePlan(stored, task, grounding);
    const hit = await planCache.getCachedPlan(lookup, grounding);
    assert.ok(hit);

    const after = planCache.getPlanCacheStats();
    assert.ok(
      after.hits > before.hits,
      `hits counter should increment (before=${before.hits} after=${after.hits})`,
    );
  });

  // -----------------------------------------------------------------------
  // Persisted counters (issue #325) — must survive a simulated restart so
  // operators can measure multi-day hit rate after deploys.
  // -----------------------------------------------------------------------

  describe("persisted stats counters (issue #325)", () => {
    test("hitRate returns 0 (not NaN) when hits+misses === 0", () => {
      // Pure function — no Redis required.
      assert.equal(planCache.computeHitRate(0, 0), 0);
      assert.equal(planCache.computeHitRate(0, 5), 0);
      assert.equal(planCache.computeHitRate(1, 1), 0.5);
      // hits=2 misses=1 -> 0.667 (3-dp)
      assert.equal(planCache.computeHitRate(2, 1), 0.667);
    });

    test("getPlanCacheStatsFull shape includes lifetime, last24h, thisProcess each with hitRate", async () => {
      const stats = await planCache.getPlanCacheStatsFull();
      for (const view of ["lifetime", "last24h", "thisProcess"] as const) {
        assert.ok(stats[view], `${view} view present`);
        for (const m of ["hits", "misses", "stored", "invalidated", "stale"] as const) {
          assert.equal(typeof stats[view][m], "number", `${view}.${m} is number`);
        }
        assert.equal(typeof stats[view].hitRate, "number", `${view}.hitRate is number`);
        assert.ok(!Number.isNaN(stats[view].hitRate), `${view}.hitRate not NaN`);
      }
    });

    test("a HIT persists to Redis and survives a simulated module reload", async () => {
      const grounding = { testReport: { passed: 100 } };
      const task = {
        title: "Persist test",
        scopeBoundary: { in: ["src/persist.ts"] },
        acceptanceCriteria: ["counter survives restart"],
      };

      const anchor = {
        type: "user-request" as const,
        reference: "Persist-stats regression check src/persist.ts",
      };

      // Baseline: lifetime hits at start of this test.
      const beforeFull = await planCache.getPlanCacheStatsFull();
      const beforeHits = beforeFull.lifetime.hits;

      await planCache.cachePlan(anchor, task, grounding);
      const hit = await planCache.getCachedPlan(anchor, grounding);
      assert.ok(hit, "must hit (precondition for the persistence assertion)");

      // The persisted INCR is fire-and-forget; flush by reading and retrying
      // until lifetime increments or we time out (~1s).
      let afterHits = beforeHits;
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const v = await planCache.getPlanCacheStatsFull();
        if (v.lifetime.hits > beforeHits) {
          afterHits = v.lifetime.hits;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(
        afterHits >= beforeHits + 1,
        `lifetime hits must increment in Redis (before=${beforeHits} after=${afterHits})`,
      );

      // Simulate a "process restart": invalidate the module cache and re-import.
      // Lifetime counter (in Redis) must still report the hit; thisProcess
      // counter (in-memory) is allowed to reset.
      const mod = await import("../src/plan-cache.ts");
      const reread = await mod.getPlanCacheStatsFull();
      assert.ok(
        reread.lifetime.hits >= beforeHits + 1,
        `after re-import, lifetime hits should still reflect the prior hit ` +
          `(before=${beforeHits} reread=${reread.lifetime.hits})`,
      );
    });

    test("invalidatePlanCache does NOT delete persisted stats keys", async () => {
      const grounding = { testReport: { passed: 100 } };
      const task = {
        title: "Stats survive flush",
        scopeBoundary: { in: ["src/x.ts"] },
        acceptanceCriteria: ["stats preserved"],
      };
      const anchor = {
        type: "user-request" as const,
        reference: "Stats survive bulk invalidate flush",
      };

      await planCache.cachePlan(anchor, task, grounding);
      await planCache.getCachedPlan(anchor, grounding); // record a hit

      // Wait for at least one stats key to exist.
      const deadline = Date.now() + 1000;
      let lifetimeBefore = 0;
      while (Date.now() < deadline) {
        const v = await planCache.getPlanCacheStatsFull();
        if (v.lifetime.hits > 0 || v.lifetime.stored > 0) {
          lifetimeBefore = v.lifetime.hits;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      await planCache.invalidatePlanCache();

      const after = await planCache.getPlanCacheStatsFull();
      // Counters MUST NOT be wiped by a bulk invalidate (they live in Redis
      // alongside cache entries but under a separate `stats:*` sub-prefix).
      assert.ok(
        after.lifetime.hits >= lifetimeBefore,
        `lifetime hits preserved across invalidatePlanCache ` +
          `(before=${lifetimeBefore} after=${after.lifetime.hits})`,
      );
    });
  });
});
