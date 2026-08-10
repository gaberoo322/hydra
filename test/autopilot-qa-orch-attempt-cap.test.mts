/**
 * Regression tests for `scripts/autopilot/decide.py` — the per-issue
 * attempt-cap guard on the `qa_orch` pipeline slot (issue #3829).
 *
 * ISSUE #3829: `qa_orch` has `cooldownSeconds: null` and is absent from
 * `ESCALATION_POLICY` (deliberately — see test/decide-cascade-escalation.
 * test.mts invariant 5), so nothing bounds how many times it re-dispatches
 * against the same needs-qa issue. An issue that structurally cannot reach a
 * QA verdict (the motivating case: the hourly worktree-orphan-prune reaping
 * the parent QA agent's worktree AND every reviewer worktree mid-review,
 * which reproduces identically on every retry — issue #3789 made this path
 * deterministic by leaving `needs-qa` on rather than bouncing) keeps
 * `needs_qa_orch` true forever and busy-loops qa_orch at 30-65k tokens/turn
 * with no bound.
 *
 * The fix mirrors the #3729 sweep_target per-item verdict-stability guard,
 * adapted from a TIME backoff to an ATTEMPT COUNT cap: `collect-state.sh`
 * emits the current needs-qa issue-number set as a fresh per-turn fact
 * (`needs_qa_orch_items`), and decide.py keeps a per-issue attempt counter
 * (`state.qa_orch_item_attempts`) persisted via `_persist_state_writeback`.
 * `qa_orch` fires iff >=1 issue in the current set has attempted fewer than
 * `QA_ORCH_ITEM_MAX_ATTEMPTS` (3) qa_orch dispatches; on fire, every issue in
 * the CURRENT set has its counter bumped (uniform advance) and counters for
 * issues that left the set are pruned. Unlike #3729 (a throttle that always
 * re-opens once the backoff window elapses), this is a hard STOP once an
 * issue's count reaches the cap — the acceptance criterion is "stops being
 * re-dispatched", not "re-dispatched less often".
 *
 * These tests pin both directions of the guard plus the visibility contract
 * (issue #3829 acceptance criterion: "becomes visible ... rather than
 * silently consuming budget"):
 *   (a) every current issue at/over the cap -> no qa_orch dispatch, and the
 *       suppression is named in the plan's dispatch_decision reason + debug;
 *   (b) an issue under the cap present in the set -> qa_orch DOES dispatch.
 *
 * Exercised through the `decide` CLI subcommand with a frozen `--now` clock,
 * same harness as test/autopilot-sweep-target-signal.test.mts (the #3729
 * precedent this guard mirrors).
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

const NOW = 10_000_000;
const MAX_ATTEMPTS = 3; // QA_ORCH_ITEM_MAX_ATTEMPTS in decide.py

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-qa-orch-attempt-cap-test-"));
  return { dir, state: join(dir, "state.json"), cands: join(dir, "cands.json"), events: join(dir, "events.json") };
}

interface StateOverrides {
  scope?: string;
  signals?: Record<string, unknown>;
  qa_orch_item_attempts?: Record<string, number>;
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
    signal_last_fired: {
      health: 0,
      sweep_orch: 0,
      sweep_target: 0,
      discover_orch: 0,
      discover_target: 0,
    },
    signals: o.signals ?? {},
    research_force_counter: {},
    ...(o.qa_orch_item_attempts ? { qa_orch_item_attempts: o.qa_orch_item_attempts } : {}),
  };
}

interface RunResult {
  plan: any;
  /** The state.json written back by decide.py main() (reflects any attempt
   *  map mutation + persistence). */
  stateAfter: any;
}

function runDecide(state: any, candidates: any = null, events: any[] = []): RunResult {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(candidates));
    writeFileSync(t.events, JSON.stringify(events));
    const r = spawnSync(
      "python3",
      [DECIDE, `--now=${NOW}`, "decide", t.state, t.cands, t.events],
      { encoding: "utf-8" },
    );
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return { plan: JSON.parse(r.stdout), stateAfter: JSON.parse(readFileSync(t.state, "utf-8")) };
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

const qaOrch = (a: any) => a.type === "dispatch" && a.slot === "qa_orch";
function findQaOrch(plan: any): any | undefined {
  return (plan.actions ?? []).find(qaOrch);
}
function dispatchDecisionFor(plan: any, cls: string): any | undefined {
  return (plan.events ?? []).find((e: any) => e.event === "dispatch_decision" && e.class === cls);
}

