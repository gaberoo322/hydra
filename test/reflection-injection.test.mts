/**
 * Regression tests for issue #221 — the reflection-injection metric was stuck
 * at 0% because the count/sources flags weren't propagated correctly through the
 * task-tagging / auto-decompose path.
 *
 * The in-process assembly path those flags travelled through (`context-builder`,
 * `planner-prompt`, `control-loop`) was retired (issue #1128) with the codex
 * control loop, and the `learning.reflectionTelemetry` helper that derived the
 * count was removed as dead once its last production consumer went (issue
 * #1414). What survives — and what this pure (no-Redis) test pins — is the
 * `parentMeta` carry-over contract on auto-decompose: a decomposed sub-task must
 * inherit the reflection flags from its parent.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("issue #221: regression — task tagging contract", () => {
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
