/**
 * decide.py — per-class signal gating (issue #4136 consolidation).
 *
 * Merged verbatim from six one-file-per-issue test files:
 * decide-cleanup-target-class, decide-design-qa-target-class,
 * decide-retro-class, decide-skill-prune-class, decide-tickets-class,
 * decide-target-board-dispatch.
 *
 * All six asked the same question of the same subject — "does decide.py emit
 * THIS dispatch class when its signals fire?" — and all six spawn
 * scripts/autopilot/decide.py rather than importing anything from src/. One
 * file per issue meant an agent touching class gating had to discover and read
 * six; epic #4131 measured that discovery cost as the largest single drain on
 * operator Claude quota in the suite.
 *
 * Each source file's body is wrapped in its own block so its module-scope
 * REPO_ROOT / DECIDE / fixtures stay private — block nesting does not change
 * node:test nesting, so every describe() below is still top-level. No test
 * text was edited.
 *
 * Adding a case for a class covered here belongs in this file, not a new one
 * (test/test-file-sprawl-guard.test.mts enforces that).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// #4519: the signal-parity legs consume the pure module (a `../scripts/ci`
// import does not reassign this file's primary subject — no src import).
import {
  checkSignalParity,
  extractDecideReads,
  extractEmittedSignals,
  extractWiringRows,
  NON_KV_PRODUCERS,
  OBSERVABILITY_ONLY_ROWS,
  PRODUCERLESS_SIGNALS,
} from "../scripts/ci/signal-parity-check.ts";

// ===========================================================================
// Merged from test/decide-cleanup-target-class.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Regression tests for `scripts/autopilot/decide.py` — the `cleanup_target`
 * signal class: the TARGET mirror of `cleanup_orch` (operator-approved
 * 2026-06-10, after hydra-betting PR #93 shipped the Target's deadcode
 * ratchet + the CLAUDE.md rule-3 cleanup carve-out).
 *
 * `cleanup_target` dispatches the headless `/hydra-target-cleanup` skill — a
 * deterministic, demote-only dead-export sweep over ~/hydra-betting/web that
 * files ready-for-agent items into the Redis target backlog. The class
 * mirrors cleanup_orch's signal discipline exactly:
 *
 *   - Fires on the precomputed `target_backfill_idle` signal (collect-state.sh
 *     emits it when the target triage + queued lanes and the Redis work-queue
 *     are all empty). decide.py never recomputes board state.
 *   - `target_cleanup_board_saturated` is the PRIMARY suppressor, checked
 *     FIRST — a board already holding >10 open cleanup-scan items suppresses
 *     the scan before the cooldown is even consulted.
 *   - 1h class cooldown (`SIGNAL_COOLDOWNS["cleanup_target"]`) as the cadence
 *     back-stop.
 *   - Target-scope by definition: excluded under `orch-only` scope
 *     (SCOPE_ORCH_ONLY_EXCLUDE), allowed under `target-only` — the exact
 *     inverse of cleanup_orch's scope placement.
 *   - Dispatches with `apply: true` so a headless run EMITS (the #1078
 *     retro_orch lesson: an argument-free dispatch of a dry-run-default skill
 *     is a silent no-op).
 *
 * Exercised through the `decide` CLI subcommand, pinning the JSON wire
 * contract (same harness as test/decide-retro-class.test.mts).
 */








const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-cleanup-target-test-"));
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

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
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

const cleanupTarget = (a: any) => a.type === "dispatch" && a.slot === "cleanup_target";

describe("decide.py — cleanup_target signal class (Target mirror of cleanup_orch)", () => {
  test("fires on target_backfill_idle and invokes hydra-target-cleanup with apply:true", () => {
    const state = baseState({ signals: { target_backfill_idle: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, cleanupTarget);
    assert.ok(a, "cleanup_target must dispatch on target_backfill_idle");
    assert.equal(a.skill, "hydra-target-cleanup");
    // The #1078 lesson: a dry-run-default skill dispatched headlessly without
    // apply:true is a silent no-op — the class would never file anything.
    assert.equal((a.prompt_args ?? {}).apply, true, "headless dispatch must carry apply:true");
  });

  test("does NOT fire without target_backfill_idle", () => {
    const plan = runDecide(baseState(), null);
    assert.equal(
      findAction(plan, cleanupTarget),
      undefined,
      "cleanup_target must not dispatch when the target board has actionable work",
    );
  });

  test("target_cleanup_board_saturated suppresses the dispatch even when idle (checked FIRST)", () => {
    const state = baseState({
      signals: { target_backfill_idle: true, target_cleanup_board_saturated: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, cleanupTarget),
      undefined,
      "a saturated cleanup board must suppress the scan before anything else",
    );
  });

  test("excluded under orch-only scope (target-scope by definition)", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { target_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, cleanupTarget),
      undefined,
      "orch-only scope must exclude cleanup_target — the inverse of cleanup_orch's placement",
    );
  });

  test("allowed under target-only scope", () => {
    const state = baseState({
      scope: "target-only",
      signals: { target_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, cleanupTarget),
      "target-only must NOT exclude cleanup_target",
    );
  });

  test("suppressed when recently fired (within the 1h cooldown)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { target_backfill_idle: true },
      signal_last_fired: { cleanup_target: now - 10 * 60 } as any, // 10 min ago
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, cleanupTarget),
      undefined,
      "10 min ago is inside the 1h cleanup_target cooldown",
    );
  });

  test("fires after the 1h cooldown elapses", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { target_backfill_idle: true },
      signal_last_fired: { cleanup_target: now - 2 * 60 * 60 } as any, // 2h ago
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, cleanupTarget),
      "cleanup_target must fire once the 1h cooldown has elapsed",
    );
  });

  test("does not preempt a dev_target pipeline dispatch (spare-capacity contract)", () => {
    // Pipeline slots dispatch BEFORE the signal loop. When target work IS
    // available the board is not idle, so cleanup_target stays silent — but
    // even with both signals present (a stale-idle race), the dev_target
    // dispatch must still appear; the signal class only rides alongside.
    const state = baseState({
      signals: { target_work_available: true, target_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      "dev_target pipeline dispatch must still fire when target work is available",
    );
  });
});
}

