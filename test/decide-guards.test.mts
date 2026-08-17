/**
 * decide.py — dispatch guards, caps and dampeners (issue #4136 consolidation).
 *
 * Merged verbatim from five one-file-per-issue test files:
 * decide-qa-stall-cap, decide-dev-resume-pending,
 * decide-context-compaction-restart, decide-discover-staleness-floor,
 * decide-shadow-dampener.
 *
 * All five ask the same question of the same subject — "under what condition
 * does decide.py SUPPRESS or REDIRECT a dispatch it would otherwise make?" —
 * and all five spawn scripts/autopilot/decide.py rather than importing from
 * src/. Grouping them by that concern is what makes the file navigable; the
 * previous split was by originating issue number, which is not a concern.
 *
 * Each source file's body is wrapped in its own block so its module-scope
 * REPO_ROOT / DECIDE / fixtures stay private — block nesting does not change
 * node:test nesting, so every describe() below is still top-level. No test
 * text was edited.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ===========================================================================
// Merged from test/decide-qa-stall-cap.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
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
}

// ===========================================================================
// Merged from test/decide-dev-resume-pending.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Regression tests for `scripts/autopilot/decide.py` — draining
 * `state.dev_resume_pending` (issue #3866).
 *
 * Motivating incident: a `dev_orch` dispatch (hydra-dev) did ~9.5 min of real
 * implementation, backgrounded `npm test`, then ended its turn waiting on the
 * test run instead of opening a PR. reap.py's completion accounting treated
 * that as an ordinary finished cycle, so the anchor's issue stayed usable by
 * hydra-dev's own `ready-for-agent` self-selection — the NEXT autopilot turn
 * re-dispatched the SAME anchor from a brand-new worktree, silently re-paying
 * the tokens already spent on the first (incomplete) attempt.
 *
 * The fix has two halves. reap.py (tested separately in
 * test/autopilot-dev-resume-stall.test.mts) detects a dev_orch completion
 * with no open PR referencing its anchor, relabels the issue away from
 * `ready-for-agent` to `needs-dev-resume`, and appends a resume record to
 * `state.dev_resume_pending`. This file pins the decide.py half: the
 * `dev_orch` selector in `_select_for_slot` drains that queue AHEAD of the
 * ordinary `orch_work_available` fresh-pick gate, pinning the dispatch back
 * to the stalled anchor (carrying `prompt_args.resume_branch` when known)
 * instead of leaving it to rot under a label nothing else consumes — and
 * pops the drained entry so the SAME stall is never pinned twice.
 */








const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-dev-resume-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

interface StateOverrides {
  signals?: Record<string, unknown>;
  dev_resume_pending?: unknown;
}

function baseState(o: StateOverrides = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      scope: "all",
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
    ...(o.dev_resume_pending !== undefined ? { dev_resume_pending: o.dev_resume_pending } : {}),
  };
}

function runDecide(state: any, candidates: any = null, events: any[] = []): { plan: any; statePath: string } {
  const t = makeTmp();
  writeFileSync(t.state, JSON.stringify(state));
  writeFileSync(t.cands, JSON.stringify(candidates));
  writeFileSync(t.events, JSON.stringify(events));
  const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    rmSync(t.dir, { recursive: true, force: true });
    throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
  }
  return { plan: JSON.parse(r.stdout), statePath: t.state };
}

function findAction(plan: any, predicate: (a: any) => boolean): any | undefined {
  return (plan.actions ?? []).find(predicate);
}

const devOrch = (a: any) => a.type === "dispatch" && a.slot === "dev_orch";

