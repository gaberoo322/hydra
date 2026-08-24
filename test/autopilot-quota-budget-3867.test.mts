/**
 * Issue #3867 slice 1 — the autopilot budget is denominated in the WRONG CURRENCY.
 *
 * `state.limits.token_budget` counts cumulative subagent-reported input/output
 * tokens (`state.cumulative_tokens`, advanced by reap.py). What the operator
 * actually pays is cache-weighted ACCOUNT UTILIZATION. Measured on run 2bcba309
 * (2026-08-05): the run "spent" 801k of a 4,000,000 token budget — 20% — and
 * would have kept dispatching, while the OAuth meter moved the 5h utilization
 * window 2% -> 30% over the same period (~150M raw tokens). So a "conservative"
 * token budget does not bound real spend at all.
 *
 * The fix adds a per-run cap denominated in utilization POINTS accrued over the
 * run's own run-start baseline, read from the `state.usage_eligibility` payload
 * collect-state.sh already injects every turn (zero new I/O).
 *
 * This suite pins the approved design concept's invariants end to end:
 *
 *   INV-1  With the caps unset (the default) the new cause NEVER fires and every
 *          existing termination is bit-for-bit unchanged.
 *   INV-2  term-check.py and decide.py._check_termination stay mirror-consistent
 *          for TERM:quota — the same fixture drives BOTH and they must agree.
 *   INV-3  The baseline is captured EXACTLY ONCE per run, on the first turn that
 *          sees a calibrated payload, through the existing atomic write-back.
 *   INV-4  A mid-run 5h-window reset clamps to a zero delta and REBASES the
 *          baseline — never negative spend, never a termination of its own.
 *   INV-5  The cap reads `usage.percentLast5h` / `usage.percentSinceReset` only,
 *          never paceState / targetPercent (ADR-0021 D5 keeps this a per-run
 *          hygiene cap, subordinate to the Pace Gate).
 *
 * Both scripts are exercised through their real CLIs (`python3 decide.py decide`
 * / `term-check.py`) against temp state files, so nothing here can pass against
 * a stubbed re-implementation of the policy.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const DECIDE = join(SCRIPTS, "decide.py");
const TERM_CHECK = join(SCRIPTS, "term-check.py");
const BOOTSTRAP = join(SCRIPTS, "bootstrap.sh");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-quota-3867-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

interface UsageOverrides {
  percentLast5h?: number | null;
  percentSinceReset?: number | null;
  calibrated?: boolean;
}

/**
 * The nested `usage` object of `GET /api/usage/eligibility` as collect-state.sh
 * injects it into `state.usage_eligibility`. Only the four fields the cap reads
 * matter; `paceState` / `targetPercent` are deliberately present at the OUTER
 * level in some cases below to prove the cap ignores them (INV-5).
 */
function usagePayload(o: UsageOverrides = {}): any {
  const usage: any = {
    usageSource: "oauth",
    calibrated: o.calibrated ?? true,
    weeklyResetAnchor: "2026-08-12T16:59:59.746Z",
    generatedAt: "2026-08-17T14:15:43.415Z",
  };
  if (o.percentLast5h !== null) usage.percentLast5h = o.percentLast5h ?? 12;
  if (o.percentSinceReset !== null) usage.percentSinceReset = o.percentSinceReset ?? 66;
  return {
    allow: true,
    shed: [],
    reasons: { calibrated: usage.calibrated, paused: false, worklessUntil: null },
    // ADR-0021 D2/D3 curve fields — the cap must NEVER read these (INV-5).
    paceState: "on",
    targetPercent: 64.2,
    usage,
  };
}

interface StateOverrides {
  token_budget?: number;
  cumulative_tokens?: number;
  quota_5h_max_pts?: number;
  quota_week_max_pts?: number;
  quota_baseline?: unknown;
  usage_eligibility?: unknown;
  idle_turns?: number;
  started_epoch?: number;
  wall_clock_max_sec?: number;
  turn?: number;
  slots?: Record<string, unknown>;
}

