/**
 * Regression suite for the anchor-reference normalizer (originally issue #192).
 *
 * Background: cacheKey() in plan-cache.ts hashed
 * `${type}:${reference.toLowerCase().trim()}`. Planner-generated references
 * vary between cycles (parenthetical metrics, word order, surrounding
 * wording) so semantically-equivalent anchors produced different keys and
 * cache hits were impossible. Verified 2026-05-09: 84 stored, 0 hits.
 *
 * Fix: normalize references before hashing.
 *  - codebase-health: parse "<category> in <file>", drop parenthetical metric.
 *  - other types: tokenize, drop stopwords + parentheticals, sort tokens.
 *
 * The normalizer migrated to src/normalize-reference.ts (ADR-0016) when the
 * anchor-selection family was retired; plan-cache.ts is its sole surviving
 * consumer. This file owns the contract.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeReference } from "../src/normalize-reference.ts";

describe("normalizeReference (issue #192)", () => {
  test("codebase-health: parses category+file, drops parenthetical metric", () => {
    const a = normalizeReference(
      "codebase-health",
      "codebase-health: tests in src/foo.ts (0 tests)",
    );
    const b = normalizeReference(
      "codebase-health",
      "codebase-health: tests in src/foo.ts (3 tests)",
    );
    const c = normalizeReference(
      "codebase-health",
      "codebase-health: tests in src/foo.ts",
    );
    assert.equal(a, b, "differing parenthetical metrics must normalize equal");
    assert.equal(a, c, "presence/absence of parenthetical must normalize equal");
    assert.match(a, /health\|tests\|src\/foo\.ts/);
  });

  test("codebase-health: different file → different normalized key", () => {
    const a = normalizeReference(
      "codebase-health",
      "codebase-health: tests in src/foo.ts",
    );
    const b = normalizeReference(
      "codebase-health",
      "codebase-health: tests in src/bar.ts",
    );
    assert.notEqual(a, b);
  });

  test("codebase-health: different category (split vs tests) → different key", () => {
    const a = normalizeReference(
      "codebase-health",
      "codebase-health: split in src/foo.ts",
    );
    const b = normalizeReference(
      "codebase-health",
      "codebase-health: tests in src/foo.ts",
    );
    assert.notEqual(a, b, "different health categories must NOT collide");
  });

  test("user-request: parenthetical clause is stripped", () => {
    const a = normalizeReference(
      "user-request",
      "Add tests for reconciliation-replay-snapshots (DB-backed fallback, 0 tests)",
    );
    const b = normalizeReference(
      "user-request",
      "Add tests for reconciliation-replay-snapshots",
    );
    assert.equal(a, b);
  });

  test("user-request: stopwords + word-order variation collide", () => {
    const a = normalizeReference(
      "user-request",
      "Fix the broken planner cache lookup",
    );
    const b = normalizeReference(
      "user-request",
      "broken planner cache lookup fix",
    );
    assert.equal(a, b, "stopwords removed and tokens sorted should yield equality");
  });

  test("non-deterministic refs with different scope still differ", () => {
    // Different files mentioned -> must NOT collide.
    const a = normalizeReference(
      "user-request",
      "Add tests for src/foo.ts",
    );
    const b = normalizeReference(
      "user-request",
      "Add tests for src/bar.ts",
    );
    assert.notEqual(a, b);
  });

  test("malformed codebase-health falls back to generic normalization", () => {
    // Doesn't match the "<category> in <file>" pattern — generic path.
    const out = normalizeReference(
      "codebase-health",
      "investigate flaky cycles",
    );
    // Should still be deterministic and non-empty.
    assert.ok(out.length > 0);
    assert.equal(
      out,
      normalizeReference("codebase-health", "investigate flaky cycles"),
    );
  });

  test("punctuation differences do not affect the normalized key", () => {
    const a = normalizeReference("user-request", "Fix the cache, please!");
    const b = normalizeReference("user-request", "Fix  the   cache please");
    assert.equal(a, b);
  });
});