describe("decide.py — dev_resume_pending drain (issue #3866)", () => {
  test("a pending stall pins dev_orch to the stalled anchor, even with no fresh ready-for-agent work", () => {
    const state = baseState({
      signals: {}, // orch_work_available NOT set — board otherwise empty
      dev_resume_pending: [
        { anchor: "issue-3726", task_id: "worktree-agent-abc-t1-dev_orch", branch: "issue-3726-fix", stalled_epoch: 1000 },
      ],
    });
    const { plan, statePath } = runDecide(state);
    try {
      const a = findAction(plan, devOrch);
      assert.ok(a, "dev_orch must dispatch to drain a pending resume even when orch_work_available is unset");
      assert.equal(a.skill, "hydra-dev");
      assert.equal(a.prompt_args.anchor, "issue-3726");
      assert.equal(a.prompt_args.resume, true);
      assert.equal(a.prompt_args.resume_branch, "issue-3726-fix");
      assert.match(a.reason, /resuming stalled dev_orch anchor issue-3726/);

      const persisted = JSON.parse(readFileSync(statePath, "utf-8"));
      assert.deepEqual(
        persisted.dev_resume_pending,
        [],
        "the drained entry must be popped and persisted so it is never pinned twice",
      );
    } finally {
      rmSync(resolve(statePath, ".."), { recursive: true, force: true });
    }
  });

  test("a pending stall takes priority over a fresh ready-for-agent pick", () => {
    const state = baseState({
      signals: { orch_work_available: true },
      dev_resume_pending: [
        { anchor: "issue-42", task_id: "t1", branch: "", stalled_epoch: 1000 },
      ],
    });
    const { plan, statePath } = runDecide(state);
    try {
      const a = findAction(plan, devOrch);
      assert.ok(a, "dev_orch must dispatch");
      assert.equal(
        a.prompt_args.anchor,
        "issue-42",
        "the resume queue must be drained before the generic ready-for-agent self-select path",
      );
      assert.equal(
        a.prompt_args.resume_branch,
        undefined,
        "an empty branch string must not be forwarded as resume_branch",
      );
    } finally {
      rmSync(resolve(statePath, ".."), { recursive: true, force: true });
    }
  });

  test("no dev_resume_pending + orch_work_available still dispatches the ordinary fresh pick (no anchor pinned)", () => {
    const state = baseState({ signals: { orch_work_available: true } });
    const { plan, statePath } = runDecide(state);
    try {
      const a = findAction(plan, devOrch);
      assert.ok(a, "dev_orch must dispatch on ordinary ready-for-agent availability");
      assert.equal(a.skill, "hydra-dev");
      assert.equal(
        a.prompt_args.anchor,
        undefined,
        "the ordinary self-select path must not pin an anchor (regression guard)",
      );
    } finally {
      rmSync(resolve(statePath, ".."), { recursive: true, force: true });
    }
  });

  test("empty dev_resume_pending array + no orch work → dev_orch idles (no crash on empty list)", () => {
    const state = baseState({ signals: {}, dev_resume_pending: [] });
    const { plan, statePath } = runDecide(state);
    try {
      assert.equal(findAction(plan, devOrch), undefined, "dev_orch must idle when there is nothing to do");
    } finally {
      rmSync(resolve(statePath, ".."), { recursive: true, force: true });
    }
  });

  test("dev_orch slot already occupied → resume queue is untouched this turn", () => {
    const state = baseState({
      signals: {},
      dev_resume_pending: [
        { anchor: "issue-99", task_id: "t9", branch: "b9", stalled_epoch: 1000 },
      ],
    });
    state.slots.dev_orch = {
      skill: "hydra-dev",
      started_epoch: Math.floor(Date.now() / 1000) - 60,
      task_id: "worktree-agent-live-t1-dev_orch",
      partial_tokens: 0,
    };
    const { plan, statePath } = runDecide(state);
    try {
      assert.equal(findAction(plan, devOrch), undefined, "an occupied slot must not dispatch a second dev_orch");
      const persisted = JSON.parse(readFileSync(statePath, "utf-8"));
      assert.deepEqual(
        persisted.dev_resume_pending,
        [{ anchor: "issue-99", task_id: "t9", branch: "b9", stalled_epoch: 1000 }],
        "the pending queue must survive untouched when the slot is busy — the selector never ran",
      );
    } finally {
      rmSync(resolve(statePath, ".."), { recursive: true, force: true });
    }
  });
});
}

