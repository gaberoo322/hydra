/**
 * Tests for `src/glm/eligibility.ts` — the ONE GLM-lane eligibility predicate
 * (ADR-0040 Decision 4 + Decision 5; epic #4681, issue #4684).
 *
 * Table-driven, fake deps, no golden files, no processes (the #4679
 * test-port rule).
 *
 * The grill-exemption case table (`glmGrillExemption` / `glmPickVerdict`)
 * lives in `test/turn-snapshot-picks.test.mts` beside the picks collector that
 * consumes it (its python twins retired with ADR-0043 slice 3). A file here that read collect-state.sh would resolve
 * to it as its #4134 sprawl-ratchet subject, which #4519 INV-1 forbids.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import {
  glmLane,
  glmGrillExemption,
  glmPickVerdict,
  type GlmLaneName,
  type GlmPickContext,
  type GlmPickRow,
  type GlmPickVerdict,
} from "../src/glm/eligibility.ts";
import {
  deriveBoardState,
  glmWithheldIssueNumbers,
  isGlmWithheldFromClaude,
} from "../src/autopilot/board-state.ts";
import { ORCH_BOARD_LABELS } from "../src/board-labels.ts";
// The ADR-0008 freshness window (DESIGN_CONCEPT_MAX_AGE_MS, 7 days), restated
// here rather than imported so this file's #4134 sprawl-ratchet subject stays
// src/glm/eligibility.ts; the boundary cases below pin the two against each other.
const DESIGN_CONCEPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
import type { IssueRow } from "../src/github/issues.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const ELIGIBILITY_SRC = join(REPO_ROOT, "src", "glm", "eligibility.ts");
const BOARD_STATE_SRC = join(REPO_ROOT, "src", "autopilot", "board-state.ts");
const SWEEP_SRC = join(REPO_ROOT, "src", "scheduler", "chores", "glm-eligibility-sweep.ts");

const RFA = ORCH_BOARD_LABELS.ready_for_agent;
const ELIG = ORCH_BOARD_LABELS.glm_eligible;
const WITHHOLD = ORCH_BOARD_LABELS.glm_withhold;
const AB = ORCH_BOARD_LABELS.glm_ab_control;
const IN_PROG = ORCH_BOARD_LABELS.in_progress;
const TARGET = ORCH_BOARD_LABELS.target_backlog;
const CLEANUP = ORCH_BOARD_LABELS.cleanup_scan;
const NDC = ORCH_BOARD_LABELS.needs_design_concept;

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function issueRow(number: number, labels: string[], body = ""): IssueRow {
  return {
    number,
    title: `Issue #${number}`,
    url: `https://github.com/x/y/issues/${number}`,
    createdAt: "",
    labels,
    body,
    state: "OPEN",
    updatedAt: "",
  };
}

function ctx(over: Partial<GlmPickContext> = {}): GlmPickContext {
  return {
    artifact: { status: "approved", createdAt: NOW - DAY_MS },
    openPrs: [],
    mergedPrs: [],
    openBlockers: new Set(),
    now: NOW,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// glmLane — every ruling (INV-3)
// ---------------------------------------------------------------------------

describe("glmLane — the label-only lane ruling (ADR-0040 Decision 4)", () => {
  const CASES: Array<{
    name: string;
    labels: string[];
    live: boolean;
    lane: GlmLaneName;
    reason: string;
  }> = [
    { name: "(a) no ready-for-agent -> neither", labels: [ELIG], live: true, lane: "neither", reason: "not-ready-for-agent" },
    { name: "(a) beats withhold", labels: [WITHHOLD, ELIG], live: true, lane: "neither", reason: "not-ready-for-agent" },
    { name: "(b) glm-ab-control -> claude (row 1)", labels: [RFA, ELIG, AB], live: true, lane: "claude", reason: "claude-pinned" },
    { name: "(b) glm-withhold -> claude (row 1, #4649)", labels: [RFA, ELIG, WITHHOLD], live: true, lane: "claude", reason: "claude-pinned" },
    { name: "(b) beats in-progress", labels: [RFA, WITHHOLD, IN_PROG], live: true, lane: "claude", reason: "claude-pinned" },
    { name: "(c) in-progress -> neither (row 8)", labels: [RFA, ELIG, IN_PROG], live: true, lane: "neither", reason: "claimed" },
    { name: "(c) target-backlog -> neither (row 9)", labels: [RFA, ELIG, TARGET], live: true, lane: "neither", reason: "target-scope" },
    { name: "(c) beats partition-inactive", labels: [RFA, IN_PROG], live: false, lane: "neither", reason: "claimed" },
    { name: "(d) partition inactive -> claude (row 11)", labels: [RFA, ELIG], live: false, lane: "claude", reason: "partition-inactive" },
    { name: "(e) glm-eligible + live -> glm", labels: [RFA, ELIG], live: true, lane: "glm", reason: "glm-owned" },
    { name: "(f) plain ready-for-agent + live -> claude", labels: [RFA], live: true, lane: "claude", reason: "not-glm-owned" },
  ];
  for (const c of CASES) {
    test(c.name, () => {
      assert.deepEqual(glmLane(c.labels, c.live), { lane: c.lane, reason: c.reason });
    });
  }
});

// ---------------------------------------------------------------------------
// isGlmWithheldFromClaude — rewired onto glmLane (INV-4), #4649 regression
// ---------------------------------------------------------------------------

describe("isGlmWithheldFromClaude delegates to glmLane (issue #4684, #4649 regression)", () => {
  test("regression #4649: glm-eligible + glm-withhold with a live partition is counted in ready_for_agent and absent from glm_withheld", () => {
    const rows = [issueRow(4649, [RFA, ELIG, WITHHOLD])];
    assert.equal(isGlmWithheldFromClaude(rows[0].labels, true), false);
    assert.equal(deriveBoardState(rows, NOW, new Set(), true).ready_for_agent, 1);
    assert.deepEqual(glmWithheldIssueNumbers(rows, true), []);
  });

  test("a plain glm-eligible row with a live partition is still withheld (not counted, listed)", () => {
    const rows = [issueRow(10, [RFA, ELIG])];
    assert.equal(deriveBoardState(rows, NOW, new Set(), true).ready_for_agent, 0);
    assert.deepEqual(glmWithheldIssueNumbers(rows, true), [10]);
  });

  test("equals glmLane(...).lane === 'glm' over the full label power set, both liveness values", () => {
    const vocab = [RFA, ELIG, WITHHOLD, AB, IN_PROG, TARGET];
    for (let mask = 0; mask < 1 << vocab.length; mask++) {
      const labels = vocab.filter((_, i) => mask & (1 << i));
      for (const live of [true, false]) {
        assert.equal(
          isGlmWithheldFromClaude(labels, live),
          glmLane(labels, live).lane === "glm",
          `labels=${JSON.stringify(labels)} live=${live}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Purity + label-home guards (INV-1, AC-1, AC-3)
// ---------------------------------------------------------------------------

describe("label home — no label literal outside src/board-labels.ts (issue #4684)", () => {
  const LABEL_VALUES = Object.values(ORCH_BOARD_LABELS) as string[];

  /** Code only: block and line comments removed (prose may name labels freely). */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  function quotedLabelLiterals(src: string): string[] {
    const code = stripComments(src);
    return LABEL_VALUES.filter((v) => new RegExp(`["'\`]${v}["'\`]`).test(code));
  }

  /** The source text of `export function <name>(` up to the next top-level `}`. */
  function functionBody(src: string, name: string): string {
    const m = new RegExp(`export function ${name}\\([\\s\\S]*?\\n}\\n`).exec(src);
    assert.ok(m, `could not locate function ${name}`);
    return m[0];
  }

  test("src/glm/eligibility.ts carries no label literal and imports no I/O module", () => {
    const src = readFileSync(ELIGIBILITY_SRC, "utf-8");
    assert.deepEqual(quotedLabelLiterals(src), []);
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), [
      "../board-labels.ts",
      "../design-concept-gate.ts",
      "../github/blockers.ts",
      "../github/pr-refs.ts",
    ]);
    assert.doesNotMatch(stripComments(src), /process\.env|Date\.now\(|fetch\(|node:/);
  });

  test("isGlmWithheldFromClaude and isGlmEligibleCandidate contain no label literal of their own", () => {
    const withheld = functionBody(readFileSync(BOARD_STATE_SRC, "utf-8"), "isGlmWithheldFromClaude");
    const candidate = functionBody(readFileSync(SWEEP_SRC, "utf-8"), "isGlmEligibleCandidate");
    assert.deepEqual(quotedLabelLiterals(withheld), []);
    assert.deepEqual(quotedLabelLiterals(candidate), []);
    assert.match(withheld, /glmLane\(/);
    assert.match(candidate, /glmLane\(/);
  });
});

