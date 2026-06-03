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
import { readFileSync } from "node:fs";
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
      /printf '%s' "\$ARCH_BOARD_JSON"[\s\S]*?python3 -c "([\s\S]*?)"\s*2>\/dev\/null/,
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
