/**
 * test/design-concept-reconcile-check.test.mts — the design-concept
 * reconciliation gate (issue #2528).
 *
 * TWO top-level suites, each with its own lifecycle and NO shared Redis
 * connection (so neither can be torn down by a sibling suite's `after()`):
 *
 *  1. "design-concept reconcile check (pure)" — unit tests over the pure
 *     decision core in `scripts/ci/design-concept-reconcile-check.ts`.
 *
 *  2. "design-concept reconciliation gate (CI adapter)" — the ENFORCEMENT
 *     itself. This is the whole point of the ticket: it runs inside the
 *     REQUIRED `test` job (`npm test` in ci.yml), which IS a
 *     branch-protection required check, so a violation actually blocks
 *     auto-merge. A new advisory `.github/workflows/*.yml` could not — see the
 *     module header and `test/protected-paths-guard.test.mts` for the
 *     empirical precedent (PR #3033 auto-merged with `protected-paths` RED).
 *
 * The adapter FAILS OPEN on every transport/context miss (no
 * GITHUB_EVENT_PATH, no `pull_request` in the payload, no `Closes #N`,
 * artifact 404, orchestrator unreachable). It must never redden on
 * orchestrator downtime — that is the npm-audit ambient-poison-pill class
 * (#3650) that wedges the whole merge queue with zero code change.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import {
  RECONCILIATION_HEADING,
  MIN_QUOTE_CHARS,
  checkReconciliation,
  countOccurrences,
  evaluateAssertion,
  extractAnchorRefFromPrBody,
  extractAssertionText,
  extractQuotedText,
  extractReconciliationSection,
  findCorrectHashMention,
  formatViolations,
  hashesMatch,
  isMachineCheckable,
  isMustNotInvariant,
  isSafeRepoRelativePath,
  normaliseInvariantText,
  parseAssertion,
  declaresSubtest,
  parseReconciliationSection,
  quoteMatchesInvariant,
  resolveEnforceDecision,
  stripCommentsAndDocstrings,
  type ArtifactEnforceDecision,
  type FileReader,
  type Violation,
} from "../scripts/ci/design-concept-reconcile-check.ts";


/** In-memory reader for the unit suite. */
function fakeReader(files: Record<string, string>): FileReader {
  return (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null);
}


// ---------------------------------------------------------------------------
// Suite 1 — pure decision core
// ---------------------------------------------------------------------------

