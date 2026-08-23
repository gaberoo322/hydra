/**
 * Regression tests for the board-read degradation seam (issue #4130).
 *
 * BACKGROUND
 *
 *   On 2026-08-17 a GraphQL-only gh outage made every `gh issue list --json` /
 *   `gh pr list --json` call in `scripts/autopilot/collect-state.sh` fail while
 *   REST stayed healthy. Each collector's `2>/dev/null || echo 0` / `|| true`
 *   guard silently rendered the failed reads as legitimate-looking `0` / `none`
 *   signals — the playbook derived "no orch work available", decide.py emitted
 *   wait-only turns, idle_turns climbed, and the run terminated with a CLEAN
 *   `idle` cause for what was really an outage. The ARCH read's zero-JSON
 *   fallback even computed `orch_backfill_idle=true` from the failed read and
 *   fired the backfill classes at a board it could not see (the inverse
 *   hazard).
 *
 * THE FIX (three layers)
 *
 *   1. collect-state.sh — every orch-lane board read detects its own failure
 *      (`if ! VAR=$(gh ...)`), withholds its counts (no legitimate `0`/`none`
 *      from a non-zero exit), and sets `ORCH_BOARD_DEGRADED`; the flag is
 *      emitted once as `orch_board_signals_degraded=true|false`. The Target
 *      lane's pre-existing `target_board_signals_degraded` flag now actually
 *      flips: it accumulates across BOTH target reads, not just the last one.
 *   2. decide.py — reads the pre-resolved flag (pure, signal-seam discipline)
 *      and (a) suspends BOTH `terminate:idle` paths, (b) fail-closes every
 *      `orch_backfill_idle` backfill selector (discover/architecture/cleanup/
 *      skill_prune), (c) emits a DISTINCT wait reason so a held drain is
 *      visible in the heartbeat turn record.
 *   3. The playbook Signal wiring table carries the flag into state.signals.
 *
 * TEST STRATEGY
 *
 *   collect-state.sh is run end-to-end with `gh`/`curl`/`hydra`/`systemctl`/
 *   `docker` stubbed on a temp PATH (the test/autopilot-grill-gate.test.mts
 *   harness pattern). The `gh` stub is keyed on each call's distinctive
 *   `--json` field list / `--label` / `--repo` combination and answers with
 *   the jq RESULT (the stub stands in for gh's built-in jq too). decide.py is
 *   exercised through its `decide` CLI subcommand (the autopilot-decide
 *   harness pattern).
 *
 * The four acceptance criteria map to the four describes below.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const COLLECT_STATE = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

// ---------------------------------------------------------------------------
// collect-state.sh harness
// ---------------------------------------------------------------------------

function writeStub(bin: string, name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

interface CollectResult {
  stdout: string;
  stderr: string;
}

/**
 * Run collect-state.sh with stubbed externals.
 *
 * @param ghMode `"fail"` — every gh call exits 1 (the total-outage shape).
 *   `"empty"` — every gh call SUCCEEDS against an empty board (the
 *   genuinely-empty-board shape); the stub answers each distinct call with
 *   the jq result a `[]` row set would produce.
 */
