/**
 * Tests for the merge-commit / PR-label parser leaf (issue #3100).
 *
 * These pure parsers were extracted from `src/aggregators/recent-merges.ts`
 * into a zero-IO leaf. The whole point of the extraction is that this test
 * file imports ONLY the leaf — it loads no subprocess machinery, no `gh` CLI
 * seam, no taxonomy Module — so a `tierFromLabels` assertion is a straight
 * three-line pure-function check. The integration suite
 * (`aggregator-recent-merges.test.mts`) still exercises the IO orchestration
 * and re-verifies the re-export paths from `recent-merges.ts`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  GIT_LOG_FIELD_SEP,
  extractMergeCommitsFromGitLog,
  extractPrNumbersFromGitLog,
  prNumberFromSubject,
  prMetaFromView,
  tierFromLabels,
} from "../src/aggregators/merge-commit-parser.ts";

// ---------------------------------------------------------------------------
// extractMergeCommitsFromGitLog
// ---------------------------------------------------------------------------

describe("extractMergeCommitsFromGitLog — pure parser", () => {
  test("returns [] on empty input", () => {
    assert.deepEqual(extractMergeCommitsFromGitLog("", 10), []);
  });

  test("parses %cI|%s lines into {prNumber, mergedAt} pairs", () => {
    const stdout = [
      "2026-06-19T10:00:00+00:00|feat(scheduler): add knob (#622)",
      "2026-06-18T09:30:00+00:00|refactor(cost): consolidate (#611)",
      "2026-06-17T00:00:00+00:00|operator: stuff with no PR",
      "2026-06-16T08:00:00+00:00|Merge pull request #599 from x/y",
    ].join("\n");
    assert.deepEqual(extractMergeCommitsFromGitLog(stdout, 10), [
      { prNumber: 622, mergedAt: "2026-06-19T10:00:00+00:00" },
      { prNumber: 611, mergedAt: "2026-06-18T09:30:00+00:00" },
      { prNumber: 599, mergedAt: "2026-06-16T08:00:00+00:00" },
    ]);
  });

  test("tolerates subject-only lines (no date field) → empty mergedAt", () => {
    const stdout = ["feat: a (#100)", "fix: b (#101)"].join("\n");
    assert.deepEqual(extractMergeCommitsFromGitLog(stdout, 10), [
      { prNumber: 100, mergedAt: "" },
      { prNumber: 101, mergedAt: "" },
    ]);
  });

  test("keeps a subject that itself contains a pipe intact (no leading date)", () => {
    // The leading field only counts as a date when it parses as one; a subject
    // with an embedded pipe and no leading date field stays whole.
    const stdout = ["feat: a | b refactor (#100)"].join("\n");
    assert.deepEqual(extractMergeCommitsFromGitLog(stdout, 10), [
      { prNumber: 100, mergedAt: "" },
    ]);
  });

  test("splits on the first separator so a dated subject with a pipe survives", () => {
    const stdout = ["2026-06-19T10:00:00+00:00|feat: a | b (#100)"].join("\n");
    assert.deepEqual(extractMergeCommitsFromGitLog(stdout, 10), [
      { prNumber: 100, mergedAt: "2026-06-19T10:00:00+00:00" },
    ]);
  });

  test("skips a non-date leading field even when it precedes a separator", () => {
    // "not-a-date" fails Date.parse, so the whole raw line is the subject.
    const stdout = ["not-a-date|feat: x (#123)"].join("\n");
    assert.deepEqual(extractMergeCommitsFromGitLog(stdout, 10), [
      { prNumber: 123, mergedAt: "" },
    ]);
  });

  test("dedupes repeated PR numbers (revert of a revert)", () => {
    const stdout = [
      "2026-06-19T10:00:00+00:00|feat: x (#10)",
      "2026-06-19T09:00:00+00:00|Revert (#10)",
      "2026-06-19T08:00:00+00:00|feat: y (#11)",
    ].join("\n");
    assert.deepEqual(
      extractMergeCommitsFromGitLog(stdout, 10).map((c) => c.prNumber),
      [10, 11],
    );
  });

  test("respects the limit and returns newest-first", () => {
    const stdout = ["a (#1)", "b (#2)", "c (#3)", "d (#4)"].join("\n");
    assert.deepEqual(
      extractMergeCommitsFromGitLog(stdout, 2).map((c) => c.prNumber),
      [1, 2],
    );
  });

  test("skips blank lines and lines with no PR-number suffix", () => {
    const stdout = ["", "   ", "operator: no pr here", "feat: has one (#7)"].join("\n");
    assert.deepEqual(extractMergeCommitsFromGitLog(stdout, 10), [
      { prNumber: 7, mergedAt: "" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// extractPrNumbersFromGitLog (back-compat number-only wrapper)
// ---------------------------------------------------------------------------

describe("extractPrNumbersFromGitLog — pure parser", () => {
  test("returns [] on empty input", () => {
    assert.deepEqual(extractPrNumbersFromGitLog("", 10), []);
  });

  test("pulls (#NNN) suffixes and Merge-pull-request prefixes", () => {
    const stdout = [
      "feat(scheduler): add knob (#622)",
      "refactor(cost): consolidate (#611)",
      "operator: stuff with no PR",
      "Merge pull request #599 from x/y",
    ].join("\n");
    assert.deepEqual(extractPrNumbersFromGitLog(stdout, 10), [622, 611, 599]);
  });

  test("dedupes and respects the limit", () => {
    const stdout = ["(#1)", "(#1)", "(#2)", "(#3)"].join("\n");
    assert.deepEqual(extractPrNumbersFromGitLog(stdout, 2), [1, 2]);
  });
});

// ---------------------------------------------------------------------------
// prNumberFromSubject
// ---------------------------------------------------------------------------

describe("prNumberFromSubject — pure parser", () => {
  test("pulls the trailing (#NNN) squash-merge suffix", () => {
    assert.equal(prNumberFromSubject("feat: foo (#123)"), 123);
  });

  test("pulls the classic Merge-pull-request prefix", () => {
    assert.equal(prNumberFromSubject("Merge pull request #456 from owner/branch"), 456);
  });

  test("returns null for a subject with no PR reference", () => {
    assert.equal(prNumberFromSubject("operator: direct commit"), null);
  });

  test("returns null for empty / whitespace-only input", () => {
    assert.equal(prNumberFromSubject(""), null);
    assert.equal(prNumberFromSubject("   "), null);
  });

  test("prefers the trailing suffix; a mid-subject #N is not matched", () => {
    // Only the trailing `(#N)` or a leading `Merge pull request #N` count —
    // a bare `#N` embedded mid-subject is deliberately ignored.
    assert.equal(prNumberFromSubject("fixes #99 in passing"), null);
  });

  test("rejects a zero / non-positive PR number", () => {
    assert.equal(prNumberFromSubject("weird (#0)"), null);
  });
});

// ---------------------------------------------------------------------------
// prMetaFromView
// ---------------------------------------------------------------------------

describe("prMetaFromView — pure mapper", () => {
  test("maps a typical viewPr object and flattens labels", () => {
    const meta = prMetaFromView({
      title: "feat: thing",
      labels: [{ name: "tier:1" }, { name: "dev_orch" }],
      mergedAt: "2026-05-26T00:00:00Z",
      url: "https://example/pr/1",
    });
    assert.equal(meta.title, "feat: thing");
    assert.equal(meta.url, "https://example/pr/1");
    assert.equal(meta.mergedAt, "2026-05-26T00:00:00Z");
    assert.deepEqual(meta.labels, ["tier:1", "dev_orch"]);
  });

  test("defaults missing string fields to '' and absent labels to []", () => {
    const meta = prMetaFromView({});
    assert.equal(meta.title, "");
    assert.equal(meta.url, "");
    assert.equal(meta.mergedAt, "");
    assert.deepEqual(meta.labels, []);
  });

  test("drops non-string label names defensively", () => {
    const meta = prMetaFromView({
      labels: [{ name: "keep" }, { name: 42 as unknown as string }, {}],
    });
    assert.deepEqual(meta.labels, ["keep"]);
  });

  test("ignores non-string title/url/mergedAt", () => {
    const meta = prMetaFromView({
      title: 5 as unknown as string,
      url: null as unknown as string,
      mergedAt: {} as unknown as string,
    });
    assert.equal(meta.title, "");
    assert.equal(meta.url, "");
    assert.equal(meta.mergedAt, "");
  });
});

// ---------------------------------------------------------------------------
// tierFromLabels
// ---------------------------------------------------------------------------

describe("tierFromLabels — pure parser", () => {
  test("returns null when no tier label exists", () => {
    assert.equal(tierFromLabels(["cleanup-scan", "needs-qa"]), null);
  });

  test("parses tier:N case-insensitively", () => {
    assert.equal(tierFromLabels(["tier:2"]), 2);
    assert.equal(tierFromLabels(["TIER:0"]), 0);
  });

  test("accepts the tier-N and tier N variants", () => {
    assert.equal(tierFromLabels(["tier-3"]), 3);
    assert.equal(tierFromLabels(["tier 4"]), 4);
  });

  test("ignores a tier label with a non-numeric N", () => {
    assert.equal(tierFromLabels(["tier:unknown"]), null);
  });

  test("returns the first matching tier label", () => {
    assert.equal(tierFromLabels(["needs-qa", "tier:1", "tier:3"]), 1);
  });

  test("returns null on an empty label array", () => {
    assert.equal(tierFromLabels([]), null);
  });
});

// ---------------------------------------------------------------------------
// GIT_LOG_FIELD_SEP contract
// ---------------------------------------------------------------------------

describe("GIT_LOG_FIELD_SEP", () => {
  test("is the pipe literal the git-log pretty format and parser share", () => {
    assert.equal(GIT_LOG_FIELD_SEP, "|");
  });
});
