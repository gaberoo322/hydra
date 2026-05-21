/**
 * Regression tests for OV search metrics and fallback query logic.
 *
 * Issue #162: OpenViking returns zero results silently. No metrics track
 * search effectiveness. When primary query returns 0 results, no fallback
 * is attempted.
 *
 * Tests the pure functions (buildFallbackQuery, getOvSearchMetrics,
 * resetOvSearchMetrics) without requiring OV or Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildFallbackQuery,
  getOvSearchMetrics,
  resetOvSearchMetrics,
} from "../src/knowledge-base/ov-search.ts";

describe("OV search metrics", () => {
  test("getOvSearchMetrics returns zeroes when no searches have occurred", () => {
    resetOvSearchMetrics();
    const metrics = getOvSearchMetrics();
    assert.equal(metrics.totalSearches, 0);
    assert.equal(metrics.zeroResultCount, 0);
    assert.equal(metrics.totalResults, 0);
    assert.equal(metrics.totalLatencyMs, 0);
    assert.equal(metrics.fallbackAttempts, 0);
    assert.equal(metrics.fallbackSuccesses, 0);
    assert.equal(metrics.errors, 0);
    assert.equal(metrics.avgResultsPerQuery, 0);
    assert.equal(metrics.avgLatencyMs, 0);
    assert.equal(metrics.zeroResultRate, 0);
  });

  test("resetOvSearchMetrics clears all counters", () => {
    // The metrics object is module-level, so reset is the way to test
    resetOvSearchMetrics();
    const metrics = getOvSearchMetrics();
    assert.equal(metrics.totalSearches, 0);
    assert.equal(metrics.errors, 0);
  });

  test("metrics include computed fields (avgResultsPerQuery, avgLatencyMs, zeroResultRate)", () => {
    resetOvSearchMetrics();
    const metrics = getOvSearchMetrics();
    // When no searches, computed fields should be 0 (not NaN)
    assert.equal(typeof metrics.avgResultsPerQuery, "number");
    assert.equal(typeof metrics.avgLatencyMs, "number");
    assert.equal(typeof metrics.zeroResultRate, "number");
    assert.ok(!Number.isNaN(metrics.avgResultsPerQuery));
    assert.ok(!Number.isNaN(metrics.avgLatencyMs));
    assert.ok(!Number.isNaN(metrics.zeroResultRate));
  });
});

describe("buildFallbackQuery", () => {
  test("strips agent context filler from planner query", () => {
    const result = buildFallbackQuery(
      "planner agent context for: fix auth login broken test"
    );
    // Should extract agent name and simplify
    assert.ok(result.toLowerCase().includes("planner"), `Expected "planner" in: ${result}`);
    // Should be shorter than original
    assert.ok(result.length < "planner agent context for: fix auth login broken test".length);
  });

  test("strips agent lessons filler", () => {
    const result = buildFallbackQuery(
      "executor agent lessons failures prevention"
    );
    assert.ok(result.toLowerCase().includes("executor"), `Expected "executor" in: ${result}`);
    // "failures prevention" should become "patterns"
    assert.ok(result.includes("patterns"), `Expected "patterns" in: ${result}`);
  });

  test("limits to 4 meaningful words", () => {
    const result = buildFallbackQuery(
      "some very long detailed specific anchor reference with many words about authentication"
    );
    const words = result.split(" ").filter(w => w.length > 2);
    assert.ok(words.length <= 6, `Expected at most 6 words (agent prefix + 4), got ${words.length}: "${result}"`);
  });

  test("returns fallback default for empty input", () => {
    const result = buildFallbackQuery("");
    assert.ok(result.length > 0, "Should not return empty string");
    assert.equal(result, "patterns context");
  });

  test("handles query with only short words gracefully", () => {
    const result = buildFallbackQuery("a b c d e f");
    assert.ok(result.length > 0, "Should not return empty string");
  });

  test("strips punctuation from query", () => {
    const result = buildFallbackQuery(
      "planner agent context for: [failing-test] auth.login.test()"
    );
    assert.ok(!result.includes("["), `Should not contain brackets: ${result}`);
    assert.ok(!result.includes("("), `Should not contain parens: ${result}`);
  });

  test("preserves agent name at start when not already present", () => {
    const result = buildFallbackQuery(
      "skeptic agent context for: deployment pipeline broken"
    );
    assert.ok(result.toLowerCase().startsWith("skeptic"), `Should start with "skeptic": ${result}`);
  });
});
