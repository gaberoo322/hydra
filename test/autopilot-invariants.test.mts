/**
 * Regression test for `scripts/autopilot/assert_invariants.py` (issue
 * #426). Each live invariant has at least one violating-plan case asserting
 * the script raises with the expected greppable ID.
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
 *   INV-001 RETIRED (ADR-0020 Slice 2 / #743) — a T4 auto-merge no longer
 *           raises; the T4 depth backstop relocated to the base-ref
 *           `deep-qa-gate` CI check + retained INV-007.
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
  test("INV-001 retired (ADR-0020 #743): a T4 auto-merge no longer raises", () => {
    // The flip that this slice unlocks: a T4 (Verifier Core) auto-merge action
    // with a PASS verdict must pass the invariant set. The T4 depth backstop
    // relocated to the base-ref `deep-qa-gate` CI check; INV-001 is gone.
    const plan = { actions: [{ type: "auto-merge", pr_number: 42, tier: 4, qa_verdict: "PASS" }] };
    const r = runAsserts(plan, baseState());
    assert.equal(r.status, 0, `expected OK (INV-001 retired), got: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /INV-001/, "INV-001 must no longer fire");
  });

  test("INV-001 retired: the identifier no longer appears in assert_invariants output", () => {
    // Defensive: a T4 auto-merge with NO verdict (the old INV-001 trigger
    // shape) is now governed only by INV-007 (which is silent without a
    // non-PASS verdict). It must not raise INV-001.
    const plan = { actions: [{ type: "auto-merge", pr_number: 7, tier: 4 }] };
    const r = runAsserts(plan, baseState());
    assert.equal(r.status, 0, `expected OK, got: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /INV-001/);
  });

  test("auto-merge on T1/T2/T3 PRs is allowed", () => {
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

  // Issue #431: bootstrap.sh must initialize all 6 named slot keys, but
  // older state.json files (and a regressed bootstrap variant) can carry
  // an empty `slots: {}` or a partial dict. assert_invariants.py must not
  // crash on these inputs, and INV-002 must still catch in-plan
  // double-dispatches when the slot key is initially absent.
  test("INV-002: empty slots dict does not crash and permits a fresh dispatch", () => {
    const plan = { actions: [{ type: "dispatch", slot: "dev_orch", skill: "hydra-dev" }] };
    const state = baseState({ slots: {} });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 0, `expected OK on empty slots dict, got: ${r.stderr}`);
  });

  test("INV-002: partially-initialized slots — dispatch into missing-key slot is allowed", () => {
    const plan = { actions: [{ type: "dispatch", slot: "qa_orch", skill: "hydra-qa" }] };
    // Only dev_orch present; qa_orch key absent entirely.
    const state = baseState({
      slots: {
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0 },
      },
    });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 0, `expected OK on missing-key slot, got: ${r.stderr}`);
  });

  test("INV-002: partially-initialized slots — double-dispatch in plan still blocked", () => {
    // slots dict has no qa_orch key, but two dispatches in the same plan
    // must still trip — the within-plan tracking (occupied.add) is the
    // last line of defense before bootstrap.sh runs the next tick.
    const plan = {
      actions: [
        { type: "dispatch", slot: "qa_orch", skill: "hydra-qa" },
        { type: "dispatch", slot: "qa_orch", skill: "hydra-qa" },
      ],
    };
    const state = baseState({ slots: {} });
    const r = runAsserts(plan, state);
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

  // Issue #466 (Phase B of #437): design_concept_orch slot test cases.
  test("INV-002 (design_concept_orch): dispatch into busy slot is rejected", () => {
    const plan = { actions: [{ type: "dispatch", slot: "design_concept_orch", skill: "hydra-grill" }] };
    const state = baseState({
      slots: {
        dev_orch: null, qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
        design_concept_orch: { skill: "hydra-grill", started: "t0", partial_tokens: 1000 },
      },
    });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-002/);
  });

  test("INV-008 (design_concept_orch): target-only scope excludes design_concept_orch", () => {
    const plan = { actions: [{ type: "dispatch", slot: "design_concept_orch", skill: "hydra-grill" }] };
    const state = baseState({ scope: "target-only" });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-008/);
    assert.match(r.stderr, /design_concept_orch/);
  });

  test("INV-008 (design_concept_orch): orch-only scope allows design_concept_orch", () => {
    const plan = { actions: [{ type: "dispatch", slot: "design_concept_orch", skill: "hydra-grill" }] };
    const state = baseState({ scope: "orch-only" });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 0, `expected OK under orch-only scope, got: ${r.stderr}`);
  });

  // -------------------------------------------------------------------------
  // Issue #485 (Phase B of /hydra-tool-scout). scout_orch mirrors the
  // design_concept_orch scope-exclude semantics — orch-scope by definition,
  // forbidden under target-only.
  // -------------------------------------------------------------------------

  test("INV-008 (scout_orch): target-only scope excludes scout_orch (issue #485)", () => {
    const plan = { actions: [{ type: "dispatch", slot: "scout_orch", skill: "hydra-tool-scout" }] };
    const state = baseState({ scope: "target-only" });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /INV-008/);
    assert.match(r.stderr, /scout_orch/);
  });

  test("INV-008 (scout_orch): orch-only scope allows scout_orch (issue #485)", () => {
    const plan = { actions: [{ type: "dispatch", slot: "scout_orch", skill: "hydra-tool-scout" }] };
    const state = baseState({ scope: "orch-only" });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 0, `expected OK under orch-only scope, got: ${r.stderr}`);
  });

  test("INV-008 (scout_orch): all scope allows scout_orch (issue #485)", () => {
    const plan = { actions: [{ type: "dispatch", slot: "scout_orch", skill: "hydra-tool-scout" }] };
    const state = baseState({ scope: "all" });
    const r = runAsserts(plan, state);
    assert.equal(r.status, 0, `expected OK under all scope, got: ${r.stderr}`);
  });

  test("INV-009: dev_orch and design_concept_orch on same anchor is warn-only (does NOT raise)", () => {
    // Phase B intentionally does not raise on this conflict — it logs
    // to state.warnings[] instead. Phase C will flip to raise.
    const plan = {
      actions: [
        { type: "dispatch", slot: "design_concept_orch", skill: "hydra-grill",
          prompt_args: { anchor: "issue-conflict", scope: "orch" } },
        { type: "dispatch", slot: "dev_orch", skill: "hydra-dev",
          prompt_args: { anchor: "issue-conflict" } },
      ],
    };
    const r = runAsserts(plan, baseState());
    // Warn-only: status must be 0 (no raise) — the warnings are observed via
    // state.warnings[] (decide.py / reap.py / digest read those), but
    // assert_invariants.py exits OK.
    assert.equal(r.status, 0,
      `INV-009 must NOT raise in Phase B (warn-only); got stderr: ${r.stderr}`);
  });

  test("INV-009: dev_orch and design_concept_orch on DIFFERENT anchors is allowed", () => {
    const plan = {
      actions: [
        { type: "dispatch", slot: "design_concept_orch", skill: "hydra-grill",
          prompt_args: { anchor: "issue-A", scope: "orch" } },
        { type: "dispatch", slot: "dev_orch", skill: "hydra-dev",
          prompt_args: { anchor: "issue-B" } },
      ],
    };
    const r = runAsserts(plan, baseState());
    assert.equal(r.status, 0, "different anchors must not trip INV-009");
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
