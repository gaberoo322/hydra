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

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