function baseState(o: StateOverrides = {}): any {
  const limits: any = {
    token_budget: o.token_budget ?? 4_000_000,
    wall_clock_max_sec: o.wall_clock_max_sec ?? 28_800,
    idle_drain_turns: 5,
    // Disabled so the #3787 periodic-restart cause cannot pre-empt the cases
    // below (this suite pins quota vs budget vs idle ordering, not the cadence).
    context_compaction_turns: 0,
    scope: "all",
    subagent_max_tokens: 400_000,
    subagent_hard_max_tokens: 800_000,
  };
  if (o.quota_5h_max_pts !== undefined) limits.quota_5h_max_pts = o.quota_5h_max_pts;
  if (o.quota_week_max_pts !== undefined) limits.quota_week_max_pts = o.quota_week_max_pts;

  const s: any = {
    started_epoch: o.started_epoch ?? Math.floor(Date.now() / 1000),
    limits,
    // The whole point of the issue: the token budget is nowhere near exhausted.
    cumulative_tokens: o.cumulative_tokens ?? 801_000,
    dispatches: 5,
    idle_turns: o.idle_turns ?? 0,
    turn: o.turn ?? 3,
    burned_classes: [],
    reaped_task_ids: [],
    failure_log: [],
    slots: o.slots ?? {
      dev_orch: null, qa_orch: null, research_orch: null,
      dev_target: null, qa_target: null, research_target: null,
      design_concept_orch: null,
    },
    signal_last_fired: {
      health: 0, sweep_orch: 0, sweep_target: 0,
      discover_orch: 0, discover_target: 0,
    },
    signals: {},
    research_force_counter: {},
  };
  if (o.usage_eligibility !== undefined) s.usage_eligibility = o.usage_eligibility;
  if (o.quota_baseline !== undefined) s.quota_baseline = o.quota_baseline;
  return s;
}

/** A captured baseline as `_capture_quota_baseline` writes it. */
function baseline(percent5h: number | null, percentWeek: number | null): any {
  return {
    percent_5h: percent5h,
    percent_week: percentWeek,
    captured_epoch: 1_786_800_000,
    rebased_epoch: null,
  };
}

// ---------------------------------------------------------------------------
// CLI runners
// ---------------------------------------------------------------------------

function runTermCheck(state: any): { status: number; stdout: string } {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    const r = spawnSync(TERM_CHECK, [], {
      // No run_id in the fixture => post_run_end() short-circuits, so this can
      // never POST to a live orchestrator from the suite.
      env: { ...process.env, HYDRA_AUTOPILOT_STATE: t.state },
      encoding: "utf-8",
    });
    return { status: r.status ?? -1, stdout: (r.stdout ?? "").trim() };
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

interface DecideResult { plan: any; persisted: any }

function runDecide(state: any): DecideResult {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, JSON.stringify(null));
    writeFileSync(t.events, JSON.stringify([]));
    const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
      encoding: "utf-8",
      // Keep the terminate run-end POST (#1352) off — a quota terminate must
      // never reach a live orchestrator from the test suite.
      env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
    });
    if (r.status !== 0) {
      throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
    }
    return {
      plan: JSON.parse(r.stdout),
      persisted: JSON.parse(readFileSync(t.state, "utf-8")),
    };
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

function terminateAction(plan: any): any | undefined {
  return (plan.actions ?? []).find((a: any) => a.type === "terminate");
}

// ---------------------------------------------------------------------------
// 1. term-check.py — the Phase 3 pre-check mirror
// ---------------------------------------------------------------------------

