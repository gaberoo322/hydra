/**
 * Regression test for issue #375 — plan-cache reflection-bypass is
 * unconditional.
 *
 * Bug: Before this fix, the planner cached a plan once, then every subsequent
 * cycle for the same anchor with any reflection in Redis hit the
 * `reflection-bypass` path in `planner-prompt.ts` and forced a full LLM
 * re-plan. Effective reflections live up to 30 days, so once an anchor had
 * ever failed its cache was effectively disabled forever. Lifetime hit rate
 * stayed at 0% with `stored: 119, misses: 9` — 5/9 misses were
 * `reflection-bypass` bookkeeping. (See `/api/plan-cache/stats` evidence in
 * the issue body.)
 *
 * Fix: cached plans now carry a `reflectionDigest` (sha256 of
 * cycleId+failure-mode pairs). On lookup we recompute the digest from the
 * current per-anchor reflections; identical digest -> hit, different digest
 * -> miss with new reason `reflection-changed`. The unconditional bypass is
 * gone; an anchor that fires twice with the same reflections produces 1
 * store + 1 hit.
 *
 * Tests cover:
 *  (a) same reflections -> cache hit
 *  (b) new reflection arrives -> miss attributed to `reflection-changed`
 *  (c) no reflections present -> normal cache path (hit)
 *  (d) `computeReflectionDigest()` is deterministic + order-insensitive
 *
 * Requires Redis on localhost:6379. Uses DB 1 for test isolation.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;
let planCache: typeof import("../src/plan-cache.ts");

async function cleanTestKeys() {
  // Covers plan entries, persisted stats, miss-reason histogram, and the
  // per-anchor reflection lists we seed below.
  const planKeys = await redis.keys("hydra:plans:cache:*");
  if (planKeys.length > 0) await redis.del(...planKeys);
  const reflectionKeys = await redis.keys("hydra:reflections:*");
  if (reflectionKeys.length > 0) await redis.del(...reflectionKeys);
}

/**
 * Poll briefly for a persisted miss-reason counter to land. Mirrors the
 * fire-and-forget pattern used in plan-cache-miss-reasons.test.mts.
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

describe("plan cache reflection digest (issue #375)", () => {
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
  // Pure digest tests — no Redis. Fastest signal that the helper is correct.
  // -----------------------------------------------------------------------

  describe("computeReflectionDigest()", () => {
    test("empty / null reflections return null sentinel", () => {
      assert.equal(planCache.computeReflectionDigest([]), null);
      assert.equal(planCache.computeReflectionDigest(null), null);
      assert.equal(planCache.computeReflectionDigest(undefined), null);
    });

    test("digest is deterministic for identical input", () => {
      const a = planCache.computeReflectionDigest([
        { cycleId: "c1", reason: "tests failed" },
        { cycleId: "c2", reason: "typecheck failed" },
      ]);
      const b = planCache.computeReflectionDigest([
        { cycleId: "c1", reason: "tests failed" },
        { cycleId: "c2", reason: "typecheck failed" },
      ]);
      assert.equal(a, b);
      assert.ok(a && a.length > 0);
    });

    test("digest is order-insensitive (sort by cycleId before hashing)", () => {
      const a = planCache.computeReflectionDigest([
        { cycleId: "c1", reason: "tests failed" },
        { cycleId: "c2", reason: "typecheck failed" },
      ]);
      const b = planCache.computeReflectionDigest([
        { cycleId: "c2", reason: "typecheck failed" },
        { cycleId: "c1", reason: "tests failed" },
      ]);
      assert.equal(a, b, "reflection order must not change the digest");
    });

    test("new cycleId changes the digest", () => {
      const a = planCache.computeReflectionDigest([
        { cycleId: "c1", reason: "tests failed" },
      ]);
      const b = planCache.computeReflectionDigest([
        { cycleId: "c1", reason: "tests failed" },
        { cycleId: "c2", reason: "tests failed" },
      ]);
      assert.notEqual(a, b, "additional reflection must produce different digest");
    });

    test("different failure mode changes the digest", () => {
      const a = planCache.computeReflectionDigest([
        { cycleId: "c1", reason: "tests failed" },
      ]);
      const b = planCache.computeReflectionDigest([
        { cycleId: "c1", reason: "typecheck failed" },
      ]);
      assert.notEqual(a, b);
    });
  });

  // -----------------------------------------------------------------------
  // Acceptance criterion (a): same reflections -> cache hit on second lookup.
  //
  // This is the load-bearing assertion. Before #375, when reflections existed
  // the cache was unconditionally bypassed -> the second lookup with the same
  // digest would still hit `reflection-bypass`. After #375, the digest match
  // means the cached plan is returned.
  // -----------------------------------------------------------------------
  test("same reflections on second lookup -> cache hit", async () => {
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Fix the foo bug",
      scopeBoundary: { in: ["src/foo.ts"] },
      acceptanceCriteria: ["tests pass"],
    };
    const anchor = {
      type: "user-request" as const,
      reference: "Fix flaky foo behavior",
    };
    const digest = planCache.computeReflectionDigest([
      { cycleId: "c-1", reason: "tests failed" },
    ]);

    // First call: miss (no entry yet), then store with digest.
    const first = await planCache.getCachedPlan(anchor, grounding, digest);
    assert.equal(first, null, "first lookup must miss");
    await planCache.cachePlan(anchor, task, grounding, digest);

    // Second call with identical digest: must hit.
    const second = await planCache.getCachedPlan(anchor, grounding, digest);
    assert.ok(second, "second lookup with same reflection digest must hit");
    assert.equal(second!.title, "Fix the foo bug");
  });

  // -----------------------------------------------------------------------
  // Acceptance criterion (b): a new reflection appears -> miss with
  // `reflection-changed` reason. The stale entry must be evicted so the
  // next planner run with the new context can store a fresh plan.
  // -----------------------------------------------------------------------
  test("new reflection arrives -> miss attributed to reflection-changed", async () => {
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Add migration X",
      scopeBoundary: { in: ["src/migrate.ts"] },
      acceptanceCriteria: ["schema applied"],
    };
    const anchor = {
      type: "research" as const,
      reference: "Roll out migration X across tenants",
    };

    const digestT0 = planCache.computeReflectionDigest([
      { cycleId: "c-1", reason: "tests failed" },
    ]);
    const digestT1 = planCache.computeReflectionDigest([
      { cycleId: "c-1", reason: "tests failed" },
      { cycleId: "c-2", reason: "verification timeout" },
    ]);
    assert.notEqual(digestT0, digestT1, "second reflection must change the digest");

    // Prime the cache with the T0 digest.
    await planCache.getCachedPlan(anchor, grounding, digestT0); // miss
    await planCache.cachePlan(anchor, task, grounding, digestT0);

    // Baseline the reflection-changed counter (other tests may have bumped it).
    const baseline = (await planCache.getPlanCacheStatsFull()).lifetime
      .missReasons["reflection-changed"];

    // Now look up with T1 digest — must miss with `reflection-changed`.
    const lookup = await planCache.getCachedPlan(anchor, grounding, digestT1);
    assert.equal(lookup, null, "lookup with changed digest must miss");

    const after = await waitForMissReasonAtLeast(
      "lifetime",
      "reflection-changed",
      baseline + 1,
    );
    assert.ok(
      after >= baseline + 1,
      `expected reflection-changed >= ${baseline + 1}, got ${after}`,
    );

    // After eviction, a fresh store under the new digest must produce a hit
    // on the next identical-digest lookup. Proves the previous entry was
    // actually removed and not just shadowed.
    await planCache.cachePlan(anchor, task, grounding, digestT1);
    const refreshed = await planCache.getCachedPlan(anchor, grounding, digestT1);
    assert.ok(refreshed, "post-eviction re-store must be retrievable");
  });

  // -----------------------------------------------------------------------
  // Acceptance criterion (c): no reflections -> normal cache path (hit).
  // The null digest matches the null digest stored at plan time; the
  // pre-#375 "no reflections" code path stays intact.
  // -----------------------------------------------------------------------
  test("no reflections present -> normal cache path produces a hit", async () => {
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Refactor bar",
      scopeBoundary: { in: ["src/bar.ts"] },
      acceptanceCriteria: ["coverage holds"],
    };
    const anchor = {
      type: "user-request" as const,
      reference: "Refactor bar module for readability",
    };

    // Digest is null when no reflections exist for the anchor.
    const digest = planCache.computeReflectionDigest([]);
    assert.equal(digest, null);

    const first = await planCache.getCachedPlan(anchor, grounding, digest);
    assert.equal(first, null, "first lookup must miss");
    await planCache.cachePlan(anchor, task, grounding, digest);

    const second = await planCache.getCachedPlan(anchor, grounding, digest);
    assert.ok(second, "second lookup with null digest must hit");
    assert.equal(second!.title, "Refactor bar");
  });

  // -----------------------------------------------------------------------
  // Legacy compatibility: callers that omit the digest argument keep the
  // pre-#375 behaviour (digest comparison skipped). Important so the
  // existing plan-cache.test.mts / plan-cache-miss-reasons.test.mts cases
  // continue to pass and the cache stays usable from tests that don't model
  // reflections.
  // -----------------------------------------------------------------------
  test("omitting the digest argument skips the digest comparison", async () => {
    const grounding = { testReport: { passed: 100 } };
    const task = {
      title: "Document baz",
      scopeBoundary: { in: ["src/baz.ts"] },
      acceptanceCriteria: ["jsdoc added"],
    };
    const anchor = {
      type: "codebase-health" as const,
      reference: "codebase-health: docs in src/baz.ts",
    };

    // Store WITHOUT a digest (legacy call).
    await planCache.getCachedPlan(anchor, grounding); // miss, not-found
    await planCache.cachePlan(anchor, task, grounding);

    // Retrieve WITHOUT a digest — must hit.
    const hit = await planCache.getCachedPlan(anchor, grounding);
    assert.ok(hit, "legacy callers without digest must still get a hit");
  });
});