// ===========================================================================
// Merged from test/decide-context-compaction-restart.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * test/decide-context-compaction-restart.test.mts — regression tests for the
 * periodic session-restart terminate cause (issue #3787, filed from research
 * #3750: hydra-autopilot's own decide loop consumes 23.2% of the weekly
 * subscription quota, driven by prompt-cache re-read growth within a single
 * long-lived session).
 *
 * `decide.py._check_termination` gains a new terminate cause,
 * `context_compaction`, fired every N **Autopilot Turns** (default 8,
 * tunable via `state.limits.context_compaction_turns`; 0 disables it). It
 * reuses the exact same `terminate` action shape and turn-ending
 * short-circuit as the existing `budget` / `wall_clock` / `idle` /
 * `failure_backstop` causes, so these tests exercise it through the same
 * `decide.py decide` CLI the autopilot playbook calls (mirrors
 * test/decide-events.test.mts).
 *
 * Unit note: the default is 8, not the issue's literal "80-120" — that
 * figure was computed over the sampled transcript's raw Anthropic API calls,
 * not over `state.turn` (one `decide.py decide` invocation); the design
 * concept for #3787 rescales it by the sampled run's ~12.25 raw-calls-per-
 * Autopilot-Turn ratio. See `CONTEXT_COMPACTION_TURNS_DEFAULT` in decide.py.
 *
 * Pinned acceptance criteria (issue #3787):
 *   - fires at the configured cadence, not before
 *   - defaults to 8 when the state carries no override
 *   - a 0 (or non-positive/unparseable) override disables it entirely
 *   - fires even with occupied pipeline slots (unlike `idle`)
 *   - a higher-priority terminate cause (budget) on the SAME turn still wins
 *   - `turn_end` still closes the turn on a context_compaction termination
 *     (mirrors the existing budget-exhaustion short-circuit test)
 */








const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-context-compaction-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

/**
 * A minimal-but-valid state.json, mirroring test/decide-events.test.mts's
 * `baseState`. `turn` here is the PRE-bump value the CLI reads from disk —
 * `decide.py decide`'s #1769 single-writer counter bumps it by 1 BEFORE
 * decide() runs, so `turn: 7` means `_check_termination` sees `turn == 8`.
 */
function baseState(o: Partial<{
  run_id: string;
  turn: number;
  started_epoch: number;
  cumulative_tokens: number;
  occupySlot: boolean;
  limitsOverride: Record<string, unknown>;
}> = {}): unknown {
  return {
    run_id: o.run_id ?? "abcdef1234-5678-90ab-cdef-1234567890ab",
    turn: o.turn ?? 0,
    started_epoch: o.started_epoch ?? Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      scope: "all",
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
      ...(o.limitsOverride ?? {}),
    },
    cumulative_tokens: o.cumulative_tokens ?? 12_345,
    dispatches: 0,
    idle_turns: 0,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: {
      dev_orch: o.occupySlot
        ? { skill: "hydra-dev", started: "now", partial_tokens: 0 }
        : null,
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
      scout_orch: 0,
    },
    signals: {},
    research_force_counter: {},
  };
}