describe("term-check.py TERM:quota (issue #3867)", () => {
  // THE issue's literal acceptance criterion: a run with --quota-5h-max=10
  // terminates once 5h utilization has risen 10 points over its run-start
  // baseline, EVEN THOUGH cumulative_tokens is far under token_budget.
  test("fires once the 5h delta reaches the cap, with tokens far under budget", () => {
    const r = runTermCheck(baseState({
      quota_5h_max_pts: 10,
      quota_baseline: baseline(2, 60),
      // 2% -> 30% is the observed run's real movement: a 28-point delta.
      usage_eligibility: usagePayload({ percentLast5h: 30, percentSinceReset: 62 }),
      cumulative_tokens: 801_000,
      token_budget: 4_000_000,
    }));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^TERM:quota /);
    assert.match(r.stdout, /5h utilization \+28\.0pts >= cap 10\.0pts/);
    assert.match(r.stdout, /baseline=2\.0 current=30\.0/);
  });

  test("keeps iterating while the delta is below the cap", () => {
    const r = runTermCheck(baseState({
      quota_5h_max_pts: 10,
      quota_baseline: baseline(2, 60),
      usage_eligibility: usagePayload({ percentLast5h: 11, percentSinceReset: 62 }),
    }));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^OK /, "a 9-point delta must not trip a 10-point cap");
  });

  test("the boundary is >= : exactly-at-cap terminates", () => {
    const r = runTermCheck(baseState({
      quota_5h_max_pts: 10,
      quota_baseline: baseline(2, 60),
      usage_eligibility: usagePayload({ percentLast5h: 12, percentSinceReset: 60 }),
    }));
    assert.match(r.stdout, /^TERM:quota /);
  });

  // INV-1 — the default. This is the single most important case in the file:
  // an unset cap must leave a run that has burned 30 points of quota running.
  test("INV-1: with the caps ABSENT, a 28-point burn does NOT terminate", () => {
    const r = runTermCheck(baseState({
      quota_baseline: baseline(2, 60),
      usage_eligibility: usagePayload({ percentLast5h: 30, percentSinceReset: 95 }),
    }));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^OK /, "the cap is opt-in — unset means never fires");
  });

  test("INV-1: an explicit 0 cap is also disabled", () => {
    const r = runTermCheck(baseState({
      quota_5h_max_pts: 0,
      quota_week_max_pts: 0,
      quota_baseline: baseline(2, 60),
      usage_eligibility: usagePayload({ percentLast5h: 30, percentSinceReset: 95 }),
    }));
    assert.match(r.stdout, /^OK /);
  });

  // term-check.py is intentionally side-effect-free, so it NEVER captures the
  // baseline — until decide.py has written one, the cap is simply skipped.
  test("no baseline yet => OK (term-check never captures; decide.py owns that)", () => {
    const r = runTermCheck(baseState({
      quota_5h_max_pts: 1,
      usage_eligibility: usagePayload({ percentLast5h: 90, percentSinceReset: 95 }),
    }));
    assert.match(r.stdout, /^OK /);
  });

  // INV-4 — a mid-run 5h-window reset.
  test("INV-4: a window reset (current < baseline) is NOT negative spend and never terminates", () => {
    const r = runTermCheck(baseState({
      quota_5h_max_pts: 10,
      quota_baseline: baseline(30, 66),
      // The 5h window rolled over: 30% -> 3%. Headroom returned.
      usage_eligibility: usagePayload({ percentLast5h: 3, percentSinceReset: 66 }),
    }));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^OK /, "a reset is headroom returning, not a spend event");
  });

  test("an UNCALIBRATED meter is never used to terminate", () => {
    const r = runTermCheck(baseState({
      quota_5h_max_pts: 1,
      quota_baseline: baseline(2, 60),
      usage_eligibility: usagePayload({
        percentLast5h: 90, percentSinceReset: 95, calibrated: false,
      }),
    }));
    assert.match(r.stdout, /^OK /, "terminating on a guessed spend figure is worse than not");
  });

  test("a missing usage_eligibility payload degrades to OK, never a crash", () => {
    const r = runTermCheck(baseState({
      quota_5h_max_pts: 1,
      quota_baseline: baseline(2, 60),
    }));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^OK /);
  });

  test("the WEEKLY cap fires on the percentSinceReset delta", () => {
    const r = runTermCheck(baseState({
      quota_week_max_pts: 5,
      quota_baseline: baseline(2, 60),
      // 5h barely moved; the weekly window crossed its own cap.
      usage_eligibility: usagePayload({ percentLast5h: 3, percentSinceReset: 66 }),
    }));
    assert.match(r.stdout, /^TERM:quota /);
    assert.match(r.stdout, /week utilization \+6\.0pts >= cap 5\.0pts/);
  });

  test("quota outranks budget when BOTH trip on the same turn", () => {
    const r = runTermCheck(baseState({
      quota_5h_max_pts: 10,
      quota_baseline: baseline(2, 60),
      usage_eligibility: usagePayload({ percentLast5h: 30, percentSinceReset: 62 }),
      // Token budget ALSO exhausted.
      token_budget: 100,
      cumulative_tokens: 5_000,
    }));
    assert.match(r.stdout, /^TERM:quota /,
      "quota is the more diagnostic cause — tokens under-measure real spend");
  });

  test("INV-1: budget still wins when the quota cap is disabled", () => {
    const r = runTermCheck(baseState({
      token_budget: 100,
      cumulative_tokens: 5_000,
      quota_baseline: baseline(2, 60),
      usage_eligibility: usagePayload({ percentLast5h: 30 }),
    }));
    assert.match(r.stdout, /^TERM:budget /);
  });

  // INV-5 — the cap must not couple to the Pace Gate's curve fields. Both
  // fixtures carry paceState/targetPercent; only the raw percentages differ, and
  // only they move the verdict.
  test("INV-5: the verdict tracks raw percentages, not paceState/targetPercent", () => {
    const under = runTermCheck(baseState({
      quota_5h_max_pts: 10,
      quota_baseline: baseline(2, 60),
      usage_eligibility: {
        ...usagePayload({ percentLast5h: 5 }),
        // An "ahead" curve state would make the Pace Gate refuse to launch —
        // but it must not terminate a RUNNING run through this cap.
        paceState: "ahead",
        targetPercent: 10,
      },
    }));
    assert.match(under.stdout, /^OK /);

    const over = runTermCheck(baseState({
      quota_5h_max_pts: 10,
      quota_baseline: baseline(2, 60),
      usage_eligibility: {
        ...usagePayload({ percentLast5h: 30 }),
        // A "behind" curve would make the Gate eager to launch — irrelevant.
        paceState: "behind",
        targetPercent: 99,
      },
    }));
    assert.match(over.stdout, /^TERM:quota /);
  });
});

