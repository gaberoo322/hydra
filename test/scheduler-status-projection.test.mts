/**
 * Unit tests for the `buildSchedulerStatus` free function (issue #2935).
 *
 * Before this extraction, the status-projection logic (advisory reads, field
 * assembly, lifetime-vs-rolling fallback) lived inside `HeartbeatController.getStatus()`,
 * which required a full 13-dep controller fixture to test. These tests exercise
 * the projection through the exported `buildSchedulerStatus` surface directly
 * — no Redis, no timer, no controller constructor.
 *
 * AC2 (issue #2935): the status-projection can be unit-tested through the
 * `buildSchedulerStatus` surface without constructing a `HeartbeatController`
 * with all its deps.
 *
 * No Redis is required by this suite. It uses only:
 *   - The exported `buildSchedulerStatus` / `SchedulerStatus` from heartbeat.ts
 *   - Plain in-memory stubs for the advisory readers and rate deps
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Import the free function + types under test.
// We need no Redis or timer setup — buildSchedulerStatus is a pure-ish async
// function that accepts all its I/O as injectable arguments.
const { buildSchedulerStatus } = await import("../src/scheduler/heartbeat.ts");

// ---------------------------------------------------------------------------
// Helpers — plain stub builders
// ---------------------------------------------------------------------------

/** Minimal state snapshot — callers override individual fields as needed. */
function makeState(overrides: Partial<Parameters<typeof buildSchedulerStatus>[0]> = {}): Parameters<typeof buildSchedulerStatus>[0] {
  return {
    running: false,
    stopReason: null,
    deliberateStoppedAt: null,
    intervalMs: 300_000,
    cyclesRun: 10,
    cyclesMerged: 7,
    cyclesFailed: 2,
    cyclesUnaccounted: 1,
    lastTickAt: null,
    lastError: null,
    startedAt: null,
    consecutiveErrors: 0,
    ...overrides,
  };
}

