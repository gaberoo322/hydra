/**
 * Regression tests for `scripts/autopilot/decide.py` — the GitHub-board Target
 * dispatch branch (issue #3435, spec #3432, ADR-0031).
 *
 * ADR-0031 migrates Target task tracking from Redis to GitHub Issues on the
 * Target repo. `collect-state.sh` now reads the scope=target board-state
 * (`GET /api/autopilot/board-state?scope=target`, issue #3434) and emits
 * `target_ready_for_agent` / `target_needs_qa` / `target_needs_research`
 * counts. The autopilot maps those to board signals which decide.py's Target
 * branch dispatches from — the orch-style Target decision:
 *
 *   - `target_board_work_available` (ready-for-agent present) → `dev_target`
 *   - `target_board_research_due`   (board empty)             → `research_target`
 *   - `needs_qa_target`             (needs-qa present)        → `qa_target`
 *
 * BLOCKED EXCLUSION: the board's `ready_for_agent` count is already
 * open-blocker-excluded via the inherited #3059 strict blocked-by/depends-on
 * filter (the scope=target board-state reuses `deriveBoardState` unchanged), so
 * a dependency-blocked Target issue never sets `target_board_work_available` —
 * the exclusion is enforced upstream at the board read, not re-derived here.
 *
 * EXPAND PHASE (ADR-0030): the legacy Redis signals (`target_work_available`,
 * `target_research_due`, the candidate-feed `research_recommended` path) still
 * fire in parallel — nothing Redis-side is removed. These tests pin that the
 * new GitHub-board signals ALSO drive the Target branch.
 *
 * Exercised through the `decide` CLI subcommand, pinning the JSON wire
 * contract (same harness as test/decide-cleanup-target-class.test.mts).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-target-board-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

interface StateOverrides {
  scope?: string;
  signal_last_fired?: Record<string, number>;
  signals?: Record<string, unknown>;
}

function baseState(o: StateOverrides = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      scope: o.scope ?? "all",
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    turn: 0,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: {
      dev_orch: null,
      qa_orch: null,
      research_orch: null,
      dev_target: null,
      qa_target: null,
      research_target: null,
      design_concept_orch: null,
    },
    signal_last_fired: o.signal_last_fired ?? {
      health: 0,
      sweep_orch: 0,
      sweep_target: 0,
      discover_orch: 0,
      discover_target: 0,
    },
    signals: o.signals ?? {},
    research_force_counter: {},
  };
}

/**
 * A candidate feed that explicitly does NOT recommend research, so the legacy
 * candidate-feed `research_target` trigger (research_recommended) stays silent
 * and only the GitHub-board signals under test can drive the Target branch. A
 * `null` candidates payload defaults `research_recommended` to True (degrade
 * toward research), which would confound the board-signal assertions.
 */
const feedNoResearch = {
  candidates: [{ anchorRef: "item-1", score: 0.9 }],
  research_recommended: false,
};

function runDecide(state: any, candidates: any, events: any[] = []): any {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(candidates));
    writeFileSync(t.events, JSON.stringify(events));
    const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

function findAction(plan: any, predicate: (a: any) => boolean): any | undefined {
  return (plan.actions ?? []).find(predicate);
}

const devTarget = (a: any) => a.type === "dispatch" && a.slot === "dev_target";
const researchTarget = (a: any) => a.type === "dispatch" && a.slot === "research_target";
const qaTarget = (a: any) => a.type === "dispatch" && a.slot === "qa_target";

describe("decide.py — GitHub-board Target dispatch branch (issue #3435, ADR-0031)", () => {
  test("target_board_work_available → dev_target dispatches hydra-target-build", () => {
    const state = baseState({ signals: { target_board_work_available: true } });
    const plan = runDecide(state, feedNoResearch);
    const a = findAction(plan, devTarget);
    assert.ok(a, "dev_target must dispatch when the target GH board has ready-for-agent work");
    assert.equal(a.skill, "hydra-target-build");
  });

  test("legacy Redis target_work_available STILL drives dev_target (expand-phase parallelism)", () => {
    const state = baseState({ signals: { target_work_available: true } });
    const plan = runDecide(state, feedNoResearch);
    assert.ok(
      findAction(plan, devTarget),
      "the legacy Redis signal must keep firing dev_target during the ADR-0031 expand phase",
    );
  });

  test("neither dev_target signal present → dev_target idles", () => {
    const state = baseState({ signals: {} });
    const plan = runDecide(state, feedNoResearch);
    assert.equal(
      findAction(plan, devTarget),
      undefined,
      "an empty target board (no ready-for-agent) must not dispatch dev_target",
    );
  });

  test("target_board_research_due → research_target dispatches hydra-target-research", () => {
    const state = baseState({ signals: { target_board_research_due: true } });
    const plan = runDecide(state, feedNoResearch);
    const a = findAction(plan, researchTarget);
    assert.ok(a, "research_target must dispatch when the target GH board is empty of work");
    assert.equal(a.skill, "hydra-target-research");
    assert.equal(
      a.reason,
      "target GitHub board empty of ready-for-agent work",
      "the board-empty branch carries its own reason string",
    );
  });

  test("target_board_research_due is NOT subject to the daily force cap", () => {
    // The candidate-feed research path is force-capped (4/day); the board-empty
    // signal is a plain board read, so a maxed-out force counter must not
    // suppress it. Seed today's counter at the cap and confirm it still fires.
    const today = new Date().toISOString().slice(0, 10);
    const state = baseState({ signals: { target_board_research_due: true } });
    state.research_force_counter = { [today]: { research_target: 99 } };
    const plan = runDecide(state, feedNoResearch);
    assert.ok(
      findAction(plan, researchTarget),
      "board-empty research must fire regardless of the force cap",
    );
  });

  test("needs_qa_target (board target_needs_qa>0) → qa_target dispatches hydra-qa scope=target", () => {
    const state = baseState({ signals: { needs_qa_target: true } });
    const plan = runDecide(state, feedNoResearch);
    const a = findAction(plan, qaTarget);
    assert.ok(a, "qa_target must dispatch when the target GH board has needs-qa work");
    assert.equal(a.skill, "hydra-qa");
    assert.equal((a.prompt_args ?? {}).scope, "target");
  });

  test("dev_target board signal excluded under orch-only scope", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { target_board_work_available: true },
    });
    const plan = runDecide(state, feedNoResearch);
    assert.equal(
      findAction(plan, devTarget),
      undefined,
      "orch-only scope must exclude the Target dispatch classes",
    );
  });

  test("dev_target board signal allowed under target-only scope", () => {
    const state = baseState({
      scope: "target-only",
      signals: { target_board_work_available: true },
    });
    const plan = runDecide(state, feedNoResearch);
    assert.ok(
      findAction(plan, devTarget),
      "target-only scope must allow the GitHub-board dev_target dispatch",
    );
  });

  test("ready-for-agent present takes dev_target, not research_target (board-empty is the negation)", () => {
    // The two board signals are mutually exclusive at the collector
    // (ready_for_agent>0 sets work_available; ==0 sets research_due). Pin that
    // when work IS available, dev_target fires and the board-empty research
    // branch stays silent.
    const state = baseState({ signals: { target_board_work_available: true } });
    const plan = runDecide(state, feedNoResearch);
    assert.ok(findAction(plan, devTarget), "dev_target fires when the board has work");
    assert.equal(
      findAction(plan, researchTarget),
      undefined,
      "the board-empty research branch must NOT fire when the board has ready-for-agent work",
    );
  });
});
