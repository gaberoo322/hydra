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
 * Since issue #4334 the reference-detection regexes live in ONE predicate —
 * `scripts/autopilot/pr-refs.py`, with its TS port `src/github/pr-refs.ts`
 * held in lockstep by test/github-pr-refs.test.mts. Since ADR-0043 slice 1
 * (issue #4929) the orch lane's three in-flight sets (the union, plus the
 * branch-only / body-only subsets the #3964 Candidate Exclusion telemetry
 * attributes) are computed by the Turn Snapshot `pr-gate` collector over the
 * TS port, and its golden files (test/fixtures/turn-snapshot/inflight-*.json)
 * pin that output to what pr-refs.py produced for every payload below. These
 * tests still run the REAL pr-refs.py (recover-stale.sh, the Target lane and
 * reap.py keep calling it), plus the candidate filter the sets feed — since
 * ADR-0043 slice 3 (#4931) the typed picks collector's `grillCandidates`.
 *
 * The exclusion set is the single input BOTH picks derive from: the
 * candidate filter subtracts it, and both `orch_pending_grill_*`
 * and `orch_dev_ready_*` are drawn from that candidate list — so proving an
 * issue number enters the in-flight set IS proving it leaves both picks.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { grillCandidates } from "../src/autopilot/turn-snapshot/picks.ts";

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
 * assignment LHS (e.g. `TARGET_READY_FOR_AGENT_ADJUSTED`). The block may span many lines
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
 * Run the picks collector's candidate filter (`grillCandidates`, ADR-0043
 * slice 3) against a constructed ready-for-agent issue list, with the given
 * issue numbers pre-marked in-flight. Returns the surviving candidate numbers
 * in walk order. Both anchor picks are drawn from this list, so an issue
 * absent here can become NEITHER pick.
 */
