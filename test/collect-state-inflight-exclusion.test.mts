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
    // Exactly the three delegating invocations — a fourth copy-paste call
    // site would be new duplication of a different kind.
    const calls = src.match(/python3 "\$SCRIPT_DIR\/pr-refs\.py"/g) ?? [];
    assert.equal(calls.length, 3, "expected exactly three pr-refs.py invocations");
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
  /** Present on the live `gh pr list` payload; the #4460 predicate reads it. */
  headRefName?: string;
  body?: string;
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
  /** issue #4460: the GLM red-PR debug bucket + forward-fix pick. */
  glmRed: number[];
  glmRedForwardFix: string;
}

interface PrGateEnvOverrides {
  /** Failed reads (empty string) are how INV-5's fail-closed path is exercised. */
  requiredContextsJson?: string;
  devResumeIssuesJson?: string;
  glmRedQuiescenceSeconds?: string;
}

function runPrGate(
  prs: PrGateOpenPr[],
  overrides: PrGateEnvOverrides = {},
): PrGateBuckets {
  const code = extractPrGatePythonBlock();
  // The live required-check contexts (branch protection's .contexts — the
  // #4460 classifier reads required-ness from here, never from the rollup's
  // isRequired=null field). Defaults to the repo's real 8 so the common
  // #4460 cases need no per-case env.
  const REQUIRED = [
    "test",
    "dashboard-build",
    "tier-gate",
    "mutation-test",
    "scope-check",
    "secret-scan",
    "deep-qa-gate",
    "design-concept-reconcile",
  ];
  const r = spawnSync("python3", ["-c", code], {
    input: JSON.stringify(prs),
    encoding: "utf-8",
    env: {
      ...process.env,
      ORCH_PR_UNCHECKED_GRACE_SECONDS: "600",
      ORCH_PR_RUN_PUSH_CREATED: "",
      ORCH_PR_RUN_PR_CREATED: "",
      ORCH_REQUIRED_CONTEXTS_JSON:
        overrides.requiredContextsJson ?? JSON.stringify(REQUIRED),
      ORCH_DEV_RESUME_ISSUES_JSON:
        overrides.devResumeIssuesJson ?? "[]",
      ORCH_GLM_RED_QUIESCENCE_SECONDS:
        overrides.glmRedQuiescenceSeconds ?? "1800",
      ORCH_PR_REFS_PY: PR_REFS,
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
    glmRed: nums(parsed.orch_prs_glm_red),
    glmRedForwardFix: parsed.orch_glm_red_forward_fix ?? "",
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

/**
 * Issue #4460 — the GLM red-PR forward-fix predicate (INV-2/3/4/5), running
 * the REAL embedded python block like the suite above.
 *
 * A rollup of all 8 required contexts green except one FAILURE is the base
 * qualifying shape; each case mutates exactly one predicate arm and asserts
 * the PR drops out. The pick (`orch_glm_red_forward_fix`) is the
 * lowest-numbered qualifier, emitted as `issue-<N>:<pr>:<headRefName>`.
 */
describe("collect-state.sh — GLM red-PR forward-fix predicate (issue #4460)", () => {
  interface RollupEntry {
    __typename?: string;
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
    startedAt?: string;
  }

  /** All 8 required contexts present: `red` FAILURE, everything else SUCCESS. */
  function fullRequiredRollup(red?: string, extra: RollupEntry[] = []): RollupEntry[] {
    const names = [
      "test",
      "dashboard-build",
      "tier-gate",
      "mutation-test",
      "scope-check",
      "secret-scan",
      "deep-qa-gate",
      "design-concept-reconcile",
    ];
    const out: RollupEntry[] = names.map((name) =>
      name === red
        ? {
            __typename: "CheckRun",
            name,
            status: "COMPLETED",
            conclusion: "FAILURE",
            startedAt: isoSecondsAgo(7000),
          }
        : {
            __typename: "CheckRun",
            name,
            status: "COMPLETED",
            conclusion: "SUCCESS",
            startedAt: isoSecondsAgo(7000),
          },
    );
    return [...out, ...extra];
  }

  function baseGlmPr(overrides: Partial<PrGateOpenPr> = {}): PrGateOpenPr {
    return basePrGate({
      number: 4433,
      mergeStateStatus: "BLOCKED",
      headRefName: "worktree-agent-glm-4240-1789",
      body: "Closes #4240",
      labels: [],
      updatedAt: isoSecondsAgo(7200), // past the 1800s quiescence default
      statusCheckRollup: fullRequiredRollup("test"),
      ...overrides,
    });
  }

  test("a qualifying GLM red PR (branch-prefix provenance, red required `test`) yields the forward-fix pick", () => {
    const buckets = runPrGate([baseGlmPr()]);
    assert.deepEqual(buckets.glmRed, [4433]);
    assert.equal(
      buckets.glmRedForwardFix,
      "issue-4240:4433:worktree-agent-glm-4240-1789",
    );
  });

  test("glm-authored LABEL provenance also qualifies (INV-3a OR-predicate, same as #4048)", () => {
    const pr = baseGlmPr({
      number: 4450,
      headRefName: "issue-4450-not-a-worktree-branch",
      labels: [{ name: "glm-authored" }],
      body: "Closes #4450",
    });
    const buckets = runPrGate([pr]);
    assert.equal(buckets.glmRedForwardFix, "issue-4450:4450:issue-4450-not-a-worktree-branch");
  });

  test("an advisory (non-required) FAILURE never qualifies (INV-4)", () => {
    const pr = baseGlmPr({
      statusCheckRollup: fullRequiredRollup(undefined, [
        {
          __typename: "CheckRun",
          name: "advisory-checks",
          status: "COMPLETED",
          conclusion: "FAILURE",
          startedAt: isoSecondsAgo(7000),
        },
      ]),
    });
    const buckets = runPrGate([pr]);
    assert.deepEqual(buckets.glmRed, []);
    assert.equal(buckets.glmRedForwardFix, "none");
  });

  test("CANCELLED on a required check is NOT red — dedupe keeps the LATEST entry (INV-4)", () => {
    // PR #4478's observed shape: changelog-check CANCELLED then SUCCESS. Here
    // the red `test` FAILURE is superseded by a LATER CANCELLED entry.
    const pr = baseGlmPr({
      statusCheckRollup: fullRequiredRollup("test", [
        {
          __typename: "CheckRun",
          name: "test",
          status: "COMPLETED",
          conclusion: "CANCELLED",
          startedAt: isoSecondsAgo(6900), // later startedAt than the FAILURE
        },
      ]),
    });
    const buckets = runPrGate([pr]);
    assert.deepEqual(buckets.glmRed, [], "CANCELLED must never arm a dispatch");
  });

  test("a still-PENDING required check disqualifies (INV-3e) — even with another check red", () => {
    const pr = baseGlmPr({
      statusCheckRollup: fullRequiredRollup("test").slice(0, -1), // drop design-concept-reconcile
    });
    const buckets = runPrGate([pr]);
    assert.deepEqual(buckets.glmRed, []);
  });

  test("a non-GLM PR with an identical red required check never qualifies (INV-3a)", () => {
    const pr = baseGlmPr({
      headRefName: "issue-4240-plain-branch",
      labels: [],
    });
    const buckets = runPrGate([pr]);
    assert.deepEqual(buckets.glmRed, []);
    assert.equal(buckets.glmRedForwardFix, "none");
  });

  test("not-yet-quiescent (updatedAt inside the 1800s window) disqualifies (INV-3c)", () => {
    const pr = baseGlmPr({ updatedAt: isoSecondsAgo(300) });
    const buckets = runPrGate([pr]);
    assert.deepEqual(buckets.glmRed, []);
  });

  test("draft / ready-for-human / DIRTY / UNKNOWN each disqualify (INV-3b)", () => {
    for (const [name, over] of [
      ["draft", { isDraft: true }],
      ["ready-for-human", { labels: [{ name: "ready-for-human" }] }],
      ["DIRTY", { mergeStateStatus: "DIRTY" }],
      ["UNKNOWN", { mergeStateStatus: "UNKNOWN" }],
    ] as const) {
      const buckets = runPrGate([baseGlmPr(over as Partial<PrGateOpenPr>)]);
      assert.deepEqual(buckets.glmRed, [], `${name} must disqualify`);
    }
  });

  test("exactly-one closing issue is required — two closing refs and zero both disqualify (INV-3d)", () => {
    for (const body of ["Closes #4240\n\nCloses #9999", "Refs #4240"]) {
      const buckets = runPrGate([baseGlmPr({ body })]);
      assert.deepEqual(buckets.glmRed, [], `body "${body}" must disqualify`);
    }
  });

  test("the needs-dev-resume arm qualifies an all-green GLM PR whose closed issue carries the label (INV-3f)", () => {
    const pr = baseGlmPr({
      statusCheckRollup: fullRequiredRollup(), // every required check SUCCESS
    });
    const buckets = runPrGate([pr], {
      devResumeIssuesJson: JSON.stringify([{ number: 4240 }]),
    });
    assert.deepEqual(buckets.glmRed, [4433]);
    assert.equal(
      buckets.glmRedForwardFix,
      "issue-4240:4433:worktree-agent-glm-4240-1789",
    );
  });

  test("a StatusContext FAILURE on a required context is red (deep-qa-gate commit status shape)", () => {
    const rollup = fullRequiredRollup().map((e) =>
      e.name === "deep-qa-gate"
        ? {
            __typename: "StatusContext",
            context: "deep-qa-gate",
            state: "FAILURE",
            startedAt: isoSecondsAgo(7000),
          }
        : e,
    );
    const buckets = runPrGate([baseGlmPr({ statusCheckRollup: rollup })]);
    assert.deepEqual(buckets.glmRed, [4433]);
  });

  test("the LOWEST-numbered qualifying PR wins the pick; the debug bucket is sorted (INV-2)", () => {
    const later = baseGlmPr({
      number: 4470,
      headRefName: "worktree-agent-glm-4266-1",
      body: "Closes #4266",
    });
    const earlier = baseGlmPr({
      number: 4465,
      headRefName: "worktree-agent-glm-4300-1",
      body: "Closes #4300",
    });
    const buckets = runPrGate([later, earlier]);
    assert.deepEqual(buckets.glmRed, [4465, 4470]);
    assert.equal(buckets.glmRedForwardFix, "issue-4300:4465:worktree-agent-glm-4300-1");
  });

  test("a failed required-contexts read fails CLOSED: empty buckets + stderr note, never a dispatch pick (INV-5)", () => {
    const r = spawnSync("python3", ["-c", extractPrGatePythonBlock()], {
      input: JSON.stringify([baseGlmPr()]),
      encoding: "utf-8",
      env: {
        ...process.env,
        ORCH_PR_UNCHECKED_GRACE_SECONDS: "600",
        ORCH_PR_RUN_PUSH_CREATED: "",
        ORCH_PR_RUN_PR_CREATED: "",
        ORCH_REQUIRED_CONTEXTS_JSON: "", // the read failed upstream
        ORCH_DEV_RESUME_ISSUES_JSON: "[]",
        ORCH_GLM_RED_QUIESCENCE_SECONDS: "1800",
        ORCH_PR_REFS_PY: PR_REFS,
      },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /orch_prs_glm_red=\n/);
    assert.match(r.stdout, /orch_glm_red_forward_fix=none\n/);
    assert.match(
      r.stderr,
      /glm-red classifier fail-closed.*#4460 INV-5/,
      "INV-5 requires a stderr note naming WHY the signal is empty",
    );
    // The four #4240 buckets are unaffected by the #4460 read failure —
    // fail-closed toward NO dispatch, NOT board degradation.
    assert.match(r.stdout, /orch_prs_behind=\n/);
  });

  test("legacy #4240 classification is unchanged by the #4460 additions (regression control)", () => {
    const pr = basePrGate({ number: 4246, updatedAt: isoSecondsAgo(7200) });
    const buckets = runPrGate([pr]);
    assert.deepEqual(buckets.behind, [4246]);
    assert.deepEqual(buckets.glmRed, []);
    assert.equal(buckets.glmRedForwardFix, "none");
  });
});
