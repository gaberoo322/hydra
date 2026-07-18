/**
 * test/decide-events.test.mts — regression tests for slice A of the
 * autopilot observability epic (issue #668, parent #667).
 *
 * decide.py grew a `plan.events` list alongside the existing
 * `{actions, reasons, debug}` triple. Each turn emits exactly one
 * `turn_start`, one `turn_end`, and one `dispatch_decision` per
 * candidate pipeline/signal class considered. The events ride the
 * existing `hydra:autopilot:slot-events` Redis stream so
 * `slot-events-bridge.ts` can forward them to dashboard WS clients
 * without bridge-side filtering — the bridge is field-agnostic.
 *
 * These tests exercise the JSON wire contract through the same
 * `decide.py decide` CLI the autopilot playbook calls. The XADD path
 * is gated behind `HYDRA_AUTOPILOT_EMIT_TURN_EVENTS` and stays OFF in
 * the test process (default), so we can pin the event shape without
 * touching the live Redis stream.
 *
 * The acceptance criteria the tests pin (issue #668):
 *   - one `turn_start` per turn with {turn_n, epoch, run_id}
 *   - one `turn_end` per turn with {turn_n, epoch, run_id, dispatches,
 *     skipped, idle, tokens_after}
 *   - one `dispatch_decision` per candidate class with {turn_n, class,
 *     outcome, reason} where outcome ∈ {dispatched, cooldown, budget, idle}
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// The PIPELINE_SLOTS and signal-class sets pinned in decide.py. We pin
// the order here as a regression: tests fail if anyone reorders the
// pipeline or adds a new class without updating these.
const PIPELINE_CLASSES = [
  "qa_orch",
  "qa_target",
  "design_concept_orch",
  "dev_orch",
  "dev_target",
  "research_orch",
  "research_target",
] as const;
const SIGNAL_CLASSES = [
  "health",
  "sweep_orch",
  "sweep_target",
  "discover_orch",
  "discover_target",
  "scout_orch",
  "architecture_orch",
  // retro_orch (issue #920) — daily per-run retrospective signal class.
  "retro_orch",
  // cleanup_orch (issue #960) — board-idle deterministic dead-code /
  // simplification detector signal class.
  "cleanup_orch",
  // cleanup_target — the Target mirror of cleanup_orch: demote-only
  // dead-export sweep over ~/hydra-betting, backlog-item-producing.
  "cleanup_target",
  // wire_or_retire_target (issue #2722) — the judgment counterpart to
  // cleanup_target: resolves triage wire-or-retire items (WIRE/RETIRE/UNCLEAR).
  "wire_or_retire_target",
  // design_qa_target (issue #2739, parent #2732) — periodic visual QA of the
  // Target UI: screenshot review vs the design-language ADR (7d cadence).
  "design_qa_target",
  // skill_prune (issue #2949, epic #2944) — eval-gated PROMPT pruner: prunes ONE
  // playbook-generated skill/run along the Pocock taxonomy (orch, 7d cadence).
  "skill_prune",
  // wayfinder_orch (issue #3351, epic #3350, ADR-0029) — the wayfinder-map AFK
  // working class: works the next unblocked frontier ticket (orch, 1h cadence).
  "wayfinder_orch",
  // tickets_orch (issue #3423, epic #3419, ADR-0030 Decision 2/5) — the
  // tickets-stage producer: dispatches the upstream to-tickets skill to render a
  // resolved plan into an epic + tracer children (orch, 1h cadence).
  "tickets_orch",
] as const;
const ALL_CLASSES = [...PIPELINE_CLASSES, ...SIGNAL_CLASSES];

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-events-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

function baseState(o: Partial<{
  run_id: string;
  turn: number;
  started_epoch: number;
  cumulative_tokens: number;
  scope: string;
  burned_classes: string[];
  signals: Record<string, unknown>;
  slots: Record<string, unknown>;
  signal_last_fired: Record<string, number>;
}> = {}): unknown {
  return {
    run_id: o.run_id ?? "abcdef1234-5678-90ab-cdef-1234567890ab",
    turn: o.turn ?? 7,
    started_epoch: o.started_epoch ?? Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      scope: o.scope ?? "all",
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: o.cumulative_tokens ?? 12_345,
    dispatches: 0,
    idle_turns: 0,
    burned_classes: o.burned_classes ?? [],
    reaped_task_ids: [],
    failure_log: [],
    slots: o.slots ?? {
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
      scout_orch: 0,
    },
    signals: o.signals ?? {},
    research_force_counter: {},
  };
}

function runDecide(
  state: unknown,
  candidates: unknown = null,
  events: unknown[] = [],
): {
  actions: Array<Record<string, unknown>>;
  reasons: string[];
  debug: Record<string, unknown>;
  events: Array<Record<string, string>>;
} {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(candidates));
    writeFileSync(t.events, JSON.stringify(events));
    // Important: keep HYDRA_AUTOPILOT_EMIT_TURN_EVENTS UNSET so the
    // CLI's best-effort XADD is a no-op. We pin the plan JSON here,
    // not the Redis side-effect (that's a manual-verification AC).
    const r = spawnSync(
      "python3",
      [DECIDE, "decide", t.state, t.cands, t.events],
      {
        encoding: "utf-8",
        // These fixtures carry a run_id AND (since #1352) an idle turn
        // terminates — keep the CLI's run-end POST off so the suite never
        // POSTs to a live orchestrator.
        env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
      },
    );
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

function eventsOfType(plan: { events: Array<Record<string, string>> }, kind: string): Array<Record<string, string>> {
  return plan.events.filter((e) => e.event === kind);
}

function dispatchDecisionFor(plan: { events: Array<Record<string, string>> }, cls: string): Record<string, string> | undefined {
  return plan.events.find((e) => e.event === "dispatch_decision" && e.class === cls);
}

// ---------------------------------------------------------------------------
// turn_start / turn_end pairing
// ---------------------------------------------------------------------------

describe("decide.py — turn_start / turn_end events (issue #668)", () => {
  test("emits exactly one turn_start per turn", () => {
    const plan = runDecide(baseState());
    const starts = eventsOfType(plan, "turn_start");
    assert.equal(starts.length, 1, "expected exactly one turn_start event");
  });

  test("emits exactly one turn_end per turn", () => {
    const plan = runDecide(baseState());
    const ends = eventsOfType(plan, "turn_end");
    assert.equal(ends.length, 1, "expected exactly one turn_end event");
  });

  test("turn_start carries {turn_n, epoch, run_id, ts_epoch}", () => {
    const epoch = 1_700_000_000;
    const plan = runDecide(
      baseState({ turn: 42, run_id: "abcd1234-deadbeef", started_epoch: epoch }),
    );
    const start = eventsOfType(plan, "turn_start")[0];
    assert.equal(start.turn_n, "43", "input turn 42 + the #1769 CLI bump");
    assert.equal(start.epoch, String(epoch));
    assert.equal(start.run_id, "abcd1234-deadbeef");
    assert.ok(start.ts_epoch, "ts_epoch must be set on turn_start");
  });

  test("turn_end carries {turn_n, epoch, run_id, dispatches, skipped, idle, tokens_after}", () => {
    const epoch = 1_700_000_000;
    const plan = runDecide(
      baseState({
        turn: 9,
        run_id: "cafef00d-1234-5678",
        started_epoch: epoch,
        cumulative_tokens: 99_999,
      }),
    );
    const end = eventsOfType(plan, "turn_end")[0];
    assert.equal(end.turn_n, "10", "input turn 9 + the #1769 CLI bump");
    assert.equal(end.epoch, String(epoch));
    assert.equal(end.run_id, "cafef00d-1234-5678");
    assert.equal(end.tokens_after, "99999");
    assert.ok(end.dispatches !== undefined);
    assert.ok(end.skipped !== undefined);
    assert.ok(end.idle !== undefined);
  });

  test("idle=1 on turn_end when no dispatch action emitted", () => {
    // Empty signals + no slots in flight => idle heartbeat path.
    const plan = runDecide(baseState());
    const end = eventsOfType(plan, "turn_end")[0];
    assert.equal(end.idle, "1");
    assert.equal(end.dispatches, "0");
  });

  test("idle=0 on turn_end when at least one dispatch fired", () => {
    const plan = runDecide(
      baseState({ signals: { needs_qa_orch: true } }),
    );
    const end = eventsOfType(plan, "turn_end")[0];
    assert.equal(end.idle, "0");
    assert.equal(end.dispatches, "1");
  });

  test("turn_end emitted even on termination short-circuit (budget exhaustion)", () => {
    const plan = runDecide(
      baseState({ cumulative_tokens: 2_000_000 }),
    );
    // Termination should fire — and turn_end should still be present
    // so the dashboard's turn counters close.
    const terminate = plan.actions.find((a) => a.type === "terminate");
    assert.ok(terminate, "termination action expected at budget");
    const ends = eventsOfType(plan, "turn_end");
    assert.equal(ends.length, 1, "turn_end must fire on termination too");
  });
});

// ---------------------------------------------------------------------------
// dispatch_decision per candidate class
// ---------------------------------------------------------------------------

describe("decide.py — dispatch_decision per candidate class", () => {
  test("emits exactly one dispatch_decision per candidate class on an idle turn", () => {
    const plan = runDecide(baseState());
    const decisions = eventsOfType(plan, "dispatch_decision");
    // ALL_CLASSES = 7 pipeline + 15 signal = 22 total.
    assert.equal(
      decisions.length,
      ALL_CLASSES.length,
      `expected one dispatch_decision per class (${ALL_CLASSES.length})`,
    );
    const classes = new Set(decisions.map((d) => d.class));
    for (const cls of ALL_CLASSES) {
      assert.ok(classes.has(cls), `missing dispatch_decision for ${cls}`);
    }
  });

  test("every dispatch_decision has a valid outcome", () => {
    const VALID = new Set(["dispatched", "cooldown", "budget", "idle"]);
    const plan = runDecide(baseState());
    const decisions = eventsOfType(plan, "dispatch_decision");
    for (const d of decisions) {
      assert.ok(
        VALID.has(d.outcome),
        `outcome '${d.outcome}' for class '${d.class}' not in {${[...VALID].join(",")}}`,
      );
    }
  });

  test("dispatched outcome when slot dispatches successfully", () => {
    const plan = runDecide(
      baseState({ signals: { needs_qa_orch: true } }),
    );
    const decision = dispatchDecisionFor(plan, "qa_orch");
    assert.ok(decision);
    assert.equal(decision.outcome, "dispatched");
    assert.ok(decision.reason.length > 0);
  });

  test("cooldown outcome when slot is busy", () => {
    const plan = runDecide(
      baseState({
        slots: {
          dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 50_000 },
          qa_orch: null,
          research_orch: null,
          dev_target: null,
          qa_target: null,
          research_target: null,
          design_concept_orch: null,
        },
        signals: { orch_work_available: true },
      }),
    );
    const decision = dispatchDecisionFor(plan, "dev_orch");
    assert.ok(decision);
    assert.equal(decision.outcome, "cooldown");
    assert.match(decision.reason, /busy/i);
  });

  test("idle outcome when no triggering signal", () => {
    const plan = runDecide(baseState());
    const decision = dispatchDecisionFor(plan, "dev_orch");
    assert.ok(decision);
    assert.equal(decision.outcome, "idle");
  });

  test("idle outcome on scope exclusion (target scope blocks orch classes)", () => {
    const plan = runDecide(baseState({ scope: "target-only" }));
    const decision = dispatchDecisionFor(plan, "dev_orch");
    assert.ok(decision);
    assert.equal(decision.outcome, "idle");
    assert.match(decision.reason, /scope/i);
  });

  test("cooldown outcome when class is burned (soft-cap)", () => {
    const plan = runDecide(
      baseState({ burned_classes: ["dev_orch"], signals: { orch_work_available: true } }),
    );
    const decision = dispatchDecisionFor(plan, "dev_orch");
    assert.ok(decision);
    assert.equal(decision.outcome, "cooldown");
    assert.match(decision.reason, /burned/i);
  });

  test("budget outcome when usage tracker blocks dispatch", () => {
    const state = baseState({ signals: { needs_qa_orch: true } }) as Record<string, unknown>;
    state.usage_eligibility = {
      allow: false,
      shed: [],
      reasons: { five_hour_pct: 95 },
    };
    const plan = runDecide(state);
    const decision = dispatchDecisionFor(plan, "qa_orch");
    assert.ok(decision);
    assert.equal(decision.outcome, "budget");
    // And no dispatch action fires under the block.
    const dispatch = plan.actions.find(
      (a) => a.type === "dispatch" && a.slot === "qa_orch",
    );
    assert.equal(dispatch, undefined, "blocked usage must suppress dispatch");
  });

  test("budget outcome when class is in usage tracker shed list", () => {
    const state = baseState({ signals: { needs_triage_orch: true } }) as Record<string, unknown>;
    state.usage_eligibility = {
      allow: true,
      shed: ["sweep_orch"],
      reasons: {},
    };
    const plan = runDecide(state);
    const decision = dispatchDecisionFor(plan, "sweep_orch");
    assert.ok(decision);
    assert.equal(decision.outcome, "budget");
    assert.match(decision.reason, /shed/i);
  });

  test("dispatch_decision events carry turn_n matching the bumped state.turn", () => {
    const plan = runDecide(baseState({ turn: 33 }));
    const decisions = eventsOfType(plan, "dispatch_decision");
    for (const d of decisions) {
      assert.equal(d.turn_n, "34", "input turn 33 + the #1769 CLI bump");
    }
  });
});

// ---------------------------------------------------------------------------
// Event ordering — turn_start first, turn_end last
// ---------------------------------------------------------------------------

describe("decide.py — observability event ordering", () => {
  test("turn_start is the first event; turn_end is the last", () => {
    const plan = runDecide(baseState());
    assert.ok(plan.events.length >= 2, "must have at least turn_start + turn_end");
    assert.equal(plan.events[0].event, "turn_start");
    assert.equal(plan.events[plan.events.length - 1].event, "turn_end");
  });

  test("dispatch_decision events sit between turn_start and turn_end", () => {
    const plan = runDecide(baseState());
    const decisionIndices = plan.events
      .map((e, i) => (e.event === "dispatch_decision" ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(decisionIndices.length > 0);
    assert.ok(decisionIndices[0] > 0);
    assert.ok(decisionIndices[decisionIndices.length - 1] < plan.events.length - 1);
  });
});
