/**
 * Tests for `src/glm/eligibility.ts` — the ONE GLM-lane eligibility predicate
 * (ADR-0040 Decision 4 + Decision 5; epic #4681, issue #4684).
 *
 * Table-driven, fake deps, no golden files, no git (the #4679 test-port rule).
 * The one process this file spawns is `python3`: the cross-language parity
 * section extracts collect-state.sh's MECHANICAL / TRIVIAL grill-exemption
 * python heredocs from the committed script AT RUN TIME and runs them over the
 * same inline case table as `glmGrillExemption` — so an edit to either side
 * alone fails here. (This replaces the collect-state LOCKSTEP comment.)
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import {
  glmLane,
  glmGrillExemption,
  glmPickVerdict,
  type GlmGrillExemption,
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
import { DESIGN_CONCEPT_MAX_AGE_MS } from "../src/design-concept-gate.ts";
import type { IssueRow } from "../src/github/issues.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const COLLECT_STATE = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
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

// ---------------------------------------------------------------------------
// Grill-exemption parity vs collect-state.sh's python (INV-7, INV-8, INV-9)
// ---------------------------------------------------------------------------

/**
 * One parity row. `row` is the gh-shaped issue fed to collect-state's python
 * (labels as `[{name}]`); `artifact` is the design-concept context for the TS
 * verdict. `row: null` is a python-only fail-closed case (issue absent from
 * the list) — no TS call.
 */
interface ParityCase {
  name: string;
  n: number;
  row: { number: number; title?: string; labels: string[]; body?: string | null } | null;
  artifact: GlmPickContext["artifact"];
  exemption: GlmGrillExemption | null;
  verdict: GlmPickVerdict | null;
}

/** Lane labels every TS row needs so the lane check passes and the grill arm is reached. */
const LANE = [RFA, ELIG];

// The 12 D9 cases from test/glm-drainer-loop.test.mts (labels/body verbatim,
// plus the lane labels), then the four rows the table itself doesn't reach.
const PARITY: ParityCase[] = [
  { name: "D9 101 cleanup-scan label", n: 101, row: { number: 101, labels: [...LANE, CLEANUP] }, artifact: null, exemption: "cleanup-scan", verdict: { pickable: true, reason: "cleanup-scan" } },
  { name: "D9 102 Expected tier: T1 stamp", n: 102, row: { number: 102, labels: [...LANE], body: "Do it.\n\nExpected tier: T1" }, artifact: null, exemption: "expected-tier-t1", verdict: { pickable: true, reason: "expected-tier-t1" } },
  { name: "D9 103 Expected tier: 1 stamp", n: 103, row: { number: 103, labels: [...LANE], body: "Expected tier: 1" }, artifact: null, exemption: "expected-tier-t1", verdict: { pickable: true, reason: "expected-tier-t1" } },
  { name: "D9 104 lowercase 'expected tier: t1'", n: 104, row: { number: 104, labels: [...LANE], body: "expected tier: t1" }, artifact: null, exemption: "expected-tier-t1", verdict: { pickable: true, reason: "expected-tier-t1" } },
  { name: "D9 105 T1 stamp + needs-design-concept (opt-in wins)", n: 105, row: { number: 105, labels: [...LANE, NDC], body: "Expected tier: T1" }, artifact: null, exemption: null, verdict: { pickable: false, reason: "artifact-missing" } },
  { name: "D9 106 T12 stamp (word boundary rejects)", n: 106, row: { number: 106, labels: [...LANE], body: "Expected tier: T12" }, artifact: null, exemption: null, verdict: { pickable: false, reason: "artifact-missing" } },
  { name: "D9 107 T3 stamp", n: 107, row: { number: 107, labels: [...LANE], body: "Expected tier: T3" }, artifact: null, exemption: null, verdict: { pickable: false, reason: "artifact-missing" } },
  { name: "D9 108 empty body", n: 108, row: { number: 108, labels: [...LANE], body: "" }, artifact: null, exemption: null, verdict: { pickable: false, reason: "artifact-missing" } },
  { name: "D9 109 cleanup-scan + needs-design-concept (unconditional)", n: 109, row: { number: 109, labels: [...LANE, CLEANUP, NDC], body: "irrelevant" }, artifact: null, exemption: "cleanup-scan", verdict: { pickable: true, reason: "cleanup-scan" } },
  { name: "D9 110 null body", n: 110, row: { number: 110, labels: [...LANE], body: null }, artifact: null, exemption: null, verdict: { pickable: false, reason: "artifact-missing" } },
  { name: "D9 111 no stamp + approved artifact within 7 days", n: 111, row: { number: 111, labels: [...LANE], body: "no stamps here" }, artifact: { status: "approved", createdAt: NOW - 2 * DAY_MS }, exemption: null, verdict: { pickable: true, reason: "approved-fresh" } },
  { name: "D9 112 issue absent from rows (python fail-closed)", n: 112, row: null, artifact: null, exemption: null, verdict: null },
  { name: "track: title row", n: 113, row: { number: 113, title: "track: 14-day measurement window", labels: [...LANE], body: "" }, artifact: null, exemption: "track-title", verdict: { pickable: false, reason: "track-title" } },
  { name: "cleanup-scan + track: title (exemption cleanup-scan, verdict track-title)", n: 114, row: { number: 114, title: "Track: remove dead export", labels: [...LANE, CLEANUP], body: "" }, artifact: null, exemption: "cleanup-scan", verdict: { pickable: false, reason: "track-title" } },
  { name: "stale approved artifact (8 days old)", n: 115, row: { number: 115, labels: [...LANE], body: "plain" }, artifact: { status: "approved", createdAt: NOW - 8 * DAY_MS }, exemption: null, verdict: { pickable: false, reason: "artifact-stale" } },
  { name: "fresh draft artifact", n: 116, row: { number: 116, labels: [...LANE], body: "plain" }, artifact: { status: "draft", createdAt: NOW - DAY_MS }, exemption: null, verdict: { pickable: false, reason: "artifact-draft" } },
];