/** Minimal rate data — callers override as needed. */
function makeRates(overrides: Partial<Parameters<typeof buildSchedulerStatus>[1]> = {}): Parameters<typeof buildSchedulerStatus>[1] {
  return {
    rolling: { mergeRate: null, cyclesInWindow: 0 },
    emptyRolling: { emptyRate: null, cyclesInWindow: 0 },
    mergeRateWindow: 50,
    emptyRateWindow: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("buildSchedulerStatus — projection without controller (issue #2935 AC2)", () => {

  // -------------------------------------------------------------------------
  // AC1: SchedulerStatus fields are structurally correct
  // -------------------------------------------------------------------------

  test("returns all required SchedulerStatus fields", async () => {
    const status = await buildSchedulerStatus(makeState(), makeRates(), {
      getAutopilotPaused: async () => ({ paused: false }),
      getReconcilerHealth: async () => null,
    });

    // Lifecycle counters
    assert.ok("running" in status, "must have running");
    assert.ok("cyclesRun" in status, "must have cyclesRun");
    assert.ok("cyclesMerged" in status, "must have cyclesMerged");
    assert.ok("cyclesFailed" in status, "must have cyclesFailed");
    assert.ok("cyclesUnaccounted" in status, "must have cyclesUnaccounted");
    assert.ok("stopReason" in status, "must have stopReason");
    assert.ok("deliberateStoppedAt" in status, "must have deliberateStoppedAt");
    assert.ok("intervalMs" in status, "must have intervalMs");
    assert.ok("intervalHuman" in status, "must have intervalHuman");
    assert.ok("lastTickAt" in status, "must have lastTickAt");
    assert.ok("lastError" in status, "must have lastError");
    assert.ok("startedAt" in status, "must have startedAt");
    assert.ok("consecutiveErrors" in status, "must have consecutiveErrors");

    // Rate fields
    assert.ok("mergeRate" in status, "must have mergeRate");
    assert.ok("mergeRateWindow" in status, "must have mergeRateWindow");
    assert.ok("mergeRateCyclesInWindow" in status, "must have mergeRateCyclesInWindow");
    assert.ok("mergeRateLifetime" in status, "must have mergeRateLifetime");
    assert.ok("emptyRate" in status, "must have emptyRate");
    assert.ok("emptyRateWindow" in status, "must have emptyRateWindow");
    assert.ok("emptyRateCyclesInWindow" in status, "must have emptyRateCyclesInWindow");

    // Indexer observability
    assert.ok("indexerErrors" in status, "must have indexerErrors");
    assert.ok("indexerRetries" in status, "must have indexerRetries");

    // Advisory cross-subsystem
    assert.ok("autopilotPause" in status, "must have autopilotPause");
    assert.ok("reconciler" in status, "must have reconciler");
  });

  // -------------------------------------------------------------------------
  // AC2: mergeRate falls back to lifetime when no rolling history
  // -------------------------------------------------------------------------

  test("mergeRate falls back to lifetime ratio when rolling history is empty", async () => {
    const status = await buildSchedulerStatus(
      makeState({ cyclesRun: 10, cyclesMerged: 7 }),
      makeRates({ rolling: { mergeRate: null, cyclesInWindow: 0 } }),
      {
        getAutopilotPaused: async () => ({ paused: false }),
        getReconcilerHealth: async () => null,
      },
    );
    // 7/10 = 70%
    assert.equal(status.mergeRate, 70, "mergeRate should be lifetime 70% when rolling is null");
    assert.equal(status.mergeRateLifetime, 70);
    assert.equal(status.mergeRateCyclesInWindow, 0);
  });

  // -------------------------------------------------------------------------
  // AC3: rolling rate wins over lifetime when history is available
  // -------------------------------------------------------------------------

  test("mergeRate uses rolling rate when rolling history is available", async () => {
    const status = await buildSchedulerStatus(
      makeState({ cyclesRun: 384, cyclesMerged: 7 }), // lifetime: 7/384 ≈ 2%
      makeRates({ rolling: { mergeRate: 80, cyclesInWindow: 10 } }),
      {
        getAutopilotPaused: async () => ({ paused: false }),
        getReconcilerHealth: async () => null,
      },
    );
    assert.equal(status.mergeRate, 80, "mergeRate should reflect recent 80%, not lifetime ~2%");
    assert.equal(status.mergeRateCyclesInWindow, 10);
    // Lifetime is preserved separately
    assert.ok(status.mergeRateLifetime < 5, "lifetime should be low (~2%)");
  });

  // -------------------------------------------------------------------------
  // AC4: advisory reads are injectable (status-projection testable standalone)
  // -------------------------------------------------------------------------

  test("autopilotPause and reconciler come from injected deps", async () => {
    const fakeReconciler = {
      ranAt: "2026-07-06T00:00:00.000Z",
      durationMs: 1234,
      prsFound: 5,
      itemsMoved: 3,
      errors: [],
      feedsChecked: ["merged", "closed"],
    };

    const status = await buildSchedulerStatus(
      makeState(),
      makeRates(),
      {
        getAutopilotPaused: async () => ({ paused: true, since: 1751000000 }),
        getReconcilerHealth: async () => fakeReconciler as any,
      },
    );

    assert.equal(status.autopilotPause.paused, true, "should surface injected autopilot-pause");
    assert.equal((status.autopilotPause as any).since, 1751000000);
    assert.deepEqual(status.reconciler, fakeReconciler, "should surface injected reconciler record");
  });

  // -------------------------------------------------------------------------
  // AC5: advisory read failures degrade to safe defaults (fail-safe)
  // -------------------------------------------------------------------------

  test("autopilot-pause failure degrades to {paused:false}", async () => {
    const status = await buildSchedulerStatus(
      makeState(),
      makeRates(),
      {
        getAutopilotPaused: async () => { throw new Error("Redis unreachable"); },
        getReconcilerHealth: async () => null,
      },
    );
    assert.deepEqual(status.autopilotPause, { paused: false },
      "should degrade to not-paused on autopilot-pause read failure");
  });

  test("reconciler-health failure degrades to null", async () => {
    const status = await buildSchedulerStatus(
      makeState(),
      makeRates(),
      {
        getAutopilotPaused: async () => ({ paused: false }),
        getReconcilerHealth: async () => { throw new Error("Redis unreachable"); },
      },
    );
    assert.equal(status.reconciler, null,
      "should degrade to null on reconciler-health read failure");
  });

  // -------------------------------------------------------------------------
  // AC6: intervalHuman is formatted correctly
  // -------------------------------------------------------------------------

  test("intervalHuman formats duration from intervalMs", async () => {
    const status5m = await buildSchedulerStatus(
      makeState({ intervalMs: 5 * 60 * 1000 }),
      makeRates(),
      { getAutopilotPaused: async () => ({ paused: false }), getReconcilerHealth: async () => null },
    );
    assert.equal(status5m.intervalHuman, "5m", "5 minutes should format as '5m'");

    const status30s = await buildSchedulerStatus(
      makeState({ intervalMs: 30_000 }),
      makeRates(),
      { getAutopilotPaused: async () => ({ paused: false }), getReconcilerHealth: async () => null },
    );
    assert.equal(status30s.intervalHuman, "30s", "30 seconds should format as '30s'");

    const statusNull = await buildSchedulerStatus(
      makeState({ intervalMs: 0 }),
      makeRates(),
      { getAutopilotPaused: async () => ({ paused: false }), getReconcilerHealth: async () => null },
    );
    assert.equal(statusNull.intervalHuman, null, "zero intervalMs should yield null intervalHuman");
  });

  // -------------------------------------------------------------------------
  // AC7: emptyRate is surfaced from injected rates
  // -------------------------------------------------------------------------

  test("emptyRate is surfaced from the rates argument", async () => {
    const status = await buildSchedulerStatus(
      makeState(),
      makeRates({ emptyRolling: { emptyRate: 0.25, cyclesInWindow: 20 } }),
      { getAutopilotPaused: async () => ({ paused: false }), getReconcilerHealth: async () => null },
    );
    assert.equal(status.emptyRate, 0.25, "emptyRate should be forwarded from rates");
    assert.equal(status.emptyRateCyclesInWindow, 20);
  });

  test("emptyRate is null when no rolling history", async () => {
    const status = await buildSchedulerStatus(
      makeState(),
      makeRates({ emptyRolling: { emptyRate: null, cyclesInWindow: 0 } }),
      { getAutopilotPaused: async () => ({ paused: false }), getReconcilerHealth: async () => null },
    );
    assert.equal(status.emptyRate, null, "emptyRate should be null when no history");
  });

  // -------------------------------------------------------------------------
  // AC8: lifecycle counter fields are passed through correctly
  // -------------------------------------------------------------------------

  test("lifecycle fields are passed through from the state snapshot", async () => {
    const state = makeState({
      running: true,
      stopReason: "circuit-breaker",
      cyclesRun: 42,
      cyclesMerged: 30,
      cyclesFailed: 8,
      cyclesUnaccounted: 4,
      lastTickAt: "2026-07-06T10:00:00.000Z",
      lastError: "timeout",
      startedAt: "2026-07-06T09:00:00.000Z",
      consecutiveErrors: 3,
    });

    const status = await buildSchedulerStatus(state, makeRates(), {
      getAutopilotPaused: async () => ({ paused: false }),
      getReconcilerHealth: async () => null,
    });

    assert.equal(status.running, true);
    assert.equal(status.stopReason, "circuit-breaker");
    assert.equal(status.cyclesRun, 42);
    assert.equal(status.cyclesMerged, 30);
    assert.equal(status.cyclesFailed, 8);
    assert.equal(status.cyclesUnaccounted, 4);
    assert.equal(status.lastTickAt, "2026-07-06T10:00:00.000Z");
    assert.equal(status.lastError, "timeout");
    assert.equal(status.startedAt, "2026-07-06T09:00:00.000Z");
    assert.equal(status.consecutiveErrors, 3);
  });
});