function runDecide(state: unknown): {
  actions: Array<Record<string, unknown>>;
  reasons: string[];
  debug: Record<string, unknown>;
  events: Array<Record<string, string>>;
} {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(null));
    writeFileSync(t.events, JSON.stringify([]));
    const r = spawnSync(
      "python3",
      [DECIDE, "decide", t.state, t.cands, t.events],
      {
        encoding: "utf-8",
        // Keep the CLI a pure JSON emitter — no live run-end POST from the
        // test process (mirrors decide-events.test.mts / decide-golden.test.mts).
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

function terminateAction(plan: { actions: Array<Record<string, unknown>> }): Record<string, unknown> | undefined {
  return plan.actions.find((a) => a.type === "terminate");
}

describe("decide.py — periodic session-restart terminate cause (issue #3787)", () => {
  test("fires context_compaction exactly at the configured cadence", () => {
    const plan = runDecide(
      baseState({ turn: 7, limitsOverride: { context_compaction_turns: 8 } }),
    );
    const term = terminateAction(plan);
    assert.ok(term, "expected a terminate action at turn=8 with cadence=8");
    assert.equal(term!.cause, "context_compaction");
    assert.equal(term!.type, "terminate");
    assert.match(String(term!.reason), /turn=8/);
    assert.match(String(term!.reason), /cadence=8/);
  });

  test("does not fire before the cadence is reached", () => {
    const plan = runDecide(
      baseState({ turn: 5, limitsOverride: { context_compaction_turns: 8 } }),
    );
    // turn bumps 5 -> 6, not a multiple of 8.
    const term = terminateAction(plan);
    if (term) {
      assert.notEqual(term.cause, "context_compaction");
    }
  });

  test("defaults to an 8-turn cadence when state carries no override", () => {
    const state = baseState({ turn: 7 }) as { limits: Record<string, unknown> };
    delete state.limits.context_compaction_turns;
    const plan = runDecide(state);
    const term = terminateAction(plan);
    assert.ok(term, "expected the built-in 8-turn default to fire at turn=8");
    assert.equal(term!.cause, "context_compaction");
  });

  test("a 0 override disables the periodic restart entirely", () => {
    const plan = runDecide(
      baseState({ turn: 7, limitsOverride: { context_compaction_turns: 0 } }),
    );
    const term = terminateAction(plan);
    if (term) {
      assert.notEqual(term.cause, "context_compaction");
    }
  });

  test("an unparseable override degrades to the built-in default rather than crashing", () => {
    const plan = runDecide(
      baseState({ turn: 7, limitsOverride: { context_compaction_turns: "not-a-number" } }),
    );
    const term = terminateAction(plan);
    assert.ok(term, "expected the default cadence to still apply on a garbage override");
    assert.equal(term!.cause, "context_compaction");
  });

  test("a custom cadence fires repeatedly within a run", () => {
    const cadenceLimits = { context_compaction_turns: 3 };
    // turn=2 -> bump=3 -> fires.
    const fires = runDecide(baseState({ turn: 2, limitsOverride: cadenceLimits }));
    assert.equal(terminateAction(fires)?.cause, "context_compaction");
    // turn=3 -> bump=4 -> not a multiple of 3, must not fire.
    const skips = runDecide(baseState({ turn: 3, limitsOverride: cadenceLimits }));
    const skipTerm = terminateAction(skips);
    if (skipTerm) {
      assert.notEqual(skipTerm.cause, "context_compaction");
    }
    // turn=5 -> bump=6 -> fires again.
    const firesAgain = runDecide(baseState({ turn: 5, limitsOverride: cadenceLimits }));
    assert.equal(terminateAction(firesAgain)?.cause, "context_compaction");
  });

  test("fires even with an occupied pipeline slot (unlike idle)", () => {
    const plan = runDecide(
      baseState({
        turn: 7,
        occupySlot: true,
        limitsOverride: { context_compaction_turns: 8 },
      }),
    );
    assert.equal(
      terminateAction(plan)?.cause,
      "context_compaction",
      "context_compaction must fire regardless of slots_occupied — a busy run is exactly the scenario accumulating the most cache-read growth",
    );
  });

  test("a same-turn budget exhaustion outranks the periodic-restart cadence", () => {
    const plan = runDecide(
      baseState({
        turn: 7,
        cumulative_tokens: 2_000_000,
        limitsOverride: { context_compaction_turns: 8 },
      }),
    );
    const term = terminateAction(plan);
    assert.ok(term, "expected a terminate action");
    assert.equal(term!.cause, "budget", "budget must win over context_compaction on the same turn");
  });

  test("turn_end still closes the turn on a context_compaction termination", () => {
    const plan = runDecide(
      baseState({ turn: 7, limitsOverride: { context_compaction_turns: 8 } }),
    );
    assert.equal(terminateAction(plan)?.cause, "context_compaction");
    const ends = plan.events.filter((e) => e.event === "turn_end");
    assert.equal(ends.length, 1, "turn_end must fire on a context_compaction termination too");
  });
});
}

// ===========================================================================
// Merged from test/decide-discover-staleness-floor.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Regression tests for `scripts/autopilot/decide.py` — the `discover_orch`
 * staleness floor (issue #4114).
 *
 * Root cause (#4114, corroborated by
 * docs/research/2026-08-08-discover-orch-dispatch-and-model-routing-rootcause.md):
 * `discover_orch`'s ONLY trigger was the shared `orch_backfill_idle`
 * board-empty signal, which requires ready_for_agent==0 AND needs_research==0
 * AND needs_triage==0 AND work_queue==0 SIMULTANEOUSLY. A healthy,
 * continuously-stocked orch board (live evidence 2026-07-26..2026-08-17:
 * 5-36 ready-for-agent items at every sample) keeps that conjunction false
 * indefinitely, so the producer class went structurally dark — 0 dispatches
 * since its #959 revival, and #3920's cooldown carry-forward fix (live,
 * deployed) was orthogonal: the selector simply never had a true input.
 * architecture_orch / cleanup_orch share the symptom (last fired 2026-07-25)
 * and are deliberately NOT fixed here (design-concept INV-3: this change
 * scopes the floor to discover_orch only; the class-parameterized helper
 * exists so a follow-up can extend it to the siblings).
 *
 * The fix: `discover_orch`'s selector fires on `orch_backfill_idle` OR a
 * 7-day staleness floor derived purely from
 * `state.signal_last_fired['discover_orch']` + `now` (ADR-0007 purity,
 * INV-1). A NEVER-fired class (last == 0) counts as dark — the exact #4114
 * live state — deliberately inverting signal_starved's never-fired semantics
 * (that floor is an intra-turn stagger override where "never fired" is normal
 * cold-start; this one is a gate-level producer trigger where "never fired"
 * IS the dark state to break). Floor dispatches carry a distinguishable
 * reason string (INV-4, mirroring the signal_starved annotation pattern).
 *
 * We exercise decide.py through its `decide` CLI subcommand so the tests pin
 * the JSON wire contract the playbook prose consumes (same harness as
 * decide-retro-class.test.mts).
 */








const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

const FLOOR_SEC = 7 * 24 * 60 * 60;

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-discover-floor-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

interface StateOverrides {
  scope?: string;
  burned_classes?: string[];
  signal_last_fired?: Record<string, number>;
  signals?: Record<string, unknown>;
}

// A BUSY board: orch_backfill_idle absent/false (the structural norm on a
// healthy, stocked board — the condition that starved the class for 3+ weeks).
function baseState(o: StateOverrides = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
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
    burned_classes: o.burned_classes ?? [],
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
      // 6 days ago — inside the 1h cooldown AND inside the 7d floor: the
      // "recently ran, nothing due" default for the sibling classes below.
      discover_orch: Math.floor(Date.now() / 1000) - 6 * 24 * 60 * 60,
      discover_target: 0,
      architecture_orch: Math.floor(Date.now() / 1000) - 6 * 24 * 60 * 60,
      cleanup_orch: Math.floor(Date.now() / 1000) - 6 * 24 * 60 * 60,
    },
    signals: o.signals ?? {},
    research_force_counter: {},
  };
}

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(candidates));
    writeFileSync(t.events, JSON.stringify(events));
    const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

