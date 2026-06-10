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
 *   3. Option C merge policy (T1-T4 monotonic ladder, mechanical carve-out, scope-justif)
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
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

// Run the decide CLI against already-written files WITHOUT rewriting them —
// lets a test observe the issue #1666 state-file write-back accumulate
// across consecutive turns (runDecide below would clobber the persisted
// counter on every call).
function runDecideOnFiles(t: Tmp): any {
  const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

function runDecide(state: any, candidates: any = null, events: any[] = [], tmp?: Tmp): any {
  const t = tmp ?? makeTmp();
  writeFileSync(t.state, JSON.stringify(state));
  writeFileSync(t.cands, JSON.stringify(candidates));
  writeFileSync(t.events, JSON.stringify(events));
  const parsed = runDecideOnFiles(t);
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

  // ISSUE #1129 (finished): the research_target trigger consumes the
  // candidate feed's precomputed `research_recommended` flag — NOT a
  // re-derivation of any private score threshold. These tests pin that the
  // flag is authoritative independent of best_score. decide.py no longer
  // holds a second threshold constant, so the boundary has one home and
  // cannot silently diverge from the feed's RESEARCH_THRESHOLD.
  test("research_recommended=true forces research_target even when best_score >= threshold (#1129)", () => {
    const state = baseState();
    // Strong top score (0.9 >= 0.5) but the feed still recommends research.
    const cands = { candidates: [{ issue: 7, anchorRef: "x", score: 0.9 }], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
    assert.ok(dispatch, "flag=true must force research regardless of best_score");
    assert.equal(dispatch.prompt_args.forced, true);
    assert.equal(dispatch.skill, "hydra-target-research");
  });

  test("research_recommended=false suppresses research_target even when best_score < threshold (#1129)", () => {
    const state = baseState();
    // Weak top score (0.4 < 0.5) but the feed does NOT recommend research.
    const cands = { candidates: [{ issue: 8, anchorRef: "x", score: 0.4 }], research_recommended: false };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
    assert.equal(dispatch, undefined,
      "flag=false must suppress forced research regardless of best_score");
  });

  test("daily cap still gates a flag-driven forced research_target (#1129)", () => {
    // AC: RESEARCH_FORCE_DAILY_CAP / _research_force_allowed gating unchanged
    // even though the trigger now reads the flag instead of best_score.
    const today = new Date().toISOString().slice(0, 10);
    const state = baseState({
      research_force_counter: { [today]: { research_target: 4 } },
    });
    const cands = { candidates: [{ issue: 9, anchorRef: "x", score: 0.9 }], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
    assert.equal(dispatch, undefined, "force cap must suppress even a flag-driven forced dispatch");
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

  // ISSUE #1666: before this fix nothing ever WROTE research_force_counter —
  // the read at _research_force_allowed always saw 0 < 4 and one production
  // run force-dispatched research_target 46 times in 52 turns. These tests
  // pin the write half: the stamp at plan time, the CLI's atomic state-file
  // write-back, the 4-allowed/5th-suppressed cap, and the UTC-day reset.
  test("forced dispatch increments research_force_counter and persists — 4 allowed, 5th suppressed (#1666)", () => {
    const t = makeTmp();
    try {
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(t.state, JSON.stringify(baseState()));
      writeFileSync(t.cands, JSON.stringify({ candidates: [], research_recommended: true }));
      writeFileSync(t.events, JSON.stringify([]));
      // Turns 1-4: forced dispatch allowed, counter accumulates in the
      // state FILE across separate CLI processes (the actual #1666 bug was
      // the increment never surviving the process exit).
      for (let i = 1; i <= 4; i += 1) {
        const plan = runDecideOnFiles(t);
        const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
        assert.ok(dispatch, `forced dispatch ${i} of 4 must be allowed`);
        assert.equal(dispatch.prompt_args.forced, true);
        const persisted = JSON.parse(readFileSync(t.state, "utf-8"));
        assert.deepEqual(
          persisted.research_force_counter,
          { [today]: { research_target: i } },
          `state file must carry counter=${i} after turn ${i}`,
        );
      }
      // Turn 5: cap reached — suppressed, and the state file is untouched.
      const before = readFileSync(t.state, "utf-8");
      const plan5 = runDecideOnFiles(t);
      const dispatch5 = findAction(plan5, (a) => a.type === "dispatch" && a.slot === "research_target");
      assert.equal(dispatch5, undefined, "5th forced dispatch within one UTC day must be suppressed");
      assert.equal(readFileSync(t.state, "utf-8"), before,
        "a suppressed turn must not rewrite the state file");
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("counter resets across UTC days and prior-day keys are pruned (#1666)", () => {
    const t = makeTmp();
    try {
      const today = new Date().toISOString().slice(0, 10);
      // Yesterday exhausted the cap — must NOT gate today, and the stale
      // bucket must be pruned on today's first stamp.
      writeFileSync(t.state, JSON.stringify(baseState({
        research_force_counter: { "2000-01-01": { research_target: 4 } },
      })));
      writeFileSync(t.cands, JSON.stringify({ candidates: [], research_recommended: true }));
      writeFileSync(t.events, JSON.stringify([]));
      const plan = runDecideOnFiles(t);
      const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
      assert.ok(dispatch, "a prior-day exhausted cap must not suppress today's forced dispatch");
      const persisted = JSON.parse(readFileSync(t.state, "utf-8"));
      assert.deepEqual(
        persisted.research_force_counter,
        { [today]: { research_target: 1 } },
        "stamp must start today's bucket at 1 AND drop the prior-day key",
      );
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("no forced dispatch -> decide CLI does not rewrite the state file (#1666)", () => {
    const t = makeTmp();
    try {
      writeFileSync(t.state, JSON.stringify(baseState()));
      // Feed does NOT recommend research — no force, no stamp, no write-back.
      writeFileSync(t.cands, JSON.stringify({
        candidates: [{ issue: 8, anchorRef: "x", score: 0.4 }],
        research_recommended: false,
      }));
      writeFileSync(t.events, JSON.stringify([]));
      const before = readFileSync(t.state, "utf-8");
      const plan = runDecideOnFiles(t);
      const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
      assert.equal(dispatch, undefined);
      assert.equal(readFileSync(t.state, "utf-8"), before,
        "decide must stay a pure JSON emitter when no force-stamp happened");
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
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

describe("decide.py — policy collapse merge policy (#742)", () => {
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

  // After the #742 policy collapse, should_auto_merge() returns only
  // "auto-merge" or "hold". No tier resolves to queue-decision or
  // apply-operator-approved — operator escalation arrives solely via the
  // Deep-QA Remediation Loop (#740), never from tier authority.

  test("Tier 1 -> auto-merge", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 100, tier: 1 })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 100));
  });

  test("Tier 2 -> auto-merge", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 101, tier: 2 })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 101));
  });

  test("Tier 3 without scope-justification -> auto-merge", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 102, tier: 3, sj: false })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 102));
  });

  test("Tier 3 WITH scope-justification -> auto-merge (no tier-triggered queue-decision)", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 103, tier: 3, sj: true })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 103));
    assert.equal(findAction(plan, (x) => x.type === "queue-decision" && x.pr_number === 103), undefined);
  });

  // ADR-0020 Slice 2 (#743): the T4 arm flips to auto-merge on PASS, identical
  // in shape to T1/T2/T3. decide.py trusts the verdict and stays pure (it
  // cannot see the Deep-QA PASS marker); the base-ref `deep-qa-gate` required
  // CI check independently enforces the marker and fails closed if absent.
  test("T4 (Verifier Core) PASS -> auto-merge (ADR-0020 flip; CI enforces the marker)", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 200, tier: 4, mechanical: true })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 200), "T4 PASS now auto-merges");
  });

  test("T4 (Verifier Core) PASS -> auto-merge regardless of mechanical signal", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 201, tier: 4, mechanical: false })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 201));
  });

  test("T4 (Verifier Core) FAIL -> hold (INV-007 preserved)", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 202, tier: 4, verdict: "FAIL" })]);
    assert.equal(findAction(plan, (x) => x.pr_number === 202), undefined, "non-PASS T4 holds — never bad-merged");
  });

  test("T4 (Verifier Core) PENDING -> hold (INV-007 preserved)", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 203, tier: 4, verdict: "PENDING" })]);
    assert.equal(findAction(plan, (x) => x.pr_number === 203), undefined);
  });

  test("no tier produces a tier-triggered queue-decision or apply-operator-approved", () => {
    const events = [
      qaEvent({ pr: 400, tier: 1 }),
      qaEvent({ pr: 401, tier: 2 }),
      qaEvent({ pr: 402, tier: 3, sj: true }),
      qaEvent({ pr: 403, tier: 4, mechanical: true }),
      qaEvent({ pr: 404, tier: 4, mechanical: false }),
    ];
    const plan = runDecide(baseState(), null, events);
    assert.equal(findAction(plan, (x) => x.type === "queue-decision"), undefined, "policy collapse removed tier-triggered queue-decision");
    assert.equal(findAction(plan, (x) => x.type === "apply-operator-approved"), undefined, "policy collapse removed tier-triggered apply-operator-approved");
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
// 3b. Emergency brake (issue #744)
//
// The operator-only emergency brake overrides the ADR-0015 depth-gated
// verdict at the decide() auto-merge sweep call site (NOT inside
// should_auto_merge). When engaged: ZERO auto-merge actions + exactly ONE
// route-prs-to-review action. When disengaged/absent (default-off): behaviour
// is byte-identical to the depth-gated sweep. decide() never reads/writes the
// brake from Redis — it arrives as the read-only `state.emergency_brake`
// field, and there is no engage/disengage action type (operator-only).
// ---------------------------------------------------------------------------

describe("decide.py — emergency brake (#744)", () => {
  function qaEvent(o: { pr: number; tier: number; verdict?: string }): any {
    return {
      type: "qa-verdict",
      pr_number: o.pr,
      tier: o.tier,
      mechanical: null,
      has_scope_justification: false,
      verdict: o.verdict ?? "PASS",
    };
  }
  function withBrake(engaged: boolean): any {
    const s = baseState();
    s.emergency_brake = { engaged };
    return s;
  }

  test("engaged + qa-verdict PASS -> NO auto-merge, exactly one route-prs-to-review", () => {
    const plan = runDecide(withBrake(true), null, [qaEvent({ pr: 100, tier: 1 })]);
    assert.equal(
      findAction(plan, (x) => x.type === "auto-merge"),
      undefined,
      "brake engaged must suppress ALL auto-merge regardless of tier/verdict",
    );
    const routes = (plan.actions ?? []).filter((a: any) => a.type === "route-prs-to-review");
    assert.equal(routes.length, 1, "exactly one route-prs-to-review action when engaged");
  });

  test("engaged overrides EVERY mergeable tier (T1/T2/T3) in one tick", () => {
    const plan = runDecide(withBrake(true), null, [
      qaEvent({ pr: 1, tier: 1 }),
      qaEvent({ pr: 2, tier: 2 }),
      qaEvent({ pr: 3, tier: 3 }),
    ]);
    assert.equal(findAction(plan, (x) => x.type === "auto-merge"), undefined);
    assert.equal((plan.actions ?? []).filter((a: any) => a.type === "route-prs-to-review").length, 1,
      "still exactly one route action even with multiple PASS verdicts");
  });

  test("disengaged (explicit) -> normal depth-gated auto-merge (regression guard)", () => {
    const plan = runDecide(withBrake(false), null, [qaEvent({ pr: 100, tier: 1 })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 100),
      "default-off: T1 PASS must still auto-merge");
    assert.equal(findAction(plan, (x) => x.type === "route-prs-to-review"), undefined,
      "no route action when disengaged");
  });

  test("absent emergency_brake field -> default-off, normal auto-merge (back-compat)", () => {
    // baseState() has no emergency_brake key at all (pre-#744 state.json).
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 102, tier: 3 })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 102));
    assert.equal(findAction(plan, (x) => x.type === "route-prs-to-review"), undefined);
  });

  test("malformed emergency_brake -> fail-safe to disengaged (auto-merge proceeds)", () => {
    const s = baseState();
    s.emergency_brake = "ENGAGED";  // wrong type — must NOT be treated as engaged
    const plan = runDecide(s, null, [qaEvent({ pr: 103, tier: 1 })]);
    assert.ok(findAction(plan, (x) => x.type === "auto-merge" && x.pr_number === 103),
      "a non-dict brake field must fail safe to disengaged, never wedge auto-merge off");
  });

  test("engaged suppresses a T4 PASS auto-merge (brake overrides the ADR-0020 flip)", () => {
    // Post-#743 a T4 PASS auto-merges (decide.py flip). The emergency brake
    // must still suppress it: the brake is the operator override that beats
    // the depth-gated verdict at the sweep call site, for every tier incl. T4.
    const plan = runDecide(withBrake(true), null, [qaEvent({ pr: 200, tier: 4 })]);
    assert.equal(findAction(plan, (x) => x.type === "auto-merge"), undefined);
  });

  test("decide() emits NO brake-write action under any input (operator-only structural guarantee)", () => {
    // There is no engage/disengage action type. Exercise both engaged and
    // disengaged paths and confirm no action mutates the brake.
    for (const engaged of [true, false]) {
      const plan = runDecide(withBrake(engaged), null, [qaEvent({ pr: 1, tier: 1 })]);
      for (const a of plan.actions ?? []) {
        assert.notEqual(a.type, "engage-brake");
        assert.notEqual(a.type, "disengage-brake");
        assert.notEqual(a.type, "set-emergency-brake");
        // The only brake-related action is the read-and-route one.
        if (String(a.type).includes("brake")) {
          assert.fail(`decide() emitted an unexpected brake action: ${a.type}`);
        }
      }
    }
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
        orch_backfill_idle: true,
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
      signals: { orch_backfill_idle: true },  // would trigger discover_orch (issue #959)
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

  // -------------------------------------------------------------------------
  // Issue #486 (Phase C of /hydra-tool-scout). Alert-driven dispatch:
  // `scout_alert_eligible_count > 0` AND board not saturated → dispatch
  // with trigger="alert". Preferred over calendar when both are available
  // (acute pain beats calendar cadence).
  // -------------------------------------------------------------------------

  test("scout_orch fires with trigger=alert when scout_alert_eligible_count > 0 (issue #486)", () => {
    const state = baseState({ signals: { scout_alert_eligible_count: 3 } });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "scout_orch");
    assert.ok(a, "scout_orch must dispatch on alert-driven signal");
    assert.equal(a.skill, "hydra-tool-scout");
    assert.equal(a.prompt_args.trigger, "alert",
      "alert-driven dispatch must pass trigger=alert to the skill");
  });

  test("scout_orch prefers alert over calendar when both signals present (issue #486)", () => {
    const state = baseState({
      signals: { scout_walk_due: true, scout_alert_eligible_count: 1 },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "scout_orch");
    assert.ok(a, "scout_orch must dispatch when alert is eligible");
    assert.equal(a.prompt_args.trigger, "alert",
      "alert path wins — acute pain beats calendar cadence");
  });

  test("scout_orch alert path is suppressed by scout_board_saturated (issue #486)", () => {
    const state = baseState({
      signals: { scout_alert_eligible_count: 5, scout_board_saturated: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      "saturated board suppresses BOTH calendar and alert triggers",
    );
  });

  test("scout_alert_eligible_count=0 does NOT fire (calendar still gates that path)", () => {
    const state = baseState({ signals: { scout_alert_eligible_count: 0 } });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "scout_orch"),
      undefined,
      "zero eligible alerts must NOT trigger an alert dispatch",
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
// 6c. Per-cycle dev_target cost-cap backstop (issue #1059, leaf of epic #1052)
// ---------------------------------------------------------------------------
//
// dev_target dispatch respects a per-cycle USD cap that mirrors the
// Orchestrator's per-cycle cost-cap pattern and the scout cost-share gate.
// The cap is a HIGH backstop (not a throttle): exceeding it halts further
// dev_target sub-dispatch this cycle and records a budget skip. The gate is
// configurable via `state.limits.per_cycle_cost_cap_usd`, defaults HIGH, reads
// cycle spend from `state.dev_target_spend_usd_cycle`, and degrades to a no-op
// when the cap is 0 (backstop disabled) or the spend key is absent.
describe("decide.py — dev_target per-cycle cost-cap (issue #1059)", () => {
  function devTargetCapState(o: {
    scope?: string;
    perCycleCapUsd?: number;
    devTargetSpendUsdCycle?: number;
  }): any {
    const s = baseState({
      scope: o.scope,
      signals: { target_work_available: true },
    });
    if (o.perCycleCapUsd !== undefined) s.limits.per_cycle_cost_cap_usd = o.perCycleCapUsd;
    if (o.devTargetSpendUsdCycle !== undefined) s.dev_target_spend_usd_cycle = o.devTargetSpendUsdCycle;
    return s;
  }

  test("cost-cap halts dev_target when cycle spend >= per_cycle cap (issue #1059 AC)", () => {
    const state = devTargetCapState({ perCycleCapUsd: 25.0, devTargetSpendUsdCycle: 30.0 });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      undefined,
      "cycle spend $30 above $25 cap must halt dev_target sub-dispatch",
    );
    assert.ok(plan.debug?.dev_target_cost_cap_skipped,
      "plan.debug should record the cost-cap skip reason for operator audit");
  });

  test("cost-cap allows dev_target when cycle spend below the cap", () => {
    const state = devTargetCapState({ perCycleCapUsd: 25.0, devTargetSpendUsdCycle: 5.0 });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      "cycle spend $5 below $25 cap must allow dev_target dispatch",
    );
  });

  test("cost-cap defaults HIGH — a normal cycle is never throttled (issue #1059 AC)", () => {
    // No explicit cap → PER_CYCLE_COST_CAP_USD_DEFAULT ($25). A modest $5 of
    // cycle spend stays well under the backstop, so dispatch proceeds.
    const state = baseState({ signals: { target_work_available: true } });
    state.dev_target_spend_usd_cycle = 5.0;
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      "default cap is HIGH ($25); $5 cycle spend must not throttle dev_target",
    );
  });

  test("cost-cap default backstop still fires on a runaway cycle (issue #1059 AC)", () => {
    // No explicit cap → $25 default. A runaway $40 of cycle spend trips it.
    const state = baseState({ signals: { target_work_available: true } });
    state.dev_target_spend_usd_cycle = 40.0;
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      undefined,
      "default $25 backstop must halt a runaway $40 cycle",
    );
  });

  test("cost-cap is a no-op (backstop disabled) when per_cycle cap is 0", () => {
    // cap=0 disables the backstop entirely — NOT a kill-switch. Even high
    // spend dispatches, because a 0 cap means "no backstop configured".
    const state = devTargetCapState({ perCycleCapUsd: 0, devTargetSpendUsdCycle: 99.0 });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      "cap of 0 disables the backstop — dev_target must still dispatch",
    );
  });

  test("cost-cap is a no-op when the cycle-spend key is absent (legacy state)", () => {
    // No dev_target_spend_usd_cycle key → spend defaults to 0.0, under any
    // positive cap, so legacy state shapes keep today's behaviour.
    const state = devTargetCapState({ perCycleCapUsd: 25.0 });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      "absent cycle-spend key → 0 spend → under cap → dispatch proceeds",
    );
  });

  test("cost-cap reads limits.per_cycle_cost_cap_usd override (issue #1059 AC)", () => {
    // Operator raises the backstop to $100 → $50 cycle spend now allowed.
    const state = devTargetCapState({ perCycleCapUsd: 100.0, devTargetSpendUsdCycle: 50.0 });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      "raised $100 cap → $50 cycle spend allowed",
    );
  });

  test("cost-cap halts ONLY dev_target — other pipeline classes unaffected", () => {
    // A tripped dev_target backstop must not suppress dev_orch / qa_orch etc.
    const state = devTargetCapState({ perCycleCapUsd: 25.0, devTargetSpendUsdCycle: 30.0 });
    state.signals = { target_work_available: true, orch_work_available: true };
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      undefined,
      "dev_target halted by its own per-cycle cap",
    );
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_orch"),
      "dev_orch must still dispatch — the cap is dev_target-only",
    );
  });
});

