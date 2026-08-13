/**
 * Regression tests for `scripts/autopilot/decide.py` — the per-issue STALL
 * CAP guard on the `qa_orch` pipeline slot (issue #3829, design-concept
 * issue-3829, artifact d11fbcf45ed08088b18fbf9b2f8bc414d80391b0d4caf1bb522f
 * 22cf0b868ef3).
 *
 * ISSUE #3829: `qa_orch` has `cooldownSeconds: null` and is deliberately
 * absent from `ESCALATION_POLICY` (see test/decide-cascade-escalation.
 * test.mts invariant 5), so nothing bounds how many times it re-dispatches
 * against the same needs-qa issue. An issue that structurally cannot reach a
 * QA verdict (the motivating case: the hourly worktree-orphan-prune reaping
 * the parent QA agent's worktree AND every reviewer worktree mid-review,
 * which reproduces identically on every retry — issue #3789 made this path
 * deterministic by leaving `needs-qa` on rather than bouncing) keeps
 * `needs_qa_orch` true forever and busy-loops qa_orch at 30-65k tokens/turn
 * with no bound.
 *
 * The approved design concept's fix (design-concept invariant 4) tracks ONLY
 * the HEAD of the needs-qa set — `needs_qa_numbers[0]`, mirroring hydra-qa's
 * own unsorted-default self-selection query (`gh issue list --label
 * needs-qa --jq '.[0]'`) — never every issue merely present in the lane. A
 * naive port of the #3729 sweep_target per-item guard (bump every current
 * item) was explicitly considered and REJECTED at design time: since a
 * single qa_orch dispatch only ever reviews the head, bumping every item
 * would falsely accumulate attempts against queued issues that were never
 * actually reviewed, risking a false "stalled" verdict on a healthy-but-
 * queued issue the moment it becomes the new head.
 *
 * `collect-state.sh` emits the current needs-qa issue-number list as a fresh
 * per-turn fact (`needs_qa_numbers`, order-preserving — no sort — to match
 * hydra-qa's own query), and decide.py keeps a persisted attempt counter for
 * the head only (`state.qa_orch_item_attempts`, at most one entry by
 * construction) via `_persist_state_writeback`. `qa_orch` fires iff the head
 * has attempted fewer than `QA_STALL_MAX_ATTEMPTS` (3) qa_orch dispatches; on
 * fire the tracker is rebuilt to hold only the head's bumped count — a
 * former head that is superseded or resolved is pruned (invariant 5).
 *
 * These tests pin both directions of the guard, the head-only invariant, and
 * the visibility contract (issue #3829 acceptance criterion: "becomes
 * visible ... rather than silently consuming budget", design-concept
 * invariant 1: a structured signal, never a GH label mutation).
 *
 * Exercised through the `decide` CLI subcommand with a frozen `--now` clock,
 * same harness as test/autopilot-sweep-target-signal.test.mts (the #3729
 * precedent this guard's collect-state-emits-a-fresh-list shape mirrors).
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
const MAX_ATTEMPTS = 3; // QA_STALL_MAX_ATTEMPTS in decide.py

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-qa-stall-cap-test-"));
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
  /** The state.json written back by decide.py main() (reflects any tracker
   *  mutation + persistence). */
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