describe("decide.py — qa_orch per-issue attempt-cap guard (issue #3829)", () => {
  test("fresh issue (no prior attempts) -> qa_orch dispatches and the counter is bumped to 1", () => {
    const state = baseState({ signals: { needs_qa_orch: true, needs_qa_orch_items: "3841" } });
    const { plan, stateAfter } = runDecide(state);
    const a = findQaOrch(plan);
    assert.ok(a, "an issue under the cap must dispatch qa_orch");
    assert.equal(a.skill, "hydra-qa");
    assert.deepEqual(
      stateAfter.qa_orch_item_attempts,
      { "3841": 1 },
      "on fire, every current issue's attempt counter is bumped",
    );
  });

  test("an issue at the attempt cap -> qa_orch does NOT dispatch (the busy-loop terminates)", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_orch_items: "3841" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS },
    });
    const { plan, stateAfter } = runDecide(state);
    assert.equal(
      findQaOrch(plan),
      undefined,
      "an issue that already used every attempt must not be re-dispatched",
    );
    assert.deepEqual(
      stateAfter.qa_orch_item_attempts,
      { "3841": MAX_ATTEMPTS },
      "a suppressed turn must not mutate the attempt map",
    );
  });

  test("suppression is visible: dispatch_decision reason names the exhausted issue + cap", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_orch_items: "3841" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS },
    });
    const { plan } = runDecide(state);
    const dd = dispatchDecisionFor(plan, "qa_orch");
    assert.ok(dd, "qa_orch must still emit a dispatch_decision event when suppressed");
    assert.match(
      dd.reason,
      /3841/,
      "the suppression reason must name the exhausted issue number",
    );
    assert.match(
      dd.reason,
      new RegExp(String(MAX_ATTEMPTS)),
      "the suppression reason must name the attempt cap",
    );
    assert.deepEqual(
      plan.debug?.stale_needs_qa_orch_items,
      [3841],
      "the exhausted issue numbers ride the plan debug field for dashboard/operator visibility (AC: becomes visible)",
    );
  });

  test("a fresh issue alongside an exhausted one -> qa_orch STILL dispatches (per-issue, not class-wide)", () => {
    // The busy-loop backstop must not starve OTHER needs-qa issues just
    // because one is permanently stuck — only the exhausted issue is denied.
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_orch_items: "3841 3850" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS, "3850": 0 },
    });
    const { plan, stateAfter } = runDecide(state);
    assert.ok(findQaOrch(plan), "a co-present eligible issue must still trigger a dispatch");
    assert.deepEqual(
      stateAfter.qa_orch_item_attempts,
      { "3841": MAX_ATTEMPTS + 1, "3850": 1 },
      "on fire, every current issue's counter is bumped uniformly, including the already-exhausted one",
    );
  });

  test("pruning: an attempt counter for an issue no longer in the set is dropped on fire (mirrors #3729 INV-5)", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_orch_items: "3841" },
      qa_orch_item_attempts: { "3841": 1, "9999": MAX_ATTEMPTS },
    });
    const { stateAfter } = runDecide(state);
    assert.deepEqual(
      stateAfter.qa_orch_item_attempts,
      { "3841": 2 },
      "a fire rebuilds the attempt map from the current set only, pruning departed issues",
    );
  });

  test("a departed exhausted issue can be re-opened fresh: absent from the set -> no attempt entry to inherit", () => {
    // Issue 9999 was exhausted, then dropped off needs-qa (resolved or the PR
    // got a fresh revision). It is simply absent from the emitted item set —
    // pruning (above) means a LATER re-open under the same number starts at 0.
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_orch_items: "" },
      qa_orch_item_attempts: { "9999": MAX_ATTEMPTS },
    });
    const { plan, stateAfter } = runDecide(state);
    // Empty item list -> fail-open on the coarse boolean (see below), and no
    // per-item fire happens, so the attempt map is left untouched here — but
    // the key point is 9999 is never CONSULTED once absent from the set.
    assert.ok(findQaOrch(plan), "empty item list fails open on the coarse boolean alone");
    assert.deepEqual(stateAfter.qa_orch_item_attempts, { "9999": MAX_ATTEMPTS });
  });

  test("fail-open on absence: needs_qa_orch_items signal absent -> dispatches on the coarse boolean (no dead-arm)", () => {
    // A degraded board read (or a pre-#3829 playbook) emits the coarse count
    // but not the per-item list. Suppressing here would re-dead-arm qa_orch
    // (the #3709 defect class), so the guard fails OPEN on absence.
    const state = baseState({ signals: { needs_qa_orch: true } });
    const { plan, stateAfter } = runDecide(state);
    assert.ok(findQaOrch(plan), "with no per-item list, qa_orch must fire on the coarse boolean alone");
    assert.equal(
      stateAfter.qa_orch_item_attempts,
      undefined,
      "firing on the coarse boolean alone stamps nothing (no item set known)",
    );
  });

  test("an item list emitted but empty -> fail-open dispatch (consistent with absence)", () => {
    const state = baseState({ signals: { needs_qa_orch: true, needs_qa_orch_items: "" } });
    const { plan } = runDecide(state);
    assert.ok(findQaOrch(plan), "an empty emitted item list must fail open, not dead-arm qa_orch");
  });

  test("no needs_qa_orch signal -> no qa_orch dispatch regardless of the item list", () => {
    const state = baseState({ signals: { needs_qa_orch_items: "3841" } });
    const { plan } = runDecide(state);
    assert.equal(
      findQaOrch(plan),
      undefined,
      "the coarse presence gate stays a necessary condition (AND-composed, not a replacement)",
    );
  });

  test("events override state.signals for the item set (precedence, like every signal)", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_orch_items: "3841" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS },
    });
    const events = [{ type: "signal", name: "needs_qa_orch_items", value: "3841 4200" }];
    const { plan, stateAfter } = runDecide(state, null, events);
    assert.ok(findQaOrch(plan), "the event-supplied new issue 4200 makes the set eligible");
    assert.deepEqual(
      stateAfter.qa_orch_item_attempts,
      { "3841": MAX_ATTEMPTS + 1, "4200": 1 },
      "the event-overridden current set is what gets bumped on fire",
    );
  });

  test("qa_orch excluded under target-only scope (the guard never bypasses scope)", () => {
    const state = baseState({
      scope: "target-only",
      signals: { needs_qa_orch: true, needs_qa_orch_items: "3841" },
    });
    const { plan } = runDecide(state);
    assert.equal(
      findQaOrch(plan),
      undefined,
      "target-only scope must exclude qa_orch regardless of per-issue eligibility",
    );
  });

  test("attempt count exactly one below the cap is still eligible (boundary)", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_orch_items: "3841" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS - 1 },
    });
    const { plan, stateAfter } = runDecide(state);
    assert.ok(findQaOrch(plan), "attempts < cap must still be eligible");
    assert.deepEqual(stateAfter.qa_orch_item_attempts, { "3841": MAX_ATTEMPTS });
  });
});
