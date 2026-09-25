/**
 * Unit + parity tests for the PR-ref detection predicate (issue #4683,
 * ADR-0040 Decision 4 row 6 / Decision 5, `src/github/pr-refs.ts`).
 *
 * One top-level describe, no Redis, no before/after — this module is a pure
 * leaf. Cases cover each channel of `referencedIssues`/`closedIssues`/
 * `mergedPrReferences`, the branch-anchoring edge cases, null/empty rows,
 * dedup, and — the load-bearing one — a source-string parity test against
 * `scripts/autopilot/pr-refs.py` (the #3965 convention): it reads the
 * Python file at test time, extracts each `re.compile(r"...")` literal by
 * NAME, and asserts `.source`/flag equality with the TS constants. Either
 * side changing alone fails this test.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLOSING_VERB_ALTERNATION,
  BRANCH_RE,
  BODY_RE,
  CLOSE_RE,
  TITLE_ANCHOR_RE,
  referencedIssues,
  closedIssues,
  mergedPrReferences,
  type PrRefRow,
} from "../src/github/pr-refs.ts";

const PY_SCRIPT = join(import.meta.dirname, "..", "scripts/autopilot/pr-refs.py");

describe("github/pr-refs (issue #4683)", () => {
  // -------------------------------------------------------------------------
  // Purity contract (INV-1)
  // -------------------------------------------------------------------------

  test("pr-refs.ts is pure: no I/O imports, no classes, no constructor parameter properties", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src/github/pr-refs.ts"), "utf-8");
    // Strip /** */ block comments first — the docstrings legitimately discuss
    // `node:fs`/`fetch`/`process.env` in prose; the purity contract is about
    // actual CODE, not what the comments talk about.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /^import /m, "pr-refs.ts must have no imports at all");
    assert.doesNotMatch(code, /\bnode:/);
    assert.doesNotMatch(code, /\bfetch\(/);
    assert.doesNotMatch(code, /process\.env/);
    assert.doesNotMatch(code, /^class /m);
  });

  test("referencedIssues/closedIssues/mergedPrReferences never throw on null/undefined/missing fields", () => {
    const rows: PrRefRow[] = [
      {},
      { headRefName: null, body: null, title: null },
      { headRefName: undefined, body: undefined, title: undefined },
    ];
    assert.deepEqual([...referencedIssues(rows)], []);
    assert.deepEqual([...closedIssues(rows)], []);
    assert.deepEqual([...mergedPrReferences(rows)], []);
  });

  test("an empty array yields empty sets", () => {
    assert.deepEqual([...referencedIssues([])], []);
    assert.deepEqual([...closedIssues([])], []);
    assert.deepEqual([...mergedPrReferences([])], []);
  });

  // -------------------------------------------------------------------------
  // One verb list (INV-2)
  // -------------------------------------------------------------------------

  test("CLOSING_VERB_ALTERNATION is the single TypeScript home for the verb list", () => {
    assert.equal(CLOSING_VERB_ALTERNATION, "close[sd]?|fix(?:e[sd])?|resolve[sd]?");
    // BODY_RE composes it plus the non-closing `refs?` arm; CLOSE_RE composes
    // it alone. Both stay byte-identical to pr-refs.py's own literals (see
    // the parity test below) purely as a consequence of sharing this constant.
    assert.match(BODY_RE.source, /refs\?/);
    assert.doesNotMatch(CLOSE_RE.source, /refs\?/);
  });

  test("the two scripts/ci consumers contain no inline closing-verb regex literal", () => {
    for (const path of ["scripts/ci/epic-close.ts", "scripts/ci/design-concept-reconcile-check.ts"]) {
      const src = readFileSync(join(import.meta.dirname, "..", path), "utf-8");
      assert.doesNotMatch(src, /close\[sd\]/, `${path} must not contain the verb-list literal inline`);
      assert.match(
        src,
        /CLOSING_VERB_ALTERNATION/,
        `${path} must import/compose CLOSING_VERB_ALTERNATION`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Source-string parity with pr-refs.py (INV-3) — the #3965 convention
  // -------------------------------------------------------------------------

  /**
   * Extract a `NAME = re.compile(r"...", re.IGNORECASE)` (or the one-line,
   * no-flags form) literal by NAME from the Python source. Returns `null`
   * when the name is not found at all — so a rename/removal on the Python
   * side fails this test loudly rather than passing vacuously.
   */
  function extractPyRegex(src: string, name: string): { source: string; ignoreCase: boolean } | null {
    const re = new RegExp(
      String.raw`${name}\s*=\s*re\.compile\(\s*r"((?:[^"\\]|\\.)*)"\s*(,\s*re\.IGNORECASE\s*)?,?\s*\)`,
    );
    const m = re.exec(src);
    if (!m) return null;
    return { source: m[1], ignoreCase: !!m[2] };
  }

  test("BRANCH_RE / BODY_RE / CLOSE_RE are byte-identical to pr-refs.py's _BRANCH_RE / _BODY_RE / _CLOSE_RE", () => {
    const pySrc = readFileSync(PY_SCRIPT, "utf-8");

    const pyBranch = extractPyRegex(pySrc, "_BRANCH_RE");
    const pyBody = extractPyRegex(pySrc, "_BODY_RE");
    const pyClose = extractPyRegex(pySrc, "_CLOSE_RE");

    assert.ok(pyBranch, "pr-refs.py must define _BRANCH_RE via re.compile(r\"...\")");
    assert.ok(pyBody, "pr-refs.py must define _BODY_RE via re.compile(r\"...\")");
    assert.ok(pyClose, "pr-refs.py must define _CLOSE_RE via re.compile(r\"...\")");

    assert.equal(BRANCH_RE.source, pyBranch!.source);
    assert.equal(pyBranch!.ignoreCase, false);
    assert.equal(BRANCH_RE.flags.includes("i"), pyBranch!.ignoreCase);

    assert.equal(BODY_RE.source, pyBody!.source);
    assert.equal(pyBody!.ignoreCase, true);
    assert.equal(BODY_RE.flags.includes("i"), pyBody!.ignoreCase);

    assert.equal(CLOSE_RE.source, pyClose!.source);
    assert.equal(pyClose!.ignoreCase, true);
    assert.equal(CLOSE_RE.flags.includes("i"), pyClose!.ignoreCase);
  });

  // -------------------------------------------------------------------------
  // Branch channel (INV-4)
  // -------------------------------------------------------------------------

  test("branch channel: anchored at 0, `-slug` optional, `\\b` stop, missing headRefName", () => {
    assert.deepEqual([...referencedIssues([{ headRefName: "issue-3852-foo" }])], [3852]);
    assert.deepEqual([...referencedIssues([{ headRefName: "issue-385" }])], [385]);
    assert.deepEqual([...referencedIssues([{ headRefName: "feat/issue-385-foo" }])], []);
    // issue-385 must never match branch issue-3852-foo as 385 (the `\b` stop).
    assert.deepEqual([...referencedIssues([{ headRefName: "issue-3852-foo" }])], [3852]);
    assert.deepEqual([...referencedIssues([{}])], []);
  });

  // -------------------------------------------------------------------------
  // Function semantics (INV-5)
  // -------------------------------------------------------------------------

  test("referencedIssues: body union — each verb tense, Refs/Ref #N, colon form, case-insensitivity", () => {
    const cases: Array<[string, number[]]> = [
      ["Closes #10", [10]],
      ["closed #11", [11]],
      ["Fix #12", [12]],
      ["fixes #13", [13]],
      ["Fixed #14", [14]],
      ["resolve #15", [15]],
      ["Resolves #16", [16]],
      ["resolved #17", [17]],
      ["Refs #18", [18]],
      ["Ref #19", [19]],
      ["Closes: #20", [20]],
      ["CLOSES #21", [21]],
    ];
    for (const [body, expected] of cases) {
      assert.deepEqual([...referencedIssues([{ body }])], expected, body);
    }
  });

  test("referencedIssues: body non-matches — no space, prefix word, trailing letters", () => {
    assert.deepEqual([...referencedIssues([{ body: "closes#22" }])], []);
    assert.deepEqual([...referencedIssues([{ body: "pref #23" }])], []);
    assert.deepEqual([...referencedIssues([{ body: "closes #24abc" }])], []);
  });

  test("closedIssues: excludes Refs #N and branch-only rows", () => {
    assert.deepEqual([...closedIssues([{ body: "Refs #30" }])], []);
    assert.deepEqual([...closedIssues([{ headRefName: "issue-31-foo" }])], []);
    assert.deepEqual([...closedIssues([{ body: "Closes #32" }])], [32]);
  });

  test("mergedPrReferences: title-anchor-only, closing verb in title, closing verb in body, no bare mention", () => {
    assert.deepEqual([...mergedPrReferences([{ title: "fix: thing (#40)" }])], [40]);
    assert.deepEqual([...mergedPrReferences([{ title: "Closes #41: thing" }])], [41]);
    assert.deepEqual([...mergedPrReferences([{ title: "thing", body: "Fixes #42" }])], [42]);
    assert.deepEqual([...mergedPrReferences([{ title: "see #43", body: "no keyword here" }])], []);
  });

  test("dedup across rows: the same issue number referenced by multiple rows appears once", () => {
    const rows: PrRefRow[] = [{ body: "Closes #50" }, { headRefName: "issue-50-foo" }, { body: "Refs #50" }];
    assert.deepEqual([...referencedIssues(rows)].sort((a, b) => a - b), [50]);
  });

  // -------------------------------------------------------------------------
  // Row shape (INV-6)
  // -------------------------------------------------------------------------

  test("PrRefRow is a structural subset — a PrRow-shaped object with no body field works unchanged", () => {
    const prRowShaped = {
      number: 1,
      title: "Closes #60",
      url: "https://example.com/1",
      updatedAt: "",
      state: "OPEN",
      headRefName: "",
      createdAt: "",
      statusCheckRollup: [],
    };
    assert.deepEqual([...mergedPrReferences([prRowShaped])], [60]);
  });

  // -------------------------------------------------------------------------
  // epic-close.ts / design-concept-reconcile-check.ts stay byte-identical (INV-7, INV-8)
  // -------------------------------------------------------------------------

  test("epic-close.ts's closing-keyword pattern composes CLOSING_VERB_ALTERNATION and stays byte-identical", () => {
    const composed = new RegExp(String.raw`\b(?:${CLOSING_VERB_ALTERNATION})\b\s*:?\s*#(\d+)`, "gi");
    assert.equal(
      composed.source,
      String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*#(\d+)`,
    );
  });

  test("design-concept-reconcile-check.ts's extractAnchorRefFromPrBody pattern stays byte-identical", () => {
    const composed = new RegExp(String.raw`(?:${CLOSING_VERB_ALTERNATION})\s+#(\d+)`, "i");
    assert.equal(composed.source, String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)`);
  });

  // -------------------------------------------------------------------------
  // The module's only import (INV-9) — see test/design-concept-reconcile-check.test.mts
  // -------------------------------------------------------------------------

  test("TITLE_ANCHOR_RE matches a (#N) title anchor and is global", () => {
    assert.ok(TITLE_ANCHOR_RE.flags.includes("g"));
    assert.deepEqual([...("thing (#70)".matchAll(TITLE_ANCHOR_RE))].map((m) => m[1]), ["70"]);
  });
});
