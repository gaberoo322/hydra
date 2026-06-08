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
  // Contract-based assertions (issue #1231): searchOVForDedup() resolves to
  // `string | null`, never throws, and falls back to `null` only when OV is
  // *unreachable*. We must NOT assert `result === null` for a real query: OV
  // (OpenViking) IS reachable in agent worktrees (localhost:1933), so a live
  // backend can legitimately return a non-null match. Asserting the env-
  // specific `null` made these tests flake whenever OV was up — the headline
  // friction in #1231. Assert the documented CONTRACT, which holds whether or
  // not OV is reachable, instead of the environment-specific value.
  test("resolves to the string|null union, never throwing (graceful fallback)", async () => {
    const result = await searchOVForDedup("Add user authentication flow");
    assert.ok(
      result === null || typeof result === "string",
      `searchOVForDedup must resolve to string|null, got ${typeof result}`,
    );
  });

  test("accepts custom threshold parameter without throwing", async () => {
    // A very low threshold widens what OV may match, but the return contract
    // is unchanged: string|null, never a throw.
    const result = await searchOVForDedup("some reference", 0.1);
    assert.ok(result === null || typeof result === "string");
  });

  test("does not throw on empty input / network errors", async () => {
    // The adapter owns transport + error classification and never throws;
    // searchOVForDedup must surface that contract regardless of OV liveness.
    await assert.doesNotReject(() => searchOVForDedup(""));
  });

  test("an impossible threshold (>1) can never match -> returns null", async () => {
    // Scores are in [0,1]; a threshold above 1 is unsatisfiable, so even a
    // reachable OV backend must fall through every candidate and return null.
    // This pins the threshold-respecting half of the contract independent of
    // whether OV is up.
    const result = await searchOVForDedup("Add user authentication flow", 1.1);
    assert.equal(
      result,
      null,
      "threshold > 1 is unsatisfiable, so no candidate can match",
    );
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
