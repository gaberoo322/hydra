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
import { spawnSync } from "node:child_process";
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

/**
 * Run pr-refs.py's `closing_issues()` over stdin JSON via the `--closing` CLI
 * selector (issue #4767): space-separated sorted numbers on stdout, so the
 * negation table below asserts BEHAVIOURAL parity — the Python engine really
 * rejects the negated verb — not only `.source` textual parity.
 */
function pyClosingNumbers(prs: readonly PrRefRow[]): number[] {
  const r = spawnSync("python3", [PY_SCRIPT, "--closing"], {
    input: JSON.stringify(prs),
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, `pr-refs.py --closing exited non-zero: ${r.stderr}`);
  return (r.stdout ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
}

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
  // The --merged rule's regex literal (issue #4690, ADR-0040 Decision 4 row 7)
  // -------------------------------------------------------------------------

  test("_TITLE_ANCHOR_RE is byte-identical to pr-refs.py's _TITLE_ANCHOR_RE (the --merged rule's own regex)", () => {
    const pySrc = readFileSync(PY_SCRIPT, "utf-8");
    const pyAnchor = extractPyRegex(pySrc, "_TITLE_ANCHOR_RE");
    assert.ok(pyAnchor, 'pr-refs.py must define _TITLE_ANCHOR_RE via re.compile(r"...")');
    // The closing-verb half of the rule reuses _CLOSE_RE, already pinned
    // byte-identical above — so the title-anchor literal is the only NEW
    // regex source the --merged mode adds, and it must equal the TS constant
    // mergedPrReferences composes (TITLE_ANCHOR_RE).
    assert.equal(TITLE_ANCHOR_RE.source, pyAnchor!.source);
    assert.equal(pyAnchor!.ignoreCase, false);
    assert.equal(TITLE_ANCHOR_RE.flags.includes("i"), pyAnchor!.ignoreCase);
  });

  test("pr-refs.py --merged emits exactly mergedPrReferences's set (CLI parity, issue #4690)", () => {
    const rows: PrRefRow[] = [
      { title: "fix: x (#40)", body: "" }, // the (#N) title anchor
      { title: "Closes #41: thing", body: "" }, // closing verb in the title
      { title: "thing", body: "Fixes #42" }, // closing verb in the body
      { title: "see #43", body: "no keyword here" }, // bare mention — no match
      { title: "fix(scope): subject (#44) (#45)", body: "" }, // two anchors
      { headRefName: "issue-46-foo", body: "" }, // branch channel is NOT part of the merged rule
      { body: "Refs #47" }, // non-closing Refs #N is NOT part of the merged rule
      {}, // null/missing fields never throw
    ];
    const expected = [...mergedPrReferences(rows)].sort((a, b) => a - b);
    const r = spawnSync("python3", [PY_SCRIPT, "--merged"], {
      input: JSON.stringify(rows),
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `pr-refs.py --merged exited non-zero: ${r.stderr}`);
    const got = (r.stdout ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    assert.deepEqual(got, expected);
  });

  test("pr-refs.py --closing emits exactly closedIssues's set (CLI parity, issue #4694)", () => {
    const rows: PrRefRow[] = [
      { body: "Closes #40" }, // closing verb
      { body: "fixed: #41 and Resolves #42" }, // other tenses / verbs
      { body: "Refs #43" }, // non-closing Refs #N is NOT a closing ref
      { headRefName: "issue-44-foo", body: "" }, // branch channel is NOT a closing ref
      { title: "fix: x (#45)", body: "" }, // title anchor is NOT a closing ref
      { title: "Closes #46", body: "" }, // closing verb in the TITLE only is NOT body
      {}, // null/missing fields never throw
    ];
    const expected = [...closedIssues(rows)].sort((a, b) => a - b);
    const r = spawnSync("python3", [PY_SCRIPT, "--closing"], {
      input: JSON.stringify(rows),
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `pr-refs.py --closing exited non-zero: ${r.stderr}`);
    const got = (r.stdout ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    assert.deepEqual(got, expected);
    assert.deepEqual(got, [40, 41, 42]);
  });

  test("pr-refs.py --merged fails open on unparsable stdin (empty set, exit 0)", () => {
    for (const input of ["", "not json", '{"not":"a list"}']) {
      const r = spawnSync("python3", [PY_SCRIPT, "--merged"], { input, encoding: "utf-8" });
      assert.equal(r.status, 0, `--merged must never abort on bad stdin: ${r.stderr}`);
      assert.equal((r.stdout ?? "").trim(), "");
    }
  });

  // -------------------------------------------------------------------------
  // Branch channel (INV-4)
  // -------------------------------------------------------------------------

  test("branch channel: anchored at 0, dash-slug optional, word-boundary stop, missing headRefName", () => {
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

  // -------------------------------------------------------------------------
  // Negation guard (issue #4767) — "Does not close #N" is NOT a close
  //
  // A companion PR that says "Does not close #26 — #63 does." was counted as
  // CLOSING #26 by the unguarded regex, so the qa_target resolver kept
  // re-picking the already-PASSed companion. The guard is a non-capturing
  // first alternation arm (negation, optional ONE bounded filler adverb,
  // verb, #N) that consumes the negated ref before the capturing arm can —
  // and it lives ONLY in CLOSE_RE: BODY_RE still counts a negated ref as
  // REFERENCED (the in-flight exclusion stays conservative), and
  // CLOSING_VERB_ALTERNATION is untouched (epic-close / reconcile keep their
  // byte-pinned patterns above).
  // -------------------------------------------------------------------------

  test("negation guard: a negated closing verb no longer closes (issue #4767 table, TS + Python)", () => {
    const cases: Array<[string, number[]]> = [
      // The CSB #64 body from the incident: previously returned {26}.
      ["Does not close #26 — #63 does.", []],
      // Contraction and typographic-apostrophe negations.
      ["doesn't fix #5", []],
      ["won’t resolve #8", []],
      // Case-insensitive negation and a newline between not and the verb.
      ["Do NOT close #7", []],
      ["does not\nclose #11", []],
      // More than one whitespace between the negation and the verb (QA #4810).
      ["does not  close #12", []],
      ["does not\n\nclose #13", []],
      // `cannot`, `never`, `no longer` negations (QA #4810).
      ["cannot close #10", []],
      ["never closes #15", []],
      ["no longer fixes #16", []],
      // ONE bounded filler adverb between negation and verb (QA #4810).
      ["does not fully close #17", []],
      ["does not yet fix #18", []],
      ["doesn't actually resolve #19", []],
      ["won’t necessarily close #20", []],
      // The REAL close in a mixed body survives the negated one.
      ["Closes #1, does not close #2", [1]],
      ["Does not yet fix #3 but fixes #4", [4]],
      // Unguarded positives keep closing.
      ["Closes #26", [26]],
      ["Fixes: #9", [9]],
      // \bnot needs a word boundary: "knot closes" is not a negation.
      ["knot closes #14", [14]],
      // A non-filler word between negation and verb is not a negated close
      // ("not only closes" IS a close).
      ["This not only closes #21 but also tidies", [21]],
      // ACCEPTED RESIDUALS (the companion-PR authoring rule in the playbooks —
      // reference the anchor as `Refs #N` — covers them): a filler outside the
      // bounded list, or more than one filler, still counts as a close.
      ["does not quite close #22", [22]],
      ["does not yet fully close #23", [23]],
    ];
    for (const [body, expected] of cases) {
      assert.deepEqual([...closedIssues([{ body }])].sort((a, b) => a - b), expected, `TS: ${body}`);
      assert.deepEqual(pyClosingNumbers([{ body }]), expected, `Python: ${body}`);
    }
  });

  test("negation guard scope: a negated ref still counts as REFERENCED, CLOSING_VERB_ALTERNATION untouched", () => {
    const body = "Does not close #26 — #63 does.";
    // BODY_RE is deliberately unguarded: the negated ref still marks the
    // anchor as in-flight (REFERENCED), keeping it off the dev candidate board…
    assert.deepEqual([...referencedIssues([{ body }])], [26]);
    // …while no longer claiming to CLOSE it.
    assert.deepEqual([...closedIssues([{ body }])], []);
    // Python parity on both channels: the body channel (and the zero-arg
    // union) still see 26; --closing does not.
    for (const args of [[], ["--source", "body"]]) {
      const r = spawnSync("python3", [PY_SCRIPT, ...args], { input: JSON.stringify([{ body }]), encoding: "utf-8" });
      assert.equal(r.status, 0, `pr-refs.py ${args.join(" ")} exited non-zero: ${r.stderr}`);
      assert.deepEqual((r.stdout ?? "").trim().split(/\s+/).filter(Boolean), ["26"], `Python ${args.join(" ")}`);
    }
    assert.deepEqual(pyClosingNumbers([{ body }]), []);
    // The verb-list constant stays byte-for-byte what it was (pinned above);
    // the guard lives only in the CLOSE_RE composition, as its leading arm.
    assert.equal(CLOSING_VERB_ALTERNATION, "close[sd]?|fix(?:e[sd])?|resolve[sd]?");
    if (!CLOSE_RE.source.startsWith(String.raw`(?:\b(?:can)?not|n't|n’t|\bnever|\bno\s+longer)\s+`)) {
      assert.fail(`CLOSE_RE must lead with the negation arm: ${CLOSE_RE.source}`);
    }
  });

  test("merged rule inherits the negation guard; the (#N) title-anchor arm is unchanged", () => {
    // A merged companion whose body says "does not close #N" no longer counts
    // as shipped work for #N via its body…
    const companion = { title: "docs: glossary touch-up", body: "Does not close #50 — the code PR does." };
    assert.deepEqual([...mergedPrReferences([companion])], []);
    // …while the (#N) title-anchor arm — the OTHER half of the merged rule —
    // is untouched and still fires.
    const anchored = { title: "docs: glossary touch-up (#51)", body: "Does not close #51 — the code PR does." };
    assert.deepEqual([...mergedPrReferences([anchored])], [51]);
    // Python --merged parity on the negated-body row (CLI, same as #4690's test).
    const r = spawnSync("python3", [PY_SCRIPT, "--merged"], {
      input: JSON.stringify([companion, anchored]),
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `pr-refs.py --merged exited non-zero: ${r.stderr}`);
    assert.deepEqual(
      (r.stdout ?? "").trim().split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b),
      [51],
    );
  });

  test("playbooks pin the companion-PR rules: Refs/Part-of referencing and fenced-anchor label stamping", () => {
    // INV-6/INV-7 of issue #4767's design concept: the authoring rule is
    // playbook prose, so this test pins the prose itself. A companion PR that
    // drifts back to a closing verb (negated or not) would re-wedge qa_target.
    // NB: assert via regex.test() + assert.fail, never assert.match — a
    // failed assert.match makes node:test render the whole playbook in the
    // failure detail, which can wedge the runner for minutes.
    const fragment = readFileSync(
      join(import.meta.dirname, "..", "docs/operator-playbooks/_fragments/hydra-dev-child-flow.md"),
      "utf-8",
    );
    const targetBuild = readFileSync(
      join(import.meta.dirname, "..", "docs/operator-playbooks/hydra-target-build.md"),
      "utf-8",
    );
    const expect = (src: string, re: RegExp, what: string) => {
      if (!re.test(src)) assert.fail(`playbook rule missing: ${what}`);
    };
    for (const [name, src] of [
      ["child-flow fragment", fragment],
      ["target-build Step 6.5", targetBuild],
    ] as const) {
      expect(src, /Refs #N/, `${name}: companion references the anchor as Refs #N`);
      expect(src, /Part of #N/, `${name}: companion references the anchor as Part of #N`);
      expect(src, /never\s+put\s+any\s+closing\s+verb/, `${name}: never put any closing verb next to #N`);
    }
    // The Target-only fence rule: a Refs #N companion is invisible to the
    // automerge fence's closingIssuesReferences resolution, so the fence label
    // must be stamped on the companion PR ITSELF, at creation, before CI ends.
    expect(targetBuild, /money-critical/, "fence label money-critical named");
    expect(targetBuild, /hold-for-operator/, "fence label hold-for-operator named");
    expect(
      targetBuild,
      /companion\s+PR\s+itself\s+at\s+creation,\s+BEFORE\s+its\s+CI\s+concludes/,
      "fence label stamped on the companion at creation, before its CI concludes",
    );
    expect(
      targetBuild,
      /never\s+becomes\s+merge-on-green\s+unreviewed/,
      "a companion of a fenced anchor never becomes merge-on-green unreviewed",
    );
  });
});
