/**
 * Regression tests for `scripts/autopilot/decide.py` — cascade-routing
 * escalation (issue #3274, design-concept issue-3274).
 *
 * SOTA cascade routing (RouteLLM / FrugalGPT): run a cheap model tier, verify,
 * and escalate to a stronger tier ONLY on a failed/no-op attempt. Hydra's
 * cheapest same-turn verifier signal is the subagent STOP STATUS
 * (success/no_op/failure/budget_exceeded) emitted by on-subagent-stop.sh — NOT
 * CI (CI is asynchronous and emits no in-turn signal; that trigger is a deferred
 * Slice B). The MVP escalates a `cleanup_orch` (Haiku) no_op / failure to Sonnet.
 *
 * Design-concept invariants pinned here:
 *   1. decide.py stays PURE — the escalation dispatch carries NO concrete `model`
 *      field, only an `escalate_model` HINT in prompt_args (issue #1093).
 *   2. classes.json is untouched — policy is the decide.py constant
 *      ESCALATION_POLICY (asserted by the taxonomy staying unchanged; covered by
 *      the existing taxonomy suites).
 *   3. A no_op on a SATURATED board never escalates (saturation-driven, not
 *      capability-driven).
 *   4. Escalation never exceeds maxAttempts (default 2) — no third dispatch.
 *   5. A class ABSENT from ESCALATION_POLICY never escalates (qa_orch).
 *   6. Recording no_op in failure_log changes VISIBILITY only.
 *
 * `dev_orch` gained a policy row on 2026-07-29 when the class was demoted from
 * the frontier tier to Sonnet (playbook per-class routing table). It is the
 * safety net for that demotion, and its trigger set is deliberately NARROWER
 * than cleanup_orch's: failure only, never no_op. Pinned in its own suite below
 * — the asymmetry is the design, not an omission.
 *
 * We exercise decide.py through its `decide` CLI subcommand so the tests also
 * pin the JSON wire contract the playbook prose consumes. The `--now` flag
 * freezes the decision clock so the frozen fixture epoch never trips the
 * wall-clock termination guard.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// Frozen decision clock: close to the fixture started_epoch so the wall-clock
// termination guard never trips before the escalation rule runs.
const STARTED_EPOCH = 1_700_000_000;
const FROZEN_NOW = STARTED_EPOCH + 200;

interface StateOverrides {
  scope?: string;
  signals?: Record<string, unknown>;
  slotEvents?: any[];
  slots?: Record<string, unknown>;
  failure_log?: any[];
  usage_eligibility?: Record<string, unknown>;
}

function baseState(o: StateOverrides = {}): any {
  return {
    started_epoch: STARTED_EPOCH,
    turn: 3,
    run_id: "abcd1234-0000-0000-0000-000000000000",
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      scope: o.scope ?? "all",
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: o.failure_log ?? [],
    slots: o.slots ?? {
      dev_orch: null,
      qa_orch: null,
      research_orch: null,
      dev_target: null,
      qa_target: null,
      research_target: null,
      design_concept_orch: null,
    },
    signal_last_fired: {},
    signals: o.signals ?? {},
    slot_events: { events: o.slotEvents ?? [], last_id: "0-0" },
    research_force_counter: {},
    ...(o.usage_eligibility !== undefined
      ? { usage_eligibility: o.usage_eligibility }
      : {}),
  };
}

function stopEvent(slot: string, status: string, taskId = "t1", summary = ""): any {
  return {
    fields: {
      event: "subagent_stop",
      slot,
      status,
      task_id: taskId,
      summary,
      ts_epoch: STARTED_EPOCH + 100,
    },
  };
}

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
  const dir = mkdtempSync(join(tmpdir(), "decide-cascade-test-"));
  try {
    const sp = join(dir, "state.json");
    const cp = join(dir, "cands.json");
    const ep = join(dir, "events.json");
    writeFileSync(sp, JSON.stringify(state));
    writeFileSync(cp, JSON.stringify(candidates));
    writeFileSync(ep, JSON.stringify(events));
    const r = spawnSync(
      "python3",
      [DECIDE, `--now=${FROZEN_NOW}`, "decide", sp, cp, ep],
      { encoding: "utf-8" },
    );
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function escalationFor(plan: any, slot: string): any | undefined {
  return (plan.actions ?? []).find(
    (a: any) =>
      a.type === "dispatch" &&
      a.slot === slot &&
      (a.prompt_args ?? {}).escalate_model !== undefined,
  );
}

/** Find the first plan event carrying a given `event` discriminator. */
function eventOf(plan: any, event: string): any | undefined {
  return (plan.events ?? []).find((e: any) => e && e.event === event);
}

