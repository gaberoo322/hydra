/**
 * Zero-IO composition tests for the idle-diagnostics aggregator leaf
 * (issue #3116, arch-scan #788).
 *
 * These exercise `getIdleDiagnostics` DIRECTLY — no Express Router, no
 * supertest, no mockReq/mockRes. The response is constructed purely from
 * injected stub readers + a fixed clock, which is the structural proof the
 * leaf is zero-IO: it composes only what its `deps` bag hands it.
 *
 * This is the layer that PR #3118 first shipped without, causing a QA FAIL —
 * the route-level supertest cases (in test/autopilot-idle.test.mts) prove the
 * thin adapter + aggregatorRoute wiring; THIS file proves the pure composition
 * independently, including the load-bearing rejected-eligibility →
 * endpoint-error case that must NOT collapse through settledOrNull.
 *
 * Authored as a NEW top-level describe (not nested under a sibling teardown),
 * per the CLAUDE.md authoring rule.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getIdleDiagnostics,
  deriveBlockedBy,
  estimateNextPaceGateCheck,
  IDLE_LIVENESS_DEFAULT,
  type IdleDiagnosticsDeps,
} from "../src/aggregators/autopilot-idle.ts";
import {
  AutopilotIdleDiagnosticsResponseSchema,
  type IdleAutopilotLiveness,
} from "../src/schemas/autopilot-idle.ts";
import type { EligibilityView } from "../src/cost/index.ts";

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

function deps(overrides: Partial<IdleDiagnosticsDeps> = {}): IdleDiagnosticsDeps {
  return {
    readEligibility: async () => eligible,
    readAutopilotLiveness: async () => idleLiveness,
    now: NOW,
    paceGateIntervalSeconds: 900,
    ...overrides,
  };
}

describe("getIdleDiagnostics — pure composition (issue #3116)", () => {
  test("eligible (on-curve, calibrated, idle) → isEligible=true, blockedBy=null", async () => {
    const r = await getIdleDiagnostics(deps());
    assert.equal(r.isEligible, true);
    assert.equal(r.blockedBy, null);
    assert.equal(r.calibrated, true);
    assert.equal(r.emergencyStop, false);
    assert.equal(r.percentLast5h, 22);
    assert.equal(r.pace.state, "on");
    assert.equal(r.pace.targetPercent, 40);
    assert.equal(r.pace.sinceResetPercent, 38);
    assert.equal(r.pace.anchor, "2026-06-01T00:00:00.000Z");
    assert.equal(r.autopilot.alive, false);
    assert.equal(r.nextPaceGateCheck, "2026-06-02T12:15:00.000Z");
    assert.equal(r.generatedAt, "2026-06-02T12:00:00.000Z");
    assert.equal(AutopilotIdleDiagnosticsResponseSchema.safeParse(r).success, true);
  });

  test("a live run wins over everything → blockedBy=running", async () => {
    const r = await getIdleDiagnostics(
      deps({
        readAutopilotLiveness: async () => ({
          alive: true,
          state: "running",
          runId: "ap-9",
          termReason: null,
          endedEpoch: null,
        }),
      }),
    );
    assert.equal(r.isEligible, false);
    assert.equal(r.blockedBy, "running");
    assert.equal(r.autopilot.state, "running");
    assert.equal(AutopilotIdleDiagnosticsResponseSchema.safeParse(r).success, true);
  });

  test("emergency-stop beats pacing-ahead → blockedBy=emergency-stop", async () => {
    const r = await getIdleDiagnostics(
      deps({
        readEligibility: async () => ({
          ...eligible,
          emergencyStop: true,
          paceState: "ahead",
          percentLast5h: 93,
        }),
      }),
    );
    assert.equal(r.blockedBy, "emergency-stop");
    assert.equal(r.emergencyStop, true);
    assert.equal(r.percentLast5h, 93);
  });

  test("pacing-ahead → blockedBy=pacing-ahead", async () => {
    const r = await getIdleDiagnostics(
      deps({
        readEligibility: async () => ({
          ...eligible,
          paceState: "ahead",
          sinceResetPercent: 70,
        }),
      }),
    );
    assert.equal(r.blockedBy, "pacing-ahead");
    assert.equal(r.pace.state, "ahead");
    assert.equal(r.pace.sinceResetPercent, 70);
  });

  // ---- The load-bearing hazard: rejected eligibility must NOT collapse. ----

  test("eligibility reader REJECTS → blockedBy=endpoint-error, neutral pacing defaults, never throws", async () => {
    const r = await getIdleDiagnostics(
      deps({
        readEligibility: async () => {
          throw new Error("usage tracker exploded");
        },
      }),
    );
    assert.equal(r.isEligible, false);
    assert.equal(r.blockedBy, "endpoint-error");
    assert.equal(r.calibrated, false);
    assert.equal(r.emergencyStop, false);
    assert.equal(r.percentLast5h, 0);
    assert.equal(r.pace.state, "on");
    assert.equal(r.pace.targetPercent, 0);
    assert.equal(r.pace.sinceResetPercent, 0);
    assert.equal(r.pace.anchor, null);
    assert.equal(AutopilotIdleDiagnosticsResponseSchema.safeParse(r).success, true);
  });

  test("a live run still reported when eligibility is down (running beats endpoint-error)", async () => {
    const r = await getIdleDiagnostics(
      deps({
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
      }),
    );
    assert.equal(r.blockedBy, "running");
  });

  test("liveness reader REJECTS → degrades to idle default, response still ships eligible", async () => {
    const r = await getIdleDiagnostics(
      deps({
        readAutopilotLiveness: async () => {
          throw new Error("redis down");
        },
      }),
    );
    assert.deepEqual(r.autopilot, IDLE_LIVENESS_DEFAULT);
    assert.equal(r.autopilot.state, "idle");
    assert.equal(r.autopilot.alive, false);
    // eligibility still reachable + on-curve → eligible
    assert.equal(r.blockedBy, null);
    assert.equal(AutopilotIdleDiagnosticsResponseSchema.safeParse(r).success, true);
  });

  test("BOTH readers reject → endpoint-error (eligibility down) + idle liveness, still valid", async () => {
    const r = await getIdleDiagnostics(
      deps({
        readEligibility: async () => {
          throw new Error("elig down");
        },
        readAutopilotLiveness: async () => {
          throw new Error("live down");
        },
      }),
    );
    assert.equal(r.blockedBy, "endpoint-error");
    assert.deepEqual(r.autopilot, IDLE_LIVENESS_DEFAULT);
    assert.equal(AutopilotIdleDiagnosticsResponseSchema.safeParse(r).success, true);
  });

  test("non-finite interval → nextPaceGateCheck=null but response valid", async () => {
    const r = await getIdleDiagnostics(deps({ paceGateIntervalSeconds: 0 }));
    assert.equal(r.nextPaceGateCheck, null);
    assert.equal(AutopilotIdleDiagnosticsResponseSchema.safeParse(r).success, true);
  });

  test("clock is injected — generatedAt + nextPaceGateCheck derive purely from now()", async () => {
    const fixed = () => new Date("2030-01-01T00:00:00.000Z");
    const r = await getIdleDiagnostics(deps({ now: fixed, paceGateIntervalSeconds: 600 }));
    assert.equal(r.generatedAt, "2030-01-01T00:00:00.000Z");
    assert.equal(r.nextPaceGateCheck, "2030-01-01T00:10:00.000Z");
  });
});

// The re-exported pure fns are the same referents the route re-exports — a
// quick sanity that the leaf owns callable definitions.
describe("leaf re-exports the pure primitives (issue #3116)", () => {
  test("deriveBlockedBy precedence: running > endpoint-error > emergency-stop > pacing-ahead > null", () => {
    const base = {
      autopilotAlive: false,
      eligibilityReachable: true,
      emergencyStop: false,
      paceState: "on" as const,
    };
    assert.equal(deriveBlockedBy({ ...base, autopilotAlive: true, eligibilityReachable: false }), "running");
    assert.equal(deriveBlockedBy({ ...base, eligibilityReachable: false, emergencyStop: true }), "endpoint-error");
    assert.equal(deriveBlockedBy({ ...base, emergencyStop: true, paceState: "ahead" }), "emergency-stop");
    assert.equal(deriveBlockedBy({ ...base, paceState: "ahead" }), "pacing-ahead");
    assert.equal(deriveBlockedBy({ ...base }), null);
  });

  test("estimateNextPaceGateCheck: now+interval ISO, null on non-positive", () => {
    const now = new Date("2026-06-02T12:00:00.000Z");
    assert.equal(estimateNextPaceGateCheck(now, 900), "2026-06-02T12:15:00.000Z");
    assert.equal(estimateNextPaceGateCheck(now, 0), null);
    assert.equal(estimateNextPaceGateCheck(now, NaN), null);
  });
});
