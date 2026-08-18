/**
 * Regression + parity tests for issue #3965 — the blocked-dependency candidate
 * exclusion in `scripts/autopilot/collect-state.sh`.
 *
 * The COUNT path (`src/autopilot/board-state.ts::hasOpenStrictBlocker` →
 * `extractStrictBlockerRefs`) already excludes a ready-for-agent issue that
 * cites an OPEN strict blocker from the dispatchable `ready_for_agent` count.
 * The SELECTION path (this script's candidate loop) did not, so a
 * dependency-blocked issue could still be picked as the grill / dev-ready
 * anchor. Issue #3965 adds the FIFTH candidate exclusion
 * (`blocked-dependency-exclusion`) so the two paths agree.
 *
 * `collect-state.sh` is bash/python (no TypeScript bridge), so the
 * strict-blocker parse is mirrored in python inside the script. These tests
 * extract the ACTUAL python blocks (`ORCH_BLOCKER_REFS`,
 * `ORCH_BLOCKED_DEPENDENCY_ISSUES`, `ORCH_GRILL_CANDIDATES`) from the committed
 * script and run them against constructed fixtures — so any drift in the
 * script's logic is caught here. This mirrors the extract-and-run discipline of
 * `test/collect-state-inflight-exclusion.test.mts`.
 *
 * Two cross-implementation invariants close the "do not write a second parser"
 * contract: a behavioural-parity check against the TS `extractStrictBlockerRefs`
 * on a shared golden fixture, and a byte-identical drift guard asserting the
 * inline python patterns equal `STRICT_BLOCKER_PATTERN_SOURCES` in
 * `src/github/blockers.ts` — one predicate, two call sites, machine-checked.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import {
  extractStrictBlockerRefs,
  STRICT_BLOCKER_PATTERN_SOURCES,
} from "../src/github/blockers.ts";
import { isGlmWithheld } from "../src/autopilot/board-state.ts";
import { ORCH_BOARD_LABELS } from "../src/board-labels.ts";
import {
  GLM_DRAINER_ACTIVE_KEY,
  GLM_DRAINER_HEARTBEAT_STALE_MS,
} from "../src/redis/autopilot.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const HYDRA_DEV_PARENT_FLOW = join(
  REPO_ROOT,
  "docs",
  "operator-playbooks",
  "_fragments",
  "hydra-dev-parent-flow.md",
);

interface Issue {
  number: number;
  body: string;
  labels?: { name: string }[];
}

/**
 * Pull a `python3 -c "<code>"` block out of collect-state.sh by its bash
 * assignment LHS. The block may span many lines and is terminated by
 * `" 2>/dev/null || true)`. Returns the literal python source so the test runs
 * the committed logic, not a re-implementation. (Shared verbatim with
 * `test/collect-state-inflight-exclusion.test.mts`.)
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

/** Run a python block with optional env, returning trimmed stdout. */
function runPython(
  code: string,
  stdinJson: unknown,
  env: Record<string, string> = {},
): string {
  const r = spawnSync("python3", ["-c", code], {
    input: JSON.stringify(stdinJson),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `python block exited non-zero: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function parseNums(s: string): number[] {
  return s.length ? s.split(/\s+/).map(Number) : [];
}

/**
 * Run the `ORCH_BLOCKER_REFS` extractor (Step 1) — the union of strict-blocker
 * refs declared across the issue pool, self-refs excluded. Mirrors
 * `resolveOpenBlockers`' ref collection.
 */
function blockerRefs(issues: Issue[]): number[] {
  return parseNums(runPython(extractPythonBlock("ORCH_BLOCKER_REFS"), issues));
}

/**
 * Run the `ORCH_BLOCKED_DEPENDENCY_ISSUES` predicate (Step 3) — the candidate
 * numbers blocked by an OPEN strict blocker, given a pre-resolved open set.
 * Mirrors `hasOpenStrictBlocker`. The open set is injected (not resolved via
 * `gh`) so the predicate is pure and deterministic under test; injecting the
 * FULL ref set simulates the bash Step-2 fail-safe (gh failure → all open).
 */
function blockedDependencyIssues(
  issues: Issue[],
  openBlockers: Set<number>,
): number[] {
  const out = runPython(
    extractPythonBlock("ORCH_BLOCKED_DEPENDENCY_ISSUES"),
    issues,
    {
      ORCH_OPEN_BLOCKERS: [...openBlockers].sort((a, b) => a - b).join(" "),
    },
  );
  return parseNums(out);
}

/**
 * Run the `ORCH_GRILL_CANDIDATES` filter — issue-number-ascending candidates
 * with in-flight, in-progress, and blocked-dependency issues subtracted. Both
 * anchor picks (`orch_pending_grill_anchor`, `orch_dev_ready_anchor`) are drawn
 * from this list, so an issue absent here can become NEITHER pick.
 */
function candidates(
  issues: Issue[],
  inflight: Set<number>,
  blockedDep: Set<number>,
): number[] {
  const out = runPython(extractPythonBlock("ORCH_GRILL_CANDIDATES"), issues, {
    ORCH_INFLIGHT_ISSUES: [...inflight].sort((a, b) => a - b).join(" "),
    ORCH_BLOCKED_DEPENDENCY_ISSUES: [...blockedDep].sort((a, b) => a - b).join(" "),
  });
  return parseNums(out);
}

describe("collect-state.sh — blocked-dependency exclusion (issue #3965)", () => {
  // ---- The headline fix: an open strict blocker excludes from BOTH picks ----

  test("a ready-for-agent issue citing an OPEN strict blocker is excluded from BOTH picks", () => {
    const issues: Issue[] = [
      { number: 100, body: "Blocked by #500." },
      { number: 101, body: "No blocker here." },
    ];
    // Step 1 collects the union of refs to look up.
    assert.deepEqual(blockerRefs(issues), [500]);
    // #500 is open -> #100 is blocked. #101 is untouched.
    const blocked = blockedDependencyIssues(issues, new Set([500]));
    assert.deepEqual(blocked, [100]);

    // Both picks derive from ORCH_GRILL_CANDIDATES, which subtracts the blocked
    // set — so a blocked #100 can become neither grill nor dev-ready anchor,
    // even though #101 (and thus the board) still has candidates.
    const cands = candidates(issues, new Set(), new Set(blocked));
    assert.ok(!cands.includes(100), "blocked #100 must be dropped from candidates → excluded from both picks");
    assert.ok(cands.includes(101), "unblocked #101 must remain a candidate");
  });

  test("the same issue with its blocker CLOSED is selected normally", () => {
    const issues: Issue[] = [
      { number: 100, body: "Blocked by #500." },
      { number: 101, body: "depends on #500 too" },
    ];
    // #500 closed (absent from the open set) -> nothing is blocked -> both
    // remain candidates. No caching/memoization: the open set is resolved
    // fresh each collect turn, so a blocker closing re-admits the issue next
    // turn.
    const blocked = blockedDependencyIssues(issues, new Set());
    assert.deepEqual(blocked, []);
    const cands = candidates(issues, new Set(), new Set(blocked));
    assert.deepEqual(cands, [100, 101]);
  });

  test("`depends on #N` excludes just like `blocked by #N`", () => {
    const issues: Issue[] = [{ number: 7, body: "Depends on #9." }];
    assert.deepEqual(blockerRefs(issues), [9]);
    assert.deepEqual(blockedDependencyIssues(issues, new Set([9])), [7]);
  });

  // ---- Deliberate non-goals: anchored keyword-only, code-span-safe, self-safe --

  test("a BARE `#N` mention does NOT exclude (would starve real work)", () => {
    const issues: Issue[] = [
      { number: 200, body: "See also #500 and part of #501." },
    ];
    assert.deepEqual(blockerRefs(issues), []);
    // Even if #500/#501 are open, a bare mention has no ref to match.
    assert.deepEqual(blockedDependencyIssues(issues, new Set([500, 501])), []);
  });

  test("a `#N` inside a backtick code span does NOT exclude (code-span-safe)", () => {
    const issues: Issue[] = [
      { number: 300, body: "Blocked by `#500` in a snippet." },
      { number: 301, body: "`code #500` but blocked by #501" },
    ];
    // #500 is inside a code span on #300 -> ignored. #301's #500 is in a span
    // too, but its #501 is a real ref outside the span.
    assert.deepEqual(blockerRefs(issues), [501]);
    assert.deepEqual(blockedDependencyIssues(issues, new Set([500, 501])), [301]);
  });

  test("a SELF-reference does NOT exclude (an issue can't block itself)", () => {
    const issues: Issue[] = [{ number: 400, body: "blocked by #400" }];
    assert.deepEqual(blockerRefs(issues), []);
    assert.deepEqual(blockedDependencyIssues(issues, new Set([400])), []);
  });

  // ---- Fail-safe: a lookup failure fails toward exclusion -------------------

  test("fail-safe: a blocker-lookup failure (all refs treated open) excludes the issue", () => {
    // The bash Step 2 produces `ORCH_OPEN_BLOCKERS = $ORCH_BLOCKER_REFS` on a
    // gh failure (mirrors fetchOpenBlockerNumbers). Simulate that by injecting
    // the FULL ref set as open — every referencing candidate is then excluded,
    // so the loop waits a tick rather than dispatching onto an unmerged
    // blocker.
    const issues: Issue[] = [
      { number: 100, body: "Blocked by #500." },
      { number: 101, body: "depends on #501" },
      { number: 102, body: "clean" },
    ];
    const refs = blockerRefs(issues);
    assert.deepEqual(refs, [500, 501]);
    // gh-fail-safe shape: open set == full ref set.
    const blocked = blockedDependencyIssues(issues, new Set(refs));
    assert.deepEqual(blocked, [100, 101]);
    const cands = candidates(issues, new Set(), new Set(blocked));
    assert.deepEqual(cands, [102]);
  });

  test("the fail-safe never fails the collect step (best-effort degrade)", () => {
    // Structural guard: the script's gh-lookup guard is a best-effort
    // `2>/dev/null || true` shape with an explicit fail-safe else-branch — a
    // transient gh outage must set ORCH_OPEN_BLOCKERS to the full ref set, not
    // abort the run. Assert the fail-safe branch is present and wired.
    const src = readFileSync(SCRIPT, "utf-8");
    assert.match(
      src,
      /ORCH_OPEN_BLOCKERS="\$\{?ORCH_BLOCKER_REFS\}?"/,
      "the gh-failure else-branch must treat every referenced blocker as open",
    );
    assert.match(
      src,
      /gh issue list --repo gaberoo322\/hydra --state open --search "\$\{?ORCH_BLOCKER_REFS\}?"/,
      "openness must be resolved with one batched gh issue list --search",
    );
  });

  // ---- The exclusion is a HARD skip at candidate construction time ----------

  test("the exclusion is a HARD skip in ORCH_GRILL_CANDIDATES (not a soft loop continue)", () => {
    // A dependency-blocked issue is never safe to hand to dev_orch either, so
    // it must be subtracted at candidate construction (like in-flight-dev),
    // NOT handled as a soft `continue` inside the per-candidate loop that could
    // still promote it to ORCH_DEV_READY_PICK (the way the mechanical/trivial
    // gates do). The candidate extractor must read ORCH_BLOCKED_DEPENDENCY_ISSUES.
    const code = extractPythonBlock("ORCH_GRILL_CANDIDATES");
    assert.match(code, /blocked_dep/, "the candidate extractor must consume the blocked-dependency set");
    assert.match(
      code,
      /or n in blocked_dep/,
      "the blocked-dependency skip must be a hard subtract at construction time",
    );
  });

  test("the exclusion is additive to the `blocked` label (never toggles it)", () => {
    // Structural guard: this exclusion must never WRITE the `blocked` label
    // (an operator escape hatch; writing it would collide with the
    // orphan-backstop tracking loop). The new code only READS issue bodies and
    // emits a candidate-number set — assert it contains no `gh issue edit` /
    // `gh issue remove-label` / label-mutation call.
    const src = readFileSync(SCRIPT, "utf-8");
    // Slice to the new region (issue #3965 marker onward) to scope the guard.
    const marker = src.indexOf("BLOCKED-DEPENDENCY CANDIDATE EXCLUSION (issue #3965)");
    assert.ok(marker > 0, "the #3965 exclusion block must be present");
    const region = src.slice(marker, marker + 6000);
    assert.doesNotMatch(
      region,
      /gh issue (edit|add-label|remove-label)/,
      "the blocked-dependency exclusion must never mutate issue labels",
    );
  });

  // ---- Cross-implementation parity: one predicate, two call sites ----------

  test("the python ref extraction matches TS extractStrictBlockerRefs on a golden fixture", () => {
    // The "do not write a second parser" invariant: the bash/python mirror and
    // the TS predicate must agree on every edge case. Feed each golden body as
    // a single-issue pool and compare the extracted ref SETS (the python sorts;
    // the TS preserves first-appearance order — compare sorted).
    const golden = [
      "Blocked by #10.\nAlso depends on #20 and blocked by #10 again.",
      "blocked-by: #5",
      "depends-on #6",
      "blocks #7",
      "See also #99, part of #42.",
      "Blocked by `#10` in a snippet.",
      "`code #10` but blocked by #11",
      "",
      "BLOCKS #100 and DEPENDENT ON #200",
      "blocked\nby #30", // newline between keyword and ref
    ];
    for (const body of golden) {
      const tsRefs = extractStrictBlockerRefs(body).sort((a, b) => a - b);
      const pyRefs = blockerRefs([{ number: 999_999, body }]);
      assert.deepEqual(
        pyRefs,
        tsRefs,
        `python/TS ref mismatch on body: ${JSON.stringify(body)}`,
      );
    }
  });

  test("the inline python PATTERNS are byte-identical to STRICT_BLOCKER_PATTERN_SOURCES (drift guard)", () => {
    // If a future edit changes the TS regex but not the python (or vice versa),
    // this fails loudly. Each source must appear in BOTH python blocks (Step 1
    // ORCH_BLOCKER_REFS and Step 3 ORCH_BLOCKED_DEPENDENCY_ISSUES) — so count
    // >= 2 occurrences per pattern.
    const src = readFileSync(SCRIPT, "utf-8");
    for (const pat of STRICT_BLOCKER_PATTERN_SOURCES) {
      const count = occurrences(src, pat);
      assert.ok(
        count >= 2,
        `pattern ${JSON.stringify(pat)} must appear in both python blocks (found ${count}); the bash/python mirror has drifted from src/github/blockers.ts`,
      );
    }
  });
});

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// isGlmWithheld — the shared GLM partition-withholding predicate (#4153)
// ---------------------------------------------------------------------------

