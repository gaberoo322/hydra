/**
 * Regression test for issue #3851 — the in-flight dev-work exclusion's open-PR
 * body matcher recognises the NON-closing reference keyword `Refs #N` — now
 * exercising the SHARED predicate (issue #4334).
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
 * Since issue #4334 the reference-detection regexes live in ONE place —
 * `scripts/autopilot/pr-refs.py` — and collect-state.sh computes all three of
 * its in-flight sets by piping the `gh pr list --json headRefName,body`
 * payload through that script (no selector = the union, `--source branch` /
 * `--source body` = the per-channel subsets its Candidate Exclusion telemetry
 * attributes, issue #3964). These tests therefore run the REAL pr-refs.py
 * exactly the way collect-state.sh invokes it, plus the candidate filter it
 * feeds — so any drift in the shared regex is caught here. The
 * `ORCH_GRILL_CANDIDATES` filter is still an inline python3 heredoc in
 * collect-state.sh (it is a candidate filter, not a reference predicate), so
 * that one block is still extracted from the committed script and run
 * directly, mirroring the extract-and-run discipline of
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
const PR_REFS = join(REPO_ROOT, "scripts", "autopilot", "pr-refs.py");

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
 * assignment LHS (e.g. `ORCH_GRILL_CANDIDATES`). The block may span many lines
 * and is terminated by `" 2>/dev/null || true)`. Returns the literal python
 * source so the test runs the committed logic, not a re-implementation.
 */
function extractPythonBlock(lhs: string): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const re = new RegExp(
    `${lhs}=[\\s\\S]*?python3 -c "\\$\\(cat <<'PY'([\\s\\S]*?)\\nPY\\n\\)" 2>/dev/null \\|\\| true\\)`,
  );
  const m = src.match(re);
  assert.ok(m, `could not locate the ${lhs} python3 block in collect-state.sh`);
  return m[1];
}

/**
 * Run the REAL shared predicate — scripts/autopilot/pr-refs.py — against a
 * constructed `gh pr list --json headRefName,body` payload, exactly the way
 * collect-state.sh invokes it. `selector` mirrors the CLI flags: no selector
 * = the union (ORCH_INFLIGHT_ISSUES), "--source branch" and "--source body"
 * = the per-channel subsets (ORCH_INFLIGHT_BRANCH_ISSUES /
 * ORCH_INFLIGHT_BODYREF_ISSUES). Returns the set of issue numbers it marks
 * as in-flight.
 */
function runPrRefs(
  payload: OpenPr[] | string,
  ...selector: string[]
): { status: number | null; stdout: string; stderr: string } {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const r = spawnSync("python3", [PR_REFS, ...selector], {
    input,
    encoding: "utf-8",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function parseSet(stdout: string): Set<number> {
  const out = stdout.trim();
  return new Set(out.length ? out.split(/\s+/).map(Number) : []);
}

function inflightIssues(prs: OpenPr[]): Set<number> {
  const r = runPrRefs(prs);
  assert.equal(
    r.status,
    0,
    `pr-refs.py (union) exited non-zero: ${r.stderr}`,
  );
  return parseSet(r.stdout);
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
    // The predicate iterates every match (re.finditer) and accumulates into a
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
    // If a future edit drops `refs?` from the shared regex in pr-refs.py,
    // this fails loudly here rather than silently re-opening the #3851 gap in
    // production. Since #4334 the regex lives ONLY in pr-refs.py —
    // collect-state.sh carries no inline copy — so the guard points there.
    const src = readFileSync(PR_REFS, "utf-8");
    assert.match(
      src,
      /resolve\[sd\]\?\|refs\?/,
      "the shared body-keyword regex in pr-refs.py must include `refs?` in its alternation",
    );
  });
});

