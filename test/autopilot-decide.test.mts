/**
 * Regression tests for `scripts/autopilot/decide.py` — the L2 decision
 * brain (issue #426).
 *
 * decide() is a pure function: input is `(state, candidates, events)`,
 * output is a JSON `Plan` object containing a typed action list. The
 * autopilot model executes each action via the right tool. The function's
 * job is to pick the right actions for the current world state.
 *
 * We exercise decide.py through its `decide` CLI subcommand
 * (`python3 decide.py decide <state> <candidates> <events>`) so the tests
 * also pin the JSON wire contract — that's what the playbook prose
 * consumes. Each test writes the three input JSON files to a tempdir,
 * runs the script, and asserts on the parsed Plan.
 *
 * The tests are grouped by what the AC of #426 calls out:
 *
 *   1. Pipeline-protected dispatch (qa_orch / dev_orch / research_orch / ...)
 *   2. Confidence threshold + research force-dispatch
 *   3. Option C merge policy (Tier 0/1/2/3, mechanical carve-out, scope-justif)
 *   4. Scope filter (exclusion mask, INV-008)
 *   5. Completion reap + INV-006 ordering
 *   6. Termination (budget / wall-clock / idle / failure backstop)
 *   7. Signal classes (cooldowns + presence)
 *   8. Idle fallback / heartbeat wait
 *
 * The test count is intentionally generous (~50) — each is a single
 * pinned behaviour, easier to triage than one fat assertion.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const DECIDE = join(SCRIPTS, "decide.py");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-decide-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

interface StateOverrides {
  scope?: string;
  cumulative_tokens?: number;
  idle_turns?: number;
  burned_classes?: string[];
  slots?: Record<string, unknown>;
  signal_last_fired?: Record<string, number>;
  signals?: Record<string, unknown>;
  failure_log?: Array<Record<string, unknown>>;
  reaped_task_ids?: string[];
  research_force_counter?: Record<string, Record<string, number>>;
  started_epoch?: number;
  wall_clock_max_sec?: number;
  token_budget?: number;
  idle_drain_turns?: number;
}

function baseState(o: StateOverrides = {}): any {
  return {
    started_epoch: o.started_epoch ?? Math.floor(Date.now() / 1000),
    limits: {
      token_budget: o.token_budget ?? 2_000_000,
      wall_clock_max_sec: o.wall_clock_max_sec ?? 28_800,
      idle_drain_turns: o.idle_drain_turns ?? 5,
      scope: o.scope ?? "all",
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: o.cumulative_tokens ?? 0,
    dispatches: 0,
    idle_turns: o.idle_turns ?? 0,
    turn: 0,
    burned_classes: o.burned_classes ?? [],
    reaped_task_ids: o.reaped_task_ids ?? [],
    failure_log: o.failure_log ?? [],
    slots: o.slots ?? {
      dev_orch: null, qa_orch: null, research_orch: null,
      dev_target: null, qa_target: null, research_target: null,
    },
    signal_last_fired: o.signal_last_fired ?? {
      health: 0, sweep_orch: 0, sweep_target: 0,
      discover_orch: 0, discover_target: 0,
    },
    signals: o.signals ?? {},
    research_force_counter: o.research_force_counter ?? {},
  };
}

function runDecide(state: any, candidates: any = null, events: any[] = [], tmp?: Tmp): any {
  const t = tmp ?? makeTmp();
  writeFileSync(t.state, JSON.stringify(state));
  writeFileSync(t.cands, JSON.stringify(candidates));
  writeFileSync(t.events, JSON.stringify(events));
  const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout);
  if (!tmp) rmSync(t.dir, { recursive: true, force: true });
  return parsed;
}

function actionTypes(plan: any): string[] {
  return (plan.actions ?? []).map((a: any) => a.type);
}

function findAction(plan: any, predicate: (a: any) => boolean): any | undefined {
  return (plan.actions ?? []).find(predicate);
}

// ---------------------------------------------------------------------------
// 1. Pipeline-protected dispatch
// ---------------------------------------------------------------------------

describe("decide.py — pipeline dispatch (issue #426 AC: 6-slot pipeline)", () => {
  test("dispatches dev_orch when slot free and best candidate >= 0.5", () => {
    const state = baseState();
    const cands = { candidates: [{ issue: 101, anchorRef: "issue-101", score: 0.72 }], research_recommended: false };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.ok(dispatch, "expected a dev_orch dispatch action");
    assert.equal(dispatch.skill, "hydra-dev");
    assert.equal(dispatch.prompt_args.anchor, "issue-101");
  });

  test("does NOT dispatch dev_orch when best score < 0.5", () => {
    const state = baseState();
    const cands = { candidates: [{ issue: 99, anchorRef: "issue-99", score: 0.3 }], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(dispatch, undefined, "low-confidence candidate must not trigger dev_orch dispatch");
  });

  test("does NOT dispatch dev_orch when slot is busy", () => {
    const state = baseState({
      slots: {
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 50_000 },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
    });
    const cands = { candidates: [{ issue: 1, anchorRef: "x", score: 0.9 }], research_recommended: false };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(dispatch, undefined, "busy slot must not receive a new dispatch (INV-002)");
  });

  test("dispatches qa_orch when needs_qa_orch signal present", () => {
    const state = baseState({ signals: { needs_qa_orch: true } });
    const plan = runDecide(state, null);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "qa_orch");
    assert.ok(dispatch, "needs_qa_orch must trigger qa_orch dispatch");
    assert.equal(dispatch.skill, "hydra-qa");
  });

  test("dispatches qa_target when needs_qa_target signal present", () => {
    const state = baseState({ signals: { needs_qa_target: true } });
    const plan = runDecide(state, null);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "qa_target");
    assert.ok(dispatch);
    assert.equal(dispatch.prompt_args.scope, "target");
  });

  test("dispatches dev_target on target_work_available signal", () => {
    const state = baseState({ signals: { target_work_available: true } });
    const plan = runDecide(state, null);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");
    assert.ok(dispatch);
    assert.equal(dispatch.skill, "hydra-target-build");
  });

  test("dispatches research_target on target_research_due signal", () => {
    const state = baseState({ signals: { target_research_due: true } });
    const plan = runDecide(state, null);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
    assert.ok(dispatch);
    assert.equal(dispatch.skill, "hydra-target-research");
  });
});

// ---------------------------------------------------------------------------
// 2. Confidence threshold + research force-dispatch (grilled decision 6)
// ---------------------------------------------------------------------------

describe("decide.py — research force-dispatch when no candidate >= 0.5", () => {
  test("no candidate -> research_orch forced", () => {
    const state = baseState();
    const cands = { candidates: [], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_orch");
    assert.ok(dispatch, "empty candidates must force research_orch");
    assert.equal(dispatch.prompt_args.forced, true);
  });

  test("best score below 0.5 -> research_orch forced", () => {
    const state = baseState();
    const cands = { candidates: [{ issue: 1, anchorRef: "x", score: 0.4 }], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_orch");
    assert.ok(dispatch);
  });

  test("daily research-force cap (4/day) — 4th forced dispatch suppressed", () => {
    const today = new Date().toISOString().slice(0, 10);
    const state = baseState({
      research_force_counter: { [today]: { research_orch: 4 } },
    });
    const cands = { candidates: [], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_orch");
    assert.equal(dispatch, undefined, "force cap must suppress further research_orch dispatches");
  });

  test("needs_research signal triggers research_orch with hydra-issue-research", () => {
    const state = baseState({ signals: { needs_research: true } });
    const cands = { candidates: [{ issue: 1, anchorRef: "x", score: 0.9 }], research_recommended: false };
    const plan = runDecide(state, cands);
    // dev_orch should dispatch on the strong candidate, AND research_orch
    // should dispatch on the needs_research signal — they're separate slots.
    const dev = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    const research = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_orch");
    assert.ok(dev);
    assert.ok(research);
    assert.equal(research.skill, "hydra-issue-research");
  });
});

// ---------------------------------------------------------------------------
// 3. Option C merge policy
// ---------------------------------------------------------------------------

describe("decide.py — Option C merge policy (grilled decision 8)", () => {
  function qaEvent(o: { pr: number; tier: number; mechanical?: boolean | string; sj?: boolean; verdict?: string }): any {
    return {
      type: "qa-verdict",
      pr_number: o.pr,
      tier: o.tier,
      mechanical: o.mechanical ?? null,
      has_scope_justification: o.sj ?? false,
      verdict: o.verdict ?? "PASS",
    };
  }

  test("Tier 1 -> auto-merge", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 100, tier: 1 })]);
    const a = findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 100);
    assert.ok(a);
  });

  test("Tier 2 -> auto-merge", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 101, tier: 2 })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 101));
  });

  test("Tier 3 without scope-justification -> auto-merge", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 102, tier: 3, sj: false })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 102));
  });

  test("Tier 3 WITH scope-justification -> queue-decision", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 103, tier: 3, sj: true })]);
    assert.ok(findAction(plan, (x) => x.type === "queue-decision" && x.pr_number === 103));
    assert.equal(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 103), undefined);
  });

  test("Tier 0 mechanical -> apply-operator-approved", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 200, tier: 0, mechanical: true })]);
    const a = findAction(plan, (x) => x.type === "apply-operator-approved" && x.pr_number === 200);
    assert.ok(a);
    assert.equal(a.mechanical, true);
  });

  test("Tier 0 non-mechanical -> queue-decision (INV-001 enforces)", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 201, tier: 0, mechanical: false })]);
    assert.ok(findAction(plan, (x) => x.type === "queue-decision" && x.pr_number === 201));
    assert.equal(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 201), undefined);
  });

  test("Tier 0 unclear (binary / large) -> queue-decision", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 202, tier: 0, mechanical: "unclear" })]);
    assert.ok(findAction(plan, (x) => x.type === "queue-decision" && x.pr_number === 202));
  });

  test("QA verdict FAIL -> no merge action", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 300, tier: 1, verdict: "FAIL" })]);
    assert.equal(findAction(plan, (x) => x.pr_number === 300), undefined, "FAIL verdict must not produce any merge action");
  });

  test("QA verdict PENDING -> no merge action (INV-007 guard)", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 301, tier: 2, verdict: "PENDING" })]);
    assert.equal(findAction(plan, (x) => x.pr_number === 301), undefined);
  });
});

// ---------------------------------------------------------------------------
// 4. Scope filter (exclusion mask, INV-008)
// ---------------------------------------------------------------------------

describe("decide.py — scope filter exclusion mask (INV-008)", () => {
  test("orch-only scope drops dev_target / research_target / qa_target/sweep_target/discover_target", () => {
    const state = baseState({
      scope: "orch-only",
      signals: {
        target_work_available: true,
        target_research_due: true,
        needs_qa_target: true,
        needs_triage_target: true,
        target_idle: true,
      },
    });
    const plan = runDecide(state, null);
    const types = (plan.actions ?? []).map((a: any) => a.slot ?? null);
    assert.equal(types.includes("dev_target"), false);
    assert.equal(types.includes("research_target"), false);
    assert.equal(types.includes("qa_target"), false);
    assert.equal(types.includes("sweep_target"), false);
    assert.equal(types.includes("discover_target"), false);
  });

  test("target-only scope drops dev_orch / research_orch / qa_orch/sweep_orch/discover_orch", () => {
    const state = baseState({
      scope: "target-only",
      signals: {
        needs_qa_orch: true,
        needs_research: true,
        needs_triage_orch: true,
        orch_idle: true,
      },
    });
    const cands = { candidates: [{ issue: 1, anchorRef: "x", score: 0.95 }] };
    const plan = runDecide(state, cands);
    const types = (plan.actions ?? []).map((a: any) => a.slot ?? null);
    assert.equal(types.includes("dev_orch"), false);
    assert.equal(types.includes("research_orch"), false);
    assert.equal(types.includes("qa_orch"), false);
    assert.equal(types.includes("sweep_orch"), false);
    assert.equal(types.includes("discover_orch"), false);
  });

  test("health is scope-agnostic — always allowed", () => {
    const state = baseState({ scope: "target-only", signals: { health_fail: true } });
    const plan = runDecide(state, null);
    assert.ok(findAction(plan, (a) => a.type === "dispatch" && a.slot === "health"));
  });

  test("scope=all is the identity filter", () => {
    const state = baseState({
      scope: "all",
      signals: { needs_qa_orch: true, target_work_available: true },
    });
    const plan = runDecide(state, null);
    const slots = (plan.actions ?? []).map((a: any) => a.slot);
    assert.ok(slots.includes("qa_orch"));
    assert.ok(slots.includes("dev_target"));
  });
});

// ---------------------------------------------------------------------------
// 5. Completion reap + INV-006 ordering
// ---------------------------------------------------------------------------

describe("decide.py — completion reap ordering (INV-006)", () => {
  test("reap action emitted for completion event", () => {
    const state = baseState({
      slots: {
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0 },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
    });
    const events = [{
      type: "completion",
      slot: "dev_orch",
      task_id: "task-X",
      total_tokens: 50_000,
      skill: "hydra-dev",
    }];
    const plan = runDecide(state, null, events);
    const reap = findAction(plan, (a) => a.type === "reap" && a.task_id === "task-X");
    assert.ok(reap);
    assert.equal(reap.slot, "dev_orch");
    assert.equal(reap.total_tokens, 50_000);
  });

  test("reap precedes dispatch (INV-006) in the same plan", () => {
    const state = baseState({
      slots: {
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0 },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
      signals: { needs_qa_orch: true },
    });
    const events = [{ type: "completion", slot: "dev_orch", task_id: "t-1", total_tokens: 10_000, skill: "hydra-dev" }];
    const plan = runDecide(state, null, events);
    const types = actionTypes(plan);
    const firstReap = types.indexOf("reap");
    const firstDispatch = types.indexOf("dispatch");
    assert.ok(firstReap !== -1, "expected at least one reap");
    assert.ok(firstDispatch !== -1, "expected at least one dispatch");
    assert.ok(firstReap < firstDispatch, `reap (${firstReap}) must precede dispatch (${firstDispatch}) per INV-006`);
  });

  // -------------------------------------------------------------------------
  // Signal-class completion reap (issue #432)
  // -------------------------------------------------------------------------
  //
  // Motivating observation (autopilot run 2026-05-15T17:57Z): two
  // signal-driven dispatches (discover_orch task aa6ce268f0b849876 and
  // sweep_orch task a0d9717fb4681215c) ran to completion and emitted
  // task-notifications, but the final state.json showed
  // `cumulative_tokens: 0` and `reaped_task_ids: []`. The reap path was
  // silently skipped for signal-class completions because the playbook /
  // model treated reap as pipeline-only (signal classes have no slot to
  // clear in state.slots, so the mental model was "nothing to reap").
  //
  // decide.py's reap-emission MUST fire for every completion event,
  // regardless of whether the class is one of the 6 PIPELINE_SLOTS or
  // one of the 5 SIGNAL_CLASSES. These tests pin that contract so the
  // bug cannot silently regress when the model is refactored.

  test("ISSUE-432: reap action emitted for discover_orch (signal) completion", () => {
    // Reproduces the failing case from 2026-05-15T17:57Z exactly:
    // a signal-driven dispatch completes and reports tokens. decide.py
    // must emit a reap action so reap.py increments cumulative_tokens
    // and appends the task_id to reaped_task_ids.
    const state = baseState();
    const events = [{
      type: "completion",
      slot: "discover_orch",
      task_id: "aa6ce268f0b849876",
      total_tokens: 42_500,
      skill: "hydra-discover",
    }];
    const plan = runDecide(state, null, events);
    const reap = findAction(plan, (a) => a.type === "reap" && a.task_id === "aa6ce268f0b849876");
    assert.ok(reap, "decide.py MUST emit a reap action for signal-class completion (#432)");
    assert.equal(reap.slot, "discover_orch", "reap action must carry the signal class as its slot");
    assert.equal(reap.total_tokens, 42_500);
    assert.equal(reap.skill, "hydra-discover");
  });

  test("ISSUE-432: reap action emitted for sweep_orch (signal) completion", () => {
    // Second motivating task from the same run — pin both, not just one,
    // so a partial regression (e.g. a hardcoded class allowlist) is caught.
    const state = baseState();
    const events = [{
      type: "completion",
      slot: "sweep_orch",
      task_id: "a0d9717fb4681215c",
      total_tokens: 18_200,
      skill: "hydra-sweep",
    }];
    const plan = runDecide(state, null, events);
    const reap = findAction(plan, (a) => a.type === "reap" && a.task_id === "a0d9717fb4681215c");
    assert.ok(reap, "decide.py MUST emit a reap action for sweep_orch completion (#432)");
    assert.equal(reap.slot, "sweep_orch");
    assert.equal(reap.total_tokens, 18_200);
  });

  test("ISSUE-432: reap fires for every signal class (parametric)", () => {
    // Parameterised across all 5 signal classes — protects against a
    // future refactor that hardcodes the pipeline subset.
    const SIGNAL_CLASSES = [
      "health", "sweep_orch", "sweep_target", "discover_orch", "discover_target",
    ];
    for (const cls of SIGNAL_CLASSES) {
      const events = [{
        type: "completion",
        slot: cls,
        task_id: `task-${cls}`,
        total_tokens: 1_000,
        skill: "test-skill",
      }];
      const plan = runDecide(baseState(), null, events);
      const reap = findAction(plan, (a) => a.type === "reap" && a.task_id === `task-${cls}`);
      assert.ok(reap, `decide.py MUST emit a reap for signal class ${cls!} completion`);
      assert.equal(reap.slot, cls);
    }
  });

  test("ISSUE-432: reap fires when completion event uses `class` field instead of `slot`", () => {
    // decide.py accepts `slot` OR `class` for the class field — pin both
    // wire-formats so a caller emitting `class` (semantically natural for
    // signal classes) doesn't silently lose its completion.
    const events = [{
      type: "completion",
      class: "discover_target",       // ← `class`, not `slot`
      task_id: "task-class-key",
      total_tokens: 5_000,
      skill: "hydra-target-discover",
    }];
    const plan = runDecide(baseState(), null, events);
    const reap = findAction(plan, (a) => a.type === "reap" && a.task_id === "task-class-key");
    assert.ok(reap, "decide.py must accept `class` as a synonym of `slot` on completion events");
    assert.equal(reap.slot, "discover_target");
  });

  test("ISSUE-432: pipeline + signal completions in the same tick BOTH produce reap actions", () => {
    // The realistic case during a busy autopilot tick: one pipeline
    // subagent and one signal subagent finish together. Both must reap.
    const state = baseState({
      slots: {
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0 },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
    });
    const events = [
      { type: "completion", slot: "dev_orch", task_id: "pipe-1", total_tokens: 50_000, skill: "hydra-dev" },
      { type: "completion", slot: "discover_orch", task_id: "sig-1", total_tokens: 30_000, skill: "hydra-discover" },
    ];
    const plan = runDecide(state, null, events);
    const reapPipe = findAction(plan, (a) => a.type === "reap" && a.task_id === "pipe-1");
    const reapSig = findAction(plan, (a) => a.type === "reap" && a.task_id === "sig-1");
    assert.ok(reapPipe, "pipeline completion must produce a reap");
    assert.ok(reapSig, "signal completion in the same tick must ALSO produce a reap");
    assert.equal(reapPipe.slot, "dev_orch");
    assert.equal(reapSig.slot, "discover_orch");
  });

  test("ISSUE-432: signal class in burned_classes is NOT re-dispatched", () => {
    // Latent bug spotted while fixing #432: the signal-class dispatch
    // loop in decide.py didn't check `burned_classes`. After reap.py
    // burns a signal class on a soft-cap trip, the next tick would
    // happily re-dispatch the runaway. This test pins the suppression.
    const state = baseState({
      burned_classes: ["discover_orch"],
      signals: { orch_idle: true },     // would trigger discover_orch
    });
    const plan = runDecide(state, null);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "discover_orch");
    assert.equal(dispatch, undefined, "burned signal class must not be re-dispatched");
  });
});

// ---------------------------------------------------------------------------
// 6. Termination
// ---------------------------------------------------------------------------

describe("decide.py — termination paths", () => {
  test("budget exhausted -> terminate(cause=budget)", () => {
    const state = baseState({ cumulative_tokens: 2_000_001 });
    const plan = runDecide(state, null);
    const t = findAction(plan, (a) => a.type === "terminate");
    assert.ok(t);
    assert.equal(t.cause, "budget");
  });

  test("wall_clock exceeded -> terminate(cause=wall_clock)", () => {
    const state = baseState({
      started_epoch: Math.floor(Date.now() / 1000) - 100,
      wall_clock_max_sec: 60,
    });
    const plan = runDecide(state, null);
    const t = findAction(plan, (a) => a.type === "terminate");
    assert.ok(t);
    assert.equal(t.cause, "wall_clock");
  });

  test("idle drain with all slots empty -> terminate(cause=idle)", () => {
    const state = baseState({ idle_turns: 5, idle_drain_turns: 5 });
    const plan = runDecide(state, null);
    const t = findAction(plan, (a) => a.type === "terminate");
    assert.ok(t);
    assert.equal(t.cause, "idle");
  });

  test("idle drain DOES NOT trip when a slot is occupied", () => {
    const state = baseState({
      idle_turns: 5,
      slots: {
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0 },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
    });
    const plan = runDecide(state, null);
    assert.equal(findAction(plan, (a) => a.type === "terminate"), undefined);
  });

  test("5 consecutive failures of same pattern -> failure_backstop terminate", () => {
    const state = baseState({
      failure_log: Array.from({ length: 5 }, () => ({
        pattern: "verification-failure",
        ts: Date.now() / 1000,
        slot: "dev_orch",
        cue: "tests failed",
      })),
    });
    const plan = runDecide(state, null);
    const t = findAction(plan, (a) => a.type === "terminate");
    assert.ok(t);
    assert.equal(t.cause, "failure_backstop");
    assert.match(t.reason, /verification-failure/);
  });

  test("after terminate is emitted, no other actions follow", () => {
    const state = baseState({ cumulative_tokens: 5_000_000 });
    const cands = { candidates: [{ issue: 1, anchorRef: "x", score: 0.9 }] };
    const plan = runDecide(state, cands);
    assert.equal(plan.actions.length, 1, "terminate must be the only action when budget is blown");
    assert.equal(plan.actions[0].type, "terminate");
  });
});

// ---------------------------------------------------------------------------
// 7. Signal classes (cooldowns)
// ---------------------------------------------------------------------------

describe("decide.py — signal classes with cooldowns", () => {
  test("health fires on health_fail signal", () => {
    const state = baseState({ signals: { health_fail: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "health");
    assert.ok(a);
    assert.equal(a.skill, "hydra-doctor");
  });

  test("sweep_orch fires on needs_triage_orch signal when cooled", () => {
    const state = baseState({ signals: { needs_triage_orch: true } });
    const plan = runDecide(state, null);
    assert.ok(findAction(plan, (a) => a.type === "dispatch" && a.slot === "sweep_orch"));
  });

  test("sweep_orch suppressed when recently fired (within cooldown)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { needs_triage_orch: true },
      signal_last_fired: { health: 0, sweep_orch: now - 60, sweep_target: 0, discover_orch: 0, discover_target: 0 },
    });
    const plan = runDecide(state, null);
    assert.equal(findAction(plan, (a) => a.type === "dispatch" && a.slot === "sweep_orch"), undefined,
      "60s ago is within the 900s sweep cooldown");
  });

  test("discover_target fires on target_idle when cooled", () => {
    const state = baseState({ signals: { target_idle: true } });
    const plan = runDecide(state, null);
    assert.ok(findAction(plan, (a) => a.type === "dispatch" && a.slot === "discover_target"));
  });
});

// ---------------------------------------------------------------------------
// 8. Idle fallback / heartbeat wait
// ---------------------------------------------------------------------------

describe("decide.py — idle fallback / heartbeat", () => {
  test("nothing to do, all slots empty -> wait(900) heartbeat", () => {
    const plan = runDecide(baseState(), null);
    const w = findAction(plan, (a) => a.type === "wait");
    assert.ok(w);
    assert.equal(w.seconds, 900);
  });

  test("nothing new to dispatch but slot busy -> short busy-wait nap", () => {
    const state = baseState({
      slots: {
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 100_000 },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
    });
    const plan = runDecide(state, null);
    const w = findAction(plan, (a) => a.type === "wait");
    assert.ok(w);
    assert.equal(w.seconds, 60);
  });
});

// ---------------------------------------------------------------------------
// 9. Plan shape contract
// ---------------------------------------------------------------------------

describe("decide.py — plan shape contract", () => {
  test("plan JSON has actions + reasons + debug fields", () => {
    const plan = runDecide(baseState(), null);
    assert.ok(Array.isArray(plan.actions), "plan.actions must be an array");
    assert.ok(Array.isArray(plan.reasons), "plan.reasons must be an array");
    assert.ok(plan.debug && typeof plan.debug === "object", "plan.debug must be an object");
  });

  test("every action carries the expected `type` literal", () => {
    const VALID = new Set([
      "dispatch", "queue-decision", "auto-merge", "apply-operator-approved",
      "update-branch", "reap", "terminate", "wait", "wait-for-api",
    ]);
    const plans = [
      runDecide(baseState({ cumulative_tokens: 5_000_000 })),                                  // terminate
      runDecide(baseState({ signals: { needs_qa_orch: true } })),                              // dispatch
      runDecide(baseState(), { candidates: [{ issue: 1, anchorRef: "x", score: 0.9 }] }),      // dispatch
      runDecide(baseState(), null, [{                                                          // auto-merge
        type: "qa-verdict", pr_number: 1, tier: 1, verdict: "PASS",
      }]),
      runDecide(baseState(), null, [{                                                          // queue-decision
        type: "qa-verdict", pr_number: 2, tier: 0, mechanical: false, verdict: "PASS",
      }]),
    ];
    for (const plan of plans) {
      for (const a of plan.actions ?? []) {
        assert.ok(VALID.has(a.type), `unexpected action type: ${a.type}`);
      }
    }
  });

  test("smoke subcommand prints action catalog", () => {
    const r = spawnSync("python3", [DECIDE, "smoke"], { encoding: "utf-8" });
    assert.equal(r.status, 0);
    const firstLine = JSON.parse((r.stdout.split("\n")[0] ?? "{}"));
    assert.deepEqual(firstLine.pipeline_slots.sort(), [
      "dev_orch", "dev_target", "qa_orch", "qa_target", "research_orch", "research_target",
    ]);
    assert.equal(firstLine.action_types.length, 9, "exactly 9 action types per AC");
  });
});

// ---------------------------------------------------------------------------
// 10. should_auto_merge (direct policy table)
//     Exposed indirectly through qa-verdict events. These tests pin the
//     exact table from the merge-policy docstring.
// ---------------------------------------------------------------------------

describe("decide.py — should_auto_merge() policy table", () => {
  function qaEvent(o: { pr: number; tier: number | string; mechanical?: any; sj?: boolean; verdict?: string }): any {
    return {
      type: "qa-verdict",
      pr_number: o.pr,
      tier: o.tier,
      mechanical: o.mechanical ?? null,
      has_scope_justification: o.sj ?? false,
      verdict: o.verdict ?? "PASS",
    };
  }

  test("unknown tier -> queue-decision (conservative)", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 999, tier: "weird" })]);
    assert.ok(findAction(plan, (a) => a.type === "queue-decision" && a.pr_number === 999));
  });

  test("multiple qa-verdict events in one tick each produce a merge action", () => {
    const events = [
      qaEvent({ pr: 1, tier: 1 }),
      qaEvent({ pr: 2, tier: 2 }),
      qaEvent({ pr: 3, tier: 0, mechanical: true }),
    ];
    const plan = runDecide(baseState(), null, events);
    assert.ok(findAction(plan, (a) => a.type === "auto-merge" && a.pr_number === 1));
    assert.ok(findAction(plan, (a) => a.type === "auto-merge" && a.pr_number === 2));
    assert.ok(findAction(plan, (a) => a.type === "apply-operator-approved" && a.pr_number === 3));
  });
});
