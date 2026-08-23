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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

  test("retro_orch fires after 24h cooldown elapses", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { retro_run_available: true },
      // 25h ago → past the 24h cooldown.
      signal_last_fired: { retro_orch: now - 25 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "retro_orch"),
      "retro_orch must fire once the 24h cooldown has elapsed",
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

  test("needs_qa_target (board target_needs_qa>0) → qa_target dispatches hydra-qa scope=target", () => {
    const state = baseState({ signals: { needs_qa_target: true } });
    const plan = runDecide(state, feedNoResearch);
    const a = findAction(plan, qaTarget);
    assert.ok(a, "qa_target must dispatch when the target GH board has needs-qa work");
    assert.equal(a.skill, "hydra-qa");
    assert.equal((a.prompt_args ?? {}).scope, "target");
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
// Added for issue #4130 (design-concept issue-4130) — degraded board reads
// vs the orch_backfill_idle backfill classes.
// ===========================================================================
{
/**
 * Issue #4130: a GraphQL-only GitHub outage failed every `gh ... --json`
 * board read in collect-state.sh, whose `|| echo` guards then emitted
 * legitimate-LOOKING zeros — and the arch emitter's all-counts-zero
 * conjunction fabricated `orch_backfill_idle=true`, firing the backfill
 * classes (discover_orch / architecture_orch / cleanup_orch / skill_prune)
 * against a board whose true state was unknown.
 *
 * The fix is at the SOURCE (design-concept INV-5): collect-state.sh fails
 * orch_backfill_idle CLOSED (false) on a failed arch read, so decide.py needs
 * NO per-class degraded gate (rejected alternative 3). These cases pin the
 * seam contract from the decide side: the signal pair a degraded turn now
 * produces (`orch_board_signals_degraded=true` + `orch_backfill_idle=false`)
 * dispatches nothing, while the genuinely-empty pair (`idle=true`, no
 * degraded flag) keeps dispatching exactly as before (INV-3 — a required
 * regression case, not incidental).
 *
 * Same harness as the blocks above: spawn the `decide` CLI subcommand and
 * pin the JSON wire contract. The emission-side fail-close itself is pinned
 * in test/autopilot-idle.test.mts against the shipped python emitter.
 */

const REPO_ROOT2 = resolve(import.meta.dirname, "..");
const DECIDE2 = join(REPO_ROOT2, "scripts", "autopilot", "decide.py");

interface Tmp2 {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp2(): Tmp2 {
  const dir = mkdtempSync(join(tmpdir(), "decide-backfill-degraded-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

function baseState2(signals: Record<string, unknown>): any {
  // 2h-ago stamps: older than the 1h backfill class cooldowns (idle arm
  // eligible) but younger than discover_orch's 7d staleness floor — so the
  // FLOOR arm (deliberately not degraded-gated per the #4130 design concept)
  // cannot fire and mask the idle-arm behaviour under test.
  const cooledNotDark = Math.floor(Date.now() / 1000) - 7_200;
  return {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: { token_budget: 2_000_000, wall_clock_max_sec: 28_800, idle_drain_turns: 5, scope: "all" },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    turn: 1,
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
    signal_last_fired: {
      sweep_orch: cooledNotDark,
      sweep_target: cooledNotDark,
      discover_orch: cooledNotDark,
      discover_target: cooledNotDark,
      architecture_orch: cooledNotDark,
      cleanup_orch: cooledNotDark,
    },
    signals,
    research_force_counter: {},
  };
}

function runDecide2(state: any): any {
  const t = makeTmp2();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(null));
    writeFileSync(t.events, JSON.stringify([]));
    const r = spawnSync("python3", [DECIDE2, "decide", t.state, t.cands, t.events], {
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

const BACKFILL_CLASSES = ["discover_orch", "architecture_orch", "cleanup_orch", "skill_prune"] as const;

function backfillDispatches(plan: any): any[] {
  return (plan.actions ?? []).filter(
    (a: any) => a.type === "dispatch" && BACKFILL_CLASSES.includes(a.slot),
  );
}

describe("decide.py — degraded board read suppresses the orch_backfill_idle backfill classes (issue #4130)", () => {
  test("the degraded signal pair (degraded=true, idle=false) dispatches no backfill class", () => {
    // Exactly what collect-state.sh now emits on a failed arch read. The
    // suppression comes from idle=false (the source fail-close), not from a
    // decide-side gate — see the sibling emission-side tests.
    const plan = runDecide2(
      baseState2({ orch_board_signals_degraded: true, orch_backfill_idle: false }),
    );
    assert.deepEqual(
      backfillDispatches(plan),
      [],
      "no backfill class may fire on a snapshot whose board read failed",
    );
  });

  test("INV-3: the genuinely-empty pair (idle=true, no degraded flag) still fires the backfill classes", () => {
    const plan = runDecide2(baseState2({ orch_backfill_idle: true }));
    const fired = backfillDispatches(plan).map((a: any) => a.slot);
    assert.ok(
      fired.length > 0,
      "a genuinely idle board must keep backfilling exactly as before #4130",
    );
    assert.ok(
      fired.includes("discover_orch"),
      `expected discover_orch among the fired classes, got ${JSON.stringify(fired)}`,
    );
  });
});
}
