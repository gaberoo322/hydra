/**
 * Regression tests for `scripts/autopilot/decide.py` — the `design_qa_target`
 * signal class (issue #2739, parent #2732: the Target UI-quality loop).
 *
 * `design_qa_target` dispatches the headless `/hydra-design-qa` skill — a
 * periodic VISUAL QA pass that captures the slice-1 screenshot set of every
 * nav-registry route on ~/hydra-betting/web, judges each page against the
 * Target design-language ADR (hydra-betting/docs/adr/0005-design-language.md —
 * density budget, clutter, consistency), and files AT MOST 3 deduped
 * needs-triage Target-backlog items per run, each citing the specific ADR rule
 * violated plus screenshot evidence.
 *
 * The class marries two established disciplines:
 *
 *   - scout_orch's CALENDAR cadence: the 7d class cooldown
 *     (`SIGNAL_COOLDOWNS["design_qa_target"]`) is the primary cadence control,
 *     seeded in bootstrap.sh so it survives the pace-gate relaunch (#2575).
 *     collect-state.sh emits `design_qa_target_due` true whenever the Target
 *     board is reachable AND not saturated — there is always UI to review, so
 *     the "due" predicate is just "board reachable + capacity".
 *   - cleanup_target / wire_or_retire_target's saturation + routing discipline:
 *     `design_qa_target_saturated` is the anti-flood cap, checked FIRST — a
 *     board already holding >5 open `design-qa`-labelled items suppresses the
 *     pass before the cooldown is even consulted. Findings route needs-triage
 *     (NOT ready-for-agent): this is JUDGMENT work (epic #2720 confidence
 *     routing).
 *
 * The dispatch carries `apply: true` (the #1078 lesson: a dry-run-default skill
 * dispatched headlessly without it is a silent no-op) and `max_items: 3` (the
 * per-run finding cap, machine-enforceable at the dispatch seam). It OMITS the
 * model param (judgment work inherits the parent, #1093).
 *
 * Target-scope by definition: excluded under `orch-only`, allowed under
 * `target-only` — the exact inverse of the orch signal classes.
 *
 * Exercised through the `decide` CLI subcommand, pinning the JSON wire
 * contract (same harness as test/decide-cleanup-target-class.test.mts).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-design-qa-target-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

interface StateOverrides {
  scope?: string;
  signal_last_fired?: Record<string, number>;
  signals?: Record<string, unknown>;
}

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

const designQaTarget = (a: any) =>
  a.type === "dispatch" && a.slot === "design_qa_target";

describe("decide.py — design_qa_target signal class (Target visual-QA loop, #2739)", () => {
  test("fires on design_qa_target_due and invokes hydra-design-qa with apply:true + max_items:3", () => {
    const state = baseState({ signals: { design_qa_target_due: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, designQaTarget);
    assert.ok(a, "design_qa_target must dispatch on design_qa_target_due");
    assert.equal(a.skill, "hydra-design-qa");
    // The #1078 lesson: a dry-run-default skill dispatched headlessly without
    // apply:true is a silent no-op — the class would never file anything.
    assert.equal(
      (a.prompt_args ?? {}).apply,
      true,
      "headless dispatch must carry apply:true",
    );
    // The per-run finding cap is machine-enforceable at the dispatch seam.
    assert.equal(
      (a.prompt_args ?? {}).max_items,
      3,
      "dispatch must thread the ≤3-findings-per-run cap as max_items:3",
    );
  });

  test("OMITS the model param (judgment work inherits the parent, #1093)", () => {
    const state = baseState({ signals: { design_qa_target_due: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, designQaTarget);
    assert.ok(a, "design_qa_target must dispatch on design_qa_target_due");
    assert.equal(
      "model" in (a.prompt_args ?? {}),
      false,
      "judgment classes must not pin a model (the Haiku-premature-exit failure mode)",
    );
    assert.equal(a.model, undefined, "no top-level model key either");
  });

  test("does NOT fire without design_qa_target_due", () => {
    const plan = runDecide(baseState(), null);
    assert.equal(
      findAction(plan, designQaTarget),
      undefined,
      "design_qa_target must not dispatch when the due signal is absent",
    );
  });

  test("design_qa_target_saturated suppresses the dispatch even when due (checked FIRST)", () => {
    // A healthy UI with a full triage pile: even if the due signal is present,
    // a saturated design-QA board must suppress the pass before anything else —
    // exactly the cleanup_target / target_cleanup_board_saturated discipline.
    const state = baseState({
      signals: { design_qa_target_due: true, design_qa_target_saturated: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, designQaTarget),
      undefined,
      "a saturated design-QA board (>5 open items) must suppress the pass",
    );
  });

  test("healthy UI (not due, not saturated) files nothing", () => {
    // The saturation backstop pinned above plus this case together encode the
    // AC "healthy UI files nothing": with no due signal there is no dispatch.
    const plan = runDecide(baseState({ signals: {} }), null);
    assert.equal(
      findAction(plan, designQaTarget),
      undefined,
      "no design-QA dispatch when the board reports nothing to review",
    );
  });

  test("excluded under orch-only scope (target-scope by definition)", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { design_qa_target_due: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, designQaTarget),
      undefined,
      "orch-only scope must exclude design_qa_target (it reviews the Target UI)",
    );
  });

  test("allowed under target-only scope", () => {
    const state = baseState({
      scope: "target-only",
      signals: { design_qa_target_due: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, designQaTarget),
      "target-only must NOT exclude design_qa_target",
    );
  });

  test("suppressed when recently fired (within the 7d calendar cooldown)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { design_qa_target_due: true },
      // fired 2 days ago — inside the 7d window
      signal_last_fired: { design_qa_target: now - 2 * 24 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, designQaTarget),
      undefined,
      "2 days ago is inside the 7d design_qa_target cooldown",
    );
  });

  test("fires after the 7d calendar cooldown elapses", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { design_qa_target_due: true },
      // fired 8 days ago — past the 7d window
      signal_last_fired: { design_qa_target: now - 8 * 24 * 60 * 60 } as any,
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, designQaTarget),
      "design_qa_target must fire once the 7d cooldown has elapsed",
    );
  });

  test("does not preempt a dev_target pipeline dispatch (spare-capacity contract)", () => {
    // Pipeline slots dispatch BEFORE the signal loop. Even with both the
    // target-work and design-QA-due signals present, the dev_target dispatch
    // must still appear; design_qa_target only rides alongside spare capacity.
    const state = baseState({
      signals: { target_work_available: true, design_qa_target_due: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      "dev_target pipeline dispatch must still fire when target work is available",
    );
  });
});