// ---------------------------------------------------------------------------
// glmPickVerdict — the non-grill arms (INV-6)
// ---------------------------------------------------------------------------

describe("glmGrillExemption — collect-state's precedence (INV-7)", () => {
  const base: GlmPickRow = { number: 1, labels: [RFA, ELIG], title: "Do a thing", body: "" };
  const CASES: Array<{ name: string; row: GlmPickRow; expected: ReturnType<typeof glmGrillExemption> }> = [
    { name: "cleanup-scan label -> cleanup-scan", row: { ...base, labels: [CLEANUP] }, expected: CLEANUP },
    { name: "cleanup-scan beats needs-design-concept", row: { ...base, labels: [CLEANUP, NDC] }, expected: CLEANUP },
    { name: "cleanup-scan beats a track: title", row: { ...base, labels: [CLEANUP], title: "track: x" }, expected: CLEANUP },
    { name: "track: title -> track-title", row: { ...base, title: " Track: window" }, expected: "track-title" },
    { name: "track: title beats needs-design-concept", row: { ...base, labels: [NDC], title: "track: w" }, expected: "track-title" },
    { name: "T1 stamp -> expected-tier-t1", row: { ...base, body: "Expected tier: T1" }, expected: "expected-tier-t1" },
    { name: "T1 stamp + needs-design-concept -> null (opt-in wins)", row: { ...base, labels: [NDC], body: "Expected tier: T1" }, expected: null },
    { name: "T12 stamp -> null (word boundary)", row: { ...base, body: "Expected tier: T12" }, expected: null },
    { name: "null body and title -> null", row: { number: 1, labels: [], title: null, body: null }, expected: null },
  ];
  for (const c of CASES) {
    test(c.name, () => {
      assert.equal(glmGrillExemption(c.row), c.expected);
    });
  }
});