// ---------------------------------------------------------------------------
// 2. decide.py — the authoritative check + the baseline capture
// ---------------------------------------------------------------------------

describe("decide.py quota-percent termination (issue #3867)", () => {
  test("emits terminate cause=quota with cumulative_tokens far under token_budget", () => {
    const { plan } = runDecide(baseState({
      quota_5h_max_pts: 10,
      quota_baseline: baseline(2, 60),
      usage_eligibility: usagePayload({ percentLast5h: 30, percentSinceReset: 62 }),
      cumulative_tokens: 801_000,
      token_budget: 4_000_000,
    }));
    const term = terminateAction(plan);
    assert.ok(term, "a quota-capped overspend must terminate");
    assert.equal(term.cause, "quota");
    assert.match(term.reason, /5h utilization \+28\.0pts >= cap 10\.0pts/);
  });

  // INV-2 — mirror consistency. One fixture, both scripts, same verdict.
  test("INV-2: term-check.py and decide.py agree on the same fixture", () => {
    const fixture = {
      quota_5h_max_pts: 10,
      quota_baseline: baseline(2, 60),
      usage_eligibility: usagePayload({ percentLast5h: 30, percentSinceReset: 62 }),
    };
    assert.match(runTermCheck(baseState(fixture)).stdout, /^TERM:quota /);
    assert.equal(terminateAction(runDecide(baseState(fixture)).plan)?.cause, "quota");

    const underFixture = { ...fixture, usage_eligibility: usagePayload({ percentLast5h: 5 }) };
    assert.match(runTermCheck(baseState(underFixture)).stdout, /^OK /);
    assert.equal(terminateAction(runDecide(baseState(underFixture)).plan), undefined);
  });

  // INV-3 — lazy capture, exactly once, persisted atomically.
  test("INV-3: captures the baseline on the first calibrated turn and persists it", () => {
    const { plan, persisted } = runDecide(baseState({
      quota_5h_max_pts: 10,
      // No baseline in the input — this IS the first turn.
      usage_eligibility: usagePayload({ percentLast5h: 12, percentSinceReset: 66 }),
    }));
    assert.equal(terminateAction(plan), undefined,
      "the capture turn has a zero delta by construction — it must not terminate");
    assert.ok(persisted.quota_baseline, "the baseline must survive to the next turn");
    assert.equal(persisted.quota_baseline.percent_5h, 12);
    assert.equal(persisted.quota_baseline.percent_week, 66);
    assert.equal(typeof persisted.quota_baseline.captured_epoch, "number");
    assert.equal(persisted.quota_baseline.rebased_epoch, null);
  });

  test("INV-3: a SECOND turn does not re-capture (the baseline is per-run, not per-turn)", () => {
    const captured = baseline(2, 60);
    const { persisted } = runDecide(baseState({
      quota_5h_max_pts: 100, // high enough that the delta never terminates
      quota_baseline: captured,
      usage_eligibility: usagePayload({ percentLast5h: 30, percentSinceReset: 66 }),
    }));
    assert.equal(persisted.quota_baseline.percent_5h, 2,
      "re-capturing each turn would make the delta permanently ~0 and the cap dead");
    assert.equal(persisted.quota_baseline.percent_week, 60);
    assert.equal(persisted.quota_baseline.captured_epoch, captured.captured_epoch);
  });

  // INV-1 — the default leaves state.json byte-identical.
  test("INV-1: with the cap disabled NO quota_baseline key is ever written", () => {
    const input = baseState({
      usage_eligibility: usagePayload({ percentLast5h: 30, percentSinceReset: 95 }),
    });
    const { plan, persisted } = runDecide(input);
    assert.equal(terminateAction(plan), undefined);
    assert.equal("quota_baseline" in persisted, false,
      "a default run's state must not grow a key the cap never reads");
  });

  test("an uncalibrated meter captures NOTHING (no baseline off a guess)", () => {
    const { plan, persisted } = runDecide(baseState({
      quota_5h_max_pts: 10,
      usage_eligibility: usagePayload({ percentLast5h: 12, calibrated: false }),
    }));
    assert.equal(terminateAction(plan), undefined);
    assert.equal("quota_baseline" in persisted, false);
  });

  // INV-4 — the reset rebase, observed through the persisted state.
  test("INV-4: a window reset REBASES the baseline down and does not terminate", () => {
    const { plan, persisted } = runDecide(baseState({
      quota_5h_max_pts: 10,
      quota_baseline: baseline(30, 66),
      // 5h window rolled over: 30 -> 3. Weekly unchanged.
      usage_eligibility: usagePayload({ percentLast5h: 3, percentSinceReset: 66 }),
    }));
    assert.equal(terminateAction(plan), undefined, "a reset must never terminate");
    assert.equal(persisted.quota_baseline.percent_5h, 3,
      "post-reset spend must be measured fresh from the new window");
    assert.equal(persisted.quota_baseline.percent_week, 66, "the weekly baseline is untouched");
    assert.equal(typeof persisted.quota_baseline.rebased_epoch, "number");
  });

  test("INV-4: after a rebase, spend from the NEW window still trips the cap", () => {
    // Turn N: reset rebases 30 -> 3.
    const afterReset = runDecide(baseState({
      quota_5h_max_pts: 10,
      quota_baseline: baseline(30, 66),
      usage_eligibility: usagePayload({ percentLast5h: 3, percentSinceReset: 66 }),
    })).persisted;
    // Turn N+1: the new window has since burned 15 points (3 -> 18).
    const { plan } = runDecide({
      ...afterReset,
      usage_eligibility: usagePayload({ percentLast5h: 18, percentSinceReset: 66 }),
    });
    assert.equal(terminateAction(plan)?.cause, "quota",
      "the rebase must not permanently disarm the cap");
  });

  // INV-1 — the other existing causes, with the cap ENABLED but not tripped.
  test("INV-1: existing budget / wall_clock / idle terminations are unchanged", () => {
    const quotaArmedButUnder = {
      quota_5h_max_pts: 10,
      quota_baseline: baseline(2, 60),
      usage_eligibility: usagePayload({ percentLast5h: 5, percentSinceReset: 62 }),
    };

    const budget = runDecide(baseState({
      ...quotaArmedButUnder, token_budget: 100, cumulative_tokens: 5_000,
    })).plan;
    assert.equal(terminateAction(budget)?.cause, "budget");

    const wall = runDecide(baseState({
      ...quotaArmedButUnder,
      started_epoch: Math.floor(Date.now() / 1000) - 40_000,
      wall_clock_max_sec: 28_800,
    })).plan;
    assert.equal(terminateAction(wall)?.cause, "wall_clock");

    const idle = runDecide(baseState({ ...quotaArmedButUnder, idle_turns: 9 })).plan;
    assert.equal(terminateAction(idle)?.cause, "idle");
  });
});

