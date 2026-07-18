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
  test("fires on tickets_available and invokes the upstream to-tickets skill", () => {
    const state = baseState({ signals: { tickets_available: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, ticketsDispatch);
    assert.ok(a, "tickets_orch must dispatch on tickets_available");
    assert.equal(
      a.skill,
      "to-tickets",
      "the tickets stage dispatches the vendored upstream to-tickets skill, not hydra-prd",
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
});