describe("collect-state.sh — in-flight exclusion delegates to pr-refs.py (issue #4334)", () => {
  // ---- Delegation shape: one predicate, zero inline copies -----------------

  test("all three in-flight sets are piped through the shared pr-refs.py (no inline regex copies)", () => {
    // The dedupe contract: collect-state.sh must carry ZERO hand-written
    // copies of the branch-prefix / body-keyword regexes. Every one of the
    // three in-flight assignments invokes scripts/autopilot/pr-refs.py —
    // the union with no selector, and `--source branch` / `--source body`
    // for the per-channel subsets the #3964 Candidate Exclusion telemetry
    // attributes. A reintroduced inline heredoc here is the exact drift this
    // PR removed (#4334).
    const src = readFileSync(SCRIPT, "utf-8");
    for (const line of [
      `ORCH_INFLIGHT_ISSUES=$(printf '%s' "$ORCH_INFLIGHT_PR_JSON" | python3 "$SCRIPT_DIR/pr-refs.py" 2>/dev/null || true)`,
      `ORCH_INFLIGHT_BRANCH_ISSUES=$(printf '%s' "$ORCH_INFLIGHT_PR_JSON" | python3 "$SCRIPT_DIR/pr-refs.py" --source branch 2>/dev/null || true)`,
      `ORCH_INFLIGHT_BODYREF_ISSUES=$(printf '%s' "$ORCH_INFLIGHT_PR_JSON" | python3 "$SCRIPT_DIR/pr-refs.py" --source body 2>/dev/null || true)`,
    ]) {
      assert.ok(src.includes(line), `collect-state.sh must invoke: ${line}`);
    }
    // And the regexes themselves are gone from the script: no inline copy of
    // the branch-prefix pattern or the body-keyword alternation may remain.
    assert.doesNotMatch(
      src,
      /issue-\(\\d\+\)/,
      "collect-state.sh must not carry an inline copy of the issue-(\\d+) branch regex",
    );
    assert.doesNotMatch(
      src,
      /close\[sd\]\?/,
      "collect-state.sh must not carry an inline copy of the body-keyword alternation",
    );
    // Exactly the three orch delegating invocations PLUS the one Target
    // in-flight invocation (issue #4474) — a fifth copy-paste call site would
    // be new duplication of a different kind.
    const calls = src.match(/python3 "\$SCRIPT_DIR\/pr-refs\.py"/g) ?? [];
    assert.equal(calls.length, 4, "expected exactly four pr-refs.py invocations");
  });

  test("collect-state.sh resolves pr-refs.py relative to its own file (SCRIPT_DIR idiom)", () => {
    // Mirrors recover-stale.sh's idiom (issue #3852) so the predicate is
    // found regardless of how $0 was passed — a relative invocation or a
    // worktree path must never silently miss the sibling file.
    const src = readFileSync(SCRIPT, "utf-8");
    assert.match(
      src,
      /SCRIPT_DIR=\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]:-\$0\}"\)" && pwd\)/,
      "collect-state.sh must define SCRIPT_DIR via the BASH_SOURCE idiom",
    );
  });

  // ---- The per-source selectors the #3964 telemetry consumes ----------------

  test("--source branch returns the branch-name channel only", () => {
    const r = runPrRefs(
      [
        { headRefName: "issue-40-slug", body: "Refs #41\n" },
        { headRefName: "worktree-agent-x", body: "Closes #42\n" },
      ],
      "--source",
      "branch",
    );
    assert.equal(r.status, 0, `--source branch exited non-zero: ${r.stderr}`);
    assert.deepEqual([...parseSet(r.stdout)].sort((a, b) => a - b), [40]);
  });

  test("--source body returns the body-keyword channel only", () => {
    const r = runPrRefs(
      [
        { headRefName: "issue-40-slug", body: "Refs #41\n" },
        { headRefName: "worktree-agent-x", body: "Closes #42\n" },
      ],
      "--source",
      "body",
    );
    assert.equal(r.status, 0, `--source body exited non-zero: ${r.stderr}`);
    assert.deepEqual([...parseSet(r.stdout)].sort((a, b) => a - b), [41, 42]);
  });

  test("zero-argument invocation prints the sorted union (recover-stale.sh / parent-flow contract)", () => {
    // recover-stale.sh and the hydra-dev parent flow call pr-refs.py with NO
    // arguments; that zero-arg surface must keep printing the UNION of both
    // channels, space-separated and sorted — never a single channel.
    const r = runPrRefs([
      { headRefName: "issue-9-b", body: "Refs #2\n" },
      { headRefName: "worktree-agent-x", body: "Closes #1\n" },
    ]);
    assert.equal(r.status, 0, `zero-arg invocation exited non-zero: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "1 2 9");
  });

  // ---- Fail-open degrade contract (never-abort) -----------------------------

  test("fail-open degrade: empty / non-JSON / non-list stdin prints nothing and exits 0 for every --source value", () => {
    // The never-abort contract every caller relies on: a failed `gh pr list`
    // (empty payload), a mangled payload, or a non-list JSON top level must
    // print NOTHING and exit 0 for all three selector values — the empty set
    // is the caller's "no open PR" signal, which falls through to today's
    // behaviour (no exclusion / re-queue to ready-for-agent).
    const badPayloads: string[] = [
      "",
      "not json at all",
      '{"degraded": true}', // valid JSON, wrong shape (object, not list)
      "42", // valid JSON, wrong shape (scalar)
      "[1, 2]", // list of non-dicts
    ];
    const selectors: string[][] = [[], ["--source", "branch"], ["--source", "body"]];
    for (const selector of selectors) {
      for (const payload of badPayloads) {
        const r = runPrRefs(payload, ...selector);
        assert.equal(
          r.status,
          0,
          `pr-refs.py ${selector.join(" ")} must exit 0 on bad stdin (${JSON.stringify(payload)}): ${r.stderr}`,
        );
        assert.equal(
          r.stdout,
          "",
          `pr-refs.py ${selector.join(" ")} must print nothing on bad stdin (${JSON.stringify(payload)})`,
        );
      }
    }
  });

  test("an unknown selector is rejected loudly (exit 2), never silently misread", () => {
    // A typo'd --source value must not silently fall back to the union: the
    // bash call sites wrap this in `2>/dev/null || true`, so a loud exit 2
    // degrades to the documented empty-set no-op while staying diagnosable
    // when run by hand.
    const r = runPrRefs([{ headRefName: "issue-1-x", body: "" }], "--source", "bogus");
    assert.notEqual(r.status, 0, "--source bogus must exit non-zero");
  });
});

/**
 * Regression tests for issue #4240's PR-gate classification block in
 * `scripts/autopilot/collect-state.sh` — closing two gaps a T3 adversarial QA
 * review found in the original PR (#4433). Folded into this file (rather than
 * a standalone one) because it shares the same subject and the same
 * extract-and-run discipline as the suite above — a fresh file here would
 * trip the test-file sprawl ratchet (#4134) for zero benefit.
 *
 * 1. A `mergeStateStatus=BEHIND` PR that is NOT yet quiescent (pushed within
 *    the last 5400s) fell through the `behind` branch's `continue` (it only
 *    fires once quiescent) and, if its `statusCheckRollup` was momentarily
 *    empty, was misclassified into `orch_prs_unchecked` — the `unchecked`
 *    branch excluded only `state in ("DIRTY", "UNKNOWN")`, not `"BEHIND"`.
 *    That produced a false "CI never started" `surface-pr {cause: unchecked}`
 *    signal on a PR that was actually mid-rebase-cycle.
 * 2. The `behind` branch itself had no `isDraft` exclusion, unlike the
 *    `dirty` and `unchecked` branches — so a draft PR that was genuinely
 *    BEHIND and quiescent landed in `orch_prs_behind`, and decide.py's
 *    `_rule_pr_gate` would emit a live `update-branch` against a draft PR,
 *    violating the design-concept artifact's stated INV-H ("an isDraft PR
 *    ... is classified into NO bucket").
 *
 * This test runs the REAL embedded python block extracted verbatim out of
 * the committed script (same extract-and-run discipline as the suite above),
 * so any regression in the committed classification logic is caught here
 * directly rather than via a re-implementation.
 */

interface PrGateOpenPr {
  number: number;
  mergeStateStatus: string;
  statusCheckRollup: unknown[];
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  labels: { name: string }[];
}

/**
 * Extract the PR-gate classification python block verbatim from
 * collect-state.sh. Anchored on the unique `def epoch(ts):` docstring text
 * this block introduces (issue #4240) so it is not confused with any of the
 * file's ~30 other `python3 -c "$(cat <<'PY' ... PY)"` blocks.
 */
function extractPrGatePythonBlock(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const re =
    /python3 -c "\$\(cat <<'PY'\n(import json\nimport os\nimport sys\nfrom datetime import datetime, timezone[\s\S]*?)\nPY\n\)"/;
  const m = src.match(re);
  assert.ok(
    m,
    "could not locate the PR-gate classification python block (issue #4240) in collect-state.sh",
  );
  return m[1];
}

/** ISO8601 timestamp `secondsAgo` seconds before now, matching the script's
 * `%Y-%m-%dT%H:%M:%SZ` parse format. */
function isoSecondsAgo(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

interface PrGateBuckets {
  dirty: number[];
  unchecked: number[];
  behind: number[];
  ciTriggerStale: boolean;
}

function runPrGate(prs: PrGateOpenPr[]): PrGateBuckets {
  const code = extractPrGatePythonBlock();
  const r = spawnSync("python3", ["-c", code], {
    input: JSON.stringify(prs),
    encoding: "utf-8",
    env: {
      ...process.env,
      ORCH_PR_UNCHECKED_GRACE_SECONDS: "600",
      ORCH_PR_RUN_PUSH_CREATED: "",
      ORCH_PR_RUN_PR_CREATED: "",
    },
  });
  assert.equal(
    r.status,
    0,
    `PR-gate classification block exited non-zero: ${r.stderr}`,
  );
  const lines = r.stdout.trim().split("\n");
  const parsed: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    parsed[line.slice(0, idx)] = line.slice(idx + 1);
  }
  const nums = (s: string | undefined) =>
    (s ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  return {
    dirty: nums(parsed.orch_prs_dirty),
    unchecked: nums(parsed.orch_prs_unchecked),
    behind: nums(parsed.orch_prs_behind),
    ciTriggerStale: parsed.orch_ci_trigger_stale === "true",
  };
}

function basePrGate(overrides: Partial<PrGateOpenPr>): PrGateOpenPr {
  return {
    number: 9001,
    mergeStateStatus: "BEHIND",
    statusCheckRollup: [],
    createdAt: isoSecondsAgo(7200),
    updatedAt: isoSecondsAgo(7200),
    isDraft: false,
    labels: [],
    ...overrides,
  };
}

describe("collect-state.sh — PR-gate BEHIND/draft classification (issue #4240)", () => {
  test("a BEHIND PR pushed moments ago with an empty rollup is NOT misclassified unchecked", () => {
    const pr = basePrGate({
      number: 4290,
      updatedAt: isoSecondsAgo(30), // well inside the 5400s quiescence window
      statusCheckRollup: [],
    });
    const buckets = runPrGate([pr]);
    assert.deepEqual(
      buckets.unchecked,
      [],
      "a recently-pushed BEHIND PR must never land in orch_prs_unchecked",
    );
    assert.deepEqual(
      buckets.behind,
      [],
      "a not-yet-quiescent BEHIND PR must not land in orch_prs_behind either — it is simply not surfaced yet",
    );
  });

  test("a quiescent, non-draft BEHIND PR still lands in orch_prs_behind (positive control)", () => {
    const pr = basePrGate({
      number: 4246,
      updatedAt: isoSecondsAgo(7200),
      isDraft: false,
    });
    const buckets = runPrGate([pr]);
    assert.deepEqual(buckets.behind, [4246]);
    assert.deepEqual(buckets.unchecked, []);
  });

  test("a draft PR that is BEHIND and quiescent is excluded from orch_prs_behind (INV-H)", () => {
    const pr = basePrGate({
      number: 4311,
      updatedAt: isoSecondsAgo(7200), // past the 5400s quiescence window
      isDraft: true,
    });
    const buckets = runPrGate([pr]);
    assert.deepEqual(
      buckets.behind,
      [],
      "a draft PR must never be classified into orch_prs_behind — decide.py would emit a live update-branch against it",
    );
    assert.deepEqual(buckets.unchecked, []);
    assert.deepEqual(buckets.dirty, []);
  });

  test("a non-BEHIND, non-draft, aged PR with an empty rollup still lands in orch_prs_unchecked (positive control)", () => {
    const pr = basePrGate({
      number: 4237,
      mergeStateStatus: "CLEAN",
      createdAt: isoSecondsAgo(1200), // past the 600s default grace window
      updatedAt: isoSecondsAgo(1200),
      statusCheckRollup: [],
    });
    const buckets = runPrGate([pr]);
    assert.deepEqual(buckets.unchecked, [4237]);
    assert.deepEqual(buckets.behind, []);
  });
});

// -----------------------------------------------------------------------------
// Target-lane in-flight PR exclusion (issue #4474, CSB swap prep)
// -----------------------------------------------------------------------------
//
// The orch lane already excludes `ready-for-agent` issues with an open PR
// (the describes above); the Target lane never got the same wiring, so
// `decide.py` could dispatch `dev_target` onto a Target issue that already
// has an open PR carrying `Closes #N`. collect-state.sh's
// `collect_target_board` now composes the raw `target_ready_for_agent` count
// (from either the healthy `scope=target` board-state read or the direct-`gh`
// fallback) with a Target-repo in-flight exclusion piped through the SAME
// shared predicate — `pr-refs.py` — invoked against `$TARGET_GH_REPO` instead
// of a second hand-rolled regex. This is a fresh top-level `describe` (not
// nested in the orch describes above) — it shares no Redis/teardown state
// with them, it just extracts a different literal python3 block out of the
// same committed script and runs it directly against fixtures, exactly the
// extract-and-run discipline the file already uses for `ORCH_GRILL_CANDIDATES`.

describe("collect-state.sh — target_ready_for_agent in-flight PR exclusion (issue #4474)", () => {
  const RAW_COUNTS = [
    "target_ready_for_agent=3",
    "target_needs_qa=1",
    "target_needs_triage=2",
    "target_needs_research=0",
  ].join("\n");

  /**
   * Pull the literal python3 block collect-state.sh pipes `$TARGET_RAW_COUNTS`
   * through (the block that subtracts the in-flight/ready-for-agent
   * intersection from `target_ready_for_agent`) out of the committed script,
   * so this test runs the REAL logic rather than a re-implementation.
   */
  function extractTargetExclusionBlock(): string {
    const src = readFileSync(SCRIPT, "utf-8");
    const re = new RegExp(
      `TARGET_RFA_ITEMS_JSON="\\$TARGET_RFA_ITEMS_JSON" python3 -c "\\$\\(cat <<'PY'([\\s\\S]*?)\\nPY\\n\\)"`,
    );
    const m = src.match(re);
    assert.ok(
      m,
      "could not locate the target in-flight exclusion python3 block in collect-state.sh",
    );
    return m[1];
  }

  function runExclusion(
    rawCounts: string,
    inflight: number[],
    rfaItemsJson: string,
  ): { status: number | null; stdout: string; stderr: string } {
    const code = extractTargetExclusionBlock();
    const r = spawnSync("python3", ["-c", code], {
      input: rawCounts,
      encoding: "utf-8",
      env: {
        ...process.env,
        TARGET_INFLIGHT_ISSUES: [...inflight].sort((a, b) => a - b).join(" "),
        TARGET_RFA_ITEMS_JSON: rfaItemsJson,
      },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function rfaItems(numbers: number[]): string {
    return JSON.stringify(numbers.map((number) => ({ number })));
  }

  function parseCounts(stdout: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const [k, v] = line.split("=");
      out[k] = Number(v);
    }
    return out;
  }

  test("an in-flight ready-for-agent issue is subtracted from target_ready_for_agent", () => {
    const r = runExclusion(RAW_COUNTS, [101], rfaItems([100, 101, 102]));
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    const counts = parseCounts(r.stdout);
    assert.equal(
      counts.target_ready_for_agent,
      2,
      "one of the three ready-for-agent issues already has an open PR — count drops by 1",
    );
    assert.equal(counts.target_needs_qa, 1, "sibling counts pass through unchanged");
    assert.equal(counts.target_needs_triage, 2);
    assert.equal(counts.target_needs_research, 0);
  });

  test("an in-flight issue that is NOT labelled ready-for-agent does not affect the count", () => {
    const r = runExclusion(RAW_COUNTS, [999], rfaItems([100, 101]));
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(
      parseCounts(r.stdout).target_ready_for_agent,
      3,
      "#999 is not in the ready-for-agent set, so nothing is excluded",
    );
  });

  test("multiple in-flight ready-for-agent issues each subtract one", () => {
    const r = runExclusion(RAW_COUNTS, [100, 101], rfaItems([100, 101, 102]));
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(parseCounts(r.stdout).target_ready_for_agent, 1);
  });

  test("the exclusion never drives the count negative (clamped at 0)", () => {
    const r = runExclusion(
      "target_ready_for_agent=1\ntarget_needs_qa=0\ntarget_needs_triage=0\ntarget_needs_research=0",
      [1, 2, 3],
      rfaItems([1, 2, 3]),
    );
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(parseCounts(r.stdout).target_ready_for_agent, 0);
  });

  test("an empty in-flight set (failed PR-list read, or genuinely none open) excludes nothing", () => {
    const r = runExclusion(RAW_COUNTS, [], rfaItems([100, 101]));
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(
      parseCounts(r.stdout).target_ready_for_agent,
      3,
      "an empty in-flight set is the fail-CLOSED 'exclude nothing' behaviour (issue #4474)",
    );
  });

  test("an unreadable TARGET_RFA_ITEMS_JSON (failed read) excludes nothing rather than crashing", () => {
    const r = runExclusion(RAW_COUNTS, [101], "");
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(
      parseCounts(r.stdout).target_ready_for_agent,
      3,
      "an unreadable ready-for-agent item list must fail CLOSED to exclude nothing, not crash or re-zero",
    );
  });

  test("a non-list TARGET_RFA_ITEMS_JSON payload excludes nothing rather than crashing", () => {
    const r = runExclusion(RAW_COUNTS, [101], '{"degraded": true}');
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(parseCounts(r.stdout).target_ready_for_agent, 3);
  });

  // ---- repo parameterisation + shared predicate reuse ------------------------

  test("the Target PR-list read is parameterised by $TARGET_GH_REPO, never a literal", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    assert.match(
      src,
      /gh pr list --repo "\$TARGET_GH_REPO" --state open --limit "\$GH_ISSUE_LIST_LIMIT" --json number,headRefName,body/,
      "the Target in-flight PR-list read must use $TARGET_GH_REPO, not a literal repo string",
    );
  });

  test("the ready-for-agent item read is also parameterised by $TARGET_GH_REPO", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    assert.match(
      src,
      /gh issue list --repo "\$TARGET_GH_REPO" --state open --label ready-for-agent --limit "\$GH_ISSUE_LIST_LIMIT" --json number/,
    );
  });

  test("the Target in-flight predicate reuses the shared pr-refs.py script (no second hand-rolled regex)", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    assert.ok(
      src.includes(
        `TARGET_INFLIGHT_ISSUES=$(printf '%s' "$TARGET_INFLIGHT_PR_JSON" | python3 "$SCRIPT_DIR/pr-refs.py" 2>/dev/null || true)`,
      ),
      "collect-state.sh must resolve Target in-flight issues via the shared pr-refs.py, not an inline regex",
    );
  });

  test("a failed Target PR-list read logs a stderr note naming issue #4474 (fail-CLOSED, not silent)", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    assert.match(
      src,
      /target pr-list read FAILED \(empty payload\) — target_ready_for_agent in-flight exclusion fails CLOSED to 'exclude nothing' \(issue #4474\)/,
    );
  });
});
