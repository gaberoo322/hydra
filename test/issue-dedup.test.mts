/**
 * Regression tests for the shared issue-dedup baseline used by
 * `hydra-research`, `hydra-discover`, and `hydra-architecture-scan` to decide
 * whether a candidate finding duplicates an already-tracked issue (issue
 * #2554).
 *
 * The rule itself is documented in `docs/operator-playbooks/hydra-research.md`
 * and `docs/operator-playbooks/hydra-discover.md` (Dedup sections) and
 * implemented in `scripts/ci/issue-dedup.ts`. Before this helper, each
 * playbook eyeballed ">50% title overlap" independently, so two skills firing
 * in the same window could disagree at the margin and double-file the same
 * finding. These tests pin the deterministic judgement both skills now share:
 *
 *   1. Near-identical titles (different action verb) → duplicate
 *   2. Unrelated titles → not duplicate
 *   3. The >50% boundary is STRICTLY greater-than (matches the ">50%" prose)
 *   4. Stop words / imperative prefixes don't inflate or deflate overlap
 *   5. Empty / all-stop-word titles never auto-duplicate
 *   6. partitionCandidates splits kept vs skipped against one baseline
 *   7. The best (highest-overlap) baseline match is the one reported
 *
 * The helper is pure — no fs/network/process — so these tests run in
 * milliseconds with zero setup and need no `after()` teardown (cf. the
 * leaked-Redis-handle lesson the epic-shape-classifier test cites).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isDuplicateIssue,
  partitionCandidates,
  titleOverlap,
  normaliseTitle,
  DEFAULT_OVERLAP_THRESHOLD,
} from "../scripts/ci/issue-dedup.ts";

describe("issue-dedup: titleOverlap / normaliseTitle", () => {
  test("normalisation strips punctuation, case, stop words and imperative prefixes", () => {
    const tokens = normaliseTitle("Fix the empty-cycle rate!");
    // "fix" and "the" are dropped; "empty", "cycle", "rate" survive.
    assert.deepEqual([...tokens].sort(), ["cycle", "empty", "rate"]);
  });

  test("two phrasings of the same finding overlap above the threshold", () => {
    // "Fix the empty-cycle rate" → {empty, cycle, rate}
    // "Reduce empty cycle rate"  → {empty, cycle, rate}
    // identical token sets → overlap 1.0
    const overlap = titleOverlap(
      "Fix the empty-cycle rate",
      "Reduce empty cycle rate",
    );
    assert.equal(overlap, 1);
  });

  test("unrelated titles overlap below the threshold", () => {
    const overlap = titleOverlap(
      "Reduce empty cycle rate",
      "Migrate redis adapter to typed accessors",
    );
    assert.ok(
      overlap <= DEFAULT_OVERLAP_THRESHOLD,
      `expected low overlap, got ${overlap}`,
    );
  });

  test("empty / all-stop-word titles overlap 0", () => {
    assert.equal(titleOverlap("", "anything at all"), 0);
    assert.equal(titleOverlap("fix the", "add the"), 0);
  });
});

describe("issue-dedup: isDuplicateIssue", () => {
  const baseline = [
    "Reduce the empty cycle rate in anchor selection",
    "Migrate redis adapter to typed accessors",
    "Document the autopilot dispatch contract",
  ];

  test("a re-phrasing of an existing issue is a duplicate", () => {
    const verdict = isDuplicateIssue(
      "Cut empty cycle rate in anchor selection",
      baseline,
    );
    assert.equal(verdict.duplicate, true);
    assert.equal(
      verdict.matchedTitle,
      "Reduce the empty cycle rate in anchor selection",
    );
    assert.ok(verdict.overlap > DEFAULT_OVERLAP_THRESHOLD);
  });

  test("a genuinely new finding is not a duplicate", () => {
    const verdict = isDuplicateIssue(
      "Add mutation testing to the verification pipeline",
      baseline,
    );
    assert.equal(verdict.duplicate, false);
    assert.equal(verdict.matchedTitle, undefined);
  });

  test("the >50% boundary is strictly greater-than", () => {
    // candidate {alpha, beta} vs existing {alpha, beta, gamma, delta}
    // intersection 2, union 4 → overlap exactly 0.5 → NOT a duplicate (>0.5)
    const verdict = isDuplicateIssue("alpha beta", ["alpha beta gamma delta"]);
    assert.equal(verdict.overlap, 0.5);
    assert.equal(verdict.duplicate, false);

    // one more shared word tips it over 0.5 → duplicate
    const over = isDuplicateIssue("alpha beta gamma", [
      "alpha beta gamma delta",
    ]);
    assert.ok(over.overlap > 0.5);
    assert.equal(over.duplicate, true);
  });

  test("empty baseline yields no duplicate", () => {
    const verdict = isDuplicateIssue("anything", []);
    assert.equal(verdict.duplicate, false);
    assert.equal(verdict.overlap, 0);
  });

  test("the highest-overlap baseline title is the one reported", () => {
    const verdict = isDuplicateIssue("empty cycle rate anchor selection", [
      "empty cycle rate", // partial overlap
      "Reduce the empty cycle rate in anchor selection", // higher overlap
    ]);
    assert.equal(verdict.duplicate, true);
    assert.equal(
      verdict.matchedTitle,
      "Reduce the empty cycle rate in anchor selection",
    );
  });
});

describe("issue-dedup: partitionCandidates", () => {
  test("splits candidates into kept (new) and skipped (duplicate)", () => {
    const baseline = ["Reduce the empty cycle rate in anchor selection"];
    const candidates = [
      "Cut empty cycle rate in anchor selection", // duplicate
      "Add mutation testing to verification pipeline", // new
    ];
    const { kept, skipped } = partitionCandidates(candidates, baseline);
    assert.deepEqual(kept, ["Add mutation testing to verification pipeline"]);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].title, "Cut empty cycle rate in anchor selection");
    assert.equal(
      skipped[0].matchedTitle,
      "Reduce the empty cycle rate in anchor selection",
    );
    assert.ok(skipped[0].overlap > DEFAULT_OVERLAP_THRESHOLD);
  });

  test("a candidate that duplicates an earlier sibling is also caught when seeded into the baseline", () => {
    // Cross-skill double-file guard: research files A, then discover (with A
    // now in its baseline) must skip a re-phrasing of A.
    const baseline = ["Reduce empty cycle rate"];
    const { kept } = partitionCandidates(["Cut the empty cycle rate"], baseline);
    assert.deepEqual(kept, []);
  });
});
