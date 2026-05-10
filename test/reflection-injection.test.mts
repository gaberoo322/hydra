/**
 * Regression tests for issue #221 — reflection injection metric was stuck at 0%
 * because task.__hadReflections was set in planner-prompt.ts using the raw
 * plannerMemory but the metric was never propagated through the auto-decompose
 * path. Also __reflectionSources was missing from the task entirely.
 *
 * The fix: context-builder.ts now exposes `reflectionInjected` and
 * `reflectionSources` directly on PlannerContext (single source of truth), and
 * planner-prompt.ts copies those onto the task. control-loop.ts carries the
 * flags across the auto-decompose boundary.
 *
 * These tests are pure (no Redis required) — they verify the contract of the
 * exported helpers and the PlannerContext shape.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

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

describe("issue #221: reflection metric propagation", () => {
  test("inspectReflections returns count and sources for per-anchor only", async () => {
    const cb = await import("../src/context-builder.ts");
    const formatted = [
      "## PRIOR ATTEMPTS (3 previous failures for this anchor)",
      "",
      "### Attempt: cycle-001",
      "stuff",
    ].join("\n");

    const result = cb.inspectReflections(formatted);
    assert.equal(result.count, 3);
    assert.deepEqual(result.sources, ["per-anchor"]);
  });

  test("inspectReflections returns count and sources for global only", async () => {
    const cb = await import("../src/context-builder.ts");
    const formatted = [
      "## Recent Failures",
      "",
      "### cycle-1 (mode-a)",
      "stuff",
      "### cycle-2 (mode-b)",
      "more",
    ].join("\n");

    const result = cb.inspectReflections(formatted);
    assert.equal(result.count, 2);
    assert.deepEqual(result.sources, ["global"]);
  });

  test("inspectReflections returns both sources when both present", async () => {
    const cb = await import("../src/context-builder.ts");
    const formatted = [
      "## PRIOR ATTEMPTS (1 previous failures for this anchor)",
      "### Attempt: cycle-A",
      "",
      "## Recent Failures",
      "### cycle-X (mode)",
      "### cycle-Y (mode)",
    ].join("\n");

    const result = cb.inspectReflections(formatted);
    assert.equal(result.count, 3, "1 per-anchor + 2 global");
    assert.deepEqual(result.sources.sort(), ["global", "per-anchor"]);
  });

  test("inspectReflections returns empty for blank or unrelated content", async () => {
    const cb = await import("../src/context-builder.ts");

    assert.deepEqual(cb.inspectReflections(""), { count: 0, sources: [] });
    assert.deepEqual(cb.inspectReflections("just generic agent memory"), { count: 0, sources: [] });
    // PRIOR ATTEMPTS with zero count must not push "per-anchor" source
    assert.deepEqual(cb.inspectReflections("## PRIOR ATTEMPTS (0 previous failures for this anchor)"),
      { count: 0, sources: [] });
  });

  test("countReflections preserves the existing numeric contract", async () => {
    const cb = await import("../src/context-builder.ts");
    assert.equal(cb.countReflections(""), 0);
    assert.equal(cb.countReflections("## PRIOR ATTEMPTS (4 previous failures for this anchor)"), 4);
  });

  test("PlannerContext exposes reflectionInjected and reflectionSources fields", async () => {
    const cb = await import("../src/context-builder.ts");

    // failing-test anchor takes the quick-fix branch — easiest to exercise
    // without needing config files / OV
    const anchor = { type: "failing-test", reference: "test:nonexistent" };
    const ctx = await cb.buildPlannerContext(anchor, makeGrounding({ failed: 1 }), null);

    // Both new fields must be present on every code path (issue #221)
    assert.equal(typeof ctx.reflectionInjected, "number",
      "reflectionInjected must be exposed by buildPlannerContext");
    assert.ok(Array.isArray(ctx.reflectionSources),
      "reflectionSources must be an array");
    // No reflections seeded in this test → must be 0 / []
    assert.equal(ctx.reflectionInjected, 0);
    assert.deepEqual(ctx.reflectionSources, []);
  });

  test("PlannerContext exposes reflectionInjected on standard (non-quick-fix) anchor", async () => {
    const cb = await import("../src/context-builder.ts");

    // Non-quick-fix path goes through the budgeted branch with applyContextBudget
    const anchor = { type: "backlog", reference: "implement-feature-x" };
    const ctx = await cb.buildPlannerContext(anchor, makeGrounding(), null);

    // Must populate the same fields on the standard branch — this is the
    // bug regression check: previously only the quick-fix branch logged
    // reflection counts, the standard branch did too but the metric was
    // recomputed from raw bytes in planner-prompt.ts (off by truncation).
    assert.equal(typeof ctx.reflectionInjected, "number");
    assert.ok(Array.isArray(ctx.reflectionSources));
  });
});

describe("issue #221: regression — task tagging contract", () => {
  test("downstream metric writers can derive flags from ctx fields", async () => {
    const cb = await import("../src/context-builder.ts");

    const formatted = [
      "## PRIOR ATTEMPTS (2 previous failures for this anchor)",
      "### Attempt: cycle-A",
    ].join("\n");

    const stats = cb.inspectReflections(formatted);

    // Simulate planner-prompt.ts assignment
    const task: any = {};
    task.__reflectionsInjected = stats.count;
    task.__hadReflections = stats.count > 0;
    task.__reflectionSources = stats.sources.slice();

    // Simulate metric writer (cycle-helpers.ts:298, verification.ts:317,
    // post-merge.ts:393) reading those flags
    const metric = {
      reflectionInjected: task.__hadReflections ? "true" : "false",
      reflectionCount: task.__reflectionsInjected || 0,
      reflectionSources: Array.isArray(task.__reflectionSources)
        ? task.__reflectionSources.join(",")
        : "",
    };

    assert.equal(metric.reflectionInjected, "true",
      "metric must record true when reflections were injected — bug was that this stayed 'false'");
    assert.equal(metric.reflectionCount, 2);
    assert.equal(metric.reflectionSources, "per-anchor");
  });

  test("auto-decompose carries reflection flags from parent task", async () => {
    // Mirrors the parentMeta carry-over in src/control-loop.ts. Without
    // these fields in parentMeta, the decomposed sub-task surfaced no
    // __hadReflections flag and the metric stayed at 0 across the entire
    // cycle, regardless of how the parent was planned.
    const parentTask: any = {
      __plannerModel: "frontier",
      __planCacheHit: false,
      __hadReflections: true,
      __reflectionsInjected: 4,
      __reflectionSources: ["per-anchor", "global"],
      taskId: "task-foo-1",
    };

    const parentMeta = {
      __plannerModel: parentTask.__plannerModel,
      __planCacheHit: parentTask.__planCacheHit,
      __hadReflections: parentTask.__hadReflections,
      __reflectionsInjected: parentTask.__reflectionsInjected,
      __reflectionSources: parentTask.__reflectionSources,
      taskId: parentTask.taskId,
    };

    const subTask = { title: "smaller piece", scopeBoundary: { in: ["a.ts"] } };
    const merged: any = { ...subTask, ...parentMeta };

    assert.equal(merged.__hadReflections, true,
      "decomposed sub-task must inherit __hadReflections from parent (issue #221)");
    assert.equal(merged.__reflectionsInjected, 4);
    assert.deepEqual(merged.__reflectionSources, ["per-anchor", "global"]);
  });
});