function candidates(issues: Issue[], inflight: Set<number>): number[] {
  return grillCandidates(issues, inflight, new Set());
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

    // Both picks derive from the candidate pool, which subtracts the
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

describe("pr-refs.py — the shared reference predicate (issue #4334)", () => {
  // ---- Delegation shape: one predicate, zero inline copies -----------------

  test("collect-state.sh carries no inline copy of the reference regexes (one predicate, #4334)", () => {
    // The dedupe contract: collect-state.sh must carry ZERO hand-written
    // copies of the branch-prefix / body-keyword regexes. Since ADR-0043
    // slice 1 (#4929) the orch in-flight sets are computed by the typed
    // Turn Snapshot collector over src/github/pr-refs.ts (the TS port of
    // pr-refs.py), and since slice 3 (#4931) the merged-PR skip calls
    // mergedPrReferences directly, so the script's one remaining pr-refs.py
    // caller is the Target in-flight invocation (issue #4474) — a further
    // copy-paste call site would be new duplication of a different kind.
    const src = readFileSync(SCRIPT, "utf-8");
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
    const calls = src.match(/python3 "\$SCRIPT_DIR\/pr-refs\.py"/g) ?? [];
    assert.equal(calls.length, 1, "expected exactly one pr-refs.py invocation");
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

// The PR-gate classification (#4240 / #4460 / #4518), the #4812 UNKNOWN
// re-poll and the #4807 dirty fix-forward suites moved with their collector to
// test/turn-snapshot-pr-gate.test.mts (ADR-0043 slice 1, issue #4929): the
// python heredocs they regex-extracted are gone, and the same cases now drive
// the typed `pr-gate` collector through a fake TurnSnapshotGithub port.

// -----------------------------------------------------------------------------
// Target-lane in-flight PR exclusion (issue #4474, CSB swap prep, grilled
// design concept)
// -----------------------------------------------------------------------------
//
// The orch lane already excludes `ready-for-agent` issues with an open PR
// (the describes above); the Target lane never got the same wiring, so
// `decide.py` could dispatch `dev_target` onto a Target issue that already
// has an open PR carrying `Closes #N`. collect-state.sh's
// `collect_target_board` now composes the raw `target_ready_for_agent` count
// (from either the healthy `scope=target` board-state read or the direct-`gh`
// fallback) with a Target-repo in-flight exclusion: max(0, base - |(R ∩ P) -
// W|), where R is the open Target `ready-for-agent` issue numbers, P is the
// pr-refs.py in-flight set, and W is the healthy endpoint's `glm_withheld` set
// (never double-subtract an issue the endpoint already excluded). The design
// concept for this issue REQUIRES both NEW Target reads (the open-PR list and
// the ready-for-agent issue-number set) to be REST `gh api` calls — never `gh
// --json` (GraphQL) — per ADR-0031 Decision 6's money-critical-hot-path
// constraint; the degraded/fallback branch instead derives R from its own
// already-fetched issue-list payload, at zero extra REST calls.
//
// This is a fresh top-level `describe` (not nested in the orch describes
// above) — it shares no Redis/teardown state with them. The subtraction
// itself is extracted with the file's EXISTING `extractPythonBlock` helper
// (the LHS `TARGET_READY_FOR_AGENT_ADJUSTED=$(... python3 -c "$(cat <<'PY'
// ... PY)" 2>/dev/null || true)` assignment form), exactly the extract-and-run
// discipline already used for `ORCH_GRILL_CANDIDATES`.

describe("collect-state.sh — target_ready_for_agent in-flight PR exclusion (issue #4474)", () => {
  const src = readFileSync(SCRIPT, "utf-8");

  function runTargetExclusion(opts: {
    base: number;
    rfaNumbers: number[];
    inflight: number[];
    glmWithheld?: number[];
    blockerExcluded?: number[];
    rfaStdin?: string;
  }): { status: number | null; stdout: string; stderr: string } {
    const code = extractPythonBlock("TARGET_READY_FOR_AGENT_ADJUSTED");
    const r = spawnSync("python3", ["-c", code], {
      input: opts.rfaStdin ?? JSON.stringify(opts.rfaNumbers),
      encoding: "utf-8",
      env: {
        ...process.env,
        TARGET_INFLIGHT_ISSUES: [...opts.inflight].sort((a, b) => a - b).join(" "),
        TARGET_GLM_WITHHELD: [...(opts.glmWithheld ?? [])].sort((a, b) => a - b).join(" "),
        TARGET_BLOCKER_EXCLUDED: [...(opts.blockerExcluded ?? [])].sort((a, b) => a - b).join(" "),
        TARGET_BASE_READY_FOR_AGENT: String(opts.base),
      },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("an in-flight ready-for-agent issue is subtracted from the base count", () => {
    const r = runTargetExclusion({ base: 3, rfaNumbers: [100, 101, 102], inflight: [101] });
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(
      r.stdout.trim(),
      "2",
      "one of the three ready-for-agent issues already has an open PR — count drops by 1",
    );
  });

  test("an in-flight issue that is NOT labelled ready-for-agent does not affect the count", () => {
    const r = runTargetExclusion({ base: 3, rfaNumbers: [100, 101], inflight: [999] });
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "3", "#999 is not in the ready-for-agent set, so nothing is excluded");
  });

  test("multiple in-flight ready-for-agent issues each subtract one", () => {
    const r = runTargetExclusion({ base: 3, rfaNumbers: [100, 101, 102], inflight: [100, 101] });
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "1");
  });

  test("the exclusion never drives the count negative (clamped at 0)", () => {
    const r = runTargetExclusion({ base: 1, rfaNumbers: [1, 2, 3], inflight: [1, 2, 3] });
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "0");
  });

  test("an empty in-flight set (failed PR-list read, or genuinely none open) excludes nothing", () => {
    const r = runTargetExclusion({ base: 3, rfaNumbers: [100, 101], inflight: [] });
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(
      r.stdout.trim(),
      "3",
      "an empty in-flight set is the fail-CLOSED 'exclude nothing' behaviour (issue #4474)",
    );
  });

  test("an unreadable rfa-numbers stdin (failed REST read) excludes nothing rather than crashing", () => {
    const r = runTargetExclusion({ base: 3, rfaNumbers: [], inflight: [101], rfaStdin: "" });
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(
      r.stdout.trim(),
      "3",
      "an unreadable ready-for-agent number set must fail CLOSED to exclude nothing (emitted UNADJUSTED), not crash or re-zero",
    );
  });

  test("a non-list rfa-numbers stdin payload excludes nothing rather than crashing", () => {
    const r = runTargetExclusion({
      base: 3,
      rfaNumbers: [],
      inflight: [101],
      rfaStdin: '{"degraded": true}',
    });
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "3");
  });

  // ---- W (glm_withheld) — never double-subtract ------------------------------

  test("an issue already withheld by the GLM partition is not double-subtracted", () => {
    // base=2 already reflects the endpoint having excluded #101 for the
    // GLM-eligible reason; #101 is ALSO in-flight (an open PR references it).
    // Only #100 (in R ∩ P but not in W) should be freshly subtracted.
    const r = runTargetExclusion({
      base: 2,
      rfaNumbers: [100, 101],
      inflight: [100, 101],
      glmWithheld: [101],
    });
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(
      r.stdout.trim(),
      "1",
      "#101 was already subtracted upstream (W) — only #100 is a fresh exclusion",
    );
  });

  test("an issue already blocker-excluded by the endpoint (B) is not double-subtracted (issue #4823)", () => {
    // base=1 already reflects the endpoint excluding #101 for an open strict
    // blocker; #101 ALSO has an open PR. Only #100 is a fresh exclusion.
    const r = runTargetExclusion({
      base: 1,
      rfaNumbers: [100, 101, 102],
      inflight: [100, 101],
      blockerExcluded: [101],
    });
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(
      r.stdout.trim(),
      "0",
      "#101 was already subtracted upstream (B) — only #100 is a fresh exclusion: max(0, 1 - 1)",
    );
    // Without B the same inputs would double-subtract #101 (clamped, so use a
    // larger base to make the difference observable).
    const withoutB = runTargetExclusion({ base: 3, rfaNumbers: [100, 101, 102], inflight: [100, 101] });
    const withB = runTargetExclusion({
      base: 3,
      rfaNumbers: [100, 101, 102],
      inflight: [100, 101],
      blockerExcluded: [101],
    });
    assert.equal(withoutB.stdout.trim(), "1");
    assert.equal(withB.stdout.trim(), "2");
  });

  test("an empty glm_withheld set (fallback path) subtracts the full R ∩ P intersection", () => {
    const r = runTargetExclusion({
      base: 3,
      rfaNumbers: [100, 101, 102],
      inflight: [100, 101],
      glmWithheld: [],
    });
    assert.equal(r.status, 0, `exclusion block exited non-zero: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "1");
  });

  // ---- REST reads: gh api, never gh --json / GraphQL (ADR-0031 Decision 6) --

  test("the open-PR read is a REST gh api call against $TARGET_GH_REPO, never gh pr list --json", () => {
    assert.match(
      src,
      /gh api "repos\/\$TARGET_GH_REPO\/pulls\?state=open&per_page=\$GH_ISSUE_LIST_LIMIT"/,
      "the Target in-flight PR read must be a REST gh api call, parameterised by $TARGET_GH_REPO",
    );
    assert.doesNotMatch(
      src,
      /gh pr list --repo "\$TARGET_GH_REPO"/,
      "the Target lane must never use gh pr list --json (GraphQL) — ADR-0031 Decision 6",
    );
  });

  test("the ready-for-agent number read (healthy path) is also a REST gh api call", () => {
    assert.match(
      src,
      /gh api "repos\/\$TARGET_GH_REPO\/issues\?labels=ready-for-agent&state=open&per_page=\$GH_ISSUE_LIST_LIMIT"/,
      "the Target ready-for-agent number read must be a REST gh api call, parameterised by $TARGET_GH_REPO",
    );
  });

  test("the REST issues payload is filtered for pull requests before counting as R", () => {
    // GitHub's REST issues-list endpoint also returns PRs (they carry a
    // `pull_request` key); counting them into R would misclassify a PR as a
    // ready-for-agent issue.
    assert.match(
      src,
      /select\(\.pull_request == null\)/,
      "the healthy-path ready-for-agent read must filter out PR entries",
    );
  });

  test("the degraded path derives R from its own already-fetched issue-list payload (zero extra REST calls)", () => {
    assert.match(
      src,
      /TARGET_RFA_NUMBERS_JSON=\$\(printf '%s' "\$TARGET_ISSUES_RAW_JSON" \| jq -c '\[\.\[\] \| select\(\.labels \| map\(\.name\) \| index\("ready-for-agent"\)\) \| \.number\]'/,
      "the fallback branch must reuse TARGET_ISSUES_RAW_JSON rather than issuing a second REST read",
    );
  });

  test("the Target in-flight predicate reuses the shared pr-refs.py script (no second hand-rolled regex)", () => {
    assert.ok(
      src.includes(
        `TARGET_INFLIGHT_ISSUES=$(printf '%s' "$TARGET_PR_REFS_INPUT" | python3 "$SCRIPT_DIR/pr-refs.py" 2>/dev/null || true)`,
      ),
      "collect-state.sh must resolve Target in-flight issues via the shared pr-refs.py, not an inline regex",
    );
  });

  test("the REST pulls payload is projected to pr-refs.py's {headRefName, body} input shape", () => {
    // Run the ACTUAL projection filter collect-state.sh uses, against a
    // synthetic REST `pulls` payload shape (.head.ref / .body), then feed the
    // result into the real pr-refs.py — end to end, no live GitHub.
    const match = src.match(
      /TARGET_PR_REFS_INPUT=\$\(printf '%s' "\$TARGET_PRS_RAW_JSON" \| jq -c '(\[.*?\])' 2>\/dev\/null \|\| echo ''\)/,
    );
    assert.ok(match, "could not locate the Target PR-refs projection filter");
    const restPulls = [
      { number: 1, head: { ref: "issue-4474-fix" }, body: "some notes" },
      { number: 2, head: { ref: "worktree-agent-abc" }, body: "Closes #55\n" },
    ];
    const projected = spawnSync("jq", ["-c", match[1]], {
      input: JSON.stringify(restPulls),
      encoding: "utf-8",
    });
    assert.equal(projected.status, 0, `jq projection failed: ${projected.stderr}`);
    const inflight = inflightIssues(JSON.parse(projected.stdout));
    assert.deepEqual([...inflight].sort((a, b) => a - b), [55, 4474]);
  });

  test("a failed Target open-PR REST read logs a stderr note naming issue #4474 (fail-CLOSED, not silent)", () => {
    assert.match(
      src,
      /target open-PR REST read FAILED \(empty payload\) — target_ready_for_agent in-flight exclusion fails CLOSED to 'exclude nothing' \(issue #4474\)/,
    );
  });

  test("a failed Target ready-for-agent REST read logs a stderr note naming issue #4474 (fail-CLOSED, not silent)", () => {
    assert.match(
      src,
      /target ready-for-agent REST read FAILED \(empty payload\) — target_ready_for_agent in-flight exclusion fails CLOSED to 'exclude nothing' \(issue #4474\)/,
    );
  });

  test("the exclusion never flips TARGET_LANE_DEGRADED (reserved for a failed counts read, issue #4130)", () => {
    // The whole in-flight-exclusion block (from its header comment to the
    // final adjusted-count emission) must never assign TARGET_LANE_DEGRADED —
    // a missing exclusion is not a missing board read.
    const start = src.indexOf("# Issue #4474 — in-flight PR exclusion (see header doc above).");
    const end = src.indexOf("\n}\n\n# UNTRIAGED ORPHANS + NEEDS-QA NUMBERS");
    assert.ok(start > -1 && end > start, "could not locate the in-flight exclusion block bounds");
    assert.doesNotMatch(
      src.slice(start, end),
      /TARGET_LANE_DEGRADED=/,
      "the in-flight exclusion must never set TARGET_LANE_DEGRADED",
    );
  });
});

describe("collect-state.sh — target_needs_qa_pr_head companion fact (issue #4653)", () => {
  // Pulls the `TARGET_QA_PR_MATCH=...python3 -c "$(cat <<'PY' ... PY)" || true)`
  // block out of collect-state.sh by its bash assignment LHS, mirroring the
  // extract-and-run discipline the sibling describes above use for
  // `ORCH_GRILL_CANDIDATES` / `TARGET_READY_FOR_AGENT_ADJUSTED` — this block's
  // invocation has no `2>/dev/null` before its trailing `|| true)`  (deliberate:
  // its stderr diagnostics stay visible), so it needs its own extraction regex
  // rather than reusing the shared `extractPythonBlock` helper above.
  function extractTargetQaPrMatchBlock(): string {
    const src = readFileSync(SCRIPT, "utf-8");
    const re = /TARGET_QA_PR_MATCH=[\s\S]*?python3 -c "\$\(cat <<'PY'([\s\S]*?)\nPY\n\)" \|\| true\)/;
    const m = src.match(re);
    assert.ok(m, "could not locate the TARGET_QA_PR_MATCH python3 block in collect-state.sh");
    return m[1];
  }

  function runTargetQaPrMatch(opts: {
    issues: { number: number; labels?: { name: string }[]; pull_request?: unknown }[];
    prs: { html_url: string; body?: string; head?: { ref: string } | null }[];
  }): { status: number | null; stdout: string; stderr: string } {
    const code = extractTargetQaPrMatchBlock();
    const r = spawnSync("python3", ["-c", code], {
      input: JSON.stringify({ issues: opts.issues, prs: opts.prs }),
      encoding: "utf-8",
      env: { ...process.env, TARGET_PR_REFS_PY: PR_REFS },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  test("a matching needs-qa issue + closing PR emits url then head.ref on two lines", () => {
    const r = runTargetQaPrMatch({
      issues: [{ number: 55, labels: [{ name: "needs-qa" }] }],
      prs: [
        {
          html_url: "https://github.com/example/target/pull/9",
          body: "Closes #55",
          head: { ref: "feature/deadbeef1-t2-dev_target" },
        },
      ],
    });
    assert.equal(r.status, 0, `block exited non-zero: ${r.stderr}`);
    assert.deepEqual(
      r.stdout.split("\n"),
      ["https://github.com/example/target/pull/9", "feature/deadbeef1-t2-dev_target"],
    );
  });

  test("a matching PR with a missing/malformed head still emits the url with an empty second line", () => {
    const r = runTargetQaPrMatch({
      issues: [{ number: 55, labels: [{ name: "needs-qa" }] }],
      prs: [
        {
          html_url: "https://github.com/example/target/pull/9",
          body: "Closes #55",
          head: null,
        },
      ],
    });
    assert.equal(r.status, 0, `block exited non-zero: ${r.stderr}`);
    assert.deepEqual(r.stdout.split("\n"), ["https://github.com/example/target/pull/9", ""]);
  });

  test("no closing PR for any needs-qa issue emits nothing on stdout (both facts fail open to empty)", () => {
    const r = runTargetQaPrMatch({
      issues: [{ number: 55, labels: [{ name: "needs-qa" }] }],
      prs: [
        {
          html_url: "https://github.com/example/target/pull/9",
          body: "Refs #55",
          head: { ref: "feature/deadbeef1-t2-dev_target" },
        },
      ],
    });
    assert.equal(r.status, 0, `block exited non-zero: ${r.stderr}`);
    assert.equal(r.stdout, "", "a non-closing reference must never match closing_issues()");
  });

  test("the zero-count and failed-read early-exit branches each emit an empty target_needs_qa_pr_head line", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    // Both early-exit branches (zero needs-qa count; failed issues REST read)
    // must emit `target_needs_qa_pr_head=` immediately alongside their
    // existing `target_needs_qa_pr_ref=` empty emission — the key is ALWAYS
    // emitted (issue #4653 INV-2), never conditionally.
    const zeroCountBlock = src.slice(
      src.indexOf('if [ "${TARGET_NQA_COUNT:-0}" = "0" ]; then'),
      src.indexOf("else", src.indexOf('if [ "${TARGET_NQA_COUNT:-0}" = "0" ]; then')),
    );
    assert.match(zeroCountBlock, /echo "target_needs_qa_pr_ref="/);
    assert.match(zeroCountBlock, /echo "target_needs_qa_pr_head="/);

    const failedReadBlock = src.slice(
      src.indexOf("target needs-qa REST read FAILED"),
      src.indexOf("else", src.indexOf("target needs-qa REST read FAILED")),
    );
    assert.match(failedReadBlock, /echo "target_needs_qa_pr_ref="/);
    assert.match(failedReadBlock, /echo "target_needs_qa_pr_head="/);
  });
});