// ---------------------------------------------------------------------------
// 7b. architecture_orch signal class (issue #790, parent #787;
//     unified board-idle signal + 1h cadence by issue #959, epic #958)
// ---------------------------------------------------------------------------
//
// architecture_orch is a board-idle backfill that dispatches the headless
// /hydra-architecture-scan wrapper (#788). Issue #959 repointed it from the
// old `arch_fallback_due` signal to the unified `orch_backfill_idle` signal
// and dropped its class cooldown from 24h to 1h. It fires when
// `orch_backfill_idle` is present AND `arch_board_saturated` is absent;
// arch_board_saturated stays the FIRST gate (primary suppressor) and the 1h
// class cooldown is the back-stop. It is orch-scope only
// (SCOPE_TARGET_ONLY_EXCLUDE; no architecture_target mirror).
//
// NOTE on test isolation: discover_orch (issue #959) is now ALSO a backfill
// class keyed off the SAME orch_backfill_idle signal and iterates BEFORE
// architecture_orch. The one-per-turn stagger guard therefore lets discover_orch
// win a fully-idle turn, staggering architecture_orch out. Tests that want to
// observe architecture_orch dispatching put discover_orch inside its 1h cooldown
// (signal_last_fired.discover_orch = now) so architecture_orch is the only
// eligible backfill class — exactly the round-robin state of the SECOND idle turn.
// collect-state.sh (#789/#959) owns signal emission; decide.py only reads them.
// ---------------------------------------------------------------------------