function findAction(plan: any, predicate: (a: any) => boolean): any | undefined {
  return (plan.actions ?? []).find(predicate);
}

function discoverDispatch(plan: any): any | undefined {
  return findAction(plan, (x) => x.type === "dispatch" && x.slot === "discover_orch");
}

describe("decide.py — discover_orch staleness floor (issue #4114)", () => {
  test("floor fires on a NEVER-fired class (last == 0) under a busy board — the #4114 live state", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        health: 0,
        sweep_orch: 0,
        sweep_target: 0,
        discover_orch: 0, // never fired — maximally dark
        discover_target: 0,
        architecture_orch: now - 22 * 24 * 60 * 60, // the live sibling symptom
        cleanup_orch: now - 22 * 24 * 60 * 60,
      },
    });
    const plan = runDecide(state, null);
    const a = discoverDispatch(plan);
    assert.ok(
      a,
      "discover_orch must dispatch via the staleness floor when it has never fired, even on a busy (non-idle) board",
    );
    assert.equal(a.skill, "hydra-discover");
  });

  test("floor fires when the class has been dark longer than 7d under a busy board", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        discover_orch: now - (FLOOR_SEC + 60), // just past the floor
        architecture_orch: now - 6 * 24 * 60 * 60,
        cleanup_orch: now - 6 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      discoverDispatch(plan),
      "discover_orch must dispatch once dark > 7d, even with orch_backfill_idle false",
    );
  });

  test("floor does NOT fire inside the 7d window on a busy board (recently ran)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        discover_orch: now - (FLOOR_SEC - 60 * 60), // 7d minus 1h — inside
        architecture_orch: now - 6 * 24 * 60 * 60,
        cleanup_orch: now - 6 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      discoverDispatch(plan),
      undefined,
      "no idle signal and dark < 7d → no dispatch (the floor is 7d, not the 1h cooldown)",
    );
  });

  test("the 1h class cooldown still gates the floor path (dark > 7d BUT fired 30min ago is impossible-by-construction; a 30min-old stamp must suppress)", () => {
    // A 30min-old stamp is necessarily inside the 7d floor too, so this pins
    // that the COOLDOWN check (signal_is_cooled, first gate in
    // _select_for_signal) still applies ahead of the floor: a hypothetical
    // floor shorter than the cooldown could never re-fire inside the window.
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        discover_orch: now - 30 * 60, // 30min ago — inside the 1h cooldown
        architecture_orch: now - 6 * 24 * 60 * 60,
        cleanup_orch: now - 6 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      discoverDispatch(plan),
      undefined,
      "the per-class 1h cooldown must suppress the floor path inside its window",
    );
  });

  test("idle path still fires and keeps its idle reason (existing #959 behavior unchanged)", () => {
    const state = baseState({ signals: { orch_backfill_idle: true } });
    const plan = runDecide(state, null);
    const a = discoverDispatch(plan);
    assert.ok(a, "discover_orch must still dispatch on orch_backfill_idle");
    assert.match(
      String(a.reason),
      /idle/,
      "the idle-triggered dispatch keeps the idle-worded reason",
    );
    assert.doesNotMatch(
      String(a.reason),
      /staleness floor/,
      "the idle path must NOT borrow the floor's reason",
    );
  });

  test("floor-triggered dispatch is distinguishable in the audit trail via its reason (INV-4)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        discover_orch: now - (FLOOR_SEC + 60),
        architecture_orch: now - 6 * 24 * 60 * 60,
        cleanup_orch: now - 6 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    const a = discoverDispatch(plan);
    assert.ok(a, "floor dispatch must be present");
    assert.match(
      String(a.reason),
      /staleness floor/i,
      "the floor-triggered reason must name the staleness floor (mirroring the signal_starved annotation pattern)",
    );
  });

  test("architecture_orch does NOT gain the floor (busy board, dark 22d) — INV-3, siblings keep idle-only gating", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signal_last_fired: {
        discover_orch: now - (FLOOR_SEC + 60),
        architecture_orch: now - 22 * 24 * 60 * 60, // dark 22d — the live symptom
        cleanup_orch: now - 22 * 24 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(discoverDispatch(plan), "discover_orch fires via its floor");
    assert.equal(
      findAction(plan, (x) => x.type === "dispatch" && x.slot === "architecture_orch"),
      undefined,
      "architecture_orch must stay idle-only in this change (deferred follow-up, not this PR)",
    );
    assert.equal(
      findAction(plan, (x) => x.type === "dispatch" && x.slot === "cleanup_orch"),
      undefined,
      "cleanup_orch must stay idle-only in this change (deferred follow-up, not this PR)",
    );
  });

  test("target-only scope still excludes the floor path (scope mask is the outer gate)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      scope: "target-only",
      signal_last_fired: {
        discover_orch: 0, // never fired — floor met
        architecture_orch: now - 22 * 24 * 60 * 60,
        cleanup_orch: now - 22 * 24 * 60 * 60,
      },
    });
    const plan = runDecide(state, null);
    assert.equal(
      discoverDispatch(plan),
      undefined,
      "target-only scope must exclude discover_orch even when the floor is met (INV-008)",
    );
  });

  test("burned_classes still suppresses the floor path", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      burned_classes: ["discover_orch"],
      signal_last_fired: {
        discover_orch: 0, // never fired — floor met
        architecture_orch: now - 22 * 24 * 60 * 60,
        cleanup_orch: now - 22 * 24 * 60 * 60,
      },
    });
    const plan = runDecide(state, null);
    assert.equal(
      discoverDispatch(plan),
      undefined,
      "a burned (soft-capped) discover_orch must not dispatch via the floor (issue #432)",
    );
  });

  test("stagger on a fully idle board still allows only ONE backfill dispatch per turn", () => {
    // last fired 2h ago for BOTH backfill classes: past the 1h cooldown, NOT
    // past the 24h BACKFILL_STARVATION_FLOOR (a starved class legitimately
    // bypasses the stagger as an additive exception, so 6d-old stamps would
    // make BOTH dispatch — that is #2428 behavior, not a stagger violation).
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: {
        discover_orch: now - 2 * 60 * 60,
        architecture_orch: now - 2 * 60 * 60,
        cleanup_orch: now - 2 * 60 * 60,
      } as any,
    });
    const plan = runDecide(state, null);
    const backfill = (plan.actions ?? []).filter(
      (a: any) =>
        a.type === "dispatch" && (a.slot === "discover_orch" || a.slot === "architecture_orch"),
    );
    assert.ok(backfill.length === 1, `exactly one backfill dispatch per turn, got ${backfill.length}`);
    assert.equal(backfill[0].slot, "discover_orch", "discover_orch is ahead in the iteration order");
  });
});
}