describe("design-concept reconcile check (pure)", () => {
  test("extractAnchorRefFromPrBody finds Closes/Fixes/Resolves, else null", () => {
    assert.equal(extractAnchorRefFromPrBody("blah\n\nCloses #2528"), 2528);
    assert.equal(extractAnchorRefFromPrBody("fixes #7"), 7);
    assert.equal(extractAnchorRefFromPrBody("Resolves  #123 and more"), 123);
    assert.equal(extractAnchorRefFromPrBody("mentions #99 only"), null);
    assert.equal(extractAnchorRefFromPrBody(""), null);
  });

  test("extractReconciliationSection slices to the next heading and returns null when absent", () => {
    const body = [
      "## Summary",
      "words",
      "",
      RECONCILIATION_HEADING,
      "",
      "Artifact: `abcdef1234`",
      '- INV-1: "hello world invariant" — verified by: `manual: fine`',
      "",
      "## Files in scope",
      "- scripts/ci/x.ts",
    ].join("\n");
    const section = extractReconciliationSection(body);
    assert.ok(section !== null);
    assert.ok(section!.includes("INV-1"));
    assert.ok(!section!.includes("Files in scope"));
    assert.equal(extractReconciliationSection("## Summary\nno section here"), null);
  });

  test("section heading tolerates ### and the unhyphenated spelling", () => {
    assert.ok(extractReconciliationSection("### Design concept reconciliation\n- x") !== null);
    assert.ok(extractReconciliationSection("## Design-Concept Reconciliation (13)\n- x") !== null);
  });

  test("parseReconciliationSection reads the hash and one entry per bullet", () => {
    const body = [
      RECONCILIATION_HEADING,
      "",
      "Artifact: `8C0DFE60287A`",
      '- INV-1: "first invariant text" — verified by: `file-exists: a.ts`',
      '* [x] INV-2: "second invariant text" — verified by: `manual: reasoning`',
      '3. INV-3 "third invariant text" — verified by: `file-absent: b.yml`',
    ].join("\n");
    const parsed = parseReconciliationSection(body);
    assert.equal(parsed.present, true);
    assert.equal(parsed.artifactHash, "8c0dfe60287a");
    assert.equal(parsed.entries.length, 3);
    assert.deepEqual(
      parsed.entries.map((e) => e.index),
      [1, 2, 3],
    );
    assert.equal(parsed.entries[0].quoted, "first invariant text");
    assert.equal(parsed.entries[0].assertion, "file-exists: a.ts");
    assert.equal(parsed.entries[2].assertion, "file-absent: b.yml");
  });

  test("a hash on the line BELOW the label resolves instead of parsing as null (issue #4101)", () => {
    // PR #4100's reconciliation section exactly as it stood when the required
    // `test` job reddened it: fully compliant (10/10 entries, correct live
    // hash), but the `artifact hash:` label ends its line and the backticked
    // hash wraps onto the NEXT line. The single-line finder parsed that as
    // artifactHash: null and CI's only violation was missing-artifact-hash —
    // quoting the very hash the body already contained (a #4037-class
    // benign-formatting false red on a required merge-gate check).
    const body = [
      RECONCILIATION_HEADING,
      "",
      "Artifact: `hydra:design-concept:issue-4010`, artifact hash:",
      "`967957884177d62e2d0e4a14d3e584c2fb9b567b871b2b846a3b852c9c40f316`",
      "(status: approved)",
      '- INV-1: "first invariant text goes here" — verified by: `manual: ok`',
    ].join("\n");
    const parsed = parseReconciliationSection(body);
    assert.equal(parsed.present, true);
    assert.equal(
      parsed.artifactHash,
      "967957884177d62e2d0e4a14d3e584c2fb9b567b871b2b846a3b852c9c40f316",
      "hash on the line below the label must resolve, not parse as null",
    );
    assert.equal(parsed.entries.length, 1, "entries still parse alongside the wrapped hash");
  });

  test("hash-finder matrix: same-line forms unchanged; next-line bounded to the label-adjacent line (issue #4101)", () => {
    const p = (sectionLines: string[]) =>
      parseReconciliationSection(
        [RECONCILIATION_HEADING, "", ...sectionLines, '- INV-1: "first invariant text" — verified by: `manual: ok`'].join("\n"),
      ).artifactHash;

    // Same-line forms — the pre-#4101 finder, byte-for-byte unchanged.
    assert.equal(p(["Artifact: `8C0DFE60287A`"]), "8c0dfe60287a", "label line, backticked");
    assert.equal(p(["Artifact: 8c0dfe60287a"]), "8c0dfe60287a", "label line, bare");
    assert.equal(
      p(["Artifact: `hydra:design-concept:issue-4010`, artifact hash: `8c0dfe60287a`"]),
      "8c0dfe60287a",
      "id and hash on one line",
    );
    assert.equal(
      p(["Artifact: `hydra:design-concept:issue-4010`", "Artifact hash: `8c0dfe60287a`"]),
      "8c0dfe60287a",
      "id line, then a label+hash line (the form PR #4100 settled on)",
    );

    // Next-line forms — what #4101 adds: a label line that captures no
    // same-line hash may carry its hash on the IMMEDIATELY following line.
    assert.equal(p(["Artifact:", "`8c0dfe60287a`"]), "8c0dfe60287a", "bare label, backticked hash below");
    assert.equal(p(["artifact hash:", "8c0dfe60287a"]), "8c0dfe60287a", "lowercase label, bare hash below");

    // A same-line citation anywhere in the section still WINS over an earlier
    // bare label's next line: the fix is additive to the finder's precedence,
    // never a rewrite of it (#4101 design-concept INV-3).
    assert.equal(p(["Artifact:", "deadbeefcafe", "Artifact: 8c0dfe60287a"]), "8c0dfe60287a");

    // Bounded: a hex token that is neither on a label line nor on the line
    // immediately following one stays unread — there is no unbounded
    // full-section hex scan (#4101 design-concept INV-2).
    assert.equal(p(["some prose with no label at all", "`8c0dfe60287a`"]), null, "no label line above");
    assert.equal(p(["Artifact:", "", "`8c0dfe60287a`"]), null, "a blank line breaks label adjacency");
  });

  test("ENTRY_RE tolerates Markdown emphasis wrapping the INV-<n> label (issue #4037)", () => {
    // A fully-reconciled PR body dev agents actually write, e.g.
    // `- **INV-1** — text` or `- **INV-2**: text`, parsed to ZERO entries
    // before #4037 (ENTRY_RE required INV to follow the bullet marker
    // directly), reddening the required `test` job with entry-count-mismatch
    // plus one missing-entry per invariant on an otherwise-compliant PR.
    const plain = [
      RECONCILIATION_HEADING,
      "",
      '- INV-1: "first invariant text" — verified by: `file-exists: a.ts`',
    ].join("\n");
    assert.equal(parseReconciliationSection(plain).entries.length, 1, "plain form: unchanged baseline");
    assert.equal(parseReconciliationSection(plain).entries[0].index, 1);

    const boldDash = [
      RECONCILIATION_HEADING,
      "",
      "- **INV-1** — text **verified by:** git diff",
    ].join("\n");
    const boldDashParsed = parseReconciliationSection(boldDash);
    assert.equal(boldDashParsed.entries.length, 1, "bold em-dash form must parse to one entry");
    assert.equal(boldDashParsed.entries[0].index, 1);

    const boldColon = [RECONCILIATION_HEADING, "", "- **INV-2**: something"].join("\n");
    const boldColonParsed = parseReconciliationSection(boldColon);
    assert.equal(boldColonParsed.entries.length, 1, "bold-with-colon form must parse to one entry");
    assert.equal(boldColonParsed.entries[0].index, 2);
    assert.equal(boldColonParsed.entries[0].raw, "something");

    const checkbox = [RECONCILIATION_HEADING, "", "- [x] INV-1 checkbox form text"].join("\n");
    const checkboxParsed = parseReconciliationSection(checkbox);
    assert.equal(checkboxParsed.entries.length, 1, "checkbox form must parse to one entry");
    assert.equal(checkboxParsed.entries[0].index, 1);

    const numbered = [RECONCILIATION_HEADING, "", "1. INV-1 numbered form text"].join("\n");
    const numberedParsed = parseReconciliationSection(numbered);
    assert.equal(numberedParsed.entries.length, 1, "numbered-list form must parse to one entry");
    assert.equal(numberedParsed.entries[0].index, 1);

    const italicStar = [RECONCILIATION_HEADING, "", "- *INV-2*: italic single-star text"].join("\n");
    const italicStarParsed = parseReconciliationSection(italicStar);
    assert.equal(italicStarParsed.entries.length, 1, "single-asterisk italic form must parse to one entry");
    assert.equal(italicStarParsed.entries[0].index, 2);

    // Underscore emphasis is the trap case: `_` is a regex word character, so a
    // naive `\b` boundary after the digit run refuses to fire between "3" and
    // the underscore closer, silently dropping this one form even though the
    // other emphasis markers worked.
    const underscoreBold = [RECONCILIATION_HEADING, "", "- __INV-3__ underscore bold text"].join("\n");
    const underscoreBoldParsed = parseReconciliationSection(underscoreBold);
    assert.equal(underscoreBoldParsed.entries.length, 1, "double-underscore bold form must parse to one entry");
    assert.equal(underscoreBoldParsed.entries[0].index, 3);

    // Negative case (guard against a vacuous widening): a bullet that merely
    // MENTIONS "INV-1" mid-sentence, rather than opening with it as a label
    // right after the bullet marker, must still parse to zero entries — the
    // bullet-marker anchor is what keeps the widened regex precise.
    const midSentence = [
      RECONCILIATION_HEADING,
      "",
      "- this bullet just mentions INV-1 mid sentence and is not a label",
    ].join("\n");
    assert.equal(parseReconciliationSection(midSentence).entries.length, 0, "mid-sentence mention must not match");
  });

  test("ENTRY_RE rejects an alphanumeric suffix on the digit run and an asymmetric emphasis closer (issue #4037 follow-up)", () => {
    // `(?!\d)` (the first attempt at closing the digit run) only blocks a
    // FOLLOWING DIGIT — a following LETTER slipped through, so `INV-10x` wrongly
    // parsed as `INV-10` with "x is not an invariant reference" absorbed as
    // trailing text. On a required-check merge gate this is the dangerous
    // direction: a genuinely unreconciled bullet is silently accepted.
    const letterSuffixTwoDigit = [
      RECONCILIATION_HEADING,
      "",
      "- INV-10x is not an invariant reference",
    ].join("\n");
    assert.equal(
      parseReconciliationSection(letterSuffixTwoDigit).entries.length,
      0,
      "INV-10x must not match — trailing letter is not a valid closer",
    );

    const letterSuffixOneDigit = [
      RECONCILIATION_HEADING,
      "",
      "- INV-1abc some other identifier entirely",
    ].join("\n");
    assert.equal(
      parseReconciliationSection(letterSuffixOneDigit).entries.length,
      0,
      "INV-1abc must not match — trailing letters are not a valid closer",
    );

    // The emphasis-closer forms this fix must keep working.
    const underscoreBold = [RECONCILIATION_HEADING, "", "- __INV-3__ underscore bold text"].join("\n");
    const underscoreBoldParsed = parseReconciliationSection(underscoreBold);
    assert.equal(underscoreBoldParsed.entries.length, 1, "__INV-3__ must still match");
    assert.equal(underscoreBoldParsed.entries[0].index, 3);

    const doubleStar = [RECONCILIATION_HEADING, "", "- **INV-1** some text"].join("\n");
    const doubleStarParsed = parseReconciliationSection(doubleStar);
    assert.equal(doubleStarParsed.entries.length, 1, "**INV-1** must still match");
    assert.equal(doubleStarParsed.entries[0].index, 1);

    // Multi-digit index: must be captured as 12, not truncated to 1.
    const multiDigit = [RECONCILIATION_HEADING, "", "- INV-12 some text"].join("\n");
    const multiDigitParsed = parseReconciliationSection(multiDigit);
    assert.equal(multiDigitParsed.entries.length, 1, "INV-12 must match");
    assert.equal(multiDigitParsed.entries[0].index, 12, "index must be 12, not truncated to 1");

    // Asymmetric emphasis: opened with `**`, "closed" with `_` — the two
    // markers don't match, so this must NOT be accepted as a valid entry.
    const asymmetric = [RECONCILIATION_HEADING, "", "- **INV-1_ some text"].join("\n");
    assert.equal(
      parseReconciliationSection(asymmetric).entries.length,
      0,
      "asymmetric ** ... _ emphasis must not match",
    );
  });

  test("a wrapped entry absorbs its indented continuation lines", () => {
    const body = [
      RECONCILIATION_HEADING,
      "Artifact: `abcdef1234`",
      '- INV-1: "an invariant that wraps across',
      '  two source lines" — verified by: `file-exists: a.ts`',
    ].join("\n");
    const parsed = parseReconciliationSection(body);
    assert.equal(parsed.entries.length, 1);
    assert.equal(parsed.entries[0].quoted, "an invariant that wraps across two source lines");
    assert.equal(parsed.entries[0].assertion, "file-exists: a.ts");
  });

  test("extractQuotedText ignores quotes that appear after `verified by:`", () => {
    const t = '"the real quote here" — verified by: `file-contains: a.ts :: "decoy"`';
    assert.equal(extractQuotedText(t), "the real quote here");
    assert.equal(extractAssertionText(t), 'file-contains: a.ts :: "decoy"');
    assert.equal(extractAssertionText('"q" — no assertion at all'), "");
  });

  test("extractQuotedText keeps an embedded quote inside the verbatim prefix (issue #3975)", () => {
    // The contract format is `- INV-<n>: "<quote>" — verified by: <assertion>`,
    // so the quote is the OUTERMOST quoted span in the text before `verified
    // by:`. An invariant whose verbatim prefix itself contains a `"` must encode
    // that `"` — the matcher may not stop at the first embedded quote. Both real
    // #3963 shapes are exercised: a `"` landing inside the first 16 chars, and an
    // invariant that STARTS with a `"`.
    const embedded = '"mergeable == "UNKNOWN" is treated as no-verdict" — verified by: `file-contains: a.ts :: x`';
    assert.equal(extractQuotedText(embedded), 'mergeable == "UNKNOWN" is treated as no-verdict');
    const leading = '""Required" checks means exactly the 7 contexts" — verified by: `file-contains: a.ts :: x`';
    assert.equal(extractQuotedText(leading), '"Required" checks means exactly the 7 contexts');
    // The no-embedded-quote majority is unchanged: a single "foo" still yields foo.
    assert.equal(extractQuotedText('"plain old invariant text" — verified by: `manual: ok`'), "plain old invariant text");
  });

  test("normaliseInvariantText strips an INV-n label and collapses whitespace", () => {
    assert.equal(normaliseInvariantText("INV-4  MUST NOT   modify\n  foo"), "MUST NOT modify foo");
    assert.equal(normaliseInvariantText("plain text"), "plain text");
  });

  test("quoteMatchesInvariant requires a verbatim, long-enough prefix", () => {
    const inv = "INV-1 The enforcement check MUST execute inside the REQUIRED `test` job";
    assert.equal(quoteMatchesInvariant("The enforcement check MUST execute", inv), true);
    // Matches even when the artifact keeps its INV-n label and the quote drops it.
    assert.equal(quoteMatchesInvariant("INV-1 The enforcement check MUST", inv), true);
    // Too short to be evidence of having read the invariant.
    assert.equal(quoteMatchesInvariant("The", inv), false);
    assert.ok(MIN_QUOTE_CHARS > 3);
    // Not a prefix — a paraphrase or a mid-sentence slice is rejected.
    assert.equal(quoteMatchesInvariant("MUST execute inside the REQUIRED", inv), false);
    assert.equal(quoteMatchesInvariant("", inv), false);
    // A short invariant may be quoted in full.
    assert.equal(quoteMatchesInvariant("short one", "short one"), true);
  });

  test("isMustNotInvariant catches MUST NOT / MUST-NOT / MUST NEVER only", () => {
    assert.equal(isMustNotInvariant("the route MUST NOT gain pruneX()"), true);
    assert.equal(isMustNotInvariant("MUST-not modify ci.yml"), true);
    assert.equal(isMustNotInvariant("this MUST never happen"), true);
    assert.equal(isMustNotInvariant("the check MUST run in the test job"), false);
  });

  test("hashesMatch accepts a >=8-char prefix and rejects a stale hash", () => {
    assert.equal(hashesMatch("8c0dfe60", "8c0dfe60287afcf4"), true);
    assert.equal(hashesMatch("`8C0DFE60287A`", "8c0dfe60287afcf4"), true);
    assert.equal(hashesMatch("8c0dfe6", "8c0dfe60287afcf4"), false, "too short to be unambiguous");
    assert.equal(hashesMatch("deadbeef", "8c0dfe60287afcf4"), false);
  });

  test("findCorrectHashMention fires only on a hex run the live hash starts with (issue #4101)", () => {
    // An all-hex-digit date is the false-positive shape the live-hash prefix
    // filter rules out: present, >=8 chars, but not a prefix of the live hash.
    assert.equal(findCorrectHashMention("approved on 20260814, no hash cited", "8c0dfe60287afcf4"), null);
    assert.equal(findCorrectHashMention("deadbeefcafe stale token", "8c0dfe60287afcf4"), null, "a wrong token is not a correct mention");
    assert.equal(findCorrectHashMention("hash 8c0dfe60287a ok", "8c0dfe60287afcf4f464b5e94c35e0fd"), "8c0dfe60287a");
    assert.equal(findCorrectHashMention("", "8c0dfe60287afcf4"), null);
  });

  test("isSafeRepoRelativePath rejects traversal, absolute paths and odd charsets", () => {
    assert.equal(isSafeRepoRelativePath("src/api/design-concepts.ts"), true);
    assert.equal(isSafeRepoRelativePath("/etc/passwd"), false);
    assert.equal(isSafeRepoRelativePath("../../etc/passwd"), false);
    assert.equal(isSafeRepoRelativePath("~/secrets"), false);
    assert.equal(isSafeRepoRelativePath("a\\b"), false);
    assert.equal(isSafeRepoRelativePath("src/$(whoami).ts"), false);
    assert.equal(isSafeRepoRelativePath(""), false);
  });

  test("parseAssertion covers every grammar kind", () => {
    assert.deepEqual(parseAssertion("file-exists: a/b.ts"), { kind: "file-exists", path: "a/b.ts" });
    assert.deepEqual(parseAssertion("file-absent: a/b.yml"), { kind: "file-absent", path: "a/b.yml" });
    assert.deepEqual(parseAssertion("file-contains: a.ts :: doThing("), {
      kind: "file-contains",
      path: "a.ts",
      needle: "doThing(",
    });
    assert.deepEqual(parseAssertion("file-lacks: a.ts :: pruneX("), {
      kind: "file-lacks",
      path: "a.ts",
      needle: "pruneX(",
    });
    assert.deepEqual(parseAssertion("file-matches: a.ts :: /foo.?bar/i"), {
      kind: "file-matches",
      path: "a.ts",
      source: "foo.?bar",
      flags: "i",
    });
    assert.deepEqual(parseAssertion("file-not-matches: a.ts :: /nope/"), {
      kind: "file-not-matches",
      path: "a.ts",
      source: "nope",
      flags: "",
    });
    assert.deepEqual(parseAssertion("occurrences: a.ts :: x( >= 2"), {
      kind: "occurrences",
      path: "a.ts",
      needle: "x(",
      op: ">=",
      count: 2,
    });
    assert.deepEqual(parseAssertion("manual: reviewed by hand"), {
      kind: "manual",
      note: "reviewed by hand",
    });
  });

  test("parseAssertion rejects malformed declarations with a reason", () => {
    for (const raw of [
      "",
      "just some prose",
      "file-contains: a.ts",
      "file-contains: ../etc/passwd :: x",
      "file-matches: a.ts :: not-a-regex",
      "occurrences: a.ts :: x(",
      "teleport: a.ts",
      "manual:",
    ]) {
      const a = parseAssertion(raw);
      assert.equal(a.kind, "unparseable", `expected unparseable for ${JSON.stringify(raw)}`);
      if (a.kind === "unparseable") assert.ok(a.reason.length > 0);
    }
  });

  test("isMachineCheckable is false for manual and unparseable only", () => {
    assert.equal(isMachineCheckable(parseAssertion("file-exists: a.ts")), true);
    assert.equal(isMachineCheckable(parseAssertion("manual: because")), false);
    assert.equal(isMachineCheckable(parseAssertion("garbage")), false);
  });

  test("countOccurrences counts non-overlapping literals", () => {
    assert.equal(countOccurrences("aXbXc", "X"), 2);
    assert.equal(countOccurrences("aaaa", "aa"), 2);
    assert.equal(countOccurrences("abc", "z"), 0);
    assert.equal(countOccurrences("abc", ""), 0);
  });

  test("evaluateAssertion re-executes each kind against the injected reader", () => {
    const read = fakeReader({ "a.ts": "alpha doThing( beta doThing(", "empty.ts": "" });
    const ev = (s: string) => evaluateAssertion(parseAssertion(s), read);

    assert.equal(ev("file-exists: a.ts").ok, true);
    assert.equal(ev("file-exists: gone.ts").ok, false);
    assert.equal(ev("file-absent: gone.ts").ok, true);
    assert.equal(ev("file-absent: a.ts").ok, false);
    assert.equal(ev("file-contains: a.ts :: doThing(").ok, true);
    assert.equal(ev("file-contains: a.ts :: nope").ok, false);
    assert.equal(ev("file-lacks: a.ts :: nope").ok, true);
    assert.equal(ev("file-lacks: a.ts :: doThing(").ok, false);
    assert.equal(ev("file-matches: a.ts :: /ALPHA/i").ok, true);
    assert.equal(ev("file-not-matches: a.ts :: /zeta/").ok, true);
    assert.equal(ev("occurrences: a.ts :: doThing( == 2").ok, true);
    assert.equal(ev("occurrences: a.ts :: doThing( == 3").ok, false);
    assert.equal(ev("occurrences: a.ts :: doThing( <= 5").ok, true);
    assert.equal(ev("manual: fine").ok, true);
  });

  test("file-lacks / file-not-matches FAIL on a missing file (no vacuous pass)", () => {
    const read = fakeReader({});
    const lacks = evaluateAssertion(parseAssertion("file-lacks: gone.ts :: pruneX("), read);
    assert.equal(lacks.ok, false);
    assert.match(lacks.observed, /not found/i);
    const notMatches = evaluateAssertion(parseAssertion("file-not-matches: gone.ts :: /x/"), read);
    assert.equal(notMatches.ok, false);
  });

  test("evaluateAssertion never throws on an invalid regex — it fails closed", () => {
    const read = fakeReader({ "a.ts": "x" });
    const res = evaluateAssertion({ kind: "file-matches", path: "a.ts", source: "(", flags: "" }, read);
    assert.equal(res.ok, false);
    assert.match(res.observed, /invalid regex/i);
  });

  // --- stripCommentsAndDocstrings (issue #4093) ---------------------------

  test("stripCommentsAndDocstrings leaves an unrecognised extension unchanged", () => {
    const src = "// not really stripped\nfoo";
    assert.equal(stripCommentsAndDocstrings(src, "a.json"), src);
  });

  test("stripCommentsAndDocstrings (.ts) blanks // and /* */ comments, keeps code", () => {
    const src = "const x = 1; // trailing comment mentions doThing(\n/* block\n   also mentions doThing( */\nreal doThing(";
    const out = stripCommentsAndDocstrings(src, "a.ts");
    assert.equal(countOccurrences(out, "doThing("), 1);
    assert.match(out, /real doThing\(/);
  });

  test("stripCommentsAndDocstrings (.ts) keeps string-literal contents, incl. escaped quotes", () => {
    const src = 'const s = "a quoted doThing( mention with an \\"escaped\\" quote";';
    const out = stripCommentsAndDocstrings(src, "a.ts");
    assert.equal(countOccurrences(out, "doThing("), 1);
  });

  test("stripCommentsAndDocstrings (.mts) applies the same TS rules", () => {
    const src = "// doThing(\nreal doThing(";
    assert.equal(countOccurrences(stripCommentsAndDocstrings(src, "a.mts"), "doThing("), 1);
  });

  test("stripCommentsAndDocstrings (.py) blanks # comments and every triple-quoted span", () => {
    const src = [
      "def closing_issues():",
      '    """Uses closingIssuesReferences under the hood."""',
      "    # closingIssuesReferences is also mentioned here",
      "    return _CLOSE_RE.findall(body)",
    ].join("\n");
    const out = stripCommentsAndDocstrings(src, "reap.py");
    assert.equal(countOccurrences(out, "closingIssuesReferences"), 0);
    assert.match(out, /_CLOSE_RE\.findall\(body\)/);
  });

  test("stripCommentsAndDocstrings (.py) keeps ordinary quoted-string contents", () => {
    const src = 'msg = "please call doThing( now"';
    assert.equal(countOccurrences(stripCommentsAndDocstrings(src, "x.py"), "doThing("), 1);
  });

  test("stripCommentsAndDocstrings (.sh) blanks # comments, keeps quoted contents", () => {
    const src = '# mentions doThing( here\necho "real doThing( call"';
    const out = stripCommentsAndDocstrings(src, "x.sh");
    assert.equal(countOccurrences(out, "doThing("), 1);
  });

  test("regression (PR #4090 false-green shape): occurrences: FALSE when the only match is inside a docstring", () => {
    const src = [
      "def closing_issues():",
      '    """',
      "    Uses closingIssuesReferences to compute closing intent.",
      '    """',
      "    return _CLOSE_RE.findall(body)",
    ].join("\n");
    const read = fakeReader({ "scripts/autopilot/reap.py": src });
    const res = evaluateAssertion(
      parseAssertion("occurrences: scripts/autopilot/reap.py :: closingIssuesReferences == 1"),
      read,
    );
    assert.equal(res.ok, false);
    assert.equal(res.observed, "0");
  });

  test("regression (PR #4112 false-red shape): occurrences: ... == 1 stays TRUE when a code match is joined by a comment mention", () => {
    const src = "const now = Date.now(); // per-call clock read, see Date.now( in the header comment too";
    const read = fakeReader({ "src/x.ts": src });
    const res = evaluateAssertion(parseAssertion("occurrences: src/x.ts :: Date.now( == 1"), read);
    assert.equal(res.ok, true);
    assert.equal(res.observed, "1");
  });

  test("file-contains / file-lacks also go through the comment/docstring strip", () => {
    const read = fakeReader({ "a.ts": "// mentions pruneIndex( only in a comment\nreal();" });
    assert.equal(evaluateAssertion(parseAssertion("file-contains: a.ts :: pruneIndex("), read).ok, false);
    assert.equal(evaluateAssertion(parseAssertion("file-lacks: a.ts :: pruneIndex("), read).ok, true);
  });

  // --- the verdict reducer ------------------------------------------------

  const INVARIANTS = [
    "INV-1 The checker MUST live in scripts/ci/design-concept-reconcile-check.ts as pure functions.",
    "INV-2 MUST NOT deliver the enforcement as a new advisory workflow file.",
  ];
  const HASH = "8c0dfe60287afcf4f464b5e94c35e0fd";
  // Issue #4118: a MUST-NOT invariant is dischargeable ONLY by naming a test,
  // so the fixture needs a suite file that genuinely declares one.
  const SUBTEST = "the enforcement is not delivered as a new advisory workflow";
  const FILES = {
    "scripts/ci/design-concept-reconcile-check.ts": "export function checkReconciliation() {}",
    "test/design-concept-reconcile-check.test.mts": `  test("${SUBTEST}", () => {});\n`,
  };
  const TEST_ASSERTION = `\`test: test/design-concept-reconcile-check.test.mts :: "${SUBTEST}"\``;

  function goodBody(): string {
    return [
      "Closes #2528",
      "",
      RECONCILIATION_HEADING,
      "",
      "Artifact: `8c0dfe60287a`",
      '- INV-1: "The checker MUST live in scripts/ci" — verified by: `file-contains: scripts/ci/design-concept-reconcile-check.ts :: checkReconciliation`',
      `- INV-2: "MUST NOT deliver the enforcement as a new advisory workflow" — verified by: ${TEST_ASSERTION}`,
    ].join("\n");
  }

  const run = (prBody: string, invariants = INVARIANTS): Violation[] =>
    checkReconciliation({ prBody, invariants, artifactHash: HASH, readFile: fakeReader(FILES) });

  const codes = (v: Violation[]) => v.map((x) => x.code);

  test("a well-formed reconciliation section produces zero violations", () => {
    assert.deepEqual(run(goodBody()), []);
  });

  test("a missing section is a single blocking violation naming the heading", () => {
    const v = run("Closes #2528\n\n## Summary\nnothing else");
    assert.deepEqual(codes(v), ["missing-section"]);
    assert.ok(v[0].message.includes(RECONCILIATION_HEADING));
  });

  test("a stale or absent artifact hash blocks", () => {
    assert.ok(codes(run(goodBody().replace("8c0dfe60287a", "deadbeefcafe"))).includes("artifact-hash-mismatch"));
    assert.ok(codes(run(goodBody().replace("Artifact: `8c0dfe60287a`", ""))).includes("missing-artifact-hash"));
  });

  test("a WRONG hash on the line below the label is found and still fails validation (issue #4101)", () => {
    // Widening the finder never weakens the check: whatever the next-line
    // fallback picks up is still validated by hashesMatch against the live
    // artifact hash, so a stale token blocks as artifact-hash-mismatch.
    const body = goodBody().replace("Artifact: `8c0dfe60287a`", "Artifact:\n`deadbeefcafe`");
    assert.equal(parseReconciliationSection(body).artifactHash, "deadbeefcafe", "the next-line token is found, not ignored");
    assert.ok(codes(run(body)).includes("artifact-hash-mismatch"));
  });

  test("a section with no hex token anywhere still yields null and still blocks (issue #4101)", () => {
    // The vacuous-widening guard (#4037's fix used the same shape): a section
    // whose only "citation" is prose must not start resolving hashes.
    const body = [
      "Closes #2528",
      "",
      RECONCILIATION_HEADING,
      "",
      "Artifact: (see the approved grill thread)",
      '- INV-1: "The checker MUST live in scripts/ci" — verified by: `file-contains: scripts/ci/design-concept-reconcile-check.ts :: checkReconciliation`',
      `- INV-2: "MUST NOT deliver the enforcement as a new advisory workflow" — verified by: ${TEST_ASSERTION}`,
    ].join("\n");
    assert.equal(parseReconciliationSection(body).artifactHash, null);
    assert.ok(codes(run(body)).includes("missing-artifact-hash"));
  });

  test("missing-artifact-hash names a correct hash the finder cannot read (issue #4101)", () => {
    // The residual shape after the fix: the CORRECT live hash is present but
    // not on a label line nor on the line immediately following one (here:
    // bare, two lines below the label). Saying "cites no artifact hash" is
    // misleading in exactly this case — the message must say the hash does
    // appear in the section, and where the gate needs it instead.
    const body = [
      "Closes #2528",
      "",
      RECONCILIATION_HEADING,
      "",
      "Artifact: grill-approved;",
      "status: approved, full hash below",
      HASH,
      '- INV-1: "The checker MUST live in scripts/ci" — verified by: `file-contains: scripts/ci/design-concept-reconcile-check.ts :: checkReconciliation`',
      `- INV-2: "MUST NOT deliver the enforcement as a new advisory workflow" — verified by: ${TEST_ASSERTION}`,
    ].join("\n");
    assert.equal(parseReconciliationSection(body).artifactHash, null, "non-adjacent bare hash still does not resolve");
    const withMention = run(body).find((v) => v.code === "missing-artifact-hash");
    assert.ok(withMention, "expected missing-artifact-hash");
    assert.match(withMention!.message, /appears in the section/);
    assert.match(withMention!.message, /8c0dfe60287a/);

    // A section with no hash anywhere keeps the original wording.
    const without = run(goodBody().replace("Artifact: `8c0dfe60287a`", "")).find((v) => v.code === "missing-artifact-hash");
    assert.ok(without, "expected missing-artifact-hash");
    assert.doesNotMatch(without!.message, /appears in the section/);
    assert.match(without!.message, /cites no artifact hash/);
  });

  test("entry count must equal invariants.length", () => {
    const short = goodBody().split("\n").slice(0, -1).join("\n");
    assert.ok(codes(run(short)).includes("entry-count-mismatch"));
    assert.ok(codes(run(short)).includes("missing-entry"));
  });

  test("a duplicated or out-of-range INV label blocks", () => {
    assert.ok(codes(run(goodBody().replace("INV-2:", "INV-1:"))).includes("duplicate-entry"));
    assert.ok(codes(run(goodBody() + '\n- INV-9: "bogus entry text here" — verified by: `manual: x`')).includes("unknown-entry"));
  });

  test("a paraphrased quote blocks, and the message carries the invariant VERBATIM", () => {
    const v = run(goodBody().replace('"The checker MUST live in scripts/ci"', '"the checker lives somewhere"'));
    const q = v.find((x) => x.code === "quote-mismatch");
    assert.ok(q, "expected a quote-mismatch");
    assert.equal(q!.invariantIndex, 1);
    assert.equal(q!.invariant, INVARIANTS[0]);
    assert.ok(q!.message.includes(INVARIANTS[0]));
  });

  test("a MUST-NOT invariant cannot be discharged by ANY lexical assertion kind (issue #4118)", () => {
    // Was "cannot be discharged with prose". Rejecting only `manual:` left
    // every other kind available — which is exactly how PR #4090 discharged a
    // MUST-NEVER invariant with an occurrences: count. The rule is now
    // test-or-nothing, so this enumerates the whole grammar rather than one
    // member of it.
    const LEXICAL = [
      "`manual: I checked, there is no workflow`",
      "`file-absent: .github/workflows/design-concept-reconcile.yml`",
      "`file-exists: scripts/ci/design-concept-reconcile-check.ts`",
      "`file-contains: scripts/ci/design-concept-reconcile-check.ts :: checkReconciliation`",
      "`file-lacks: scripts/ci/design-concept-reconcile-check.ts :: nonesuch`",
      "`file-matches: scripts/ci/design-concept-reconcile-check.ts :: /checkReconciliation/`",
      "`file-not-matches: scripts/ci/design-concept-reconcile-check.ts :: /nonesuch/`",
      "`occurrences: scripts/ci/design-concept-reconcile-check.ts :: checkReconciliation == 1`",
    ];
    for (const declared of LEXICAL) {
      const v = run(goodBody().replace(TEST_ASSERTION, declared));
      const m = v.find((x) => x.code === "must-not-needs-machine-assertion");
      assert.ok(m, `expected ${declared} to be rejected on a MUST-NOT invariant`);
      assert.equal(m!.invariantIndex, 2);
      assert.equal(m!.invariant, INVARIANTS[1]);
    }
  });

  test("PR #4090 shape: an occurrences: count that evaluates TRUE still blocks (issue #4118)", () => {
    // The incident, reduced. `checkReconciliation` appears exactly once in the
    // fixture, so this assertion is TRUE — and that is the whole problem: it
    // was never evidence about a prohibition. It must be rejected on KIND,
    // before evaluation runs at all.
    const declared = "`occurrences: scripts/ci/design-concept-reconcile-check.ts :: checkReconciliation == 1`";
    const v = run(goodBody().replace(TEST_ASSERTION, declared));
    assert.ok(
      v.some((x) => x.code === "must-not-needs-machine-assertion"),
      "a TRUE lexical assertion must still be rejected as the wrong KIND of evidence",
    );
    assert.ok(
      !v.some((x) => x.code === "assertion-failed"),
      "and rejected for its kind, not for evaluating false — it evaluated TRUE",
    );
  });

  test("a MUST-NOT invariant discharged by a test: naming a real subtest passes (issue #4118)", () => {
    assert.deepEqual(run(goodBody()), [], "the fixture's MUST-NOT entry is discharged by a named, declared test");
  });

  test("a test: assertion naming a subtest that does not exist FAILS", () => {
    const v = run(goodBody().replace(SUBTEST, "a subtest nobody ever wrote"));
    assert.ok(
      v.some((x) => x.code === "assertion-failed"),
      "naming a test that is not declared must not pass, or the kind is decoration",
    );
  });

  test("a test: name appearing only in a COMMENT fails — structural, not substring", () => {
    // The difference from occurrences: in one case. A mention is not a
    // declaration.
    const v = checkReconciliation({
      prBody: goodBody(),
      invariants: INVARIANTS,
      artifactHash: HASH,
      readFile: fakeReader({
        ...FILES,
        "test/design-concept-reconcile-check.test.mts": `// ${SUBTEST}\nconst s = "${SUBTEST}";\n`,
      }),
    });
    assert.ok(v.some((x) => x.code === "assertion-failed"), "a mention must not discharge an invariant");
  });

  test("a SKIPPED test does not discharge an invariant", () => {
    const v = checkReconciliation({
      prBody: goodBody(),
      invariants: INVARIANTS,
      artifactHash: HASH,
      readFile: fakeReader({
        ...FILES,
        "test/design-concept-reconcile-check.test.mts": `  test.skip("${SUBTEST}", () => {});\n`,
      }),
    });
    assert.ok(
      v.some((x) => x.code === "assertion-failed"),
      "a skipped test asserts nothing, so it cannot be the evidence for a prohibition",
    );
  });

  test("prose IS accepted for a positive (non-MUST-NOT) invariant", () => {
    const v = run(
      goodBody().replace(
        "`file-contains: scripts/ci/design-concept-reconcile-check.ts :: checkReconciliation`",
        "`manual: reviewed the module header`",
      ),
    );
    assert.deepEqual(codes(v), []);
  });

  test("a falsified assertion blocks with expected-vs-observed and the named invariant", () => {
    // Retargeted onto INV-1 (positive) by #4118: on a MUST-NOT invariant the
    // wrong-KIND rejection now fires first, so a lexical assertion never
    // reaches evaluation and this case could no longer observe what it exists
    // to observe.
    const v = run(
      goodBody().replace(
        "`file-contains: scripts/ci/design-concept-reconcile-check.ts :: checkReconciliation`",
        "`file-contains: scripts/ci/design-concept-reconcile-check.ts :: neverAppearsAnywhere`",
      ),
    );
    const f = v.find((x) => x.code === "assertion-failed");
    assert.ok(f, "expected assertion-failed");
    assert.equal(f!.invariant, INVARIANTS[0]);
    assert.match(f!.message, /expected:/);
    assert.match(f!.message, /observed:/);
  });

  test("an unparseable assertion blocks rather than passing silently", () => {
    const v = run(
      goodBody().replace(TEST_ASSERTION, "`I eyeballed it`"),
    );
    assert.ok(codes(v).includes("unparseable-assertion"));
  });

  test("the gate never judges WHICH spec-offered option was chosen", () => {
    // Two different-but-equally-valid implementations both reconcile cleanly:
    // the gate only re-executes the assertion the dev declared.
    const invariants = ["INV-1 The enforcement MUST reach a required check."];
    const mk = (assertion: string) =>
      [
        RECONCILIATION_HEADING,
        "Artifact: `8c0dfe60287a`",
        `- INV-1: "The enforcement MUST reach a required check." — verified by: \`${assertion}\``,
      ].join("\n");
    const read = fakeReader({ "test/x.test.mts": "describe(", "scripts/ci/y.ts": "export function y() {}" });
    for (const a of ["file-contains: test/x.test.mts :: describe(", "file-exists: scripts/ci/y.ts"]) {
      assert.deepEqual(
        checkReconciliation({ prBody: mk(a), invariants, artifactHash: HASH, readFile: read }),
        [],
        `option ${a} should reconcile cleanly`,
      );
    }
  });

  test("an invariant whose verbatim prefix embeds a quote reconciles end-to-end (issue #3975)", () => {
    // Real #3963 shapes that were structurally unencodable under the old
    // first-`"`-to-next-`"` matcher: a `"` inside the first 16 chars (INV-1) and
    // an invariant that STARTS with a `"` (INV-2). The dev quotes a verbatim
    // ≥16-char prefix of each; the gate must accept both, not truncate them to a
    // sub-MIN_QUOTE_CHARS span and emit a bogus quote-mismatch.
    const invariants = [
      'mergeable == "UNKNOWN" is treated as no-verdict (never conflicted); re-poll once after a short delay or skip the row for this pass.',
      '"Required" checks means exactly the 7 branch-protection contexts — no more, no fewer.',
    ];
    const body = [
      "Closes #3963",
      "",
      RECONCILIATION_HEADING,
      "",
      "Artifact: `8c0dfe60287a`",
      '- INV-1: "mergeable == "UNKNOWN" is treated as no-verdict" — verified by: `file-contains: src/poll.ts :: mergeable`',
      '- INV-2: ""Required" checks means exactly the 7 branch-protection contexts" — verified by: `file-contains: src/poll.ts :: Required`',
    ].join("\n");
    const read = fakeReader({ "src/poll.ts": "const mergeable = row.Required;" });
    assert.deepEqual(
      checkReconciliation({ prBody: body, invariants, artifactHash: HASH, readFile: read }),
      [],
      "an invariant embedding a quote in its first 16 chars must be encodable end-to-end",
    );
  });

  test("formatViolations names every violation and the push-a-commit remedy", () => {
    const msg = formatViolations(run("no section"), 2528);
    assert.match(msg, /#2528/);
    assert.match(msg, /missing-section/);
    assert.match(msg, /PUSH A COMMIT/);
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — the adapter approval guard (issue #3849)
// ---------------------------------------------------------------------------
//
// Pure unit tests over the adapter's fail-OPEN skip ladder
// (`resolveEnforceDecision`). The live adapter (Suite 2) used to bind a PR to a
// resolved artifact's invariants WITHOUT checking that the artifact was
// approved, so a stale or abandoned DRAFT carrying real invariants + a hash
// became a binding reconciliation requirement on any later, unrelated PR that
// closed the same issue — on a REQUIRED merge-gate job (the npm-audit
// ambient-poison-pill class). Only an APPROVED artifact may bind.

describe("design-concept reconcile adapter approval guard (issue #3849)", () => {
  // The same invariants + hash the poison-pill draft and the approved artifact
  // both carry; only `status` differs between cases.
  const INVARIANTS = ["INV-1 The reconciliation gate MUST only bind an approved artifact to a PR."];
  const HASH = "826e0adbf7dab6b1cbe8403a16ecdceaf19cbf6c";
  // A PR body that closes the anchor and OMITS the reconciliation section.
  const PR_BODY_NO_SECTION = "Closes #3849\n\n## Summary\nno reconciliation section here";

  /** Run the pure decision core the adapter would run once it decides to bind. */
  const enforce = (artifact: any) => {
    const d = resolveEnforceDecision(artifact);
    if (!d.enforce) return { decision: d, violations: [] as Violation[] };
    return {
      decision: d,
      violations: checkReconciliation({
        prBody: PR_BODY_NO_SECTION,
        invariants: artifact.invariants,
        artifactHash: artifact.artifactHash,
        readFile: fakeReader({}),
      }),
    };
  };

  test("a DRAFT artifact carrying invariants + a hash does NOT bind (skips green)", () => {
    const { decision, violations } = enforce({ status: "draft", invariants: INVARIANTS, artifactHash: HASH });
    assert.equal(decision.enforce, false);
    assert.deepEqual(violations, [], "a non-binding adapter decision never reaches checkReconciliation");
    if (!decision.enforce) {
      assert.match(decision.reason, /not approved/i);
      assert.match(decision.reason, /draft/);
    }
    // Same inputs, HAD they been enforced, WOULD have failed (missing-section) —
    // proving the approval guard is what keeps this PR green, not a vacuous pass.
    const wouldViolate = checkReconciliation({
      prBody: PR_BODY_NO_SECTION,
      invariants: INVARIANTS,
      artifactHash: HASH,
      readFile: fakeReader({}),
    });
    assert.ok(wouldViolate.some((v) => v.code === "missing-section"));
  });

  test("an APPROVED artifact with the same invariants + hash DOES still bind", () => {
    const { decision, violations } = enforce({ status: "approved", invariants: INVARIANTS, artifactHash: HASH });
    assert.equal(decision.enforce, true);
    // Because it binds, the adapter runs checkReconciliation, which flags the
    // missing section — the guard cannot silently disable the whole check.
    assert.ok(violations.some((v) => v.code === "missing-section"));
  });

  test("a STALE artifact does NOT bind either — only 'approved' binds", () => {
    const decision = resolveEnforceDecision({ status: "stale", invariants: INVARIANTS, artifactHash: HASH });
    assert.equal(decision.enforce, false);
    if (!decision.enforce) assert.match(decision.reason, /stale/);
  });

  test("a missing or unrecognised status is treated as not-approved (fail open)", () => {
    for (const artifact of [
      { invariants: INVARIANTS, artifactHash: HASH }, // no status field at all
      { status: undefined, invariants: INVARIANTS, artifactHash: HASH },
      { status: "bogus", invariants: INVARIANTS, artifactHash: HASH },
    ]) {
      const decision = resolveEnforceDecision(artifact);
      assert.equal(decision.enforce, false);
      if (!decision.enforce) assert.match(decision.reason, /not approved/i);
    }
  });

  test("the four pre-existing structural rungs are unchanged for an approved artifact", () => {
    const noInv = resolveEnforceDecision({ status: "approved", invariants: [], artifactHash: HASH });
    assert.equal(noInv.enforce, false);
    if (!noInv.enforce) assert.match(noInv.reason, /no invariants/);

    const noHash = resolveEnforceDecision({ status: "approved", invariants: INVARIANTS, artifactHash: "" });
    assert.equal(noHash.enforce, false);
    if (!noHash.enforce) assert.match(noHash.reason, /artifactHash/);
  });

  test("the not-approved skip reason is distinguishable from the no-artifact (404) skip", () => {
    // Suite 2's 404 rung skips with "no design-concept artifact for issue #N".
    // The not-approved rung must carry text an operator can tell apart.
    const decision = resolveEnforceDecision({ status: "draft", invariants: INVARIANTS, artifactHash: HASH });
    if (!decision.enforce) {
      assert.ok(!/no design-concept artifact/i.test(decision.reason));
      assert.match(decision.reason, /approved/i);
    } else {
      assert.fail("expected a draft artifact to skip, not bind");
    }
  });
});

// =============================================================================
// The `test:` assertion kind — parsing (issue #4118).
// =============================================================================
describe("design-concept-reconcile — parseAssertion, `test:` kind (issue #4118)", () => {
  test("parses a path and a quoted subtest name, in any of the three quote styles", () => {
    for (const q of ['"', "'", "`"]) {
      assert.deepEqual(
        parseAssertion(`test: test/a.test.mts :: ${q}does the thing${q}`),
        { kind: "test", path: "test/a.test.mts", name: "does the thing" },
        `quote style ${q} must parse`,
      );
    }
  });

  test("a subtest name containing :: and regex metacharacters survives intact", () => {
    // The name is whatever the test is actually called; real subtest names in
    // this repo contain colons, parentheses and dots.
    const a = parseAssertion('test: test/a.test.mts :: "INV-5: absent latency_ms clears the streak (probe never reached)"');
    assert.equal(a.kind, "test");
    assert.equal(
      (a as { name: string }).name,
      "INV-5: absent latency_ms clears the streak (probe never reached)",
    );
  });

  test("a path outside the suite is UNPARSEABLE, never a pass", () => {
    // The kind's whole value is that it names something the `test` job ran.
    for (const path of ["src/api.ts", "scripts/ci/x.ts", "test/helper.mts", "docs/a.md"]) {
      const a = parseAssertion(`test: ${path} :: "x"`);
      assert.equal(a.kind, "unparseable", `${path} must not parse as a test assertion`);
      assert.match((a as { reason: string }).reason, /test\/\*\*\.test\.mts|name a file in the suite/);
    }
  });

  test("an unsafe path is rejected by the same guard as every other kind", () => {
    for (const path of ["/etc/passwd", "../../test/a.test.mts", "~/test/a.test.mts"]) {
      assert.equal(parseAssertion(`test: ${path} :: "x"`).kind, "unparseable");
    }
  });

  test("an unquoted or empty subtest name is unparseable", () => {
    assert.equal(parseAssertion("test: test/a.test.mts :: does the thing").kind, "unparseable");
    assert.equal(parseAssertion('test: test/a.test.mts :: ""').kind, "unparseable");
    assert.equal(parseAssertion("test: test/a.test.mts").kind, "unparseable");
  });

  test("a `test:` assertion is machine-checkable — it is evidence, not prose", () => {
    assert.equal(isMachineCheckable(parseAssertion('test: test/a.test.mts :: "x"')), true);
  });
});

// =============================================================================
// declaresSubtest — the structural match behind the `test:` kind (issue #4118).
// =============================================================================
describe("design-concept-reconcile — declaresSubtest (issue #4118)", () => {
  const NAME = "does the thing";

  test("matches test( / it( / describe( at the head of a line, with any indentation", () => {
    for (const fn of ["test", "it", "describe"]) {
      assert.equal(declaresSubtest(`${fn}("${NAME}", () => {});`, NAME), true, `${fn}( must match`);
      assert.equal(declaresSubtest(`      ${fn}('${NAME}', () => {});`, NAME), true, `indented ${fn}( must match`);
    }
  });

  test("does NOT match a mention in a comment, a string, or mid-line", () => {
    assert.equal(declaresSubtest(`// ${NAME}`, NAME), false);
    assert.equal(declaresSubtest(`const s = "${NAME}";`, NAME), false);
    assert.equal(declaresSubtest(`  /* test("${NAME}") */`, NAME), false, "a commented-out declaration is not a declaration");
    assert.equal(declaresSubtest(`assert.ok(x, "${NAME}");`, NAME), false);
  });

  test("does NOT match a skipped or todo declaration", () => {
    assert.equal(declaresSubtest(`test.skip("${NAME}", () => {});`, NAME), false);
    assert.equal(declaresSubtest(`it.todo("${NAME}");`, NAME), false);
  });

  test("requires the EXACT name — a prefix or a superstring does not satisfy it", () => {
    assert.equal(declaresSubtest(`test("${NAME} and more", () => {});`, NAME), false);
    assert.equal(declaresSubtest(`test("does the", () => {});`, NAME), false);
  });

  test("a name containing regex metacharacters is matched literally", () => {
    const tricky = "INV-5: clears (probe never reached) [a.b]";
    assert.equal(declaresSubtest(`test("${tricky}", () => {});`, tricky), true);
    assert.equal(declaresSubtest(`test("INV-5X clears XprobeYneverYreachedZ XaXbZ", () => {});`, tricky), false);
  });

  test("finds a declaration anywhere in a multi-line file", () => {
    const src = ['import test from "node:test";', "", 'describe("outer", () => {', `  test("${NAME}", () => {});`, "});"].join("\n");
    assert.equal(declaresSubtest(src, NAME), true);
  });
});

// =============================================================================
// Additivity + contract-documentation guards (issue #4118).
// =============================================================================
describe("design-concept-reconcile — the test: kind is strictly additive (issue #4118)", () => {
  const FILES = {
    "src/x.ts": "export function doThing() {}\nconst other = 1;\n",
    "test/a.test.mts": 'test("real subtest", () => {});\n',
  };
  const ev = (raw: string) => evaluateAssertion(parseAssertion(raw), fakeReader(FILES));

  test("INV-4: every pre-existing assertion kind evaluates exactly as it did before", () => {
    // Pinning that adding a union member and a switch case changed no other
    // branch. If a future edit to the `test:` case leaks into these, this
    // fails rather than quietly shifting the meaning of an existing kind.
    assert.equal(ev("file-exists: src/x.ts").ok, true);
    assert.equal(ev("file-exists: src/missing.ts").ok, false);
    assert.equal(ev("file-absent: src/missing.ts").ok, true);
    assert.equal(ev("file-absent: src/x.ts").ok, false);
    assert.equal(ev("file-contains: src/x.ts :: doThing(").ok, true);
    assert.equal(ev("file-contains: src/x.ts :: nonesuch").ok, false);
    assert.equal(ev("file-lacks: src/x.ts :: nonesuch").ok, true);
    assert.equal(ev("file-lacks: src/x.ts :: doThing(").ok, false);
    // A missing file is never a vacuous pass for the negative kinds.
    assert.equal(ev("file-lacks: src/missing.ts :: anything").ok, false);
    assert.equal(ev("file-not-matches: src/missing.ts :: /anything/").ok, false);
    assert.equal(ev("file-matches: src/x.ts :: /doThing/").ok, true);
    assert.equal(ev("file-not-matches: src/x.ts :: /nonesuch/").ok, true);
    assert.equal(ev("occurrences: src/x.ts :: doThing == 1").ok, true);
    assert.equal(ev("occurrences: src/x.ts :: doThing == 2").ok, false);
    assert.equal(ev("occurrences: src/x.ts :: doThing >= 1").ok, true);
    assert.equal(ev("manual: I read it").ok, true);
  });

  test("INV-4: a positive invariant may still be discharged by any kind, including test:", () => {
    // The new kind is permitted everywhere; it is only REQUIRED on
    // prohibitions. Nothing about positive invariants got narrower.
    assert.equal(ev('test: test/a.test.mts :: "real subtest"').ok, true);
    assert.equal(ev('test: test/a.test.mts :: "not a real subtest"').ok, false);
  });
});

describe("design-concept-reconcile — the dispatch contract documents the test: kind (issue #4118)", () => {
  const FRAGMENT = join(
    import.meta.dirname,
    "..",
    "docs/operator-playbooks/_fragments/hydra-dev-child-flow.md",
  );

  test("INV-6: the hydra-dev fragment documents test: and states MUST-NOT requires it exclusively", () => {
    // A gate whose contract is not written down where dispatches read it turns
    // into a surprise red on a PR body that was written in good faith. This
    // fragment is what a dev_orch dispatch is handed, so the grammar change
    // has to be visible there before the first PR meets it.
    const md = readFileSync(FRAGMENT, "utf-8");
    assert.match(md, /test: test\/<file>\.test\.mts :: "<subtest name>"/, "the grammar list must show the test: form");
    assert.match(md, /MUST NOT \/ MUST NEVER can ONLY be discharged with a `test:`/, "exclusivity must be stated, not implied");
    assert.match(md, /#4118/, "the fragment must cite the issue that changed the contract");
    assert.match(md, /test\.skip\(` does not count|does not count \(a skipped test asserts nothing\)/, "the skip rule must be documented — it is surprising otherwise");
  });
});
