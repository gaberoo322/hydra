/**
 * Regression tests for the orch-lane degraded-board-read contract (issue #4130).
 *
 * During the 2026-08-17 GitHub GraphQL 503 outage (REST healthy), every
 * `gh issue list --json` call in collect-state.sh failed through its
 * best-effort guards and rendered as a LEGITIMATE empty board: the orch
 * board-counts JSON line was absent, both anchor picks printed `none` (while
 * 15 ready-for-agent issues sat on the board), target_ready_for_agent read 0
 * (true count 34), and target_board_signals_degraded reported FALSE. decide.py
 * then concluded "no work": dev_orch yielded, runs drained to terminate:idle
 * with a clean cause, and orch_backfill_idle could read true off the failed
 * read and fire backfill against a full board.
 *
 * The fix has two halves, pinned here:
 *
 *   1. collect-state.sh latches ORCH_GH_READ_FAILED on any failed /
 *      unparseable orch gh read of the turn and closes with an explicit
 *      `orch_board_signals_degraded=true|false` line — the orch mirror of the
 *      Target lane's target_board_signals_degraded, which itself now actually
 *      flips (it used to be emitted BEFORE the payload parse, so error text
 *      on stdout passed the non-empty gate and reported degraded=FALSE).
 *   2. decide.py reads that pre-resolved flag (the signal-seam discipline —
 *      it never recomputes board health) and on a degraded snapshot:
 *        - does NOT terminate with cause idle (budget / wall_clock still
 *          bound an extended outage — those causes are untouched),
 *        - does NOT dispatch any orch_backfill_idle-keyed backfill class,
 *        - stamps the condition on the turn record (reasons + debug) so it
 *          is attributable post-hoc (AC 4).
 *
 * Layered like its siblings (test/autopilot-target-board-signals.test.mts,
 * test/autopilot-idle.test.mts): source-shape assertions over the committed
 * shell, the committed python validators/emitters run for real, and decide.py
 * exercised through its CLI harness.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const COLLECT_STATE = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");
const SRC = readFileSync(COLLECT_STATE, "utf-8");

// ---------------------------------------------------------------------------
// collect-state.sh — failure latching + the lane flags (AC 1 / AC 2)
// ---------------------------------------------------------------------------

describe("collect-state.sh — orch gh-read failure latching (#4130)", () => {
  test("the script closes with orch_board_signals_degraded in BOTH branches (AC 2)", () => {
    // The orch mirror of the Target lane flag: emitted unconditionally, true
    // only when a read of the turn latched ORCH_GH_READ_FAILED. It must be a
    // closing emit so every earlier latch of the turn is folded in.
    assert.match(
      SRC,
      /if \[ "\$ORCH_GH_READ_FAILED" -ne 0 \]; then\n\s*echo "orch_board_signals_degraded=true"\n\s*else\n\s*echo "orch_board_signals_degraded=false"\n\s*fi/,
      "the closing emit must key on the ORCH_GH_READ_FAILED latch and ship both branches",
    );
  });

  test("a failed orch board-counts fallback latches the lane and emits NOTHING (AC 1)", () => {
    // The 2026-08-17 shape under test: the fallback `gh issue list` failed and
    // the guard swallowed it, so the board-counts JSON line simply never
    // appeared — the playbook derived an empty board from absence. The fix
    // keeps failure SILENT for the counts (an absent line cannot pose as a
    // legitimate zero-set; `orch_work_available` stays unset, which is the
    // dispatch-SUPPRESSING direction) but latches the lane so the closing
    // flag explains the absence.
    const m = SRC.match(
      /ORCH_FALLBACK_BOARD_RC=\$\?\n\s*if \[ "\$ORCH_FALLBACK_BOARD_RC" -eq 0 \] && printf '%s' "\$ORCH_FALLBACK_BOARD_JSON" \| _json_ok; then\n\s*printf '%s\\n' "\$ORCH_FALLBACK_BOARD_JSON"\n\s*else\n(?:\s*#[^\n]*\n)*\s*ORCH_GH_READ_FAILED=1\n\s*fi/,
    );
    assert.ok(
      m,
      "the counts fallback must validate the payload with _json_ok, print it only on success, and latch ORCH_GH_READ_FAILED=1 (emitting nothing) on failure",
    );
    // And the failure branch must not smuggle any count emission back in:
    // slice from the latch to the closing fi of that if-block.
    const latchIdx = SRC.indexOf("ORCH_GH_READ_FAILED=1", SRC.indexOf("ORCH_FALLBACK_BOARD_RC"));
    const fiIdx = SRC.indexOf("\nfi", latchIdx);
    const failureBranch = SRC.slice(latchIdx, fiIdx);
    assert.doesNotMatch(
      failureBranch,
      /printf|echo/,
      "the failed-read branch must emit NOTHING — absence, never a printed zero",
    );
  });

  test("a failed grill-candidate read suppresses the anchor echoes entirely (AC 1)", () => {
    // During the outage both anchor picks rendered as a LEGITIMATE `none`
    // while 15 eligible issues sat on the board. The failure branch blanks
    // the payload and latches; the three anchor echoes are gated on the
    // read having SUCCEEDED, so a failed enumeration is ABSENT, not `none`.
    assert.match(
      SRC,
      /if \[ "\$ORCH_GRILL_LIST_RC" -ne 0 \] \|\| ! printf '%s' "\$ORCH_GRILL_LIST_JSON" \| _json_list_ok; then\n\s*ORCH_GH_READ_FAILED=1\n\s*ORCH_GRILL_LIST_FAILED=1\n\s*ORCH_GRILL_LIST_JSON=""\n\s*else\n\s*ORCH_GRILL_LIST_FAILED=0\n\s*fi/,
      "a non-zero rc OR an unparseable candidate payload must latch both the lane and the list failure, and blank the payload",
    );
    assert.match(
      SRC,
      /if \[ "\$ORCH_GRILL_LIST_FAILED" -eq 0 \]; then\n\s*echo "orch_pending_grill_anchor=\$ORCH_GRILL_PICK"\n\s*echo "orch_dev_ready_anchor=\$ORCH_DEV_READY_PICK"\n\s*echo "orch_dev_ready_anchor_design_concept_status=\$ORCH_DEV_READY_DESIGN_CONCEPT_STATUS"\n\s*fi/,
      "all three anchor echoes must be gated on a successful candidate read",
    );
  });

  test("the target lane flag can no longer report healthy off a failed read (AC 2)", () => {
    // Observed bug: target_board_signals_degraded=false was echoed BEFORE the
    // payload parse, so gh error text on stdout passed the `[ -n ]` gate while
    // the python except-path emitted fail-open zeros — degraded read reported
    // healthy. The healthy branch now also requires a JSON-array payload and
    // a clean TARGET_GH_READ_FAILED latch.
    assert.match(
      SRC,
      /if \[ -n "\$TARGET_BOARD_ISSUES_JSON" \] \\\n\s*&& printf '%s' "\$TARGET_BOARD_ISSUES_JSON" \| _json_list_ok \\\n\s*&& \[ "\$TARGET_GH_READ_FAILED" -eq 0 \]; then\n\s*echo "target_board_signals_degraded=false"/,
      "the healthy (false) branch must require a parseable payload AND no latched target-read failure of the turn",
    );
  });
});

// ---------------------------------------------------------------------------
// collect-state.sh — the committed validators, run for real (AC 1)
// ---------------------------------------------------------------------------

describe("collect-state.sh — _json_ok / _json_list_ok validators (#4130)", () => {
  const jsonOkFn = SRC.match(/^_json_ok\(\) \{[\s\S]*?^\}/m)?.[0];
  const jsonListOkFn = SRC.match(/^_json_list_ok\(\) \{[\s\S]*?^\}/m)?.[0];

  test("both validators are defined in the committed script", () => {
    assert.ok(jsonOkFn, "_json_ok() must exist");
    assert.ok(jsonListOkFn, "_json_list_ok() must exist");
  });

  /** Run one extracted validator against a payload; returns its exit code. */
  function validatorExit(fn: string, call: string, payload: string): number | null {
    const r = spawnSync("bash", ["-c", `${fn}\nprintf '%s' "$VPAYLOAD" | ${call}`], {
      encoding: "utf-8",
      env: { ...process.env, VPAYLOAD: payload },
    });
    return r.status;
  }

  test("_json_ok accepts any parseable JSON and rejects error text / emptiness", () => {
    assert.ok(jsonOkFn);
    assert.equal(validatorExit(jsonOkFn!, "_json_ok", '{"ready_for_agent":7}'), 0);
    assert.equal(validatorExit(jsonOkFn!, "_json_ok", "[]"), 0);
    // The outage shape: gh's error text on stdout.
    assert.equal(validatorExit(jsonOkFn!, "_json_ok", "gh: GraphQL: HttpError (503)"), 1);
    assert.equal(validatorExit(jsonOkFn!, "_json_ok", ""), 1);
  });

  test("_json_list_ok additionally requires a top-level ARRAY", () => {
    assert.ok(jsonListOkFn);
    assert.equal(validatorExit(jsonListOkFn!, "_json_list_ok", "[]"), 0);
    assert.equal(validatorExit(jsonListOkFn!, "_json_list_ok", '[{"number":1}]'), 0);
    // A JSON OBJECT parses fine but is not a candidate list — the healthy
    // grill jq always emits an array, so an object can only be a bad read.
    assert.equal(validatorExit(jsonListOkFn!, "_json_list_ok", '{"message":"Bad credentials"}'), 1);
    assert.equal(validatorExit(jsonListOkFn!, "_json_list_ok", "gh: HttpError"), 1);
    assert.equal(validatorExit(jsonListOkFn!, "_json_list_ok", ""), 1);
  });
});

