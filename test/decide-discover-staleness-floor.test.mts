/**
 * Regression tests for `scripts/autopilot/decide.py` — the `discover_orch`
 * staleness floor (issue #4114).
 *
 * Root cause (#4114, corroborated by
 * docs/research/2026-08-08-discover-orch-dispatch-and-model-routing-rootcause.md):
 * `discover_orch`'s ONLY trigger was the shared `orch_backfill_idle`
 * board-empty signal, which requires ready_for_agent==0 AND needs_research==0
 * AND needs_triage==0 AND work_queue==0 SIMULTANEOUSLY. A healthy,
 * continuously-stocked orch board (live evidence 2026-07-26..2026-08-17:
 * 5-36 ready-for-agent items at every sample) keeps that conjunction false
 * indefinitely, so the producer class went structurally dark — 0 dispatches
 * since its #959 revival, and #3920's cooldown carry-forward fix (live,
 * deployed) was orthogonal: the selector simply never had a true input.
 * architecture_orch / cleanup_orch share the symptom (last fired 2026-07-25)
 * and are deliberately NOT fixed here (design-concept INV-3: this change
 * scopes the floor to discover_orch only; the class-parameterized helper
 * exists so a follow-up can extend it to the siblings).
 *
 * The fix: `discover_orch`'s selector fires on `orch_backfill_idle` OR a
 * 7-day staleness floor derived purely from
 * `state.signal_last_fired['discover_orch']` + `now` (ADR-0007 purity,
 * INV-1). A NEVER-fired class (last == 0) counts as dark — the exact #4114
 * live state — deliberately inverting signal_starved's never-fired semantics
 * (that floor is an intra-turn stagger override where "never fired" is normal
 * cold-start; this one is a gate-level producer trigger where "never fired"
 * IS the dark state to break). Floor dispatches carry a distinguishable
 * reason string (INV-4, mirroring the signal_starved annotation pattern).
 *
 * We exercise decide.py through its `decide` CLI subcommand so the tests pin
 * the JSON wire contract the playbook prose consumes (same harness as
 * decide-retro-class.test.mts).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

const FLOOR_SEC = 7 * 24 * 60 * 60;

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-discover-floor-test-"));
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

// A BUSY board: orch_backfill_idle absent/false (the structural norm on a
// healthy, stocked board — the condition that starved the class for 3+ weeks).
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
      // 6 days ago — inside the 1h cooldown AND inside the 7d floor: the
      // "recently ran, nothing due" default for the sibling classes below.
      discover_orch: Math.floor(Date.now() / 1000) - 6 * 24 * 60 * 60,
      discover_target: 0,
      architecture_orch: Math.floor(Date.now() / 1000) - 6 * 24 * 60 * 60,
      cleanup_orch: Math.floor(Date.now() / 1000) - 6 * 24 * 60 * 60,
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

function discoverDispatch(plan: any): any | undefined {
  return findAction(plan, (x) => x.type === "dispatch" && x.slot === "discover_orch");
}

describe("decide.py — discover_orch staleness floor (issue #4114)", () => {
  test("floor fires on a NEVER-fired class (last == 0) under a busy board — the #4114 live state", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        health: 0,
        sweep_orch: 0,
        sweep_target: 0,
        discover_orch: 0, // never fired — maximally dark
        discover_target: 0,
        architecture_orch: now - 22 * 24 * 60 * 60, // the live sibling symptom
        cleanup_orch: now - 22 * 24 * 60 * 60,
      },
    });
    const plan = runDecide(state, null);
    const a = discoverDispatch(plan);
    assert.ok(
      a,
      "discover_orch must dispatch via the staleness floor when it has never fired, even on a busy (non-idle) board",
    );
    assert.equal(a.skill, "hydra-discover");
  });

  test("floor fires when the class has been dark longer than 7d under a busy board", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        discover_orch: now - (FLOOR_SEC + 60), // just past the floor
        architecture_orch: now - 6 * 24 * 60 * 60,
        cleanup_orch: now - 6 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      discoverDispatch(plan),
      "discover_orch must dispatch once dark > 7d, even with orch_backfill_idle false",
    );
  });

  test("floor does NOT fire inside the 7d window on a busy board (recently ran)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        discover_orch: now - (FLOOR_SEC - 60 * 60), // 7d minus 1h — inside
        architecture_orch: now - 6 * 24 * 60 * 60,
        cleanup_orch: now - 6 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      discoverDispatch(plan),
      undefined,
      "no idle signal and dark < 7d → no dispatch (the floor is 7d, not the 1h cooldown)",
    );
  });

  test("the 1h class cooldown still gates the floor path (dark > 7d BUT fired 30min ago is impossible-by-construction; a 30min-old stamp must suppress)", () => {
    // A 30min-old stamp is necessarily inside the 7d floor too, so this pins
    // that the COOLDOWN check (signal_is_cooled, first gate in
    // _select_for_signal) still applies ahead of the floor: a hypothetical
    // floor shorter than the cooldown could never re-fire inside the window.
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        discover_orch: now - 30 * 60, // 30min ago — inside the 1h cooldown
        architecture_orch: now - 6 * 24 * 60 * 60,
        cleanup_orch: now - 6 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      discoverDispatch(plan),
      undefined,
      "the per-class 1h cooldown must suppress the floor path inside its window",
    );
  });

  test("idle path still fires and keeps its idle reason (existing #959 behavior unchanged)", () => {
    const state = baseState({ signals: { orch_backfill_idle: true } });
    const plan = runDecide(state, null);
    const a = discoverDispatch(plan);
    assert.ok(a, "discover_orch must still dispatch on orch_backfill_idle");
    assert.match(
      String(a.reason),
      /idle/,
      "the idle-triggered dispatch keeps the idle-worded reason",
    );
    assert.doesNotMatch(
      String(a.reason),
      /staleness floor/,
      "the idle path must NOT borrow the floor's reason",
    );
  });

  test("floor-triggered dispatch is distinguishable in the audit trail via its reason (INV-4)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        discover_orch: now - (FLOOR_SEC + 60),
        architecture_orch: now - 6 * 24 * 60 * 60,
        cleanup_orch: now - 6 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    const a = discoverDispatch(plan);
    assert.ok(a, "floor dispatch must be present");
    assert.match(
      String(a.reason),
      /staleness floor/i,
      "the floor-triggered reason must name the staleness floor (mirroring the signal_starved annotation pattern)",
    );
  });

  test("architecture_orch does NOT gain the floor (busy board, dark 22d) — INV-3, siblings keep idle-only gating", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        discover_orch: now - (FLOOR_SEC + 60),
        architecture_orch: now - 22 * 24 * 60 * 60, // dark 22d — the live symptom
        cleanup_orch: now - 22 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(discoverDispatch(plan), "discover_orch fires via its floor");
    assert.equal(
      findAction(plan, (x) => x.type === "dispatch" && x.slot === "architecture_orch"),
      undefined,
      "architecture_orch must stay idle-only in this change (deferred follow-up, not this PR)",
    );
    assert.equal(
      findAction(plan, (x) => x.type === "dispatch" && x.slot === "cleanup_orch"),
      undefined,
      "cleanup_orch must stay idle-only in this change (deferred follow-up, not this PR)",
    );
  });

  test("target-only scope still excludes the floor path (scope mask is the outer gate)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      scope: "target-only",
      signal_last_fired: {
        discover_orch: 0, // never fired — floor met
        architecture_orch: now - 22 * 24 * 60 * 60,
        cleanup_orch: now - 22 * 24 * 60 * 60,
      },
    });
    const plan = runDecide(state, null);
    assert.equal(
      discoverDispatch(plan),
      undefined,
      "target-only scope must exclude discover_orch even when the floor is met (INV-008)",
    );
  });

  test("burned_classes still suppresses the floor path", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      burned_classes: ["discover_orch"],
      signal_last_fired: {
        discover_orch: 0, // never fired — floor met
        architecture_orch: now - 22 * 24 * 60 * 60,
        cleanup_orch: now - 22 * 24 * 60 * 60,
      },
    });
    const plan = runDecide(state, null);
    assert.equal(
      discoverDispatch(plan),
      undefined,
      "a burned (soft-capped) discover_orch must not dispatch via the floor (issue #432)",
    );
  });

  test("stagger on a fully idle board still allows only ONE backfill dispatch per turn", () => {
    // last fired 2h ago for BOTH backfill classes: past the 1h cooldown, NOT
    // past the 24h BACKFILL_STARVATION_FLOOR (a starved class legitimately
    // bypasses the stagger as an additive exception, so 6d-old stamps would
    // make BOTH dispatch — that is #2428 behavior, not a stagger violation).
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: {
        discover_orch: now - 2 * 60 * 60,
        architecture_orch: now - 2 * 60 * 60,
        cleanup_orch: now - 2 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    const backfill = (plan.actions ?? []).filter(
      (a: any) =>
        a.type === "dispatch" && (a.slot === "discover_orch" || a.slot === "architecture_orch"),
    );
    assert.ok(backfill.length === 1, `exactly one backfill dispatch per turn, got ${backfill.length}`);
    assert.equal(backfill[0].slot, "discover_orch", "discover_orch is ahead in the iteration order");
  });
});
