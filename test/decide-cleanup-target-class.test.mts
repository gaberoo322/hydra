/**
 * Regression tests for `scripts/autopilot/decide.py` — the `cleanup_target`
 * signal class: the TARGET mirror of `cleanup_orch` (operator-approved
 * 2026-06-10, after hydra-betting PR #93 shipped the Target's deadcode
 * ratchet + the CLAUDE.md rule-3 cleanup carve-out).
 *
 * `cleanup_target` dispatches the headless `/hydra-target-cleanup` skill — a
 * deterministic, demote-only dead-export sweep over ~/hydra-betting/web that
 * files ready-for-agent items into the Redis target backlog. The class
 * mirrors cleanup_orch's signal discipline exactly:
 *
 *   - Fires on the precomputed `target_backfill_idle` signal (collect-state.sh
 *     emits it when the target triage + queued lanes and the Redis work-queue
 *     are all empty). decide.py never recomputes board state.
 *   - `target_cleanup_board_saturated` is the PRIMARY suppressor, checked
 *     FIRST — a board already holding >10 open cleanup-scan items suppresses
 *     the scan before the cooldown is even consulted.
 *   - 1h class cooldown (`SIGNAL_COOLDOWNS["cleanup_target"]`) as the cadence
 *     back-stop.
 *   - Target-scope by definition: excluded under `orch-only` scope
 *     (SCOPE_ORCH_ONLY_EXCLUDE), allowed under `target-only` — the exact
 *     inverse of cleanup_orch's scope placement.
 *   - Dispatches with `apply: true` so a headless run EMITS (the #1078
 *     retro_orch lesson: an argument-free dispatch of a dry-run-default skill
 *     is a silent no-op).
 *
 * Exercised through the `decide` CLI subcommand, pinning the JSON wire
 * contract (same harness as test/decide-retro-class.test.mts).
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
  const dir = mkdtempSync(join(tmpdir(), "decide-cleanup-target-test-"));
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

const cleanupTarget = (a: any) => a.type === "dispatch" && a.slot === "cleanup_target";

describe("decide.py — cleanup_target signal class (Target mirror of cleanup_orch)", () => {
  test("fires on target_backfill_idle and invokes hydra-target-cleanup with apply:true", () => {
    const state = baseState({ signals: { target_backfill_idle: true } });
    const plan = runDecide(state, null);
    const a = findAction(plan, cleanupTarget);
    assert.ok(a, "cleanup_target must dispatch on target_backfill_idle");
    assert.equal(a.skill, "hydra-target-cleanup");
    // The #1078 lesson: a dry-run-default skill dispatched headlessly without
    // apply:true is a silent no-op — the class would never file anything.
    assert.equal((a.prompt_args ?? {}).apply, true, "headless dispatch must carry apply:true");
  });

  test("does NOT fire without target_backfill_idle", () => {
    const plan = runDecide(baseState(), null);
    assert.equal(
      findAction(plan, cleanupTarget),
      undefined,
      "cleanup_target must not dispatch when the target board has actionable work",
    );
  });

  test("target_cleanup_board_saturated suppresses the dispatch even when idle (checked FIRST)", () => {
    const state = baseState({
      signals: { target_backfill_idle: true, target_cleanup_board_saturated: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, cleanupTarget),
      undefined,
      "a saturated cleanup board must suppress the scan before anything else",
    );
  });

  test("excluded under orch-only scope (target-scope by definition)", () => {
    const state = baseState({
      scope: "orch-only",
      signals: { target_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, cleanupTarget),
      undefined,
      "orch-only scope must exclude cleanup_target — the inverse of cleanup_orch's placement",
    );
  });

  test("allowed under target-only scope", () => {
    const state = baseState({
      scope: "target-only",
      signals: { target_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, cleanupTarget),
      "target-only must NOT exclude cleanup_target",
    );
  });

  test("suppressed when recently fired (within the 1h cooldown)", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { target_backfill_idle: true },
      signal_last_fired: { cleanup_target: now - 10 * 60 } as any, // 10 min ago
    });
    const plan = runDecide(state, null);
    assert.equal(
      findAction(plan, cleanupTarget),
      undefined,
      "10 min ago is inside the 1h cleanup_target cooldown",
    );
  });

  test("fires after the 1h cooldown elapses", () => {
    const now = Math.floor(Date.now() / 1000);
    const state = baseState({
      signals: { target_backfill_idle: true },
      signal_last_fired: { cleanup_target: now - 2 * 60 * 60 } as any, // 2h ago
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, cleanupTarget),
      "cleanup_target must fire once the 1h cooldown has elapsed",
    );
  });

  test("does not preempt a dev_target pipeline dispatch (spare-capacity contract)", () => {
    // Pipeline slots dispatch BEFORE the signal loop. When target work IS
    // available the board is not idle, so cleanup_target stays silent — but
    // even with both signals present (a stale-idle race), the dev_target
    // dispatch must still appear; the signal class only rides alongside.
    const state = baseState({
      signals: { target_work_available: true, target_backfill_idle: true },
    });
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "dev_target"),
      "dev_target pipeline dispatch must still fire when target work is available",
    );
  });
});