describe("glmPickVerdict — check order (ADR-0040 rows 2–7)", () => {
  const PICKABLE: GlmPickRow = { number: 500, labels: [RFA, ELIG], title: "Do a thing", body: "" };

  const CASES: Array<{ name: string; row: GlmPickRow; ctx: GlmPickContext; expected: GlmPickVerdict }> = [
    { name: "approved fresh artifact -> approved-fresh", row: PICKABLE, ctx: ctx(), expected: { pickable: true, reason: "approved-fresh" } },
    { name: "not glm lane (glm-withhold) -> lane", row: { ...PICKABLE, labels: [RFA, ELIG, WITHHOLD] }, ctx: ctx(), expected: { pickable: false, reason: "lane" } },
    { name: "no glm-eligible -> lane", row: { ...PICKABLE, labels: [RFA] }, ctx: ctx(), expected: { pickable: false, reason: "lane" } },
    { name: "in-progress -> lane", row: { ...PICKABLE, labels: [RFA, ELIG, IN_PROG] }, ctx: ctx(), expected: { pickable: false, reason: "lane" } },
    { name: "lane beats track-title", row: { ...PICKABLE, labels: [RFA], title: "track: x" }, ctx: ctx(), expected: { pickable: false, reason: "lane" } },
    { name: "track: title (leading whitespace, any case) -> track-title", row: { ...PICKABLE, title: "  TRACK: window" }, ctx: ctx(), expected: { pickable: false, reason: "track-title" } },
    { name: "track: beats a T1 stamp", row: { ...PICKABLE, title: "track: w", body: "Expected tier: T1" }, ctx: ctx(), expected: { pickable: false, reason: "track-title" } },
    { name: "open strict blocker -> open-blocker", row: { ...PICKABLE, body: "Blocked by #77" }, ctx: ctx({ openBlockers: new Set([77]) }), expected: { pickable: false, reason: "open-blocker" } },
    { name: "closed strict blocker -> not blocked", row: { ...PICKABLE, body: "Blocked by #77" }, ctx: ctx({ openBlockers: new Set([78]) }), expected: { pickable: true, reason: "approved-fresh" } },
    { name: "self-reference is never a blocker", row: { ...PICKABLE, body: "Blocked by #500" }, ctx: ctx({ openBlockers: new Set([500]) }), expected: { pickable: true, reason: "approved-fresh" } },
    { name: "open PR via body Closes #N -> open-pr", row: PICKABLE, ctx: ctx({ openPrs: [{ body: "Closes #500" }] }), expected: { pickable: false, reason: "open-pr" } },
    { name: "open PR via issue-<N> branch -> open-pr", row: PICKABLE, ctx: ctx({ openPrs: [{ headRefName: "issue-500-thing" }] }), expected: { pickable: false, reason: "open-pr" } },
    { name: "open PR via Refs #N -> open-pr (union semantics)", row: PICKABLE, ctx: ctx({ openPrs: [{ body: "Refs #500" }] }), expected: { pickable: false, reason: "open-pr" } },
    { name: "open PR for another issue -> ignored", row: PICKABLE, ctx: ctx({ openPrs: [{ body: "Closes #5000" }] }), expected: { pickable: true, reason: "approved-fresh" } },
    { name: "merged PR title anchor (#N) -> merged-pr", row: PICKABLE, ctx: ctx({ mergedPrs: [{ title: "feat: x (#500)" }] }), expected: { pickable: false, reason: "merged-pr" } },
    { name: "merged PR body Fixes #N -> merged-pr", row: PICKABLE, ctx: ctx({ mergedPrs: [{ body: "Fixes #500" }] }), expected: { pickable: false, reason: "merged-pr" } },
    { name: "open-blocker beats open-pr", row: { ...PICKABLE, body: "Depends on #9" }, ctx: ctx({ openBlockers: new Set([9]), openPrs: [{ body: "Closes #500" }] }), expected: { pickable: false, reason: "open-blocker" } },
    { name: "open-pr beats cleanup-scan", row: { ...PICKABLE, labels: [RFA, ELIG, CLEANUP] }, ctx: ctx({ openPrs: [{ body: "Closes #500" }], artifact: null }), expected: { pickable: false, reason: "open-pr" } },
    { name: "artifact null -> artifact-missing", row: PICKABLE, ctx: ctx({ artifact: null }), expected: { pickable: false, reason: "artifact-missing" } },
    { name: "artifact draft -> artifact-draft", row: PICKABLE, ctx: ctx({ artifact: { status: "draft", createdAt: NOW } }), expected: { pickable: false, reason: "artifact-draft" } },
    { name: "artifact status stale -> artifact-stale", row: PICKABLE, ctx: ctx({ artifact: { status: "stale", createdAt: NOW } }), expected: { pickable: false, reason: "artifact-stale" } },
    { name: "approved exactly at the 7-day boundary -> approved-fresh", row: PICKABLE, ctx: ctx({ artifact: { status: "approved", createdAt: NOW - DESIGN_CONCEPT_MAX_AGE_MS } }), expected: { pickable: true, reason: "approved-fresh" } },
    { name: "approved 1ms past 7 days -> artifact-stale", row: PICKABLE, ctx: ctx({ artifact: { status: "approved", createdAt: NOW - DESIGN_CONCEPT_MAX_AGE_MS - 1 } }), expected: { pickable: false, reason: "artifact-stale" } },
    { name: "approved with non-finite createdAt -> artifact-stale", row: PICKABLE, ctx: ctx({ artifact: { status: "approved", createdAt: Number.NaN } }), expected: { pickable: false, reason: "artifact-stale" } },
    { name: "approved with createdAt 0 -> artifact-stale", row: PICKABLE, ctx: ctx({ artifact: { status: "approved", createdAt: 0 } }), expected: { pickable: false, reason: "artifact-stale" } },
  ];
  for (const c of CASES) {
    test(c.name, () => {
      assert.deepEqual(glmPickVerdict(c.row, c.ctx), c.expected);
    });
  }
});
