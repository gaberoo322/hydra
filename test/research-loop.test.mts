/**
 * Regression tests for research auto-queue telemetry (issue #314).
 *
 * Bug: `[Research] Auto-queued #${opp.rank}` logged `#undefined` because the
 * Director's synthesis schema produces `alignmentScore`, `impact`, and
 * `feasibility` — not `rank`, `adjustedScore`, or `confidence`. 90+ log lines
 * in 2 days carried `undefined` telemetry. The fix derives the missing fields
 * from the Director's actual output so logs and work-queue context carry real
 * numbers.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { enrichOpportunity } from "../src/research-loop.ts";

describe("enrichOpportunity — rank derivation", () => {
  test("uses array index + 1 when rank is missing", () => {
    const enriched = enrichOpportunity({ title: "foo" }, 0);
    assert.equal(enriched.rank, 1);

    const enriched2 = enrichOpportunity({ title: "bar" }, 4);
    assert.equal(enriched2.rank, 5);
  });

  test("preserves an existing positive numeric rank", () => {
    const enriched = enrichOpportunity({ title: "foo", rank: 7 }, 0);
    assert.equal(enriched.rank, 7);
  });

  test("falls back to index for non-numeric / zero / negative rank", () => {
    assert.equal(enrichOpportunity({ rank: "1" } as any, 2).rank, 3);
    assert.equal(enrichOpportunity({ rank: 0 } as any, 2).rank, 3);
    assert.equal(enrichOpportunity({ rank: -1 } as any, 2).rank, 3);
  });
});

describe("enrichOpportunity — adjustedScore derivation", () => {
  test("maps alignmentScore onto adjustedScore", () => {
    const enriched = enrichOpportunity({ title: "foo", alignmentScore: 0.85 }, 0);
    assert.equal(enriched.adjustedScore, 0.85);
  });

  test("preserves existing adjustedScore over alignmentScore", () => {
    const enriched = enrichOpportunity({ adjustedScore: 0.5, alignmentScore: 0.9 }, 0);
    assert.equal(enriched.adjustedScore, 0.5);
  });

  test("returns null when neither field is present", () => {
    const enriched = enrichOpportunity({ title: "foo" }, 0);
    assert.equal(enriched.adjustedScore, null);
  });
});

describe("enrichOpportunity — confidence derivation", () => {
  test("derives 0.8 from feasibility=high", () => {
    const enriched = enrichOpportunity({ feasibility: "high" }, 0);
    assert.equal(enriched.confidence, 0.8);
  });

  test("derives 0.5 from feasibility=medium", () => {
    const enriched = enrichOpportunity({ feasibility: "medium" }, 0);
    assert.equal(enriched.confidence, 0.5);
  });

  test("derives 0.3 from feasibility=low", () => {
    const enriched = enrichOpportunity({ feasibility: "low" }, 0);
    assert.equal(enriched.confidence, 0.3);
  });

  test("preserves existing numeric confidence over feasibility", () => {
    const enriched = enrichOpportunity({ confidence: 0.65, feasibility: "low" }, 0);
    assert.equal(enriched.confidence, 0.65);
  });

  test("is case-insensitive on feasibility tier", () => {
    const enriched = enrichOpportunity({ feasibility: "HIGH" }, 0);
    assert.equal(enriched.confidence, 0.8);
  });

  test("returns null for unknown feasibility tiers", () => {
    const enriched = enrichOpportunity({ feasibility: "moderate" }, 0);
    assert.equal(enriched.confidence, null);
  });

  test("returns null when neither field is present", () => {
    const enriched = enrichOpportunity({ title: "foo" }, 0);
    assert.equal(enriched.confidence, null);
  });
});

describe("enrichOpportunity — issue #314 telemetry contract", () => {
  test("auto-queued log line shows real numbers given a Director-shape opportunity", () => {
    // Shape per config/research/director.md — the Director's actual output schema.
    const directorOpp = {
      title: "Wire LLM probability estimator into edge model",
      description: "...",
      category: "feature",
      impact: "high",
      feasibility: "high",
      alignmentScore: 0.9,
      reasoning: "...",
      autoQueue: true,
      prerequisites: [],
    };

    const enriched = enrichOpportunity(directorOpp, 0);

    // None of these may be `undefined` (the bug).
    assert.notEqual(enriched.rank, undefined, "rank must not be undefined");
    assert.notEqual(enriched.adjustedScore, undefined, "adjustedScore must not be undefined");
    assert.notEqual(enriched.confidence, undefined, "confidence must not be undefined");

    // The log line that ships to operators.
    const logLine = `[Research] Auto-queued #${enriched.rank}: "${enriched.title}" (score: ${enriched.adjustedScore}, confidence: ${enriched.confidence})`;
    assert.equal(logLine.includes("undefined"), false, `log line still includes 'undefined': ${logLine}`);
    assert.equal(logLine, `[Research] Auto-queued #1: "Wire LLM probability estimator into edge model" (score: 0.9, confidence: 0.8)`);
  });

  test("work-queue context carries non-undefined rank/score/confidence", () => {
    const directorOpp = {
      title: "X",
      alignmentScore: 0.7,
      feasibility: "medium",
      autoQueue: true,
    };

    const enriched = enrichOpportunity(directorOpp, 3);

    // Mirror the JSON.stringify(context) payload the work-queue receives.
    const context = {
      rank: enriched.rank,
      adjustedScore: enriched.adjustedScore,
      confidence: enriched.confidence,
    };

    assert.equal(typeof context.rank, "number");
    assert.equal(typeof context.adjustedScore, "number");
    assert.equal(typeof context.confidence, "number");
    assert.deepEqual(context, { rank: 4, adjustedScore: 0.7, confidence: 0.5 });
  });

  test("returned object preserves all original opportunity fields", () => {
    const opp = {
      title: "T",
      description: "D",
      category: "feature",
      impact: "high",
      feasibility: "high",
      alignmentScore: 0.9,
      reasoning: "R",
      autoQueue: true,
      prerequisites: ["a"],
      acceptanceCriteria: ["c1", "c2"],
    };

    const enriched = enrichOpportunity(opp, 0);

    assert.equal(enriched.title, "T");
    assert.equal(enriched.description, "D");
    assert.equal(enriched.category, "feature");
    assert.equal(enriched.impact, "high");
    assert.equal(enriched.feasibility, "high");
    assert.equal(enriched.alignmentScore, 0.9);
    assert.equal(enriched.reasoning, "R");
    assert.equal(enriched.autoQueue, true);
    assert.deepEqual(enriched.prerequisites, ["a"]);
    assert.deepEqual(enriched.acceptanceCriteria, ["c1", "c2"]);
  });
});
