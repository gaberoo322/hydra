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
