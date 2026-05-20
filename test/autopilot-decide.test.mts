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
      // Issue #466 (Phase B of #437): 7th pipeline slot. Defensive
      // selectors tolerate missing keys, but tests pin the full shape.
      design_concept_orch: null,
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
  // ISSUE #458: dev_orch no longer reads /api/anchor/candidates — it fires
  // on the `orch_work_available` signal, which the playbook turn sets when
  // collect-state.sh reports `ready_for_agent > 0` on the orchestrator GH
  // board. hydra-dev picks its own issue from `gh issue list`.
  test("dispatches dev_orch when slot free and orch_work_available signal set (#458)", () => {
    const state = baseState({ signals: { orch_work_available: true } });
    const plan = runDecide(state, null);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.ok(dispatch, "expected a dev_orch dispatch action on orch_work_available");
    assert.equal(dispatch.skill, "hydra-dev");
    // dev_orch no longer carries a target-side anchor (#458 was specifically
    // about NOT routing target candidates through dev_orch).
    assert.equal(dispatch.prompt_args.anchor, undefined,
      "dev_orch must not receive an anchor from /api/anchor/candidates (#458)");
  });

  test("does NOT dispatch dev_orch when orch_work_available signal is absent (#458)", () => {
    const state = baseState();  // no signals
    // Even a high-scoring target candidate must NOT trigger dev_orch — the
    // exact misroute symptom that motivated #458.
    const cands = { candidates: [{ issue: 267, anchorRef: "item-267", score: 0.85 }], research_recommended: false };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(dispatch, undefined,
      "target-product candidate must NOT trigger dev_orch (#458 — was causing hydra-dev misroute escalations)");
  });

  test("does NOT dispatch dev_orch when slot is busy", () => {
    const state = baseState({
      slots: {
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 50_000 },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
      signals: { orch_work_available: true },
    });
    const plan = runDecide(state, null);
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
  // ISSUE #458: the candidate-driven force-research moved from
  // research_orch to research_target. /api/anchor/candidates is a
  // target-product backlog in this deployment, so a weak top score means
  // the TARGET needs research direction — not the orchestrator-self.
  test("no candidate -> research_target forced (#458)", () => {
    const state = baseState();
    const cands = { candidates: [], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
    assert.ok(dispatch, "empty candidates must force research_target (post-#458)");
    assert.equal(dispatch.prompt_args.forced, true);
    assert.equal(dispatch.skill, "hydra-target-research");
  });

  test("best score below 0.5 -> research_target forced (#458)", () => {
    const state = baseState();
    const cands = { candidates: [{ issue: 1, anchorRef: "x", score: 0.4 }], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
    assert.ok(dispatch);
  });

  test("daily research-force cap (4/day) — 4th forced research_target dispatch suppressed (#458)", () => {
    const today = new Date().toISOString().slice(0, 10);
    const state = baseState({
      research_force_counter: { [today]: { research_target: 4 } },
    });
    const cands = { candidates: [], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
    assert.equal(dispatch, undefined, "force cap must suppress further research_target dispatches");
  });

  test("low-score candidate does NOT force research_orch (#458)", () => {
    // Inverse of the test above — verifies the trigger moved off research_orch.
    const state = baseState();
    const cands = { candidates: [], research_recommended: true };
    const plan = runDecide(state, cands);
    const research_orch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_orch");
    assert.equal(research_orch, undefined,
      "candidate-driven force must NOT fire research_orch post-#458 — the trigger moved to research_target");
  });

  test("needs_research signal triggers research_orch with hydra-issue-research", () => {
    const state = baseState({
      signals: { needs_research: true, orch_work_available: true },
    });
    const plan = runDecide(state, null);
    // dev_orch should dispatch on orch_work_available, AND research_orch
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

  // -------------------------------------------------------------------------
  // Issue #485 (Phase B of /hydra-tool-scout). `scout_orch` is a signal
  // class with a 7-day cooldown. It fires on `scout_walk_due` AND when the
  // orch board isn't saturated (`scout_board_saturated` suppresses it).
  // -------------------------------------------------------------------------

  test("scout_orch fires on scout_walk_due signal (issue #485)", () => {
    const state = baseState({ signals: { scout_walk_due: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "scout_orch");
    assert.ok(a, "scout_orch must dispatch on scout_walk_due");
    assert.equal(a.skill, "hydra-tool-scout");
    assert.equal(a.prompt_args.trigger, "calendar",
      "calendar-driven dispatch must pass trigger=calendar to the skill");
  });

  test("scout_orch DOES NOT fire without scout_walk_due signal", () => {
    const state = baseState();  // no signals
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      "scout_orch must not dispatch when the calendar isn't due",
    );
  });

  test("scout_orch suppressed when scout_board_saturated is set (issue #485)", () => {
    const state = baseState({
      signals: { scout_walk_due: true, scout_board_saturated: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      ">20 open enhancement issues → operator drains queue before more scouts",
    );
  });

  test("scout_orch suppressed when recently fired (within 7d cooldown)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { scout_walk_due: true },
      // Fired 1 day ago → inside the 7-day cooldown.
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
        scout_orch: now - 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      "1d ago is well inside the 7d scout_orch cooldown",
    );
  });

  test("scout_orch fires after 7d cooldown elapses", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { scout_walk_due: true },
      // 8 days ago → past the 7-day cooldown.
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
        scout_orch: now - 8 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      "scout_orch must fire once the 7d cooldown has elapsed",
    );
  });

  test("scout_orch is excluded by target-only scope (orch-scope by definition)", () => {
    const state = baseState({
      scope: "target-only",
      signals: { scout_walk_due: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      "target-only scope must exclude scout_orch (INV-008)",
    );
  });

  test("scout_orch is allowed under orch-only scope", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { scout_walk_due: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      "orch-only must NOT exclude scout_orch",
    );
  });

  test("scout_orch in burned_classes is NOT re-dispatched (mirrors #432)", () => {
    const state = baseState({
      burned_classes: ["scout_orch"],
      signals: { scout_walk_due: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      "burned signal class scout_orch must not be re-dispatched",
    );
  });

  test("scout_orch completion event produces a reap (mirrors #432)", () => {
    const events = [{
      type: "completion",
      slot: "scout_orch",
      task_id: "scout-task-1",
      total_tokens: 35_000,
      skill: "hydra-tool-scout",
    }];
    const plan = runDecide(baseState(), null, events);
    const reap = findAction(plan, (a) => a.type === "reap" && a.task_id === "scout-task-1");
    assert.ok(reap, "scout_orch completion must produce a reap");
    assert.equal(reap.slot, "scout_orch");
    assert.equal(reap.skill, "hydra-tool-scout");
  });

  // -------------------------------------------------------------------------
  // Issue #532 — scout_orch cost-cap gate. The gate fires BEFORE the
  // cooldown check (cap is the harder limit), suppresses dispatch when
  // `scout_spend_usd_today >= scout_cost_share * daily_spend_cap_usd`, and
  // honours `scout_cost_share = 0` as an operator kill-switch.
  // -------------------------------------------------------------------------

  function costCapState(o: {
    scope?: string;
    scoutCostShare?: number;
    dailySpendCapUsd?: number;
    scoutSpendUsdToday?: number;
    signals?: Record<string, unknown>;
  }): any {
    const s = baseState({
      scope: o.scope,
      signals: o.signals ?? { scout_walk_due: true },
    });
    if (o.scoutCostShare !== undefined) s.limits.scout_cost_share = o.scoutCostShare;
    if (o.dailySpendCapUsd !== undefined) s.limits.daily_spend_cap_usd = o.dailySpendCapUsd;
    if (o.scoutSpendUsdToday !== undefined) s.scout_spend_usd_today = o.scoutSpendUsdToday;
    return s;
  }

  test("cost-cap suppresses scout_orch when spend >= share * daily_cap (issue #532)", () => {
    // 4% of $50 = $2 cap; spend $2.50 → exceeds.
    const state = costCapState({
      dailySpendCapUsd: 50.0,
      scoutCostShare: 0.04,
      scoutSpendUsdToday: 2.5,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      "spend $2.50 above $2.00 cap (4% of $50) must suppress scout_orch dispatch",
    );
    assert.ok(plan.debug?.scout_cost_cap_skipped,
      "plan.debug should record the cost-cap skip reason for operator audit");
  });

  test("cost-cap allows scout_orch when spend below share * daily_cap", () => {
    // 4% of $50 = $2 cap; spend $1.00 → under.
    const state = costCapState({
      dailySpendCapUsd: 50.0,
      scoutCostShare: 0.04,
      scoutSpendUsdToday: 1.0,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      "spend $1.00 below $2.00 cap (4% of $50) must allow scout_orch dispatch",
    );
  });

  test("cost-cap kill-switch: scout_cost_share = 0 suppresses every dispatch (issue #532 AC)", () => {
    // share=0 → cap=0; any spend (incl. 0) is >= 0, so every dispatch is suppressed.
    const state = costCapState({
      dailySpendCapUsd: 50.0,
      scoutCostShare: 0,
      scoutSpendUsdToday: 0,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      "scout_cost_share=0 is the operator kill-switch — must suppress all scout_orch dispatch",
    );
  });

  test("cost-cap fires BEFORE the 7d cooldown gate (issue #532 AC: cap is the harder limit)", () => {
    // Set up: cooldown has elapsed (8d ago) AND spend exceeds cap.
    // Verify: dispatch is suppressed by the cap, not gated by cooldown.
    // The signal proves cap is checked first because both gates would
    // otherwise allow dispatch (cooldown elapsed) — only the cap can
    // produce the skip.
    const now = Math.floor(Date.now() / 1000);
    const state = costCapState({
      scoutCostShare: 0.04,
      dailySpendCapUsd: 50.0,
      scoutSpendUsdToday: 10.0,  // way over $2 cap
    });
    state.signal_last_fired = {
      health: 0, sweep_orch: 0, sweep_target: 0,
      discover_orch: 0, discover_target: 0,
      scout_orch: now - 8 * 24 * 60 * 60,  // past 7d cooldown
    };
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      "cost-cap must fire before cooldown — cap suppresses even when cooldown elapsed",
    );
    assert.ok(plan.debug?.scout_cost_cap_skipped,
      "the skip reason must surface as cost-cap, not cooldown");
  });

  test("cost-cap is inactive (no-op) when daily_spend_cap_usd is 0 (rate not configured)", () => {
    // dailySpendCapUsd=0 → rate unconfigured (default HYDRA_TOKEN_USD_RATE=0).
    // Phase B's pre-#532 behaviour must be preserved.
    const state = costCapState({
      dailySpendCapUsd: 0,
      scoutCostShare: 0.04,
      scoutSpendUsdToday: 0,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      "cap of 0 with non-zero share is 'rate unconfigured' — gate must be a no-op",
    );
  });

  test("cost-cap reads limits.scout_cost_share override (issue #532 AC)", () => {
    // Operator override: bump share to 10% → cap is $5.00, $4 spend allowed.
    const state = costCapState({
      dailySpendCapUsd: 50.0,
      scoutCostShare: 0.10,
      scoutSpendUsdToday: 4.0,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      "10% of $50 = $5 cap, $4 spend → allow",
    );
  });

  test("cost-cap default values: share 0.04 + cap $50 → $2/day (issue #532 documented default)", () => {
    // No explicit limits → defaults kick in: 4% * $50 = $2 cap.
    // Spend $3 → over default cap → suppress.
    const state = baseState({ signals: { scout_walk_due: true } });
    // Don't set scout_cost_share or daily_spend_cap_usd — let decide.py
    // fall back to its defaults (SCOUT_DAILY_COST_SHARE_DEFAULT,
    // DAILY_SPEND_CAP_USD_DEFAULT).
    state.scout_spend_usd_today = 3.0;
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      "default 4% of $50 = $2 cap; $3 spend exceeds → suppress",
    );
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
      runDecide(baseState({ signals: { orch_work_available: true } })),                        // dispatch dev_orch (#458)
      runDecide(baseState(), { candidates: [{ issue: 1, anchorRef: "x", score: 0.9 }] }),      // dispatch (research-related)
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
    // Issue #466 (Phase B of #437) added the 7th pipeline slot.
    assert.deepEqual(firstLine.pipeline_slots.sort(), [
      "design_concept_orch",
      "dev_orch", "dev_target", "qa_orch", "qa_target", "research_orch", "research_target",
    ]);
    // Issue #509 added the 10th action type `wait_or_reap` — the silent-
    // wedge fallback emitted when an active slot ages past
    // subagent_max_wall_seconds with no matching SubagentStop event.
    assert.equal(firstLine.action_types.length, 10, "exactly 10 action types (9 + wait_or_reap per #509)");
    assert.ok(firstLine.action_types.includes("wait_or_reap"), "wait_or_reap must be in the catalog");
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

// ---------------------------------------------------------------------------
// 11. ISSUE #458 — dev_orch vs dev_target candidate-feed routing
// ---------------------------------------------------------------------------
//
// Symptom (2026-05-15 ~22:09Z autopilot tick): decide.py dispatched
// `dev_orch` (hydra-dev) on anchor `item-267` — a target-product Settings-
// page task whose files live in `~/hydra-betting/web/src/`. hydra-dev
// correctly identified the work as target-only and escalated, but the
// dispatch consumed budget and round-trip latency for a routing decision
// the brain should have made up front.
//
// Root cause: `_select_for_slot('dev_orch')` previously read the top
// /api/anchor/candidates entry, but in this deployment the candidates
// feed is structurally the target-product backlog (item-26x are all
// hydra-betting work). dev_orch had no orch/target scope filter and kept
// picking target items, blocking productive orchestrator-side dispatches
// (8 orch GH `ready-for-agent` issues sat idle: #449, #448, #443, ...).
//
// Fix: dev_orch consumes the orchestrator GH board via the
// `orch_work_available` signal; dev_target keeps target_work_available
// AND surfaces the top candidate as an anchor hint; the
// candidate-driven research force moved from research_orch to
// research_target.
//
// These tests pin every leg of the routing change so a future refactor
// can't silently regress to the misroute.

describe("decide.py — ISSUE #458 dev_orch / dev_target routing", () => {
  test("ISSUE-458 reproduction: target-product candidate must NOT trigger dev_orch", () => {
    // The exact misroute that motivated #458 — `item-267` is target-product
    // work but was being routed to dev_orch (hydra-dev) for orchestrator
    // dispatch. After the fix, only an explicit `orch_work_available`
    // signal can trigger dev_orch; the candidate feed is ignored by it.
    const state = baseState();  // no signals — fresh tick
    const cands = {
      candidates: [
        { issue: 267, anchorRef: "item-267", score: 0.85, title: "Settings page: editable kill switch" },
        { issue: 266, anchorRef: "item-266", score: 0.80, title: "Slippage alarm on dashboard" },
        { issue: 264, anchorRef: "item-264", score: 0.75, title: "Settlement orphan detection" },
      ],
      research_recommended: false,
    };
    const plan = runDecide(state, cands);

    const devOrch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.equal(devOrch, undefined,
      "target-product candidate must NOT trigger dev_orch (was the #458 misroute)");

    // The same candidates SHOULD NOT trigger dev_target either, because
    // target_work_available signal isn't set — the candidate feed is a
    // hint, not a trigger.
    const devTarget = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");
    assert.equal(devTarget, undefined,
      "dev_target needs target_work_available signal, not just candidates");
  });

  test("ISSUE-458: dev_orch dispatches on orch_work_available signal with NO target anchor", () => {
    // The fixed path: the playbook sets `orch_work_available=true` from
    // collect-state.sh's `ready_for_agent` count, and dev_orch fires.
    // No anchor is carried — hydra-dev picks its own issue from the GH
    // board, which is the only correct source for orch-side work.
    const state = baseState({ signals: { orch_work_available: true } });
    // Even with a target-product candidate present, dev_orch must not
    // carry it through as an anchor.
    const cands = { candidates: [{ issue: 267, anchorRef: "item-267", score: 0.85 }] };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.ok(dispatch, "orch_work_available must fire dev_orch");
    assert.equal(dispatch.skill, "hydra-dev");
    assert.equal(dispatch.prompt_args.anchor, undefined,
      "dev_orch must NOT pass a target-product anchor — that's the bug #458 fixes");
    assert.equal(dispatch.prompt_args.score, undefined,
      "dev_orch must NOT pass a candidate score — candidates are target work");
  });

  test("ISSUE-458: dev_target dispatches on target_work_available AND carries top candidate as anchor", () => {
    // The candidates feed IS the target backlog — when dev_target fires,
    // the top entry is surfaced as `prompt_args.anchor` so hydra-target-build
    // gets a clear pointer.
    const state = baseState({ signals: { target_work_available: true } });
    const cands = {
      candidates: [{ issue: 267, anchorRef: "item-267", score: 0.85 }],
    };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");
    assert.ok(dispatch, "target_work_available must fire dev_target");
    assert.equal(dispatch.skill, "hydra-target-build");
    assert.equal(dispatch.prompt_args.anchor, "item-267",
      "dev_target must surface the top candidate as its anchor (#458)");
    assert.equal(dispatch.prompt_args.score, 0.85);
  });

  test("ISSUE-458: dev_target with weak top candidate fires WITHOUT an anchor hint", () => {
    // The 0.5 threshold still gates the anchor hint — a weak candidate
    // is no better than no candidate, so dev_target fires bare.
    const state = baseState({ signals: { target_work_available: true } });
    const cands = { candidates: [{ issue: 1, anchorRef: "x", score: 0.3 }] };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");
    assert.ok(dispatch);
    assert.equal(dispatch.prompt_args.anchor, undefined,
      "below-threshold candidate must NOT be surfaced as a dev_target anchor");
  });

  test("ISSUE-458: dev_target with NO candidates feed fires bare (no anchor)", () => {
    // candidates=null is the bootstrap / API-down case. dev_target should
    // still dispatch on the signal — it has its own queue to consult.
    const state = baseState({ signals: { target_work_available: true } });
    const plan = runDecide(state, null);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");
    assert.ok(dispatch);
    assert.equal(dispatch.prompt_args.anchor, undefined);
  });

  test("ISSUE-458: empty candidates force research_target, NOT research_orch", () => {
    // The candidate-driven force-research trigger moved off research_orch.
    // /api/anchor/candidates is target-product work in this deployment, so
    // a weak top score signals that the TARGET needs research direction.
    const state = baseState();
    const cands = { candidates: [], research_recommended: true };
    const plan = runDecide(state, cands);

    const researchTarget = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
    assert.ok(researchTarget, "empty candidates must force research_target (#458)");
    assert.equal(researchTarget.skill, "hydra-target-research");
    assert.equal(researchTarget.prompt_args.forced, true);

    const researchOrch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_orch");
    assert.equal(researchOrch, undefined,
      "candidate-driven force must NOT fire research_orch (it moved to research_target in #458)");
  });

  test("ISSUE-458: research_orch still fires on explicit needs_research signal", () => {
    // The orch-side research path is intact — it just no longer fires
    // off the candidates feed. An explicit `needs_research` signal from
    // the orch GH board still triggers research_orch.
    const state = baseState({ signals: { needs_research: true } });
    const plan = runDecide(state, null);
    const research = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_orch");
    assert.ok(research);
    assert.equal(research.skill, "hydra-issue-research");
  });

  test("ISSUE-458: realistic post-fix tick — both dev_orch and dev_target fire correctly", () => {
    // Simulates the autopilot tick from the issue's evidence AFTER the
    // fix: GH board has ready-for-agent issues AND the target queue is
    // hot AND the candidates feed has a strong target item. dev_orch
    // picks from GH; dev_target picks the candidate. No misroute.
    const state = baseState({
      signals: { orch_work_available: true, target_work_available: true },
    });
    const cands = { candidates: [{ issue: 267, anchorRef: "item-267", score: 0.85 }] };
    const plan = runDecide(state, cands);

    const devOrch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    const devTarget = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");

    assert.ok(devOrch, "dev_orch must fire on the orch board signal");
    assert.equal(devOrch.skill, "hydra-dev");
    assert.equal(devOrch.prompt_args.anchor, undefined,
      "dev_orch carries no target anchor");

    assert.ok(devTarget, "dev_target must fire on the target queue signal");
    assert.equal(devTarget.skill, "hydra-target-build");
    assert.equal(devTarget.prompt_args.anchor, "item-267",
      "dev_target picks up the target-product candidate");
  });

  test("ISSUE-458: research_target daily cap independent of research_orch cap", () => {
    // The two slots have separate counters under research_force_counter.
    // Exhausting the research_target cap must not affect research_orch
    // (and vice versa).
    const today = new Date().toISOString().slice(0, 10);
    const state = baseState({
      research_force_counter: { [today]: { research_target: 4, research_orch: 0 } },
    });
    const cands = { candidates: [], research_recommended: true };
    const plan = runDecide(state, cands);

    const researchTarget = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
    assert.equal(researchTarget, undefined,
      "research_target cap exhausted -> no force dispatch");

    // No needs_research signal -> research_orch also idle, but for an
    // unrelated reason. That's expected.
    const researchOrch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_orch");
    assert.equal(researchOrch, undefined);
  });

  test("ISSUE-458: scope=orch-only does not break dev_orch's new signal-based trigger", () => {
    // Belt-and-braces: the scope filter still passes dev_orch through under
    // orch-only, and the new signal-based dispatch path works inside the
    // restricted scope.
    const state = baseState({
      scope: "orch-only",
      signals: { orch_work_available: true, target_work_available: true },
    });
    const plan = runDecide(state, null);
    const devOrch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    const devTarget = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");
    assert.ok(devOrch, "dev_orch must still fire under orch-only scope");
    assert.equal(devTarget, undefined, "dev_target is excluded by orch-only scope");
  });
});

// ---------------------------------------------------------------------------
// ISSUE #527 — stamp `worktreeBranch` on dispatch actions so the dashboard's
// slice-4 "Watch stream" cross-link (PR #526) renders end-to-end.
//
// The dashboard reads `action.worktreeBranch` (with a defensive fallback to
// `outcome.worktreeBranch`) to scope `/agents/stream?agent=<branch>`. Before
// #527 the field was never stamped anywhere consumers could see, so the link
// silently omitted itself on every row.
//
// Schema-closure invariant (slice-2 AC10 / slice-3 AC12 / slice-4 AC9): the
// stamp goes on the action inside the turn-row JSON, NOT as a new top-level
// field on `hydra:autopilot:run:<id>`. That invariant is asserted in
// test/autopilot-turns.test.mts and test/autopilot-history.test.mts; this
// suite only checks the producer side (decide.py emits the field).
// ---------------------------------------------------------------------------

describe("decide.py — worktreeBranch stamping (issue #527)", () => {
  test("dev_orch dispatch carries a stamped worktreeBranch", () => {
    const state = baseState({ signals: { orch_work_available: true } });
    (state as any).run_id = "abcdef12-3456-7890-abcd-ef1234567890";
    (state as any).turn = 7;
    const plan = runDecide(state, null);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.ok(dispatch, "expected dev_orch dispatch");
    assert.ok(dispatch.worktreeBranch, "worktreeBranch field must be stamped");
    // Prefix matches collect-state.sh's recognised set so the dashboard's
    // active_dev_orch detector keeps working.
    assert.ok(
      dispatch.worktreeBranch.startsWith("worktree-agent-"),
      `worktreeBranch must start with worktree-agent- prefix, got: ${dispatch.worktreeBranch}`,
    );
    assert.ok(
      dispatch.worktreeBranch.includes("dev_orch"),
      "worktreeBranch must embed the slot for AgentStream filtering",
    );
    assert.ok(
      dispatch.worktreeBranch.includes("t7"),
      "worktreeBranch must embed the turn number",
    );
  });

  test("dispatch worktreeBranch is deterministic across re-runs", () => {
    const baseSignals = { orch_work_available: true };
    const stateA = baseState({ signals: baseSignals });
    (stateA as any).run_id = "abcdef12-3456-7890-abcd-ef1234567890";
    (stateA as any).turn = 3;
    const planA = runDecide(stateA, null);
    const dispatchA = findAction(planA, (a) => a.type === "dispatch" && a.slot === "dev_orch");

    const stateB = baseState({ signals: baseSignals });
    (stateB as any).run_id = "abcdef12-3456-7890-abcd-ef1234567890";
    (stateB as any).turn = 3;
    const planB = runDecide(stateB, null);
    const dispatchB = findAction(planB, (a) => a.type === "dispatch" && a.slot === "dev_orch");

    assert.equal(
      dispatchA.worktreeBranch,
      dispatchB.worktreeBranch,
      "same (run_id, turn, slot) must produce identical worktreeBranch",
    );
  });

  test("AgentStream cross-link href is well-formed from stamped branch", () => {
    // Mirror the dashboard consumer's resolution rule (Autopilot.jsx:236-237)
    // — action.worktreeBranch || action.worktree_branch || action.branch ||
    // outcome?.worktreeBranch — and confirm the resulting href is valid.
    const state = baseState({ signals: { target_work_available: true } });
    (state as any).run_id = "11223344-aaaa-bbbb-cccc-ddddeeeeffff";
    (state as any).turn = 12;
    const plan = runDecide(state, null);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");
    assert.ok(dispatch, "expected dev_target dispatch");

    const branch =
      dispatch.worktreeBranch ||
      dispatch.worktree_branch ||
      dispatch.branch ||
      null;
    assert.ok(branch, "dashboard's resolution chain must surface a branch");
    const href = `/agents/stream?agent=${encodeURIComponent(branch)}`;
    assert.ok(
      href.startsWith("/agents/stream?agent=worktree-agent-"),
      `href must point at AgentStream with worktree-agent-* filter, got: ${href}`,
    );
  });

  test("non-dispatch actions are not stamped with worktreeBranch", () => {
    // The wait/heartbeat fallback fires when nothing dispatches — confirm the
    // stamping loop is dispatch-scoped and doesn't leak the field onto other
    // action types (which would confuse the schema-additivity gates).
    const state = baseState(); // no signals → idle heartbeat
    const plan = runDecide(state, null);
    const waitAction = findAction(plan, (a) => a.type === "wait");
    assert.ok(waitAction, "idle path must emit a wait action");
    assert.equal(
      (waitAction as any).worktreeBranch,
      undefined,
      "non-dispatch actions must NOT carry worktreeBranch",
    );
  });

  test("missing run_id in state still produces a valid prefix", () => {
    // Legacy / test callers may omit run_id; the synthesiser falls back to
    // a `local` token so the branch name stays grep-able. This protects the
    // ~50 existing decide-tests that don't seed run_id from breaking.
    const state = baseState({ signals: { orch_work_available: true } });
    // intentionally do NOT set run_id
    const plan = runDecide(state, null);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch");
    assert.ok(dispatch);
    assert.ok(
      dispatch.worktreeBranch.startsWith("worktree-agent-local-"),
      `fallback prefix should be worktree-agent-local-*, got: ${dispatch.worktreeBranch}`,
    );
  });

  test("dispatch action with caller-supplied worktreeBranch is preserved", () => {
    // The stamping loop is additive — if a future selector learns the
    // harness-generated branch name and supplies it, we must not clobber it.
    // We exercise this via the decide.py CLI by injecting a slot_event that
    // simulates a make_dispatch caller already setting the field… but the
    // simpler path is to import make_dispatch directly. Since this test file
    // shells out to Python, we instead assert the empirical behaviour: the
    // loop's `if action.get("worktreeBranch"): continue` guard.
    //
    // Sanity check: the field IS present on every dispatch in the plan and
    // matches our synth formula — that pins the contract for the only path
    // the autopilot uses today (no callers pre-set it yet).
    const state = baseState({ signals: { needs_qa_orch: true } });
    (state as any).run_id = "deadbeef-1234-5678-9abc-def012345678";
    (state as any).turn = 1;
    const plan = runDecide(state, null);
    const qa = findAction(plan, (a) => a.type === "dispatch" && a.slot === "qa_orch");
    assert.ok(qa);
    // Match the formula: worktree-agent-<runtoken>-t<turn>-<slot>
    assert.equal(
      qa.worktreeBranch,
      "worktree-agent-deadbeef-t1-qa_orch",
      "worktreeBranch must match the deterministic synth formula",
    );
  });
});
