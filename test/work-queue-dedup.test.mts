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
import { normalizeForDedup, isFuzzyDuplicate, isTerminalMarker } from "../src/redis/work-queue.ts";

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

// ---------------------------------------------------------------------------
// Terminal-state marker predicate (issue #1853).
//
// `hydra queue add "COMPLETED: <ref>"` used to RPUSH the marker into the same
// candidate work-queue, where it resurfaced as a guaranteed no-op candidate.
// `isTerminalMarker` is the shared predicate the write seam (pushToWorkQueue),
// the startup GC (cleanWorkQueue), and the candidate reader use to refuse / skip
// these completion notes.
// ---------------------------------------------------------------------------

describe("isTerminalMarker", () => {
  test("matches a COMPLETED: prefix", () => {
    assert.equal(isTerminalMarker("COMPLETED: issue-1700 shipped"), true);
  });

  test("matches a CLOSED: prefix", () => {
    assert.equal(isTerminalMarker("CLOSED: item-99"), true);
  });

  test("case-insensitive", () => {
    assert.equal(isTerminalMarker("completed: foo"), true);
    assert.equal(isTerminalMarker("Closed: bar"), true);
  });

  test("tolerates leading whitespace", () => {
    assert.equal(isTerminalMarker("  COMPLETED: foo"), true);
  });

  test("does not match a reference that merely contains the word", () => {
    assert.equal(isTerminalMarker("Add a completed-work dashboard"), false);
    assert.equal(isTerminalMarker("issue-12 COMPLETED somewhere mid-string"), false);
  });

  test("non-string / empty inputs are not markers", () => {
    assert.equal(isTerminalMarker(""), false);
    assert.equal(isTerminalMarker(undefined), false);
    assert.equal(isTerminalMarker(null), false);
    assert.equal(isTerminalMarker(42), false);
  });
});
