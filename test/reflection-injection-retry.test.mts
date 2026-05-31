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
import type { LearningContext, LearningContextBlock } from "../src/learning.ts";

process.env.REDIS_URL = "redis://localhost:6379/1";

/** Build a minimal LearningContext from a list of blocks (issue #804). */
function ctxOf(blocks: Partial<LearningContextBlock>[]): LearningContext {
  const full = blocks.map((b) => ({
    source: b.source!,
    status: b.status ?? "hit",
    content: b.content ?? "",
    itemCount: b.itemCount ?? 0,
    error: b.error,
  })) as LearningContextBlock[];
  return {
    blocks: full,
    toPrompt: () => full.filter((b) => b.status === "hit" && b.content.length > 0).map((b) => b.content).join("\n\n"),
  };
}

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
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
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

  test("reflectionTelemetry sums per-anchor and global block itemCounts (issue #804)", async () => {
    const { reflectionTelemetry } = await import("../src/learning.ts");

    assert.deepEqual(reflectionTelemetry(ctxOf([])), { count: 0, sources: [] }, "no blocks → 0");

    const priorOnly = reflectionTelemetry(ctxOf([
      { source: "per-anchor-reflections", status: "hit", content: "## PRIOR ATTEMPTS (3…)", itemCount: 3 },
    ]));
    assert.equal(priorOnly.count, 3, "per-anchor itemCount is the count — no header regex");

    const recentOnly = reflectionTelemetry(ctxOf([
      { source: "global-reflections", status: "hit", content: "## Recent Failures …", itemCount: 2 },
    ]));
    assert.equal(recentOnly.count, 2, "global itemCount is the count");

    const both = reflectionTelemetry(ctxOf([
      { source: "per-anchor-reflections", status: "hit", content: "prior", itemCount: 3 },
      { source: "global-reflections", status: "hit", content: "recent", itemCount: 2 },
    ]));
    assert.equal(both.count, 5, "both blocks sum");
    assert.deepEqual(both.sources, ["per-anchor", "global"]);
  });

  test("getReflectionEffectiveness returns injection stats (issue #193)", async (t) => {
    requireRedis(t);
    const learning = await import("../src/reflections/reflections.ts");

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
  test("reflectionTelemetry feeds task.__reflectionsInjected metric path", async () => {
    // Unit-level check that the helper used by context-builder produces the
    // value that becomes task.__reflectionsInjected — now off structured
    // blocks (issue #804), not a markdown re-parse.
    const { reflectionTelemetry } = await import("../src/learning.ts");

    // Simulate what loadAnchorReflections reports (one reflection, count=1).
    const { count } = reflectionTelemetry(ctxOf([
      { source: "per-anchor-reflections", status: "hit", content: "## PRIOR ATTEMPTS (1…)", itemCount: 1 },
    ]));
    assert.equal(count, 1, "one per-anchor reflection → count is 1");

    // This is what task.__reflectionsInjected will be set to
    const hadReflections = count > 0;
    assert.equal(hadReflections, true, "boolean derivation works for metric");
  });
});
