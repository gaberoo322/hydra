/**
 * Regression test for issue #3851 — the in-flight dev-work exclusion's open-PR
 * body matcher now recognises the NON-closing reference keyword `Refs #N`.
 *
 * `scripts/autopilot/collect-state.sh` keeps an anchor dev_orch "has already
 * built, or is building" out of BOTH the `orch_pending_grill_anchor` and the
 * `orch_dev_ready_anchor` picks. One of its two evidence sources scans open PR
 * bodies for an issue reference. Pre-#3851 that scanner only recognised GitHub
 * *closing* keywords (`Closes`/`Fixes`/`Resolves #N`). A PR that deliberately
 * references its anchor with a NON-closing keyword — `Refs #N`, the correct
 * choice for a draft that must not auto-close its issue — was therefore
 * invisible to the exclusion. The sibling branch-name source did not rescue it
 * either: a harness-created `worktree-agent-<hash>` branch carries no issue
 * number, so all three sources missed it and `orch_dev_ready_anchor` promoted
 * an anchor that already had an open PR awaiting review (observed: PR #3802 on
 * branch `worktree-agent-a9a703393fd943448`, body line 42 `Refs #3708`).
 *
 * The fix broadens the body-keyword alternation to also match `refs?`. These
 * tests extract the ACTUAL python3 extraction block (and the candidate filter
 * that consumes it) from the committed script and run them against constructed
 * `gh pr list --json headRefName,body` / issue fixtures — so any drift in the
 * script's regex is caught here. This mirrors the extract-and-run discipline of
 * `test/autopilot-dev-orch-gate.test.mts`.
 *
 * The exclusion set is the single input BOTH picks derive from: the
 * `ORCH_GRILL_CANDIDATES` filter subtracts it, and both `orch_pending_grill_*`
 * and `orch_dev_ready_*` are drawn from that candidate list — so proving an
 * issue number enters the in-flight set IS proving it leaves both picks.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");

interface OpenPr {
  headRefName: string;
  body: string;
}

interface Issue {
  number: number;
  labels: { name: string }[];
}

/**
 * Pull a `python3 -c "<code>"` block out of collect-state.sh by its bash
 * assignment LHS (e.g. `ORCH_INFLIGHT_ISSUES`). The block may span many lines
 * and is terminated by `" 2>/dev/null || true)`. Returns the literal python
 * source so the test runs the committed logic, not a re-implementation.
 */
function extractPythonBlock(lhs: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const re = new RegExp(
    `${lhs}=[\\s\\S]*?python3 -c "([\\s\\S]*?)" 2>/dev/null \\|\\| true\\)`,
  );
  const m = src.match(re);
  assert.ok(m, `could not locate the ${lhs} python3 block in collect-state.sh`);
  return m[1];
}

/**
 * Run the `ORCH_INFLIGHT_ISSUES` extraction block against a constructed
 * `gh pr list --json headRefName,body` fixture and return the set of issue
 * numbers it marks as in-flight.
 */
function inflightIssues(prs: OpenPr[]): Set<number> {
  const code = extractPythonBlock("ORCH_INFLIGHT_ISSUES");
  const r = spawnSync("python3", ["-c", code], {
    input: JSON.stringify(prs),
    encoding: "utf-8",
  });
  assert.equal(
    r.status,
    0,
    `ORCH_INFLIGHT_ISSUES extractor exited non-zero: ${r.stderr}`,
  );
  const out = (r.stdout ?? "").trim();
  return new Set(out.length ? out.split(/\s+/).map(Number) : []);
}

/**
 * Run the `ORCH_GRILL_CANDIDATES` filter against a constructed ready-for-agent
 * issue list, with the given issue numbers pre-marked in-flight. Returns the
 * surviving candidate numbers in walk order. Both anchor picks are drawn from
 * this list, so an issue absent here can become NEITHER pick.
 */
