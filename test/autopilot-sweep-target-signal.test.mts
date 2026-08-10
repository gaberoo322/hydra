/**
 * Regression tests for `scripts/autopilot/decide.py` — the per-item verdict-
 * stability guard on the `sweep_target` signal class (issue #3729).
 *
 * ISSUE #3729 (re-scoped 2026-07-26 by the design-concept grill): `sweep_target`
 * fires on `needs_triage_target` (raw `needs-triage` label count on the Target
 * board) with a 900s class cooldown and no saturation cap. The Target's
 * `needs-triage` lane holds time-gated wire-or-retire candidates, and successive
 * sweeps at the 900s cooldown reached MUTUALLY CONTRADICTORY verdicts on the same
 * items (the evidence: hydra-betting#631 took 10 label events in 28h; #626 took
 * 12 in 36h) — verdict thrash, not indefinite parking. The original Option A
 * (pre-qualify the signal by date-gating) was struck as actively harmful: it
 * suppresses the very dispatches that promoted #626/#631 out of the lane.
 *
 * The fix is a PER-ITEM verdict-stability guard (the literal distinction from
 * the rejected class-level Option B): `collect-state.sh` emits the current
 * needs-triage item-number set as a fresh per-turn fact
 * (`target_needs_triage_items`), and decide.py keeps a per-item stamp map
 * (`state.target_triage_item_stamps`) persisted via `_persist_state_writeback`.
 * `sweep_target` fires iff >=1 item in the current set has no stamp OR a stamp
 * older than a fixed backoff window; on fire, every item in the CURRENT set is
 * stamped (uniform clock reset) and stamps for items that left the set are
 * pruned. The 900s class cooldown stays a necessary, independent condition.
 *
 * These tests pin both directions of the guard (design-concept invariant 10):
 *   (a) all-current-items-freshly-stamped → no sweep_target dispatch this turn;
 *   (b) an item with no stamp (or a stamp older than the backoff window) present
 *       in the set → sweep_target DOES dispatch.
 *
 * Exercised through the `decide` CLI subcommand with a frozen `--now` clock and
 * a short `HYDRA_TARGET_TRIAGE_BACKOFF_SEC`, so the assertions are independent
 * of the production 6h default (same harness as
 * test/decide-target-board-dispatch.test.mts).
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// A short backoff so the test is independent of the production 6h default.
// TARGET_TRIAGE_BACKOFF_SEC is resolved once at decide.py import time, and each
// spawnSync is a fresh python process, so the override takes effect per run.
const BACKOFF_SEC = 60;
const NOW = 10_000_000;

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-sweep-target-test-"));
  return { dir, state: join(dir, "state.json"), cands: join(dir, "cands.json"), events: join(dir, "events.json") };
}

interface StateOverrides {
  scope?: string;
  signal_last_fired?: Record<string, number>;
  signals?: Record<string, unknown>;
  target_triage_item_stamps?: Record<string, number>;
}

function baseState(o: StateOverrides = {}): any {
  return {
    // started_epoch near `now` so the wall-clock termination check never trips.
    started_epoch: NOW - 1000,
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
    ...(o.target_triage_item_stamps
      ? { target_triage_item_stamps: o.target_triage_item_stamps }
      : {}),
  };
}

/** A candidate feed that does NOT recommend research, so only the sweep_target
 *  signal under test can drive the Target branch. */
const feedNoResearch = {
  candidates: [{ anchorRef: "item-1", score: 0.9 }],
  research_recommended: false,
};

interface RunResult {
  plan: any;
  /** The state.json written back by decide.py main() (reflects any stamp map
   *  mutation + persistence). */
  stateAfter: any;
}

function runDecide(state: any, candidates: any, events: any[] = []): RunResult {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(candidates));
    writeFileSync(t.events, JSON.stringify(events));
    const r = spawnSync(
      "python3",
      [DECIDE, "decide", t.state, t.cands, t.events, `--now=${NOW}`],
      {
        encoding: "utf-8",
        env: { ...process.env, HYDRA_TARGET_TRIAGE_BACKOFF_SEC: String(BACKOFF_SEC) },
      },
    );
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return { plan: JSON.parse(r.stdout), stateAfter: JSON.parse(readFileSync(t.state, "utf-8")) };
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

const sweepTarget = (a: any) => a.type === "dispatch" && a.slot === "sweep_target";
function findSweep(plan: any): any | undefined {
  return (plan.actions ?? []).find(sweepTarget);
}