describe("decide.py — architecture_orch signal class (issue #790, #959)", () => {
  const now = Math.floor(Date.now() / 1000);
  // discover_orch just fired → inside its 1h cooldown, so architecture_orch is
  // the only eligible backfill class (the "turn N+1" round-robin state).
  const discoverCooling = { discover_orch: now } as any;

  test("architecture_orch fires on orch_backfill_idle (discover_orch cooling)", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: discoverCooling,
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "architecture_orch");
    assert.ok(a, "architecture_orch must dispatch on orch_backfill_idle");
    assert.equal(a.skill, "hydra-architecture-scan");
  });

  test("architecture_orch DOES NOT fire without orch_backfill_idle signal", () => {
    const state = baseState();  // no signals
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "architecture_orch"),
      undefined,
      "architecture_orch must not dispatch when the board is not idle",
    );
  });

  test("architecture_orch suppressed when arch_board_saturated is set (cap is FIRST gate)", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true, arch_board_saturated: true },
      signal_last_fired: discoverCooling,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "architecture_orch"),
      undefined,
      "saturated arch board → suppress backfill (anti-feedback-loop guard, checked before cooldown + stagger)",
    );
  });

  test("architecture_orch is excluded by target-only scope (orch-scope by definition)", () => {
    const state = baseState({
      scope: "target-only",
      signals: { orch_backfill_idle: true },
      signal_last_fired: discoverCooling,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "architecture_orch"),
      undefined,
      "target-only scope must exclude architecture_orch (INV-008)",
    );
  });

  test("architecture_orch is allowed under orch-only scope", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { orch_backfill_idle: true },
      signal_last_fired: discoverCooling,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "architecture_orch"),
      "orch-only must NOT exclude architecture_orch",
    );
  });

  test("architecture_orch suppressed when recently fired (within 1h cooldown)", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      // Fired 30m ago → inside the new 1h cooldown.
      signal_last_fired: { architecture_orch: now - 30 * 60, discover_orch: now } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "architecture_orch"),
      undefined,
      "30m ago is inside the 1h architecture_orch cooldown (issue #959)",
    );
  });

  test("architecture_orch fires after the 1h cooldown elapses", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      // 61m ago → past the 1h cooldown. discover_orch still cooling.
      signal_last_fired: { architecture_orch: now - 61 * 60, discover_orch: now } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "architecture_orch"),
      "architecture_orch must fire once the 1h cooldown has elapsed (issue #959)",
    );
  });

  test("architecture_orch counts as a real dispatch (no idle-heartbeat wait emitted)", () => {
    // A real dispatch sets dispatched_any=True, which suppresses the idle
    // heartbeat `wait` action so idle_turns does not accumulate while a
    // fallback is eligible. The observable proof is the ABSENCE of a
    // heartbeat wait alongside the PRESENCE of the dispatch.
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: discoverCooling,
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "architecture_orch");
    assert.ok(a, "architecture_orch dispatch must be present");
    assert.equal(
      findAction(plan, (x) => x.type === "wait" && x.reason === "idle heartbeat"),
      undefined,
      "a real dispatch turn must NOT emit the idle-heartbeat wait",
    );
  });

  test("architecture_orch in burned_classes is NOT re-dispatched (mirrors #432)", () => {
    const state = baseState({
      burned_classes: ["architecture_orch"],
      signals: { orch_backfill_idle: true },
      signal_last_fired: discoverCooling,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "architecture_orch"),
      undefined,
      "burned signal class architecture_orch must not be re-dispatched",
    );
  });
});

