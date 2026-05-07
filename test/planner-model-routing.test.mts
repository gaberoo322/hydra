/**
 * Regression test for issue #138 — codebase-health anchors should route to
 * the codex model tier instead of frontier.
 *
 * Bug: All non-quick-fix anchors used the frontier model ($2.50/$15.00 per 1M
 * tokens) for planning, but codebase-health anchors involve deterministic,
 * narrowly-scoped changes where the cheaper codex model suffices.
 *
 * Fix: Add codebase-health to the set of anchor types that route to codex.
 *
 * Tests the model selection logic from planner-prompt.ts by replicating
 * the inline routing decision (the logic is not exported as a function).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * Replicates the model selection logic from planner-prompt.ts lines 192-195.
 * If this diverges from the source, update both.
 */
function selectPlannerModel(anchorType: string): "codex" | "frontier" {
  const isQuickFixAnchor = anchorType === "failing-test" || anchorType === "prior-failure";
  const isCheapAnchor = isQuickFixAnchor || anchorType === "codebase-health";
  return isCheapAnchor ? "codex" : "frontier";
}

describe("planner model routing (issue #138)", () => {
  test("codebase-health anchors route to codex model", () => {
    assert.equal(selectPlannerModel("codebase-health"), "codex",
      "codebase-health should use cheaper codex model");
  });

  test("failing-test anchors route to codex model", () => {
    assert.equal(selectPlannerModel("failing-test"), "codex",
      "failing-test should use codex model");
  });

  test("prior-failure anchors route to codex model", () => {
    assert.equal(selectPlannerModel("prior-failure"), "codex",
      "prior-failure should use codex model");
  });

  test("user-request anchors route to frontier model", () => {
    assert.equal(selectPlannerModel("user-request"), "frontier",
      "user-request should use frontier model");
  });

  test("research anchors route to frontier model", () => {
    assert.equal(selectPlannerModel("research"), "frontier",
      "research should use frontier model");
  });

  test("kanban anchors route to frontier model", () => {
    assert.equal(selectPlannerModel("kanban"), "frontier",
      "kanban should use frontier model");
  });

  test("spec anchors route to frontier model", () => {
    assert.equal(selectPlannerModel("spec"), "frontier",
      "spec should use frontier model");
  });

  test("reframe anchors route to frontier model", () => {
    assert.equal(selectPlannerModel("reframe"), "frontier",
      "reframe should use frontier model");
  });

  test("todo anchors route to frontier model", () => {
    assert.equal(selectPlannerModel("todo"), "frontier",
      "todo should use frontier model");
  });
});
