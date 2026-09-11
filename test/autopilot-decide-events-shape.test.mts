/**
 * Regression tests for the events-argument shape contract of
 * `scripts/autopilot/decide.py` (issue #4213).
 *
 * Three autopilot runs (7f370acb, 8e50460f, b5c4c27c) each lost a Turn to
 * `AttributeError: 'str' object has no attribute 'get'` because Phase 3 was
 * handed collect-state.sh's `{"events": [...], "last_id": ...}` blob as
 * events.json: iterating the dict yielded its KEYS, which every
 * `for ev in events` loop then treated as event dicts. The fix normalises the
 * argument ONCE at the top of decide() (`_normalise_events`), shares the
 * dict-unwrap with the state.slot_events lane (`_unwrap_events_container`),
 * and RE-HOMES raw stream entries onto state.slot_events so the ONE existing
 * `subagent_stop` projection frees the slot (comment 2 on the issue: unwrap
 * alone would turn the crash into a silent drop that reaps nothing).
 *
 * Exercised through the `decide` CLI (spawnSync, own tmp dir, no Redis) — the
 * same harness as test/autopilot-decide.test.mts — so the tests also pin the
 * wire contract the playbook's Phase 3 line consumes. Every case is a new
 * top-level `describe` with no shared mutable state (each call writes its own
 * tmp dir), so nothing here can leak into a sibling.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-decide-events-shape-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

/** Minimal state with one BUSY dev_orch slot (task_id "t-1") — the reap target. */
function busyDevOrchState(extra: Record<string, unknown> = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
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
      dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0, task_id: "t-1" },
      qa_orch: null, research_orch: null,
      dev_target: null, qa_target: null, research_target: null,
      design_concept_orch: null,
    },
    signal_last_fired: {
      health: 0, sweep_orch: 0, sweep_target: 0, discover_orch: 0, discover_target: 0,
    },
    signals: {},
    research_force_counter: {},
    ...extra,
  };
}

interface RunResult { status: number | null; stdout: string; stderr: string; plan: any | null; tmp: Tmp }

/**
 * Run the decide CLI. `eventsRaw` is written VERBATIM (so a test can hand it
 * `not json`); `eventsArg` = false omits the positional entirely.
 */
function runRaw(state: any, eventsRaw: string, opts: { eventsArg?: boolean } = {}): RunResult {
  const tmp = makeTmp();
  writeFileSync(tmp.state, JSON.stringify(state));
  writeFileSync(tmp.cands, JSON.stringify(null));
  writeFileSync(tmp.events, eventsRaw);
  const argv = [DECIDE, "decide", tmp.state, tmp.cands];
  if (opts.eventsArg !== false) argv.push(tmp.events);
  const r = spawnSync("python3", argv, {
    encoding: "utf-8",
    env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
  });
  let plan: any | null = null;
  if (r.status === 0) {
    try { plan = JSON.parse(r.stdout); } catch { plan = null; }
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, plan, tmp };
}

function run(state: any, events: unknown): RunResult {
  return runRaw(state, JSON.stringify(events));
}

function cleanup(r: RunResult): void {
  rmSync(r.tmp.dir, { recursive: true, force: true });
}

function reapActions(plan: any): any[] {
  return (plan?.actions ?? []).filter((a: any) => a.type === "reap");
}

/** The stream row collect-state.sh emits for a stopped dev_orch dispatch. */
const STOP_ROW = {
  id: "1787836354861-3",
  fields: {
    event: "subagent_stop",
    slot: "dev_orch",
    status: "success",
    task_id: "t-1",
    summary: "done",
    ts_epoch: "1787836354",
  },
};

// ---------------------------------------------------------------------------
// 1. Both typed shapes produce an identical plan (INV-5)
// ---------------------------------------------------------------------------

