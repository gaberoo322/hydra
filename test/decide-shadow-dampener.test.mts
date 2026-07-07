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

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

function baseState(overrides: Record<string, unknown> = {}): any {
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
      [DECIDE, "--now=1800000000", "decide", sPath, cPath, ePath],
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