function candidates(issues: Issue[], inflight: Set<number>): number[] {
  const code = extractPythonBlock("ORCH_GRILL_CANDIDATES");
  const r = spawnSync("python3", ["-c", code], {
    input: JSON.stringify(issues),
    encoding: "utf-8",
    env: {
      ...process.env,
      // The bash block threads the set through this env var as a
      // space-separated string; mirror that contract exactly.
      ORCH_INFLIGHT_ISSUES: [...inflight].sort((a, b) => a - b).join(" "),
    },
  });
  assert.equal(
    r.status,
    0,
    `ORCH_GRILL_CANDIDATES filter exited non-zero: ${r.stderr}`,
  );
  return (r.stdout ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

describe("collect-state.sh — in-flight dev-work exclusion (issue #3851)", () => {
  // ---- The headline fix: `Refs #N` is now recognised ----------------------

  test("`Refs #N` on a worktree-agent branch excludes N from BOTH picks (#3851)", () => {
    // The exact observed shape: PR #3802, head `worktree-agent-<hash>` (no
    // issue number in the name, so the branch source cannot help), body line
    // 42 `Refs #3708`. The "[BLOCKED on #3749]" context is a deliberate
    // non-closing ref — the PR must not auto-close #3708.
    const inflight = inflightIssues([
      {
        headRefName: "worktree-agent-a9a703393fd943448",
        body: "DO NOT MERGE\n\n[BLOCKED on #3749]\n\nRefs #3708\n",
      },
    ]);
    assert.ok(inflight.has(3708), "Refs #3708 must mark 3708 in-flight");
    assert.ok(
      !inflight.has(3749),
      "a bare 'on #3749' mention must NOT mark 3749 in-flight",
    );

    // Both picks derive from ORCH_GRILL_CANDIDATES, which subtracts the
    // in-flight set — so an in-flight N is dropped and can become neither
    // orch_pending_grill_anchor nor orch_dev_ready_anchor.
    const cands = candidates(
      [
        { number: 3708, labels: [] },
        { number: 3709, labels: [] },
      ],
      inflight,
    );
    assert.ok(
      !cands.includes(3708),
      "in-flight #3708 must be dropped from candidates → excluded from both picks",
    );
    assert.ok(
      cands.includes(3709),
      "unrelated #3709 must remain a candidate",
    );
  });

  test("`Ref #N` (singular) excludes N", () => {
    const inflight = inflightIssues([
      { headRefName: "worktree-agent-deadbeef", body: "Ref #42\n" },
    ]);
    assert.ok(inflight.has(42));
  });

  test("`Refs: #N` and `Ref: #N` (optional colon, as tolerated for Closes) exclude N", () => {
    const inflight = inflightIssues([
      { headRefName: "worktree-agent-a", body: "Refs: #7\n" },
      { headRefName: "worktree-agent-b", body: "Ref: #8\n" },
    ]);
    assert.ok(inflight.has(7));
    assert.ok(inflight.has(8));
  });

  test("`refs` / `REFS` are case-insensitive (the matcher uses re.IGNORECASE)", () => {
    const inflight = inflightIssues([
      { headRefName: "worktree-agent-a", body: "refs #11\n" },
      { headRefName: "worktree-agent-b", body: "REFS #12\n" },
    ]);
    assert.ok(inflight.has(11));
    assert.ok(inflight.has(12));
  });

  // ---- Existing sources still work (regression guard) ---------------------

  test("closing keywords Closes/Fixes/Resolves #N still exclude N", () => {
    const inflight = inflightIssues([
      { headRefName: "worktree-agent-a", body: "Closes #20\n" },
      { headRefName: "worktree-agent-b", body: "fixes #21\n" },
      { headRefName: "worktree-agent-c", body: "Resolved: #22\n" },
    ]);
    assert.ok(inflight.has(20), "Closes #N");
    assert.ok(inflight.has(21), "fixes #N");
    assert.ok(inflight.has(22), "Resolved: #N");
  });

  test("`issue-<N>-<slug>` head branch still excludes N (branch-name source)", () => {
    // This is the path that DOES carry an issue number; the body is irrelevant.
    const inflight = inflightIssues([
      { headRefName: "issue-30-fix-the-thing", body: "" },
    ]);
    assert.ok(inflight.has(30));
  });

  test("branch name and body refs both contribute (union of sources)", () => {
    const inflight = inflightIssues([
      { headRefName: "issue-40-slug", body: "Refs #41\n" },
      { headRefName: "worktree-agent-x", body: "Closes #42\n" },
    ]);
    assert.deepEqual([...inflight].sort((a, b) => a - b), [40, 41, 42]);
  });

  test("a single body with multiple distinct keyword refs contributes all of them", () => {
    // The extractor iterates every match (re.finditer) and accumulates into a
    // Python set(), so one PR body carrying BOTH a closing keyword and a Refs
    // keyword lands both issue numbers in the emitted set.
    const inflight = inflightIssues([
      { headRefName: "worktree-agent-x", body: "Closes #60\n\nRefs #61\n" },
    ]);
    assert.deepEqual([...inflight].sort((a, b) => a - b), [60, 61]);
  });

  test("a `worktree-agent-<hash>` branch with NO body ref marks nothing in-flight", () => {
    // This is exactly why the body-keyword source is load-bearing: the branch
    // name alone cannot recover an issue number, so without a body keyword the
    // anchor is (correctly) NOT excluded. Pre-#3851 `Refs #N` fell into this
    // gap too.
    const inflight = inflightIssues([
      { headRefName: "worktree-agent-cafebabe", body: "Just some work.\n" },
    ]);
    assert.equal(inflight.size, 0);
  });

  // ---- Deliberate non-goals: keyword-anchored, never bare #N --------------

  test("a BARE `#N` mention is NOT excluded (would starve dev_orch)", () => {
    // The issue is explicit: treating any bare `#N` as evidence would
    // false-exclude an issue merely mentioned in passing — the opposite
    // failure and a worse one. The predicate stays keyword-anchored.
    const inflight = inflightIssues([
      { headRefName: "worktree-agent-a", body: "see also #123 and #124\n" },
    ]);
    assert.ok(!inflight.has(123));
    assert.ok(!inflight.has(124));
    assert.equal(inflight.size, 0);
  });

  test("'blocked on #N' is NOT excluded (the #3851 PR's own body context)", () => {
    const inflight = inflightIssues([
      { headRefName: "worktree-agent-a", body: "[BLOCKED on #3749]\n" },
    ]);
    assert.ok(!inflight.has(3749));
  });

  test("'References #N' / 'referred to #N' are NOT excluded (over-broad match guard)", () => {
    // `refs?` must match only the keyword Ref/Refs, not every word beginning
    // with "ref" — the trailing `\s*:?\s+#` requires the `#N` immediately
    // after the keyword, so a longer word like "References" cannot match.
    const inflight = inflightIssues([
      { headRefName: "worktree-agent-a", body: "References #200\n" },
      { headRefName: "worktree-agent-b", body: "referred to #201\n" },
      { headRefName: "worktree-agent-c", body: "pref #202\n" },
    ]);
    assert.ok(!inflight.has(200), "'References #N' must not match");
    assert.ok(!inflight.has(201), "'referred to #N' must not match");
    assert.ok(!inflight.has(202), "'pref #N' must not match");
    assert.equal(inflight.size, 0);
  });

  // ---- Source-level guard --------------------------------------------------

  test("the body-keyword alternation includes refs? (drift guard for #3851)", () => {
    // If a future edit drops `refs?` from the regex, this fails loudly here
    // rather than silently re-opening the #3851 gap in production.
    const src = readFileSync(SCRIPT, "utf-8");
    assert.match(
      src,
      /resolve\[sd\]\?\|refs\?/,
      "the in-flight body-keyword regex must include `refs?` in its alternation",
    );
  });
});
