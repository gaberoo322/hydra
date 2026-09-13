/**
 * Regression tests for issue #4240's PR-gate classification block in
 * `scripts/autopilot/collect-state.sh` — closing two gaps a T3 adversarial QA
 * review found in the original PR (#4433):
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
 * the committed script (same extract-and-run discipline as
 * `test/collect-state-inflight-exclusion.test.mts` /
 * `test/autopilot-dev-orch-gate.test.mts`), so any regression in the
 * committed classification logic is caught here directly rather than via a
 * re-implementation.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");

interface OpenPr {
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

function runPrGate(prs: OpenPr[]): PrGateBuckets {
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

function basePr(overrides: Partial<OpenPr>): OpenPr {
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
    const pr = basePr({
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
    const pr = basePr({
      number: 4246,
      updatedAt: isoSecondsAgo(7200),
      isDraft: false,
    });
    const buckets = runPrGate([pr]);
    assert.deepEqual(buckets.behind, [4246]);
    assert.deepEqual(buckets.unchecked, []);
  });

  test("a draft PR that is BEHIND and quiescent is excluded from orch_prs_behind (INV-H)", () => {
    const pr = basePr({
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
    const pr = basePr({
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
