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
  extractParentEpicRefs,
  extractGatingBlockerRefs,
  STRICT_BLOCKER_PATTERN_SOURCES,
  PARENT_EPIC_PATTERN_SOURCES,
} from "../src/github/blockers.ts";
import {
  isGlmWithheldFromClaude,
  glmWithheldIssueNumbers,
} from "../src/autopilot/board-state.ts";
import type { IssueRow } from "../src/github/issues.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const HYDRA_DEV_FRAGMENT = join(
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

// ---------------------------------------------------------------------------
// Parent-epic exemption — the #4823 extension of the #3965 mirror
// ---------------------------------------------------------------------------

describe("collect-state.sh — parent-epic exemption mirror (issue #4823)", () => {
  test("the Step-3 python PARENT_PATTERNS are byte-identical to PARENT_EPIC_PATTERN_SOURCES (drift guard)", () => {
    // The parent predicate has ONE selection call site (Step 3 — the gating
    // decision), so unlike the strict patterns (Step 1 + Step 3) each source
    // must appear in the ORCH_BLOCKED_DEPENDENCY_ISSUES block itself.
    const step3 = extractPythonBlock("ORCH_BLOCKED_DEPENDENCY_ISSUES");
    for (const pat of PARENT_EPIC_PATTERN_SOURCES) {
      assert.ok(
        step3.includes(pat),
        `parent pattern ${JSON.stringify(pat)} must appear verbatim in the Step-3 python block; the bash/python mirror has drifted from src/github/blockers.ts`,
      );
    }
  });

  test("Step 1 stays STRICT-ONLY — parent refs still enter the lookup union (resolveOpenBlockers parity)", () => {
    // The TS resolver (resolveOpenBlockers) collects STRICT refs only, so the
    // open-state lookup still resolves parent numbers; the exemption is
    // applied at the GATING decision (Step 3), not by hiding refs from the
    // union. Pin that Step 1 carries no parent patterns and still extracts a
    // parent number declared as a strict blocker.
    const step1 = extractPythonBlock("ORCH_BLOCKER_REFS");
    for (const pat of PARENT_EPIC_PATTERN_SOURCES) {
      assert.ok(
        !step1.includes(pat),
        `Step 1 must not carry parent pattern ${JSON.stringify(pat)} — the union mirrors resolveOpenBlockers' strict-only collection`,
      );
    }
    const body = "Child of #194.\n\nBlocked by #194.";
    assert.deepEqual(blockerRefs([{ number: 200, body }]), [194]);
    assert.deepEqual(
      extractStrictBlockerRefs(body).sort((a, b) => a - b),
      [194],
      "python Step 1 and the TS strict extractor agree the parent ref IS collected",
    );
  });

  test("the incident shape is NOT blocked by its open parent epic (python mirror of the exemption)", () => {
    const issues: Issue[] = [
      { number: 200, body: "Child of #194 (M5 Paper Clock).\n\nBlocked by #194." },
      { number: 201, body: "Blocked by #194." }, // pre-remediation: no marker
      { number: 202, body: "Child of #194.\n\nBlocked by #195 (sibling)." },
    ];
    // Parent epic #194 and sibling #195 both open.
    assert.deepEqual(
      blockedDependencyIssues(issues, new Set([194, 195])),
      [201, 202],
      "#200 (parent-exempt) must be selectable; #201 (bare blocker) and #202 (open sibling) stay blocked",
    );
    // Only the parent open: nothing except the bare-blocker row is blocked.
    assert.deepEqual(blockedDependencyIssues(issues, new Set([194])), [201]);
  });

  test("python Step 3 matches TS extractGatingBlockerRefs on a golden fixture (behavioural parity)", () => {
    // One predicate, two call sites: for every body, the python "blocked"
    // verdict must equal "TS gating refs ∩ openSet is non-empty". Each body
    // gets a UNIQUE issue number (the python verdict is per-row, but its
    // output is a flat number list — a shared number would alias rows).
    const golden: Array<[number, string]> = [
      [1000, "Child of #194.\n\nBlocked by #194."],
      [1001, "Blocked by #194."],
      [1002, "parent epic: #194. depends on #194."],
      [1003, "Part of #194 — blocked by #194."],
      [1004, "Child of #194.\n\nBlocked by #195."],
      [1005, "See also #99, part of #42."],
      [1006, "Blocked by `#194` and child of `#194`."],
      [1007, "child-of #194, blocked-by #194"],
      [300, "blocked by #300"], // self-ref: row number == ref number
      [1008, "no refs at all"],
    ];
    const all = new Set<number>();
    for (const [, body] of golden) {
      for (const n of extractStrictBlockerRefs(body)) all.add(n);
      for (const n of extractParentEpicRefs(body)) all.add(n);
    }
    for (const openSet of [all, new Set([194]), new Set([195])]) {
      const pyBlocked = new Set(blockedDependencyIssues(golden.map(([number, body]) => ({ number, body })), openSet));
      for (const [n, body] of golden) {
        const tsGating = extractGatingBlockerRefs(body, n);
        const tsBlocked = tsGating.some((x) => openSet.has(x));
        assert.equal(
          pyBlocked.has(n),
          tsBlocked,
          `python/TS gating mismatch on #${n} (body ${JSON.stringify(body)}, open=[${[...openSet].join(",")}])`,
        );
      }
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

/**
 * Regression + parity tests for issue #4153 — the `hydra-dev` skill's
 * SELECTION path ("1. Select issue" in
 * `docs/operator-playbooks/_fragments/hydra-dev-parent-flow.md`) applied no
 * `glm-eligible` filter at all, while the COUNT path
 * (`src/autopilot/board-state.ts::deriveBoardState`) already excludes a
 * `glm-eligible` issue when the GLM dev-drainer partition is live (#3754).
 * An unpinned `dev_orch` dispatch could therefore land on — and
 * double-author — a GLM-drainer-owned issue.
 *
 * Same shape as the #3965 suite above: the fragment is bash/python (no TS
 * bridge), so its liveness check and label filter MIRROR the TS predicate
 * (`isGlmWithheldFromClaude`) rather than importing it. These tests pin the
 * TS predicate directly, extract the ACTUAL embedded python liveness snippet
 * from the committed fragment and run it against constructed heartbeat
 * values, and assert a byte-identical drift guard between the fragment's
 * inlined constants and their TS sources (`GLM_DRAINER_ACTIVE_KEY`,
 * `GLM_DRAINER_HEARTBEAT_STALE_MS` in `src/redis/autopilot.ts`, and the
 * `glm-eligible` label literal in `ORCH_BOARD_LABELS.glm_eligible`).
 */
describe("isGlmWithheldFromClaude — the shared count/selection predicate (issue #4153)", () => {
  test("glm-eligible + partition LIVE -> withheld", () => {
    assert.equal(isGlmWithheldFromClaude(["ready-for-agent", "glm-eligible"], true), true);
  });

  test("glm-eligible + partition NOT live (fail-open) -> NOT withheld", () => {
    assert.equal(isGlmWithheldFromClaude(["ready-for-agent", "glm-eligible"], false), false);
  });

  test("no glm-eligible label, partition live -> NOT withheld", () => {
    assert.equal(isGlmWithheldFromClaude(["ready-for-agent"], true), false);
  });

  test("no glm-eligible label, partition not live -> NOT withheld", () => {
    assert.equal(isGlmWithheldFromClaude(["ready-for-agent"], false), false);
  });

  test("default glmPartitionActive is the fail-open direction when explicitly false", () => {
    // Mirrors deriveBoardState's own `glmPartitionActive = false` default —
    // a caller that never resolves liveness must never withhold.
    assert.equal(isGlmWithheldFromClaude(["glm-eligible"], false), false);
  });

  // -------------------------------------------------------------------------
  // Both-labels deadlock guard (issue #4124) — glm-ab-control always wins
  // over glm-eligible, so an issue mistakenly carrying both is never
  // double-excluded (skipped by the drainer AND subtracted from the Opus
  // pool, worked by nobody).
  // -------------------------------------------------------------------------

  test("BOTH glm-eligible AND glm-ab-control, partition LIVE -> NOT withheld (the deadlock guard)", () => {
    // This is the criterion that must fail against unmodified code: the
    // unmodified predicate keys solely on glm-eligible + partition liveness,
    // so a row carrying both labels would be wrongly withheld without the
    // glm-ab-control override.
    assert.equal(
      isGlmWithheldFromClaude(["ready-for-agent", "glm-eligible", "glm-ab-control"], true),
      false,
    );
  });

  test("BOTH glm-eligible AND glm-ab-control, partition NOT live -> NOT withheld (fail-open arm unchanged)", () => {
    // Pins that the new glm-ab-control override does not disturb the #3754
    // fail-open behaviour when the partition is inactive regardless of labels.
    assert.equal(
      isGlmWithheldFromClaude(["ready-for-agent", "glm-eligible", "glm-ab-control"], false),
      false,
    );
  });

  test("glm-ab-control alone (no glm-eligible), partition LIVE -> NOT withheld", () => {
    // Already true before #4124 (the predicate keys on glm-eligible), but
    // pinned here as the baseline the both-labels case is layered on top of.
    assert.equal(isGlmWithheldFromClaude(["ready-for-agent", "glm-ab-control"], true), false);
  });
});

describe("hydra-dev selector — glm_withheld projection consumer (issue #4689)", () => {
  const fragmentSrc = readFileSync(HYDRA_DEV_FRAGMENT, "utf-8");

  /** Extract the single-quoted jq program from the committed WITHHELD_JQ assignment. */
  function extractionProgram(): string {
    const m = fragmentSrc.match(/WITHHELD_JQ=\$\(curl[^\n]*\\\n[^\n]*jq -r '([^']*)'/);
    assert.ok(m, "could not locate the WITHHELD_JQ jq program in hydra-dev-parent-flow.md");
    return m[1];
  }

  function withheldFrom(input: string): string {
    const r = spawnSync("jq", ["-r", extractionProgram()], { input, encoding: "utf-8" });
    // Mirrors the fragment's `2>/dev/null || true`: a jq failure is an empty list.
    return r.status === 0 ? r.stdout.trim() : "";
  }

  test("the fragment has no glm-eligible / glm-ab-control label literal", () => {
    assert.ok(!fragmentSrc.includes("glm-eligible"));
    assert.ok(!fragmentSrc.includes("glm-ab-control"));
  });

  test("the fragment performs no GLM liveness read of its own", () => {
    for (const lit of ["hydra:glm:drainer:active", "redis-cli", "docker exec", "2700000", "GLM_FILTER_JQ", "GLM_PARTITION_ACTIVE"]) {
      assert.ok(!fragmentSrc.includes(lit), `fragment must not contain ${lit}`);
    }
  });

  test("the fragment reads glm_withheld only from the board-state endpoint", () => {
    assert.match(fragmentSrc, /curl -sf --max-time 5 http:\/\/localhost:4000\/api\/autopilot\/board-state/);
    assert.ok(fragmentSrc.includes("glm_withheld"));
  });

  test("the committed jq extraction resolves the fail-open fixture table", () => {
    assert.equal(withheldFrom(JSON.stringify({ glm_withheld: [4247] })), "4247");
    assert.equal(withheldFrom(JSON.stringify({ glm_withheld: [4247, 12] })), "4247,12");
    assert.equal(withheldFrom(JSON.stringify({ degraded: true, glm_withheld: [1] })), "");
    assert.equal(withheldFrom(JSON.stringify({ glm_withheld: "x" })), "");
    assert.equal(withheldFrom(JSON.stringify({ glm_withheld: [0, -1, 1.5, "7", null] })), "");
    assert.equal(withheldFrom("{}"), "");
    assert.equal(withheldFrom("garbage"), "");
    assert.equal(withheldFrom(""), "");
  });

  test("the extraction program is a single-quoted-safe literal", () => {
    assert.ok(!extractionProgram().includes("'"));
  });

  test("the selector applies a WITHHELD index-exclusion clause alongside the CLAIMED one", () => {
    assert.ok(fragmentSrc.includes("[${CLAIMED_JQ}] | index(\\$n) | not"));
    assert.ok(fragmentSrc.includes("[${WITHHELD_JQ}] | index(\\$n) | not"));
  });

  test("fail-open direction is documented and must not be inverted", () => {
    assert.match(fragmentSrc, /Fail-open preserved \(#3754\)/);
  });
});

/**
 * Issue #4254 — `glmWithheldIssueNumbers`, the SOLE producer of the
 * `glm_withheld` field on `GET /api/autopilot/board-state`. It is a pure
 * sibling of `deriveBoardState` that publishes the per-row VERDICTS of the one
 * label rule (`isGlmWithheldFromClaude`) so `collect-state.sh` can refuse an
 * `orch_dev_ready_anchor` pin by issue NUMBER alone — never by re-spelling the
 * label rule in shell (the mirror class #4253 documents).
 */
describe("glmWithheldIssueNumbers — the derived GLM-withheld verdict list (issue #4254)", () => {
  function glmRow(number: number, labels: string[]): IssueRow {
    return {
      number,
      title: `Issue #${number}`,
      url: `https://github.com/x/y/issues/${number}`,
      createdAt: "",
      labels,
      body: "",
      state: "OPEN",
      updatedAt: "",
    };
  }

  test("live + glm-eligible-only ready row -> listed", () => {
    assert.deepEqual(
      glmWithheldIssueNumbers([glmRow(4247, ["ready-for-agent", "glm-eligible"])], true),
      [4247],
    );
  });

  test("live + BOTH glm-eligible AND glm-ab-control -> NOT listed (deadlock guard travels with the list)", () => {
    assert.deepEqual(
      glmWithheldIssueNumbers(
        [glmRow(4247, ["ready-for-agent", "glm-eligible", "glm-ab-control"])],
        true,
      ),
      [],
    );
  });

  test("live + glm-ab-control only -> NOT listed", () => {
    assert.deepEqual(
      glmWithheldIssueNumbers([glmRow(4247, ["ready-for-agent", "glm-ab-control"])], true),
      [],
    );
  });

  test("NOT live + glm-eligible -> [] (fail-open toward work, #3754)", () => {
    assert.deepEqual(
      glmWithheldIssueNumbers([glmRow(4247, ["ready-for-agent", "glm-eligible"])], false),
      [],
    );
  });

  test("a glm-eligible row WITHOUT ready-for-agent -> NOT listed (never a dispatch candidate)", () => {
    assert.deepEqual(
      glmWithheldIssueNumbers([glmRow(4247, ["glm-eligible", "needs-triage"])], true),
      [],
    );
  });

  test("a plain ready-for-agent row -> NOT listed", () => {
    assert.deepEqual(
      glmWithheldIssueNumbers([glmRow(4255, ["ready-for-agent"])], true),
      [],
    );
  });

  test("output is ascending regardless of input order, and only withheld rows appear", () => {
    const rows = [
      glmRow(4262, ["ready-for-agent", "glm-eligible"]),
      glmRow(4247, ["ready-for-agent", "glm-eligible"]),
      glmRow(4255, ["ready-for-agent"]),
      glmRow(4250, ["ready-for-agent", "glm-eligible", "glm-ab-control"]),
      glmRow(4249, ["ready-for-agent", "glm-eligible"]),
    ];
    assert.deepEqual(glmWithheldIssueNumbers(rows, true), [4247, 4249, 4262]);
  });

  test("verdicts match isGlmWithheldFromClaude row-for-row on ready-for-agent rows (one definition)", () => {
    const labelSets: string[][] = [
      ["ready-for-agent"],
      ["ready-for-agent", "glm-eligible"],
      ["ready-for-agent", "glm-ab-control"],
      ["ready-for-agent", "glm-eligible", "glm-ab-control"],
      ["ready-for-agent", "glm-withhold", "glm-eligible"],
    ];
    for (const live of [true, false]) {
      const rows = labelSets.map((labels, i) => glmRow(100 + i, labels));
      const expected = rows
        .filter((r) => isGlmWithheldFromClaude(r.labels, live))
        .map((r) => r.number);
      assert.deepEqual(glmWithheldIssueNumbers(rows, live), expected, `live=${live}`);
    }
  });
});
