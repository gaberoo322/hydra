/**
 * Regression test for `scripts/autopilot/assert_invariants.py` (issue
 * #426). Each of INV-001 through INV-008 has at least one violating-plan
 * case asserting the script raises with the expected greppable ID.
 *
 * The invariants live in Python because decide.py's output is consumed
 * by both the Claude harness (model executes the plan) and by smoke
 * scripts. Encoding the guards as a separate module means a future
 * decide.py refactor can be cross-validated against the guards without
 * touching tests.
 *
 * Invariant IDs (kept stable for grep — same identifiers as
 * assert_invariants.py docstring):
 *
 *   INV-001 never auto-merge a Tier-0 non-mechanical PR
 *   INV-002 never dispatch into a busy pipeline slot
 *   INV-003 never re-dispatch a class in burned_classes
 *   INV-004 never re-reap a task_id already in reaped_task_ids
 *   INV-005 emit `terminate` when cumulative_tokens >= budget
 *   INV-006 reap actions precede dispatch actions in the same plan
 *   INV-007 auto-merge only when QA verdict is PASS
 *   INV-008 no dispatch for a scope-disallowed class (except `health`)
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const ASSERTS = join(SCRIPTS, "assert_invariants.py");

interface Tmp { dir: string; plan: string; state: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-inv-test-"));
  return { dir, plan: join(dir, "plan.json"), state: join(dir, "state.json") };
}

function baseState(o: Partial<{
  scope: string;
  cumulative_tokens: number;
  burned_classes: string[];
  slots: Record<string, unknown>;
  reaped_task_ids: string[];
  token_budget: number;
}> = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: o.token_budget ?? 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: 5,
      scope: o.scope ?? "all",
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: o.cumulative_tokens ?? 0,
    dispatches: 0,
    idle_turns: 0,
    burned_classes: o.burned_classes ?? [],
    reaped_task_ids: o.reaped_task_ids ?? [],
    failure_log: [],
    slots: o.slots ?? {
      dev_orch: null, qa_orch: null, research_orch: null,
      dev_target: null, qa_target: null, research_target: null,
    },
    signal_last_fired: { health: 0, sweep_orch: 0, sweep_target: 0, discover_orch: 0, discover_target: 0 },
  };
}

function runAsserts(plan: any, state: any): { status: number; stdout: string; stderr: string } {
  const tmp = makeTmp();
  try {
    writeFileSync(tmp.plan, JSON.stringify(plan));
    writeFileSync(tmp.state, JSON.stringify(state));
    const r = spawnSync("python3", [ASSERTS, tmp.plan, tmp.state], { encoding: "utf-8" });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// One test per INV-NNN
// ---------------------------------------------------------------------------

describe("autopilot invariants — assert_invariants.py (issue #426)", () => {
  test("INV-001: auto-merge on Tier-0 PR is rejected", () => {
    const plan = { actions: [{ type: "auto-merge", pr_number: 42, tier: 0 }] };
    const r = runAsserts(plan, baseState());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-001/);
    assert.match(r.stderr, /Tier-0/);
  });

  test("INV-001: auto-merge on Tier-1/2/3 PRs is allowed", () => {
    const plan = {
      actions: [
        { type: "auto-merge", pr_number: 1, tier: 1 },
        { type: "auto-merge", pr_number: 2, tier: 2 },
        { type: "auto-merge", pr_number: 3, tier: 3 },
      ],
    };
    const r = runAsserts(plan, baseState());
    assert.equal(r.status, 0, `expected OK, got: ${r.stderr}`);
  });

  test("INV-002: dispatch into busy slot is rejected", () => {
    const plan = { actions: [{ type: "dispatch", slot: "dev_orch", skill: "hydra-dev" }] };
    const state = baseState({
      slots: {
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0 },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
    });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-002/);
  });

  test("INV-002: two dispatches into the same free slot in one plan is rejected", () => {
    const plan = {
      actions: [
        { type: "dispatch", slot: "dev_orch", skill: "hydra-dev" },
        { type: "dispatch", slot: "dev_orch", skill: "hydra-dev" },
      ],
    };
    const r = runAsserts(plan, baseState());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-002/);
  });

  test("INV-003: dispatch into burned class is rejected", () => {
    const plan = { actions: [{ type: "dispatch", slot: "qa_orch", skill: "hydra-qa" }] };
    const state = baseState({ burned_classes: ["qa_orch"] });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-003/);
  });

  test("INV-004: re-reap of known task_id is rejected", () => {
    const plan = { actions: [{ type: "reap", slot: "dev_orch", task_id: "task-A", total_tokens: 1000 }] };
    const state = baseState({ reaped_task_ids: ["task-A"] });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-004/);
  });

  test("INV-004: two reaps of same task_id within one plan is rejected", () => {
    const plan = {
      actions: [
        { type: "reap", slot: "dev_orch", task_id: "task-A", total_tokens: 1000 },
        { type: "reap", slot: "qa_orch", task_id: "task-A", total_tokens: 2000 },
      ],
    };
    const r = runAsserts(plan, baseState());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-004/);
  });

  test("INV-005: budget exhausted but no terminate is rejected", () => {
    const plan = { actions: [{ type: "wait", seconds: 10 }] };
    const state = baseState({ cumulative_tokens: 2_500_000 });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-005/);
  });

  test("INV-005: budget exhausted WITH terminate is allowed", () => {
    const plan = { actions: [{ type: "terminate", cause: "budget", merged_prs: 0 }] };
    const state = baseState({ cumulative_tokens: 2_500_000 });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 0);
  });

  test("INV-006: reap after dispatch in same plan is rejected", () => {
    const plan = {
      actions: [
        { type: "dispatch", slot: "qa_orch", skill: "hydra-qa" },
        { type: "reap", slot: "dev_orch", task_id: "task-Z", total_tokens: 1000 },
      ],
    };
    const r = runAsserts(plan, baseState());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-006/);
  });

  test("INV-006: reap before dispatch is allowed", () => {
    const plan = {
      actions: [
        { type: "reap", slot: "dev_orch", task_id: "task-Z", total_tokens: 1000 },
        { type: "dispatch", slot: "qa_orch", skill: "hydra-qa" },
      ],
    };
    const state = baseState({
      slots: {
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0 },
        qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
      },
    });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 0);
  });

  test("INV-007: auto-merge with qa_verdict=FAIL is rejected", () => {
    const plan = {
      actions: [{ type: "auto-merge", pr_number: 5, tier: 1, qa_verdict: "FAIL" }],
    };
    const r = runAsserts(plan, baseState());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-007/);
  });

  test("INV-008: dispatch dev_target under orch-only scope is rejected", () => {
    const plan = { actions: [{ type: "dispatch", slot: "dev_target", skill: "hydra-target-build" }] };
    const state = baseState({ scope: "orch-only" });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-008/);
  });

  test("INV-008: dispatch health under any scope is allowed", () => {
    const plan = { actions: [{ type: "dispatch", slot: "health", skill: "hydra-doctor" }] };
    const stateOrch = baseState({ scope: "orch-only" });
    const stateTarget = baseState({ scope: "target-only" });
    assert.equal(runAsserts(plan, stateOrch).status, 0);
    assert.equal(runAsserts(plan, stateTarget).status, 0);
  });

  test("happy path: empty plan passes all invariants", () => {
    const r = runAsserts({ actions: [] }, baseState());
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OK/);
  });

  test("plan without an `actions` array is rejected with INV-000", () => {
    const r = runAsserts({ foo: "bar" }, baseState());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-000/);
  });
});