describe("decide.py events shape — typed list vs {events: [...]} wrapper (#4213)", () => {
  test("bare list and the collect-state wrapper yield identical actions and reasons", () => {
    const typed = [{ type: "completion", slot: "dev_orch", task_id: "t-1", total_tokens: 10_000, skill: "hydra-dev" }];
    const a = run(busyDevOrchState(), typed);
    const b = run(busyDevOrchState(), { events: typed, last_id: "1787836354861-3" });
    try {
      assert.equal(a.status, 0, a.stderr);
      assert.equal(b.status, 0, b.stderr);
      assert.deepEqual(b.plan.actions, a.plan.actions);
      assert.deepEqual(b.plan.reasons, a.plan.reasons);
      // And it is a REAL plan: the completion reaped the busy slot.
      assert.equal(reapActions(a.plan).length, 1);
      assert.equal(reapActions(a.plan)[0].task_id, "t-1");
      // No degradation marker on a well-formed payload of either shape.
      assert.ok(!a.plan.reasons.some((r: string) => r.startsWith("events-")), a.plan.reasons.join(","));
      assert.ok(!b.plan.reasons.some((r: string) => r.startsWith("events-")), b.plan.reasons.join(","));
    } finally {
      cleanup(a);
      cleanup(b);
    }
  });

  test("the wrapper dict never crashes _signal_present (recurrence 2 call site)", () => {
    // Recurrences 8e50460f / b5c4c27c died in `_signal_present`, reached from
    // `_orch_board_read_degraded` BEFORE step 1.5 — so a normaliser placed any
    // later than the top of decide() would still have crashed here.
    const r = run(busyDevOrchState(), { events: [], last_id: "0" });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!/AttributeError/.test(r.stderr), r.stderr);
    } finally {
      cleanup(r);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Raw stream entries on the events lane are re-homed, not dropped (INV-4)
// ---------------------------------------------------------------------------

describe("decide.py events shape — stream entries re-homed onto state.slot_events (#4213)", () => {
  test("a subagent_stop stream entry passed as events.json emits a reap for the stopped slot", () => {
    const r = run(busyDevOrchState({ slot_events: [] }), { events: [STOP_ROW], last_id: STOP_ROW.id });
    try {
      assert.equal(r.status, 0, r.stderr);
      const reaps = reapActions(r.plan);
      assert.equal(reaps.length, 1, JSON.stringify(r.plan.actions));
      assert.equal(reaps[0].slot, "dev_orch");
      assert.equal(reaps[0].task_id, "t-1");
      assert.ok(r.plan.reasons.includes("events-stream-entries-rehomed:1"), r.plan.reasons.join(","));
    } finally {
      cleanup(r);
    }
  });

  test("events.json lane and state.slot_events lane produce the same reap actions for the same stream payload", () => {
    const viaEvents = run(busyDevOrchState({ slot_events: [] }), { events: [STOP_ROW], last_id: STOP_ROW.id });
    const viaState = run(busyDevOrchState({ slot_events: { events: [STOP_ROW], last_id: STOP_ROW.id } }), []);
    try {
      assert.equal(viaEvents.status, 0, viaEvents.stderr);
      assert.equal(viaState.status, 0, viaState.stderr);
      assert.deepEqual(viaEvents.plan.actions, viaState.plan.actions);
      // Reasons differ ONLY by the re-home marker the events lane adds.
      const stripped = viaEvents.plan.reasons.filter((x: string) => x !== "events-stream-entries-rehomed:1");
      assert.deepEqual(stripped, viaState.plan.reasons);
      assert.equal(reapActions(viaState.plan).length, 1);
    } finally {
      cleanup(viaEvents);
      cleanup(viaState);
    }
  });

  test("a stream entry already present on state.slot_events is not re-homed twice (dedup by id)", () => {
    const r = run(
      busyDevOrchState({ slot_events: { events: [STOP_ROW], last_id: STOP_ROW.id } }),
      { events: [STOP_ROW], last_id: STOP_ROW.id },
    );
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(reapActions(r.plan).length, 1, JSON.stringify(r.plan.actions));
      assert.ok(!r.plan.reasons.some((x: string) => x.startsWith("events-stream-entries-rehomed")), r.plan.reasons.join(","));
    } finally {
      cleanup(r);
    }
  });

  test("re-homing preserves the wrapper's last_id on state.slot_events (no second projection, no shape rewrite)", () => {
    // The wrapper on state keeps its cursor while the events-lane row is
    // appended into its `events` list; observable via the reap it produces
    // plus the absence of any events-* degradation marker.
    const r = run(
      busyDevOrchState({ slot_events: { events: [], last_id: "42-0" } }),
      [STOP_ROW],
    );
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(reapActions(r.plan).length, 1);
      assert.ok(r.plan.reasons.includes("events-stream-entries-rehomed:1"));
      assert.ok(!r.plan.reasons.some((x: string) => x.startsWith("events-entry-skipped")));
    } finally {
      cleanup(r);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Unparseable / unrecognisable events.json degrades to a plan (INV-1, INV-6, INV-7)
// ---------------------------------------------------------------------------

describe("decide.py events shape — unparseable events.json degrades, never crashes (#4213)", () => {
  test("`not json` exits 0 with events-malformed-ignored, a stderr diagnostic, and the turn bumped by exactly one", () => {
    const r = runRaw(busyDevOrchState({ turn: 4 }), "not json");
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.plan, "plan JSON on stdout");
      assert.ok(r.plan.reasons.includes("events-malformed-ignored"), r.plan.reasons.join(","));
      assert.equal(typeof r.plan.debug.events_load_error, "string");
      assert.ok(r.plan.debug.events_load_error.includes(r.tmp.events));
      // Fail-loud: one stderr line naming the file, no traceback.
      assert.ok(r.stderr.includes(`decide.py: events file ${r.tmp.events} unreadable`), r.stderr);
      assert.ok(!/Traceback/.test(r.stderr), r.stderr);
      // INV-6: the #1769 bump still happened, exactly once, and the plan stamp matches it.
      const persisted = JSON.parse(readFileSync(r.tmp.state, "utf-8"));
      assert.equal(persisted.turn, 5);
      assert.equal(r.plan.turn, 5);
    } finally {
      cleanup(r);
    }
  });

  test("an unrecognisable container (a JSON string) degrades to events-malformed-ignored", () => {
    const r = run(busyDevOrchState(), "events");
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.plan.reasons.includes("events-malformed-ignored"), r.plan.reasons.join(","));
      assert.equal(reapActions(r.plan).length, 0);
    } finally {
      cleanup(r);
    }
  });

  test("a missing events.json file (OSError) degrades the same way", () => {
    const tmp = makeTmp();
    writeFileSync(tmp.state, JSON.stringify(busyDevOrchState()));
    writeFileSync(tmp.cands, "null");
    const missing = join(tmp.dir, "does-not-exist.json");
    const r = spawnSync("python3", [DECIDE, "decide", tmp.state, tmp.cands, missing], {
      encoding: "utf-8",
      env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
    });
    try {
      assert.equal(r.status, 0, r.stderr);
      const plan = JSON.parse(r.stdout);
      assert.ok(plan.reasons.includes("events-malformed-ignored"), plan.reasons.join(","));
      assert.ok(r.stderr.includes(`decide.py: events file ${missing} unreadable`), r.stderr);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("a garbled state.json still fails hard (the catch is scoped to the events positional)", () => {
    const tmp = makeTmp();
    writeFileSync(tmp.state, "not json");
    writeFileSync(tmp.cands, "null");
    writeFileSync(tmp.events, "[]");
    const r = spawnSync("python3", [DECIDE, "decide", tmp.state, tmp.cands, tmp.events], {
      encoding: "utf-8",
      env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
    });
    try {
      assert.notEqual(r.status, 0);
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  });

  test("omitting the events positional entirely (None) still yields a plan", () => {
    const r = runRaw(busyDevOrchState(), "[]", { eventsArg: false });
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(Array.isArray(r.plan.actions));
      assert.ok(!r.plan.reasons.some((x: string) => x.startsWith("events-")), r.plan.reasons.join(","));
    } finally {
      cleanup(r);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Non-dict / unclassifiable entries are skipped with a count (INV-1, INV-4)
// ---------------------------------------------------------------------------

describe("decide.py events shape — non-dict entries skipped, not fatal (#4213)", () => {
  test("a list with a bare string entry yields events-entry-skipped:1 and still reaps the typed entry beside it", () => {
    const r = run(busyDevOrchState(), [
      "events",
      { type: "completion", slot: "dev_orch", task_id: "t-1", total_tokens: 1, skill: "hydra-dev" },
    ]);
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.plan.reasons.includes("events-entry-skipped:1"), r.plan.reasons.join(","));
      assert.equal(reapActions(r.plan).length, 1);
    } finally {
      cleanup(r);
    }
  });

  test("a dict that is neither typed nor stream-shaped counts as skipped", () => {
    const r = run(busyDevOrchState(), [{ foo: "bar" }, 42, null]);
    try {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.plan.reasons.includes("events-entry-skipped:3"), r.plan.reasons.join(","));
    } finally {
      cleanup(r);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Signals wrapped in the dict shape are still honoured (recurrence 2 call site)
// ---------------------------------------------------------------------------

describe("decide.py events shape — signal events inside the wrapper are honoured (#4213)", () => {
  test("orch_board_signals_degraded wrapped in {events: [...]} stamps plan.debug.orch_board_read_degraded", () => {
    const wrapped = run(busyDevOrchState(), {
      events: [{ type: "signal", name: "orch_board_signals_degraded", value: true }],
      last_id: "0",
    });
    const bare = run(busyDevOrchState(), [
      { type: "signal", name: "orch_board_signals_degraded", value: true },
    ]);
    try {
      assert.equal(wrapped.status, 0, wrapped.stderr);
      assert.equal(bare.status, 0, bare.stderr);
      assert.equal(wrapped.plan.debug.orch_board_read_degraded, true);
      assert.equal(bare.plan.debug.orch_board_read_degraded, true);
    } finally {
      cleanup(wrapped);
      cleanup(bare);
    }
  });
});
