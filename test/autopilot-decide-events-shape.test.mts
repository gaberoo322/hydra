/**
 * Regression tests for `scripts/autopilot/decide.py` — the shape of the
 * optional `events.json` positional (issue #4213, design-concept
 * issue-4213, artifact 19d4b18c0fd4e9f980c2959b7895ab95cad8b6ae42fcdfa1081e
 * 338fee1339d0).
 *
 * ISSUE #4213: three autopilot runs (7f370acb, 8e50460f, b5c4c27c) each burned
 * a Turn because Phase 3 was invoked with `collect-state.sh`'s
 * `slot_events_json` payload — `{"events": [...], "last_id": ...}` — as the
 * events positional. `decide()` did `list(events)` on the dict, iterated its
 * KEYS, and the first `for ev in events` loop (`_signal_present` via
 * `_rule_termination`, or `_rule_completion_reaps`) raised
 * `AttributeError: 'str' object has no attribute 'get'`. The whole decision
 * phase exited 1 with a traceback and no plan.
 *
 * The approved design concept fixes input handling, not the turn counter:
 *
 *   INV-1  decide() never raises on the events argument's shape; degradation is
 *          expressed as plan.reasons entries + one stderr line, never a traceback.
 *   INV-2  ONE normaliser (`_normalise_events`) at the top of decide(), ahead of
 *          step 1, so every downstream loop sees a guaranteed list[dict].
 *   INV-3  The dict-unwrap is one shared helper used by both the events.json
 *          lane and the state.slot_events lane (the asymmetry the issue names).
 *   INV-4  Raw stream entries `{id, fields}` on the events.json lane are
 *          RE-HOMED onto state.slot_events (dedup by id) so the ONE existing
 *          projection in `_rule_slot_events` translates them — a
 *          `subagent_stop` passed as events.json frees its slot.
 *   INV-5  Both shapes produce an identical Plan.
 *   INV-6  The #1769 turn bump stays BEFORE decide(); a malformed events file
 *          still consumes exactly one Turn, but that Turn now carries a Plan.
 *   INV-7  Only the OPTIONAL events positional is caught on parse failure;
 *          state.json / candidates.json keep failing hard.
 *
 * Exercised through the `decide` CLI subcommand with a frozen `--now` clock —
 * the same spawnSync harness as test/autopilot-decide.test.mts, with its own
 * tmp dir per run and no shared Redis.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// Frozen decision clock (issue #2713) so two runs of the same input are
// byte-comparable on `actions` + `reasons`.
const NOW = 1_790_000_000;

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-events-shape-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

/** A busy dev_orch slot started 60s before NOW — well inside the silent-wedge
 *  wall-clock fallback, so the ONLY way it gets reaped is a completion event. */
function busyDevOrchState(extra: Record<string, unknown> = {}): any {
  return {
    started_epoch: NOW - 600,
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
    turn: 4,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: {
      dev_orch: { skill: "hydra-dev", started: "t0", started_epoch: NOW - 60, partial_tokens: 1234, task_id: "t-1" },
      qa_orch: null, research_orch: null,
      dev_target: null, qa_target: null, research_target: null,
      design_concept_orch: null,
    },
    signal_last_fired: {
      health: NOW, sweep_orch: NOW, sweep_target: NOW,
      discover_orch: NOW, discover_target: NOW,
    },
    signals: {},
    research_force_counter: {},
    ...extra,
  };
}

interface RunResult { status: number | null; stdout: string; stderr: string; plan: any | null }

/** Run the CLI against raw file contents (events may be NON-JSON text). */
function runRaw(state: any, eventsFileText: string, candidates: any = null): { r: RunResult; t: Tmp } {
  const t = makeTmp();
  writeFileSync(t.state, JSON.stringify(state));
  writeFileSync(t.cands, JSON.stringify(candidates));
  writeFileSync(t.events, eventsFileText);
  const p = spawnSync("python3", [DECIDE, `--now=${NOW}`, "decide", t.state, t.cands, t.events], {
    encoding: "utf-8",
    env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
  });
  let plan: any | null = null;
  if (p.status === 0) {
    try { plan = JSON.parse(p.stdout); } catch { /* intentional: asserted by callers */ }
  }
  return { r: { status: p.status, stdout: p.stdout, stderr: p.stderr }, t };
}