describe("decide.py — sweep_target per-item verdict-stability guard (issue #3729)", () => {
  test("AC1 (direction a): all current items freshly stamped → no sweep_target dispatch", () => {
    // Both items were examined within the backoff window, so re-dispatching would
    // just re-confirm the same verdict (the thrash the guard exists to stop). The
    // coarse needs_triage_target boolean stays TRUE (INV-3) — only the per-item
    // eligibility suppresses the dispatch.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626 631" },
      target_triage_item_stamps: { "626": NOW - 10, "631": NOW - 5 },
    });
    const { plan, stateAfter } = runDecide(state, feedNoResearch);
    assert.equal(
      findSweep(plan),
      undefined,
      "a lane whose every item was checked inside the backoff window must not re-dispatch",
    );
    // No fire → no write-back of the stamp map (it stays exactly as seeded).
    assert.deepEqual(
      stateAfter.target_triage_item_stamps,
      { "626": NOW - 10, "631": NOW - 5 },
      "a suppressed turn must not mutate the stamp map",
    );
  });

  test("AC2 (direction b): an unstamped item in the set → sweep_target dispatches", () => {
    // 631 is new to the lane (no stamp) → immediately eligible (INV-2), even
    // though 626 was checked moments ago. A per-item clock (not a class-wide
    // one) is the whole point: a fresh item is never starved by a sibling.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626 631" },
      target_triage_item_stamps: { "626": NOW - 10 },
    });
    const { plan, stateAfter } = runDecide(state, feedNoResearch);
    const a = findSweep(plan);
    assert.ok(a, "an unstamped item in the set must dispatch sweep_target");
    assert.equal(a.skill, "hydra-target-sweep");
    // On fire, EVERY item in the current set is stamped (uniform clock reset).
    assert.deepEqual(
      stateAfter.target_triage_item_stamps,
      { "626": NOW, "631": NOW },
      "on fire, every current item is stamped to now (INV-4)",
    );
  });

  test("direction b: an item with a stamp older than the backoff window → dispatches", () => {
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626" },
      target_triage_item_stamps: { "626": NOW - (BACKOFF_SEC + 60) },
    });
    const { plan } = runDecide(state, feedNoResearch);
    assert.ok(
      findSweep(plan),
      "an item whose stamp aged past the backoff window is eligible again",
    );
  });

  test("pruning: stamps for items absent from the current set are dropped on fire (INV-5)", () => {
    // 999 left the needs-triage lane; 626 aged out and is eligible. On fire the
    // stamp map is rebuilt from the CURRENT set only, so 999 is pruned.
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626" },
      target_triage_item_stamps: { "626": NOW - (BACKOFF_SEC + 60), "999": NOW - 10 },
    });
    const { stateAfter } = runDecide(state, feedNoResearch);
    assert.deepEqual(
      stateAfter.target_triage_item_stamps,
      { "626": NOW },
      "a fire rebuilds the stamp map from the current set, pruning departed items",
    );
  });

  test("the 900s class cooldown remains a necessary condition (INV-1)", () => {
    // An eligible (unstamped) item, but sweep_target fired 100s ago — inside its
    // 900s class cooldown. The per-item guard is AND-composed with the cooldown,
    // never a replacement, so the dispatch is suppressed by the cooldown.
    const state = baseState({
      signal_last_fired: {
        health: 0,
        sweep_orch: 0,
        sweep_target: NOW - 100, // inside the 900s class cooldown
        discover_orch: 0,
        discover_target: 0,
      },
      signals: { needs_triage_target: true, target_needs_triage_items: "626" },
      // 626 has no stamp → eligible by the per-item guard.
    });
    const { plan } = runDecide(state, feedNoResearch);
    assert.equal(
      findSweep(plan),
      undefined,
      "the class-level 900s cooldown must still suppress even an eligible item",
    );
  });

  test("fail-open on absence: items absent + needs_triage_target true → dispatches (no dead-arm)", () => {
    // A degraded board read (or a pre-#3729 playbook) emits the coarse count but
    // not the per-item list. Suppressing here would re-dead-arm sweep_target
    // (the #3709 defect class), so the guard fails OPEN on absence.
    const state = baseState({ signals: { needs_triage_target: true } });
    const { plan, stateAfter } = runDecide(state, feedNoResearch);
    assert.ok(
      findSweep(plan),
      "with no per-item list, sweep_target must fire on the coarse boolean alone",
    );
    assert.equal(
      stateAfter.target_triage_item_stamps,
      undefined,
      "firing on the coarse boolean alone stamps nothing (no item set known)",
    );
  });

  test("no needs_triage_target signal → no sweep_target dispatch", () => {
    const state = baseState({ signals: { target_needs_triage_items: "626" } });
    const { plan } = runDecide(state, feedNoResearch);
    assert.equal(
      findSweep(plan),
      undefined,
      "an empty Target triage lane must not dispatch sweep_target",
    );
  });

  test("an item list emitted but empty → fail-open dispatch (consistent with absence)", () => {
    // collect-state emits `target_needs_triage_items=` (empty) on a degraded
    // read. decide.py treats an empty set the same as absence: no per-item
    // granularity, so fall back to the coarse boolean (fail open).
    const state = baseState({ signals: { needs_triage_target: true, target_needs_triage_items: "" } });
    const { plan } = runDecide(state, feedNoResearch);
    assert.ok(
      findSweep(plan),
      "an empty emitted item list must fail open, not dead-arm the sweep",
    );
  });

  test("events override state.signals for the item set (precedence, like every signal)", () => {
    // state.signals says all-fresh, but the live event stream carries a new
    // unstamped item 700. Events take precedence (the _signal_present contract).
    const state = baseState({
      signals: { needs_triage_target: true, target_needs_triage_items: "626" },
      target_triage_item_stamps: { "626": NOW - 5 }, // 626 fresh
    });
    const events = [
      { type: "signal", name: "target_needs_triage_items", value: "626 700" },
    ];
    const { plan, stateAfter } = runDecide(state, feedNoResearch, events);
    assert.ok(findSweep(plan), "the event-supplied new item 700 makes the set eligible");
    assert.deepEqual(
      stateAfter.target_triage_item_stamps,
      { "626": NOW, "700": NOW },
      "the event-overridden current set is what gets stamped on fire",
    );
  });

  test("sweep_target excluded under orch-only scope (the guard never bypasses scope)", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { needs_triage_target: true, target_needs_triage_items: "626" },
    });
    const { plan } = runDecide(state, feedNoResearch);
    assert.equal(
      findSweep(plan),
      undefined,
      "orch-only scope must exclude the Target sweep class regardless of eligibility",
    );
  });
});
