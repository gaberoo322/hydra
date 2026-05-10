/**
 * Regression tests for episodic reflection injection on retries (issue #193).
 *
 * The bug: prior-failure anchors are quick-fix anchors, and buildPlannerContext
 * deliberately returned an empty plannerMemory for quick-fix anchors. As a
 * result, retries had a 0% merge rate (0/8 across 50 cycles, measured 2026-05-09)
 * because the planner never saw the failure context and re-proposed the same
 * plan that already failed.
 *
 * The fix: load reflections (planner-context) for quick-fix anchors too, and
 * inject them into the quick-fix prompt with explicit "do something different"
 * guidance.
 *
 * Requires Redis running on localhost:6379 (uses DB 1).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

let redis: any;
let redisAvailable = false;

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

async function cleanReflections() {
  const keys = await redis.keys("hydra:reflections:*");
  if (keys.length > 0) await redis.del(...keys);
  const outcomes = "hydra:learning:reflection:outcomes";
  await redis.del(outcomes);
}

function makeGrounding(overrides: Record<string, any> = {}) {
  return {
    timestamp: Date.now(),
    branch: "main",
    headCommit: "abc1234",
    fileCount: 42,
    failingTests: [],
    testReport: { passed: 10, failed: 0, total: 10, ran: true, stdout: "", stderr: "", durationMs: 50 },
    typecheckReport: { exitCode: 0, output: "", ran: false },
    dirtyFiles: [],
    recentCommits: ["abc1234 test commit"],
    fileTree: "src/index.ts",
    groundingDurationMs: 100,
    ...overrides,
  };
}

describe("reflection injection on retry (issue #193)", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL!);
      try {
        await redis.ping();
        redisAvailable = true;
      } catch (err) {
        console.error("Redis unavailable, skipping reflection-injection tests");
        return;
      }
    }
    if (!redisAvailable) return;
    await cleanReflections();
  });

  after(async () => {
    if (redis) {
      if (redisAvailable) await cleanReflections();
      redis.disconnect();
    }
    const { closeRedisConnections } = await import("../src/redis-adapter.ts");
    closeRedisConnections();
  });

  test("buildPlannerContext loads reflections for prior-failure anchor", async (t) => {
    requireRedis(t);
    const cb = await import("../src/context-builder.ts");

    const anchorRef = "task-flake-fix-001";

    // Seed a per-anchor reflection directly in Redis (matches the format
    // produced by recordAnchorReflection in learning.ts).
    const reflectionKey = "hydra:reflections:" + anchorRef.replace(/\s+/g, "-").toLowerCase().slice(0, 120);
    const reflection = {
      cycleId: "cycle-prior-001",
      anchorRef,
      taskTitle: "Update auth token validation",
      outcome: "verification-failed",
      reason: "Test fixture used hardcoded token",
      whatWasAttempted: "Update auth token validation",
      whyItFailed: "Test fixture used hardcoded token; refactor missed it",
      whatShouldChange: "Update the fixture in test/fixtures/auth.json before changing validator",
      timestamp: new Date().toISOString(),
    };
    await redis.rpush(reflectionKey, JSON.stringify(reflection));
    await redis.expire(reflectionKey, 7 * 24 * 60 * 60);

    const anchor = { type: "prior-failure", reference: anchorRef, whyNow: "retry" };
    const ctx = await cb.buildPlannerContext(anchor, makeGrounding(), null);

    // The reflection MUST appear in plannerMemory — this is the core fix.
    assert.ok(
      ctx.plannerMemory.includes("PRIOR ATTEMPTS"),
      `plannerMemory should include "PRIOR ATTEMPTS" header for prior-failure anchor. Got: ${ctx.plannerMemory.slice(0, 300)}`,
    );
    assert.ok(
      ctx.plannerMemory.includes("Update the fixture in test/fixtures/auth.json"),
      `plannerMemory should include the specific advice from the reflection. Got: ${ctx.plannerMemory.slice(0, 300)}`,
    );
  });

  test("buildPlannerContext: prior-failure anchor with no reflection has no PRIOR ATTEMPTS section", async (t) => {
    requireRedis(t);
    const cb = await import("../src/context-builder.ts");

    const anchor = { type: "prior-failure", reference: "never-failed-before-xyz", whyNow: "retry" };
    const ctx = await cb.buildPlannerContext(anchor, makeGrounding(), null);

    // Note: plannerMemory may still include generic "PAST OUTCOMES" agent
    // memory patterns — that's fine. The contract for this test is that
    // there's no per-anchor PRIOR ATTEMPTS section when no reflection exists
    // for THIS specific anchor.
    assert.equal(typeof ctx.plannerMemory, "string");
    assert.ok(
      !ctx.plannerMemory.includes("PRIOR ATTEMPTS"),
      "no per-anchor reflection seeded → no PRIOR ATTEMPTS section",
    );
  });

  test("countReflections counts PRIOR ATTEMPTS and Recent Failures", async () => {
    const cb = await import("../src/context-builder.ts");

    assert.equal(cb.countReflections(""), 0, "empty input → 0");
    assert.equal(cb.countReflections("no reflection markers here"), 0, "no markers → 0");

    const priorOnly = "## PRIOR ATTEMPTS (3 previous failures for this anchor)\n\nstuff";
    assert.equal(cb.countReflections(priorOnly), 3, "PRIOR ATTEMPTS extracts the count");

    const recentOnly = [
      "## Recent Failures",
      "",
      "### cycle-1 (mode-a)",
      "stuff",
      "### cycle-2 (mode-b)",
      "more",
    ].join("\n");
    assert.equal(cb.countReflections(recentOnly), 2, "Recent Failures counts ### entries");

    const both = priorOnly + "\n\n" + recentOnly;
    assert.equal(cb.countReflections(both), 5, "both sections sum");
  });

  test("getReflectionEffectiveness returns injection stats (issue #193)", async (t) => {
    requireRedis(t);
    const learning = await import("../src/learning.ts");

    const result = await learning.getReflectionEffectiveness();

    // Shape contract
    assert.ok(Array.isArray(result.anchors), "anchors must be an array");
    assert.ok(typeof result.injection === "object", "injection summary must be present");
    assert.equal(typeof result.injection.totalCycles, "number");
    assert.equal(typeof result.injection.cyclesWithReflections, "number");
    assert.equal(typeof result.injection.injectionRate, "number");
    assert.ok(result.injection.injectionRate >= 0 && result.injection.injectionRate <= 1,
      "injection rate must be a fraction");
  });
});

describe("planner result tags reflection telemetry (issue #193)", () => {
  test("countReflections feeds task.__reflectionsInjected metric path", async () => {
    // This is a unit-level check that the helper used by planner-prompt.ts
    // produces the value that becomes task.__reflectionsInjected.
    const cb = await import("../src/context-builder.ts");

    // Simulate what loadAnchorReflections produces (one reflection)
    const formatted = [
      "## PRIOR ATTEMPTS (1 previous failures for this anchor)",
      "",
      "### Attempt: cycle-001",
      "- **Task**: foo",
      "- **Outcome**: failed",
    ].join("\n");

    const count = cb.countReflections(formatted);
    assert.equal(count, 1, "one PRIOR ATTEMPTS reflection → count is 1");

    // This is what task.__reflectionsInjected will be set to
    const hadReflections = count > 0;
    assert.equal(hadReflections, true, "boolean derivation works for metric");
  });
});
