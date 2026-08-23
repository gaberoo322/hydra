/**
 * Regression tests for the autopilot idle-diagnostics endpoint (issue #889,
 * now-console-2 / PRD #887).
 *
 * Three layers:
 *   1. `deriveBlockedBy` — the pure verdict precedence (no I/O, no clock),
 *      mirroring the Pace Gate's launch-decision order.
 *   2. `estimateNextPaceGateCheck` — the coarse next-check upper-bound.
 *   3. The GET /autopilot/idle-diagnostics route handler — that the verdict,
 *      pace numerics, liveness, never-throw degradation, and 400-on-bad-query
 *      all ride the response and validate against the schema.
 *
 * Follows the test/now-page.test.mts pattern — wires the router with stubbed
 * readers and calls the handler directly. No live Express server, no real
 * Redis, no tracker scan, no on-disk state file.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import {
  createAutopilotIdleRouter,
  deriveBlockedBy,
  estimateNextPaceGateCheck,
  type EligibilityView,
  type AutopilotIdleRouterDeps,
} from "../src/api/autopilot-idle.ts";
import {
  AutopilotIdleDiagnosticsResponseSchema,
  type IdleAutopilotLiveness,
} from "../src/schemas/autopilot-idle.ts";

// Path to the collect-state.sh emitter exercised by the issue #959 block below.
function collectStatePath(): string {
  return join(resolve(import.meta.dirname, ".."), "scripts", "autopilot", "collect-state.sh");
}

// ---------------------------------------------------------------------------
// deriveBlockedBy — pure precedence
// ---------------------------------------------------------------------------

describe("deriveBlockedBy — verdict precedence (issue #889)", () => {
  const base = {
    autopilotAlive: false,
    eligibilityReachable: true,
    emergencyStop: false,
    paceState: "on" as const,
  };

  test("a live run wins over everything → running", () => {
    assert.equal(
      deriveBlockedBy({
        ...base,
        autopilotAlive: true,
        eligibilityReachable: false,
        emergencyStop: true,
        paceState: "ahead",
      }),
      "running",
    );
  });

  test("eligibility unreachable (and no live run) → endpoint-error", () => {
    assert.equal(
      deriveBlockedBy({ ...base, eligibilityReachable: false, emergencyStop: true }),
      "endpoint-error",
    );
  });

  test("emergency-stop beats pacing-ahead", () => {
    assert.equal(
      deriveBlockedBy({ ...base, emergencyStop: true, paceState: "ahead" }),
      "emergency-stop",
    );
  });

  test("pacing-ahead when only ahead of the curve", () => {
    assert.equal(deriveBlockedBy({ ...base, paceState: "ahead" }), "pacing-ahead");
  });

  test("on/behind the curve, calibrated, idle → null (eligible)", () => {
    assert.equal(deriveBlockedBy({ ...base, paceState: "on" }), null);
    assert.equal(deriveBlockedBy({ ...base, paceState: "behind" }), null);
  });
});

// ---------------------------------------------------------------------------
// estimateNextPaceGateCheck — coarse upper bound
// ---------------------------------------------------------------------------

describe("estimateNextPaceGateCheck (issue #889)", () => {
  test("now + interval, as ISO", () => {
    const now = new Date("2026-06-02T12:00:00.000Z");
    assert.equal(
      estimateNextPaceGateCheck(now, 900),
      "2026-06-02T12:15:00.000Z",
    );
  });

  test("non-positive / non-finite interval → null", () => {
    const now = new Date("2026-06-02T12:00:00.000Z");
    assert.equal(estimateNextPaceGateCheck(now, 0), null);
    assert.equal(estimateNextPaceGateCheck(now, -1), null);
    assert.equal(estimateNextPaceGateCheck(now, NaN), null);
  });
});

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

function mockReq(query: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/x", headers: {}, query, params: {}, body: {} };
}
function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
    send(body: any) {
      res._body = body;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}
function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

const ROUTE = "/autopilot/idle-diagnostics";
const NOW = () => new Date("2026-06-02T12:00:00.000Z");

const eligible: EligibilityView = {
  paceState: "on",
  targetPercent: 40,
  sinceResetPercent: 38,
  anchor: "2026-06-01T00:00:00.000Z",
  emergencyStop: false,
  calibrated: true,
  percentLast5h: 22,
};

const idleLiveness: IdleAutopilotLiveness = {
  alive: false,
  state: "idle",
  runId: null,
  termReason: null,
  endedEpoch: null,
};

function buildRouter(overrides: AutopilotIdleRouterDeps = {}) {
  return createAutopilotIdleRouter({
    readEligibility: async () => eligible,
    readAutopilotLiveness: async () => idleLiveness,
    now: NOW,
    paceGateIntervalSeconds: 900,
    ...overrides,
  });
}

async function callRoute(deps: AutopilotIdleRouterDeps = {}, query: Record<string, unknown> = {}) {
  const handler = findHandler(buildRouter(deps), "GET", ROUTE);
  assert.ok(handler, "route handler must exist");
  const res = mockRes();
  await handler!(mockReq(query), res);
  return res;
}

// ---------------------------------------------------------------------------
// Route — verdicts
// ---------------------------------------------------------------------------

describe("GET /autopilot/idle-diagnostics — verdicts (issue #889)", () => {
  test("eligible (on-curve, calibrated, idle) → isEligible=true, blockedBy=null", async () => {
    const res = await callRoute();
    assert.equal(res._status, 200);
    assert.equal(res._body.isEligible, true);
    assert.equal(res._body.blockedBy, null);
    assert.equal(res._body.calibrated, true);
    assert.equal(res._body.emergencyStop, false);
    assert.equal(res._body.percentLast5h, 22);
    assert.equal(res._body.pace.state, "on");
    assert.equal(res._body.pace.targetPercent, 40);
    assert.equal(res._body.pace.sinceResetPercent, 38);
    assert.equal(res._body.pace.anchor, "2026-06-01T00:00:00.000Z");
    assert.equal(res._body.autopilot.alive, false);
    assert.equal(res._body.nextPaceGateCheck, "2026-06-02T12:15:00.000Z");
    assert.equal(
      AutopilotIdleDiagnosticsResponseSchema.safeParse(res._body).success,
      true,
    );
  });

  test("live run → blockedBy=running even when on-curve", async () => {
    const res = await callRoute({
      readAutopilotLiveness: async () => ({
        alive: true,
        state: "running",
        runId: "ap-9",
        termReason: null,
        endedEpoch: null,
      }),
    });
    assert.equal(res._body.isEligible, false);
    assert.equal(res._body.blockedBy, "running");
    assert.equal(res._body.autopilot.state, "running");
    assert.equal(AutopilotIdleDiagnosticsResponseSchema.safeParse(res._body).success, true);
  });

  test("emergency-stop → blockedBy=emergency-stop (beats pacing)", async () => {
    const res = await callRoute({
      readEligibility: async () => ({
        ...eligible,
        emergencyStop: true,
        paceState: "ahead",
        percentLast5h: 93,
      }),
    });
    assert.equal(res._body.blockedBy, "emergency-stop");
    assert.equal(res._body.emergencyStop, true);
    assert.equal(res._body.percentLast5h, 93);
  });

  test("pacing-ahead → blockedBy=pacing-ahead", async () => {
    const res = await callRoute({
      readEligibility: async () => ({ ...eligible, paceState: "ahead", sinceResetPercent: 70 }),
    });
    assert.equal(res._body.blockedBy, "pacing-ahead");
    assert.equal(res._body.pace.state, "ahead");
    assert.equal(res._body.pace.sinceResetPercent, 70);
  });
});

// ---------------------------------------------------------------------------
// Route — never-throw + validation
// ---------------------------------------------------------------------------

describe("GET /autopilot/idle-diagnostics — never-throw + validation (issue #889)", () => {
  test("eligibility reader rejects → blockedBy=endpoint-error, safe pacing defaults, no 500", async () => {
    const res = await callRoute({
      readEligibility: async () => {
        throw new Error("usage tracker exploded");
      },
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.isEligible, false);
    assert.equal(res._body.blockedBy, "endpoint-error");
    assert.equal(res._body.calibrated, false);
    assert.equal(res._body.emergencyStop, false);
    assert.equal(res._body.percentLast5h, 0);
    assert.equal(res._body.pace.state, "on");
    assert.equal(res._body.pace.targetPercent, 0);
    assert.equal(res._body.pace.anchor, null);
    assert.equal(AutopilotIdleDiagnosticsResponseSchema.safeParse(res._body).success, true);
  });

  test("a live run still reported even when eligibility is down (running wins)", async () => {
    const res = await callRoute({
      readEligibility: async () => {
        throw new Error("down");
      },
      readAutopilotLiveness: async () => ({
        alive: true,
        state: "running",
        runId: "ap-x",
        termReason: null,
        endedEpoch: null,
      }),
    });
    assert.equal(res._body.blockedBy, "running");
  });

  test("liveness reader rejects → degrades to idle, response still ships", async () => {
    const res = await callRoute({
      readAutopilotLiveness: async () => {
        throw new Error("redis down");
      },
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.autopilot.state, "idle");
    assert.equal(res._body.autopilot.alive, false);
    // eligibility still reachable + on-curve → eligible
    assert.equal(res._body.blockedBy, null);
    assert.equal(AutopilotIdleDiagnosticsResponseSchema.safeParse(res._body).success, true);
  });

  test("unknown query key → 400 schema-validation-failed", async () => {
    const res = await callRoute({}, { forse: "1" });
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues));
  });

  test("empty query → 200 (no required params)", async () => {
    const res = await callRoute({}, {});
    assert.equal(res._status, 200);
  });

  test("non-finite interval → nextPaceGateCheck null but response valid", async () => {
    const res = await callRoute({ paceGateIntervalSeconds: 0 });
    assert.equal(res._body.nextPaceGateCheck, null);
    assert.equal(AutopilotIdleDiagnosticsResponseSchema.safeParse(res._body).success, true);
  });
});

// ---------------------------------------------------------------------------
// collect-state.sh — the unified orch_backfill_idle board-idle signal
// (issue #959, epic #958)
// ---------------------------------------------------------------------------
//
// The autopilot's board-idle BACKFILL trigger is produced by
// scripts/autopilot/collect-state.sh, which emits a single canonical
// `orch_backfill_idle` state line (true iff the orchestrator board is empty
// of actionable work). decide.py consumes it as a precomputed signal and
// never recomputes board-empty itself (the signal-seam discipline). This
// block pins the EMISSION predicate: orch_backfill_idle is true iff
// ready_for_agent == 0 AND needs_research == 0 AND needs_triage == 0 AND
// work_queue == 0 — and false the moment any of the four is non-zero.
//
// We extract and run the exact python emitter the shell script ships (rather
// than a drift-prone copy), mirroring test/autopilot-arch-fallback-signals.
// ---------------------------------------------------------------------------

describe("collect-state.sh — unified orch_backfill_idle signal (issue #959)", () => {
  const COLLECT_STATE = collectStatePath();
  const collectSrc = readFileSync(COLLECT_STATE, "utf-8");

  function extractBackfillEmitter(): string {
    const match = collectSrc.match(
      /printf '%s' "\$ARCH_BOARD_JSON"[\s\S]*?python3 -c "\$\(cat <<'PY'([\s\S]*?)\nPY\n\)"\s*2>\/dev\/null/,
    );
    assert.ok(match, "could not locate the board-idle emitter python block in collect-state.sh");
    return match![1];
  }

  function runEmitter(board: Record<string, number>, workQueue = "0"): string[] {
    const r = spawnSync("python3", ["-c", extractBackfillEmitter()], {
      input: JSON.stringify(board),
      encoding: "utf-8",
      env: { ...process.env, ARCH_WORK_QUEUE: workQueue, ARCH_BOARD_SATURATION_CAP: "6" },
    });
    assert.equal(r.status, 0, `emitter exited non-zero: ${r.stderr}`);
    return (r.stdout ?? "").trim().split("\n");
  }

  test("emits orch_backfill_idle as the single canonical board-idle line", () => {
    assert.match(collectSrc, /orch_backfill_idle=/);
    // The pre-#959 name must be gone from the emit (no dual emission).
    assert.doesNotMatch(collectSrc, /print\('arch_fallback_due=/);
  });

  test("orch_backfill_idle=true iff all four actionable counts are zero", () => {
    const out = runEmitter(
      { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 0 },
      "0",
    );
    assert.ok(out.includes("orch_backfill_idle=true"), "fully-idle board → true");
  });

  test("orch_backfill_idle=false when work_queue is non-empty", () => {
    const out = runEmitter(
      { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 0 },
      "2",
    );
    assert.ok(out.includes("orch_backfill_idle=false"), "non-empty work-queue → false");
  });

  test("orch_backfill_idle=false when any actionable label count is non-zero", () => {
    for (const label of ["ready_for_agent", "needs_research", "needs_triage"]) {
      const board = { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 0 };
      (board as Record<string, number>)[label] = 1;
      const out = runEmitter(board, "0");
      assert.ok(
        out.includes("orch_backfill_idle=false"),
        `non-zero ${label} must suppress orch_backfill_idle`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// collect-state.sh — lane board-read degradation flags (issue #4130,
// design-concept issue-4130)
// ---------------------------------------------------------------------------
//
// A GraphQL-only GitHub outage makes every `gh ... --json` board read fail;
// the `|| echo 0` / `|| true` guards then emit legitimate-LOOKING zeros and
// decide.py read that as "no work" — the run drained to a clean
// terminate:idle and fired backfill classes against a full board. Issue
// #4130 adds one degraded flag per lane, OR-composed across every gh call
// in the lane (INV-4), set ONLY by a nonzero gh exit code (INV-2 — a
// genuinely empty board never degrades), and makes orch_backfill_idle fail
// CLOSED on a failed arch read (INV-5) so no backfill class fires off a
// zeroed payload.
//
// Like the #959 block above, these tests pin the EMISSION side: the flag
// plumbing in the shell source and the exact python emitter the script
// ships (never a drift-prone copy).
// ---------------------------------------------------------------------------

describe("collect-state.sh — lane board-read degradation flags (issue #4130)", () => {
  const COLLECT_STATE = collectStatePath();
  const collectSrc = readFileSync(COLLECT_STATE, "utf-8");

  test("both lane flags are initialised and emitted via the echo key=value convention", () => {
    // INV-8: plain echo lines the playbook merges into state.signals — no new
    // plumbing module. Each flag is emitted exactly once, after the last gh
    // read of its own lane (orch at end-of-script, target at the Target board
    // block).
    assert.match(collectSrc, /^ORCH_BOARD_DEGRADED=false$/m);
    assert.match(collectSrc, /^TARGET_BOARD_DEGRADED=false$/m);
    assert.match(collectSrc, /echo "orch_board_signals_degraded=\$ORCH_BOARD_DEGRADED"/);
    assert.match(collectSrc, /echo "target_board_signals_degraded=\$TARGET_BOARD_DEGRADED"/);
    assert.equal(
      collectSrc.match(/echo "orch_board_signals_degraded=/g)?.length,
      1,
      "orch flag must have exactly ONE emission site",
    );
  });

  test("every orch-lane gh board read flips the flag on failure (ratchet: 13 known sites)", () => {
    // INV-4: one failed call degrades the whole lane's turn signal. The 13
    // known orch-lane gh reads are: board-state fallback, needs-triage item
    // set, untriaged orphans, needs-qa numbers, inflight PRs, grill list,
    // open-blocker lookup, active_dev_orch, scout enhancements, the arch
    // board read, wayfinder maps, per-map graphql, and the tickets read. A
    // 14th `gh` read added WITHOUT a flag flip must update this count
    // consciously — that is the point of the ratchet (the design concept's
    // rejected-alternative-2 concern, answered in test form).
    const flips = collectSrc.match(/ORCH_BOARD_DEGRADED=true/g)?.length ?? 0;
    assert.ok(
      flips >= 13,
      `expected >= 13 orch-lane degraded flips (one per gh board read), found ${flips}`,
    );
    // Target lane: the board-state fallback, the board read, and the
    // degraded else branch (which sets the aggregate for its own emission).
    const targetFlips = collectSrc.match(/TARGET_BOARD_DEGRADED=true/g)?.length ?? 0;
    assert.ok(
      targetFlips >= 3,
      `expected >= 3 target-lane degraded flips, found ${targetFlips}`,
    );
  });

  test("a failed target board-state fallback read flips the target flag while still emitting zeros", () => {
    // The observed outage shape: the endpoint is down AND the direct REST
    // fallback fails. The four counts still fail open to zero (the #3709
    // contract) but the read is marked UNREAD (INV-4).
    assert.match(
      collectSrc,
      /\{ echo "target_ready_for_agent=0"; echo "target_needs_qa=0"; echo "target_needs_triage=0"; echo "target_needs_research=0"; \}/,
    );
    assert.match(collectSrc, /TARGET_FALLBACK_LINES=[\s\S]{0,900}?\|\| TARGET_BOARD_DEGRADED=true/);
  });

  // The arch emitter, extracted exactly as the #959 block above does, so the
  // INV-5 fail-close is exercised against the shipped python.
  function extractArchEmitter(): string {
    const match = collectSrc.match(
      /printf '%s' "\$ARCH_BOARD_JSON"[\s\S]*?python3 -c "\$\(cat <<'PY'([\s\S]*?)\nPY\n\)"\s*2>\/dev\/null/,
    );
    assert.ok(match, "could not locate the arch emitter python block in collect-state.sh");
    return match![1];
  }

  function runArchEmitter(
    board: Record<string, number>,
    env: Record<string, string>,
  ): string[] {
    const r = spawnSync("python3", ["-c", extractArchEmitter()], {
      input: JSON.stringify(board),
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    assert.equal(r.status, 0, `arch emitter exited non-zero: ${r.stderr}`);
    return (r.stdout ?? "").trim().split("\n");
  }

  test("INV-5: a degraded arch read fails CLOSED — orch_backfill_idle=false even on an all-zero board", () => {
    // The exact hazard: gh failed, the zeroed fallback JSON fed the emitter,
    // and the all-counts-zero conjunction fabricated idle=true. With
    // ARCH_READ_DEGRADED=true the emitter must emit false.
    const out = runArchEmitter(
      { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 0 },
      { ARCH_WORK_QUEUE: "0", ARCH_READ_DEGRADED: "true" },
    );
    assert.ok(
      out.includes("orch_backfill_idle=false"),
      "a read that never happened must not render as a board-empty conjunction",
    );
  });

  test("INV-2: a genuinely empty board (no degraded flag) still emits orch_backfill_idle=true", () => {
    // The required regression case, not incidental: same zeros + work queue,
    // but the read SUCCEEDED — the flag is absent and idle must fire exactly
    // as before #4130.
    const out = runArchEmitter(
      { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 0 },
      { ARCH_WORK_QUEUE: "0" },
    );
    assert.ok(out.includes("orch_backfill_idle=true"));
  });

  test("a non-empty work queue keeps idle=false even under degradation (fail-closed, both ways)", () => {
    const out = runArchEmitter(
      { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 0 },
      { ARCH_WORK_QUEUE: "2", ARCH_READ_DEGRADED: "true" },
    );
    assert.ok(out.includes("orch_backfill_idle=false"));
  });
});

// ---------------------------------------------------------------------------
// decide.py — a degraded board read must not conclude idle (issue #4130)
// ---------------------------------------------------------------------------
//
// The decide-side half of #4130: the two idle conclusions — _check_termination's
// idle_drain_turns cap and _rule_idle_fallback's immediate #1352 drain — are
// suppressed while EITHER lane's degraded flag is set (INV-6: idle_turns is a
// single global counter fed by both lanes), and the suppressed turn emits a
// degraded-marked heartbeat wait so the condition is visible in the turn
// record (AC: turn record/heartbeat visibility). A genuinely empty board
// keeps today's behaviour exactly (INV-3).
// ---------------------------------------------------------------------------

describe("decide.py — degraded board read must not conclude idle (issue #4130)", () => {
  const REPO_ROOT = resolve(import.meta.dirname, "..");
  const DECIDE = join(REPO_ROOT, "scripts", "autopilot", "decide.py");

  function baseState(signals: Record<string, unknown>, idleTurns = 0): Record<string, unknown> {
    // 2h-ago stamps: older than the 1h class cooldowns (so the idle arm of
    // each backfill class is eligible) but younger than discover_orch's 7d
    // staleness floor (so the FLOOR arm — which is deliberately not
    // degraded-gated — cannot fire and mask the behaviour under test).
    const cooledNotDark = Math.floor(Date.now() / 1000) - 7_200;
    return {
      started_epoch: Math.floor(Date.now() / 1000),
      limits: { token_budget: 2_000_000, wall_clock_max_sec: 28_800, idle_drain_turns: 5, scope: "all" },
      cumulative_tokens: 0,
      dispatches: 0,
      idle_turns: idleTurns,
      turn: 1,
      burned_classes: [],
      reaped_task_ids: [],
      failure_log: [],
      slots: {
        dev_orch: null, qa_orch: null, research_orch: null,
        dev_target: null, qa_target: null, research_target: null,
        design_concept_orch: null,
      },
      signal_last_fired: {
        sweep_orch: cooledNotDark,
        sweep_target: cooledNotDark,
        discover_orch: cooledNotDark,
        discover_target: cooledNotDark,
        architecture_orch: cooledNotDark,
        cleanup_orch: cooledNotDark,
      },
      signals,
      research_force_counter: {},
    };
  }

  function runDecide(state: Record<string, unknown>): any {
    const dir = mkdtempSync(join(tmpdir(), "decide-board-degraded-"));
    const statePath = join(dir, "state.json");
    const candsPath = join(dir, "candidates.json");
    const eventsPath = join(dir, "events.json");
    try {
      writeFileSync(statePath, JSON.stringify(state));
      writeFileSync(candsPath, JSON.stringify(null));
      writeFileSync(eventsPath, JSON.stringify([]));
      const r = spawnSync("python3", [DECIDE, "decide", statePath, candsPath, eventsPath], {
        encoding: "utf-8",
      });
      assert.equal(r.status, 0, `decide.py decide exited ${r.status}: ${r.stderr}`);
      return JSON.parse(r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const terminate = (plan: any) =>
    (plan.actions ?? []).find((a: any) => a.type === "terminate");

  test("AC(d): a genuinely empty board still terminates cause=idle on a wait-only turn", () => {
    // No signals, no candidates, no slots in flight, no degraded flag — the
    // #1352 clean idle drain, byte-for-byte today's behaviour.
    const plan = runDecide(baseState({}));
    const term = terminate(plan);
    assert.ok(term, "a genuinely quiet board must still end the run");
    assert.equal(term.cause, "idle");
    assert.equal(plan.debug?.idle_fallback, "terminate");
  });

  test("AC(d): a genuinely empty board still terminates cause=idle via the idle_drain_turns cap", () => {
    // idle_turns past the cap with nothing in flight — the OTHER idle
    // conclusion, in _check_termination.
    const plan = runDecide(baseState({}, 5));
    const term = terminate(plan);
    assert.ok(term, "idle_turns >= idle_drain_turns with no slots must still terminate");
    assert.equal(term.cause, "idle");
    assert.equal(term.reason, "idle_turns=5");
  });

  test("AC(3): a degraded ORCH read suppresses the immediate idle drain", () => {
    const plan = runDecide(
      baseState({ orch_board_signals_degraded: true }),
    );
    const term = terminate(plan);
    assert.equal(term, undefined, "must not terminate with cause idle on a degraded snapshot");
    const wait = (plan.actions ?? []).find((a: any) => a.type === "wait");
    assert.ok(wait, "the suppressed turn must emit the heartbeat wait instead");
    assert.ok(
      (plan.reasons ?? []).includes("heartbeat:board-degraded"),
      "the wait must carry the degraded reason so the turn record shows WHY",
    );
    assert.equal(plan.debug?.board_signals_degraded, true);
    assert.equal(plan.debug?.idle_fallback, "deferred-board-degraded");
  });

  test("INV-6: a degraded TARGET read alone also suppresses idle (either lane)", () => {
    // idle_turns is a single global counter fed by both lanes — a target-only
    // outage must not let the run drain to a clean idle either.
    const plan = runDecide(
      baseState({ target_board_signals_degraded: true }, 5),
    );
    const term = terminate(plan);
    assert.equal(term, undefined, "target-lane degradation must suppress the idle terminate too");
    assert.ok(
      (plan.reasons ?? []).includes("heartbeat:board-degraded"),
      "the deferred heartbeat must be marked degraded",
    );
  });

  test("AC(3): degradation suppresses the idle_drain_turns cap terminate as well", () => {
    const plan = runDecide(
      baseState({ orch_board_signals_degraded: true }, 5),
    );
    const term = terminate(plan);
    assert.equal(
      term,
      undefined,
      "idle >= idle_drain_turns must not terminate while the board read failed",
    );
    const wait = (plan.actions ?? []).find((a: any) => a.type === "wait");
    assert.ok(wait);
  });

  test("suppression is not forever: wall_clock still bounds a degraded run", () => {
    // The guard defers, it does not immortalise — elapsed past wall_clock_max
    // still terminates (under its own, more diagnostic cause).
    const state: Record<string, unknown> = {
      ...baseState({ orch_board_signals_degraded: true }, 5),
      started_epoch: Math.floor(Date.now() / 1000) - 29_000,
    };
    const plan = runDecide(state);
    const term = terminate(plan);
    assert.ok(term, "wall_clock must still end a degraded run");
    assert.equal(term.cause, "wall_clock");
  });
});
