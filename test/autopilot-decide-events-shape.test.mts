/**
 * Regression suite for `scripts/autopilot/decide.py`'s events-argument
 * normalisation (issue #4213).
 *
 * Run 7f370acb turn 1 invoked Phase 3 with an events.json shaped
 * `{"events": [...]}` (the exact blob collect-state.sh emits under
 * `slot_events_json=`) instead of a bare list. `_rule_completion_reaps`
 * iterated the dict — yielding its KEYS — and died with
 * `AttributeError: 'str' object has no attribute 'get'`, so the whole
 * decision phase exited 1 with no Plan, on an unattended run, after the
 * Turn counter had already been bumped (#1769).
 *
 * The fix normalises `events` ONCE at the top of decide() and expresses
 * every degradation as `plan.reasons` entries — never a traceback. These
 * cases drive the `decide` CLI (spawnSync, own tmp dir, no shared Redis) so
 * they pin the JSON wire contract the playbook consumes, exactly like
 * test/autopilot-decide.test.mts. Every describe() is top-level with its own
 * tmp lifecycle.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// Frozen decision clock (#2713) so two runs of the same payload are
// byte-comparable — turn_start / turn_end events carry `now`.
const NOW = 1_800_000_000;

interface BusySlot { task_id: string; started_epoch: number; skill: string }

function baseState(slots: Record<string, BusySlot | null> = {}): any {
  return {
    started_epoch: NOW - 60,
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      context_compaction_turns: 0,
      scope: "all",
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
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
      ...slots,
    },
    // Every signal class recently fired → nothing dispatches, so the plan
    // is a deterministic function of the events lane alone.
    signal_last_fired: {
      health: NOW, sweep_orch: NOW, sweep_target: NOW,
      discover_orch: NOW, discover_target: NOW,
    },
    signals: {},
    research_force_counter: {},
  };
}

const BUSY_DEV: BusySlot = { task_id: "t-1", started_epoch: NOW - 100, skill: "hydra-dev" };

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  plan: any | null;
  stateAfter: any;
}

/**
 * Run the decide CLI with `eventsText` written VERBATIM to events.json (so a
 * case can hand it non-JSON), or with NO events positional when `eventsText`
 * is `undefined`. Never throws on a non-zero exit — the exit code is what
 * the crash cases assert on.
 */