// ---------------------------------------------------------------------------
// collect-state.sh — the ARCH emitter fails closed under ARCH_DEGRADED (AC 1)
// ---------------------------------------------------------------------------

describe("collect-state.sh — ARCH emitter degraded handling (#4130)", () => {
  function extractArchEmitter(): string {
    // Same anchor as test/autopilot-idle.test.mts — the committed board-idle
    // emitter, extracted verbatim so the two implementations cannot drift.
    const match = SRC.match(
      /printf '%s' "\$ARCH_BOARD_JSON"[\s\S]*?python3 -c "\$\(cat <<'PY'([\s\S]*?)\nPY\n\)"\s*2>\/dev\/null/,
    );
    assert.ok(match, "could not locate the ARCH board emitter python block in collect-state.sh");
    return match![1];
  }

  const ALL_ZERO_BOARD = JSON.stringify({
    ready_for_agent: 0,
    needs_research: 0,
    needs_triage: 0,
    arch_sourced: 0,
    cleanup_sourced: 0,
  });

  function runEmitter(boardJson: string, env: Record<string, string>): string[] {
    const r = spawnSync("python3", ["-c", extractArchEmitter()], {
      input: boardJson,
      encoding: "utf-8",
      env: {
        ...process.env,
        ARCH_WORK_QUEUE: "0",
        ARCH_BOARD_SATURATION_CAP: "6",
        CLEANUP_BOARD_SATURATION_CAP: "10",
        ...env,
      },
    });
    assert.equal(r.status, 0, `emitter exited non-zero: ${r.stderr}`);
    return (r.stdout ?? "").trim().split("\n");
  }

  test("ARCH_DEGRADED=1 fails closed: no idle conjunction, both saturation caps trip (AC 1)", () => {
    // The inverse hazard, reproduced at the emitter level: the same all-zero
    // payload that a GENUINELY empty board yields, but flagged degraded. The
    // 2026-08-17 outage fed the emitter exactly this shape (an all-zero
    // placeholder / unparseable fallback) and orch_backfill_idle read TRUE.
    const out = runEmitter(ALL_ZERO_BOARD, { ARCH_DEGRADED: "1" });
    assert.ok(
      out.includes("orch_backfill_idle=false"),
      "a degraded read must NEVER yield the board-empty conjunction — that is backfill off a read that did not happen",
    );
    assert.ok(out.includes("arch_board_saturated=true"), "degraded → arch saturation trips (fail closed)");
    assert.ok(out.includes("cleanup_board_saturated=true"), "degraded → cleanup saturation trips (fail closed)");
  });

  test("control: a genuinely empty board still yields orch_backfill_idle=true (AC 5d)", () => {
    // No ARCH_DEGRADED (the default '0' path) — the pre-#4130 behaviour for
    // a healthy empty board is byte-for-byte unchanged.
    const out = runEmitter(ALL_ZERO_BOARD, {});
    assert.ok(out.includes("orch_backfill_idle=true"));
    assert.ok(out.includes("arch_board_saturated=false"));
    assert.ok(out.includes("cleanup_board_saturated=false"));
  });
});

