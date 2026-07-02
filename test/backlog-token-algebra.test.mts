/**
 * Regression tests for the pure merged-ref token algebra leaf (issue #2677).
 *
 * `src/backlog/token-algebra.ts` is the zero-I/O leaf extracted from
 * `src/backlog/merged-refs.ts`. It holds ONLY pure functions (string/plain-object
 * in, string/number/boolean out) with no `execFileViaSeam` / `getTargetGithubRepo`
 * import. This suite imports the symbols DIRECTLY from the new leaf (not through
 * the `merged-refs.ts` re-export) so it pins the extraction: a caller can consume
 * the algebra without dragging the gh-scan I/O machinery into scope at
 * module-load time.
 *
 * The back-compat re-export path (`merged-refs.ts`) is separately exercised by
 * `test/backlog-merged-refs.test.mts`, which still imports every pure symbol from
 * `../src/backlog/merged-refs.ts` and passes unchanged.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeIdentity,
  mergedTokensFromPr,
  candidateMergedTokens,
  isMergedWork,
  mergedTokensFromGhJson,
  titleSimilarity,
  subjectCoverageScore,
  subjectCoveredBy,
  SUBJECT_MATCH_THRESHOLD,
  SUBJECT_MATCH_MIN_WORDS,
} from "../src/backlog/token-algebra.ts";

describe("token-algebra pure leaf — normalized identity tokens (#2677)", () => {
  test("normalizeIdentity lowercases, collapses whitespace, trims", () => {
    assert.equal(normalizeIdentity("  Foo   BAR  "), "foo bar");
    assert.equal(normalizeIdentity(undefined as any), "");
  });

  test("mergedTokensFromPr harvests #NNN, item-NNN, and the normalized title", () => {
    const toks = mergedTokensFromPr(
      "feat: extract token algebra (#2677)",
      "Closes #2677\n\nImplements item-2677 leaf split.",
    );
    assert.ok(toks.includes("2677"));
    assert.ok(toks.includes("item-2677"));
    assert.ok(toks.includes("feat: extract token algebra (#2677)"));
  });

  test("candidateMergedTokens emits the bare issue number + normalized title", () => {
    const toks = candidateMergedTokens({
      issue: 2677,
      title: "Some anchor",
      anchorRef: "Some anchor",
    });
    assert.ok(toks.includes("2677"));
    assert.ok(toks.includes("some anchor"));
  });

  test("candidateMergedTokens extracts item-NNN from a target work-queue ref", () => {
    const toks = candidateMergedTokens({
      issue: "item-322",
      title: "item-322 maker order placement",
      anchorRef: "item-322 maker order placement",
    });
    assert.ok(toks.includes("item-322"));
  });

  test("isMergedWork intersects candidate tokens with the merged set; empty set never suppresses", () => {
    const merged = new Set(["2677", "item-322"]);
    assert.equal(
      isMergedWork({ issue: 2677, title: "x", anchorRef: "x" }, merged),
      true,
    );
    assert.equal(
      isMergedWork({ issue: 999, title: "unrelated", anchorRef: "unrelated" }, merged),
      false,
    );
    assert.equal(
      isMergedWork({ issue: 2677, title: "x", anchorRef: "x" }, new Set()),
      false,
    );
  });

  test("mergedTokensFromGhJson parses a gh payload and never throws on malformed input", () => {
    const good = JSON.stringify([
      { title: "feat (#100)", body: "Closes #100" },
      { title: "fix item-7", body: "" },
    ]);
    const toks = mergedTokensFromGhJson(good);
    assert.ok(toks.includes("100"));
    assert.ok(toks.includes("item-7"));
    // Never-throws contract: malformed / non-array / empty → [].
    assert.deepEqual(mergedTokensFromGhJson("{ not json"), []);
    assert.deepEqual(mergedTokensFromGhJson("{}"), []);
    assert.deepEqual(mergedTokensFromGhJson(""), []);
  });
});

describe("token-algebra pure leaf — subject fuzzy-match (#2677 / #2110)", () => {
  test("titleSimilarity is symmetric and guards on <4 significant words", () => {
    assert.equal(titleSimilarity("cat dog", "cat dog"), 0); // too few significant words
    const s = titleSimilarity(
      "extract token algebra leaf module",
      "extract token algebra leaf module",
    );
    assert.equal(s, 1);
  });

  test("subjectCoverageScore is asymmetric containment (item words / |itemWords|)", () => {
    // All four significant item words appear in a much larger blob → 1.00.
    const score = subjectCoverageScore(
      "extract token algebra leaf",
      "refactor(backlog): extract the pure token algebra into a new leaf module with much surrounding body text",
    );
    assert.equal(score, 1);
  });

  test("subjectCoverageScore returns 0 below the minimum significant-word floor", () => {
    assert.equal(SUBJECT_MATCH_MIN_WORDS, 4);
    assert.equal(subjectCoverageScore("fix tests now", "anything at all here"), 0);
    assert.equal(subjectCoverageScore(123 as any, "blob"), 0);
  });

  test("subjectCoveredBy gates on SUBJECT_MATCH_THRESHOLD", () => {
    assert.equal(SUBJECT_MATCH_THRESHOLD, 0.7);
    assert.equal(
      subjectCoveredBy(
        "extract token algebra leaf",
        "extract the token algebra into a leaf module",
      ),
      true,
    );
    assert.equal(
      subjectCoveredBy(
        "extract token algebra leaf",
        "completely unrelated betting arbitrage execution pipeline",
      ),
      false,
    );
  });
});
