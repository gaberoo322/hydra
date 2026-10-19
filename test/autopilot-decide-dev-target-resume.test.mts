/**
 * Regression tests for issue #4739 — the Target dev-resume path.
 *
 * A Target issue whose PR got a QA FAIL plus an operator "fix forward on
 * PR #N, push to its existing branch" decision carries `needs-dev-resume`
 * (written ONLY by /hydra-review's per-Target fix-forward resolution). The
 * #4474 in-flight exclusion subtracts every `ready-for-agent` issue
 * referenced by an open Target PR from `target_ready_for_agent`, and the
 * resume issue deliberately does NOT carry that label — so the board signal
 * never fires for it and `dev_target` never dispatches (observed: 11 held
 * CSB PRs with fix-forward decisions, zero pushes since). The fix is a
 * durable, label-derived pin in the same shape as #4518's
 * `orch_dev_resume_pick`:
 *
 *   the Turn Snapshot → `target_dev_resume_pick=issue-<N>:<pr>:<head.ref>`
 *                     (or `=none`, fail closed on any degraded read)
 *   decide.py        → `_select_slot_dev_target` checks the pick FIRST,
 *                      before and independent of the board signals, and
 *                      dispatches hydra-target-build with resume:true +
 *                      resume_issue / resume_pr / resume_branch.
 *
 * The decide.py half is pinned here through its `decide` CLI (the JSON wire
 * contract, the test/autopilot-decide.test.mts shape). The collector half
 * lives with the typed Turn Snapshot `target-board` collector in
 * test/turn-snapshot-target-board.test.mts (ADR-0043 slice 4, #4932).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withTurnSnapshot } from "./_helpers/turn-snapshot-state.mts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// ---------------------------------------------------------------------------
// decide.py harness (the test/autopilot-decide.test.mts shape)
// ---------------------------------------------------------------------------

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-dev-target-resume-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

/**
 * The minimal autopilot state fixture — same shape as
 * test/autopilot-decide.test.mts's baseState(): all slots free, `scope: all`
 * (dev_target dispatches on either board lane), no burned classes, no
 * cooldowns, and the #4411 fail-closed risk-surface gate satisfied by a
 * resolved surface. The class-level pre-selector guards (#1059 cost cap,
 * #4475 WIP saturation) read absent state here and stay inert, so what each
 * case below pins is the SELECTOR's own precedence, per INV-5's scoping.
 */
function baseState(overrides: Record<string, unknown> = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
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
    turn: 0,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: {
      dev_orch: null, qa_orch: null, research_orch: null,
      dev_target: null, qa_target: null, research_target: null,
      design_concept_orch: null,
    },
    signal_last_fired: {
      health: 0, sweep_orch: 0, sweep_target: 0,
      discover_orch: 0, discover_target: 0,
    },
    signals: (overrides.signals as Record<string, unknown>) ?? {},
    research_force_counter: {},
    target_risk_surface: {
      ok: true,
      appSubdir: "web",
      surface: ["src/lib/execution/", "src/bin/"],
      surfaceRepoRelative: ["web/src/lib/execution/", "web/src/bin/"],
    },
    ...overrides,
  };
}

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(withTurnSnapshot(state)));
    writeFileSync(t.cands, JSON.stringify(candidates));
    writeFileSync(t.events, JSON.stringify(events));
    const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
      encoding: "utf-8",
      env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
    });
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

function devTargetDispatches(plan: any): any[] {
  return (plan.actions ?? []).filter(
    (a: any) => a.type === "dispatch" && a.slot === "dev_target",
  );
}

// ---------------------------------------------------------------------------
// decide.py — the resume pin in _select_slot_dev_target
// ---------------------------------------------------------------------------