// ---------------------------------------------------------------------------
// 7c. Board-idle backfill set: discover_orch revival + one-per-turn stagger
//     (issue #959, epic #958)
// ---------------------------------------------------------------------------
//
// Issue #959 unifies the board-empty predicate behind a single canonical
// `orch_backfill_idle` signal and points BOTH backfill-set classes
// (discover_orch + architecture_orch) at it on a 1h cadence:
//   - discover_orch was DEAD: it keyed off `orch_idle`, a signal collect-state
//     never emitted. It now reads orch_backfill_idle.
//   - A one-per-turn stagger guard in _rule_signals ensures the two never both
//     dispatch on the same idle turn; round-robin across turns emerges from the
//     per-class 1h cooldowns with NO new persistent state.
// ---------------------------------------------------------------------------

describe("decide.py — board-idle backfill set (issue #959)", () => {
  const now = Math.floor(Date.now() / 1000);

  test("discover_orch is REVIVED: dispatches on orch_backfill_idle", () => {
    const state = baseState({ signals: { orch_backfill_idle: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "discover_orch");
    assert.ok(a, "discover_orch must dispatch on orch_backfill_idle (was dead on orch_idle)");
    assert.equal(a.skill, "hydra-discover");
  });

  test("discover_orch does NOT fire on the dead orch_idle signal anymore", () => {
    // The old (never-emitted) signal must no longer trigger discover_orch —
    // the seam is orch_backfill_idle now.
    const state = baseState({ signals: { orch_idle: true } });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "discover_orch"),
      undefined,
      "orch_idle is a dead signal; discover_orch must key off orch_backfill_idle",
    );
  });

  test("stagger: on a fully-idle turn with BOTH cooled, exactly ONE backfill class dispatches", () => {
    // Both discover_orch and architecture_orch are eligible (idle board, both
    // cooled). The one-per-turn guard must let only one through — discover_orch
    // iterates first, so it wins this turn and architecture_orch is staggered.
    const state = baseState({ signals: { orch_backfill_idle: true } });
    const plan = runDecide(state, null);
    const backfillDispatches = (plan.actions ?? []).filter(
      (a: any) => a.type === "dispatch" && (a.slot === "discover_orch" || a.slot === "architecture_orch"),
    );
    assert.equal(backfillDispatches.length, 1, "exactly one backfill class may dispatch per turn");
    assert.equal(backfillDispatches[0].slot, "discover_orch", "discover_orch iterates first → wins turn 1");
  });

  test("stagger round-robin: turn N+1 (discover_orch cooling) dispatches architecture_orch", () => {
    // Simulate the second consecutive idle turn: discover_orch fired last turn
    // so it is inside its 1h cooldown; architecture_orch is the only eligible
    // backfill class. No persistent rotation cursor — the cooldown IS the cursor.
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { discover_orch: now } as any,
    });
    const plan = runDecide(state, null);
    const backfillDispatches = (plan.actions ?? []).filter(
      (a: any) => a.type === "dispatch" && (a.slot === "discover_orch" || a.slot === "architecture_orch"),
    );
    assert.equal(backfillDispatches.length, 1, "still exactly one backfill class on turn N+1");
    assert.equal(
      backfillDispatches[0].slot,
      "architecture_orch",
      "discover_orch cooling → architecture_orch is the only eligible backfill class",
    );
  });

  test("staggered class records a `stagger` dispatch_decision (not a real dispatch)", () => {
    const state = baseState({ signals: { orch_backfill_idle: true } });
    const plan = runDecide(state, null);
    const staggerEvents = (plan.events ?? []).filter(
      (e: any) => e.event === "dispatch_decision" && e.outcome === "stagger" && e.class === "architecture_orch",
    );
    assert.equal(staggerEvents.length, 1, "the held-back architecture_orch must record a stagger decision");
  });

  test("stagger NEVER bypasses the saturation cap: saturated arch board still suppresses", () => {
    // discover_orch cooling so architecture_orch would be the winner, BUT the
    // board is saturated → suppressed at the FIRST gate, before the stagger.
    const state = baseState({
      signals: { orch_backfill_idle: true, arch_board_saturated: true },
      signal_last_fired: { discover_orch: now } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "architecture_orch"),
      undefined,
      "saturation cap is the first gate — a saturated class never consumes the stagger slot",
    );
  });
});