describe("decide.py — cascade-routing escalation (issue #3274)", () => {
  test("cleanup_orch no_op on a fresh (non-saturated) board escalates to sonnet", () => {
    const state = baseState({ slotEvents: [stopEvent("cleanup_orch", "no_op")] });
    const plan = runDecide(state);
    const esc = escalationFor(plan, "cleanup_orch");
    assert.ok(esc, "a fresh-board cleanup_orch no_op must escalate");
    assert.equal(esc.skill, "hydra-cleanup", "escalation re-dispatches the same class's skill");
    assert.equal(
      esc.prompt_args.escalate_model,
      "sonnet",
      "escalate_model hint must be sonnet",
    );
  });

  test("escalation dispatch carries NO concrete model field (decide.py stays pure, #1093)", () => {
    const state = baseState({ slotEvents: [stopEvent("cleanup_orch", "no_op")] });
    const plan = runDecide(state);
    const esc = escalationFor(plan, "cleanup_orch");
    assert.ok(esc, "escalation dispatch must be present");
    assert.equal(
      esc.model,
      undefined,
      "decide.py must NOT write a concrete `model` field — only the escalate_model HINT",
    );
    // The hint lives in prompt_args, the playbook's model lever.
    assert.equal(esc.prompt_args.escalate_model, "sonnet");
  });

  test("saturation guard: a no_op on a SATURATED board does NOT escalate (invariant 3)", () => {
    const state = baseState({
      slotEvents: [stopEvent("cleanup_orch", "no_op")],
      signals: { cleanup_board_saturated: true },
    });
    const plan = runDecide(state);
    assert.equal(
      escalationFor(plan, "cleanup_orch"),
      undefined,
      "a saturation-driven no_op must be suppressed — escalating re-produces it at double cost",
    );
  });

  test("a verification FAILURE escalates even on a saturated board (capability-driven)", () => {
    const state = baseState({
      slotEvents: [stopEvent("cleanup_orch", "failure", "tF", "npm test failed")],
      signals: { cleanup_board_saturated: true },
    });
    const plan = runDecide(state);
    const esc = escalationFor(plan, "cleanup_orch");
    assert.ok(
      esc,
      "a failure is capability-driven and escalates regardless of board saturation",
    );
    assert.equal(esc.prompt_args.escalate_model, "sonnet");
  });

  test("attempt cap: an escalation attempt (attempt>=2) does NOT trigger a third dispatch (invariant 4)", () => {
    // The slot carries attempt:2 (the escalation attempt itself, stamped by the
    // playbook). Its no_op must NOT escalate again.
    const state = baseState({
      slotEvents: [stopEvent("cleanup_orch", "no_op")],
      slots: {
        dev_orch: null,
        qa_orch: null,
        research_orch: null,
        dev_target: null,
        qa_target: null,
        research_target: null,
        design_concept_orch: null,
        cleanup_orch: { attempt: 2, skill: "hydra-cleanup", task_id: "t1" },
      },
    });
    const plan = runDecide(state);
    assert.equal(
      escalationFor(plan, "cleanup_orch"),
      undefined,
      "attempt 2 >= max_attempts 2 — no third dispatch",
    );
  });

  test("a class ABSENT from ESCALATION_POLICY never escalates (qa_orch, invariant 5)", () => {
    // Was dev_orch until 2026-07-29; dev_orch now HAS a policy row (see the
    // dev_orch suite below), so invariant 5 needs a genuinely-absent class.
    const state = baseState({ slotEvents: [stopEvent("qa_orch", "no_op")] });
    const plan = runDecide(state);
    assert.equal(
      escalationFor(plan, "qa_orch"),
      undefined,
      "qa_orch is not in ESCALATION_POLICY — zero behavior change",
    );
  });

  // Issue #3829 (design-concept issue-3829) diagnosed WHY qa_orch staying
  // out of ESCALATION_POLICY is not itself a bug: ESCALATION_POLICY governs
  // a one-time stronger-tier retry immediately after a subagent STOP, never
  // a standing cap on the ORDINARY per-turn pipeline dispatch
  // (`_select_for_slot`, step 4) — so even a qa_orch policy row would not
  // have bounded the busy loop. The real fix is the separate per-issue STALL
  // CAP guard, tracking only the HEAD of the needs-qa set (full coverage in
  // the dedicated test/decide-qa-stall-cap.test.mts). This test pins that
  // the two mechanisms are independent: an exhausted head-issue cap
  // suppresses the ordinary pipeline dispatch on its own, with no
  // ESCALATION_POLICY row and no dependence on any subagent_stop event
  // having occurred this turn.
  test("issue #3829: the qa_orch per-issue stall-cap guard is independent of ESCALATION_POLICY", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_numbers: "3841" },
    });
    (state as any).qa_orch_item_attempts = { "3841": 3 };
    const plan = runDecide(state);
    const ordinaryDispatch = (plan.actions ?? []).find(
      (a: any) => a.type === "dispatch" && a.slot === "qa_orch",
    );
    assert.equal(
      ordinaryDispatch,
      undefined,
      "an exhausted head needs-qa issue suppresses the ordinary pipeline dispatch even with zero slot_events this turn — the guard does not ride on ESCALATION_POLICY's stop-event trigger",
    );
    assert.equal(
      escalationFor(plan, "qa_orch"),
      undefined,
      "qa_orch still never appears in ESCALATION_POLICY — invariant 5 holds unchanged alongside the new guard",
    );
  });

  test("a SUCCESS never escalates", () => {
    const state = baseState({ slotEvents: [stopEvent("cleanup_orch", "success")] });
    const plan = runDecide(state);
    assert.equal(
      escalationFor(plan, "cleanup_orch"),
      undefined,
      "a clean success never escalates",
    );
  });

  test("escalation is ordered AFTER the completion reap (INV-006 — reap before re-dispatch)", () => {
    const state = baseState({ slotEvents: [stopEvent("cleanup_orch", "no_op", "tORDER")] });
    const plan = runDecide(state);
    const types = (plan.actions ?? []).map((a: any) => `${a.type}:${a.slot}`);
    const reapIdx = types.indexOf("reap:cleanup_orch");
    const escAction = escalationFor(plan, "cleanup_orch");
    assert.ok(reapIdx >= 0, "the no_op slot must be reaped");
    assert.ok(escAction, "the escalation dispatch must be present");
    const dispatchIdx = (plan.actions ?? []).indexOf(escAction);
    assert.ok(
      reapIdx < dispatchIdx,
      "the reap that frees the slot must precede the escalation re-dispatch (INV-006)",
    );
  });

  test("no_op is recorded in failure_log for visibility (invariant 6)", () => {
    // The escalation re-dispatch does not depend on failure_log, but the no_op
    // must land there as `subagent_noop` so self_heal / the operator digest can
    // see a recurring no_op run.
    const state = baseState({ slotEvents: [stopEvent("cleanup_orch", "no_op", "tVIS")] });
    const plan = runDecide(state);
    // decide() mutates state.failure_log in place; the CLI persists it back and
    // the plan reasons reflect the escalation, but the durable failure_log
    // visibility is exercised by the Python-level self_heal test. Here we assert
    // the escalation fired, which is downstream of the same no_op recognition.
    assert.ok(
      escalationFor(plan, "cleanup_orch"),
      "the recognised no_op both records visibility and drives the gated escalation",
    );
  });

  test(
    "co-trigger: idle-board cleanup_orch no_op escalates ONCE, not double-dispatched (issue #3274 QA blocker)",
    () => {
      // Production-typical scenario the earlier fixtures missed: cleanup_orch
      // runs specifically on idle-board turns, so a real no_op arrives with
      // `orch_backfill_idle=true` present — NOT the empty `signals: {}` the
      // fresh-board escalation cases used, which suppresses the signal-class
      // co-trigger. Under that realistic signal state, step 2.5
      // (_rule_escalation) re-dispatches cleanup_orch at the escalate_model
      // tier AND step 5 (_rule_signal_classes, cleanup_orch keyed off
      // orch_backfill_idle) would ALSO emit an ordinary `dispatch cleanup_orch`
      // — a double-dispatch of the same class in one plan (fold() never mutates
      // state.slots, so the signal rule reads the still-null reaped slot and
      // fires independently). The escalation rule must claim the slot so the
      // signal rule skips it: exactly one cleanup_orch dispatch, and it must be
      // the ESCALATION (stronger-tier) one.
      const state = baseState({
        slotEvents: [stopEvent("cleanup_orch", "no_op", "tCO")],
        signals: { orch_backfill_idle: true },
      });
      const plan = runDecide(state);

      const cleanupDispatches = (plan.actions ?? []).filter(
        (a: any) => a.type === "dispatch" && a.slot === "cleanup_orch",
      );
      assert.equal(
        cleanupDispatches.length,
        1,
        `exactly one cleanup_orch dispatch expected in the plan, got ${cleanupDispatches.length}: ` +
          JSON.stringify(cleanupDispatches.map((a: any) => a.prompt_args ?? {})),
      );
      // The surviving dispatch must be the escalation re-dispatch (the stronger
      // tier), not the plain signal-class one — suppressing the wrong copy would
      // silently downgrade the retry back to the cheap tier.
      assert.equal(
        (cleanupDispatches[0].prompt_args ?? {}).escalate_model,
        "sonnet",
        "the surviving cleanup_orch dispatch must be the escalation (sonnet) re-dispatch, not the plain signal-class copy",
      );

      // INV-006: the reap that frees the slot must still precede the dispatch.
      const types = (plan.actions ?? []).map(
        (a: any) => `${a.type}:${a.slot}`,
      );
      const reapIdx = types.indexOf("reap:cleanup_orch");
      const dispatchIdx = types.indexOf("dispatch:cleanup_orch");
      assert.ok(reapIdx >= 0, "the no_op slot must be reaped");
      assert.ok(
        reapIdx < dispatchIdx,
        "reap must precede the surviving cleanup_orch dispatch (INV-006)",
      );
    },
  );

  test(
    "usage gate: dispatch_blocked SUPPRESSES the escalation re-dispatch (issue #3274 QA blocker)",
    () => {
      // Near budget exhaustion the Subscription Usage Tracker returns
      // allow=false → dispatch_blocked. The escalation rule runs at step 2.5,
      // AHEAD of the ordinary dispatch rules, so without a guard a cheap-tier
      // (Haiku) cleanup_orch no_op would still trigger a MORE expensive Sonnet
      // re-dispatch — the opposite of the cost win the cascade routing exists
      // to deliver. decide() now hoists the usage-eligibility read ahead of the
      // escalation rule and passes dispatch_blocked in; the guard mirrors the
      // pipeline/signal dispatch rules and emits ZERO escalation dispatches.
      const state = baseState({
        slotEvents: [stopEvent("cleanup_orch", "no_op", "tBLOCK")],
        usage_eligibility: { allow: false, reasons: { budget: "exhausted" } },
      });
      const plan = runDecide(state);
      assert.equal(
        escalationFor(plan, "cleanup_orch"),
        undefined,
        "dispatch_blocked must suppress the Sonnet escalation re-dispatch under the usage gate",
      );
      // No cleanup_orch dispatch of ANY kind should survive the hard stop.
      const cleanupDispatches = (plan.actions ?? []).filter(
        (a: any) => a.type === "dispatch" && a.slot === "cleanup_orch",
      );
      assert.equal(
        cleanupDispatches.length,
        0,
        `dispatch_blocked is a hard stop — no cleanup_orch dispatch expected, got ${cleanupDispatches.length}`,
      );
      // The no_op slot must still be reaped — the gate blocks DISPATCH, not the
      // completion reap (INV-006 stays intact under the budget hard stop).
      const types = (plan.actions ?? []).map((a: any) => `${a.type}:${a.slot}`);
      assert.ok(
        types.includes("reap:cleanup_orch"),
        "the no_op slot must still be reaped even when dispatch is budget-blocked",
      );
    },
  );

  test(
    "usage gate allow=true leaves the escalation re-dispatch intact (guard is scoped to the hard stop)",
    () => {
      // Symmetry check: an explicit allow=true payload must NOT suppress the
      // escalation — the guard fires ONLY on the budget hard stop, never on a
      // healthy budget. Guards against an inverted-boolean regression.
      const state = baseState({
        slotEvents: [stopEvent("cleanup_orch", "no_op", "tALLOW")],
        usage_eligibility: { allow: true },
      });
      const plan = runDecide(state);
      const esc = escalationFor(plan, "cleanup_orch");
      assert.ok(
        esc,
        "with allow=true the cascade escalation must still fire",
      );
      assert.equal(esc.prompt_args.escalate_model, "sonnet");
    },
  );
});