function runDecide(state: any, events: unknown, candidates: any = null): RunResult {
  const { r, t } = runRaw(state, JSON.stringify(events), candidates);
  rmSync(t.dir, { recursive: true, force: true });
  if (r.status !== 0) {
    throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
  }
  return r;
}

function planOf(r: RunResult): any {
  return JSON.parse(r.stdout);
}

function reapsOf(plan: any): Array<{ slot: string; task_id: string }> {
  return (plan.actions ?? [])
    .filter((a: any) => a.type === "reap")
    .map((a: any) => ({ slot: a.slot, task_id: a.task_id }));
}

/** Strip the per-run freshness stamp so two plans from the same state compare
 *  on decision content only. `plan.events` carries `ts`/uuids and is excluded. */
function comparable(plan: any): { actions: unknown; reasons: unknown } {
  return { actions: plan.actions, reasons: plan.reasons };
}

const STREAM_STOP = {
  id: "1787836354861-3",
  fields: { event: "subagent_stop", slot: "dev_orch", status: "success", task_id: "t-1", ts_epoch: String(NOW - 5) },
};

describe("decide.py events.json shape normalisation (issue #4213)", () => {
  // -------------------------------------------------------------------------
  // INV-5 — typed payload: `[...]` and `{"events": [...]}` are the same plan.
  // -------------------------------------------------------------------------
  test("typed list and {events: list} wrapper yield identical actions and reasons", () => {
    const typed = [{ type: "completion", slot: "dev_orch", task_id: "t-1", total_tokens: 10_000, skill: "hydra-dev" }];
    const bare = planOf(runDecide(busyDevOrchState(), typed));
    const wrapped = planOf(runDecide(busyDevOrchState(), { events: typed, last_id: "1787836354861-3" }));
    assert.deepEqual(reapsOf(bare), [{ slot: "dev_orch", task_id: "t-1" }], "sanity: the typed completion reaps the slot");
    assert.deepEqual(comparable(wrapped), comparable(bare));
    assert.ok(
      !wrapped.reasons.some((r: string) => r.startsWith("events-")),
      `a well-formed wrapper must not emit a degradation reason: ${JSON.stringify(wrapped.reasons)}`,
    );
  });

  // -------------------------------------------------------------------------
  // INV-4 / INV-5 — a raw `subagent_stop` stream entry passed as events.json
  // frees its slot, exactly as it would from state.slot_events. This is the
  // "silent drop" case from the issue's second recurrence comment: unwrapping
  // alone would leave `ev.get("type")` None and reap nothing.
  // -------------------------------------------------------------------------
  test("a subagent_stop stream entry on the events.json lane emits a reap for the stopped slot's task_id", () => {
    const viaEvents = planOf(runDecide(busyDevOrchState(), { events: [STREAM_STOP], last_id: STREAM_STOP.id }));
    assert.deepEqual(reapsOf(viaEvents), [{ slot: "dev_orch", task_id: "t-1" }]);
    assert.ok(
      viaEvents.reasons.includes("events-stream-entries-rehomed:1"),
      `re-homing must be visible in plan.reasons: ${JSON.stringify(viaEvents.reasons)}`,
    );
  });

  test("stream payload on events.json equals the same payload on state.slot_events", () => {
    const viaEvents = planOf(runDecide(busyDevOrchState(), { events: [STREAM_STOP], last_id: STREAM_STOP.id }));
    const viaState = planOf(runDecide(
      busyDevOrchState({ slot_events: { events: [STREAM_STOP], last_id: STREAM_STOP.id } }),
      [],
    ));
    assert.deepEqual(reapsOf(viaState), [{ slot: "dev_orch", task_id: "t-1" }], "sanity: the state lane reaps");
    assert.deepEqual(viaEvents.actions, viaState.actions, "same reap actions from either lane");
    // Only the re-home telemetry reason may differ between the two lanes.
    const strip = (rs: string[]) => rs.filter((r) => !r.startsWith("events-stream-entries-rehomed:"));
    assert.deepEqual(strip(viaEvents.reasons), strip(viaState.reasons));
  });

  test("a stream entry present on BOTH lanes is deduped by id — exactly one reap", () => {
    const plan = planOf(runDecide(
      busyDevOrchState({ slot_events: { events: [STREAM_STOP], last_id: STREAM_STOP.id } }),
      { events: [STREAM_STOP], last_id: STREAM_STOP.id },
    ));
    assert.deepEqual(reapsOf(plan), [{ slot: "dev_orch", task_id: "t-1" }]);
    assert.ok(
      !plan.reasons.some((r: string) => r.startsWith("events-stream-entries-rehomed:")),
      `a duplicate must not be re-homed: ${JSON.stringify(plan.reasons)}`,
    );
  });

  // -------------------------------------------------------------------------
  // INV-1 / INV-6 / INV-7 — a wholly unparseable events.json still yields a
  // Plan (exit 0), a reason, a stderr line, and exactly one turn bump.
  // -------------------------------------------------------------------------
  test("unparseable events.json degrades to a plan with events-malformed-ignored, exit 0, one turn bump", () => {
    const { r, t } = runRaw(busyDevOrchState(), "not json {");
    try {
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
      assert.ok(!/Traceback/.test(r.stderr), `no traceback on stderr: ${r.stderr}`);
      assert.match(r.stderr, /decide\.py: events file .*events\.json unreadable \(.*\) — continuing with \[\]/);
      const plan = JSON.parse(r.stdout);
      assert.ok(plan.reasons.includes("events-malformed-ignored"), JSON.stringify(plan.reasons));
      assert.equal(typeof plan.debug.events_load_error, "string");
      // INV-6: the bump stays before decide() — turn 4 -> 5, and the plan stamp agrees.
      const persisted = JSON.parse(readFileSync(t.state, "utf-8"));
      assert.equal(persisted.turn, 5);
      assert.equal(plan.turn, 5);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("state.json parse failure still fails hard (INV-7 scopes the catch to the events positional)", () => {
    const t = makeTmp();
    try {
      writeFileSync(t.state, "not json {");
      writeFileSync(t.cands, "null");
      writeFileSync(t.events, "[]");
      const p = spawnSync("python3", [DECIDE, `--now=${NOW}`, "decide", t.state, t.cands, t.events], {
        encoding: "utf-8",
        env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
      });
      assert.notEqual(p.status, 0, "a garbled state.json is not degradable");
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // INV-1 — non-dict entries and non-container values never raise.
  // -------------------------------------------------------------------------
  test("a list containing a bare string entry is tolerated with events-entry-skipped:1", () => {
    const typed = { type: "completion", slot: "dev_orch", task_id: "t-1", total_tokens: 1, skill: "hydra-dev" };
    const plan = planOf(runDecide(busyDevOrchState(), ["events", typed]));
    assert.ok(plan.reasons.includes("events-entry-skipped:1"), JSON.stringify(plan.reasons));
    assert.deepEqual(reapsOf(plan), [{ slot: "dev_orch", task_id: "t-1" }], "the dict entry beside it is still consumed");
  });

  test("an entry that is neither typed nor stream-shaped is skipped, not re-homed", () => {
    const plan = planOf(runDecide(busyDevOrchState(), { events: [{ slot: "dev_orch", task_id: "t-1" }] }));
    assert.ok(plan.reasons.includes("events-entry-skipped:1"), JSON.stringify(plan.reasons));
    assert.deepEqual(reapsOf(plan), []);
  });

  test("a wrapper whose events value is not a list is events-malformed-ignored", () => {
    for (const bad of [{ events: "nope" }, { events: 42 }, "just a string", 7]) {
      const plan = planOf(runDecide(busyDevOrchState(), bad));
      assert.ok(
        plan.reasons.includes("events-malformed-ignored"),
        `${JSON.stringify(bad)} -> ${JSON.stringify(plan.reasons)}`,
      );
      assert.deepEqual(reapsOf(plan), []);
    }
  });

  // -------------------------------------------------------------------------
  // Recurrence 2 (run 8e50460f / b5c4c27c): the crash site was
  // `_signal_present` reached from `_rule_termination` — BEFORE step 1.5. A
  // signal delivered inside the dict wrapper must be honoured, which proves
  // the normaliser runs ahead of step 1 (INV-2).
  // -------------------------------------------------------------------------
  test("an orch_board_signals_degraded signal wrapped in the dict shape is still honoured", () => {
    const plan = planOf(runDecide(
      busyDevOrchState(),
      { events: [{ type: "signal", name: "orch_board_signals_degraded", value: true }], last_id: null },
    ));
    assert.equal(plan.debug.orch_board_read_degraded, true);
  });
});
