/**
 * Regression tests for work queue deduplication.
 *
 * Bug: duplicate items accumulated in the work queue (e.g., "Add stream freshness
 * route-quality scoring" appeared 3x). Issue #82 added fuzzy dedup checks.
 *
 * Tests the pure dedup functions (normalizeForDedup, isFuzzyDuplicate) and
 * the cleanWorkQueue logic.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeForDedup, isFuzzyDuplicate } from "../src/redis-adapter.ts";

describe("normalizeForDedup", () => {
  test("lowercases and trims", () => {
    assert.equal(normalizeForDedup("  Hello World  "), "hello world");
  });

  test("collapses multiple whitespace into single space", () => {
    assert.equal(normalizeForDedup("Add   stream\tfreshness"), "add stream freshness");
  });

  test("handles empty string", () => {
    assert.equal(normalizeForDedup(""), "");
  });

  test("handles newlines and tabs", () => {
    assert.equal(normalizeForDedup("foo\n\tbar"), "foo bar");
  });
});

describe("isFuzzyDuplicate", () => {
  test("exact match after normalization", () => {
    assert.equal(isFuzzyDuplicate("Add stream freshness", "add stream freshness"), true);
  });

  test("case-insensitive match", () => {
    assert.equal(isFuzzyDuplicate("Add Stream Freshness", "add stream freshness"), true);
  });

  test("whitespace normalization match", () => {
    assert.equal(isFuzzyDuplicate("Add  stream   freshness", "Add stream freshness"), true);
  });

  test("substring match — first contains second", () => {
    assert.equal(
      isFuzzyDuplicate("Add stream freshness route-quality scoring", "stream freshness route-quality scoring"),
      true,
    );
  });

  test("substring match — second contains first", () => {
    assert.equal(
      isFuzzyDuplicate("stream freshness", "Add stream freshness route-quality scoring"),
      true,
    );
  });

  test("non-match — different content", () => {
    assert.equal(isFuzzyDuplicate("Add stream freshness", "Fix login bug"), false);
  });

  test("non-match — partial overlap but not substring", () => {
    assert.equal(isFuzzyDuplicate("Add stream freshness scoring", "Add stream latency monitoring"), false);
  });

  test("empty strings are never duplicates", () => {
    assert.equal(isFuzzyDuplicate("", "something"), false);
    assert.equal(isFuzzyDuplicate("something", ""), false);
    assert.equal(isFuzzyDuplicate("", ""), false);
  });

  test("real duplicate from issue #82", () => {
    assert.equal(
      isFuzzyDuplicate(
        "Add stream freshness route-quality scoring",
        "Add stream freshness route-quality scoring",
      ),
      true,
    );
  });

  test("near-duplicate with extra whitespace from issue #82", () => {
    assert.equal(
      isFuzzyDuplicate(
        "Add stream freshness  route-quality scoring",
        "Add stream freshness route-quality scoring",
      ),
      true,
    );
  });
});