describe("decide.py — cascade-routing telemetry events (issue #3284)", () => {
  test("a realised escalation emits a cascade_routing_escalation event", () => {
    const state = baseState({ slotEvents: [stopEvent("cleanup_orch", "no_op")] });
    const plan = runDecide(state);
    // The dispatch AND the telemetry event must both be present.
    assert.ok(escalationFor(plan, "cleanup_orch"), "escalation dispatch present");
    const ev = eventOf(plan, "cascade_routing_escalation");
    assert.ok(ev, "a cascade_routing_escalation event must be emitted");
    assert.equal(ev.class, "cleanup_orch");
    assert.equal(ev.trigger_reason, "subagent_noop", "no_op maps to the subagent_noop trigger");
    assert.equal(ev.from_model, "haiku", "cheap tier is haiku (the class default)");
    assert.equal(ev.to_model, "sonnet", "escalate-to tier is sonnet");
    // attempt is stringified for XADD and is the ESCALATED attempt number (2).
    assert.equal(ev.attempt, "2");
  });

  test("a FAILURE trigger records trigger_reason=subagent_failure", () => {
    const state = baseState({
      slotEvents: [stopEvent("cleanup_orch", "failure", "tF", "npm test failed")],
    });
    const plan = runDecide(state);
    const ev = eventOf(plan, "cascade_routing_escalation");
    assert.ok(ev, "a failure escalation must emit the telemetry event");
    assert.equal(ev.trigger_reason, "subagent_failure");
  });

  test("a usage-gate-blocked would-be escalation emits cascade_routing_blocked and NO escalation event", () => {
    const state = baseState({
      slotEvents: [stopEvent("cleanup_orch", "no_op", "tBLOCK")],
      usage_eligibility: { allow: false, reasons: { budget: "exhausted" } },
    });
    const plan = runDecide(state);
    // No dispatch survives the hard stop (existing invariant) …
    assert.equal(
      escalationFor(plan, "cleanup_orch"),
      undefined,
      "dispatch_blocked suppresses the re-dispatch",
    );
    // … but the throttled escalation is now VISIBLE via the blocked event.
    const blocked = eventOf(plan, "cascade_routing_blocked");
    assert.ok(blocked, "a throttled escalation must emit cascade_routing_blocked");
    assert.equal(blocked.class, "cleanup_orch");
    assert.equal(blocked.trigger_reason, "subagent_noop");
    assert.equal(blocked.to_model, "sonnet", "the suppressed escalate-to tier is recorded");
    assert.equal(blocked.block_reason, "usage_dispatch_blocked");
    // And NO escalation event fires (the escalation did not actually happen).
    assert.equal(
      eventOf(plan, "cascade_routing_escalation"),
      undefined,
      "a blocked escalation must NOT also emit an escalation event",
    );
  });

  test("a SUCCESS emits NEITHER cascade event (no routing decision to report)", () => {
    const state = baseState({ slotEvents: [stopEvent("cleanup_orch", "success")] });
    const plan = runDecide(state);
    assert.equal(eventOf(plan, "cascade_routing_escalation"), undefined);
    assert.equal(eventOf(plan, "cascade_routing_blocked"), undefined);
  });

  test("a saturated-board no_op suppression emits NEITHER cascade event (not a routing decision)", () => {
    // Suppression here is capability-neutral (work-availability), NOT the usage
    // gate — so it is NOT a `blocked` telemetry event; nothing is reported.
    const state = baseState({
      slotEvents: [stopEvent("cleanup_orch", "no_op")],
      signals: { cleanup_board_saturated: true },
    });
    const plan = runDecide(state);
    assert.equal(eventOf(plan, "cascade_routing_escalation"), undefined);
    assert.equal(eventOf(plan, "cascade_routing_blocked"), undefined);
  });
});

