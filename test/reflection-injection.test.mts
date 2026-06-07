/**
 * Regression tests for issue #221 — the reflection-injection metric was stuck
 * at 0% because the count/sources flags weren't propagated correctly through the
 * task-tagging / auto-decompose path.
 *
 * The in-process assembly path those flags travelled through (`context-builder`,
 * `planner-prompt`, `control-loop`) was retired (issue #1128) with the codex
 * control loop. What survives — and what these pure (no-Redis) tests pin — is
 * the still-live telemetry contract: `learning.reflectionTelemetry` reads count
 * + sources off the structured LearningContext blocks (issue #804, NOT a regex
 * scan of flattened markdown), and downstream metric/auto-decompose writers
 * derive the `__hadReflections` / `__reflectionsInjected` / `__reflectionSources`
 * flags from that count.
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
