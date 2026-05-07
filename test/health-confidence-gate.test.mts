/**
 * Regression test for low-confidence codebase-health anchor gate (issue #147).
 *
 * Bug: codebase-health anchors have ~83% empty rate. selectAnchor() returned
 * them without checking confidence, wasting ~$2.50 per cycle on a planner call
 * that produces noWork. The post-selection confidence gate in control-loop.ts
 * caught them, but the cycle ended with "skipped" instead of falling through
 * to the next anchor type (priorities doc).
 *
 * Fix: selectAnchor() now calls scoreHeuristic() on codebase-health candidates
 * before returning. Anchors scoring < 0.5 are skipped with a 'low-confidence-skip'
 * log so the selection falls through to the next priority level.
 *
 * Tests the pure scoring function (no Redis, no LLM).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scoreHeuristic } from "../src/anchor-scorer.ts";
import { _testing } from "../src/anchor-selection.ts";

const { HEALTH_CONFIDENCE_THRESHOLD } = _testing;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGrounding(overrides: Record<string, any> = {}) {
  return {
    testReport: { passed: 42, failed: 0 },
    typecheckReport: { exitCode: 0 },
    todoMarkers: [],
    failingTests: [],
    fileTree: "",
    ...overrides,
  };
}

function makeHealthAnchor(ref = "codebase-health: large-file in src/api.ts") {
  return {
    type: "codebase-health",
    reference: ref,
    whyNow: "Top health issue: large-file",
    context: "Split src/api.ts into smaller modules",
    description: "Split src/api.ts into smaller modules",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("codebase-health confidence gate (issue #147)", () => {
  test("HEALTH_CONFIDENCE_THRESHOLD is 0.5", () => {
    assert.equal(HEALTH_CONFIDENCE_THRESHOLD, 0.5);
  });

  test("low-confidence: codebase-health with no signal scores below threshold", () => {
    // No failing tests, no typecheck errors, no TODO markers — historically 83% empty
    const anchor = makeHealthAnchor();
    const grounding = makeGrounding();
    const result = scoreHeuristic(anchor, grounding);

    assert.ok(
      result.score < HEALTH_CONFIDENCE_THRESHOLD,
      `Expected score ${result.score} < threshold ${HEALTH_CONFIDENCE_THRESHOLD}`,
    );
    // This anchor would be skipped by selectAnchor's confidence gate
  });

  test("high-confidence: codebase-health with failing tests scores above threshold", () => {
    const anchor = makeHealthAnchor();
    const grounding = makeGrounding({
      failingTests: ["test-1"],
      testReport: { passed: 40, failed: 2 },
    });
    const result = scoreHeuristic(anchor, grounding);

    assert.ok(
      result.score >= HEALTH_CONFIDENCE_THRESHOLD,
      `Expected score ${result.score} >= threshold ${HEALTH_CONFIDENCE_THRESHOLD}`,
    );
    // This anchor would be returned by selectAnchor
  });

  test("high-confidence: codebase-health with typecheck errors scores above threshold", () => {
    const anchor = makeHealthAnchor();
    const grounding = makeGrounding({ typecheckReport: { exitCode: 1 } });
    const result = scoreHeuristic(anchor, grounding);

    assert.ok(
      result.score >= HEALTH_CONFIDENCE_THRESHOLD,
      `Expected score ${result.score} >= threshold ${HEALTH_CONFIDENCE_THRESHOLD}`,
    );
  });

  test("boundary: codebase-health with TODO markers scores exactly at threshold", () => {
    const anchor = makeHealthAnchor();
    const grounding = makeGrounding({ todoMarkers: ["TODO: fix this"] });
    const result = scoreHeuristic(anchor, grounding);

    // Score of 0.5 should pass the gate (>= threshold, not < threshold)
    assert.equal(result.score, 0.5);
    assert.ok(
      result.score >= HEALTH_CONFIDENCE_THRESHOLD,
      `Score at threshold boundary (${result.score}) should pass the gate`,
    );
  });

  test("skip falls through: non-health anchor types are unaffected by the gate", () => {
    // The confidence gate only applies to codebase-health anchors.
    // Other types with low scores are handled by the control loop's post-selection gate.
    const docAnchor = { type: "doc", reference: "direction/priorities.md" };
    const grounding = makeGrounding();
    const result = scoreHeuristic(docAnchor, grounding);

    // doc anchors score 0.5 — they're not subject to HEALTH_CONFIDENCE_THRESHOLD
    assert.equal(result.score, 0.5);
    assert.equal(result.tier, "heuristic");
  });
});