// ---------------------------------------------------------------------------
// 3. bootstrap.sh / args-parse.sh — the operator-facing knobs
// ---------------------------------------------------------------------------

describe("--quota-5h-max / --quota-week-max plumbing (issue #3867)", () => {
  interface BTmp { dir: string; state: string; heartbeat: string; log: string }

  function makeBootstrapTmp(): BTmp {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-quota-bootstrap-"));
    return {
      dir,
      state: join(dir, "state.json"),
      heartbeat: join(dir, "heartbeat.txt"),
      log: join(dir, "nightly.log"),
    };
  }

  /**
   * Isolated bootstrap run (non-default STATE/HEARTBEAT/LOG => bootstrap skips
   * the run-start POST, so this never registers a fake run with the live
   * dashboard). Every inherited HYDRA_AUTOPILOT_* var is stripped first: the
   * host's systemd drop-in exports some, and a leak would make the
   * default-value assertions read the HOST's override (issue #1231).
   */
  function runBootstrap(
    env: Record<string, string>,
    argv: string[],
    expectFailure = false,
  ): any {
    const tmp = makeBootstrapTmp();
    try {
      const sanitized = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("HYDRA_AUTOPILOT_")),
      );
      const r = spawnSync(BOOTSTRAP, argv, {
        env: {
          ...sanitized,
          HYDRA_AUTOPILOT_STATE: tmp.state,
          HYDRA_AUTOPILOT_HEARTBEAT: tmp.heartbeat,
          HYDRA_AUTOPILOT_LOG: tmp.log,
          HYDRA_AUTOPILOT_UNATTENDED: "true",
          ...env,
          PATH: process.env.PATH ?? "",
        },
        encoding: "utf-8",
      });
      if (expectFailure) {
        return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      }
      assert.equal(r.status, 0, `bootstrap failed: ${r.stderr}`);
      assert.ok(existsSync(tmp.state), "bootstrap must write the state file");
      const state = JSON.parse(readFileSync(tmp.state, "utf-8"));
      return { limits: state.limits, state, stdout: r.stdout ?? "" };
    } finally {
      rmSync(tmp.dir, { recursive: true, force: true });
    }
  }

  // Deliberately few cases with several assertions each: every case spawns a
  // real bootstrap.sh, and a spawn-heavy file is exactly what the
  // `--test-force-exit` truncation race bites (CLAUDE.md's suite-count note).
  test("both flags stamp state.limits, in both arg and env form, args winning", () => {
    const flags = runBootstrap({}, ["--quota-5h-max=10", "--quota-week-max=25"]);
    assert.equal(flags.limits.quota_5h_max_pts, 10);
    assert.equal(flags.limits.quota_week_max_pts, 25);

    const env = runBootstrap(
      { HYDRA_AUTOPILOT_QUOTA_5H_MAX: "7", HYDRA_AUTOPILOT_QUOTA_WEEK_MAX: "12" },
      [],
    );
    assert.equal(env.limits.quota_5h_max_pts, 7);
    assert.equal(env.limits.quota_week_max_pts, 12);

    // Explicit > implicit, and fractional caps survive (the percentages the cap
    // compares against are floats server-side).
    const both = runBootstrap(
      { HYDRA_AUTOPILOT_QUOTA_5H_MAX: "7" },
      ["--quota-5h-max=2.5"],
    );
    assert.equal(both.limits.quota_5h_max_pts, 2.5);
  });

  // INV-1 at the plumbing layer: the default invocation is DISABLED, and the
  // bootstrap-written state is immediately consumable by the cap (absent
  // quota_baseline => term-check prints OK rather than crashing).
  test("INV-1: no flag, no env => both caps 0, and term-check.py reads it cleanly", () => {
    const r = runBootstrap({}, []);
    assert.equal(r.limits.quota_5h_max_pts, 0);
    assert.equal(r.limits.quota_week_max_pts, 0);
    assert.match(
      r.stdout,
      /quota_5h_max_pts=0 quota_week_max_pts=0/,
      "the resolved-limits line must surface the caps for the operator log",
    );

    const armed = runBootstrap({}, ["--quota-5h-max=10"]);
    assert.equal("quota_baseline" in armed.state, false,
      "bootstrap must NOT seed a baseline — that is what re-arms capture per run");
    assert.match(runTermCheck(armed.state).stdout, /^OK /);
  });

  // The caps are interpolated UNQUOTED into the state.json heredoc (they are
  // JSON numbers). A typo must FATAL with a clear message rather than emit torn
  // JSON that breaks every downstream jq/json.load reader at Phase 0.
  test("a non-numeric cap FATALs loudly instead of writing torn JSON", () => {
    const r = runBootstrap({}, ["--quota-5h-max=ten"], true);
    assert.notEqual(r.status, 0, "a non-numeric cap must abort bootstrap");
    assert.match(r.stdout + r.stderr, /FATAL: QUOTA_5H_MAX=ten invalid/);
  });

  // Issue #4129 — the original glob (`''|*[!0-9.]*|*.*.*|.`) had no arm for a
  // BARE leading or trailing decimal point, so `.5` and `5.` slipped through.
  // Neither is a JSON number (`json.loads(".5")` -> Expecting value), so both
  // produced exactly the torn-JSON state.json this validator exists to prevent
  // — just via a narrower typo class than `ten`. The fix requires a digit on
  // each side of an optional decimal point.
  test("bare-decimal caps (.5 / 5.) FATAL too; well-formed values still pass (issue #4129)", () => {
    const leading = runBootstrap({}, ["--quota-5h-max=.5"], true);
    assert.notEqual(leading.status, 0, "`.5` is not a JSON number — must abort");
    assert.match(leading.stdout + leading.stderr, /FATAL: QUOTA_5H_MAX=\.5 invalid/);

    const trailing = runBootstrap({}, ["--quota-week-max=5."], true);
    assert.notEqual(trailing.status, 0, "`5.` is not a JSON number — must abort");
    assert.match(trailing.stdout + trailing.stderr, /FATAL: QUOTA_WEEK_MAX=5\. invalid/);

    // The already-rejected classes stay rejected — pinned here so a future glob
    // rewrite cannot silently drop one while chasing the bare-decimal fix.
    const multiDot = runBootstrap({}, ["--quota-5h-max=1.2.3"], true);
    assert.notEqual(multiDot.status, 0, "two decimal points are never a number");
    const bareDot = runBootstrap({}, ["--quota-5h-max=."], true);
    assert.notEqual(bareDot.status, 0, "a bare dot is never a number");

    // And every still-valid form keeps flowing through: fractional caps
    // (integers and the disabled default 0 are pinned by the cases above).
    const ok = runBootstrap({}, ["--quota-5h-max=0.5", "--quota-week-max=90.5"]);
    assert.equal(ok.limits.quota_5h_max_pts, 0.5);
    assert.equal(ok.limits.quota_week_max_pts, 90.5);
  });
});