/** Extract the `<<'PY' ... ^PY$` heredoc body following `<VAR>=$(printf` in collect-state.sh. */
function extractPython(src: string, varName: "MECHANICAL" | "TRIVIAL"): string {
  const re = new RegExp(`\\n\\s*${varName}=\\$\\(printf[^\\n]*<<'PY'\\n([\\s\\S]*?)\\nPY\\n`);
  const m = re.exec(src);
  assert.ok(m, `could not locate the ${varName} python heredoc in collect-state.sh`);
  const body = m[1];
  assert.ok(body.trim().length > 0, `${varName} python heredoc extracted empty`);
  return body;
}

function runPython(snippet: string, n: number, rows: unknown[]): string {
  const r = spawnSync("python3", ["-c", snippet], {
    input: JSON.stringify(rows),
    encoding: "utf-8",
    env: { ...process.env, ORCH_GRILL_N: String(n) },
  });
  // A missing python3 FAILS (never skips): the parity check is load-bearing.
  assert.equal(r.error, undefined, `python3 could not be spawned: ${r.error?.message}`);
  assert.equal(r.status, 0, `python snippet exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

describe("grill-exemption parity: glmGrillExemption vs collect-state.sh MECHANICAL/TRIVIAL python (ADR-0040 Decision 5)", () => {
  const src = readFileSync(COLLECT_STATE, "utf-8");
  const MECHANICAL = extractPython(src, "MECHANICAL");
  const TRIVIAL = extractPython(src, "TRIVIAL");

  test("both python heredocs are extracted and non-empty", () => {
    assert.match(MECHANICAL, /cleanup-scan/);
    assert.match(TRIVIAL, /Expected/);
  });

  for (const c of PARITY) {
    test(`parity: ${c.name}`, () => {
      const ghRows =
        c.row === null
          ? []
          : [
              {
                number: c.row.number,
                title: c.row.title ?? `Issue ${c.row.number}`,
                labels: c.row.labels.map((name) => ({ name })),
                body: c.row.body,
              },
            ];
      const mech = runPython(MECHANICAL, c.n, ghRows);
      const triv = runPython(TRIVIAL, c.n, ghRows);

      if (c.row === null) {
        assert.equal(mech, "0", "absent row: MECHANICAL must fail closed");
        assert.equal(triv, "0", "absent row: TRIVIAL must fail closed");
        return;
      }

      const row: GlmPickRow = {
        number: c.row.number,
        labels: c.row.labels,
        title: c.row.title ?? `Issue ${c.row.number}`,
        body: c.row.body,
      };
      const exemption = glmGrillExemption(row);
      assert.equal(exemption, c.exemption, "TS exemption");

      // Agreement at the MECHANICAL/TRIVIAL level.
      const tsMechanical = exemption === "cleanup-scan" || exemption === "track-title";
      assert.equal(mech, tsMechanical ? "1" : "0", "MECHANICAL parity");
      if (mech === "0") {
        assert.equal(triv, exemption === "expected-tier-t1" ? "1" : "0", "TRIVIAL parity");
      }

      assert.deepEqual(glmPickVerdict(row, ctx({ artifact: c.artifact })), c.verdict, "TS verdict");
    });
  }
});