// ===========================================================================
// Merged from test/decide-design-qa-target-class.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Regression tests for `scripts/autopilot/decide.py` — the `design_qa_target`
 * signal class (issue #2739, parent #2732: the Target UI-quality loop).
 *
 * `design_qa_target` dispatches the headless `/hydra-design-qa` skill — a
 * periodic VISUAL QA pass that captures the slice-1 screenshot set of every
 * nav-registry route on ~/hydra-betting/web, judges each page against the
 * Target design-language ADR (hydra-betting/docs/adr/0005-design-language.md —
 * density budget, clutter, consistency), and files AT MOST 3 deduped
 * needs-triage Target-backlog items per run, each citing the specific ADR rule
 * violated plus screenshot evidence.
 *
 * The class marries two established disciplines:
 *
 *   - scout_orch's CALENDAR cadence: the 7d class cooldown
 *     (`SIGNAL_COOLDOWNS["design_qa_target"]`) is the primary cadence control,
 *     seeded in bootstrap.sh so it survives the pace-gate relaunch (#2575).
 *     collect-state.sh emits `design_qa_target_due` true whenever the Target
 *     board is reachable AND not saturated — there is always UI to review, so
 *     the "due" predicate is just "board reachable + capacity".
 *   - cleanup_target / wire_or_retire_target's saturation + routing discipline:
 *     `design_qa_target_saturated` is the anti-flood cap, checked FIRST — a
 *     board already holding >5 open `design-qa`-labelled items suppresses the
 *     pass before the cooldown is even consulted. Findings route needs-triage
 *     (NOT ready-for-agent): this is JUDGMENT work (epic #2720 confidence
 *     routing).
 *
 * The dispatch carries `apply: true` (the #1078 lesson: a dry-run-default skill
 * dispatched headlessly without it is a silent no-op) and `max_items: 3` (the
 * per-run finding cap, machine-enforceable at the dispatch seam). It OMITS the
 * model param (judgment work inherits the parent, #1093).
 *
 * Target-scope by definition: excluded under `orch-only`, allowed under
 * `target-only` — the exact inverse of the orch signal classes.
 *
 * Exercised through the `decide` CLI subcommand, pinning the JSON wire
 * contract (same harness as test/decide-cleanup-target-class.test.mts).
 */








const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-design-qa-target-test-"));
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

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
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

const designQaTarget = (a: any) =>
  a.type === "dispatch" && a.slot === "design_qa_target";

describe("decide.py — design_qa_target signal class (Target visual-QA loop, #2739)", () => {
  test("fires on design_qa_target_due and invokes hydra-design-qa with apply:true + max_items:3", () => {
    const state = baseState({ signals: { design_qa_target_due: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, designQaTarget);
    assert.ok(a, "design_qa_target must dispatch on design_qa_target_due");
    assert.equal(a.skill, "hydra-design-qa");
    // The #1078 lesson: a dry-run-default skill dispatched headlessly without
    // apply:true is a silent no-op — the class would never file anything.
    assert.equal(
      (a.prompt_args ?? {}).apply,
      true,
      "headless dispatch must carry apply:true",
    );
    // The per-run finding cap is machine-enforceable at the dispatch seam.
    assert.equal(
      (a.prompt_args ?? {}).max_items,
      3,
      "dispatch must thread the ≤3-findings-per-run cap as max_items:3",
    );
  });

  test("OMITS the model param (judgment work inherits the parent, #1093)", () => {
    const state = baseState({ signals: { design_qa_target_due: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, designQaTarget);
    assert.ok(a, "design_qa_target must dispatch on design_qa_target_due");
    assert.equal(
      "model" in (a.prompt_args ?? {}),
      false,
      "judgment classes must not pin a model (the Haiku-premature-exit failure mode)",
    );
    assert.equal(a.model, undefined, "no top-level model key either");
  });

  test("does NOT fire without design_qa_target_due", () => {
    const plan = runDecide(baseState(), null);
    assert.equal(
      findAction(plan, designQaTarget),
      undefined,
      "design_qa_target must not dispatch when the due signal is absent",
    );
  });

  test("design_qa_target_saturated suppresses the dispatch even when due (checked FIRST)", () => {
    // A healthy UI with a full triage pile: even if the due signal is present,
    // a saturated design-QA board must suppress the pass before anything else —
    // exactly the cleanup_target / target_cleanup_board_saturated discipline.
    const state = baseState({
      signals: { design_qa_target_due: true, design_qa_target_saturated: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, designQaTarget),
      undefined,
      "a saturated design-QA board (>5 open items) must suppress the pass",
    );
  });

  test("healthy UI (not due, not saturated) files nothing", () => {
    // The saturation backstop pinned above plus this case together encode the
    // AC "healthy UI files nothing": with no due signal there is no dispatch.
    const plan = runDecide(baseState({ signals: {} }), null);
    assert.equal(
      findAction(plan, designQaTarget),
      undefined,
      "no design-QA dispatch when the board reports nothing to review",
    );
  });

  test("excluded under orch-only scope (target-scope by definition)", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { design_qa_target_due: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, designQaTarget),
      undefined,
      "orch-only scope must exclude design_qa_target (it reviews the Target UI)",
    );
  });

  test("allowed under target-only scope", () => {
    const state = baseState({
      scope: "target-only",
      signals: { design_qa_target_due: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, designQaTarget),
      "target-only must NOT exclude design_qa_target",
    );
  });

  test("suppressed when recently fired (within the 7d calendar cooldown)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { design_qa_target_due: true },
      // fired 2 days ago — inside the 7d window
      signal_last_fired: { design_qa_target: now - 2 * 24 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, designQaTarget),
      undefined,
      "2 days ago is inside the 7d design_qa_target cooldown",
    );
  });

  test("fires after the 7d calendar cooldown elapses", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { design_qa_target_due: true },
      // fired 8 days ago — past the 7d window
      signal_last_fired: { design_qa_target: now - 8 * 24 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, designQaTarget),
      "design_qa_target must fire once the 7d cooldown has elapsed",
    );
  });

  test("does not preempt a dev_target pipeline dispatch (spare-capacity contract)", () => {
    // Pipeline slots dispatch BEFORE the signal loop. Even with both the
    // target-work and design-QA-due signals present, the dev_target dispatch
    // must still appear; design_qa_target only rides alongside spare capacity.
    const state = baseState({
      signals: { target_work_available: true, design_qa_target_due: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      "dev_target pipeline dispatch must still fire when target work is available",
    );
  });
});
}

// ===========================================================================
// Merged from test/decide-retro-class.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Regression tests for `scripts/autopilot/decide.py` — the `retro_orch`
 * signal class (issue #920, parent epic #917).
 *
 * `retro_orch` is the daily per-run retrospective signal class. It dispatches
 * the `/hydra-retro` skill (#919) to turn the most-recent COMPLETED run into
 * conservative, recurrence-gated improvement proposals. It is modeled on the
 * calendar-driven, cooldown-gated `scout_orch` / `architecture_orch` classes:
 *
 *   - Fires on the precomputed `retro_run_available` signal (collect-state.sh
 *     emits it when a completed run exists to analyse). decide.py reads the
 *     signal verbatim and never recomputes run state.
 *   - 24h class cooldown (`SIGNAL_COOLDOWNS["retro_orch"]`) enforces the
 *     once-per-day cadence — the gating signal only asserts a run exists, so
 *     the cooldown is what stops a re-fire on every idle turn.
 *   - Spare-capacity / no-preemption: a signal class has no slot semantics and
 *     decide.py dispatches every pipeline slot BEFORE the signal loop, so a
 *     retro never preempts a dev/QA/research dispatch.
 *   - Orch-scope by definition: excluded under `target-only` runs via
 *     `SCOPE_TARGET_ONLY_EXCLUDE` (no `retro_target` mirror).
 *
 * We exercise decide.py through its `decide` CLI subcommand
 * (`python3 decide.py decide <state> <candidates> <events>`) so the tests
 * also pin the JSON wire contract the playbook prose consumes. Each test
 * writes the three input JSON files to a tempdir, runs the script, and
 * asserts on the parsed Plan.
 */








const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-retro-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

interface StateOverrides {
  scope?: string;
  burned_classes?: string[];
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
    burned_classes: o.burned_classes ?? [],
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

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
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

describe("decide.py — retro_orch signal class (issue #920)", () => {
  test("retro_orch fires on retro_run_available signal and invokes hydra-retro", () => {
    const state = baseState({ signals: { retro_run_available: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "retro_orch");
    assert.ok(a, "retro_orch must dispatch on retro_run_available");
    assert.equal(a.skill, "hydra-retro");
  });

  test("retro_orch dispatch carries no run_id (skill defaults to latest completed run)", () => {
    // The hydra-retro skill resolves the latest completed run itself when
    // invoked with no argument, so decide.py must NOT thread a run_id —
    // mirroring architecture_orch's argument-free dispatch and avoiding a
    // hard coupling to the run-id resolution path.
    const state = baseState({ signals: { retro_run_available: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "retro_orch");
    assert.ok(a, "retro_orch dispatch must be present");
    const args = a.prompt_args ?? {};
    assert.equal(args.run_id, undefined, "no run_id should be threaded through prompt_args");
    assert.equal(args.runId, undefined, "no runId should be threaded through prompt_args");
  });

  test("retro_orch dispatch stamps apply:true so a headless retro EMITS (issue #1078)", () => {
    // hydra-retro defaults to --audit/dry-run: an argument-free headless
    // dispatch persists the artifact but files ZERO issues and opens ZERO
    // PRs, making every scheduled retro_orch a silent no-op on GitHub. The
    // fix (option 2 of #1078) is decide.py-side: stamp `apply:true` so the
    // autopilot forwards `--apply` (the playbook maps `apply=true` →
    // `--apply`). This pins the emit-mode contract — without it the retro
    // signal class's entire purpose (≤2 issues + ≤1 gated PR/run) never fires.
    const state = baseState({ signals: { retro_run_available: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "retro_orch");
    assert.ok(a, "retro_orch dispatch must be present");
    const args = a.prompt_args ?? {};
    assert.equal(
      args.apply,
      true,
      "headless retro_orch must dispatch with apply:true (emit mode), not silent dry-run",
    );
  });

  test("retro_orch DOES NOT fire without retro_run_available signal", () => {
    const state = baseState(); // no signals
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "retro_orch"),
      undefined,
      "retro_orch must not dispatch when no completed run is available",
    );
  });

  test("retro_orch is excluded by target-only scope (orch-scope by definition)", () => {
    const state = baseState({
      scope: "target-only",
      signals: { retro_run_available: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "retro_orch"),
      undefined,
      "target-only scope must exclude retro_orch (INV-008)",
    );
  });

  test("retro_orch is allowed under orch-only scope", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { retro_run_available: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "retro_orch"),
      "orch-only must NOT exclude retro_orch",
    );
  });

  test("retro_orch suppressed when recently fired (within 24h cooldown)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { retro_run_available: true },
      // Fired 1h ago → inside the 24h cooldown.
      signal_last_fired: { retro_orch: now - 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "retro_orch"),
      undefined,
      "1h ago is inside the 24h retro_orch cooldown — the daily-cadence guard",
    );
  });

  test("retro_orch fires after 24h cooldown elapses, when the run is drillable", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      // Issue #3871 narrowed this class: an elapsed cooldown is necessary but
      // no longer sufficient — the SAME run's retro bundle must also carry
      // something to drill (`retro_run_drillable`). This case pins the
      // conjunction's positive arm.
      signals: { retro_run_available: true, retro_run_drillable: true },
      // 25h ago → past the 24h cooldown, and well inside the 7d weekly floor
      // so the correction-(b) override is NOT what makes this fire.
      signal_last_fired: { retro_orch: now - 25 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "retro_orch"),
      "retro_orch must fire once the 24h cooldown has elapsed and the run is drillable",
    );
  });

  test("retro_orch does NOT fire on an elapsed cooldown when the run is not drillable", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      // The negative arm of the same conjunction (issue #3871): a completed
      // run whose bundle carries no flagged dispatch / reflection / stuck
      // signal / recommendation is not worth a ~115k-token /hydra-retro
      // dispatch, even though its cooldown has elapsed.
      signals: { retro_run_available: true },
      // 25h ago: past the 24h cooldown but far inside the 7d weekly-override
      // floor, so correction (b) cannot mask the drillability gate here.
      signal_last_fired: { retro_orch: now - 25 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "retro_orch"),
      undefined,
      "an elapsed cooldown alone no longer dispatches retro_orch — the run must also be drillable",
    );
  });

  test("the drillable conjunction dispatches via the DAILY reason, not the weekly override (#4342)", () => {
    // Pin WHICH branch dispatches. The daily path and the weekly full-retro
    // override emit the same skill with the same prompt_args; the reason
    // string is the only observable that distinguishes them. #4342's defect
    // was wiring-level, not decide.py-level: retro_run_drillable was emitted
    // by collect-state.sh but never promoted into state.signals (no Signal
    // wiring row), so _signal_present read it as absent == false and the
    // daily branch below was structurally unreachable — only the weekly
    // override ever fired. If this assertion regresses to the override
    // reason, the promotion hop has gone dark again.
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { retro_run_available: true, retro_run_drillable: true },
      // 25h ago → past the 24h cooldown, far inside the 7d weekly floor, so
      // the override is NOT eligible and cannot mask a dead daily branch.
      signal_last_fired: { retro_orch: now - 25 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "retro_orch");
    assert.ok(a, "retro_orch dispatch must be present");
    assert.equal(
      a.reason,
      "completed run available and drillable — daily retrospective",
      "the drillable conjunction must dispatch via the DAILY branch — the weekly-override reason here means retro_run_drillable was read as absent/false (#4342)",
    );
  });

  test("retro_orch does not preempt a pipeline dispatch (reap/dispatch ordering)", () => {
    // Spare-capacity contract: pipeline slots dispatch BEFORE the signal
    // loop, so when both an orch dev candidate and a retro are eligible the
    // dev_orch dispatch still appears. retro_orch is the lowest-priority
    // signal class and rides alongside — it never displaces pipeline work.
    const state = baseState({
      signals: { orch_work_available: true, retro_run_available: true },
    });
    const plan = runDecide(state, null);
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    const retro = findAction(plan, (a) => a.type === "dispatch" && a.slot === "retro_orch");
    assert.ok(dev, "dev_orch pipeline dispatch must still fire when work is available");
    assert.ok(retro, "retro_orch may also fire — spare capacity, not a preemption");
    const types = (plan.actions ?? []).map((a: any) => a.slot);
    assert.ok(
      types.indexOf("dev_orch") < types.indexOf("retro_orch"),
      "pipeline dispatch must be ordered before the signal-class dispatch",
    );
  });

  test("retro_orch in burned_classes is NOT re-dispatched (mirrors #432)", () => {
    const state = baseState({
      burned_classes: ["retro_orch"],
      signals: { retro_run_available: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "retro_orch"),
      undefined,
      "burned signal class retro_orch must not be re-dispatched",
    );
  });
});
}

// ===========================================================================
// Merged from test/decide-skill-prune-class.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Regression tests for `scripts/autopilot/decide.py` — the `skill_prune` signal
 * class (issue #2949, epic #2944: the skill-quality overhaul).
 *
 * `skill_prune` dispatches the headless `/hydra-skill-prune` skill — the
 * eval-gated PROMPT counterpart to cleanup_orch's mechanical dead-CODE sweep. It
 * prunes the Orchestrator's playbook-generated skills ONE per run along the
 * Pocock pruning taxonomy (duplication / sediment / no-op), validates candidates
 * with the promptfoo eval (golden-task contract-token parity), and opens at most
 * one T1/T2 PR editing only that playbook (plus its regenerated skill + its
 * shrink-only-tightened baseline entry); a failing eval downgrades to a
 * needs-triage candidate-list issue instead.
 *
 * The class marries two established disciplines:
 *
 *   - cleanup_orch's spare-capacity backfill: keyed off the same
 *     `orch_backfill_idle` signal, with `skill_prune_board_saturated` as the
 *     anti-flood cap checked FIRST. Like cleanup_orch it rides the idle signal
 *     but rate-limits on its OWN cooldown, NOT the one-per-turn stagger — so it
 *     is deliberately NOT in BACKFILL_SIGNAL_CLASSES.
 *   - scout_orch's CALENDAR cadence: the 7d class cooldown
 *     (`SIGNAL_COOLDOWNS["skill_prune"]`), seeded in bootstrap.sh so it survives
 *     the pace-gate relaunch (#2575) — the accretion worth pruning takes a week
 *     to accumulate.
 *
 * The dispatch carries `apply: true` (the #1078 lesson: a dry-run-default skill
 * dispatched headlessly without it is a silent no-op) and OMITS the model param
 * (judgment work inherits the parent, #1093).
 *
 * Orch-scope by definition (it prunes the Orchestrator's own skills): allowed
 * under `orch-only`, excluded under `target-only` — mirroring scout_orch /
 * architecture_orch / cleanup_orch.
 *
 * Exercised through the `decide` CLI subcommand, pinning the JSON wire contract
 * (same harness as test/decide-design-qa-target-class.test.mts).
 */








const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-skill-prune-test-"));
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

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
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

const skillPrune = (a: any) =>
  a.type === "dispatch" && a.slot === "skill_prune";

describe("decide.py — skill_prune signal class (eval-gated skill pruner, #2949)", () => {
  test("fires on orch_backfill_idle and invokes hydra-skill-prune with apply:true", () => {
    const state = baseState({ signals: { orch_backfill_idle: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, skillPrune);
    assert.ok(a, "skill_prune must dispatch on orch_backfill_idle");
    assert.equal(a.skill, "hydra-skill-prune");
    // The #1078 lesson: a dry-run-default skill dispatched headlessly without
    // apply:true is a silent no-op — the class would never open a PR or file.
    assert.equal(
      (a.prompt_args ?? {}).apply,
      true,
      "headless dispatch must carry apply:true",
    );
  });

  test("OMITS the model param (judgment work inherits the parent, #1093)", () => {
    const state = baseState({ signals: { orch_backfill_idle: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, skillPrune);
    assert.ok(a, "skill_prune must dispatch on orch_backfill_idle");
    assert.equal(
      "model" in (a.prompt_args ?? {}),
      false,
      "judgment classes must not pin a model (the Haiku-premature-exit failure mode)",
    );
    assert.equal(a.model, undefined, "no top-level model key either");
  });

  test("does NOT fire without orch_backfill_idle", () => {
    const plan = runDecide(baseState(), null);
    assert.equal(
      findAction(plan, skillPrune),
      undefined,
      "skill_prune must not dispatch when the idle signal is absent",
    );
  });

  test("skill_prune_board_saturated suppresses the dispatch even when idle (checked FIRST)", () => {
    // A board already holding enough open skill-prune proposal work: even with
    // the idle signal present, saturation must suppress the pass before anything
    // else — exactly the cleanup_orch / cleanup_board_saturated discipline.
    const state = baseState({
      signals: { orch_backfill_idle: true, skill_prune_board_saturated: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, skillPrune),
      undefined,
      "a saturated skill-prune board must suppress the pass",
    );
  });

  test("healthy board (not idle, not saturated) files nothing", () => {
    const plan = runDecide(baseState({ signals: {} }), null);
    assert.equal(
      findAction(plan, skillPrune),
      undefined,
      "no skill-prune dispatch when the board reports nothing to backfill",
    );
  });

  test("excluded under target-only scope (orch-scope by definition)", () => {
    const state = baseState({
      scope: "target-only",
      signals: { orch_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, skillPrune),
      undefined,
      "target-only scope must exclude skill_prune (it prunes the Orchestrator's own skills)",
    );
  });

  test("allowed under orch-only scope", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { orch_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, skillPrune),
      "orch-only must NOT exclude skill_prune",
    );
  });

  test("suppressed when recently fired (within the 7d calendar cooldown)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { orch_backfill_idle: true },
      // fired 2 days ago — inside the 7d window
      signal_last_fired: { skill_prune: now - 2 * 24 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, skillPrune),
      undefined,
      "2 days ago is inside the 7d skill_prune cooldown",
    );
  });

  test("fires after the 7d calendar cooldown elapses", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { orch_backfill_idle: true },
      // fired 8 days ago — past the 7d window
      signal_last_fired: { skill_prune: now - 8 * 24 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, skillPrune),
      "skill_prune must fire once the 7d cooldown has elapsed",
    );
  });

  test("does not preempt a dev_orch pipeline dispatch (spare-capacity contract)", () => {
    // Pipeline slots dispatch BEFORE the signal loop. Even with both the
    // orch-work and idle signals present, the dev_orch dispatch must still
    // appear; skill_prune only rides alongside spare capacity.
    const state = baseState({
      signals: { orch_work_available: true, orch_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch"),
      "dev_orch pipeline dispatch must still fire when orch work is available",
    );
  });
});
}

// ===========================================================================
// Merged from test/decide-tickets-class.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Regression tests for `scripts/autopilot/decide.py` — the `tickets_orch` signal
 * class (issue #3423, epic #3419, ADR-0030 Decision 2 + Decision 5: one
 * autonomous Pocock skill lineage; the delta/contract slice wires the selector).
 *
 * `tickets_orch` is the tickets-STAGE producer: it turns a resolved plan/finding
 * into one parent epic + N tracer-bullet child issues by dispatching the vendored
 * upstream `to-tickets` skill + the thin Hydra AFK overlay (Option C compose,
 * alpha #3420). `hydra-prd` is demoted to the called PrdInput→issue renderer
 * library invoked BY that overlay — it is no longer a standalone dispatch
 * identity and has no class row.
 *
 * Structural sibling: `wayfinder_orch` (the plan-stage producer, also a signal
 * class, also 1h) — NOT a pipeline slot. It reads a precomputed board signal
 * (`tickets_available`) verbatim (the signal-seam discipline: no gh/curl/GraphQL
 * inside decide.py — collect-state.sh owns the enumeration and emits the signal;
 * that emission is a follow-on, out of this slice's Files-in-scope). The 1h class
 * cooldown (`SIGNAL_COOLDOWNS["tickets_orch"]`) is the back-stop; board state is
 * the primary suppressor.
 *
 * The dispatch OMITS the model param (producer/judgment work inherits the parent,
 * #1093). Orch-scope by definition (ADR-0030 charted the orchestrator taxonomy
 * only): allowed under `orch-only`, excluded under `target-only` — mirroring
 * wayfinder_orch / scout_orch / architecture_orch / cleanup_orch / skill_prune.
 *
 * Exercised through the `decide` CLI subcommand, pinning the JSON wire contract
 * (same harness as test/decide-skill-prune-class.test.mts).
 */








const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-tickets-test-"));
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

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
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

const ticketsDispatch = (a: any) =>
  a.type === "dispatch" && a.slot === "tickets_orch";

describe("decide.py — tickets_orch signal class (ADR-0030 delta, #3423)", () => {
  test("fires on tickets_available and invokes the composed hydra-tickets skill", () => {
    const state = baseState({ signals: { tickets_available: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, ticketsDispatch);
    assert.ok(a, "tickets_orch must dispatch on tickets_available");
    assert.equal(
      a.skill,
      "hydra-tickets",
      "the tickets stage dispatches the COMPOSED hydra-tickets skill (vendored to-tickets base + Hydra AFK overlay), never the bare upstream skill (which carries disable-model-invocation and would hard-error) and never hydra-prd",
    );
  });

  test("OMITS the model param (producer work inherits the parent, #1093)", () => {
    const state = baseState({ signals: { tickets_available: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, ticketsDispatch);
    assert.ok(a, "tickets_orch must dispatch on tickets_available");
    assert.equal(
      "model" in (a.prompt_args ?? {}),
      false,
      "producer classes must not pin a model",
    );
    assert.equal(a.model, undefined, "no top-level model key either");
  });

  test("does NOT fire without the tickets_available signal", () => {
    const plan = runDecide(baseState(), null);
    assert.equal(
      findAction(plan, ticketsDispatch),
      undefined,
      "tickets_orch must not dispatch when no resolved plan awaits ticketing",
    );
  });

  test("healthy board (no ticketing work) files nothing", () => {
    const plan = runDecide(baseState({ signals: {} }), null);
    assert.equal(
      findAction(plan, ticketsDispatch),
      undefined,
      "no tickets dispatch when the board reports nothing to ticket",
    );
  });

  test("excluded under target-only scope (orch-scope by definition)", () => {
    const state = baseState({
      scope: "target-only",
      signals: { tickets_available: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, ticketsDispatch),
      undefined,
      "target-only scope must exclude tickets_orch (ADR-0030 charted orch taxonomy only)",
    );
  });

  test("allowed under orch-only scope", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { tickets_available: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, ticketsDispatch),
      "orch-only must NOT exclude tickets_orch",
    );
  });

  test("suppressed when recently fired (within the 1h cooldown)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { tickets_available: true },
      // fired 10 minutes ago — inside the 1h window
      signal_last_fired: { tickets_orch: now - 10 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, ticketsDispatch),
      undefined,
      "10 minutes ago is inside the 1h tickets_orch cooldown",
    );
  });

  test("fires after the 1h cooldown elapses", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { tickets_available: true },
      // fired 2h ago — past the 1h window
      signal_last_fired: { tickets_orch: now - 2 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, ticketsDispatch),
      "tickets_orch must fire once the 1h cooldown has elapsed",
    );
  });

  test("does not preempt a dev_orch pipeline dispatch (signal classes run after slots)", () => {
    // Pipeline slots dispatch BEFORE the signal loop. Even with both the
    // orch-work and ticketing signals present, the dev_orch dispatch must still
    // appear; tickets_orch is a producer that rides alongside spare capacity.
    const state = baseState({
      signals: { orch_work_available: true, tickets_available: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch"),
      "dev_orch pipeline dispatch must still fire when orch work is available",
    );
  });

  // ---------------------------------------------------------------------------
  // #4014 — the resolved-ref seam. collect-state.sh emits BOTH tickets_available
  // AND a companion tickets_orch_pending_spec=issue-N (the oldest unassigned
  // needs-tickets spec). decide.py threads that verbatim string into the
  // dispatch prompt_args.spec_issue so hydra-tickets decomposes exactly that
  // spec — the same pre-resolution pattern as wayfinder_orch_frontier. These
  // tests pin the consumer side; the producer (collect-state.sh) is pinned in
  // test/autopilot-scripts.test.mts.
  // ---------------------------------------------------------------------------

  test("threads tickets_orch_pending_spec into prompt_args.spec_issue (#4014)", () => {
    const state = baseState({
      signals: {
        tickets_available: true,
        tickets_orch_pending_spec: "issue-1234",
      },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, ticketsDispatch);
    assert.ok(a, "tickets_orch must dispatch on tickets_available");
    assert.equal(
      a.prompt_args?.spec_issue,
      "issue-1234",
      "the resolved spec ref must be threaded verbatim into prompt_args.spec_issue so hydra-tickets decomposes exactly that spec",
    );
  });

  test("omits spec_issue when no companion ref is present (#4014 fail-open)", () => {
    // tickets_available=true but tickets_orch_pending_spec absent — decide.py
    // must not invent a ref; hydra-tickets dispatches with no target and relies
    // on its own board read (fail-open, never fabricate issue-N).
    const state = baseState({ signals: { tickets_available: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, ticketsDispatch);
    assert.ok(a, "tickets_orch must still dispatch on tickets_available alone");
    assert.equal(
      a.prompt_args?.spec_issue,
      undefined,
      "no spec_issue must be threaded when collect-state.sh emitted no companion ref",
    );
  });

  test("ignores a companion ref when tickets_available is false (#4014 gating)", () => {
    // The boolean is the gate; a stale/echoed pending_spec string alone must
    // NOT wake tickets_orch. Pins that the two signals are decoupled: the ref
    // is advisory context, the boolean is authoritative.
    const state = baseState({
      signals: {
        tickets_available: false,
        tickets_orch_pending_spec: "issue-1234",
      },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, ticketsDispatch),
      undefined,
      "tickets_orch must not fire on a companion ref without the tickets_available gate",
    );
  });
});
}

// ===========================================================================
// Merged from test/decide-target-board-dispatch.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Regression tests for `scripts/autopilot/decide.py` — the GitHub-board Target
 * dispatch branch (issue #3435, spec #3432, ADR-0031).
 *
 * ADR-0031 migrates Target task tracking from Redis to GitHub Issues on the
 * Target repo. `collect-state.sh` now reads the scope=target board-state
 * (`GET /api/autopilot/board-state?scope=target`, issue #3434) and emits
 * `target_ready_for_agent` / `target_needs_qa` / `target_needs_triage` /
 * `target_needs_research` counts. The autopilot maps those to board signals
 * which decide.py's Target branch dispatches from — the orch-style Target
 * decision:
 *
 *   - `target_board_work_available` (ready-for-agent present) → `dev_target`
 *   - `target_board_research_due`   (board empty)             → `research_target`
 *   - `needs_qa_target`             (needs-qa present)        → `qa_target`
 *   - `needs_triage_target`         (needs-triage present)    → `sweep_target`
 *
 * The `needs_triage_target` → `sweep_target` row is issue #3709: the selector
 * had shipped since inception but `collect-state.sh` never emitted the
 * `target_needs_triage` count behind it, so the signal had zero producers and
 * the arm was permanently dead (same defect class as #959's `orch_idle`). It
 * is the exact Target mirror of `needs_triage_orch` → `sweep_orch`, and like
 * that sibling it carries NO saturation cap — `sweep_target` drains the very
 * lane it is gated on, so a cap would guarantee the lane never drains; the
 * 900s class cooldown is the backstop.
 *
 * BLOCKED EXCLUSION: the board's `ready_for_agent` count is already
 * open-blocker-excluded via the inherited #3059 strict blocked-by/depends-on
 * filter (the scope=target board-state reuses `deriveBoardState` unchanged), so
 * a dependency-blocked Target issue never sets `target_board_work_available` —
 * the exclusion is enforced upstream at the board read, not re-derived here.
 *
 * EXPAND PHASE (ADR-0030): the legacy Redis signals (`target_work_available`,
 * `target_research_due`) still fire in parallel — nothing Redis-side is
 * removed. (The candidate-feed `research_recommended` forced-research path was
 * retired in #3832 — `/api/anchor/candidates` is gone — so it is no longer a
 * parallel trigger.) These tests pin that the new GitHub-board signals ALSO
 * drive the Target branch.
 *
 * Exercised through the `decide` CLI subcommand, pinning the JSON wire
 * contract (same harness as test/decide-cleanup-target-class.test.mts).
 */








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
 * A candidate feed that explicitly does NOT recommend research. Post-#3832 the
 * candidate feed no longer drives the research_target selector at all (the
 * `/api/anchor/candidates` forced-research branch was retired), so this payload
 * cannot confound the board-signal assertions via research_target; it is
 * retained only as a realistic non-null feed for the dev_target steer path
 * (which still reads `research_recommended` to decide the anchor hint).
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
const sweepTarget = (a: any) => a.type === "dispatch" && a.slot === "sweep_target";

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

  test("needs_qa_target (board target_needs_qa>0) → qa_target dispatches hydra-target-qa scope=target", () => {
    const state = baseState({ signals: { needs_qa_target: true } });
    const plan = runDecide(state, feedNoResearch);
    const a = findAction(plan, qaTarget);
    assert.ok(a, "qa_target must dispatch when the target GH board has needs-qa work");
    // Flipped for #4576 (INV-1/INV-8): the dispatch skill is the purpose-built
    // hydra-target-qa, never hydra-qa — the installed hydra-qa has no
    // target-scope path (nothing reads prompt_args.scope), so a literal
    // hydra-qa dispatch reviewed an orchestrator PR or no-op'd.
    assert.equal(a.skill, "hydra-target-qa");
    assert.equal((a.prompt_args ?? {}).scope, "target");
    // INV-4/INV-5: absent pre-resolution signal → NO pr_ref key (never "" or
    // null) and the dispatch still fires — hydra-target-qa's own step 1
    // resolves the PR when pr_ref is absent.
    assert.equal(
      "pr_ref" in (a.prompt_args ?? {}),
      false,
      "pr_ref must be absent when target_needs_qa_pr_ref is not served",
    );
  });

  test("target_needs_qa_pr_ref (non-empty) → qa_target threads prompt_args.pr_ref verbatim", () => {
    const url = "https://github.com/gaberoo322/hydra-betting/pull/67";
    const state = baseState({
      signals: { needs_qa_target: true, target_needs_qa_pr_ref: url },
    });
    const plan = runDecide(state, feedNoResearch);
    const a = findAction(plan, qaTarget);
    assert.ok(a, "qa_target must still dispatch when the PR pre-resolution is served");
    assert.equal(a.skill, "hydra-target-qa");
    assert.equal((a.prompt_args ?? {}).pr_ref, url, "pr_ref must carry the html_url verbatim");
    // INV-4's lookup order: an event value is PREFERRED over state.signals —
    // the same seam as _triage_item_set / _qa_orch_needs_qa_numbers.
    const plan2 = runDecide(
      baseState({ signals: { needs_qa_target: true, target_needs_qa_pr_ref: url } }),
      feedNoResearch,
      [{ type: "signal", name: "target_needs_qa_pr_ref", value: "https://github.com/example/t/pull/9" }],
    );
    const a2 = findAction(plan2, qaTarget);
    assert.ok(a2);
    assert.equal(
      (a2.prompt_args ?? {}).pr_ref,
      "https://github.com/example/t/pull/9",
      "the event value must win over the state.signals value",
    );
  });

  test("target_needs_qa_pr_ref (EMPTY string) → no pr_ref key, dispatch still fires (fail open)", () => {
    const state = baseState({
      signals: { needs_qa_target: true, target_needs_qa_pr_ref: "" },
    });
    const plan = runDecide(state, feedNoResearch);
    const a = findAction(plan, qaTarget);
    assert.ok(
      a,
      "an empty pre-resolution must never suppress qa_target (INV-5 — hydra-target-qa self-resolves)",
    );
    assert.equal(a.skill, "hydra-target-qa");
    assert.equal(
      "pr_ref" in (a.prompt_args ?? {}),
      false,
      "an empty signal must yield NO pr_ref key — never pr_ref:\"\" or null",
    );
  });

  test("classes.json qa_target.skill matches the dispatched skill (single binding source)", () => {
    const parsed = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts", "autopilot", "classes.json"), "utf-8"),
    ) as { classes?: Array<{ name?: string; skill?: string }> };
    const row = (parsed.classes ?? []).find((r) => r.name === "qa_target");
    assert.ok(row, "classes.json must carry a qa_target row");
    const state = baseState({ signals: { needs_qa_target: true } });
    const a = findAction(runDecide(state, feedNoResearch), qaTarget);
    assert.ok(a);
    // INV-2: the selector literal and the taxonomy row are the SAME binding —
    // they drifted once (#4576's finding) because nothing asserted parity.
    assert.equal(a.skill, row.skill);
  });

  test("needs_triage_target (board target_needs_triage>0) → sweep_target dispatches hydra-target-sweep", () => {
    const state = baseState({ signals: { needs_triage_target: true } });
    const plan = runDecide(state, feedNoResearch);
    const a = findAction(plan, sweepTarget);
    assert.ok(
      a,
      "issue #3709: sweep_target must dispatch when the target GH board has needs-triage work",
    );
    assert.equal(a.skill, "hydra-target-sweep");
    assert.equal(a.reason, "target board hygiene due");
  });

  test("no needs_triage_target signal → sweep_target idles", () => {
    const state = baseState({ signals: {} });
    const plan = runDecide(state, feedNoResearch);
    assert.equal(
      findAction(plan, sweepTarget),
      undefined,
      "a Target board with zero needs-triage items must not dispatch sweep_target",
    );
  });

  test("sweep_target fires even when the Target board is otherwise busy (no saturation cap)", () => {
    // sweep_target DRAINS the lane it is gated on, so — unlike the producer
    // classes that carry a *_board_saturated cap — a full board is exactly
    // when it must run. Its sibling sweep_orch has run capless since inception.
    const state = baseState({
      signals: {
        needs_triage_target: true,
        target_board_work_available: true,
        needs_qa_target: true,
      },
    });
    const plan = runDecide(state, feedNoResearch);
    assert.ok(
      findAction(plan, sweepTarget),
      "a saturated triage lane must not suppress its own drainer",
    );
  });

  test("sweep_target excluded under orch-only scope", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { needs_triage_target: true },
    });
    const plan = runDecide(state, feedNoResearch);
    assert.equal(
      findAction(plan, sweepTarget),
      undefined,
      "orch-only scope must exclude the Target sweep class",
    );
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
}

// ===========================================================================
// decide.py ↔ playbook Signal-wiring drift guard (issue #4342), widened into
// the three-leg signal-parity check (issue #4519) — NOT a per-class dispatch
// case; a cross-cutting wiring assertion over the same subjects this file
// charters (decide.py's signal classes). Lives here per the file-header rule
// (no new file — test/test-file-sprawl-guard.test.mts), which is also
// #4519 design-concept INV-1: the parity legs REPLACE the #4342 block in this
// file (test/decide-signal-classes.test.mts), so a red verdict reddens the
// REQUIRED `test` job (INV-2) — never an advisory workflow.
// ===========================================================================
{
/**
 * The #4342 defect class: a signal can exist at BOTH ends of the
 * collect-state.sh → decide.py seam and still be structurally dead, because
 * the middle hop is a TABLE. `collect-state.sh` emitted `retro_run_drillable`
 * and decide.py read it (`_signal_present(state, events,
 * "retro_run_drillable")`), but the "Signal wiring (state.signals)" table in
 * docs/operator-playbooks/hydra-autopilot.md — the table the autopilot
 * session derives its per-turn signal-promotion script from — had no row for
 * it, so `state.signals.retro_run_drillable` never existed, `_signal_present`
 * read absent as falsy, and the #3871 daily drillable branch was unreachable
 * (only the 7d weekly override ever fired). Per-class tests cannot catch
 * this: they hand decide.py fixture states that already contain the keys.
 *
 * #4519 widens the one-leg #4342 guard (read→row, `_signal_present` only)
 * into the full parity contract over the same three artifacts, consuming the
 * pure module scripts/ci/signal-parity-check.ts:
 *
 *   L1 read→row   every decide.py read (SEVEN shapes, not just
 *                 `_signal_present`) has a table row or a PRODUCERLESS
 *                 exemption — #4342's class, complete.
 *   L2 row→emit   every row's column-1 producer is emitted by
 *                 collect-state.sh / target-wip.py or rides the board-state
 *                 JSON line (NON_KV_PRODUCERS).
 *   L3 row→read   every promoted state.signals key is read by decide.py or
 *                 is observability-only by design.
 *
 * Exemptions are name→rationale Maps in the module, honesty-tested in BOTH
 * directions below (INV-6): an exempted entry that gains a row / a reader /
 * a producer fails this suite naming the entry to delete.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");
const PLAYBOOK = join(REPO_ROOT, "docs", "operator-playbooks", "hydra-autopilot.md");
const COLLECT_STATE = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const TARGET_WIP = join(REPO_ROOT, "scripts", "autopilot", "target-wip.py");

describe("decide.py ↔ playbook Signal-wiring drift guard (#4342; #4519 parity)", () => {
  const decideSrc = readFileSync(DECIDE, "utf-8");
  const playbookSrc = readFileSync(PLAYBOOK, "utf-8");
  const collectStateSrc = readFileSync(COLLECT_STATE, "utf-8");
  const targetWipSrc = readFileSync(TARGET_WIP, "utf-8");

  const reads = extractDecideReads(decideSrc);
  const emitted = extractEmittedSignals(collectStateSrc, targetWipSrc);
  const { rows, error: rowsError } = extractWiringRows(playbookSrc);
  const tableKeys = new Set<string>();
  const rowProducers = new Set<string>();
  for (const row of rows) {
    if (row.key) tableKeys.add(row.key);
    if (row.producer) rowProducers.add(row.producer);
  }

  test("the Signal wiring section heading is still present (INV-9 — a rename fails loud)", () => {
    assert.ok(!rowsError, rowsError ?? "extractWiringRows reported no error but one was expected check");
    assert.ok(rows.length > 0, "the Signal wiring table parsed to zero rows — the extractor has rotted");
  });

  test("L1 rot guard — the read extractor still finds a substantial, shape-pinned set (#4519 INV-4)", () => {
    // A regex that silently matches nothing would turn the parity check into
    // a vacuous pass. Floor the extraction and pin ONE member per read shape
    // so parser rot fails loud, not green:
    //   _signal_present            → orch_board_signals_degraded (the `events or []` arg shape)
    //   (state.get("signals") or {}).get → orch_realm_weekly_share, scout_alert_eligible_count
    //   signals/_tk_signals.get    → orch_dev_ready_anchor_design_concept_status
    //   _orch_anchor_signal        → orch_pending_grill_anchor
    //   _triage_item_set           → orch_needs_triage_items
    //   ESCALATION_SATURATION_SIGNAL value → cleanup_board_saturated
    //   _pr_gate_numbers           → orch_prs_dirty (#4240; not in the artifact's
    //                                 enumeration — found by the exhaustive sweep)
    assert.ok(
      reads.length >= 35,
      `read extractor found only ${reads.length} distinct reads — a regex has likely rotted against decide.py's call shapes`,
    );
    for (const must of [
      "orch_board_signals_degraded",
      "orch_realm_weekly_share",
      "scout_alert_eligible_count",
      "orch_dev_ready_anchor_design_concept_status",
      "orch_pending_grill_anchor",
      "orch_needs_triage_items",
      "cleanup_board_saturated",
      "orch_prs_dirty",
      "retro_run_drillable",
    ]) {
      assert.ok(
        reads.includes(must),
        `read extractor must find the ${must} read — without it the parity check says nothing about it`,
      );
    }
  });

  test("L1 read→row — every decide.py signal read has a Signal wiring row (or an explicit exemption) (#4342)", () => {
    const missing = reads.filter((l) => !tableKeys.has(l) && !PRODUCERLESS_SIGNALS.has(l));
    assert.deepEqual(
      missing,
      [],
      [
        "decide.py reads these signals but the playbook's Signal wiring table never promotes them — collect-state can emit them all day and state.signals will stay without them (#4342's defect class).",
        "Fix: add a row to the `## Signal wiring (state.signals)` table in docs/operator-playbooks/hydra-autopilot.md for each, or — if the signal has no collect-state producer — add it to PRODUCERLESS_SIGNALS in scripts/ci/signal-parity-check.ts with a rationale.",
      ].join(" "),
    );
  });

  test("L2 rot guard — the emit extractor still finds a substantial, pinned emission set (#4519 INV-5)", () => {
    // Floor + pinned members across every literal emission shape: shell
    // echo -n (failed_services), python f-string prefix (health,
    // orch_glm_red_forward_fix), mid-fstring (capacity_floor_met), ANSI-C
    // $'…' fallback (target_ready_for_agent), bare f-string print arg
    // (target_wip_saturated), plain echo (retro_run_drillable,
    // design_qa_target_due). The artifact's "≥80" was a per-shape SUM
    // (~55 shell + ~35 python + ~6 mid) — the distinct union over
    // collect-state.sh + target-wip.py measures 77, so the floor sits at 75
    // with the measurement recorded here, NOT lowered past reality.
    assert.ok(
      emitted.length >= 75,
      `emit extractor found only ${emitted.length} distinct names — a shape has likely rotted against collect-state.sh's emission forms`,
    );
    for (const must of [
      "health",
      "failed_services",
      "target_ready_for_agent",
      "target_wip_saturated",
      "orch_glm_red_forward_fix",
      "capacity_floor_met",
      "retro_run_drillable",
      "design_qa_target_due",
    ]) {
      assert.ok(
        emitted.includes(must),
        `emit extractor must find the ${must} emission — without it L2 says nothing about it`,
      );
    }
  });

  test("a trailing `#` comment does not leak a quoted literal into the emitted set (#4519 PR #4522 QA Reviewer B finding 1)", () => {
    // The comment skip used to be `rawLine.trimStart().startsWith("#")` — a
    // whole-line-only check — while the scan-gate and literal scan ran over
    // the RAW line, comment tail included. A trailing comment quoting a
    // `"name=value"` shape (e.g. explaining what NOT to emit) therefore
    // false-positived into `emitted`. Real echo/printf lines around it must
    // still be picked up.
    const src = [
      'echo -n "real_signal="',
      'echo -n "1"',
      'foo=1  # don\'t print duplicate "test_signal=1" entries',
    ].join("\n");
    const names = extractEmittedSignals(src);
    assert.ok(names.includes("real_signal"), "a genuine emission on its own line must still be found");
    assert.ok(
      !names.includes("test_signal"),
      "a quoted literal inside a trailing comment must not be extracted as an emitted signal",
    );
  });

  test("an escaped quote inside a $'...' ANSI-C literal does not desync the trailing-comment scan (#4519 PR #4522 QA Reviewer B re-review, T3 round 2)", () => {
    // stripTrailingComment's inAnsiC branch used to treat ANY `'` as the
    // literal's terminator, with no backslash-escape awareness. A `\'`
    // inside a `$'...'` literal is bash's escaped-quote form — it does NOT
    // close the literal — so the old scan flipped inAnsiC off early, fell
    // back to top-level scanning mid-literal, and then misread a later
    // quote in the REAL trailing comment as new quoting, so the comment was
    // never actually stripped and a quoted literal inside it leaked into
    // `emitted`. Both reproduction inputs from the QA finding must resolve
    // cleanly: the genuine ANSI-C emission must survive, and nothing from
    // the trailing comment must leak.
    const src = [
      `x=$'a\\'b' # plain comment "leak=1"`,
      `echo $'name=1\\'x' # don't emit "phantom=1" here`,
    ].join("\n");
    const names = extractEmittedSignals(src);
    assert.ok(names.includes("name"), "the genuine ANSI-C emission before the escaped quote must still be found");
    assert.ok(!names.includes("leak"), "a quoted literal inside the trailing comment must not leak past an escaped quote");
    assert.ok(!names.includes("phantom"), "a quoted literal inside the trailing comment must not leak past an escaped quote");
  });

  test("an escaped double-quote inside a plain \"...\" literal does not desync the trailing-comment scan (#4519 PR #4522 QA re-review round 4, Reviewer A finding)", () => {
    // Round 2 only hardened the ANSI-C ($'...') branch. `target-wip.py` is
    // Python source, where plain `"..."` literals DO support backslash-
    // escaped quotes (`\"`), so the same desync survived in the inDouble
    // branch: an escaped `\"` flipped inDouble off early, the real closing
    // `"` misread as a fresh opener, and the real trailing `#` landed
    // "inside" that bogus reopened quote — stripTrailingComment returned the
    // line unmodified and the quoted literal in the comment leaked out.
    const src = 'echo "foo=\\"bar" # comment "leak=1"';
    const names = extractEmittedSignals(src);
    assert.ok(!names.includes("leak"), "a quoted literal inside the trailing comment must not leak past an escaped double-quote");
  });

  test("an escaped single-quote (apostrophe) inside a comment does not desync the trailing-comment scan (#4519 PR #4522 QA re-review round 4, Reviewer B finding)", () => {
    // Same defect class in the inSingle branch, reproduced without any
    // literal at all: a bare apostrophe in ordinary comment prose (e.g. the
    // contraction "don't", common in this codebase's own comments) opens
    // inSingle with no closing `'` before EOL, so the real trailing `#`
    // comment is never reached and a quoted literal after it leaks into the
    // emitted set. Reviewer B's fuzz found ~15% of random inputs leaked this
    // way before the fix.
    const names = extractEmittedSignals(`echo x=1 don't care # "leak=1"`);
    assert.ok(!names.includes("leak"), "an apostrophe in comment prose must not desync the trailing-comment scan");
  });

  test("bash's `'\\''`-embedded-apostrophe idiom does not desync the trailing-comment scan (#4519 PR #4522 QA re-review round 5, Reviewer B Standards finding)", () => {
    // Rounds 2-4 only made the ALREADY-in-a-quote-state backslash escapes
    // aware; the standard bash idiom for embedding a literal apostrophe
    // (`echo 'it'\''s a test'`) places its backslash BETWEEN two quoted
    // spans, at TOP LEVEL — with no top-level escape case, that `\` was
    // inert, so the very next `'` opened a phantom empty `''` pair (instead
    // of the real `'s a test'` string), desyncing the rest of the scan and
    // letting the real trailing `#` comment's quoted literal leak through.
    const names = extractEmittedSignals(`echo 'it'\\''s a test' # don't leak "leak_signal=1"`);
    assert.ok(
      !names.includes("leak_signal"),
      "the bash apostrophe-embedding idiom must not desync the trailing-comment scan",
    );
  });

  test("two unrelated prose apostrophes do not mis-pair and swallow a real trailing comment (#4519 PR #4522 QA re-review round 5, Reviewer B Spec finding)", () => {
    // The round-4 `hasUnescapedClose` lookahead accepted ANY later same-kind
    // quote character as a valid closing partner, not just a genuine one —
    // so two unrelated contractions in ordinary comment prose (`don't` ...
    // `isn't`) mis-paired as a fake open/close span, swallowing the real `#`
    // between them and leaking the quoted literal after it.
    const names = extractEmittedSignals(`echo x=1 don't care # this isn't right "leak=99"`);
    assert.ok(
      !names.includes("leak"),
      "two unrelated prose apostrophes must not mis-pair and swallow the real trailing comment",
    );
  });

  test("a real f-string emission preceded by the `f` string-prefix letter is still extracted (#4519 PR #4522 QA re-review round 5 fix, regression guard)", () => {
    // The round-5 fix excludes contraction-shaped quotes (word char on BOTH
    // sides) from opening a real quote — but collect-state.sh's own
    // `print(f'health={d["status"]} redis={d["redis"]}')` has its opening
    // `'` preceded by `f` (a word char) and followed by `h` (a word char,
    // the first letter of "health") — the exact same shape a contraction
    // apostrophe has. isStringPrefixQuote must carve this back out so a
    // genuine f-string opener is never mistaken for prose.
    const names = extractEmittedSignals(
      `try: d=json.load(sys.stdin); print(f'health={d["status"]} redis={d["redis"]}')`,
    );
    assert.ok(names.includes("health"), "a real f-string emission must still be extracted after the round-5 fix");
    assert.ok(names.includes("redis"), "a real f-string emission must still be extracted after the round-5 fix");
  });

  test("an asymmetric possessive apostrophe does not mis-pair and swallow a real trailing comment (#4519 PR #4522 QA re-review round 6, Reviewer A Standards finding)", () => {
    // Round 5's `isProseContractionQuote` only excluded the SYMMETRIC
    // contraction shape (identifier char on both sides). An asymmetric
    // possessive apostrophe — identifier char before, a space/punctuation/
    // EOL boundary after (`cats'`, `dogs'`) — fell through to the generic
    // same-kind-quote pairing, which happily paired two unrelated
    // possessives across the real `#` and swallowed it, leaking a quoted
    // literal from inside the (unstripped) comment.
    const names = extractEmittedSignals(`echo "foo=1" cats' # dogs' "leak=1"`);
    assert.ok(names.includes("foo"), "the genuine emission before the possessive apostrophe must still be found");
    assert.ok(!names.includes("leak"), "a quoted literal inside the trailing comment must not leak past a possessive apostrophe");
  });

  test("a possessive-of-single-letter-identifier comment token does not suppress a genuine later emission (#4519 PR #4522 QA re-review round 6, Reviewer B Standards finding)", () => {
    // `isStringPrefixQuote` treated a prefix-shaped token (`br`, or any of
    // `f`/`r`/`b`/`u`/`fr`/`rf`/`rb`) immediately followed by a lone `s`
    // then a boundary as a genuine string-prefix opener — colliding with an
    // ordinary possessive-of-identifier comment token ("br's return value").
    // That phantom open then stole the real opening quote of the genuine
    // LATER `'real_signal=1 # not a comment inside string'` literal, so the
    // `#` inside that real string was misread as a top-level comment marker
    // and the real emission was silently dropped (suppression, the opposite
    // failure direction from Reviewer A's leakage finding above).
    const withPrefixCollision = extractEmittedSignals(
      `echo x br's foo='real_signal=1 # not a comment inside string'`,
    );
    const withoutPrefixCollision = extractEmittedSignals(
      `echo x foo='real_signal=1 # not a comment inside string'`,
    );
    assert.deepEqual(
      withoutPrefixCollision,
      ["real_signal"],
      "sanity: the baseline line without the possessive-of-identifier token must extract the real emission",
    );
    assert.ok(
      withPrefixCollision.includes("real_signal"),
      "a possessive-of-identifier comment token must not suppress a genuine later emission",
    );
  });

  test("L2 row→emit — every row's producer is emitted by collect-state.sh or target-wip.py (or exempted)", () => {
    // Rows whose column 2 is prose ("(read directly from state)") promote
    // nothing — no hop to verify — so they are skipped exactly as
    // checkSignalParity's L2 skips them.
    const unproduced = [
      ...new Set(
        rows
          .filter((row) => row.producer !== undefined && !row.col2Prose)
          .map((row) => row.producer as string),
      ),
    ].filter((p) => !emitted.includes(p) && !NON_KV_PRODUCERS.has(p));
    assert.deepEqual(
      unproduced,
      [],
      [
        "these Signal-wiring rows name a producer that neither collect-state.sh nor target-wip.py emits — the row claims a promotion hop that does not exist (dead wiring).",
        "Fix: correct the row's producer identifier, or — if it rides the board-state JSON line — add it to NON_KV_PRODUCERS in scripts/ci/signal-parity-check.ts with a rationale. Rows whose column 2 is prose (\"(read directly from state)\") promote nothing and are skipped by design.",
      ].join(" "),
    );
  });

  test("L3 row→read — every promoted state.signals key is read by decide.py (or observability-exempt)", () => {
    const unread = [...tableKeys].filter(
      (k) => !reads.includes(k) && !OBSERVABILITY_ONLY_ROWS.has(k),
    );
    assert.deepEqual(
      unread,
      [],
      [
        "the Signal wiring table promotes these state.signals keys but decide.py never reads them — dead rows.",
        "Fix: add the decide.py reader, or — if the row is observability by design — add it to OBSERVABILITY_ONLY_ROWS in scripts/ci/signal-parity-check.ts with a rationale naming the non-decide.py consumer.",
      ].join(" "),
    );
  });

  test("the parity check is green over the live trio (#4519)", () => {
    const result = checkSignalParity(
      { decide: decideSrc, collect: collectStateSrc, leaf: targetWipSrc, playbook: playbookSrc },
      {
        producerless: PRODUCERLESS_SIGNALS,
        nonKvProducers: NON_KV_PRODUCERS,
        observabilityOnlyRows: OBSERVABILITY_ONLY_ROWS,
      },
    );
    assert.deepEqual(
      { ok: result.ok, error: result.error ?? null },
      { ok: true, error: null },
      `parity over the live trio must be green: L1=${JSON.stringify(result.missingRows)} L2=${JSON.stringify(result.unproducedRows)} L3=${JSON.stringify(result.unreadRows)}`,
    );
    assert.ok(result.stats.rows >= 40, `expected a substantial table (≥40 rows), got ${result.stats.rows}`);
  });

  test("retro_run_drillable IS promoted by the Signal wiring table (#4342 regression pin)", () => {
    assert.ok(
      tableKeys.has("retro_run_drillable"),
      "the `retro_run_drillable` row is the fix itself — without it the #3871 daily drillable path is structurally dead and only the weekly override fires",
    );
  });

  test("parity enforcement is wired into no workflow and no liveness.yaml axis — only the required test job (#4519 INV-2)", () => {
    // INV-2's placement claim ("NOT a fourth `type:` in liveness.yaml, NOT a
    // new advisory workflow, NOT wired into advisory-checks.yml") is a
    // structural absence fact about the repo, not something the parity
    // functions themselves exercise — pin it directly against the three
    // artifacts that WOULD carry a reference if enforcement had leaked out of
    // the required `test` job.
    const livenessYamlSrc = readFileSync(join(REPO_ROOT, "config", "direction", "liveness.yaml"), "utf-8");
    const advisoryWorkflowSrc = readFileSync(join(REPO_ROOT, ".github", "workflows", "advisory-checks.yml"), "utf-8");
    const pkgJsonSrc = readFileSync(join(REPO_ROOT, "package.json"), "utf-8");
    for (const [label, src] of [
      ["config/direction/liveness.yaml", livenessYamlSrc],
      [".github/workflows/advisory-checks.yml", advisoryWorkflowSrc],
      ["package.json", pkgJsonSrc],
    ] as const) {
      assert.ok(
        !src.includes("signal-parity-check"),
        `${label} must not reference scripts/ci/signal-parity-check.ts — enforcement lives ONLY inside test/decide-signal-classes.test.mts, run by the required \`test\` job (#4519 INV-2)`,
      );
    }
  });

  test("the parity module never shells out or touches the network — the three legs are textual only (#4519 INV-3)", () => {
    // INV-3's "zero execution of collect-state.sh and zero network" claim,
    // pinned directly against the shipped module source rather than inferred
    // from a parity-content assertion that says nothing about HOW the legs
    // read their inputs.
    const moduleSrc = readFileSync(join(REPO_ROOT, "scripts", "ci", "signal-parity-check.ts"), "utf-8");
    assert.ok(!/\bnode:child_process\b/.test(moduleSrc), "must not import node:child_process — that would let a leg execute a script instead of reading it textually");
    assert.ok(!/\bfetch\s*\(/.test(moduleSrc), "must not call fetch(...) — a leg must never touch the network");
    assert.ok(!/\bspawn(Sync)?\s*\(/.test(moduleSrc), "must not spawn a child process — collect-state.sh must never be executed, only read");
  });

  test("an unreadable source is a result with an error field, never a throw (#4519 INV-7)", () => {
    const result = checkSignalParity(
      { decide: { error: "ENOENT: no such file" }, collect: "x=1", playbook: "## Signal wiring (state.signals)\n\n| a | b |\n" },
      {},
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /ENOENT/);
    assert.deepEqual(result.missingRows, []);
  });

  test("an unreadable leaf source (target-wip.py) also surfaces via sourceError, not silently dropped (#4519 PR #4522 QA Reviewer B finding 2)", () => {
    // `sourceError` used to resolve decide/collect/playbook only, skipping
    // `sources.leaf` — an unreadable target-wip.py produced no result.error
    // and was silently dropped from emit-extraction inputs instead,
    // inconsistent with the other three sources and INV-7's "never throw,
    // always surface" contract.
    const result = checkSignalParity(
      {
        decide: "x=1",
        collect: "y=1",
        leaf: { error: "ENOENT: no such file target-wip.py" },
        playbook: "## Signal wiring (state.signals)\n\n| a | b |\n",
      },
      {},
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /target-wip\.py/);
    assert.match(result.error ?? "", /ENOENT/);
  });

  test("a renamed Signal wiring heading fails loud (#4519 INV-9)", () => {
    const { error } = extractWiringRows("## Some other heading\n\n| `a` | `b` |\n");
    assert.ok(error, "a missing `## Signal wiring (state.signals)` heading must produce an error, not a vacuous empty row set");
  });

  test("unescaped-pipe table parsing splits real pipes and protects an escaped pipe inside a cell (#4519 INV-9)", () => {
    // A `\|` inside column 1's prose is DATA, not a cell boundary — splitting
    // on every literal `|` (ignoring the escape) would shear the row into
    // extra cells and misalign column 2 (the promoted key) off by one.
    const src =
      "## Signal wiring (state.signals)\n\n" +
      "| `foo` prose with an escaped a\\|b pipe | `state.signals.foo` |\n\n" +
      "## Next section\n";
    const { rows, error } = extractWiringRows(src);
    assert.ok(!error, error);
    assert.equal(rows.length, 1, "the escaped pipe must not split column 1 into an extra cell");
    assert.equal(rows[0]?.producer, "foo", "column 1's first code-span identifier must still resolve to the producer");
    assert.equal(rows[0]?.key, "foo", "column 2's promoted key must still resolve — an unescaped extra split would shift it into the wrong cell");
  });

  // ── exemption honesty (INV-6): both directions per list ──────────────────

  test("PRODUCERLESS_SIGNALS stays honest — no entry has a table row", () => {
    const gainedRows = [...PRODUCERLESS_SIGNALS.keys()].filter((k) => tableKeys.has(k));
    assert.deepEqual(
      gainedRows,
      [],
      "these exemptions have since gained a Signal-wiring row — remove them from PRODUCERLESS_SIGNALS so L1 covers them again",
    );
  });

  test("PRODUCERLESS_SIGNALS stays honest — no entry is emitted by collect-state.sh or target-wip.py", () => {
    // The moment a producer appears, the emitted-but-never-promoted gap — the
    // exact defect this guard exists for — re-opens behind the exemption.
    const nowEmitted = [...PRODUCERLESS_SIGNALS.keys()].filter((sig) =>
      emitted.includes(sig),
    );
    assert.deepEqual(
      nowEmitted,
      [],
      "collect-state.sh / target-wip.py now emit these exempted signals — add their Signal-wiring rows and remove them from PRODUCERLESS_SIGNALS",
    );
  });

  test("NON_KV_PRODUCERS stays honest — every key still sits in the board-state keys literal", () => {
    // The exemption's premise: the key rides the JSON line
    // `print(json.dumps({k:d[k] for k in keys}))`. The moment the key leaves
    // the `keys=[...]` python list literal, the producer is GONE and the
    // exempted row names dead wiring.
    const keysLiteral = collectStateSrc.match(/keys=\[([^\]]*)\]/);
    assert.ok(keysLiteral, "collect-state.sh must still carry the board-state `keys=[...]` list literal — the NON_KV exemption anchor has moved");
    const inLiteral = new Set(
      [...(keysLiteral[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string),
    );
    const gone = [...NON_KV_PRODUCERS.keys()].filter((k) => !inLiteral.has(k));
    assert.deepEqual(
      gone,
      [],
      "these NON_KV_PRODUCERS keys are no longer in the board-state keys=[...] literal — their rows name a JSON-line producer that no longer emits them",
    );
  });

  test("NON_KV_PRODUCERS stays honest — every key still has a Signal-wiring row", () => {
    const rowless = [...NON_KV_PRODUCERS.keys()].filter((k) => !rowProducers.has(k));
    assert.deepEqual(
      rowless,
      [],
      "these NON_KV_PRODUCERS keys no longer name a row producer — the exemption is stale, delete the entry",
    );
  });

  test("OBSERVABILITY_ONLY_ROWS stays honest — no entry is read by decide.py", () => {
    const nowRead = [...OBSERVABILITY_ONLY_ROWS.keys()].filter((k) => reads.includes(k));
    assert.deepEqual(
      nowRead,
      [],
      "decide.py now reads these observability-exempt keys — remove them from OBSERVABILITY_ONLY_ROWS so L3 covers them again",
    );
  });

  test("OBSERVABILITY_ONLY_ROWS stays honest — every entry is still a promoted table key", () => {
    const rowGone = [...OBSERVABILITY_ONLY_ROWS.keys()].filter((k) => !tableKeys.has(k));
    assert.deepEqual(
      rowGone,
      [],
      "these OBSERVABILITY_ONLY_ROWS entries no longer have a Signal-wiring row — the exemption is stale, delete the entry",
    );
  });

  test("the #4134 test-subject sprawl ratchet is not regenerated to admit a new parity test file — decide.py stays at 10, collect-state.sh at 17 (#4519 INV-1)", () => {
    // INV-1: the parity legs REPLACE the #4342 block inside THIS file rather
    // than land in a new test/*.test.mts file. A new file whose primary
    // subject resolves to decide.py or collect-state.sh would force a bump
    // of these two baseline counts (test/fixtures/test-subject-baseline.json,
    // issue #4134's sprawl ratchet) — so an unchanged baseline is a
    // mechanical witness that no such file was admitted.
    const baselinePath = join(REPO_ROOT, "test", "fixtures", "test-subject-baseline.json");
    const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as Record<string, number>;
    assert.equal(
      baseline["scripts/autopilot/decide.py"],
      10,
      "the decide.py sprawl-ratchet baseline moved off 10 — INV-1 forbids regenerating it to admit a new parity test file",
    );
    assert.equal(
      baseline["scripts/autopilot/collect-state.sh"],
      17,
      "the collect-state.sh sprawl-ratchet baseline moved off 17 — INV-1 forbids regenerating it to admit a new parity test file",
    );
  });
});
}

// hitl_grill_saturated guard on the idle-board backfill set (issue #4391).
// ===========================================================================
{

/**
 * decide.py — the `hitl_grill_saturated` anti-feedback-loop guard (issue
 * #4391): while the operator-admission inbox (`hitl-grill`, cap 10) is
 * saturated, every orchestrator-defect finding the idle-board producers file
 * parks into a lane only the operator can drain — so an idle-board dispatch
 * is a guaranteed ~70-130k-token no-op. The guard suppresses the
 * `orch_backfill_idle` path of discover_orch and architecture_orch:
 *
 *   - discover_orch's 7d staleness-floor path (#4114) stays UNGATED, so the
 *     producer can never go structurally dark on a full inbox (it still
 *     fires at most once per 7d, bounded by the 1h class cooldown);
 *   - architecture_orch has no floor (#4114 INV-3 deferred it) — the
 *     suppressor is total while the inbox is full, and the operator
 *     draining it below the cap is the release;
 *   - cleanup_orch is NOT gated: hydra-cleanup files `cleanup-scan` +
 *     `ready-for-agent`, never `hitl-grill`, and already carries its own
 *     cleanup_board_saturated cap;
 *   - the signal is presence-gated (INV-6): absent from state.signals →
 *     every selector behaves exactly as today.
 *
 * Fixtures deliberately set signal_last_fired so the SUPPRESSION — not a
 * cooldown or floor technicality — is the thing under test (cooled = >1h
 * since last fire; not floor-dark = <7d).
 */
const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-hitl-grill-test-"));
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

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
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

const discover = (a: any) => a.type === "dispatch" && a.slot === "discover_orch";
const architecture = (a: any) => a.type === "dispatch" && a.slot === "architecture_orch";
const cleanupOrch = (a: any) => a.type === "dispatch" && a.slot === "cleanup_orch";

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 24 * 3600;
// Cooled (>1h since last fire) but NOT floor-dark (<7d): pins that the
// suppression, not a cooldown or the staleness floor, is what stopped the
// dispatch in the suppressed cases below.
const RECENT_ENOUGH = NOW - 2 * HOUR;

describe("decide.py — hitl_grill_saturated guard on the idle-board backfill set (issue #4391)", () => {
  test("discover_orch: idle board + saturated inbox → NO dispatch", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true, hitl_grill_saturated: true },
      signal_last_fired: { discover_orch: RECENT_ENOUGH },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, discover),
      undefined,
      "a saturated hitl-grill inbox must suppress the idle-board discover dispatch",
    );
  });

  test("discover_orch: idle board, saturated ABSENT → dispatches as before (presence-gated, INV-6)", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { discover_orch: RECENT_ENOUGH },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, discover);
    assert.ok(a, "without the saturation signal the idle path must fire exactly as before");
    assert.match(a.reason, /orch board idle — discovery backfill/);
  });

  test("discover_orch: 7d staleness floor still fires UNDER saturation (never structurally dark, INV-2)", () => {
    // Busy board (orch_backfill_idle absent) + dark 8d + saturated: the floor
    // path is the one #4114 added and it stays ungated by #4391.
    const state = baseState({
      signals: { hitl_grill_saturated: true },
      signal_last_fired: { discover_orch: NOW - 8 * DAY },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, discover);
    assert.ok(a, "the staleness floor must survive the saturation guard");
    assert.match(a.reason, /discover staleness floor \(>7d dark since last fire\)/);
  });

  test("discover_orch: idle + saturated + dark → the floor (not the idle path) is what fires", () => {
    // The INV-2 core property: under a saturated inbox discover_orch still
    // fires at most once per 7d — via the floor, never via the idle path.
    const state = baseState({
      signals: { orch_backfill_idle: true, hitl_grill_saturated: true },
      signal_last_fired: { discover_orch: NOW - 8 * DAY },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, discover);
    assert.ok(a, "a floor-dark discover must dispatch even on an idle+saturated board");
    assert.doesNotMatch(
      a.reason,
      /orch board idle/,
      "the IDLE path is suppressed; only the floor path may fire under saturation",
    );
    assert.match(a.reason, /staleness floor/);
  });

  test("architecture_orch: idle board + saturated inbox → NO dispatch", () => {
    // discover_orch inside its 1h cooldown so it cannot fire either — the
    // fixture pins architecture_orch's own suppression, not a stagger
    // technicality.
    const state = baseState({
      signals: { orch_backfill_idle: true, hitl_grill_saturated: true },
      signal_last_fired: { discover_orch: NOW - 1800, architecture_orch: 0 },
    });
    const plan = runDecide(state, null);
    assert.equal(findAction(plan, architecture), undefined, "saturated inbox suppresses architecture backfill");
    assert.equal(findAction(plan, discover), undefined, "cooldown-bound discover stays silent too");
  });

  test("architecture_orch: idle board, saturated ABSENT → dispatches as before (the suppression is the guard's doing)", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { discover_orch: NOW - 1800, architecture_orch: 0 },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, architecture);
    assert.ok(a, "without the saturation signal the idle path must fire exactly as before");
    assert.match(a.reason, /orch board idle — architecture backfill/);
  });

  test("architecture_orch: arch_board_saturated still suppresses independently (the sibling cap keeps its teeth)", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true, arch_board_saturated: true },
      signal_last_fired: { discover_orch: NOW - 1800, architecture_orch: 0 },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, architecture),
      undefined,
      "the pre-existing arch cap must keep its exact early-return semantics",
    );
  });

  test("cleanup_orch: idle board + saturated inbox → STILL dispatches (NOT gated, INV-3)", () => {
    // hydra-cleanup files cleanup-scan + ready-for-agent, never hitl-grill;
    // its own anti-flood cap is cleanup_board_saturated, absent here.
    const state = baseState({
      signals: { orch_backfill_idle: true, hitl_grill_saturated: true },
      signal_last_fired: { discover_orch: RECENT_ENOUGH, cleanup_orch: RECENT_ENOUGH },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, cleanupOrch);
    assert.ok(a, "cleanup_orch must stay ungated by the hitl-grill inbox");
    assert.equal(a.skill, "hydra-cleanup");
  });
});

/**
 * decide.py — `apply:true` stamping on the architecture_orch / cleanup_orch
 * idle-board backfill dispatches (issue #4605).
 *
 * Both `hydra-architecture-scan` and `hydra-cleanup` are dry-run by default
 * (they file zero issues without `--apply`), so an argument-free headless
 * dispatch off `orch_backfill_idle` was a silent no-op on GitHub — the same
 * defeat pattern the #1078 retro_orch lesson fixed there. Both selectors now
 * stamp `prompt_args={"apply": True}` (mirroring the retro_orch arm literal),
 * and the same stamp rides the `cleanup_orch` ESCALATION_POLICY re-dispatch
 * (INV-4) so the Sonnet retry that the #3274 dedup keeps over the plain
 * signal copy is not silently defeated back to a dry run.
 */
describe("decide.py — apply:true stamping on architecture_orch / cleanup_orch idle-board dispatch (issue #4605)", () => {
  test("architecture_orch: orch_backfill_idle dispatch carries prompt_args.apply === true", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { discover_orch: NOW - 1800, architecture_orch: 0 },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, architecture);
    assert.ok(a, "architecture_orch must dispatch on orch_backfill_idle");
    assert.equal(
      a.prompt_args?.apply,
      true,
      "hydra-architecture-scan is dry-run by default; the idle backfill must forward --apply",
    );
  });

  test("cleanup_orch: orch_backfill_idle dispatch carries prompt_args.apply === true", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { discover_orch: RECENT_ENOUGH, cleanup_orch: RECENT_ENOUGH },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, cleanupOrch);
    assert.ok(a, "cleanup_orch must dispatch on orch_backfill_idle");
    assert.equal(
      a.prompt_args?.apply,
      true,
      "hydra-cleanup is dry-run by default; the idle backfill must forward --apply",
    );
  });

  test("cleanup_orch: cleanup_board_saturated still suppresses the dispatch even with orch_backfill_idle (apply stamping does not defeat the cap)", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true, cleanup_board_saturated: true },
      signal_last_fired: { discover_orch: RECENT_ENOUGH, cleanup_orch: RECENT_ENOUGH },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, cleanupOrch),
      undefined,
      "cleanup_board_saturated must still suppress cleanup_orch ahead of the apply-stamped dispatch",
    );
  });

  test("cleanup_orch: no_op escalation on an idle, non-saturated board carries BOTH escalate_model==='sonnet' AND apply===true (INV-4)", () => {
    // Same co-trigger scenario as decide-escalation-events.test.mts's
    // "co-trigger: idle-board cleanup_orch no_op escalates ONCE" case (issue
    // #3274 QA blocker): orch_backfill_idle=true plus a fresh (non-saturated)
    // no_op stop makes _rule_escalation (step 2.5) and _rule_signal_classes
    // (step 5, keyed off orch_backfill_idle) BOTH eligible to dispatch
    // cleanup_orch; the #3274 dedup keeps the escalation copy. Without INV-4's
    // merge, that surviving copy would carry escalate_model but silently drop
    // apply:true, defeating #4605 on exactly the turns cascade routing fires.
    const state = {
      ...baseState({
        signals: { orch_backfill_idle: true },
        signal_last_fired: { discover_orch: RECENT_ENOUGH, cleanup_orch: RECENT_ENOUGH },
      }),
      slot_events: {
        events: [
          {
            fields: {
              event: "subagent_stop",
              slot: "cleanup_orch",
              status: "no_op",
              task_id: "t-4605",
              summary: "",
              // `_filter_stale_slot_events` drops any entry whose ts_epoch
              // predates `state.started_epoch` (issue #4441) — started_epoch
              // is stamped at baseState() call time, strictly AFTER the
              // module-scope `NOW` constant above, so the event time must be
              // >= NOW with headroom, not NOW-relative-in-the-past.
              ts_epoch: NOW + 60,
            },
          },
        ],
        last_id: "0-0",
      },
    };
    const plan = runDecide(state, null);
    const cleanupDispatches = (plan.actions ?? []).filter(
      (a: any) => a.type === "dispatch" && a.slot === "cleanup_orch",
    );
    assert.equal(
      cleanupDispatches.length,
      1,
      `exactly one cleanup_orch dispatch expected (the #3274 dedup), got ${cleanupDispatches.length}: ` +
        JSON.stringify(cleanupDispatches.map((a: any) => a.prompt_args ?? {})),
    );
    const [dispatch] = cleanupDispatches;
    assert.equal(
      dispatch.prompt_args?.escalate_model,
      "sonnet",
      "the surviving dispatch must be the escalation (sonnet) re-dispatch",
    );
    assert.equal(
      dispatch.prompt_args?.apply,
      true,
      "the escalation re-dispatch must ALSO carry apply:true — dropping it here silently reverts cleanup_orch to a dry run",
    );
  });
});
}

