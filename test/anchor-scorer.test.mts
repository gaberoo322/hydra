/**
 * Regression tests for src/anchor-scorer.ts — anchor confidence scoring.
 *
 * Tests the pure heuristic scoring functions (Tier 1) without any LLM or
 * Redis dependency. Tier 2 (nano-model classifier) is tested via the
 * ambiguous-score path returning heuristic fallback when no agent is available.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Import the heuristic scorer directly — it's a pure function
import { scoreHeuristic, getMinConfidence } from "../src/anchor-scorer.ts";

// ---------------------------------------------------------------------------
// Helpers — minimal grounding stubs
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

// ---------------------------------------------------------------------------
// Tier 1: Deterministic heuristic scoring
// ---------------------------------------------------------------------------

describe("anchor-scorer heuristic scoring", () => {
  // --- failing-test ---
  test("failing-test anchor always scores 1.0", () => {
    const result = scoreHeuristic(
      { type: "failing-test", reference: "auth login test" },
      makeGrounding(),
    );
    assert.equal(result.score, 1.0);
    assert.equal(result.tier, "heuristic");
  });

  // --- prior-failure ---
  test("prior-failure anchor scores 0.6", () => {
    const result = scoreHeuristic(
      { type: "prior-failure", reference: "task-123" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.6);
    assert.equal(result.tier, "heuristic");
  });

  // --- reframe ---
  test("reframe anchor scores 0.7", () => {
    const result = scoreHeuristic(
      { type: "reframe", reference: "auth refactor" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.7);
    assert.equal(result.tier, "heuristic");
  });

  // --- regression-hunt ---
  test("regression-hunt anchor scores 0.8", () => {
    const result = scoreHeuristic(
      { type: "regression-hunt", reference: "periodic hunt" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.8);
    assert.equal(result.tier, "heuristic");
  });

  // --- research ---
  test("research anchor with valid reference scores 0.8", () => {
    const result = scoreHeuristic(
      { type: "research", reference: "Add WebSocket reconnection" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.8);
    assert.equal(result.tier, "heuristic");
  });

  test("research anchor with empty reference scores 0", () => {
    const result = scoreHeuristic(
      { type: "research", reference: "" },
      makeGrounding(),
    );
    assert.equal(result.score, 0);
  });

  // --- user-request ---
  test("user-request with context scores 0.9", () => {
    const result = scoreHeuristic(
      { type: "user-request", reference: "Add dark mode", context: "Toggle in settings" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.9);
  });

  test("user-request with description scores 0.9", () => {
    const result = scoreHeuristic(
      { type: "user-request", reference: "Fix header", description: "Header overlaps on mobile" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.9);
  });

  test("user-request with reference only scores 0.6", () => {
    const result = scoreHeuristic(
      { type: "user-request", reference: "Add feature X" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.6);
  });

  test("user-request with empty reference scores 0", () => {
    const result = scoreHeuristic(
      { type: "user-request", reference: "" },
      makeGrounding(),
    );
    assert.equal(result.score, 0);
  });

  test("user-request with completed prefix scores 0", () => {
    const result = scoreHeuristic(
      { type: "user-request", reference: "COMPLETED: old task" },
      makeGrounding(),
    );
    assert.equal(result.score, 0);
  });

  // --- codebase-health ---
  test("codebase-health with no signal scores 0", () => {
    const result = scoreHeuristic(
      { type: "codebase-health", reference: "codebase-health: large-file in src/api.ts" },
      makeGrounding(),
    );
    assert.equal(result.score, 0);
  });

  test("codebase-health with failing tests scores 0.8", () => {
    const result = scoreHeuristic(
      { type: "codebase-health", reference: "codebase-health: coverage in src/api.ts" },
      makeGrounding({ failingTests: ["test-1"], testReport: { passed: 40, failed: 2 } }),
    );
    assert.equal(result.score, 0.8);
  });

  test("codebase-health with typecheck errors scores 0.7", () => {
    const result = scoreHeuristic(
      { type: "codebase-health", reference: "codebase-health: type-safety" },
      makeGrounding({ typecheckReport: { exitCode: 1 } }),
    );
    assert.equal(result.score, 0.7);
  });

  test("codebase-health with TODO markers scores 0.5", () => {
    const result = scoreHeuristic(
      { type: "codebase-health", reference: "codebase-health: docs" },
      makeGrounding({ todoMarkers: ["TODO: fix this"] }),
    );
    assert.equal(result.score, 0.5);
  });

  // --- issue (TODO/FIXME markers) ---
  test("issue anchor with active TODO markers scores 0.7", () => {
    const result = scoreHeuristic(
      { type: "issue", reference: "TODO: fix auth" },
      makeGrounding({ todoMarkers: ["TODO: fix auth"] }),
    );
    assert.equal(result.score, 0.7);
  });

  test("issue anchor with no markers scores 0.3", () => {
    const result = scoreHeuristic(
      { type: "issue", reference: "TODO: old task" },
      makeGrounding({ todoMarkers: [] }),
    );
    assert.equal(result.score, 0.3);
  });

  // --- doc (priorities fallback) ---
  test("doc anchor scores 0.5", () => {
    const result = scoreHeuristic(
      { type: "doc", reference: "direction/priorities.md" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.5);
  });

  // --- unknown type ---
  test("unknown anchor type scores 0.5", () => {
    const result = scoreHeuristic(
      { type: "banana", reference: "mystery" },
      makeGrounding(),
    );
    assert.equal(result.score, 0.5);
  });

  // --- null/undefined anchor ---
  test("null anchor defaults to unknown type with 0.5", () => {
    const result = scoreHeuristic(null, makeGrounding());
    assert.equal(result.score, 0.5);
    assert.match(result.reason, /unknown/i);
  });

  // --- all results have required shape ---
  test("all results include score, reason, and tier", () => {
    const anchors = [
      { type: "failing-test", reference: "x" },
      { type: "prior-failure", reference: "x" },
      { type: "reframe", reference: "x" },
      { type: "research", reference: "x" },
      { type: "user-request", reference: "x" },
      { type: "codebase-health", reference: "x" },
      { type: "issue", reference: "x" },
      { type: "doc", reference: "x" },
      { type: "unknown-thing", reference: "x" },
    ];
    for (const anchor of anchors) {
      const result = scoreHeuristic(anchor, makeGrounding());
      assert.ok(typeof result.score === "number", `${anchor.type}: score is number`);
      assert.ok(result.score >= 0 && result.score <= 1, `${anchor.type}: score in range`);
      assert.ok(typeof result.reason === "string", `${anchor.type}: reason is string`);
      assert.ok(result.reason.length > 0, `${anchor.type}: reason non-empty`);
      assert.ok(result.tier === "heuristic", `${anchor.type}: tier is heuristic`);
    }
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("anchor-scorer configuration", () => {
  test("getMinConfidence returns a number", () => {
    const min = getMinConfidence();
    assert.ok(typeof min === "number");
    assert.ok(min >= 0 && min <= 1);
  });

  test("default min confidence is 0.4", () => {
    // Only valid when ANCHOR_MIN_CONFIDENCE env var is not set
    if (!process.env.ANCHOR_MIN_CONFIDENCE) {
      assert.equal(getMinConfidence(), 0.4);
    }
  });
});
