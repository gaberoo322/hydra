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
