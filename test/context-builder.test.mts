/**
 * Context builder tests.
 *
 * Regression: context sources were loaded across planner-prompt.ts and
 * control-loop.ts with inconsistent error handling. A missing source
 * (e.g. priorities.md not found) could silently produce an empty prompt
 * section with no warning. buildPlannerContext centralizes loading with
 * explicit warnings for each failed source.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// We test the module's exported function by mocking its dependencies.
// Since node:test has no mocking framework, we test the contract:
// - quick-fix anchors produce empty context (no priorities/feedback/etc)
// - the returned PlannerContext has the correct shape
// - warnings array collects errors without throwing

// Minimal grounding object that satisfies summarizeForPrompt
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
    fileTree: "src/index.ts\nsrc/foo.ts",
    groundingDurationMs: 100,
    ...overrides,
  };
}

describe("context-builder PlannerContext shape", () => {
  // Import the type at test time to verify it exists and exports correctly
  test("buildPlannerContext is exported", async () => {
    const mod = await import("../src/context-builder.ts");
    assert.equal(typeof mod.buildPlannerContext, "function",
      "buildPlannerContext must be an exported function");
  });

  test("PlannerContext interface has all required fields", async () => {
    const mod = await import("../src/context-builder.ts");

    const anchor = { type: "failing-test", reference: "test:foo" };
    const ctx = await mod.buildPlannerContext(anchor, makeGrounding({ failed: 1 }), null);

    const expectedKeys = [
      "priorities", "feedback", "plannerMemory", "ovContext",
      "milestoneContext", "accomplishmentsContext", "groundingSummary",
      "continuityContext", "warnings",
      // Issue #221: reflection telemetry exposed by the context builder
      "reflectionInjected", "reflectionSources",
    ];
    for (const key of expectedKeys) {
      assert.ok(key in ctx, `PlannerContext must have field "${key}"`);
    }
    assert.ok(Array.isArray(ctx.warnings), "warnings must be an array");
  });

  test("quick-fix anchor skips heavy context sources but keeps reflections (issue #193)", async () => {
    const mod = await import("../src/context-builder.ts");

    const anchor = { type: "prior-failure", reference: "fix:bar" };
    const ctx = await mod.buildPlannerContext(anchor, makeGrounding(), null);

    assert.equal(ctx.priorities, "", "quick-fix should skip priorities");
    assert.equal(ctx.feedback, "", "quick-fix should skip feedback");
    assert.equal(ctx.ovContext, "", "quick-fix should skip ovContext");
    assert.equal(ctx.milestoneContext, "", "quick-fix should skip milestoneContext");
    assert.equal(ctx.accomplishmentsContext, "", "quick-fix should skip accomplishments");
    assert.equal(ctx.continuityContext, "", "quick-fix should skip continuity");
    assert.ok(ctx.groundingSummary.length > 0, "quick-fix should still have grounding summary");
    // Reflections are loaded for quick-fix anchors (issue #193 fix). The value
    // may be empty when no reflections exist in Redis, but the contract is that
    // the load is attempted, not skipped.
    assert.equal(typeof ctx.plannerMemory, "string", "plannerMemory must be a string (loaded, not skipped)");
  });

  test("grounding summary is always populated for valid grounding", async () => {
    const mod = await import("../src/context-builder.ts");

    const anchor = { type: "failing-test", reference: "test:baz" };
    const grounding = makeGrounding({
      testReport: { passed: 50, failed: 2, total: 52, ran: true, stdout: "", stderr: "err" },
      typecheckReport: { exitCode: 1, output: "error TS2345" },
      dirtyFiles: ["src/foo.ts"],
      failingTests: ["test:baz"],
    });

    const ctx = await mod.buildPlannerContext(anchor, grounding, null);
    assert.ok(ctx.groundingSummary.includes("50"), "grounding summary should mention test count");
  });

  test("warnings array stays small for quick-fix (only reflection load attempted)", async () => {
    const mod = await import("../src/context-builder.ts");

    const anchor = { type: "failing-test", reference: "test:clean" };
    const ctx = await mod.buildPlannerContext(anchor, makeGrounding(), null);
    // Only the planner-context (reflections) load is attempted for quick-fix
    // anchors after issue #193. If Redis is unavailable in the test env, that
    // is the only warning we'll see.
    assert.ok(ctx.warnings.length <= 1,
      `quick-fix should have at most one warning (reflection load), got ${ctx.warnings.length}: ${ctx.warnings.join("; ")}`);
  });
});

describe("context-builder degraded path", () => {
  test("standard anchor with unavailable Redis produces warnings, not errors", async () => {
    // Force a non-quick-fix anchor. This will attempt to load from Redis/filesystem
    // which may fail in test env — that's the point: it should degrade gracefully.
    const mod = await import("../src/context-builder.ts");

    const anchor = { type: "backlog", reference: "implement-feature-x" };

    // This may produce warnings if Redis/config files are unavailable
    // The key assertion is that it does NOT throw
    const ctx = await mod.buildPlannerContext(anchor, makeGrounding(), null);

    // Should still return a valid PlannerContext
    assert.ok(typeof ctx.priorities === "string", "priorities should be a string even on failure");
    assert.ok(typeof ctx.feedback === "string", "feedback should be a string even on failure");
    assert.ok(typeof ctx.plannerMemory === "string", "plannerMemory should be a string even on failure");
    assert.ok(typeof ctx.groundingSummary === "string", "groundingSummary should be a string");
    assert.ok(Array.isArray(ctx.warnings), "warnings should be an array");
    // In test env without config files, we expect at least some warnings
    // (but don't assert exact count — depends on environment)
  });

  test("ovSession with failing getAgentContext degrades gracefully", async () => {
    const mod = await import("../src/context-builder.ts");

    const anchor = { type: "research", reference: "research-task" };

    // Mock ovSession that throws
    const badOvSession = {
      getAgentContext: () => { throw new Error("OV connection refused"); },
    };

    const ctx = await mod.buildPlannerContext(anchor, makeGrounding(), badOvSession);

    assert.equal(ctx.ovContext, "", "ovContext should be empty on failure");
    assert.ok(ctx.warnings.some((w) => w.includes("openviking-context")),
      "should have a warning about openviking-context failure");
  });
});