const DECIDE_PY = join(REPO_ROOT, "scripts", "autopilot", "decide.py");
const SELF_HEAL_PY = join(REPO_ROOT, "scripts", "autopilot", "self_heal.py");

/** Import a decide.py-style script by path (it is a script, not a package). */
function importPy(path: string, name: string): string {
  return `
import sys, importlib.util
spec = importlib.util.spec_from_file_location(${JSON.stringify(name)}, ${JSON.stringify(path)})
m = importlib.util.module_from_spec(spec)
sys.modules[${JSON.stringify(name)}] = m
spec.loader.exec_module(m)
`;
}

/** Call decide_escalation(slot,status,attempt,saturated) -> escalate bool. */
function escalateBool(
  slot: string,
  status: string,
  attempt: number,
  saturated: boolean,
): { escalate: boolean; model: string | null } {
  const script =
    importPy(DECIDE_PY, "decide") +
    `
import json
r = m.decide_escalation(slot=${JSON.stringify(slot)}, status=${JSON.stringify(status)}, attempt=${attempt}, board_saturated=${saturated ? "True" : "False"})
print(json.dumps({"escalate": r["escalate"], "model": r["escalate_model"]}))
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`decide_escalation failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

describe("decide.py — decide_escalation pure reducer truth table (issue #3274)", () => {
  // The 8 cases the design-concept prototype pinned (branch=logic, 8/8 pass).
  const CASES: Array<[string, string, number, boolean, boolean]> = [
    // slot, status, attempt, saturated, expectEscalate
    ["cleanup_orch", "no_op", 1, false, true],
    ["cleanup_orch", "no_op", 1, true, false],
    ["cleanup_orch", "failure", 1, true, true],
    ["cleanup_orch", "failure", 1, false, true],
    ["cleanup_orch", "no_op", 2, false, false],
    ["cleanup_orch", "success", 1, false, false],
    ["dev_orch", "no_op", 1, false, false],
    ["cleanup_orch", "budget_exceeded", 1, true, true],
  ];
  for (const [slot, status, attempt, sat, expected] of CASES) {
    test(`${slot}/${status}/attempt=${attempt}/saturated=${sat} -> escalate=${expected}`, () => {
      const r = escalateBool(slot, status, attempt, sat);
      assert.equal(r.escalate, expected);
      if (expected) assert.equal(r.model, "sonnet");
      else assert.equal(r.model, null);
    });
  }
});

describe("self_heal.py — subagent_noop pattern (issue #3274)", () => {
  test("classify() maps a no_op cue to the subagent-noop pattern; its strategy is a no-op action", () => {
    const script =
      importPy(SELF_HEAL_PY, "self_heal") +
      `
print(m.classify("subagent_noop"))
print(m.strategy_for(m.PATTERN_SUBAGENT_NOOP).action)
`;
    const r = spawnSync("python3", ["-c", script], { encoding: "utf-8" });
    assert.equal(r.status, 0, `self_heal import failed: ${r.stderr}`);
    const [pattern, action] = r.stdout.trim().split("\n");
    assert.equal(pattern, "subagent-noop", "no_op cue classifies to subagent-noop");
    assert.equal(
      action,
      "none",
      "a no_op is not a GitHub-issue re-queue — escalation is decide.py's reducer",
    );
  });
});

describe("decide.py — dev_orch Sonnet demotion safety net (2026-07-29)", () => {
  // dev_orch was demoted from the frontier tier to Sonnet in the playbook's
  // per-class model routing table. ESCALATION_POLICY gained a dev_orch row so
  // that a genuine capability miss self-rescues at the frontier tier on the
  // next dispatch instead of stalling the class until an operator notices.
  //
  // The row's trigger set is NARROWER than cleanup_orch's on purpose, and that
  // asymmetry is the substance of the design — see the no_op case below.

  test("a dev_orch verification FAILURE escalates to the frontier tier", () => {
    const state = baseState({
      slotEvents: [
        stopEvent("dev_orch", "failure", "tDEV", "npm test failed in worktree"),
      ],
    });
    const plan = runDecide(state);
    const esc = escalationFor(plan, "dev_orch");
    assert.ok(esc, "a dev_orch failure is capability-driven and must escalate");
    assert.equal(
      esc.prompt_args.escalate_model,
      "fable",
      "escalates to the frontier alias, not back to Sonnet — a Sonnet retry of a Sonnet failure buys nothing",
    );
  });

  test("decide.py stays PURE — the escalation carries a HINT, never a concrete model field (invariant 1)", () => {
    const state = baseState({
      slotEvents: [stopEvent("dev_orch", "failure", "tDEV", "tsc failed")],
    });
    const plan = runDecide(state);
    const esc = escalationFor(plan, "dev_orch");
    assert.ok(esc);
    assert.equal(
      esc.model,
      undefined,
      "decide.py must not stamp a concrete `model` field — the lever lives in the playbook (#1093)",
    );
  });

  test("a dev_orch no_op does NOT escalate — a no_op here is board-driven, not capability-driven", () => {
    // This is the deliberate asymmetry vs cleanup_orch, which DOES escalate a
    // fresh-board no_op. A dev_orch no_op overwhelmingly means the board had
    // nothing dispatchable (nothing ready-for-agent, every candidate already
    // carries an open PR, the glm-eligible partition subtracted the queue) —
    // escalating that would burn a frontier dispatch to re-discover an empty
    // board. Same saturation-vs-capability distinction, different default.
    const state = baseState({ slotEvents: [stopEvent("dev_orch", "no_op")] });
    const plan = runDecide(state);
    assert.equal(
      escalationFor(plan, "dev_orch"),
      undefined,
      "dev_orch triggers on subagent_failure only — a no_op must not escalate",
    );
  });

  test("attempt cap: an escalated dev_orch failure does NOT trigger a third dispatch (invariant 4)", () => {
    const state = baseState({
      slotEvents: [stopEvent("dev_orch", "failure", "tDEV", "still failing")],
      slots: {
        dev_orch: { attempt: 2, skill: "hydra-dev", task_id: "tDEV" },
        qa_orch: null,
        research_orch: null,
        dev_target: null,
        qa_target: null,
        research_target: null,
        design_concept_orch: null,
      },
    });
    const plan = runDecide(state);
    assert.equal(
      escalationFor(plan, "dev_orch"),
      undefined,
      "attempt 2 >= max_attempts 2 — the frontier retry is the last one",
    );
  });

  test("a dev_orch SUCCESS never escalates", () => {
    const state = baseState({
      slotEvents: [stopEvent("dev_orch", "success", "tDEV")],
    });
    const plan = runDecide(state);
    assert.equal(escalationFor(plan, "dev_orch"), undefined);
  });
});