function runRaw(state: any, eventsText: string | undefined, candidates: any = null): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "decide-events-shape-"));
  try {
    const statePath = join(dir, "state.json");
    const candsPath = join(dir, "candidates.json");
    const eventsPath = join(dir, "events.json");
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(candsPath, JSON.stringify(candidates));
    const args = [DECIDE, `--now=${NOW}`, "decide", statePath, candsPath];
    if (eventsText !== undefined) {
      writeFileSync(eventsPath, eventsText);
      args.push(eventsPath);
    }
    const env: Record<string, string | undefined> = { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" };
    delete env.HYDRA_AUTOPILOT_EMIT_TURN_EVENTS;
    delete env.HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS;
    const r = spawnSync("python3", args, { encoding: "utf-8", env });
    let plan: any | null = null;
    if (r.status === 0) {
      plan = JSON.parse(r.stdout);
    }
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      plan,
      stateAfter: JSON.parse(readFileSync(statePath, "utf-8")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(state: any, events: unknown, candidates: any = null): RunResult {
  return runRaw(state, JSON.stringify(events), candidates);
}

function reaps(plan: any): any[] {
  return (plan?.actions ?? []).filter((a: any) => a.type === "reap");
}

/** The plan minus the per-turn identity stamps — what "identical Plan" means. */
function comparable(plan: any): { actions: unknown; reasons: unknown; debug: unknown } {
  return { actions: plan.actions, reasons: plan.reasons, debug: plan.debug };
}

const TYPED_COMPLETION = { type: "completion", slot: "dev_orch", task_id: "t-1", total_tokens: 1234, skill: "hydra-dev" };
const STREAM_STOP = {
  id: "1779143539950-0",
  fields: { event: "subagent_stop", slot: "dev_orch", status: "success", task_id: "t-1", ts_epoch: String(NOW - 5) },
};

// ---------------------------------------------------------------------------
// INV-1 — decide() never raises on the shape of the events argument
// ---------------------------------------------------------------------------

describe("decide.py events-argument normalisation (issue #4213)", () => {
  test("decide() never raises on the shape of the events argument", () => {
    const shapes: Array<[string, string | undefined]> = [
      ["no events positional", undefined],
      ["JSON null", "null"],
      ["bare empty list", "[]"],
      ["wrapper with empty list", JSON.stringify({ events: [] })],
      ["collect-state wrapper with last_id", JSON.stringify({ events: [TYPED_COMPLETION], last_id: "1-0" })],
      ["list with a bare string entry (the run-7f370acb crash shape)", JSON.stringify(["events"])],
      ["list with an integer entry", JSON.stringify([1])],
      ["list with an empty dict entry", JSON.stringify([{}])],
      ["a JSON string", JSON.stringify("not-events")],
      ["a JSON number", "42"],
      ["a dict without an events list", JSON.stringify({ last_id: "1-0" })],
      ["a dict whose events is not a list", JSON.stringify({ events: "nope" })],
      ["not JSON at all", "not json {"],
      ["empty file", ""],
    ];
    for (const [label, text] of shapes) {
      const r = runRaw(baseState({ dev_orch: BUSY_DEV }), text);
      assert.equal(r.status, 0, `${label}: expected exit 0, got ${r.status}\n${r.stderr}`);
      assert.ok(Array.isArray(r.plan?.actions), `${label}: plan has an actions list`);
      assert.ok(!/Traceback/.test(r.stderr), `${label}: no traceback on stderr:\n${r.stderr}`);
    }
  });

  test("the exact run-7f370acb shape — {events:[...]} wrapper — produces a plan with the reap", () => {
    // The wrapper is what collect-state.sh emits as slot_events_json=; passing
    // it straight through as events.json used to kill the decision phase.
    const r = run(baseState({ dev_orch: BUSY_DEV }), { events: [TYPED_COMPLETION], last_id: "1-0" });
    assert.equal(r.status, 0, r.stderr);
    const reap = reaps(r.plan);
    assert.equal(reap.length, 1);
    assert.equal(reap[0].slot, "dev_orch");
    assert.equal(reap[0].task_id, "t-1");
    assert.equal(reap[0].total_tokens, 1234);
    // A well-formed wrapper is NOT a degradation — no events-* reason.
    assert.ok(!r.plan.reasons.some((x: string) => x.startsWith("events-")), JSON.stringify(r.plan.reasons));
  });
});

// ---------------------------------------------------------------------------
// INV-5 — both shapes produce an identical Plan
// ---------------------------------------------------------------------------

describe("decide.py events shapes are plan-equivalent (issue #4213)", () => {
  test("a typed list and the {events: list} wrapper yield an identical plan", () => {
    const bare = run(baseState({ dev_orch: BUSY_DEV }), [TYPED_COMPLETION]);
    const wrapped = run(baseState({ dev_orch: BUSY_DEV }), { events: [TYPED_COMPLETION] });
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.deepEqual(comparable(wrapped.plan), comparable(bare.plan));
    assert.equal(reaps(bare.plan).length, 1, "the typed completion is reaped");
  });

  test("a stream-shaped subagent_stop on the events.json lane emits the same reap as on state.slot_events", () => {
    // Lane A: raw stream entry mis-routed onto events.json.
    const viaEvents = run(baseState({ dev_orch: BUSY_DEV }), { events: [STREAM_STOP] });
    // Lane B: the same entry where collect-state puts it — state.slot_events.
    const stateB = baseState({ dev_orch: BUSY_DEV });
    stateB.slot_events = { events: [STREAM_STOP], last_id: STREAM_STOP.id };
    const viaState = run(stateB, []);
    assert.equal(viaEvents.status, 0, viaEvents.stderr);
    assert.equal(viaState.status, 0, viaState.stderr);

    const reapA = reaps(viaEvents.plan);
    assert.equal(reapA.length, 1, "the stopped slot is reaped, not silently dropped");
    assert.equal(reapA[0].slot, "dev_orch");
    assert.equal(reapA[0].task_id, "t-1");
    assert.deepEqual(viaEvents.plan.actions, viaState.plan.actions, "identical actions on both lanes");

    // The ONLY difference is the loud re-home reason on lane A.
    assert.ok(viaEvents.plan.reasons.includes("events-stream-entries-rehomed:1"), JSON.stringify(viaEvents.plan.reasons));
    assert.equal(viaEvents.plan.debug.events_stream_entries_rehomed, 1);
    assert.deepEqual(
      viaEvents.plan.reasons.filter((x: string) => x !== "events-stream-entries-rehomed:1"),
      viaState.plan.reasons,
    );
  });

  test("a stream entry present on BOTH lanes is projected once (dedup by id)", () => {
    const state = baseState({ dev_orch: BUSY_DEV });
    state.slot_events = [STREAM_STOP];
    const r = run(state, [STREAM_STOP]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(reaps(r.plan).length, 1, "exactly one reap for the one stop");
    assert.ok(!r.plan.reasons.some((x: string) => x.startsWith("events-stream-entries-rehomed")), "nothing re-homed");
  });

  test("re-homing is in-memory only: the persisted state.json gains no slot_events key", () => {
    // INV-8: the re-home is the same telemetry-class mutation as slot_history;
    // main() adds NO write-back trigger for it. The turn bump (#1769) persists
    // BEFORE decide() runs, so the file never sees the mutated dict.
    const r = run(baseState({ dev_orch: BUSY_DEV }), { events: [STREAM_STOP] });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stateAfter.slot_events, undefined);
    assert.equal(r.stateAfter.slot_history, undefined);
  });
});

// ---------------------------------------------------------------------------
// INV-1 / INV-7 — degradation reasons, the turn contract, fail-loud stderr
// ---------------------------------------------------------------------------

describe("decide.py events degradation reasons (issue #4213)", () => {
  test("an unparseable events.json exits 0 with events-malformed-ignored and bumps turn by exactly 1", () => {
    const r = runRaw(baseState({ dev_orch: BUSY_DEV }), "not json {");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.plan.reasons.includes("events-malformed-ignored"), JSON.stringify(r.plan.reasons));
    assert.equal(typeof r.plan.debug.events_load_error, "string");
    assert.ok(r.plan.debug.events_load_error.includes("events.json"), r.plan.debug.events_load_error);
    // Fail loud: path + error on stderr, no traceback.
    assert.ok(/events file .*events\.json unreadable/.test(r.stderr), r.stderr);
    assert.ok(!/Traceback/.test(r.stderr), r.stderr);
    // INV-6: the #1769 contract is untouched — the Turn is still consumed
    // (bump BEFORE decide()) and plan.turn equals the persisted turn.
    assert.equal(r.stateAfter.turn, 1);
    assert.equal(r.plan.turn, 1);
    // The plan is still executable: the busy slot yields a wait, not nothing.
    assert.ok(r.plan.actions.some((a: any) => a.type === "wait"), JSON.stringify(r.plan.actions));
  });

  test("a garbled state.json still fails hard: only the events positional is degradable", () => {
    const dir = mkdtempSync(join(tmpdir(), "decide-events-shape-state-"));
    try {
      const statePath = join(dir, "state.json");
      const candsPath = join(dir, "candidates.json");
      const eventsPath = join(dir, "events.json");
      writeFileSync(statePath, "not json {");
      writeFileSync(candsPath, "null");
      writeFileSync(eventsPath, "[]");
      const r = spawnSync("python3", [DECIDE, `--now=${NOW}`, "decide", statePath, candsPath, eventsPath], {
        encoding: "utf-8",
        env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
      });
      assert.notEqual(r.status, 0, "a garbled state.json is not degradable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a bare string entry is skipped with events-entry-skipped:1 and the typed sibling is still reaped", () => {
    const r = run(baseState({ dev_orch: BUSY_DEV }), ["events", TYPED_COMPLETION]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.plan.reasons.includes("events-entry-skipped:1"), JSON.stringify(r.plan.reasons));
    assert.equal(r.plan.debug.events_entries_skipped, 1);
    assert.equal(reaps(r.plan).length, 1);
  });

  test("a dict entry that is neither typed nor stream-shaped is counted as skipped", () => {
    const r = run(baseState(), [{}, { foo: "bar" }, 7]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.plan.reasons.includes("events-entry-skipped:3"), JSON.stringify(r.plan.reasons));
  });

  test("a wrapper dict without an events list degrades loudly to []", () => {
    const r = run(baseState({ dev_orch: BUSY_DEV }), { last_id: "1-0" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.plan.reasons.includes("events-malformed-ignored"), JSON.stringify(r.plan.reasons));
    assert.equal(reaps(r.plan).length, 0);
  });

  test("a clean typed list adds no events-* reason or debug key (golden plans stay byte-identical)", () => {
    const r = run(baseState(), []);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.plan.reasons.some((x: string) => x.startsWith("events-")), JSON.stringify(r.plan.reasons));
    assert.ok(!Object.keys(r.plan.debug).some((k) => k.startsWith("events_")), JSON.stringify(r.plan.debug));
  });
});

// ---------------------------------------------------------------------------
// INV-2 — every consumer sees the normalised list, including the signal
// readers that run at step 1 (the `_signal_present` site of recurrence 2)
// ---------------------------------------------------------------------------

describe("decide.py signal readers see the normalised events (issue #4213)", () => {
  test("an orch_board_signals_degraded signal wrapped in the dict shape is still honoured", () => {
    const signal = { type: "signal", name: "orch_board_signals_degraded", value: true };
    const bare = run(baseState(), [signal]);
    const wrapped = run(baseState(), { events: [signal] });
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.equal(bare.plan.debug.orch_board_read_degraded, true);
    assert.equal(wrapped.plan.debug.orch_board_read_degraded, true);
    assert.deepEqual(comparable(wrapped.plan), comparable(bare.plan));
  });

  test("a qa-verdict event inside the wrapper still reaches the auto-merge sweep", () => {
    const verdict = { type: "qa-verdict", verdict: "PASS", pr_number: 4213, tier: 1, mechanical: false };
    const bare = run(baseState(), [verdict]);
    const wrapped = run(baseState(), { events: [verdict] });
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.deepEqual(comparable(wrapped.plan), comparable(bare.plan));
    assert.ok(
      bare.plan.actions.some((a: any) => a.type === "auto-merge" || a.type === "queue-decision"),
      `expected the verdict to produce an auto-merge/queue-decision action: ${JSON.stringify(bare.plan.actions)}`,
    );
  });
});