describe("isGlmWithheld (issue #4153) — the shared count/selection predicate", () => {
  test("withholds a glm-eligible issue while the partition is live", () => {
    assert.equal(
      isGlmWithheld(new Set([ORCH_BOARD_LABELS.glm_eligible]), true),
      true,
    );
  });

  test("does NOT withhold a non-glm-eligible issue even while the partition is live", () => {
    assert.equal(
      isGlmWithheld(new Set([ORCH_BOARD_LABELS.ready_for_agent]), true),
      false,
    );
  });

  test("fail-open: does NOT withhold a glm-eligible issue while the partition is inactive", () => {
    assert.equal(
      isGlmWithheld(new Set([ORCH_BOARD_LABELS.glm_eligible]), false),
      false,
    );
  });

  test("accepts a plain label array, not just a Set", () => {
    assert.equal(isGlmWithheld([ORCH_BOARD_LABELS.glm_eligible], true), true);
    assert.equal(isGlmWithheld([], true), false);
  });
});

// ---------------------------------------------------------------------------
// hydra-dev "1. Select issue" GLM partition exclusion (issue #4153)
// ---------------------------------------------------------------------------
//
// `docs/operator-playbooks/_fragments/hydra-dev-parent-flow.md` has no
// TypeScript bridge (it is bash/jq the operator/parent dispatcher runs
// directly), so the `isGlmWithheld` predicate is mirrored there in bash. These
// tests extract the ACTUAL committed block and (a) drift-guard its three
// literals (Redis key, staleness window, label) against the TS source of
// truth, and (b) run its jq filter through real jq against constructed
// fixtures to confirm behavioural parity with `isGlmWithheld` — the same
// "extract the real block, drift-guard the literals" discipline the
// strict-blocker suite above uses for `collect-state.sh`.