function runCollectState(ghMode: "fail" | "empty"): CollectResult {
  const dir = mkdtempSync(join(tmpdir(), "board-degraded-"));
  try {
    const bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);

    if (ghMode === "fail") {
      // Total gh outage: every invocation fails, stdout empty, like a real
      // `gh: GraphQL: 502 bad gateway` (gh writes errors to stderr).
      writeStub(
        bin,
        "gh",
        `#!/usr/bin/env bash\necho "gh: server error (stubbed outage)" >&2\nexit 1\n`,
      );
    } else {
      // Empty-but-HEALTHY board. Keyed on each call's distinctive argument
      // combination; answers carry the jq RESULT (the stub plays gh's built-in
      // jq too), matching what `[]` rows would produce for each query.
      writeStub(
        bin,
        "gh",
        `#!/usr/bin/env bash
args="$*"
case "$args" in
  *"--json updatedAt,headRefName,labels"*)
    # active_dev_orch: '[ ... ] | length' over no rows.
    echo 0; exit 0 ;;
  *"--label enhancement"*)
    # scout_board_open_enhancements: 'length' over no rows.
    echo 0; exit 0 ;;
  *"hydra-betting"*)
    # Target board reads (fallback counts + full board): no rows.
    echo "[]"; exit 0 ;;
  *"--label needs-qa"*)
    # needs_qa_numbers: join over no rows -> empty string.
    echo ""; exit 0 ;;
  *"--label needs-triage"*)
    # orch_needs_triage_items: join over no rows -> empty string.
    echo ""; exit 0 ;;
  *"hitl-grill"*)
    # untriaged_orphans: the exclusion-label list is unique to this jq — the
    # '[ ... ] | length' over no rows is 0.
    echo 0; exit 0 ;;
  *"number,labels,updatedAt"*)
    # orch board-state fallback: zero-count object over no rows.
    echo '{"needs_qa":0,"ready_for_agent":0,"needs_triage":0,"needs_research":0,"in_progress":0,"blocked":0,"stale_in_progress":[],"stale_blocked":[]}'
    exit 0 ;;
  *"arch_sourced"*)
    # ARCH/cleanup board read: zero-count object over no rows.
    echo '{"ready_for_agent":0,"needs_research":0,"needs_triage":0,"arch_sourced":0,"cleanup_sourced":0}'
    exit 0 ;;
  *)
    # grill list, in-flight PRs, blocker lookup, wayfinder, and every other
    # enumeration: no rows, healthy.
    echo "[]"; exit 0 ;;
esac
`,
      );
    }

    // Mimic `curl -sf` on a 404 for every HTTP probe (design-concept lookups,
    // board-state endpoint, eligibility): no body, non-zero exit.
    writeStub(bin, "curl", `#!/usr/bin/env bash\nexit 22\n`);
    // `hydra` CLI down — that is part of the outage shape being modeled.
    writeStub(bin, "hydra", `#!/usr/bin/env bash\nexit 1\n`);
    writeStub(bin, "systemctl", `#!/usr/bin/env bash\necho ""\nexit 0\n`);
    // Redis-side reads succeed (the 2026-08-17 outage was gh-only): empty
    // queues / no timestamps.
    writeStub(
      bin,
      "docker",
      `#!/usr/bin/env bash
case "$*" in
  *LLEN*) echo 0 ;;
  *HGET*) echo 0 ;;
  *) echo "" ;;
esac
exit 0
`,
    );

    const r = spawnSync("bash", [COLLECT_STATE], {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function linesOf(stdout: string): string[] {
  return stdout.split("\n");
}

function readLine(result: CollectResult, key: string): string | undefined {
  return linesOf(result.stdout).find((l) => l.startsWith(`${key}=`));
}

// ---------------------------------------------------------------------------
// decide.py harness (mirrors test/autopilot-decide.test.mts)
// ---------------------------------------------------------------------------

interface Tmp {
  dir: string;
  state: string;
  cands: string;
  events: string;
}

function makeTmp(): Tmp {
  const dir = mkdtempSync(join(tmpdir(), "decide-4130-"));
  return {
    dir,
    state: join(dir, "state.json"),
    cands: join(dir, "cands.json"),
    events: join(dir, "events.json"),
  };
}

function baseState(o: Record<string, unknown> = {}): any {
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
    signal_last_fired: {},
    signals: {},
    research_force_counter: {},
    ...o,
  };
}

function runDecide(state: any, events: any[] = []): any {
  const t = makeTmp();
  try {
    writeFileSync(t.state, JSON.stringify(state));
    writeFileSync(t.cands, "null");
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

function findAction(plan: any, pred: (a: any) => boolean): any | undefined {
  return (plan.actions ?? []).find(pred);
}

// ---------------------------------------------------------------------------
// AC (a) — a failed board read must not emit legitimate 0 / none
// ---------------------------------------------------------------------------

describe("collect-state.sh — failed orch board read is observable, not zero (issue #4130 AC-1/AC-2)", () => {
  test("total gh failure flips orch_board_signals_degraded=true and withholds the board counts", () => {
    const r = runCollectState("fail");
    const flag = readLine(r, "orch_board_signals_degraded");
    assert.ok(flag, "orch_board_signals_degraded line must be emitted unconditionally");
    assert.equal(flag, "orch_board_signals_degraded=true");

    // The board-state fallback must emit NO counts (a zero object here would
    // be the legitimate-looking empty board).
    assert.ok(
      !readLine(r, "ready_for_agent"),
      "a failed orch board read must not emit any board counts line",
    );

    // Failed per-lane reads emit EMPTY values, not zeros/nones.
    assert.equal(readLine(r, "untriaged_orphans"), "untriaged_orphans=");
    assert.equal(readLine(r, "orch_needs_triage_items"), "orch_needs_triage_items=");
    assert.equal(readLine(r, "needs_qa_numbers"), "needs_qa_numbers=");
    assert.equal(readLine(r, "scout_board_open_enhancements"), "scout_board_open_enhancements=");
  });

  test("failed grill-list read WITHHOLDS the anchor picks instead of emitting =none", () => {
    const r = runCollectState("fail");
    // `orch_pending_grill_anchor=none` from a read that never ran is exactly
    // the "legitimate none" hazard — the lines must be absent entirely.
    assert.ok(!readLine(r, "orch_pending_grill_anchor"), "anchor line must be withheld on a failed read");
    assert.ok(!readLine(r, "orch_dev_ready_anchor"), "dev-ready line must be withheld on a failed read");
    assert.ok(
      !readLine(r, "orch_dev_ready_anchor_design_concept_status"),
      "design-concept-status line must be withheld on a failed read",
    );
  });

  test("failed ARCH read fail-closes orch_backfill_idle (never backfill off an unreadable board)", () => {
    const r = runCollectState("fail");
    // The pre-#4130 zero-JSON fallback computed orch_backfill_idle=true from a
    // FAILED read — the inverse hazard. It must now fail closed.
    assert.equal(readLine(r, "orch_backfill_idle"), "orch_backfill_idle=false");
    assert.equal(readLine(r, "arch_board_saturated"), "arch_board_saturated=false");
    assert.equal(readLine(r, "cleanup_board_saturated"), "cleanup_board_saturated=false");
  });

  test("active_dev_orch still renders a parseable integer on failure (test-pinned exception) and flags", () => {
    const r = runCollectState("fail");
    // test/autopilot-dev-orch-gate.test.mts pins that this line is ALWAYS a
    // parseable integer, so a failed read keeps the numeric render — the one
    // documented exception. It is fail-closed-inert (0 = don't block the slot)
    // and the lane flag carries the outage.
    assert.equal(readLine(r, "active_dev_orch"), "active_dev_orch=0");
    assert.equal(readLine(r, "orch_board_signals_degraded"), "orch_board_signals_degraded=true");
  });

  test("target_board_signals_degraded actually flips true when the target reads fail (#4130 AC-2)", () => {
    const r = runCollectState("fail");
    // During the 2026-08-17 outage this flag stayed false (it covered only one
    // read and a LATER successful read overwrote it). It must now flip.
    assert.equal(readLine(r, "target_board_signals_degraded"), "target_board_signals_degraded=true");
    assert.ok(
      !readLine(r, "target_ready_for_agent"),
      "a failed target board read must not emit target_ready_for_agent=0",
    );
  });

  test("failed reads are loud on stderr (fail-loud), not silent", () => {
    const r = runCollectState("fail");
    assert.match(
      r.stderr,
      /collect-state: .*degraded/,
      "each failed board read must log a stderr warning naming the degradation",
    );
  });
});

// ---------------------------------------------------------------------------
// AC (d) — a genuinely empty board behaves exactly as today
// ---------------------------------------------------------------------------

describe("collect-state.sh — genuinely empty board is unchanged (issue #4130 AC-5d)", () => {
  test("healthy empty board: degraded=false, honest zeros, honest nones, backfill idle", () => {
    const r = runCollectState("empty");
    // Healthy read: explicit false, never a missing key.
    assert.equal(readLine(r, "orch_board_signals_degraded"), "orch_board_signals_degraded=false");
    assert.equal(readLine(r, "target_board_signals_degraded"), "target_board_signals_degraded=false");
    // Honest zeros from a successful read (not withheld, not blank).
    assert.equal(readLine(r, "untriaged_orphans"), "untriaged_orphans=0");
    assert.equal(readLine(r, "active_dev_orch"), "active_dev_orch=0");
    assert.equal(readLine(r, "scout_board_open_enhancements"), "scout_board_open_enhancements=0");
    // Honest nones: the candidate loop RAN and found nothing.
    assert.equal(readLine(r, "orch_pending_grill_anchor"), "orch_pending_grill_anchor=none");
    assert.equal(readLine(r, "orch_dev_ready_anchor"), "orch_dev_ready_anchor=none");
    // The board-empty backfill trigger still fires on a genuinely empty board.
    assert.equal(readLine(r, "orch_backfill_idle"), "orch_backfill_idle=true");
  });
});

// ---------------------------------------------------------------------------
// AC (b) — a degraded snapshot must not terminate with cause=idle
// ---------------------------------------------------------------------------

describe("decide.py — degraded snapshot suspends terminate:idle (issue #4130 AC-3/AC-4)", () => {
  test("idle_turns at the drain threshold + degraded flag -> NO terminate, degraded-hold wait", () => {
    const state = baseState({
      idle_turns: 5,
      signals: { orch_board_signals_degraded: true },
    });
    const plan = runDecide(state);
    assert.equal(
      findAction(plan, (a) => a.type === "terminate"),
      undefined,
      "a degraded board read must never produce a clean terminate:idle",
    );
    const wait = findAction(plan, (a) => a.type === "wait");
    assert.ok(wait, "the held turn must still emit a wait action");
    assert.match(
      wait.reason,
      /orch board read degraded/,
      "the wait reason must name the degraded read so it lands in the turn record (AC-4)",
    );
    assert.ok(
      (plan.reasons ?? []).includes("degraded-board-hold"),
      "the plan reason must be the distinct degraded-board-hold marker",
    );
    assert.equal(plan.debug.idle_fallback, "degraded-hold");
    assert.equal(plan.debug.orch_board_degraded_hold, true);
  });

  test("control: same state WITHOUT the flag still terminates idle (unchanged behavior)", () => {
    const state = baseState({ idle_turns: 5 });
    const plan = runDecide(state);
    const term = findAction(plan, (a) => a.type === "terminate");
    assert.ok(term, "a healthy board at the idle threshold must still drain");
    assert.equal(term.cause, "idle");
  });

  test("degraded hold applies to the #1352 wait-only-turn terminate path too", () => {
    // No idle_turns climb needed — the _rule_idle_fallback terminate fires on
    // a wait-only turn with no slots in flight. Degraded must suspend it.
    const state = baseState({
      idle_turns: 0,
      signals: { orch_board_signals_degraded: true },
    });
    const plan = runDecide(state);
    assert.equal(findAction(plan, (a) => a.type === "terminate"), undefined);
    const wait = findAction(plan, (a) => a.type === "wait");
    assert.ok(wait);
    assert.match(wait.reason, /degraded/);
  });

  test("degraded does NOT mask the measured termination causes (budget/wall_clock stay live)", () => {
    const state = baseState({
      cumulative_tokens: 2_000_001,
      signals: { orch_board_signals_degraded: true },
    });
    const plan = runDecide(state);
    const term = findAction(plan, (a) => a.type === "terminate");
    assert.ok(term, "budget exhaustion is measured, not board-inferred — it must still terminate");
    assert.equal(term.cause, "budget");
  });

  test("the flag is read from the event seam too (events take precedence), staying pure", () => {
    // A degraded flag delivered as a signal EVENT (not state.signals) must
    // gate identically — decide.py reads the pre-resolved flag wherever it
    // was merged from, never re-deriving board health.
    const state = baseState({ idle_turns: 5 });
    const plan = runDecide(state, [
      { type: "signal", name: "orch_board_signals_degraded", value: true },
    ]);
    assert.equal(findAction(plan, (a) => a.type === "terminate"), undefined);
  });
});

// ---------------------------------------------------------------------------
// AC (c) — a degraded snapshot must not fire the orch_backfill_idle classes
// ---------------------------------------------------------------------------

describe("decide.py — degraded snapshot suppresses backfill dispatch (issue #4130 AC-3)", () => {
  const BACKFILL_SKILLS = [
    "hydra-discover",
    "hydra-architecture-scan",
    "hydra-cleanup",
    "hydra-skill-prune",
  ];

  test("orch_backfill_idle=true + degraded -> zero backfill dispatches", () => {
    const state = baseState({
      idle_turns: 0, // stay below the idle threshold so dispatch is reachable
      signals: { orch_backfill_idle: true, orch_board_signals_degraded: true },
    });
    const plan = runDecide(state);
    const dispatched = (plan.actions ?? [])
      .filter((a: any) => a.type === "dispatch")
      .map((a: any) => a.skill);
    for (const skill of BACKFILL_SKILLS) {
      assert.ok(
        !dispatched.includes(skill),
        `${skill} must not fire off a board the turn could not read`,
      );
    }
    assert.equal(dispatched.length, 0, "a degraded read must produce no dispatches at all");
  });

  test("control: orch_backfill_idle=true WITHOUT the flag still fires the backfill set", () => {
    const state = baseState({
      idle_turns: 0,
      signals: { orch_backfill_idle: true },
    });
    const plan = runDecide(state);
    const dispatched = (plan.actions ?? [])
      .filter((a: any) => a.type === "dispatch")
      .map((a: any) => a.skill);
    assert.ok(
      dispatched.includes("hydra-discover"),
      "a genuinely empty healthy board must still trigger discovery backfill",
    );
    assert.ok(
      dispatched.includes("hydra-cleanup"),
      "a genuinely empty healthy board must still trigger cleanup backfill",
    );
  });

  test("degraded also suppresses the discover_orch staleness-floor path", () => {
    // #4114 gave discover_orch a second trigger (7d dark floor) that does not
    // read the board signal — it must be held too: the discovery pass itself
    // reads the board to file issues, so firing it mid-outage floods.
    const nowSec = Math.floor(Date.now() / 1000);
    const state = baseState({
      idle_turns: 0,
      signal_last_fired: { discover_orch: nowSec - 8 * 24 * 60 * 60 }, // 8d dark
      signals: { orch_board_signals_degraded: true },
    });
    const plan = runDecide(state);
    const dispatched = (plan.actions ?? [])
      .filter((a: any) => a.type === "dispatch")
      .map((a: any) => a.skill);
    assert.ok(!dispatched.includes("hydra-discover"));
  });
});