// ---------------------------------------------------------------------------
// decide.py — degraded snapshot behaviour (AC 3 / AC 4 / AC 5b / AC 5c / AC 5d)
// ---------------------------------------------------------------------------

interface Tmp { dir: string; state: string; cands: string; events: string }

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-orch-degraded-test-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "candidates.json"),
    events: join(dir, "events.json"),
  };
}

/** Same fixture contract as test/autopilot-decide.test.mts (trimmed to the
 * overrides these cases need). */
function baseState(o: {
  cumulative_tokens?: number;
  idle_turns?: number;
  idle_drain_turns?: number;
  signal_last_fired?: Record<string, number>;
  signals?: Record<string, unknown>;
} = {}): any {
  return {
    started_epoch: Math.floor(Date.now() / 1000),
    limits: {
      token_budget: 2_000_000,
      wall_clock_max_sec: 28_800,
      idle_drain_turns: o.idle_drain_turns ?? 5,
      context_compaction_turns: 0,
      scope: "all",
      subagent_max_tokens: 400_000,
      subagent_hard_max_tokens: 800_000,
    },
    cumulative_tokens: o.cumulative_tokens ?? 0,
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
    signal_last_fired: o.signal_last_fired ?? {
      health: 0, sweep_orch: 0, sweep_target: 0,
      discover_orch: 0, discover_target: 0,
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
  const r = spawnSync("python3", [DECIDE, "decide", t.state, t.cands, t.events], {
    encoding: "utf-8",
    // Keep the CLI's run-end POST (#1352) off — same belt-and-braces switch
    // as every other decide.py suite.
    env: { ...process.env, HYDRA_AUTOPILOT_RUN_END_POST: "off" },
  });
  rmSync(t.dir, { recursive: true, force: true });
  if (r.status !== 0) {
    throw new Error(`decide.py decide exited ${r.status}: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

function findAction(plan: any, predicate: (a: any) => boolean): any | undefined {
  return (plan.actions ?? []).find(predicate);
}

describe("decide.py — degraded orch board snapshot (#4130)", () => {
  const now = Math.floor(Date.now() / 1000);
  // discover_orch inside its 1h cooldown so the #4114 staleness floor cannot
  // add a dispatch and mask the paths under test (same seeding as the
  // terminate(idle) / architecture_orch cases in test/autopilot-decide.test.mts).
  const discoverCooling = { discover_orch: now } as any;

  test("degraded snapshot suppresses terminate(idle) — heartbeat wait instead (AC 3 / AC 5b)", () => {
    // Exactly the fixture that produced the outage's clean idle drain:
    // idle_turns at the drain threshold, every slot empty, nothing to do —
    // but the snapshot is flagged degraded, so "no work" is not knowable.
    const plan = runDecide(baseState({
      idle_turns: 5,
      idle_drain_turns: 5,
      signals: { orch_board_signals_degraded: true },
      signal_last_fired: discoverCooling,
    }), null);
    assert.equal(
      findAction(plan, (a) => a.type === "terminate"),
      undefined,
      "a blind snapshot must not conclude idle — the run keeps waiting instead of draining",
    );
    const w = findAction(plan, (a) => a.type === "wait");
    assert.ok(w, "the degraded idle turn falls through to the heartbeat wait");
    assert.match(
      w.reason ?? "",
      /degraded/,
      "the wait reason must name the degraded board read so the turn record shows why the run kept waiting",
    );
  });

  test("degraded snapshot suppresses every orch_backfill_idle backfill class (AC 3 / AC 5c)", () => {
    // orch_backfill_idle=true (as the failed read rendered it on 2026-08-17)
    // AND the degraded flag: no discover / architecture / cleanup / skill_prune
    // dispatch may fire off a board-empty conjunction computed blind.
    const plan = runDecide(baseState({
      signals: { orch_backfill_idle: true, orch_board_signals_degraded: true },
      signal_last_fired: discoverCooling,
    }), null);
    for (const slot of ["discover_orch", "architecture_orch", "cleanup_orch", "skill_prune"]) {
      assert.equal(
        findAction(plan, (a) => a.type === "dispatch" && a.slot === slot),
        undefined,
        `${slot} must not backfill off a degraded board read`,
      );
    }
    assert.equal(
      findAction(plan, (a) => a.type === "terminate"),
      undefined,
      "the blind empty-board conjunction must not terminate the run either",
    );
  });

  test("a TARGET-only degraded read also suppresses terminate(idle) (INV-6: idle_turns is global)", () => {
    // idle_turns is ONE counter fed by both lanes' selectors, so a target-only
    // degradation reaches the identical false-"no work" hazard the issue
    // documents for orch. The idle guards key on EITHER lane's flag.
    const plan = runDecide(baseState({
      idle_turns: 5,
      idle_drain_turns: 5,
      signals: { target_board_signals_degraded: true },
      signal_last_fired: discoverCooling,
    }), null);
    assert.equal(
      findAction(plan, (a) => a.type === "terminate"),
      undefined,
      "a target-blind snapshot must not conclude idle either — the counter is global (INV-6)",
    );
    const w = findAction(plan, (a) => a.type === "wait");
    assert.ok(w, "the target-degraded idle turn falls through to the heartbeat wait");
    assert.match(w.reason ?? "", /degraded/);
  });

  test("a TARGET-only degraded read does NOT suppress orch backfill (lane-scoped gating)", () => {
    // The mirror of INV-6: backfill suppression is orch-lane-scoped. A
    // degraded TARGET read says nothing about whether the orch board is idle,
    // so the orch backfill classes keep firing on a genuinely idle orch board.
    const plan = runDecide(baseState({
      signals: { orch_backfill_idle: true, target_board_signals_degraded: true },
      signal_last_fired: discoverCooling,
    }), null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "architecture_orch"),
      "orch backfill must stay live under a target-only degradation (lane-scoped)",
    );
  });

  test("degraded snapshot stamps the turn record: reasons line + debug key (AC 4)", () => {
    const plan = runDecide(baseState({
      signals: { orch_board_signals_degraded: true },
      signal_last_fired: discoverCooling,
    }), null);
    assert.ok(
      (plan.reasons ?? []).some((r: string) => r.includes("orch board read degraded (#4130)")),
      "the plan's reasons must carry the degraded-board line (heartbeat / turn-record visibility)",
    );
    assert.equal(
      plan.debug?.orch_board_signals_degraded,
      true,
      "the debug map must carry the machine-readable orch_board_signals_degraded key",
    );
    assert.deepEqual(
      plan.debug?.board_signals_degraded,
      ["orch"],
      "the debug map must name the degraded lane(s) (INV-6 composition point)",
    );
  });

  test("budget exhaustion still terminates on a degraded snapshot (outage stays bounded)", () => {
    // Only IDLE conclusions are suppressed. The budget bound must keep
    // working through a multi-hour outage, or the suppression would arm an
    // immortal run.
    const plan = runDecide(baseState({
      cumulative_tokens: 5_000_000,
      signals: { orch_board_signals_degraded: true },
      signal_last_fired: discoverCooling,
    }), null);
    const t = findAction(plan, (a) => a.type === "terminate");
    assert.ok(t, "budget exhaustion must still terminate on a degraded snapshot");
    assert.equal(t.cause, "budget");
  });

  test("discover_orch staleness-floor arm stays live on a degraded snapshot (deliberate)", () => {
    // The #4114 staleness floor is a BUSY-BOARD producer-liveness trigger
    // (discovery has been dark >24h), not an idle conclusion — it does not
    // read the board and is deliberately NOT gated on the degraded flag.
    // discover_orch NOT cooling + never fired → the floor arm fires.
    const state = baseState({ signals: { orch_board_signals_degraded: true } });
    // signal_last_fired.discover_orch = 0 (never fired) comes from baseState's
    // default seeding — well past DISCOVER_STALENESS_FLOOR_SEC.
    const plan = runDecide(state, null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "discover_orch"),
      "the staleness-floor arm must keep firing on a degraded snapshot (producer liveness, not a board conclusion)",
    );
  });

  test("control: without the flag, a genuinely idle board still drains cleanly (AC 5d)", () => {
    // The mirror of the suppression test — same fixture, no degraded flag:
    // the pre-#4130 behaviour (clean terminate(idle), #1352) is unchanged.
    const plan = runDecide(baseState({
      idle_turns: 5,
      idle_drain_turns: 5,
      signal_last_fired: discoverCooling,
    }), null);
    const t = findAction(plan, (a) => a.type === "terminate");
    assert.ok(t, "an idle turn on a HEALTHY snapshot must still terminate cleanly");
    assert.equal(t.cause, "idle");
  });

  test("control: without the flag, orch_backfill_idle still dispatches backfill (AC 5d)", () => {
    // discover_orch cooling → architecture_orch is the eligible backfill
    // class, exactly the pinned case in test/autopilot-decide.test.mts.
    const plan = runDecide(baseState({
      signals: { orch_backfill_idle: true },
      signal_last_fired: discoverCooling,
    }), null);
    assert.ok(
      findAction(plan, (a) => a.type === "dispatch" && a.slot === "architecture_orch"),
      "a genuinely idle board must still backfill architecture_orch",
    );
  });
});