describe("decide.py — Target dev resume pick (issue #4739)", () => {
  const RESUME_PICK = "issue-176:57:feature/resume-176";

  test("a resume pick produces a dev_target dispatch with resume:true and the correct resume_branch", () => {
    const plan = runDecide(baseState({ signals: { target_dev_resume_pick: RESUME_PICK } }), null);
    const d = devTargetDispatches(plan);
    assert.equal(d.length, 1, `expected exactly one pinned dispatch: ${JSON.stringify(d)}`);
    assert.equal(d[0].skill, "hydra-target-build");
    assert.deepEqual(d[0].prompt_args, {
      anchor: "issue-176",
      resume: true,
      resume_issue: 176,
      resume_pr: 57,
      resume_branch: "feature/resume-176",
    });
    assert.match(d[0].reason, /#4739/);
  });

  test("resume pick wins ahead of ordinary board work", () => {
    // BOTH lanes armed (legacy Redis + GitHub board) AND a pick present: the
    // pinned resume must be the dispatch, not the board pick (which carries
    // no resume key at all).
    const plan = runDecide(
      baseState({
        signals: {
          target_work_available: true,
          target_board_work_available: true,
          target_dev_resume_pick: RESUME_PICK,
        },
      }),
      null,
    );
    const d = devTargetDispatches(plan);
    assert.equal(d.length, 1);
    assert.equal(d[0].prompt_args.resume, true, "the resume pin outranks the board pick");
    assert.equal(d[0].prompt_args.anchor, "issue-176");
    assert.equal(d[0].prompt_args.resume_branch, "feature/resume-176");
  });

  test("the pin fires with BOTH board signals absent — the resume issue carries needs-dev-resume, not ready-for-agent (#4739 premise)", () => {
    const plan = runDecide(baseState({ signals: { target_dev_resume_pick: RESUME_PICK } }), null);
    const d = devTargetDispatches(plan);
    assert.equal(d.length, 1);
    assert.equal(d[0].prompt_args.resume, true);
  });

  test("a resume pick is exempt from the #4475 WIP-saturation guard; a board pick is still suppressed by it", () => {
    const pinned = runDecide(
      baseState({ signals: { target_wip_saturated: true, target_dev_resume_pick: RESUME_PICK } }),
      null,
    );
    const d = devTargetDispatches(pinned);
    assert.equal(d.length, 1, "resume is not new WIP — the saturation guard must not preempt it");
    assert.equal(d[0].prompt_args.resume, true);
    const board = runDecide(
      baseState({ signals: { target_wip_saturated: true, target_board_work_available: true } }),
      null,
    );
    assert.equal(devTargetDispatches(board).length, 0, "ordinary board work stays WIP-suppressed");
  });

  test("`none` / absent / malformed pick spellings fall through to the ordinary board path", () => {
    for (const bad of ["none", "", "issue-176:57", "176:57:feature/x", "issue-x:57:feature/x", "issue-0:57:feature/x", "issue-176:0:feature/x", "issue-176:57:"]) {
      const plan = runDecide(
        baseState({
          signals: {
            target_board_work_available: true,
            target_dev_resume_pick: bad,
          },
        }),
        null,
      );
      const d = devTargetDispatches(plan);
      assert.equal(d.length, 1, `signal "${bad}" must fall through to the board path, not suppress it`);
      assert.equal(d[0].prompt_args.resume, undefined, `signal "${bad}" must never pin a resume`);
      assert.equal(d[0].prompt_args.anchor, undefined, "the ordinary board path carries no anchor from the pick");
    }
    // Absent entirely + no board signal ⇒ no dispatch at all.
    assert.equal(devTargetDispatches(runDecide(baseState(), null)).length, 0);
  });

  test("signal EVENTS take precedence over state.signals for the resume pick", () => {
    const plan = runDecide(
      baseState({ signals: { target_dev_resume_pick: "none" } }),
      null,
      [{ type: "signal", name: "target_dev_resume_pick", value: RESUME_PICK }],
    );
    const d = devTargetDispatches(plan);
    assert.equal(d.length, 1, "the event-borne signal wins");
    assert.equal(d[0].prompt_args.resume_pr, 57);
  });

  test("a busy dev_target slot means no resume pin (the pick rides the normal slot-free pipeline)", () => {
    const state = baseState({ signals: { target_dev_resume_pick: RESUME_PICK } });
    state.slots.dev_target = { task_id: "abc", status: "running" };
    assert.equal(devTargetDispatches(runDecide(state, null)).length, 0);
  });
});

// The collect-state half (the target_dev_resume_pick emission) moved with its
// collector to test/turn-snapshot-target-board.test.mts (ADR-0043 slice 4,
// issue #4932): the Target pick is now the shared dev-resume pick
// (src/autopilot/turn-snapshot/dev-resume.ts) and its cases drive the typed
// `target-board` collector through a fake TurnSnapshotGithub port.