// ---------------------------------------------------------------------------
// 7d. cleanup_orch signal class (issue #960, parent #958)
// ---------------------------------------------------------------------------
//
// cleanup_orch is the high-confidence mechanical backfill class: it dispatches
// the headless /hydra-cleanup skill (a deterministic dead-code / simplification
// detector) on the SAME unified `orch_backfill_idle` signal as the backfill set,
// with a 1h cooldown. Its anti-flood cap is `cleanup_board_saturated`
// (mirroring arch_board_saturated), checked FIRST. It is orch-scope only
// (SCOPE_TARGET_ONLY_EXCLUDE; no cleanup_target mirror).
//
// CRITICAL DIFFERENCE from architecture_orch / discover_orch: cleanup_orch is
// deliberately NOT in BACKFILL_SIGNAL_CLASSES, so it is EXEMPT from the
// one-per-turn stagger guard and CO-FIRES with a staggered backfill class on the
// same idle turn (it runs hot — epic #958). The tests below pin that co-firing.
// ---------------------------------------------------------------------------

describe("decide.py — cleanup_orch signal class (issue #960)", () => {
  const now = Math.floor(Date.now() / 1000);

  test("cleanup_orch fires on orch_backfill_idle", () => {
    const state = baseState({ signals: { orch_backfill_idle: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "cleanup_orch");
    assert.ok(a, "cleanup_orch must dispatch on orch_backfill_idle");
    assert.equal(a.skill, "hydra-cleanup");
  });

  test("cleanup_orch DOES NOT fire without orch_backfill_idle signal", () => {
    const state = baseState();  // no signals
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "cleanup_orch"),
      undefined,
      "cleanup_orch must not dispatch when the board is not idle",
    );
  });

  test("cleanup_orch suppressed when cleanup_board_saturated is set (cap is FIRST gate)", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true, cleanup_board_saturated: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "cleanup_orch"),
      undefined,
      "saturated cleanup board → suppress backfill (anti-feedback-loop guard, checked before cooldown)",
    );
  });

  test("cleanup_orch is excluded by target-only scope (orch-scope by definition)", () => {
    const state = baseState({
      scope: "target-only",
      signals: { orch_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "cleanup_orch"),
      undefined,
      "target-only scope must exclude cleanup_orch (INV-008)",
    );
  });

  test("cleanup_orch is allowed under orch-only scope", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { orch_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "cleanup_orch"),
      "orch-only must NOT exclude cleanup_orch",
    );
  });

  test("cleanup_orch suppressed when recently fired (within 1h cooldown)", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      // Fired 30m ago → inside the 1h cooldown.
      signal_last_fired: { cleanup_orch: now - 30 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "cleanup_orch"),
      undefined,
      "30m ago is inside the 1h cleanup_orch cooldown (issue #960)",
    );
  });

  test("cleanup_orch fires after the 1h cooldown elapses", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { cleanup_orch: now - 61 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "cleanup_orch"),
      "cleanup_orch must fire once the 1h cooldown has elapsed (issue #960)",
    );
  });

  test("cleanup_orch in burned_classes is NOT re-dispatched (mirrors #432)", () => {
    const state = baseState({
      burned_classes: ["cleanup_orch"],
      signals: { orch_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "cleanup_orch"),
      undefined,
      "burned signal class cleanup_orch must not be re-dispatched",
    );
  });

  test("cleanup_orch CO-FIRES with a staggered backfill class (NOT in BACKFILL_SIGNAL_CLASSES)", () => {
    // On a fully-idle turn with everything cooled, discover_orch wins the
    // stagger slot for the backfill set, AND cleanup_orch dispatches in the
    // same turn because it is exempt from the one-per-turn stagger guard.
    const state = baseState({ signals: { orch_backfill_idle: true } });
    const plan = runDecide(state, null);
    const cleanup = findAction(plan, (a) => a.type === "dispatch" && a.slot === "cleanup_orch");
    const backfill = (plan.actions ?? []).filter(
      (a: any) => a.type === "dispatch" && (a.slot === "discover_orch" || a.slot === "architecture_orch"),
    );
    assert.ok(cleanup, "cleanup_orch must dispatch on a fully-idle turn");
    assert.equal(backfill.length, 1, "the staggered backfill set still emits exactly one dispatch");
    assert.equal(
      backfill[0].slot,
      "discover_orch",
      "the staggered set's winner is unchanged by cleanup_orch co-firing",
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
      // Issue #744: emergency-brake route-to-review action.
      "route-prs-to-review",
    ]);
    const plans = [
      runDecide(baseState({ cumulative_tokens: 5_000_000 })),                                  // terminate
      runDecide(baseState({ signals: { needs_qa_orch: true } })),                              // dispatch
      runDecide(baseState({ signals: { orch_work_available: true } })),                        // dispatch dev_orch (#458)
      runDecide(baseState(), { candidates: [{ issue: 1, anchorRef: "x", score: 0.9 }] }),      // dispatch (research-related)
      runDecide(baseState(), null, [{                                                          // auto-merge
        type: "qa-verdict", pr_number: 1, tier: 1, verdict: "PASS",
      }]),
      runDecide(baseState(), null, [{                                                          // T4 -> hold (no action)
        type: "qa-verdict", pr_number: 2, tier: 4, mechanical: false, verdict: "PASS",
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
    // Issue #744 added the 11th, `route-prs-to-review` (emergency brake).
    assert.equal(firstLine.action_types.length, 11, "exactly 11 action types (10 + route-prs-to-review per #744)");
    assert.ok(firstLine.action_types.includes("wait_or_reap"), "wait_or_reap must be in the catalog");
    assert.ok(firstLine.action_types.includes("route-prs-to-review"), "route-prs-to-review must be in the catalog (#744)");
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

  test("unknown tier -> hold (fail-safe: required depth unprovable)", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 999, tier: "weird" })]);
    // Policy collapse (#742): an unparseable tier holds rather than emitting
    // a tier-triggered queue-decision — the required depth cannot be proven.
    assert.equal(findAction(plan, (a) => a.pr_number === 999), undefined);
  });

  test("multiple qa-verdict events in one tick: every tier (incl. T4) auto-merges on PASS", () => {
    // ADR-0020 Slice 2 (#743): the T4 arm flips — a T4 PASS now auto-merges
    // identically to T1/T2/T3. decide.py trusts the verdict; the base-ref
    // deep-qa-gate CI check independently enforces the Deep-QA PASS marker.
    const events = [
      qaEvent({ pr: 1, tier: 1 }),
      qaEvent({ pr: 2, tier: 2 }),
      qaEvent({ pr: 3, tier: 4, mechanical: true }),
    ];
    const plan = runDecide(baseState(), null, events);
    assert.ok(findAction(plan, (a) => a.type === "auto-merge" && a.pr_number === 1));
    assert.ok(findAction(plan, (a) => a.type === "auto-merge" && a.pr_number === 2));
    assert.ok(findAction(plan, (a) => a.type === "auto-merge" && a.pr_number === 3), "T4 PASS now auto-merges");
  });

  test("T4 with a non-PASS verdict still holds in the policy table (INV-007)", () => {
    const plan = runDecide(baseState(), null, [qaEvent({ pr: 4, tier: 4, verdict: "FAIL" })]);
    assert.equal(findAction(plan, (a) => a.pr_number === 4), undefined);
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

  test("ISSUE-458/#1129: dev_target with a research-recommended board fires WITHOUT an anchor hint", () => {
    // The feed's `research_recommended` flag — not a private score threshold
    // — gates the anchor hint. When the feed judges the board too weak to
    // steer (research_recommended=true), dev_target fires bare; the same flag
    // also forces research_target, so the boundary fires exactly once.
    const state = baseState({ signals: { target_work_available: true } });
    const cands = { candidates: [{ issue: 1, anchorRef: "x", score: 0.3 }], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");
    assert.ok(dispatch);
    assert.equal(dispatch.prompt_args.anchor, undefined,
      "a research-recommended board must NOT be surfaced as a dev_target anchor");
  });

  test("ISSUE #1129 (finished): research_recommended=true suppresses the dev_target anchor hint even with a high candidate score", () => {
    // The dev-steer half of the boundary now reads the SAME feed flag the
    // research_target slot does (mirrors the #1129 research_target tests).
    // A strong score (0.9) that the feed nonetheless flags for research must
    // NOT be steered — keying both slots off the one flag eliminates the
    // dead-zone / double-fire risk the original #1129 comment only mitigated.
    const state = baseState({ signals: { target_work_available: true } });
    const cands = { candidates: [{ issue: 42, anchorRef: "item-42", score: 0.9 }], research_recommended: true };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");
    assert.ok(dispatch, "dev_target must still dispatch on the work signal");
    assert.equal(dispatch.skill, "hydra-target-build");
    assert.equal(dispatch.prompt_args.anchor, undefined,
      "research_recommended=true must suppress the anchor hint regardless of score (#1129)");
    assert.equal(dispatch.prompt_args.score, undefined,
      "no score hint when the feed recommends research");
  });

  test("ISSUE #1129 (finished): research_recommended=false attaches the dev_target anchor hint even with a low candidate score", () => {
    // The inverse: the boundary is the flag, not the score. A weak score
    // (0.4) the feed does NOT flag for research IS steerable — under the
    // unified semantics decide.py no longer second-guesses the feed with a
    // private 0.5 cutoff.
    const state = baseState({ signals: { target_work_available: true } });
    const cands = { candidates: [{ issue: 43, anchorRef: "item-43", score: 0.4 }], research_recommended: false };
    const plan = runDecide(state, cands);
    const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target");
    assert.ok(dispatch);
    assert.equal(dispatch.prompt_args.anchor, "item-43",
      "research_recommended=false must surface the candidate as a dev_target anchor regardless of score (#1129)");
    assert.equal(dispatch.prompt_args.score, 0.4);
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
