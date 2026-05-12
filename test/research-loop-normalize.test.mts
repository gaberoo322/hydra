/**
 * Regression tests for research-loop opportunity normalization (issue #314).
 *
 * Bug: The director agent's JSON schema emits
 *   { title, description, category, impact, feasibility, alignmentScore,
 *     reasoning, autoQueue, prerequisites }
 * but the auto-queue consumer reads
 *   rank, adjustedScore, confidence, complexity, rationale,
 *   acceptanceCriteria, estimatedCycles
 *
 * Result: live logs were emitting
 *   [Research] Auto-queued #undefined: "..." (score: undefined, confidence: undefined)
 * on every queued opportunity, and the persisted work-queue context
 * carried `undefined` for those fields too — 90 lost telemetry events in
 * the 48h before the fix.
 *
 * normalizeOpportunities maps director output onto the consumer field
 * names without changing the director's schema contract.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOpportunity,
  normalizeOpportunities,
} from "../src/research-loop.ts";

describe("normalizeOpportunity — director-shape → consumer-shape", () => {
  test("maps alignmentScore → adjustedScore", () => {
    const opp = {
      title: "Foo",
      alignmentScore: 0.87,
      feasibility: "high",
      reasoning: "because",
    };
    const out = normalizeOpportunity(opp, 1);
    assert.equal(out.adjustedScore, 0.87);
  });

  test("maps feasibility → confidence (lowercased)", () => {
    const out = normalizeOpportunity({ feasibility: "High" }, 1);
    assert.equal(out.confidence, "high");
  });

  test("maps reasoning → rationale", () => {
    const out = normalizeOpportunity({ reasoning: "explains it" }, 1);
    assert.equal(out.rationale, "explains it");
  });

  test("derives complexity from inverse of feasibility", () => {
    assert.equal(normalizeOpportunity({ feasibility: "high" }, 1).complexity, "low");
    assert.equal(normalizeOpportunity({ feasibility: "medium" }, 1).complexity, "medium");
    assert.equal(normalizeOpportunity({ feasibility: "low" }, 1).complexity, "high");
  });

  test("assigns rank from supplied argument", () => {
    const out = normalizeOpportunity({ title: "x" }, 3);
    assert.equal(out.rank, 3);
  });

  test("never overwrites an explicit value with a derived one", () => {
    const opp = {
      rank: 99,
      adjustedScore: 0.11,
      confidence: "low",
      complexity: "extreme",
      rationale: "explicit",
      alignmentScore: 0.99,
      feasibility: "high",
      reasoning: "ignored",
    };
    const out = normalizeOpportunity(opp, 1);
    assert.equal(out.rank, 99);
    assert.equal(out.adjustedScore, 0.11);
    assert.equal(out.confidence, "low");
    assert.equal(out.complexity, "extreme");
    assert.equal(out.rationale, "explicit");
  });

  test("preserves unrelated fields", () => {
    const opp = {
      title: "Foo",
      description: "bar",
      category: "feature",
      autoQueue: true,
      prerequisites: ["a", "b"],
      acceptanceCriteria: ["c"],
      estimatedCycles: 2,
      alignmentScore: 0.5,
      feasibility: "medium",
    };
    const out = normalizeOpportunity(opp, 2);
    assert.equal(out.title, "Foo");
    assert.equal(out.description, "bar");
    assert.equal(out.category, "feature");
    assert.equal(out.autoQueue, true);
    assert.deepEqual(out.prerequisites, ["a", "b"]);
    assert.deepEqual(out.acceptanceCriteria, ["c"]);
    assert.equal(out.estimatedCycles, 2);
  });

  test("returns input unchanged if not an object", () => {
    assert.equal(normalizeOpportunity(null), null);
    assert.equal(normalizeOpportunity(undefined), undefined);
    assert.equal(normalizeOpportunity("oops" as any), "oops");
  });

  test("missing feasibility/alignmentScore leaves derived fields undefined", () => {
    const out = normalizeOpportunity({ title: "no score" }, 1);
    assert.equal(out.adjustedScore, undefined);
    assert.equal(out.confidence, undefined);
    assert.equal(out.complexity, undefined);
  });
});

describe("normalizeOpportunities — array-level normalization", () => {
  test("sorts by alignmentScore descending and assigns 1-based rank", () => {
    const opps = [
      { title: "B", alignmentScore: 0.5, feasibility: "medium", reasoning: "b" },
      { title: "A", alignmentScore: 0.9, feasibility: "high", reasoning: "a" },
      { title: "C", alignmentScore: 0.3, feasibility: "low", reasoning: "c" },
    ];
    const out = normalizeOpportunities(opps);
    assert.equal(out.length, 3);
    assert.equal(out[0].title, "A");
    assert.equal(out[0].rank, 1);
    assert.equal(out[1].title, "B");
    assert.equal(out[1].rank, 2);
    assert.equal(out[2].title, "C");
    assert.equal(out[2].rank, 3);
  });

  test("populates the fields needed by the [Research] Auto-queued log line", () => {
    // Regression for issue #314: ensure rank, adjustedScore, and confidence
    // are non-undefined on every normalized opportunity so the log line
    // emits real numbers/strings, not "#undefined (score: undefined, confidence: undefined)".
    const opps = [
      { title: "T", alignmentScore: 0.7, feasibility: "high", reasoning: "r" },
    ];
    const [out] = normalizeOpportunities(opps);
    const logLine = `[Research] Auto-queued #${out.rank}: "${out.title}" (score: ${out.adjustedScore}, confidence: ${out.confidence})`;
    assert.ok(!logLine.includes("undefined"), `log line still has undefined: ${logLine}`);
    assert.equal(logLine, `[Research] Auto-queued #1: "T" (score: 0.7, confidence: high)`);
  });

  test("respects explicit rank already on opportunities", () => {
    const opps = [
      { title: "X", rank: 2, alignmentScore: 0.9 },
      { title: "Y", rank: 1, alignmentScore: 0.1 },
    ];
    const out = normalizeOpportunities(opps);
    assert.equal(out[0].title, "Y");
    assert.equal(out[0].rank, 1);
    assert.equal(out[1].title, "X");
    assert.equal(out[1].rank, 2);
  });

  test("returns [] for non-array input", () => {
    assert.deepEqual(normalizeOpportunities(null as any), []);
    assert.deepEqual(normalizeOpportunities(undefined as any), []);
    assert.deepEqual(normalizeOpportunities({} as any), []);
  });

  test("stable for opportunities missing scores (preserves insertion order)", () => {
    const opps = [
      { title: "first" },
      { title: "second" },
      { title: "third" },
    ];
    const out = normalizeOpportunities(opps);
    assert.equal(out[0].title, "first");
    assert.equal(out[1].title, "second");
    assert.equal(out[2].title, "third");
    assert.equal(out[0].rank, 1);
    assert.equal(out[1].rank, 2);
    assert.equal(out[2].rank, 3);
  });

  test("matches the real director output shape (fixture from research-2026-05-12-2053)", () => {
    // Fixture mirrors the actual director output observed in Redis on
    // 2026-05-12 — keys: title, description, category, impact,
    // feasibility, alignmentScore, reasoning, autoQueue, prerequisites.
    const directorOpp = {
      title: "Restore sports forecast capture-time regression",
      description: "Fix the failing forecast-outcome sync behavior",
      category: "feature",
      impact: "high",
      feasibility: "high",
      alignmentScore: 0.95,
      reasoning: "Forecast calibration is the operator's primary path",
      autoQueue: true,
      prerequisites: [],
    };
    const [out] = normalizeOpportunities([directorOpp]);
    assert.equal(out.rank, 1);
    assert.equal(out.adjustedScore, 0.95);
    assert.equal(out.confidence, "high");
    assert.equal(out.complexity, "low");
    assert.equal(out.rationale, "Forecast calibration is the operator's primary path");
    // Auto-queue log line must be fully populated:
    assert.ok(typeof out.rank === "number");
    assert.ok(typeof out.adjustedScore === "number");
    assert.ok(typeof out.confidence === "string");
  });
});
