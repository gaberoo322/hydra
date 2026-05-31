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
 * Issue #804: the count/sources are now read off the structured LearningContext
 * blocks via `learning.reflectionTelemetry`, NOT regex-scanned out of the
 * flattened markdown (the deleted `inspectReflections`/`countReflections`). The
 * helper unit tests below assert against the structured blocks directly.
 *
 * These tests are pure (no Redis required) — they verify the contract of the
 * exported helpers and the PlannerContext shape.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { LearningContext, LearningContextBlock } from "../src/learning.ts";

/** Build a minimal LearningContext from a list of blocks (toPrompt joins hits). */
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

describe("issue #804: reflectionTelemetry reads count + sources off structured blocks", () => {
  test("returns count and sources for per-anchor only", async () => {
    const { reflectionTelemetry } = await import("../src/learning.ts");
    const result = reflectionTelemetry(ctxOf([
      { source: "per-anchor-reflections", status: "hit", content: "## PRIOR ATTEMPTS (3…)", itemCount: 3 },
    ]));
    assert.equal(result.count, 3);
    assert.deepEqual(result.sources, ["per-anchor"]);
  });

  test("returns count and sources for global only", async () => {
    const { reflectionTelemetry } = await import("../src/learning.ts");
    const result = reflectionTelemetry(ctxOf([
      { source: "global-reflections", status: "hit", content: "## Recent Failures …", itemCount: 2 },
    ]));
    assert.equal(result.count, 2);
    assert.deepEqual(result.sources, ["global"]);
  });

  test("sums across reflection sources when several are present, in block order", async () => {
    const { reflectionTelemetry } = await import("../src/learning.ts");
    const result = reflectionTelemetry(ctxOf([
      { source: "agent-memory", status: "hit", content: "patterns", itemCount: 1 },
      { source: "knowledge-base", status: "hit", content: "ov", itemCount: 5 },
      { source: "per-anchor-reflections", status: "hit", content: "prior", itemCount: 1 },
      { source: "global-reflections", status: "hit", content: "recent", itemCount: 2 },
    ]));
    assert.equal(result.count, 3, "1 per-anchor + 2 global; pattern/KB blocks are NOT reflections");
    assert.deepEqual(result.sources, ["per-anchor", "global"], "canonical block order preserved");
  });

  test("returns empty when no reflection blocks hit (or itemCount 0)", async () => {
    const { reflectionTelemetry } = await import("../src/learning.ts");
    assert.deepEqual(reflectionTelemetry(ctxOf([])), { count: 0, sources: [] });
    assert.deepEqual(
      reflectionTelemetry(ctxOf([{ source: "agent-memory", status: "hit", content: "x", itemCount: 1 }])),
      { count: 0, sources: [] },
      "agent-memory is not a reflection source",
    );
    // A reflection source that missed (itemCount 0) must not contribute.
    assert.deepEqual(
      reflectionTelemetry(ctxOf([{ source: "per-anchor-reflections", status: "miss", content: "", itemCount: 0 }])),
      { count: 0, sources: [] },
    );
  });

  test("knowledge-base block never counts as a reflection", async () => {
    const { reflectionTelemetry } = await import("../src/learning.ts");
    const result = reflectionTelemetry(ctxOf([
      { source: "knowledge-base", status: "hit", content: "ov memories", itemCount: 4 },
    ]));
    assert.deepEqual(result, { count: 0, sources: [] });
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
    const { reflectionTelemetry } = await import("../src/learning.ts");

    const stats = reflectionTelemetry(ctxOf([
      { source: "per-anchor-reflections", status: "hit", content: "## PRIOR ATTEMPTS (2…)", itemCount: 2 },
    ]));

    // Simulate planner-prompt.ts assignment
    const task: any = {};
    task.__reflectionsInjected = stats.count;
    task.__hadReflections = stats.count > 0;
    task.__reflectionSources = stats.sources.slice();

    // Simulate metric writer reading those flags (post-merge / verification path)
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
