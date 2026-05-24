/**
 * Regression tests for semantic dedup via OpenViking embeddings.
 *
 * Bug: Work queue dedup used fuzzy word-overlap only, missing semantic
 * duplicates (same work, different words). Issue #174 adds OV embedding
 * search as a second-pass check after fuzzy dedup.
 *
 * Tests the pure dedup functions (searchOVForDedup, SEMANTIC_DEDUP_THRESHOLD)
 * and the indexWorkItem contract.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SEMANTIC_DEDUP_THRESHOLD,
  searchOVForDedup,
  indexWorkItem,
  isFuzzyDuplicate,
} from "../src/redis/work-queue.ts";

describe("SEMANTIC_DEDUP_THRESHOLD", () => {
  test("default threshold is 0.85", () => {
    // Unless overridden by env var, should be 0.85
    assert.equal(SEMANTIC_DEDUP_THRESHOLD, 0.85);
  });

  test("threshold is a number between 0 and 1", () => {
    assert.equal(typeof SEMANTIC_DEDUP_THRESHOLD, "number");
    assert.ok(SEMANTIC_DEDUP_THRESHOLD > 0, "threshold should be positive");
    assert.ok(SEMANTIC_DEDUP_THRESHOLD <= 1, "threshold should be at most 1");
  });
});

describe("searchOVForDedup", () => {
  test("returns null when OV is unavailable (graceful fallback)", async () => {
    // In test environment OV is not running -- should fall back gracefully
    const result = await searchOVForDedup("Add user authentication flow");
    assert.equal(result, null, "should return null when OV is unavailable");
  });

  test("accepts custom threshold parameter", async () => {
    // Even with a very low threshold, unavailable OV returns null
    const result = await searchOVForDedup("some reference", 0.1);
    assert.equal(result, null);
  });

  test("does not throw on network errors", async () => {
    // Should not throw, just return null
    const result = await searchOVForDedup("");
    assert.equal(result, null);
  });
});

describe("indexWorkItem", () => {
  test("does not throw when OV is unavailable", async () => {
    // indexWorkItem is fire-and-forget -- should never throw
    await assert.doesNotReject(
      () => indexWorkItem("Test work item reference", "test"),
    );
  });

  test("accepts source parameter", async () => {
    // Should handle different source types without throwing
    await assert.doesNotReject(
      () => indexWorkItem("Another test reference", "merged"),
    );
  });
});

describe("semantic dedup integration (pure logic)", () => {
  test("fuzzy dedup still catches exact duplicates", () => {
    assert.equal(
      isFuzzyDuplicate("Add user authentication", "add user authentication"),
      true,
    );
  });

  test("fuzzy dedup misses semantic duplicates (motivating case for issue #174)", () => {
    // This is the case that OV is meant to catch -- same intent, different words.
    // Fuzzy dedup won't match these because neither is a substring of the other.
    assert.equal(
      isFuzzyDuplicate(
        "Add user authentication flow",
        "Implement login and signup system",
      ),
      false,
      "fuzzy dedup should NOT catch semantic duplicates -- that is OV's job",
    );
  });
});