/** The literal "1. Select issue" bash fenced block from the parent-flow doc. */
function selectIssueBashBlock(): string {
  const src = readFileSync(HYDRA_DEV_PARENT_FLOW, "utf-8");
  const marker = src.indexOf("### 1. Select issue");
  assert.ok(marker > 0, "could not locate the '### 1. Select issue' section");
  const fenceStart = src.indexOf("```bash", marker);
  const fenceEnd = src.indexOf("```", fenceStart + "```bash".length);
  assert.ok(
    fenceStart > 0 && fenceEnd > fenceStart,
    "could not locate the fenced bash block under '### 1. Select issue'",
  );
  return src.slice(fenceStart, fenceEnd);
}

/** Pull the jq `select(...)` predicate assigned to GLM_JQ_FILTER when the partition IS active. */
function extractGlmJqFilter(block: string): string {
  const m = block.match(/GLM_JQ_FILTER='([^']+)'/);
  assert.ok(m, "could not locate the active-partition GLM_JQ_FILTER assignment");
  return m[1];
}

/** Run the extracted jq filter over synthetic ready-for-agent issues via real jq. */
function jqSelectGlmEligible(filter: string, issues: { labels: string[] }[]): boolean[] {
  const input = JSON.stringify(
    issues.map((i) => ({ labels: i.labels.map((name) => ({ name })) })),
  );
  const r = spawnSync("jq", [`map(select(${filter}))`], {
    input,
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, `jq filter failed: ${r.stderr}`);
  const kept: { labels: { name: string }[] }[] = JSON.parse(r.stdout);
  // True per input issue when it SURVIVED the filter (i.e. was NOT withheld).
  return issues.map((issue) =>
    kept.some((k) => JSON.stringify(k.labels.map((l) => l.name)) === JSON.stringify(issue.labels)),
  );
}

describe("hydra-dev '1. Select issue' GLM partition exclusion (issue #4153)", () => {
  test("drift guard: the doc's Redis key literal matches GLM_DRAINER_ACTIVE_KEY", () => {
    const block = selectIssueBashBlock();
    assert.ok(
      block.includes(`redis-cli GET ${GLM_DRAINER_ACTIVE_KEY}`),
      `doc must read the exact key ${JSON.stringify(GLM_DRAINER_ACTIVE_KEY)} (src/redis/autopilot.ts) — the bash mirror has drifted`,
    );
  });

  test("drift guard: the doc's staleness-window literal matches GLM_DRAINER_HEARTBEAT_STALE_MS", () => {
    const block = selectIssueBashBlock();
    assert.ok(
      block.includes(`-le ${GLM_DRAINER_HEARTBEAT_STALE_MS}`),
      `doc must compare heartbeat age against ${GLM_DRAINER_HEARTBEAT_STALE_MS}ms (src/redis/autopilot.ts) — the bash mirror has drifted`,
    );
  });

  test("drift guard: the doc's label literal matches ORCH_BOARD_LABELS.glm_eligible", () => {
    const block = selectIssueBashBlock();
    const filter = extractGlmJqFilter(block);
    assert.ok(
      filter.includes(`index("${ORCH_BOARD_LABELS.glm_eligible}")`),
      `doc's jq filter must key off ${JSON.stringify(ORCH_BOARD_LABELS.glm_eligible)} (src/board-labels.ts) — the bash mirror has drifted`,
    );
  });

  test("fail-open: the doc sets GLM_JQ_FILTER to a literal no-op when the partition is inactive", () => {
    const block = selectIssueBashBlock();
    assert.match(
      block,
      /GLM_JQ_FILTER="true"/,
      "the default (partition inactive) filter must be the unconditional jq no-op 'true' — fail-open toward work (#3754)",
    );
  });

  test("behavioural parity: the extracted jq filter agrees with isGlmWithheld when the partition is active", () => {
    const block = selectIssueBashBlock();
    const filter = extractGlmJqFilter(block);
    const issues = [
      { labels: [ORCH_BOARD_LABELS.ready_for_agent, ORCH_BOARD_LABELS.glm_eligible] },
      { labels: [ORCH_BOARD_LABELS.ready_for_agent] },
    ];
    const survived = jqSelectGlmEligible(filter, issues);
    const expected = issues.map((i) => !isGlmWithheld(i.labels, true));
    assert.deepEqual(
      survived,
      expected,
      "jq filter's kept/dropped set must match isGlmWithheld(labels, glmPartitionActive=true) for every fixture issue",
    );
    // Concretely: the glm-eligible issue is dropped, the plain one survives.
    assert.deepEqual(survived, [false, true]);
  });
});