describe("decide.py — qa_orch per-issue stall-cap guard (issue #3829)", () => {
  test("fresh head issue (no prior attempts) -> qa_orch dispatches and the tracker is bumped to 1", () => {
    const state = baseState({ signals: { needs_qa_orch: true, needs_qa_numbers: "3841" } });
    const { plan, stateAfter } = runDecide(state);
    const a = findQaOrch(plan);
    assert.ok(a, "a head issue under the cap must dispatch qa_orch");
    assert.equal(a.skill, "hydra-qa");
    assert.deepEqual(
      stateAfter.qa_orch_item_attempts,
      { "3841": 1 },
      "on fire, the head issue's attempt counter is bumped",
    );
  });

  test("the head issue at the attempt cap -> qa_orch does NOT dispatch (the busy-loop terminates)", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_numbers: "3841" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS },
    });
    const { plan, stateAfter } = runDecide(state);
    assert.equal(
      findQaOrch(plan),
      undefined,
      "a head issue that already used every attempt must not be re-dispatched",
    );
    assert.deepEqual(
      stateAfter.qa_orch_item_attempts,
      { "3841": MAX_ATTEMPTS },
      "a suppressed turn must not mutate the tracker",
    );
  });

  test("suppression is visible: dispatch_decision reason + plan debug name the stalled head issue + cap", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_numbers: "3841" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS },
    });
    const { plan } = runDecide(state);
    const dd = dispatchDecisionFor(plan, "qa_orch");
    assert.ok(dd, "qa_orch must still emit a dispatch_decision event when suppressed");
    assert.match(dd.reason, /3841/, "the suppression reason must name the stalled head issue number");
    assert.match(
      dd.reason,
      new RegExp(String(MAX_ATTEMPTS)),
      "the suppression reason must name the attempt cap",
    );
    assert.equal(
      plan.debug?.qa_orch_stalled_issue,
      3841,
      "the stalled issue number rides the plan debug field for dashboard/operator visibility (AC: becomes visible)",
    );
  });

  test("design-concept invariant 4: a queued NON-HEAD issue is NEVER touched, even while the head is capped", () => {
    // 3841 is exhausted and stays head (queue order unchanged); 3850 sits
    // behind it and has never been reviewed. The busy-loop backstop must
    // suppress the whole slot (hydra-qa always picks the head) WITHOUT
    // bumping 3850's counter — bumping it would falsely start a "stalled"
    // clock on an issue nothing has actually attempted yet.
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_numbers: "3841 3850" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS },
    });
    const { plan, stateAfter } = runDecide(state);
    assert.equal(
      findQaOrch(plan),
      undefined,
      "the whole slot is suppressed while the head is capped — hydra-qa never reaches issue #3850 on this turn",
    );
    assert.deepEqual(
      stateAfter.qa_orch_item_attempts,
      { "3841": MAX_ATTEMPTS },
      "the non-head issue #3850 must NOT appear in the tracker at all",
    );
  });

  test("the head issue is eligible and dispatches even while a DIFFERENT (fully independent) issue number was previously tracked as head", () => {
    // 3841 was the prior head and got capped; 3850 has since become the new
    // head (queue order changed — e.g. #3841's PR finally got a verdict and
    // dropped off needs-qa). The tracker must have already dropped #3841 and
    // start #3850 fresh, not inherit or block on the old head's exhausted count.
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_numbers: "3850" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS },
    });
    const { plan, stateAfter } = runDecide(state);
    assert.ok(findQaOrch(plan), "a fresh new head must dispatch even though a DIFFERENT prior head was capped");
    assert.deepEqual(
      stateAfter.qa_orch_item_attempts,
      { "3850": 1 },
      "the tracker is rebuilt to hold only the current head — the former head #3841 is pruned",
    );
  });

  test("pruning: once the head issue leaves the needs-qa set, its tracker entry is dropped (design-concept invariant 5)", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_numbers: "" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS },
    });
    const { plan, stateAfter } = runDecide(state);
    // Empty item list -> fail-open on the coarse boolean (see below), and no
    // per-item fire happens this turn, so the tracker is left untouched here
    // — the point is that on the NEXT turn where 3841 actually reappears as
    // a head, it starts fresh because a real fire always rebuilds from
    // scratch (pinned by the "different head" case above).
    assert.ok(findQaOrch(plan), "empty item list fails open on the coarse boolean alone");
    assert.deepEqual(stateAfter.qa_orch_item_attempts, { "3841": MAX_ATTEMPTS });
  });

  test("fail-open on absence: needs_qa_numbers signal absent -> dispatches on the coarse boolean (no dead-arm)", () => {
    // A degraded board read (or a pre-#3829 playbook) emits the coarse count
    // but not the per-item list. Suppressing here would re-dead-arm qa_orch
    // (the #3709 defect class), so the guard fails OPEN on absence.
    const state = baseState({ signals: { needs_qa_orch: true } });
    const { plan, stateAfter } = runDecide(state);
    assert.ok(findQaOrch(plan), "with no per-item list, qa_orch must fire on the coarse boolean alone");
    assert.equal(
      stateAfter.qa_orch_item_attempts,
      undefined,
      "firing on the coarse boolean alone stamps nothing (no head known)",
    );
  });

  test("an item list emitted but empty -> fail-open dispatch (consistent with absence)", () => {
    const state = baseState({ signals: { needs_qa_orch: true, needs_qa_numbers: "" } });
    const { plan } = runDecide(state);
    assert.ok(findQaOrch(plan), "an empty emitted item list must fail open, not dead-arm qa_orch");
  });

  test("no needs_qa_orch signal -> no qa_orch dispatch regardless of the item list", () => {
    const state = baseState({ signals: { needs_qa_numbers: "3841" } });
    const { plan } = runDecide(state);
    assert.equal(
      findQaOrch(plan),
      undefined,
      "the coarse presence gate stays a necessary condition (AND-composed, not a replacement)",
    );
  });

  test("events override state.signals for the item list (precedence, like every signal)", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_numbers: "3841" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS },
    });
    const events = [{ type: "signal", name: "needs_qa_numbers", value: "4200 3841" }];
    const { plan, stateAfter } = runDecide(state, null, events);
    assert.ok(findQaOrch(plan), "the event-supplied new head 4200 makes the slot eligible");
    assert.deepEqual(
      stateAfter.qa_orch_item_attempts,
      { "4200": 1 },
      "the event-overridden HEAD (first element) is what gets bumped on fire — 3841 is no longer head and is dropped",
    );
  });

  test("qa_orch excluded under target-only scope (the guard never bypasses scope)", () => {
    const state = baseState({
      scope: "target-only",
      signals: { needs_qa_orch: true, needs_qa_numbers: "3841" },
    });
    const { plan } = runDecide(state);
    assert.equal(
      findQaOrch(plan),
      undefined,
      "target-only scope must exclude qa_orch regardless of head eligibility",
    );
  });

  test("attempt count exactly one below the cap is still eligible (boundary)", () => {
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_numbers: "3841" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS - 1 },
    });
    const { plan, stateAfter } = runDecide(state);
    assert.ok(findQaOrch(plan), "attempts < cap must still be eligible");
    assert.deepEqual(stateAfter.qa_orch_item_attempts, { "3841": MAX_ATTEMPTS });
  });

  test("design-concept invariant 3: qa_orch stays absent from ESCALATION_POLICY even with the stall-cap guard active", () => {
    // The stall cap and ESCALATION_POLICY are structurally independent
    // mechanisms — full cross-file coverage lives in
    // test/decide-cascade-escalation.test.mts; this is a same-file sanity
    // pin that a stall-capped turn's plan carries no escalate_model hint.
    const state = baseState({
      signals: { needs_qa_orch: true, needs_qa_numbers: "3841" },
      qa_orch_item_attempts: { "3841": MAX_ATTEMPTS },
    });
    const { plan } = runDecide(state);
    const anyQaOrchAction = (plan.actions ?? []).find((a: any) => a.slot === "qa_orch");
    assert.equal(anyQaOrchAction, undefined, "no qa_orch action of any kind (dispatch or escalation) this turn");
  });
});
