/**
 * Regression tests for issue #4130 — a GraphQL-only GitHub outage silently
 * degrades every board signal to zero/none, and the autopilot reads that as
 * "no work".
 *
 * Observed live during autopilot run 161d9642 (2026-08-17): GitHub's GraphQL
 * endpoint 503'd on every request while REST stayed healthy
 * (graphql.remaining: 4626/5000 — NOT a rate limit). Every `gh issue list
 * --json` / `gh pr list --json` board read in collect-state.sh failed
 * silently (`2>/dev/null || true` → empty → zero/none), decide.py was handed
 * a snapshot indistinguishable from an empty board, the run drained to
 * `terminate` with a CLEAN `idle` cause, and `orch_backfill_idle` could fire
 * backfill against a full board.
 *
 * The fix has two halves, pinned here:
 *
 *   EMISSION (collect-state.sh) — a FAILED read is distinguishable from a
 *   genuinely EMPTY one: every board read that has no silent fallback now
 *   captures its gh output and treats an EMPTY capture (the jq programs
 *   always print at least `[]`/`{}` on success) as a failure — emitting NO
 *   fabricated zero/none lines and folding the failure into a lane degraded
 *   flag (`orch_board_signals_degraded` / `target_board_signals_degraded`).
 *
 *   DECISION (decide.py) — a snapshot flagged
 *   `signals.orch_board_signals_degraded=true` must never be read as a quiet
 *   board: no `terminate`/wait-only `idle` conclusions, and the whole
 *   `orch_backfill_idle` backfill set is suppressed for the turn.
 *
 * AC (d) — a GENUINELY empty board (successful read, zero counts) keeps
 * today's behaviour exactly — pinned here as the contrast arm of every
 * suppression test, alongside the pre-existing emitter pins in
 * test/autopilot-arch-fallback-signals.test.mts (empty board →
 * orch_backfill_idle=true).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const COLLECT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");
const src = readFileSync(COLLECT, "utf-8");

// ---------------------------------------------------------------------------
// EMISSION — collect-state.sh must not fabricate a readable board (AC a)
// ---------------------------------------------------------------------------

describe("collect-state.sh — failed board reads are loud, not zero (issue #4130)", () => {
  test("orch board-state fallback: a failed read emits NO counts and folds ORCH_BOARD_DEGRADED", () => {
    // The jq always prints a JSON object on success (an empty board prints
    // all-zero counts), so an EMPTY capture means the read itself failed.
    assert.match(
      src,
      /ORCH_FALLBACK_BOARD_JSON=\$\(gh issue list --repo gaberoo322\/hydra/,
      "the fallback must capture its gh output so a failed (empty) read is detectable",
    );
    assert.match(
      src,
      /if \[ -n "\$ORCH_FALLBACK_BOARD_JSON" \]; then\s+printf '%s\\n' "\$ORCH_FALLBACK_BOARD_JSON"\s+else\s+ORCH_BOARD_DEGRADED=true\s+fi/,
      "an empty capture must print NOTHING (absent ≠ zero) and fold into ORCH_BOARD_DEGRADED",
    );
  });

  test("grill walk: a failed candidate read flags the walk and emits the degraded sentinel, never a legitimate none", () => {
    // The candidate jq wraps rows in an array literal, so success always
    // prints at least `[]` — empty means the read failed. (The capture shape
    // itself is pinned by test/autopilot-collect-state-signals.test.mts
    // (#4096); the `2>/dev/null || true` tail must stay.)
    assert.match(src, /--jq '\s+\[ \.\[\] \| select/);
    assert.match(
      src,
      /ORCH_GRILL_READ_FAILED=false\s+if \[ -z "\$ORCH_GRILL_LIST_JSON" \]; then\s+ORCH_GRILL_READ_FAILED=true\s+ORCH_BOARD_DEGRADED=true\s+fi/,
      "an empty candidate capture must flag the walk AND fold the lane flag",
    );
    assert.match(
      src,
      /if \[ "\$ORCH_GRILL_READ_FAILED" = true \]; then\s+ORCH_GRILL_PICK="degraded"\s+ORCH_DEV_READY_PICK="degraded"\s+fi/,
      "a failed walk must emit the explicit `degraded` sentinel picks — a failed read is not 'no anchor'",
    );
  });

  test("arch/cleanup board read: the all-zero fabrication is gone; a failed read fails closed", () => {
    // Pre-#4130 the capture tail was
    // `|| echo '{"ready_for_agent":0,…}'` — a fabricated EMPTY board that
    // made the emitter compute orch_backfill_idle=true during the outage.
    assert.doesNotMatch(
      src,
      /\|\| echo '\{"ready_for_agent":0,"needs_research":0,"needs_triage":0,"arch_sourced":0,"cleanup_sourced":0\}'/,
      "a failed arch board read must not fabricate a legitimate-looking empty board (#4130)",
    );
    assert.match(
      src,
      /if \[ -n "\$ARCH_BOARD_JSON" \]; then\s+printf '%s' "\$ARCH_BOARD_JSON"/,
      "the python emitter must only run on a successful (non-empty) capture",
    );
    assert.match(
      src,
      /else\s+ORCH_BOARD_DEGRADED=true\s+echo "orch_backfill_idle=false"\s+echo "arch_board_open_scan=0"\s+echo "arch_board_saturated=true"\s+echo "cleanup_board_open_scan=0"\s+echo "cleanup_board_saturated=true"/,
      "a failed arch read must emit the SUPPRESSING defaults (fail closed — the same direction as the Target lane) and fold the lane flag",
    );
  });

  test("the folded orch flag is emitted exactly once, from the arch block's tail", () => {
    assert.equal(
      src.match(/orch_board_signals_degraded=/g)?.length,
      1,
      "exactly one emission site — the flag folds every orch board read into one line",
    );
    assert.match(src, /echo "orch_board_signals_degraded=\$ORCH_BOARD_DEGRADED"/);
    // Ordering: the emission must come AFTER the last read that can set the
    // flag (the arch/cleanup block), or a late failure would be dropped.
    const emitIdx = src.indexOf('echo "orch_board_signals_degraded=$ORCH_BOARD_DEGRADED"');
    const archElseIdx = src.indexOf('ARCH_BOARD_JSON=$(gh issue list');
    assert.ok(emitIdx > archElseIdx, "the folded emission must follow the arch board read it folds");
  });

  test("target lane: the earlier fallback failure folds into the lane degraded line", () => {
    // The lane read can succeed while the board-state fallback failed; a bare
    // `=false` there would re-create the invisible zero-set the outage left.
    assert.match(src, /echo "target_board_signals_degraded=\$TARGET_BOARD_DEGRADED"/);
    assert.match(src, /echo "target_board_signals_degraded=true"/,
      "the unreachable-lane branch keeps its literal true emission (issue #3478)");
    const initIdx = src.indexOf("TARGET_BOARD_DEGRADED=false");
    const readIdx = src.indexOf('TARGET_BOARD_STATE_JSON=$(hydra raw GET');
    assert.ok(initIdx > -1 && initIdx < readIdx,
      "TARGET_BOARD_DEGRADED must be initialised before the first read that can set it");
  });

  test("AC (d): a genuinely empty board is NOT a failed read — detection is empty-output only", () => {
    // `[]` from a successful gh call is non-empty, so a board with zero
    // ready-for-agent issues never trips the failure guards. The emitter-side
    // behaviour (empty VALID board → orch_backfill_idle=true) is pinned by
    // test/autopilot-arch-fallback-signals.test.mts; here we pin that the
    // detection predicate is `-z` (string emptiness), not any content check
    // that could misread a successful-but-empty payload.
    assert.match(src, /if \[ -z "\$ORCH_GRILL_LIST_JSON" \]/);
    assert.match(src, /if \[ -n "\$ARCH_BOARD_JSON" \]/);
    assert.doesNotMatch(src, /ORCH_GRILL_LIST_JSON =+"\[\]"/,
      "an explicit `[]` comparison must not appear — `[]` is a successful empty read");
  });
});

// ---------------------------------------------------------------------------
// DECISION — decide.py must not read a degraded snapshot as a quiet board
// ---------------------------------------------------------------------------

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-board-degraded-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

interface StateOverrides {
  idle_turns?: number;
  idle_drain_turns?: number;
  started_epoch?: number;
  wall_clock_max_sec?: number;
  signals?: Record<string, unknown>;
  seed_discover_fired?: boolean;
}

function baseState(o: StateOverrides = {}): any {
  return {
    started_epoch: o.started_epoch ?? Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: o.wall_clock_max_sec ?? 28_800,
      idle_drain_turns: o.idle_drain_turns ?? 5,
      context_compaction_turns: 0,
      scope: "all",
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: 0,
    dispatches: 0,
    idle_turns: o.idle_turns ?? 0,
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
      // Same seeding as the #1352 pinner in test/autopilot-decide.test.mts:
      // post-#4114 a never-fired discover_orch dispatches via the staleness
      // floor, which would make this turn dispatch-bearing and mask the
      // idle-drain paths under test.
      discover_orch: o.seed_discover_fired ? Math.floor(Date.now() / 1000) : 0,
      discover_target: 0,
    },
    signals: o.signals ?? {},
    research_force_counter: {},
  };
}

function runDecide(state: any, candidates: any = null, events: any[] = []): any {
  const t = makeTmp();
  writeFileSync(t.state, JSON.stringify(state));
  writeFileSync(t.cands, JSON.stringify(candidates));
  writeFileSync(t.events, JSON.stringify(events));
  try {
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

function actionTypes(plan: any): string[] {
  return (plan.actions ?? []).map((a: any) => a.type);
}

const BACKFILL_SLOTS = ["discover_orch", "architecture_orch", "cleanup_orch", "skill_prune"] as const;

describe("decide.py — degraded orch board read suppresses idle conclusions (issue #4130, AC b)", () => {
  test("a degraded wait-only turn emits the degraded hold, NOT terminate:idle", () => {
    // The exact #4130 scenario shape: every signal absent because the read
    // failed — pre-#4130 this was a wait-only turn that cleanly idle-drained
    // (issue #1352) with no record the loop went idle because it was BLIND.
    const plan = runDecide(baseState({ signals: { orch_board_signals_degraded: true } }));
    assert.equal(
      actionTypes(plan).some((t) => t === "terminate"),
      false,
      "a degraded snapshot must never drain the run with terminate (cause would be idle — fabricated emptiness)",
    );
    assert.ok(actionTypes(plan).includes("wait"), "the degraded hold is a heartbeat wait");
    assert.equal(plan.debug?.idle_fallback, "degraded-board-hold",
      "the turn record must name WHY the idle conclusion was withheld");
    assert.equal(plan.debug?.orch_board_degraded, true);
  });

  test("AC (d) contrast: a clean wait-only turn still terminates idle (#1352 unchanged)", () => {
    // Same shape as the #1352 pinner in test/autopilot-decide.test.mts:
    // discover_orch seeded fired-just-now so the #4114 staleness floor
    // doesn't make the turn dispatch-bearing — the degraded hold in the
    // test above must be attributable ONLY to the flag.
    const plan = runDecide(baseState({ seed_discover_fired: true }));
    const term = (plan.actions ?? []).find((a: any) => a.type === "terminate");
    assert.ok(term, "a genuinely quiet board still idle-drains");
    assert.equal(term.cause, "idle");
  });

  test("idle_drain termination is withheld on a degraded snapshot even at idle_turns >= idle_drain_turns", () => {
    const plan = runDecide(baseState({
      idle_turns: 5,
      idle_drain_turns: 5,
      signals: { orch_board_signals_degraded: true },
    }));
    const term = (plan.actions ?? []).find((a: any) => a.type === "terminate");
    assert.equal(term, undefined,
      "the idle-drain backstop must not fire while the board read is degraded (#4130)");
  });

  test("AC (d) contrast: the same exhausted idle counter still terminates without the flag", () => {
    const plan = runDecide(baseState({ idle_turns: 5, idle_drain_turns: 5 }));
    const term = (plan.actions ?? []).find((a: any) => a.type === "terminate");
    assert.ok(term && term.cause === "idle",
      "an honestly-idle run keeps its clean idle drain (existing behaviour, pinned by test/autopilot-decide.test.mts)");
  });

  test("wall_clock remains an honest backstop on a degraded snapshot", () => {
    // The hold must not immortalise a permanently-blind run: elapsed past
    // wall_clock_max_sec still terminates (with the honest cause).
    const plan = runDecide(baseState({
      started_epoch: Math.floor(Date.now() / 1000) - 30_000,
      wall_clock_max_sec: 28_800,
      signals: { orch_board_signals_degraded: true },
    }));
    const term = (plan.actions ?? []).find((a: any) => a.type === "terminate");
    assert.ok(term && term.cause === "wall_clock",
      "degraded holds defer idle conclusions, not the wall-clock bound");
  });

  test("decide.py stays pure — the degraded flag is only ever a state read, never an I/O call", () => {
    // INV-3 of the issue-4130 design concept: decide.py must not verify a
    // degraded read itself — it only reads the pre-resolved signal. The
    // decide() logic is pure; decide.py's ONLY subprocess/network users are
    // the pre-existing function-local CLI blocks in its I/O tail (run-end
    // POST + telemetry). Pin both halves: the helper is one pure state read,
    // and the flag name is never referenced from the I/O tail.
    const py = readFileSync(DECIDE, "utf-8");
    assert.match(
      py,
      /def _orch_board_degraded\(state: dict\) -> bool:\s+"""[\s\S]*?"""\s+return bool\(\(state\.get\("signals"\) or \{\}\)\.get\("orch_board_signals_degraded"\)\)/,
      "the degraded check is one pure read of state.signals",
    );
    const firstIo = py.indexOf("import subprocess");
    const lastFlag = py.lastIndexOf("orch_board_signals_degraded");
    assert.ok(firstIo > 0 && lastFlag > -1 && lastFlag < firstIo,
      "every degraded-flag read lives in the pure decide() section, before the CLI I/O tail");
  });
});

describe("decide.py — degraded orch board read suppresses backfill dispatch (issue #4130, AC c)", () => {
  test("no ORCH_BACKFILL_IDLE_CLASSES dispatch on a degraded snapshot, each skip recorded", () => {
    // orch_backfill_idle read `true` here exactly as it did during the
    // outage — fabricated from failed reads with 15 real issues on the
    // board. The degraded flag must suppress the whole set, discover_orch's
    // staleness floor included (signal_last_fired at epoch 0 = maximally
    // dark, so the floor branch is the live hazard in this fixture).
    const plan = runDecide(baseState({
      signals: { orch_board_signals_degraded: true, orch_backfill_idle: true },
    }));
    for (const slot of BACKFILL_SLOTS) {
      assert.equal(
        (plan.actions ?? []).find((a: any) => a.type === "dispatch" && a.slot === slot),
        undefined,
        `${slot} must not dispatch against a board it cannot read`,
      );
    }
    for (const slot of BACKFILL_SLOTS) {
      const ev = (plan.events ?? []).find(
        (e: any) => e.event === "dispatch_decision" && e.class === slot,
      );
      assert.ok(ev, `${slot} must record a dispatch_decision for the audit trail`);
      assert.equal(ev.outcome, "idle");
      assert.match(String(ev.reason), /degraded/,
        `${slot}'s skip reason must name the degradation (issue #4130)`);
    }
  });

  test("AC (d) contrast: an honestly-idle board still backfills (orch_backfill_idle without the flag)", () => {
    const plan = runDecide(baseState({ signals: { orch_backfill_idle: true } }));
    const dispatched = BACKFILL_SLOTS.filter((slot) =>
      (plan.actions ?? []).some((a: any) => a.type === "dispatch" && a.slot === slot),
    );
    assert.ok(dispatched.length >= 1,
      "a genuinely empty board keeps its backfill dispatch (stagger still applies — pinned by test/autopilot-decide.test.mts)");
  });

  test("the orch flag is lane-scoped: target backfill is NOT suppressed", () => {
    // The outage read is orch-specific; a degraded ORCH board must not stall
    // the Target lane (the target_* signals have their own degraded flag,
    // advisory in decide.py today by design — #4130 scope).
    const plan = runDecide(baseState({
      signals: {
        orch_board_signals_degraded: true,
        target_backfill_idle: true,
        target_cleanup_board_saturated: false,
      },
    }));
    assert.ok(
      (plan.actions ?? []).some((a: any) => a.type === "dispatch" && a.slot === "cleanup_target"),
      "cleanup_target keys off target_backfill_idle and must keep firing while only the ORCH read is degraded",
    );
  });
});

describe("decide.py — the `degraded` anchor sentinel collapses like `none` (issue #4130)", () => {
  test("degraded anchor signals yield no anchor and fire no grill — same shape as `none`", () => {
    const plan = runDecide(baseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "degraded",
        orch_dev_ready_anchor: "degraded",
      },
    }));
    assert.equal(
      (plan.actions ?? []).find((a: any) => a.type === "dispatch" && a.slot === "design_concept_orch"),
      undefined,
      "a degraded grill anchor is not a real anchor — design_concept_orch must not fire on it",
    );
    const dev = (plan.actions ?? []).find(
      (a: any) => a.type === "dispatch" && a.slot === "dev_orch",
    );
    assert.ok(dev, "dev_orch still fires on orch_work_available");
    assert.equal(dev.prompt_args?.anchor, undefined,
      "the sentinel must never leak into a dispatch prompt as an anchor ref");
  });

  test("contrast: a real anchor ref still pins dev_orch (existing behaviour)", () => {
    // Per #3711 the pin fires when a grill is PENDING on a different anchor —
    // the unpinned yield otherwise lets hydra-dev self-select.
    const plan = runDecide(baseState({
      signals: {
        orch_work_available: true,
        orch_pending_grill_anchor: "issue-9999",
        orch_dev_ready_anchor: "issue-4130",
      },
    }));
    const dev = (plan.actions ?? []).find(
      (a: any) => a.type === "dispatch" && a.slot === "dev_orch",
    );
    assert.ok(dev);
    assert.equal(dev.prompt_args?.anchor, "issue-4130",
      "a real grill-clear anchor keeps pinning dev_orch (issue #3711)");
  });
});