// ===========================================================================
// Merged from test/decide-shadow-dampener.test.mts (issue #4136) — every test verbatim.
// ===========================================================================
{
/**
 * Regression tests for `scripts/autopilot/decide.py` — the SHADOW-MODE per-class
 * dampener (issue #2943).
 *
 * The design-concept invariants this pins:
 *   - decide() output (actions/events) is BYTE-IDENTICAL with the shadow
 *     computation present vs absent — no dispatch behavior changes in this issue.
 *   - decide.py stays a PURE function of state.json: it reads the injected
 *     class-stats verdict but NEVER fetches dispatch history itself; the verdict
 *     arrives via collect-state.sh injection only.
 *   - The shadow log records, per turn, the cadence multiplier that WOULD be
 *     applied and the verdict behind it — and ONLY for classes it would dampen
 *     (multiplier != 1.0). It actuates nothing (`actuated: false`).
 *
 * We exercise decide.py through its `decide` CLI subcommand so the tests also
 * pin the JSON wire contract, and point HYDRA_CLASS_STATS_SHADOW_LOG at a tmp
 * file so the shadow write is observable + isolated.
 *
 * Own top-level describe with its own lifecycle.
 */








const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// Fixed decision clock shared by every runDecide() call in this file (issue
// #3820). `NOW_EPOCH` is the value passed to decide.py via `--now`;
// `STARTED_EPOCH` is a fixed epoch 100s before it, used as `state.started_epoch`
// so `elapsed` (= NOW_EPOCH - STARTED_EPOCH = 100) stays comfortably under the
// default `wall_clock_max_sec` (28_800s) and decide() exercises its normal
// (non-terminating) decision path deterministically.
//
// Previously `started_epoch` was `Math.floor(Date.now() / 1000)` — a LIVE
// clock read racing the fixed `--now`. That produced two problems: (1) the
// resulting `elapsed` (~14.5M seconds, since NOW_EPOCH sits in 2027) exceeded
// `wall_clock_max_sec` and silently made every run exercise decide.py's
// wall-clock TERMINATION short-circuit instead of the real decision pipeline
// this suite means to pin; (2) because two separate `baseState()` calls in
// the same test each read the real clock independently, `elapsed`/`epoch` in
// decide.py's stdout drifted by 1s whenever the two calls straddled a real
// wall-clock second boundary under full-suite load — the exact off-by-one
// race reported in #3820. Pinning both ends of the clock removes the race
// and lets the byte-identical assertion actually cover the normal path.
const NOW_EPOCH = 1_800_000_000;
const STARTED_EPOCH = NOW_EPOCH - 100;

function baseState(overrides: Record<string, unknown> = {}): any {
  return {
    started_epoch: STARTED_EPOCH,
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      scope: "all",
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: 0,
    turn: 3,
    run_id: "abcd1234-run",
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
    signals: {},
    research_force_counter: {},
    ...overrides,
  };
}

/** An injected class_stats blob with one underperforming class (dampened). */
function classStatsInjection(): any {
  return {
    scoreboard: { classes: [] },
    shadow: {
      computedAt: 1_800_000_000_000,
      reprobeHours: 24,
      verdicts: [
        {
          className: "dev_orch",
          multiplier: 2.0,
          reprobeAt: 1_800_000_000_000 + 24 * 3600 * 1000,
          verdict: "underperforming",
        },
        // A healthy class at 1.0 — must NOT be logged.
        { className: "qa_orch", multiplier: 1.0, reprobeAt: null, verdict: "not-scored" },
      ],
    },
  };
}

/**
 * Run decide.py with a given state. `shadowLog` points the shadow-log env var
 * at a tmp path so the write is observable. Returns the parsed plan + the raw
 * stdout (for the byte-identical comparison) + the shadow-log contents.
 */
function runDecide(
  state: any,
  shadowLog: string,
): { plan: any; stdout: string; shadowLines: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "decide-shadow-test-"));
  try {
    const sPath = join(dir, "state.json");
    const cPath = join(dir, "candidates.json");
    const ePath = join(dir, "events.json");
    writeFileSync(sPath, JSON.stringify(state));
    writeFileSync(cPath, JSON.stringify(null));
    writeFileSync(ePath, JSON.stringify([]));
    // --now pins the decision clock so the two runs (shadow on/off) are
    // deterministically comparable byte-for-byte.
    const r = spawnSync(
      "python3",
      [DECIDE, `--now=${NOW_EPOCH}`, "decide", sPath, cPath, ePath],
      {
        encoding: "utf-8",
        env: { ...process.env, HYDRA_CLASS_STATS_SHADOW_LOG: shadowLog },
      },
    );
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    const shadowLines = existsSync(shadowLog)
      ? readFileSync(shadowLog, "utf-8").split("\n").filter((l) => l.trim())
      : [];
    return { plan: JSON.parse(r.stdout), stdout: r.stdout, shadowLines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("decide.py — shadow-mode dampener (issue #2943)", () => {
  test("plan output is BYTE-IDENTICAL with class_stats present vs absent", () => {
    const withLog = join(mkdtempSync(join(tmpdir(), "shadow-with-")), "log");
    const withoutLog = join(mkdtempSync(join(tmpdir(), "shadow-without-")), "log");

    // NOTE: turn is bumped in-place by decide.py's CLI, but --now pins the clock
    // and the state is otherwise identical, so the emitted plan must match.
    const withStats = runDecide(
      baseState({ class_stats: classStatsInjection() }),
      withLog,
    );
    const withoutStats = runDecide(baseState(), withoutLog);

    assert.equal(
      withStats.stdout,
      withoutStats.stdout,
      "the plan must be byte-identical whether or not class_stats was injected",
    );
  });

  test("the shadow log records ONLY the dampened class (multiplier != 1.0), actuating nothing", () => {
    const logPath = join(mkdtempSync(join(tmpdir(), "shadow-log-")), "log");
    const { shadowLines } = runDecide(
      baseState({ class_stats: classStatsInjection() }),
      logPath,
    );
    assert.equal(shadowLines.length, 1, "only the underperforming class is logged");
    const row = JSON.parse(shadowLines[0]);
    assert.equal(row.class, "dev_orch");
    assert.equal(row.would_apply_multiplier, 2.0);
    assert.equal(row.verdict, "underperforming");
    assert.equal(row.actuated, false, "shadow mode actuates nothing");
    assert.equal(row.turn, 4, "turn is the CLI-bumped value (3 → 4)");
  });

  test("no class_stats injection → no shadow log written (clean no-op)", () => {
    const logPath = join(mkdtempSync(join(tmpdir(), "shadow-noop-")), "log");
    const { shadowLines } = runDecide(baseState(), logPath);
    assert.equal(shadowLines.length, 0, "absent class_stats writes nothing");
  });

  test("an all-1.0 shadow plan writes nothing (no class would be dampened)", () => {
    const logPath = join(mkdtempSync(join(tmpdir(), "shadow-allhealthy-")), "log");
    const healthy = {
      scoreboard: { classes: [] },
      shadow: {
        computedAt: 1_800_000_000_000,
        reprobeHours: 24,
        verdicts: [
          { className: "dev_orch", multiplier: 1.0, reprobeAt: null, verdict: "healthy" },
          { className: "research_orch", multiplier: 1.0, reprobeAt: null, verdict: "healthy" },
        ],
      },
    };
    const { shadowLines } = runDecide(baseState({ class_stats: healthy }), logPath);
    assert.equal(shadowLines.length, 0, "all-healthy → nothing to log");
  });
});
}
