/**
 * Context budget regression tests.
 *
 * Regression: buildPlannerContext() loaded all context sources unconditionally,
 * producing 15k-20k char prompts for standard anchors. No prioritization or
 * truncation existed, inflating planner inference cost.
 *
 * Tests the pure applyContextBudget() function directly — no Redis, no
 * filesystem, no mocking needed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyContextBudget,
  CONTEXT_BUDGET,
  MIN_TRUNCATED,
  SOURCE_PRIORITY,
  type ContextSource,
} from "../src/context-builder.ts";

function makeSources(sizes: Record<string, number>): ContextSource[] {
  return Object.entries(sizes).map(([name, len]) => ({
    name,
    content: "x".repeat(len),
  }));
}

function totalChars(sources: ContextSource[]): number {
  return sources.reduce((sum, s) => sum + s.content.length, 0);
}

describe("applyContextBudget", () => {
  test("no truncation when total is under budget", () => {
    const sources = makeSources({
      grounding: 2000,
      feedback: 1000,
      reflections: 1000,
      priorities: 1000,
      memory: 1000,
      accomplishments: 1000,
      continuity: 1000,
    });
    const result = applyContextBudget(sources);
    // Every source should be unchanged
    for (let i = 0; i < sources.length; i++) {
      assert.equal(result[i].content.length, sources[i].content.length,
        `${sources[i].name} should not be truncated`);
    }
  });

  test("lower-priority sources are truncated first when over budget", () => {
    // Total = 18000, budget = 12000 — need to shed ~6000 chars
    const sources = makeSources({
      grounding: 3000,
      feedback: 3000,
      reflections: 3000,
      priorities: 3000,
      memory: 3000,
      accomplishments: 3000,
      continuity: 3000,  // lowest priority → truncated first
    });

    const result = applyContextBudget(sources, 12000, 500);

    // Grounding (highest priority) must be untouched
    const grounding = result.find((s) => s.name === "grounding")!;
    assert.equal(grounding.content.length, 3000, "grounding must never be truncated");

    // Continuity (lowest priority) should be truncated
    const continuity = result.find((s) => s.name === "continuity")!;
    assert.ok(continuity.content.length < 3000, "continuity should be truncated");

    // Total should be at or under budget
    assert.ok(totalChars(result) <= 12000 + 200, // allow for truncation notice text
      `total ${totalChars(result)} should be near budget`);
  });

  test("truncated sources keep at least MIN_TRUNCATED chars of content", () => {
    // Massive sources — budget forces heavy truncation
    const sources = makeSources({
      grounding: 5000,
      feedback: 5000,
      reflections: 5000,
      priorities: 5000,
      memory: 5000,
      accomplishments: 5000,
      continuity: 5000,  // 35000 total, budget 12000
    });

    const result = applyContextBudget(sources, 12000, 500);

    for (const s of result) {
      // Each truncated source should keep at least 500 chars of actual content
      // (the truncation notice is appended, so total length >= 500)
      assert.ok(s.content.length >= 500,
        `${s.name} should keep at least ${MIN_TRUNCATED} chars, got ${s.content.length}`);
    }
  });

  test("grounding (highest priority) is never truncated", () => {
    // Even with extreme budget pressure, grounding is last to be touched
    const sources = makeSources({
      grounding: 10000,
      feedback: 1000,
      reflections: 1000,
      priorities: 1000,
      memory: 1000,
      accomplishments: 1000,
      continuity: 1000,
    });

    const result = applyContextBudget(sources, 12000, 500);
    const grounding = result.find((s) => s.name === "grounding")!;
    assert.equal(grounding.content.length, 10000,
      "grounding must not be truncated even under budget pressure");
  });

  test("truncated sources include truncation notice", () => {
    const sources = makeSources({
      grounding: 2000,
      continuity: 15000,
    });

    const result = applyContextBudget(sources, 5000, 500);
    const continuity = result.find((s) => s.name === "continuity")!;
    assert.ok(continuity.content.includes("(truncated from 15000 chars)"),
      "truncated source should have a truncation notice");
  });

  test("source order is preserved after truncation", () => {
    const sources: ContextSource[] = [
      { name: "grounding", content: "x".repeat(3000) },
      { name: "feedback", content: "x".repeat(3000) },
      { name: "continuity", content: "x".repeat(10000) },
    ];

    const result = applyContextBudget(sources, 12000, 500);
    assert.deepEqual(
      result.map((s) => s.name),
      ["grounding", "feedback", "continuity"],
      "source order should be preserved",
    );
  });

  test("empty sources are not truncated", () => {
    const sources: ContextSource[] = [
      { name: "grounding", content: "x".repeat(11000) },
      { name: "continuity", content: "" },
      { name: "feedback", content: "x".repeat(5000) },
    ];

    const result = applyContextBudget(sources, 12000, 500);
    const continuity = result.find((s) => s.name === "continuity")!;
    assert.equal(continuity.content, "", "empty source should stay empty");
  });

  test("constants are exported with expected values", () => {
    assert.equal(CONTEXT_BUDGET, 12000);
    assert.equal(MIN_TRUNCATED, 500);
    assert.ok(SOURCE_PRIORITY.length >= 7, "should have at least 7 priority sources");
    assert.equal(SOURCE_PRIORITY[0], "grounding", "grounding should be highest priority");
  });
});