// ===========================================================================
// Issue #4476 — data-driven dispatch isolation for every Target-scope class.
// ===========================================================================
{
const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

/** Run a python probe against a freshly-imported decide.py; returns parsed stdout JSON. */
function probeIsolation(body: string): any {
  const script = `
import sys, json, importlib.util
spec = importlib.util.spec_from_file_location("decide", ${JSON.stringify(DECIDE)})
m = importlib.util.module_from_spec(spec)
sys.modules["decide"] = m
spec.loader.exec_module(m)
${body}
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`isolation probe failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

/** Try a mutated policy against the import-time validator. */
function validateMutated(mutation: string): { raised: boolean; msg?: string } {
  return probeIsolation(`
policy = dict(m.TARGET_ISOLATION)
${mutation}
try:
    m._validate_target_isolation(policy, m.CLASS_TAXONOMY)
    print(json.dumps({"raised": False}))
except m.TaxonomyError as e:
    print(json.dumps({"raised": True, "msg": str(e)}))
`);
}

describe("decide.py — dispatch isolation is data-driven per class (issue #4476)", () => {
  // Stamp one synthetic dispatch action per classes.json row through the real
  // Step-7 stamper and read back the `isolation` field it writes.
  const stamped = probeIsolation(`
out = {}
for r in m.CLASS_TAXONOMY:
    s = r["name"]
    actions = [{"type": "dispatch", "slot": s, "skill": m.CLASS_SKILL[s]}]
    m._stamp_dispatch_metadata(actions, {"run_id": "r1", "turn": 1})
    out[s] = actions[0].get("isolation")
print(json.dumps({"stamped": out, "scope": m.CLASS_SCOPE}))
`);

  const cases: Array<[string, string]> = [
    ["dev_target", "self"],
    ["qa_target", "self"],
    ["research_target", "self"],
    ["cleanup_target", "self"],
    ["design_qa_target", "self"],
    ["sweep_target", "worktree"],
    ["discover_target", "worktree"],
    ["wire_or_retire_target", "worktree"],
    ["health", "worktree"],
  ];
  for (const [slot, mode] of cases) {
    test(`${slot} dispatch is stamped isolation=${mode}`, () => {
      assert.equal(stamped.stamped[slot], mode);
    });
  }

  test("the verdict table covers exactly the eight *_target classes plus health", () => {
    const needs = Object.entries(stamped.scope as Record<string, string>)
      .filter(([, s]) => s === "target" || s === "both")
      .map(([n]) => n)
      .sort();
    assert.deepEqual(needs, cases.map(([n]) => n).sort());
  });

  test("every orch-scope class is stamped isolation=worktree", () => {
    for (const [slot, scope] of Object.entries(stamped.scope as Record<string, string>)) {
      if (scope === "orch") assert.equal(stamped.stamped[slot], "worktree", slot);
    }
  });

  test("an unclassified target-scope class fails loud (no silent default)", () => {
    const res = validateMutated(`del policy["cleanup_target"]`);
    assert.equal(res.raised, true);
    assert.match(res.msg ?? "", /cleanup_target/);
  });

  test("a policy key that is not a classes.json row fails loud", () => {
    const res = validateMutated(`policy["ghost_target"] = "self"`);
    assert.equal(res.raised, true);
    assert.match(res.msg ?? "", /ghost_target/);
  });

  test("an orch-scope policy key fails loud", () => {
    const res = validateMutated(`policy["dev_orch"] = "worktree"`);
    assert.equal(res.raised, true);
    assert.match(res.msg ?? "", /dev_orch/);
  });

  test("an invalid verdict value fails loud", () => {
    const res = validateMutated(`policy["sweep_target"] = "none"`);
    assert.equal(res.raised, true);
    assert.match(res.msg ?? "", /sweep_target/);
  });
});
}
