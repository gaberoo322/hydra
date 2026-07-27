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
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
  formatViolations,
  hashesMatch,
  isMachineCheckable,
  isMustNotInvariant,
  isSafeRepoRelativePath,
  normaliseInvariantText,
  parseAssertion,
  parseReconciliationSection,
  quoteMatchesInvariant,
  type FileReader,
  type Violation,
} from "../scripts/ci/design-concept-reconcile-check.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

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

  // --- the verdict reducer ------------------------------------------------

  const INVARIANTS = [
    "INV-1 The checker MUST live in scripts/ci/design-concept-reconcile-check.ts as pure functions.",
    "INV-2 MUST NOT deliver the enforcement as a new advisory workflow file.",
  ];
  const HASH = "8c0dfe60287afcf4f464b5e94c35e0fd";
  const FILES = {
    "scripts/ci/design-concept-reconcile-check.ts": "export function checkReconciliation() {}",
  };

  function goodBody(): string {
    return [
      "Closes #2528",
      "",
      RECONCILIATION_HEADING,
      "",
      "Artifact: `8c0dfe60287a`",
      '- INV-1: "The checker MUST live in scripts/ci" — verified by: `file-contains: scripts/ci/design-concept-reconcile-check.ts :: checkReconciliation`',
      '- INV-2: "MUST NOT deliver the enforcement as a new advisory workflow" — verified by: `file-absent: .github/workflows/design-concept-reconcile.yml`',
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

  test("a MUST-NOT invariant cannot be discharged with prose", () => {
    const v = run(
      goodBody().replace(
        "`file-absent: .github/workflows/design-concept-reconcile.yml`",
        "`manual: I checked, there is no workflow`",
      ),
    );
    const m = v.find((x) => x.code === "must-not-needs-machine-assertion");
    assert.ok(m, "expected must-not-needs-machine-assertion");
    assert.equal(m!.invariantIndex, 2);
    assert.equal(m!.invariant, INVARIANTS[1]);
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
    const v = run(
      goodBody().replace(
        "`file-absent: .github/workflows/design-concept-reconcile.yml`",
        "`file-exists: .github/workflows/design-concept-reconcile.yml`",
      ),
    );
    const f = v.find((x) => x.code === "assertion-failed");
    assert.ok(f, "expected assertion-failed");
    assert.equal(f!.invariant, INVARIANTS[1]);
    assert.match(f!.message, /expected:/);
    assert.match(f!.message, /observed:/);
  });

  test("an unparseable assertion blocks rather than passing silently", () => {
    const v = run(
      goodBody().replace("`file-absent: .github/workflows/design-concept-reconcile.yml`", "`I eyeballed it`"),
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

  test("formatViolations names every violation and the push-a-commit remedy", () => {
    const msg = formatViolations(run("no section"), 2528);
    assert.match(msg, /#2528/);
    assert.match(msg, /missing-section/);
    assert.match(msg, /PUSH A COMMIT/);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — the live CI gate
// ---------------------------------------------------------------------------

describe("design-concept reconciliation gate (CI adapter)", () => {
  /** Repo-rooted, traversal-guarded reader. Returns null for anything unreadable. */
  const readRepoFile: FileReader = (repoRelativePath) => {
    if (!isSafeRepoRelativePath(repoRelativePath)) return null;
    const abs = join(REPO_ROOT, repoRelativePath);
    if (!abs.startsWith(REPO_ROOT + sep)) return null;
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) return null;
      return readFileSync(abs, "utf8");
    } catch (err: any) {
      console.error(`[dc-reconcile] unreadable ${repoRelativePath}: ${err?.message ?? err}`);
      return null;
    }
  };

  /** Fail-open skip: log the reason, assert nothing. */
  const skip = (why: string): void => {
    console.error(`[dc-reconcile] skipped (fail-open): ${why}`);
  };

  test("the PR body reconciles the linked issue's design-concept invariants", async () => {
    // --- 1. PR body, from the webhook payload (no token, no rate limit). ----
    // GITHUB_EVENT_PATH is free and always present in Actions; `gh pr view`
    // would need GH_TOKEN exported into the `test` job (a ci.yml edit, T4) and
    // unauthenticated api.github.com is 60 req/hr per IP, which
    // `reference_gh_graphql_vs_rest_ratelimit` records exhausting under a
    // running autopilot.
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) return skip("no GITHUB_EVENT_PATH (local run)");

    let payload: any;
    try {
      payload = JSON.parse(readFileSync(eventPath, "utf8"));
    } catch (err: any) {
      return skip(`unreadable GITHUB_EVENT_PATH: ${err?.message ?? err}`);
    }
    if (!payload?.pull_request) return skip("event payload has no pull_request (push/schedule run)");

    const prBody: string = payload.pull_request.body ?? "";
    const anchorRef = extractAnchorRefFromPrBody(prBody);
    if (anchorRef === null) return skip("PR body has no Closes/Fixes/Resolves #N — not a dev PR");

    // --- 2. Artifact, from the local orchestrator. --------------------------
    const base = (process.env.HYDRA_API_BASE ?? "http://localhost:4000").replace(/\/$/, "");
    let artifact: any;
    try {
      const res = await fetch(`${base}/api/design-concepts/${anchorRef}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 404) return skip(`no design-concept artifact for issue #${anchorRef}`);
      if (!res.ok) return skip(`artifact fetch returned HTTP ${res.status} for issue #${anchorRef}`);
      artifact = await res.json();
    } catch (err: any) {
      // Orchestrator down / unreachable MUST NOT redden the merge gate.
      return skip(`artifact fetch failed for issue #${anchorRef}: ${err?.message ?? err}`);
    }

    const invariants: string[] = Array.isArray(artifact?.invariants) ? artifact.invariants : [];
    const artifactHash: string = typeof artifact?.artifactHash === "string" ? artifact.artifactHash : "";
    if (invariants.length === 0) return skip(`artifact for issue #${anchorRef} declares no invariants`);
    if (artifactHash.length === 0) return skip(`artifact for issue #${anchorRef} has no artifactHash`);

    // --- 3. Fail CLOSED from here on. ---------------------------------------
    const violations = checkReconciliation({ prBody, invariants, artifactHash, readFile: readRepoFile });
    assert.deepEqual(violations, [], formatViolations(violations, anchorRef));
  });
});
