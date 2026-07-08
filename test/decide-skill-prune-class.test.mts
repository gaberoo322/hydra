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
