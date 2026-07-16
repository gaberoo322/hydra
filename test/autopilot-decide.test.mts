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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
    // Belt-and-braces: keep the CLI's run-end POST (#1352) off so a fixture
    // that both carries a run_id and terminates can never POST to a live
    // orchestrator from the test suite. The POST wire contract is pinned by
    // its own dedicated test below with an explicit local server.
    env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
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
      // Turn 5: cap reached — suppressed. The #1769 turn bump still
      // persists (the CLI is the single writer of state.turn), but the
      // force counter must NOT move past the cap.
      const beforeJson = JSON.parse(readFileSync(t.state, "utf-8"));
      const plan5 = runDecideOnFiles(t);
      const dispatch5 = findAction(plan5, (a) => a.type === "dispatch" && a.slot === "research_target");
      assert.equal(dispatch5, undefined, "5th forced dispatch within one UTC day must be suppressed");
      const afterJson = JSON.parse(readFileSync(t.state, "utf-8"));
      assert.deepEqual(afterJson.research_force_counter, beforeJson.research_force_counter,
        "a suppressed turn must not advance the force counter");
      assert.equal(afterJson.turn, beforeJson.turn + 1,
        "the #1769 turn bump is the ONLY state mutation on a suppressed turn");
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

  test("no forced dispatch -> decide CLI persists only the #1769 turn bump (#1666)", () => {
    const t = makeTmp();
    try {
      writeFileSync(t.state, JSON.stringify(baseState()));
      // Feed does NOT recommend research — no force, no stamp. The only
      // state-file mutation is the #1769 single-writer turn bump; in
      // particular the in-memory mutations decide() makes (slot_history,
      // failure_log) must NOT ride along.
      writeFileSync(t.cands, JSON.stringify({
        candidates: [{ issue: 8, anchorRef: "x", score: 0.4 }],
        research_recommended: false,
      }));
      writeFileSync(t.events, JSON.stringify([]));
      const before = JSON.parse(readFileSync(t.state, "utf-8"));
      const plan = runDecideOnFiles(t);
      const dispatch = findAction(plan, (a) => a.type === "dispatch" && a.slot === "research_target");
      assert.equal(dispatch, undefined);
      const after = JSON.parse(readFileSync(t.state, "utf-8"));
      assert.deepEqual(
        after,
        { ...before, turn: before.turn + 1 },
        "the persisted state must differ from the input by EXACTLY the turn bump",
      );
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

  // Issue #2426: untriaged-orphans triage backstop. An open issue carrying
  // none of the actionable/lifecycle labels is invisible to both the
  // dev_orch (ready-for-agent) and the needs_triage_orch sweep paths.
  // collect-state.sh emits an `untriaged_orphans` count; the playbook maps
  // `untriaged_orphans > 0` → the boolean `untriaged_orphans_orch` signal,
  // which sweep_orch reads as a secondary trigger to route the orphans
  // through hydra-sweep.
  test("sweep_orch fires on untriaged_orphans_orch signal when cooled (#2426)", () => {
    const state = baseState({ signals: { untriaged_orphans_orch: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "sweep_orch");
    assert.ok(a, "untriaged_orphans_orch must dispatch a sweep_orch triage pass");
    assert.equal(a.skill, "hydra-sweep");
  });

  test("untriaged_orphans_orch sweep respects the sweep_orch cooldown (#2426)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { untriaged_orphans_orch: true },
      signal_last_fired: { health: 0, sweep_orch: now - 60, sweep_target: 0, discover_orch: 0, discover_target: 0 },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "sweep_orch"),
      undefined,
      "60s ago is within the 900s sweep cooldown — the backstop must not busy-loop",
    );
  });

  test("sweep_orch stays idle with no triage or orphan signal (#2426)", () => {
    const state = baseState();  // no signals
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "sweep_orch"),
      undefined,
      "no needs_triage_orch and no untriaged_orphans_orch → no sweep dispatch",
    );
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
// 7c-bis. Board-idle backfill STARVATION FLOOR (issue #2428)
// ---------------------------------------------------------------------------
//
// The one-per-turn stagger guard (issue #959) can starve a backfill class:
// on a busy run a staggered class (discover_orch / architecture_orch) loses
// the round-robin slot every idle turn and goes fully dark for >24h. The
// starvation floor forces a class that has not fired in >24h through the
// stagger, while NEVER bypassing the saturation cap / cooldown / scope / burned
// gates (those are checked FIRST and the floor only overrides the stagger).
// The `now` is pinned per the AC so the >24h boundary is deterministic.
// ---------------------------------------------------------------------------

describe("decide.py — backfill starvation floor (issue #2428)", () => {
  // The decide CLI resolves `now` from wall-clock (int(time.time())), so the
  // floor boundary is exercised deterministically via offsets from the same
  // clock the CLI reads (the established pattern in the #959 backfill tests).
  // A few-seconds test↔CLI skew is irrelevant against the 24h/1h windows, so
  // the >24h boundary stays effectively pinned.
  const now = Math.floor(Date.now() / 1000);
  const DAY = 24 * 60 * 60;

  function backfillDispatches(plan: any) {
    return (plan.actions ?? []).filter(
      (a: any) =>
        a.type === "dispatch" &&
        (a.slot === "discover_orch" || a.slot === "architecture_orch"),
    );
  }

  test("starved architecture_orch (>24h) is FORCED through even though discover_orch wins the stagger", () => {
    // discover_orch is fresh (never-fired → it wins the stagger slot this turn).
    // architecture_orch last fired 25h ago → past the 24h floor → forced through.
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { architecture_orch: now - 25 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    const dispatched = backfillDispatches(plan).map((a: any) => a.slot).sort();
    assert.deepEqual(
      dispatched,
      ["architecture_orch", "discover_orch"],
      "both must dispatch: discover_orch wins the stagger, architecture_orch is forced by the starvation floor",
    );
  });

  test("forced dispatch is annotated with the starvation-floor reason (audit trail)", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { architecture_orch: now - 25 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    const arch = findAction(
      plan,
      (a: any) => a.type === "dispatch" && a.slot === "architecture_orch",
    );
    assert.ok(arch, "architecture_orch must be force-dispatched");
    assert.match(
      String(arch.reason),
      /starvation floor/,
      "forced dispatch reason must name the starvation floor, not the round-robin",
    );
  });

  test("a backfill class just UNDER the 24h floor (23h) is NOT forced — normal stagger holds", () => {
    // architecture_orch fired 23h ago → inside the floor window → no force.
    // discover_orch (fresh) wins the stagger; architecture_orch is staggered out.
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { architecture_orch: now - 23 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    const dispatched = backfillDispatches(plan).map((a: any) => a.slot);
    assert.deepEqual(
      dispatched,
      ["discover_orch"],
      "23h < 24h floor → no force; exactly one backfill class dispatches (the stagger winner)",
    );
  });

  test("the floor boundary is inclusive at exactly 24h", () => {
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { architecture_orch: now - DAY } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(
        plan,
        (a: any) => a.type === "dispatch" && a.slot === "architecture_orch",
      ),
      "exactly 24h since last fire is starved (>= floor) → forced through",
    );
  });

  test("starvation floor NEVER bypasses the saturation cap (cap is the FIRST gate)", () => {
    // architecture_orch is starved (>24h) AND the arch board is saturated.
    // The saturation cap is checked before the stagger/floor, so the class is
    // suppressed at the selector — the floor must not resurrect a capped class.
    const state = baseState({
      signals: { orch_backfill_idle: true, arch_board_saturated: true },
      signal_last_fired: { architecture_orch: now - 25 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(
        plan,
        (a: any) => a.type === "dispatch" && a.slot === "architecture_orch",
      ),
      undefined,
      "a saturated class is suppressed before the floor — the cap stays the hardest limit",
    );
  });

  test("starvation floor NEVER bypasses the per-class cooldown", () => {
    // Construct a case where the floor would WANT to force a class that is still
    // inside its 1h cooldown. signal_starved keys on the SAME timestamp as the
    // cooldown, so a class inside its cooldown is by definition NOT >24h stale —
    // but pin it explicitly: discover_orch fired 30m ago (cooling), so even
    // though it is the stagger winner it must not dispatch this turn.
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: { discover_orch: now - 30 * 60, architecture_orch: now } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(
        plan,
        (a: any) => a.type === "dispatch" && a.slot === "discover_orch",
      ),
      undefined,
      "a class inside its 1h cooldown is never starved (same timestamp source) and never forced",
    );
  });

  test("starvation floor NEVER bypasses the burned-class soft-cap", () => {
    const state = baseState({
      burned_classes: ["architecture_orch"],
      signals: { orch_backfill_idle: true },
      signal_last_fired: { architecture_orch: now - 25 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(
        plan,
        (a: any) => a.type === "dispatch" && a.slot === "architecture_orch",
      ),
      undefined,
      "a burned class is suppressed before the floor — starvation does not override the soft-cap",
    );
  });

  test("starvation floor NEVER bypasses scope exclusion", () => {
    const state = baseState({
      scope: "target-only",
      signals: { orch_backfill_idle: true },
      signal_last_fired: { architecture_orch: now - 25 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(
        plan,
        (a: any) => a.type === "dispatch" && a.slot === "architecture_orch",
      ),
      undefined,
      "target-only scope excludes architecture_orch before the floor is ever consulted",
    );
  });

  test("an UNSEEN backfill class (no signal_last_fired entry) is NOT force-dispatched (cold-start ≠ starvation)", () => {
    // On a fresh state every backfill class is unseen. Treating never-fired as
    // starved would force them ALL through every turn and defeat the stagger, so
    // signal_starved returns False for an unseen class — the stagger round-robin
    // drains the cold start fairly over successive turns instead. discover_orch
    // wins turn 1; architecture_orch (also unseen) is staggered out, NOT forced.
    const state = baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: {} as any,
    });
    const plan = runDecide(state, null);
    const dispatched = backfillDispatches(plan).map((a: any) => a.slot);
    assert.deepEqual(
      dispatched,
      ["discover_orch"],
      "cold-start unseen classes obey the normal stagger (exactly one dispatch) — the floor needs a real prior last-fired time",
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
  test("nothing to do, all slots empty -> clean terminate(idle), not a heartbeat wait (#1352)", () => {
    // The print-mode session exits the moment the model emits its final
    // message — a wait-only plan was never honoured, the process died and
    // the reap backstop stamped the run `interrupted` (the retro-starvation
    // mechanism of issue #1352). A wait-only turn with zero occupied slots
    // now records the designed exit as a clean idle drain.
    const plan = runDecide(baseState(), null);
    const t = findAction(plan, (a) => a.type === "terminate");
    assert.ok(t, "wait-only turn with empty slots must terminate cleanly");
    assert.equal(t.cause, "idle");
    assert.equal(
      findAction(plan, (a) => a.type === "wait"),
      undefined,
      "no wait action alongside the clean idle drain",
    );
  });

  test("nothing new to dispatch but slot busy -> short busy-wait nap (no terminate)", () => {
    // Background dispatches hold the print-mode process alive and re-invoke
    // it on completion — the busy-wait nap is real there, and terminating
    // would orphan the in-flight slot.
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
    assert.equal(
      findAction(plan, (a) => a.type === "terminate"),
      undefined,
      "in-flight slots must never trigger the idle drain",
    );
  });

  test("idle-drain terminate carries merged_prs from state", () => {
    const state = baseState();
    (state as any).merged_prs = 3;
    const plan = runDecide(state, null);
    const t = findAction(plan, (a) => a.type === "terminate");
    assert.ok(t);
    assert.equal(t.merged_prs, 3);
  });

  test("housekeeping-only turn (auto-merge, no dispatch, empty slots) keeps the heartbeat wait", () => {
    // A turn that emitted other actions (here: an auto-merge from a
    // qa-verdict) but no dispatch must NOT terminate — only a true
    // wait-only turn drains. The heartbeat wait stays so the model
    // finishes the housekeeping before the session ends.
    const events = [{
      type: "qa-verdict", pr_number: 555, tier: 1,
      mechanical: null, has_scope_justification: false, verdict: "PASS",
    }];
    const plan = runDecide(baseState(), null, events);
    assert.ok(
      findAction(plan, (a) => a.type === "auto-merge" && a.pr_number === 555),
      "fixture must produce an auto-merge action",
    );
    assert.equal(
      findAction(plan, (a) => a.type === "terminate"),
      undefined,
      "a turn with housekeeping actions must not idle-drain",
    );
    assert.ok(
      findAction(plan, (a) => a.type === "wait" && a.reason === "idle heartbeat"),
      "housekeeping turn keeps the heartbeat wait",
    );
  });
});

// ---------------------------------------------------------------------------
// 8.5 Terminate run-end POST (#1352) — the CLI records a clean run-end for
//     any decide-side terminate BEFORE the print-mode session exits, so the
//     reap backstop's `interrupted` stamp becomes an idempotent no-op.
// ---------------------------------------------------------------------------

describe("decide.py — terminate run-end POST (#1352)", () => {
  const RUN_ID = "11111111-2222-3333-4444-555555555555";

  interface Captured { url: string; method: string; body: Record<string, unknown> }

  async function withCaptureServer(
    fn: (baseUrl: string, requests: Captured[]) => Promise<void>,
  ): Promise<void> {
    const requests: Captured[] = [];
    const server: Server = createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => {
        requests.push({
          url: req.url ?? "",
          method: req.method ?? "",
          body: buf ? JSON.parse(buf) : {},
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      await fn(`http://127.0.0.1:${port}`, requests);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  // Async spawn (NOT spawnSync): the local capture server must be able to
  // answer the CLI's POST, and spawnSync would block the event loop.
  function spawnDecideAsync(
    state: unknown,
    env: Record<string, string>,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const t = makeTmp();
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(null));
    writeFileSync(t.events, JSON.stringify([]));
    return new Promise((resolveSpawn) => {
      const child = spawn("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
        env: { ...process.env, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        rmSync(t.dir, { recursive: true, force: true });
        resolveSpawn({ code, stdout, stderr });
      });
    });
  }

  test("a terminating plan POSTs run-end with the plan's cause before exit", async () => {
    await withCaptureServer(async (baseUrl, requests) => {
      const state = baseState(); // wait-only turn → terminate(idle)
      (state as any).run_id = RUN_ID;
      const out = await spawnDecideAsync(state, {
        HYDRA_API_BASE: baseUrl,
        HYDRA_AUTOPILOT_RUN_END_POST: "",
      });
      assert.equal(out.code, 0, out.stderr);
      const plan = JSON.parse(out.stdout);
      assert.ok(
        (plan.actions as any[]).some((a) => a.type === "terminate"),
        "fixture must produce a terminating plan",
      );
      assert.equal(requests.length, 1, "exactly one run-end POST");
      assert.equal(requests[0].method, "POST");
      assert.equal(requests[0].url, "/api/autopilot/run-end");
      assert.equal(requests[0].body.run_id, RUN_ID);
      assert.equal(requests[0].body.cause, "idle");
      assert.ok(
        Number.isInteger(requests[0].body.ended_epoch),
        "ended_epoch must be an integer epoch",
      );
    });
  });

  test("no run_id in state -> no POST (test fixtures / isolated runs)", async () => {
    await withCaptureServer(async (baseUrl, requests) => {
      const out = await spawnDecideAsync(baseState(), {
        HYDRA_API_BASE: baseUrl,
        HYDRA_AUTOPILOT_RUN_END_POST: "",
      });
      assert.equal(out.code, 0, out.stderr);
      assert.equal(requests.length, 0, "no run_id → no run-end POST");
    });
  });

  test("HYDRA_AUTOPILOT_RUN_END_POST=off -> no POST even with run_id + terminate", async () => {
    await withCaptureServer(async (baseUrl, requests) => {
      const state = baseState();
      (state as any).run_id = RUN_ID;
      const out = await spawnDecideAsync(state, {
        HYDRA_API_BASE: baseUrl,
        HYDRA_AUTOPILOT_RUN_END_POST: "off",
      });
      assert.equal(out.code, 0, out.stderr);
      assert.equal(requests.length, 0, "off-switch must suppress the POST");
    });
  });

  test("non-terminating plan -> no POST", async () => {
    await withCaptureServer(async (baseUrl, requests) => {
      const state = baseState({ signals: { orch_work_available: true } });
      (state as any).run_id = RUN_ID;
      const out = await spawnDecideAsync(state, {
        HYDRA_API_BASE: baseUrl,
        HYDRA_AUTOPILOT_RUN_END_POST: "",
      });
      assert.equal(out.code, 0, out.stderr);
      const plan = JSON.parse(out.stdout);
      assert.ok(
        (plan.actions as any[]).some((a) => a.type === "dispatch"),
        "fixture must dispatch (non-terminating turn)",
      );
      assert.equal(requests.length, 0, "no terminate in plan → no POST");
    });
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

  /**
   * Issue #1732 — the plan carries a (run_id, turn) freshness stamp so
   * heartbeat.py post_turn can refuse to attribute a stale default-path
   * plan (a previous run's dispatch actions were misattributed into the
   * turn records of runs ebcfebd2/b2422e61 on 2026-06-11).
   *
   * Issue #1769 — the CLI bumps state.turn BEFORE decide() runs, so the
   * stamp carries the BUMPED value (input turn + 1) and always equals the
   * persisted state.json turn.
   */
  test("plan JSON is stamped with the state's run_id + bumped turn (#1732/#1769)", () => {
    const state = baseState();
    (state as any).run_id = "stamp-run-1732";
    (state as any).turn = 4;
    const plan = runDecide(state, null);
    assert.equal(plan.run_id, "stamp-run-1732", "plan.run_id mirrors state.run_id");
    assert.equal(plan.turn, 5, "plan.turn mirrors the CLI-bumped state.turn (4 + 1)");
  });

  test("plan stamp degrades to run_id=null (turn still bumps) when state has no run_id (#1732)", () => {
    const plan = runDecide(baseState(), null); // baseState has no run_id, turn: 0
    assert.equal(plan.run_id, null, "no state.run_id → plan.run_id null");
    assert.equal(plan.turn, 1, "state.turn 0 → CLI bump → plan.turn 1");
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
// 9b. Single-writer turn counter (issue #1769)
//
// The decide CLI is the SINGLE writer of state.turn: main() bumps it by one
// and persists the bumped state atomically BEFORE calling decide(), so the
// plan's turn stamp equals the persisted state.json turn by construction.
// heartbeat.py's plan-stale guard keeps STRICT (run_id, turn) equality on
// top of this — run 69442b4c (2026-06-11) zeroed turns 2-9's action ledgers
// because a session-improvised increment raced the heartbeat; the rejected
// alternative (a tolerance window in heartbeat.py, PR #1777) reopened the
// #1732 misattribution class and was bounced by QA.
// ---------------------------------------------------------------------------

describe("decide.py — single-writer turn counter (#1769)", () => {
  test("decide CLI bumps state.turn and persists it to the state file", () => {
    const t = makeTmp();
    try {
      const state = baseState(); // turn: 0
      (state as any).run_id = "single-writer-run";
      writeFileSync(t.state, JSON.stringify(state));
      writeFileSync(t.cands, JSON.stringify(null));
      writeFileSync(t.events, JSON.stringify([]));
      runDecideOnFiles(t);
      const persisted = JSON.parse(readFileSync(t.state, "utf-8"));
      assert.equal(persisted.turn, 1, "state file must carry the bumped turn (0 → 1)");
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("plan.turn equals the persisted state.json turn — equality by construction", () => {
    const t = makeTmp();
    try {
      const state = baseState();
      (state as any).run_id = "single-writer-run";
      (state as any).turn = 6;
      writeFileSync(t.state, JSON.stringify(state));
      writeFileSync(t.cands, JSON.stringify(null));
      writeFileSync(t.events, JSON.stringify([]));
      const plan = runDecideOnFiles(t);
      const persisted = JSON.parse(readFileSync(t.state, "utf-8"));
      assert.equal(persisted.turn, 7, "persisted turn is the bumped value");
      assert.equal(
        plan.turn,
        persisted.turn,
        "plan stamp and persisted state.turn must be equal by construction — " +
          "this is the invariant heartbeat.py's strict freshness guard relies on",
      );
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("consecutive CLI invocations yield turn 1 then 2 (monotonic, no session writer needed)", () => {
    const t = makeTmp();
    try {
      const state = baseState(); // turn: 0
      (state as any).run_id = "single-writer-run";
      writeFileSync(t.state, JSON.stringify(state));
      writeFileSync(t.cands, JSON.stringify(null));
      writeFileSync(t.events, JSON.stringify([]));
      const plan1 = runDecideOnFiles(t);
      assert.equal(plan1.turn, 1, "first invocation stamps turn 1");
      const plan2 = runDecideOnFiles(t);
      assert.equal(plan2.turn, 2, "second invocation reads the persisted bump and stamps turn 2");
      const persisted = JSON.parse(readFileSync(t.state, "utf-8"));
      assert.equal(persisted.turn, 2, "state file ends at turn 2");
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  test("missing/null turn key is treated as 0 and bumps to 1", () => {
    const t = makeTmp();
    try {
      const state = baseState();
      delete (state as any).turn; // legacy state shape without the counter
      writeFileSync(t.state, JSON.stringify(state));
      writeFileSync(t.cands, JSON.stringify(null));
      writeFileSync(t.events, JSON.stringify([]));
      const plan = runDecideOnFiles(t);
      assert.equal(plan.turn, 1, "absent turn coerces to 0 and bumps to 1");
      const persisted = JSON.parse(readFileSync(t.state, "utf-8"));
      assert.equal(persisted.turn, 1);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
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
      dispatch.worktreeBranch.includes("t8"),
      "worktreeBranch must embed the turn number (input turn 7 + CLI bump per #1769)",
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
    // The idle fallback fires when nothing dispatches (a clean
    // terminate(idle) since #1352) — confirm the stamping loop is
    // dispatch-scoped and doesn't leak the field onto other action types
    // (which would confuse the schema-additivity gates).
    const state = baseState(); // no signals → idle drain terminate
    const plan = runDecide(state, null);
    const idleAction = findAction(plan, (a) => a.type === "terminate");
    assert.ok(idleAction, "idle path must emit a terminate action");
    assert.equal(
      (idleAction as any).worktreeBranch,
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
    // (input turn 1 + the #1769 CLI bump → t2)
    assert.equal(
      qa.worktreeBranch,
      "worktree-agent-deadbeef-t2-qa_orch",
      "worktreeBranch must match the deterministic synth formula",
    );
  });
});

// ---------------------------------------------------------------------------
// wire_or_retire_target signal class (issue #2722, epic #2720)
// ---------------------------------------------------------------------------
//
// The JUDGMENT counterpart to cleanup_target's mechanical sweep. When the
// Target triage lane holds open `wire-or-retire` decision items, collect-state.sh
// emits `wire_or_retire_target_available`; decide.py dispatches the headless
// /hydra-wire-or-retire resolver (24h cooldown, at most 2 items/run) to turn each
// into a WIRE / RETIRE / UNCLEAR verdict.
//
// Contract points this suite pins:
//  - fires on wire_or_retire_target_available, dispatching hydra-wire-or-retire
//  - is a NO-OP without the signal
//  - respects the 24h cooldown (SIGNAL_COOLDOWNS["wire_or_retire_target"])
//  - is target-scope: EXCLUDED under orch-only, ALLOWED under target-only + all
//  - OMITS the model param (inherit parent per #1093 — judgment work; the
//    Haiku-premature-exit failure mode is documented)
//
// New TOP-LEVEL describe with its own lifecycle (no shared-Redis teardown to
// piggyback on; decide.py is a pure CLI over temp files, so there is nothing to
// tear down — but the suite is kept top-level per the CLAUDE.md authoring rule).
// ---------------------------------------------------------------------------
describe("decide.py — wire_or_retire_target signal class (issue #2722)", () => {
  const DAY = 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);

  function worState(over: Record<string, unknown> = {}): any {
    // signal_last_fired must include the class key at 0 (cooled) by default so
    // the cooldown gate does not spuriously suppress the dispatch.
    return baseState({
      signals: { wire_or_retire_target_available: true },
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
        wire_or_retire_target: 0,
      },
      ...over,
    });
  }

  test("fires hydra-wire-or-retire on wire_or_retire_target_available", () => {
    const plan = runDecide(worState(), null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wire_or_retire_target");
    assert.ok(a, "wire_or_retire_target must dispatch when the signal is present and cooled");
    assert.equal(a.skill, "hydra-wire-or-retire");
  });

  test("does NOT fire without the wire_or_retire_target_available signal", () => {
    const state = worState({ signals: {} });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "wire_or_retire_target"),
      undefined,
      "no triage wire-or-retire items → no resolver dispatch",
    );
  });

  test("OMITS the model param — inherit parent per #1093 (judgment work)", () => {
    const plan = runDecide(worState(), null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wire_or_retire_target");
    assert.ok(a, "expected a wire_or_retire_target dispatch");
    // The dispatch action must carry NO `model` key at all — the resolver
    // inherits the parent session's model. A pinned Haiku here is the
    // documented premature-exit failure mode.
    assert.equal("model" in a, false, "wire_or_retire_target dispatch must not pin a model (#1093)");
    assert.equal(a.prompt_args?.model, undefined, "no model in prompt_args either");
  });

  test("stamps prompt_args {apply, max_items, risk_carveout} — design concept Invariant 9", () => {
    // Regression pin for the QA-failed defect: the dispatch shipped with NO
    // prompt_args, so the class ran as a silent dry-run no-op (the retro #1078 /
    // cleanup_orch pattern) and its risk carve-out was prose-only (the exact
    // item-685/687 laundering failure mode the epic exists to fix).
    const plan = runDecide(worState(), null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wire_or_retire_target");
    assert.ok(a, "expected a wire_or_retire_target dispatch");
    assert.ok(a.prompt_args, "dispatch must carry prompt_args (never the empty-args dry-run no-op)");

    // apply:true — the autopilot maps apply=true → --apply; without it every
    // dispatched run is a headless dry-run that resolves nothing.
    assert.equal(a.prompt_args.apply, true, "prompt_args.apply must be true (anti-dry-run-no-op, retro #1078)");

    // max_items:2 — the per-run resolution cap (oldest-first).
    assert.equal(a.prompt_args.max_items, 2, "prompt_args.max_items must be 2 (per-run cap)");

    // risk_carveout — machine-readable carve-out list, not prose. Must contain
    // the risk-core prefix so the risk/live-execution guard is auditable at the
    // dispatch seam and unit-testable (design concept Invariant 3/9).
    assert.ok(
      Array.isArray(a.prompt_args.risk_carveout),
      "prompt_args.risk_carveout must be a list, not prose",
    );
    assert.ok(
      a.prompt_args.risk_carveout.includes("web/src/lib/risk/"),
      "risk_carveout must include web/src/lib/risk/ (the risk-core carve-out prefix)",
    );
    assert.ok(
      a.prompt_args.risk_carveout.includes("web/src/lib/execution/"),
      "risk_carveout must include web/src/lib/execution/ (live-execution carve-out)",
    );
    assert.ok(
      a.prompt_args.risk_carveout.includes("web/src/lib/kalshi/kalshi-executor.ts"),
      "risk_carveout must include the kalshi-executor live-execution path",
    );
  });

  test("respects the 24h cooldown (SIGNAL_COOLDOWNS)", () => {
    // Fired 1h ago → still inside the 24h window → suppressed.
    const state = worState({
      started_epoch: now,
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
        wire_or_retire_target: now - 3600,
      },
    });
    const plan = runDecide(state, null, [], undefined);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "wire_or_retire_target"),
      undefined,
      "within the 24h cooldown window the resolver must not re-dispatch",
    );
  });

  test("fires again once the 24h cooldown has elapsed", () => {
    const state = worState({
      started_epoch: now,
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
        wire_or_retire_target: now - (DAY + 60),
      },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wire_or_retire_target");
    assert.ok(a, "past the 24h cooldown the resolver dispatches again");
    assert.equal(a.skill, "hydra-wire-or-retire");
  });

  test("is EXCLUDED under orch-only scope (target-scope class)", () => {
    const state = worState({ scope: "orch-only" });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "wire_or_retire_target"),
      undefined,
      "orch-only scope must exclude the target-scope wire_or_retire_target class",
    );
  });

  test("is ALLOWED under target-only scope", () => {
    const state = worState({ scope: "target-only" });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wire_or_retire_target");
    assert.ok(a, "target-only scope must allow the target-scope wire_or_retire_target class");
    assert.equal(a.skill, "hydra-wire-or-retire");
  });
});

// ---------------------------------------------------------------------------
// wayfinder_orch signal class (issue #3351, epic #3350, ADR-0029)
// ---------------------------------------------------------------------------
//
// The single AFK working class for wayfinder maps. collect-state.sh owns the
// native GraphQL frontier enumeration and pre-resolves the next AFK-typed,
// unblocked, unclaimed frontier ticket into two signals — `wayfinder_orch_frontier`
// (an `issue-<N>` ref, or `none`) and `wayfinder_orch_ticket_type` (research|task).
// decide.py stays PURE: it reads those precomputed signals verbatim (AC #3 — no
// gh/curl/GraphQL inside decide.py) and emits a pure `dispatch` action referencing
// the pre-resolved ticket, threading the ticket ref + type into prompt_args so the
// playbook can resolve ticket-type -> skill at dispatch time.
//
// This suite is the decide.py-golden-fixture half of AC #2: frontier-available
// signal present + cooldown satisfied -> wayfinder_orch dispatch action; absent
// signal -> no dispatch.
//
// Contract points this suite pins:
//  - fires on wayfinder_orch_frontier (an issue-<N> ref), dispatching with the
//    ticket + ticket_type threaded into prompt_args
//  - is a NO-OP without the signal, and when the signal is the literal `none`
//  - respects the 1h cooldown (SIGNAL_COOLDOWNS["wayfinder_orch"])
//  - is orch-scope: EXCLUDED under target-only, ALLOWED under orch-only + all
//  - OMITS the model param (inherit parent per #1093 — authoring/judgment work)
//  - defaults ticket_type to "research" when collect-state.sh didn't stamp one
//
// New TOP-LEVEL describe with its own lifecycle (decide.py is a pure CLI over
// temp files — nothing to tear down — but kept top-level per the CLAUDE.md
// authoring rule).
// ---------------------------------------------------------------------------
describe("decide.py — wayfinder_orch signal class (issue #3351)", () => {
  const HOUR = 60 * 60;
  const now = Math.floor(Date.now() / 1000);

  function wfState(over: Record<string, unknown> = {}): any {
    // signal_last_fired must include the class key at 0 (cooled) by default so
    // the 1h cooldown gate does not spuriously suppress the dispatch.
    return baseState({
      signals: {
        wayfinder_orch_frontier: "issue-4242",
        wayfinder_orch_ticket_type: "research",
      },
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
        wayfinder_orch: 0,
      },
      ...over,
    });
  }

  test("fires on wayfinder_orch_frontier (research) — threads ticket + type into prompt_args", () => {
    const plan = runDecide(wfState(), null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wayfinder_orch");
    assert.ok(a, "wayfinder_orch must dispatch when a frontier ticket is pre-resolved and cooled");
    // decide.py emits the taxonomy default skill; the playbook overrides per type.
    assert.equal(a.skill, "hydra-issue-research");
    assert.ok(a.prompt_args, "dispatch must carry prompt_args referencing the pre-resolved ticket");
    assert.equal(a.prompt_args.ticket, "issue-4242", "prompt_args.ticket must be the pre-resolved frontier ref");
    assert.equal(a.prompt_args.ticket_type, "research", "prompt_args.ticket_type must carry the frontier type");
  });

  test("carries the task ticket_type verbatim for task frontier tickets", () => {
    const state = wfState({
      signals: {
        wayfinder_orch_frontier: "issue-4243",
        wayfinder_orch_ticket_type: "task",
      },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wayfinder_orch");
    assert.ok(a, "wayfinder_orch must dispatch on a task-typed frontier ticket");
    assert.equal(a.prompt_args.ticket, "issue-4243");
    assert.equal(a.prompt_args.ticket_type, "task", "task type must pass through so the playbook routes to hydra-dev");
  });

  test("does NOT fire without the wayfinder_orch_frontier signal (AC #2 absent-signal arm)", () => {
    const state = wfState({ signals: {} });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "wayfinder_orch"),
      undefined,
      "no pre-resolved frontier ticket → no wayfinder dispatch",
    );
  });

  test("does NOT fire when the frontier signal is the literal `none`", () => {
    const state = wfState({
      signals: { wayfinder_orch_frontier: "none" },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "wayfinder_orch"),
      undefined,
      "a `none` frontier (no eligible ticket on any approved map) must not dispatch",
    );
  });

  test("defaults ticket_type to research when collect-state.sh did not stamp one", () => {
    const state = wfState({
      signals: { wayfinder_orch_frontier: "issue-4244" },  // no ticket_type
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wayfinder_orch");
    assert.ok(a, "an unstamped ticket_type must still dispatch (default research)");
    assert.equal(a.prompt_args.ticket_type, "research", "missing ticket_type defaults to research (matches the taxonomy default skill)");
  });

  test("OMITS the model param — inherit parent per #1093 (authoring/judgment work)", () => {
    const plan = runDecide(wfState(), null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wayfinder_orch");
    assert.ok(a, "expected a wayfinder_orch dispatch");
    assert.equal("model" in a, false, "wayfinder_orch dispatch must not pin a model (#1093)");
    assert.equal(a.prompt_args?.model, undefined, "no model in prompt_args either");
  });

  test("respects the 1h cooldown (SIGNAL_COOLDOWNS)", () => {
    // Fired 30m ago → still inside the 1h window → suppressed.
    const state = wfState({
      started_epoch: now,
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
        wayfinder_orch: now - 30 * 60,
      },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "wayfinder_orch"),
      undefined,
      "within the 1h cooldown window wayfinder_orch must not re-dispatch",
    );
  });

  test("fires again once the 1h cooldown has elapsed", () => {
    const state = wfState({
      started_epoch: now,
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
        wayfinder_orch: now - (HOUR + 60),
      },
    });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wayfinder_orch");
    assert.ok(a, "past the 1h cooldown wayfinder_orch dispatches again");
    assert.equal(a.skill, "hydra-issue-research");
  });

  test("is EXCLUDED under target-only scope (orch-scope class)", () => {
    const state = wfState({ scope: "target-only" });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "wayfinder_orch"),
      undefined,
      "target-only scope must exclude the orch-scope wayfinder_orch class",
    );
  });

  test("is ALLOWED under orch-only scope", () => {
    const state = wfState({ scope: "orch-only" });
    const plan = runDecide(state, null);
    const a = findAction(plan, (x) => x.type === "dispatch" && x.slot === "wayfinder_orch");
    assert.ok(a, "orch-only scope must allow the orch-scope wayfinder_orch class");
    assert.equal(a.skill, "hydra-issue-research");
  });

  test("wayfinder_orch in burned_classes is NOT re-dispatched (mirrors #432)", () => {
    const state = wfState({ burned_classes: ["wayfinder_orch"] });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "wayfinder_orch"),
      undefined,
      "burned signal class wayfinder_orch must not be re-dispatched",
    );
  });
});

// ---------------------------------------------------------------------------
// Destination gate — approved-map guard (issue #3353, epic #3350, ADR-0029)
// ---------------------------------------------------------------------------
//
// ADR-0029 Decision 1: a `wayfinder:map` issue is a dispatchable APPROVED map
// only when it does NOT carry the draft gate label `wayfinder:destination-pending`.
// The frontier collector in collect-state.sh enforces this at the MAP-SELECTION
// step: its jq program filters the open `wayfinder:map` list down to the maps
// that lack the gate label BEFORE it walks any map's sub-issue frontier. A
// destination-pending map's number therefore never enters `WF_MAP_NUMS`, so the
// GraphQL frontier walk that resolves an AFK ticket into `wayfinder_orch_frontier`
// never runs for it — its AFK tickets are structurally un-dispatchable.
//
// collect-state.sh is network-dependent (live `gh issue list` + GraphQL), so we
// cannot run the whole collector offline. The gate itself, however, is a PURE jq
// program embedded in the source — we golden-fixture it by EXTRACTING that exact
// program from collect-state.sh (no copy — it stays coupled to production) and
// running it under the real `jq` binary against label fixtures. This pins:
//
//   - AC #1: an AFK ticket under a destination-pending map is NOT dispatched —
//     i.e. the pending map is excluded from the map list the frontier walk runs
//     over, so no ticket under it can ever surface into the frontier signal.
//   - AC #2: after `wayfinder:destination-pending` is removed, that map becomes
//     dispatchable on the next tick — i.e. it re-enters the map list and its
//     tickets become walk-eligible.
//
// New TOP-LEVEL describe with its own lifecycle (pure CLI over stdin — nothing
// to tear down — but kept top-level per the CLAUDE.md authoring rule).
// ---------------------------------------------------------------------------
describe("collect-state.sh — wayfinder destination-gate approved-map guard (issue #3353)", () => {
  const COLLECT_STATE = join(SCRIPTS, "collect-state.sh");

  // Extract the EXACT map-selection jq program from collect-state.sh so the
  // golden fixture exercises the production filter, not a copy that could drift.
  // The program is the `--jq '...'` argument to the `gh issue list --label
  // 'wayfinder:map'` call — anchored on that label so it can't grab an unrelated
  // jq block. Fails loud if the anchor moves (the guard must stay findable).
  function extractMapSelectionJq(): string {
    const src = readFileSync(COLLECT_STATE, "utf-8");
    const MAP_LABEL = "--label 'wayfinder:map'";
    const anchor = src.indexOf(MAP_LABEL);
    assert.ok(anchor >= 0, "wayfinder:map frontier gh call missing from collect-state.sh");
    const JQ_FLAG = "--jq '";
    const jqStart = src.indexOf(JQ_FLAG, anchor);
    assert.ok(jqStart >= 0, "map-selection --jq program missing after the wayfinder:map call");
    const progStart = jqStart + JQ_FLAG.length;
    const progEnd = src.indexOf("'", progStart);
    assert.ok(progEnd > progStart, "unterminated map-selection jq program in collect-state.sh");
    const prog = src.slice(progStart, progEnd);
    // Sanity: the guard label MUST appear inside the extracted program — this is
    // the whole point of the gate. If it ever disappears, the approved-map guard
    // is gone and the test must fail rather than silently pass.
    assert.ok(
      prog.includes("wayfinder:destination-pending"),
      "extracted map-selection filter lost the wayfinder:destination-pending guard",
    );
    return prog;
  }

  // Run the extracted jq program over a `gh issue list --json number,labels`-shaped
  // fixture; returns the sorted array of admitted (approved) map numbers.
  function selectApprovedMaps(maps: unknown[]): number[] {
    const prog = extractMapSelectionJq();
    const r = spawnSync("jq", ["-c", prog], {
      input: JSON.stringify(maps),
      encoding: "utf-8",
    });
    assert.equal(r.status, 0, `jq exited non-zero: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  // gh-shaped map row: `{number, labels:[{name}]}` — the exact shape
  // collect-state.sh requests via `--json number,labels`.
  function mapRow(num: number, extraLabels: string[] = []): any {
    return { number: num, labels: [{ name: "wayfinder:map" }, ...extraLabels.map((name) => ({ name }))] };
  }

  test("AC #1: a destination-pending map is EXCLUDED from the frontier walk (its AFK ticket is not dispatched)", () => {
    const pendingMap = mapRow(900, ["wayfinder:destination-pending"]);
    const approvedMap = mapRow(901);
    const admitted = selectApprovedMaps([pendingMap, approvedMap]);
    assert.ok(
      !admitted.includes(900),
      "a wayfinder:destination-pending map must NOT enter the map list the frontier walk runs over — " +
        "so no AFK ticket under it can surface into wayfinder_orch_frontier",
    );
    assert.ok(
      admitted.includes(901),
      "an approved map (no gate label) must remain dispatchable alongside the excluded pending one",
    );
  });

  test("AC #2: removing wayfinder:destination-pending makes the map dispatchable on the next tick", () => {
    // Same map #900, but the operator has removed the gate label (= approve).
    const beforeApproval = selectApprovedMaps([mapRow(900, ["wayfinder:destination-pending"]), mapRow(901)]);
    assert.deepEqual(beforeApproval, [901], "before approval only the un-gated map #901 is admitted");

    const afterApproval = selectApprovedMaps([mapRow(900), mapRow(901)]);
    assert.deepEqual(
      afterApproval,
      [900, 901],
      "after the gate label is removed, map #900 re-enters the frontier walk (dispatchable next tick)",
    );
  });

  test("guard is label-specific — an unrelated wayfinder label does NOT gate a map", () => {
    // Only wayfinder:destination-pending gates. A map carrying some other
    // wayfinder:* label but not the gate label stays approved.
    const admitted = selectApprovedMaps([mapRow(902, ["wayfinder:charting"])]);
    assert.deepEqual(admitted, [902], "a non-gate wayfinder label must not exclude the map");
  });

  test("output is deterministically sorted (stable frontier pick across ticks)", () => {
    // ADR-0029: maps are walked oldest-first / stable ordering so the frontier
    // pick is deterministic. The map-selection jq ends in `| sort`.
    const admitted = selectApprovedMaps([mapRow(905), mapRow(901), mapRow(903)]);
    assert.deepEqual(admitted, [901, 903, 905], "admitted map numbers must be sorted ascending");
  });
});

// ---------------------------------------------------------------------------
// Stalled-map staleness sweep — housekeeping backstop (issue #3355, epic #3350,
// ADR-0029)
// ---------------------------------------------------------------------------
//
// Two stall classes strand a wayfinder map on the OPERATOR's side with no
// autopilot working path (both need the human — ADR-0029 Decision 3):
//   1. A `wayfinder:destination-pending` map the operator never approves (a draft
//      forever; its whole AFK frontier is un-dispatchable per the #3353 gate).
//   2. An OPEN, unblocked, unclaimed HITL frontier ticket (`wayfinder:grilling` |
//      `wayfinder:prototype`) on an APPROVED map the operator never picks up —
//      `wayfinder_orch` never dispatches HITL tickets, so it stalls its map's AFK
//      frontier.
//
// collect-state.sh's staleness sweep emits two counts — `wayfinder_stale_maps`
// and `wayfinder_stale_hitl` — of the ones aged PAST the threshold
// (WAYFINDER_STALENESS_THRESHOLD_SEC, default 48h) so /hydra-review and the digest
// can flag the genuinely stalled ones distinctly from the fresh backlog. Fresh
// (within-threshold) maps/tickets are NOT flagged.
//
// The sweep is network-dependent (live gh list + per-map GraphQL), so we cannot
// run the whole collector offline. Its two age filters, however, are PURE jq
// programs embedded in the source — we golden-fixture them by EXTRACTING the exact
// programs from collect-state.sh (no copy — they stay coupled to production) and
// running them under the real `jq` binary against timestamp fixtures. This pins
// the two acceptance criteria: a past-threshold map/ticket IS counted; a
// within-threshold one is NOT.
//
// New TOP-LEVEL describe with its own lifecycle (pure CLI over stdin — nothing to
// tear down — but kept top-level per the CLAUDE.md authoring rule).
// ---------------------------------------------------------------------------
describe("collect-state.sh — stalled-map staleness sweep (issue #3355)", () => {
  const COLLECT_STATE = join(SCRIPTS, "collect-state.sh");
  const THRESHOLD_SEC = 172800; // 48h — the documented default in collect-state.sh
  const src = readFileSync(COLLECT_STATE, "utf-8");

  // ISO-8601 UTC timestamp `sec` seconds in the past — the `createdAt` shape gh /
  // GraphQL emit and the jq `fromdateiso8601` parses.
  function agoIso(sec: number): string {
    return new Date(Date.now() - sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  const STALE_ISO = agoIso(THRESHOLD_SEC + 6 * 3600); // 6h past the threshold
  const FRESH_ISO = agoIso(3600); // 1h old — well within the threshold

  // Generic `--jq '...'` extractor anchored on a preceding literal so it grabs the
  // exact production program, not a copy that could drift. Fails loud if the
  // anchor moves (the sweep must stay findable) and substitutes the literal
  // threshold for the `${WAYFINDER_STALENESS_THRESHOLD_SEC}` shell interpolation so
  // the extracted program runs standalone under jq.
  function extractJqAfter(anchorLiteral: string, mustInclude: string): string {
    const anchor = src.indexOf(anchorLiteral);
    assert.ok(anchor >= 0, `staleness-sweep anchor ${JSON.stringify(anchorLiteral)} missing from collect-state.sh`);
    const JQ_FLAG = "--jq \"";
    const jqStart = src.indexOf(JQ_FLAG, anchor);
    assert.ok(jqStart >= 0, `--jq program missing after ${JSON.stringify(anchorLiteral)}`);
    const progStart = jqStart + JQ_FLAG.length;
    // Scan for the UNESCAPED closing double-quote — the HITL program embeds `\"`
    // (backslash-quote) inside for its label literals, so a naive indexOf('"')
    // would truncate at the first embedded quote.
    let progEnd = progStart;
    while (progEnd < src.length && !(src[progEnd] === '"' && src[progEnd - 1] !== "\\")) {
      progEnd += 1;
    }
    assert.ok(progEnd > progStart && progEnd < src.length, "unterminated staleness-sweep jq program in collect-state.sh");
    // Unescape the shell `\"` -> `"` so the extracted program is valid jq.
    let prog = src.slice(progStart, progEnd).replace(/\\"/g, '"');
    assert.ok(
      prog.includes(mustInclude),
      `extracted staleness filter lost its guard token ${JSON.stringify(mustInclude)}`,
    );
    // The production program references the threshold via shell interpolation;
    // substitute the literal so the standalone jq run has a concrete bound.
    prog = prog.replace("${WAYFINDER_STALENESS_THRESHOLD_SEC}", String(THRESHOLD_SEC));
    assert.ok(
      prog.includes(String(THRESHOLD_SEC)),
      "threshold interpolation was not present in the extracted program",
    );
    return prog;
  }

  function runJq(prog: string, input: unknown): number {
    const r = spawnSync("jq", [prog], { input: JSON.stringify(input), encoding: "utf-8" });
    assert.equal(r.status, 0, `jq exited non-zero: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  // ---- 1. Stale destination-pending maps -----------------------------------
  // The map-count filter is the --jq after the second `--label 'wayfinder:map'`
  // gh call (the one that ALSO carries `--label 'wayfinder:destination-pending'`).
  function mapStaleJq(): string {
    return extractJqAfter("--label 'wayfinder:destination-pending' \\", "createdAt");
  }

  test("AC: a destination-pending map older than the threshold IS flagged", () => {
    const n = runJq(mapStaleJq(), [{ number: 900, createdAt: STALE_ISO }]);
    assert.equal(n, 1, "a past-threshold destination-pending map must be counted as stale");
  });

  test("AC: a fresh (within-threshold) destination-pending map is NOT flagged", () => {
    const n = runJq(mapStaleJq(), [{ number: 901, createdAt: FRESH_ISO }]);
    assert.equal(n, 0, "a within-threshold map is still in the normal review cadence, not stale");
  });

  test("mixed board: only the past-threshold maps are counted", () => {
    const n = runJq(mapStaleJq(), [
      { number: 900, createdAt: STALE_ISO },
      { number: 901, createdAt: FRESH_ISO },
      { number: 902, createdAt: STALE_ISO },
    ]);
    assert.equal(n, 2, "exactly the two past-threshold maps count; the fresh one does not");
  });

  // ---- 2. Stale un-picked-up HITL frontier tickets -------------------------
  // The HITL filter is the --jq after the `wayfinder:grilling` GraphQL walk; it
  // consumes the GraphQL response shape (.data.repository.issue.subIssues.nodes).
  function hitlStaleJq(): string {
    return extractJqAfter("subIssues(first:100){ nodes { number state createdAt", "assignees.totalCount==0");
  }

  // GraphQL-response-shaped sub-issue node.
  function node(
    number: number,
    label: string,
    opts: { createdAt?: string; state?: string; assigned?: number; blockedOpen?: boolean } = {},
  ): any {
    return {
      number,
      state: opts.state ?? "OPEN",
      createdAt: opts.createdAt ?? STALE_ISO,
      labels: { nodes: [{ name: label }] },
      assignees: { totalCount: opts.assigned ?? 0 },
      blockedBy: { nodes: opts.blockedOpen ? [{ number: 99, state: "OPEN" }] : [] },
    };
  }
  function graphqlResponse(nodes: any[]): any {
    return { data: { repository: { issue: { subIssues: { nodes } } } } };
  }

  test("AC: a stale, unblocked, unclaimed HITL ticket IS flagged", () => {
    const n = runJq(
      hitlStaleJq(),
      graphqlResponse([node(10, "wayfinder:grilling"), node(11, "wayfinder:prototype")]),
    );
    assert.equal(n, 2, "both past-threshold, unblocked, unclaimed HITL tickets must count");
  });

  test("AC: a fresh (within-threshold) HITL ticket is NOT flagged", () => {
    const n = runJq(hitlStaleJq(), graphqlResponse([node(12, "wayfinder:grilling", { createdAt: FRESH_ISO })]));
    assert.equal(n, 0, "a within-threshold HITL ticket is not yet stalled");
  });

  test("a stale but CLAIMED (assigned) HITL ticket is NOT flagged — it has a live worker/owner", () => {
    const n = runJq(hitlStaleJq(), graphqlResponse([node(13, "wayfinder:grilling", { assigned: 1 })]));
    assert.equal(n, 0, "an assigned HITL ticket has been picked up — not an un-picked-up stall");
  });

  test("a stale but BLOCKED HITL ticket is NOT flagged — it is not on the frontier yet", () => {
    const n = runJq(hitlStaleJq(), graphqlResponse([node(14, "wayfinder:prototype", { blockedOpen: true })]));
    assert.equal(n, 0, "a ticket with an open blocker is not un-picked-up frontier work");
  });

  test("a stale AFK-typed ticket is NOT counted as HITL — only grilling/prototype are HITL", () => {
    const n = runJq(
      hitlStaleJq(),
      graphqlResponse([node(15, "wayfinder:research"), node(16, "wayfinder:task")]),
    );
    assert.equal(n, 0, "AFK types (research/task) have an autopilot path; they are not HITL stalls");
  });

  test("mixed frontier: only the stale, unblocked, unclaimed HITL ticket survives every gate", () => {
    const n = runJq(
      hitlStaleJq(),
      graphqlResponse([
        node(20, "wayfinder:grilling"), // stale, unblocked, unclaimed → count
        node(21, "wayfinder:prototype", { createdAt: FRESH_ISO }), // fresh → skip
        node(22, "wayfinder:grilling", { assigned: 1 }), // claimed → skip
        node(23, "wayfinder:prototype", { blockedOpen: true }), // blocked → skip
        node(24, "wayfinder:research"), // AFK-typed → skip
        node(25, "wayfinder:grilling", { state: "CLOSED" }), // closed → skip
      ]),
    );
    assert.equal(n, 1, "exactly one node clears every eligibility+staleness gate");
  });

  // ---- 3. The signals are emitted with the documented names/threshold --------
  test("collect-state.sh emits the sweep signals with the documented names and default threshold", () => {
    assert.ok(src.includes('echo -n "wayfinder_stale_maps="'), "wayfinder_stale_maps signal must be emitted");
    assert.ok(src.includes('echo "$WF_STALE_HITL"'), "wayfinder_stale_hitl count must be emitted");
    assert.ok(
      src.includes('echo -n "wayfinder_stale_hitl="'),
      "wayfinder_stale_hitl signal label must be emitted",
    );
    assert.ok(
      src.includes("HYDRA_WAYFINDER_STALENESS_SEC:-172800"),
      "the 48h default threshold (env-overridable) must be present",
    );
    assert.ok(
      src.includes('echo "wayfinder_staleness_threshold_sec=${WAYFINDER_STALENESS_THRESHOLD_SEC}"'),
      "the resolved threshold must be surfaced so downstream readers can label the age bound",
    );
  });
});

// ---------------------------------------------------------------------------
// Saturation guards — global cap <=2 (issue #3354, epic #3350, ADR-0029 Dec. 2)
// ---------------------------------------------------------------------------
//
// A live `wayfinder_orch` worker CLAIMS its ticket by self-assigning it (dispatch
// protocol, hydra-autopilot.md). collect-state.sh counts open, assigned, AFK-typed
// tickets across all approved maps into `wayfinder_orch_inflight_global`; decide.py
// reads that counter VERBATIM (staying PURE — no gh/GraphQL) and suppresses a new
// dispatch once two workers are in flight. These golden fixtures pin the decide.py
// half of the guard: dispatch at 0/1 in flight, suppress at >=2, and fail-open on
// an absent/garbage counter (the structural per-map single-flight guard in
// collect-state.sh still holds; the cap must not block on missing evidence).
//
// New TOP-LEVEL describe with its own lifecycle (per the CLAUDE.md authoring rule)
// — decide.py runs are pure over temp state files, nothing shared to tear down.
// ---------------------------------------------------------------------------
describe("decide.py — wayfinder_orch global-cap saturation guard (issue #3354)", () => {
  function wfStateCap(inflight: unknown, over: Record<string, unknown> = {}): any {
    const signals: Record<string, unknown> = {
      wayfinder_orch_frontier: "issue-5000",
      wayfinder_orch_ticket_type: "research",
    };
    // Only stamp the counter when a value is supplied — omit it entirely for the
    // absent-signal arm (mirrors collect-state.sh emitting nothing).
    if (inflight !== undefined) signals.wayfinder_orch_inflight_global = inflight;
    return baseState({
      signals,
      signal_last_fired: {
        health: 0, sweep_orch: 0, sweep_target: 0,
        discover_orch: 0, discover_target: 0,
        wayfinder_orch: 0,
      },
      ...over,
    });
  }

  function wfDispatch(plan: any): any {
    return findAction(plan, (a) => a.type === "dispatch" && a.slot === "wayfinder_orch");
  }

  test("dispatches at 0 in-flight (global cap not reached)", () => {
    const plan = runDecide(wfStateCap("0"), null);
    assert.ok(wfDispatch(plan), "0 in-flight workers must not suppress a wayfinder_orch dispatch");
  });

  test("dispatches at 1 in-flight (one slot still free under the cap)", () => {
    const plan = runDecide(wfStateCap("1"), null);
    assert.ok(wfDispatch(plan), "1 in-flight worker leaves one slot free — dispatch must proceed");
  });

  test("SUPPRESSES at 2 in-flight (global cap of <=2 reached)", () => {
    const plan = runDecide(wfStateCap("2"), null);
    assert.equal(
      wfDispatch(plan), undefined,
      "two workers already in flight — the global cap must suppress a third wayfinder_orch dispatch",
    );
  });

  test("SUPPRESSES above the cap (>=2 is a ceiling, not an equality)", () => {
    const plan = runDecide(wfStateCap("5"), null);
    assert.equal(
      wfDispatch(plan), undefined,
      "an over-cap counter (defensive) must also suppress — the guard is >= 2, not == 2",
    );
  });

  test("fail-open on an ABSENT counter (default 0 — never block on missing evidence)", () => {
    // collect-state.sh emitted no counter (older state / gh hiccup). The cap must
    // NOT block: absence is treated as 0, and the structural per-map single-flight
    // guard still prevents double-dispatch of a single ticket.
    const plan = runDecide(wfStateCap(undefined), null);
    assert.ok(
      wfDispatch(plan),
      "an absent in-flight counter must default to 0 (fail-open), not suppress the frontier",
    );
  });

  test("fail-open on a GARBAGE counter (non-numeric → 0)", () => {
    const plan = runDecide(wfStateCap("not-a-number"), null);
    assert.ok(
      wfDispatch(plan),
      "a malformed counter must default to 0 (fail-open on the parse), not suppress the frontier",
    );
  });

  test("guard order is FRONTIER-FIRST: no frontier ticket → no dispatch regardless of the counter", () => {
    // Even at 0 in-flight, a `none` frontier means there is nothing to work — the
    // cap check never runs because the frontier guard returns first.
    const state = wfStateCap("0", { signals: { wayfinder_orch_frontier: "none", wayfinder_orch_inflight_global: "0" } });
    const plan = runDecide(state, null);
    assert.equal(
      wfDispatch(plan), undefined,
      "a `none` frontier must not dispatch even under the cap — the frontier guard is checked first",
    );
  });
});

// ---------------------------------------------------------------------------
// Saturation guards — collect-state.sh in-flight count + per-map single-flight
// (issue #3354, epic #3350, ADR-0029 Decision 2)
// ---------------------------------------------------------------------------
//
// The COUNTING half lives in collect-state.sh: one native GraphQL query per
// approved map derives (a) the map's in-flight count = OPEN, assigned, AFK-typed
// sub-issues, and (b) the frontier pick, which it withholds when the map already
// has an in-flight worker (per-map single-flight). collect-state.sh is
// network-dependent (live gh/GraphQL), so we cannot run the whole collector
// offline — but the per-map derivation is a PURE jq program embedded in the
// source. We golden-fixture it by EXTRACTING that exact program from
// collect-state.sh (no copy — it stays coupled to production; fails loud if the
// guard ever disappears) and running it under the real `jq` binary against
// `subIssues`-shaped GraphQL fixtures. This pins:
//   - HITL types (grilling/prototype) are NEVER counted and NEVER picked (AC #1).
//   - per-map single-flight: a map with an in-flight (assigned) worker yields NO
//     new frontier pick (AC #2, the <=1-per-map bound).
//   - the emitted in-flight count reflects assigned AFK tickets (feeds the global
//     cap the decide.py suite above pins).
//
// New TOP-LEVEL describe, own lifecycle (pure CLI over stdin — nothing to tear
// down), per the CLAUDE.md authoring rule.
// ---------------------------------------------------------------------------
describe("collect-state.sh — wayfinder saturation guards: in-flight count + per-map single-flight (issue #3354)", () => {
  const COLLECT_STATE = join(SCRIPTS, "collect-state.sh");

  // Extract the EXACT per-map derivation jq program from collect-state.sh so the
  // golden fixture exercises the production filter, not a drifting copy. The
  // program is the `--jq '...'` argument on the per-map GraphQL query — anchored
  // on the `subIssues` GraphQL field so it can't grab the (separate) map-selection
  // filter. Fails loud if the anchor moves (the guard must stay findable).
  function extractPerMapJq(): string {
    const src = readFileSync(COLLECT_STATE, "utf-8");
    // Anchor on the GraphQL query body's data path (unique to the per-map query).
    const ANCHOR = ".data.repository.issue.subIssues.nodes";
    const anchor = src.indexOf(ANCHOR);
    assert.ok(anchor >= 0, "per-map subIssues GraphQL --jq program missing from collect-state.sh");
    // The program starts at the opening `--jq '` before the anchor.
    const JQ_FLAG = "--jq '";
    const jqStart = src.lastIndexOf(JQ_FLAG, anchor);
    assert.ok(jqStart >= 0 && jqStart < anchor, "per-map --jq flag missing before the subIssues query body");
    const progStart = jqStart + JQ_FLAG.length;
    const progEnd = src.indexOf("'", progStart);
    assert.ok(progEnd > progStart, "unterminated per-map jq program in collect-state.sh");
    const prog = src.slice(progStart, progEnd);
    // Sanity: the extracted program MUST carry both guard mechanisms.
    assert.ok(
      prog.includes("assignees.totalCount>0"),
      "extracted per-map filter lost the in-flight (assigned) count — the global-cap input",
    );
    assert.ok(
      prog.includes("assignees.totalCount==0"),
      "extracted per-map filter lost the unassigned-only frontier pick (single-flight relies on it)",
    );
    return prog;
  }

  // Run the extracted jq over a `subIssues`-shaped GraphQL fixture; returns the
  // program's single-line output (`<inflight>` or `<inflight> <num> <type>`).
  function runPerMap(nodes: any[]): string {
    const prog = extractPerMapJq();
    const payload = { data: { repository: { issue: { subIssues: { nodes } } } } };
    const r = spawnSync("jq", ["-r", prog], { input: JSON.stringify(payload), encoding: "utf-8" });
    assert.equal(r.status, 0, `jq exited non-zero: ${r.stderr}`);
    return r.stdout.trim();
  }

  // A GraphQL sub-issue node in the exact shape collect-state.sh queries.
  function node(num: number, type: string, opts: { assigned?: boolean; blockedByOpen?: number } = {}): any {
    return {
      number: num,
      state: "OPEN",
      labels: { nodes: [{ name: type }] },
      assignees: { totalCount: opts.assigned ? 1 : 0 },
      blockedBy: { nodes: opts.blockedByOpen != null ? [{ number: opts.blockedByOpen, state: "OPEN" }] : [] },
    };
  }

  test("AC #1: HITL-typed tickets (grilling/prototype) are NEVER counted or picked", () => {
    // A map whose only open tickets are HITL types: in-flight 0 (an assigned HITL
    // ticket is NOT a wayfinder_orch worker) and NO frontier pick.
    const out = runPerMap([
      node(30, "wayfinder:grilling", { assigned: true }),
      node(31, "wayfinder:prototype"),
    ]);
    assert.equal(out, "0", "HITL tickets must not be counted in-flight nor picked into the AFK frontier");
  });

  test("picks an unblocked, unassigned AFK ticket when the map has zero in-flight", () => {
    const out = runPerMap([node(40, "wayfinder:research")]);
    assert.equal(out, "0 40 research", "a fresh unblocked AFK ticket is picked; in-flight count is 0");
  });

  test("per-map single-flight (AC #2): an in-flight worker WITHHOLDS a second pick on the same map", () => {
    // #41 is claimed (assigned) → in-flight 1. #42 is unblocked+unassigned but the
    // map already has a worker, so NO new pick is emitted (only the count).
    const out = runPerMap([
      node(41, "wayfinder:task", { assigned: true }),
      node(42, "wayfinder:research"),
    ]);
    assert.equal(
      out, "1",
      "a map with one in-flight worker must yield in-flight=1 and NO new frontier pick (single-flight)",
    );
  });

  test("in-flight count reflects assigned AFK tickets (feeds the global cap)", () => {
    // Two claimed AFK tickets on one map → in-flight 2, no new pick.
    const out = runPerMap([
      node(50, "wayfinder:task", { assigned: true }),
      node(51, "wayfinder:research", { assigned: true }),
    ]);
    assert.equal(out, "2", "two claimed AFK tickets on a map count as 2 in-flight (global-cap input)");
  });

  test("a blocked AFK ticket is not picked (in-flight 0, no pick)", () => {
    const out = runPerMap([node(60, "wayfinder:research", { blockedByOpen: 999 })]);
    assert.equal(out, "0", "a ticket whose blocker is still OPEN is neither in-flight nor pickable");
  });

  test("an empty frontier yields in-flight 0 and no pick", () => {
    assert.equal(runPerMap([]), "0", "a map with no AFK tickets contributes 0 in-flight and no pick");
  });
});
