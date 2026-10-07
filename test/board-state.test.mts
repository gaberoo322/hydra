/**
 * Board-state predicate tests. The #3965 / #4823 blocked-dependency exclusion
 * that used to be mirrored in python inside collect-state.sh (and pinned here
 * by byte-identity drift guards) is now the typed Turn Snapshot picks
 * collector, which calls src/github/blockers.ts directly (ADR-0043 slice 3,
 * #4931); its behavioural cases live in test/turn-snapshot-picks.test.mts and
 * the drift guards retired with the python copy.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import {
  isGlmWithheldFromClaude,
  glmWithheldIssueNumbers,
} from "../src/autopilot/board-state.ts";
import type { IssueRow } from "../src/github/issues.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const HYDRA_DEV_FRAGMENT = join(
  REPO_ROOT,
  "docs",
  "operator-playbooks",
  "_fragments",
  "hydra-dev-parent-flow.md",
);

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
 * label rule (`isGlmWithheldFromClaude`) so the Turn Snapshot can refuse an
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
