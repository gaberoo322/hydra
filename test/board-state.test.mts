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
import { isGlmWithheldFromClaude } from "../src/autopilot/board-state.ts";
import {
  GLM_DRAINER_ACTIVE_KEY,
  GLM_DRAINER_HEARTBEAT_STALE_MS,
} from "../src/redis/autopilot.ts";
import { ORCH_BOARD_LABELS } from "../src/board-labels.ts";

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
});

describe("hydra-dev selector — GLM partition selection-path exclusion (issue #4153)", () => {
  const fragmentSrc = readFileSync(HYDRA_DEV_FRAGMENT, "utf-8");

  /**
   * Extract the embedded `python3 -c "..."` liveness snippet piped from the
   * `GLM_PARTITION_ACTIVE=$(docker exec ... | python3 -c "..." )` assignment
   * in the committed fragment, and run it with `raw` fed on stdin — exactly
   * as `docker exec hydra-redis-1 redis-cli GET ...` would feed it in
   * production. Runs the COMMITTED logic, not a re-implementation.
   */
  function glmLivenessFromRaw(raw: string): string {
    const re =
      /GLM_PARTITION_ACTIVE=\$\(docker exec hydra-redis-1 redis-cli GET hydra:glm:drainer:active[\s\S]*?python3 -c "([\s\S]*?)"\s*2>\/dev\/null \|\| echo false\)/;
    const m = fragmentSrc.match(re);
    assert.ok(m, "could not locate the GLM_PARTITION_ACTIVE python3 block in hydra-dev-parent-flow.md");
    const code = m[1];
    const r = spawnSync("python3", ["-c", code], {
      input: raw,
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `python liveness block exited non-zero: ${r.stderr}`);
    return r.stdout.trim();
  }

  test("a FRESH heartbeat (1 min old) resolves live=true", () => {
    const nowMs = Date.now();
    assert.equal(glmLivenessFromRaw(String(nowMs - 60_000)), "true");
  });

  test("a STALE heartbeat (past GLM_DRAINER_HEARTBEAT_STALE_MS) resolves live=false", () => {
    const nowMs = Date.now();
    assert.equal(
      glmLivenessFromRaw(String(nowMs - (GLM_DRAINER_HEARTBEAT_STALE_MS + 60_000))),
      "false",
    );
  });

  test("an ABSENT heartbeat (empty stdin) resolves live=false (fail-open)", () => {
    assert.equal(glmLivenessFromRaw(""), "false");
  });

  test("an UNPARSEABLE heartbeat value resolves live=false (fail-open)", () => {
    assert.equal(glmLivenessFromRaw("not-a-number"), "false");
  });

  test("a non-positive heartbeat value resolves live=false", () => {
    assert.equal(glmLivenessFromRaw("0"), "false");
    assert.equal(glmLivenessFromRaw("-1"), "false");
  });

  test("the jq glm-eligible exclusion filter drops a glm-eligible row only when live", () => {
    const rows = [
      { number: 1, title: "a", labels: [{ name: "ready-for-agent" }, { name: "glm-eligible" }] },
      { number: 2, title: "b", labels: [{ name: "ready-for-agent" }] },
    ];
    const liveFilter = '((.labels // []) | map(.name) | index("glm-eligible")) == null';
    assert.match(
      fragmentSrc,
      /GLM_FILTER_JQ='\(\(\.labels \/\/ \[\]\) \| map\(\.name\) \| index\("glm-eligible"\)\) == null'/,
      "the committed jq filter string has drifted from the tested one",
    );
    const r = spawnSync("jq", [`map(select(${liveFilter}))`], {
      input: JSON.stringify(rows),
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `jq exited non-zero: ${r.stderr}`);
    const filtered = JSON.parse(r.stdout);
    assert.deepEqual(
      filtered.map((x: { number: number }) => x.number),
      [2],
      "a live-partition filter must drop the glm-eligible issue and keep the plain one",
    );
  });

  test("the selection query requests `labels` in --json (needed to evaluate the filter)", () => {
    assert.match(
      fragmentSrc,
      /gh issue list --repo gaberoo322\/hydra --label "ready-for-agent" --state open[\s\S]*?--json number,title,labels/,
      "the selector must fetch labels or the glm-eligible filter has nothing to read",
    );
  });

  test("GLM_FILTER_JQ defaults to a no-op ('true') before liveness is known (fail-open)", () => {
    assert.match(
      fragmentSrc,
      /GLM_FILTER_JQ='true'/,
      "the filter must default to a no-op so an unresolved/negative liveness never withholds",
    );
  });

  // ---- Drift guard: the fragment's inlined constants stay pinned to TS ----

  test("the fragment's inlined Redis key is byte-identical to GLM_DRAINER_ACTIVE_KEY (drift guard)", () => {
    assert.equal(
      GLM_DRAINER_ACTIVE_KEY,
      "hydra:glm:drainer:active",
      "sanity: the TS constant itself must still be the documented key",
    );
    assert.ok(
      fragmentSrc.includes(`redis-cli GET ${GLM_DRAINER_ACTIVE_KEY}`),
      "the fragment's inlined Redis key literal has drifted from GLM_DRAINER_ACTIVE_KEY in src/redis/autopilot.ts",
    );
  });

  test("the fragment's inlined staleness window is byte-identical to GLM_DRAINER_HEARTBEAT_STALE_MS (drift guard)", () => {
    assert.equal(
      GLM_DRAINER_HEARTBEAT_STALE_MS,
      45 * 60 * 1000,
      "sanity: the TS constant itself must still be 45 minutes",
    );
    assert.ok(
      fragmentSrc.includes(`<= ${GLM_DRAINER_HEARTBEAT_STALE_MS}`),
      "the fragment's inlined staleness threshold has drifted from GLM_DRAINER_HEARTBEAT_STALE_MS in src/redis/autopilot.ts",
    );
  });

  test("the fragment's inlined label literal is byte-identical to ORCH_BOARD_LABELS.glm_eligible (drift guard)", () => {
    assert.equal(
      ORCH_BOARD_LABELS.glm_eligible,
      "glm-eligible",
      "sanity: the TS constant itself must still be the documented label",
    );
    assert.ok(
      fragmentSrc.includes(`index("${ORCH_BOARD_LABELS.glm_eligible}")`),
      "the fragment's inlined glm-eligible label literal has drifted from ORCH_BOARD_LABELS.glm_eligible",
    );
  });

  test("fail-open direction is documented and must not be inverted", () => {
    assert.match(
      fragmentSrc,
      /Fail-open preserved \(#3754\)/,
      "the fragment must document the fail-open contract inline, mirroring board-state.ts's header doc",
    );
  });
});
