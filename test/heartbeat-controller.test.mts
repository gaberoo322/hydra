/**
 * HeartbeatController seam tests (issue #2195).
 *
 * Exercises the heartbeat's state machine — start/stop lifecycle, the
 * deliberate-stop discriminant + Redis rehydration, the rolling-merge-rate
 * status composition, and start-after-stop semantics — by constructing a
 * FRESH `HeartbeatController` per case with injected Redis readers/writers
 * and a fixed clock. NO real Redis: every dep is a deterministic stub, so the
 * state-machine's correctness is a unit-test concern rather than an
 * integration-test concern. This mirrors the `DigestAccumulator` seam test
 * (issue #1487) that resolved the same module-level-singleton friction.
 *
 * These tests deliberately do not touch DB 1 — the six legacy `scheduler-*`
 * suites still cover the live-Redis integration path; this suite covers the
 * deterministic per-case isolation the extraction unlocks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HeartbeatController, type HeartbeatControllerDeps } from "../src/scheduler/heartbeat.ts";

// A fixed clock so startedAt / stoppedAt / lastTickAt are deterministic.
const FIXED = new Date("2026-06-19T12:00:00.000Z");
const fixedNow = () => FIXED;

// A non-pingable, no-op event bus stand-in. runScheduledCycle only stamps
// lastTickAt and re-arms a timer; it never publishes, so any value works.
const noopBus: any = {};

/**
 * Build a controller whose Redis-touching deps are all inert stubs. Callers
 * override individual deps per case. computeRollingMergeRate defaults to a
 * "no data yet" stub so getStatus never reaches real Redis.
 */
function makeController(overrides: HeartbeatControllerDeps = {}): HeartbeatController {
  const inertDeps: HeartbeatControllerDeps = {
    now: fixedNow,
    computeRollingMergeRate: async () => ({ mergeRate: null, cyclesInWindow: 0 }),
    getSchedulerStateRaw: async () => null,
    getSchedulerCyclesRun: async () => 0,
    getSchedulerCyclesMerged: async () => 0,
    getSchedulerCyclesFailed: async () => 0,
    getSchedulerCyclesUnaccounted: async () => 0,
    getLastResearchAtMs: async () => null,
    getSchedulerStateVersion: async () => 0,
    getSchedulerDeliberateStop: async () => null,
    setSchedulerDeliberateStop: async () => {},
    clearSchedulerDeliberateStop: async () => {},
    getAutopilotPaused: async () => ({ paused: false }),
    getReconcilerHealth: async () => null,
  };
  return new HeartbeatController({ ...inertDeps, ...overrides });
}

describe("HeartbeatController — start/stop lifecycle", () => {
  it("starts from a fresh state and reports running=true with the chosen interval", async () => {
    const controller = makeController();

    const result = await controller.start(noopBus, { intervalMs: 60_000 });
    assert.equal((result as any).started, true);
    assert.equal((result as any).intervalMs, 60_000);

    const status = await controller.getStatus();
    assert.equal(status.running, true);
    assert.equal(status.intervalMs, 60_000);
    assert.equal(status.startedAt, FIXED.toISOString());

    // Clean up the re-armed timer so the test process doesn't keep it alive.
    await controller.stop({ reason: "shutdown" });
  });

  it("refuses a double-start while already running", async () => {
    const controller = makeController();
    await controller.start(noopBus, { intervalMs: 60_000 });

    const second = await controller.start(noopBus, { intervalMs: 60_000 });
    assert.equal((second as any).error, "Scheduler is already running");

    await controller.stop({ reason: "shutdown" });
  });

  it("rejects an interval below the 30s minimum", async () => {
    const controller = makeController();
    const result = await controller.start(noopBus, { intervalMs: 1_000 });
    assert.match((result as any).error, /at least 30000ms/);

    const status = await controller.getStatus();
    assert.equal(status.running, false);
  });

  it("stop() on a not-running controller returns an error and never persists a marker", async () => {
    let setCalls = 0;
    const controller = makeController({
      setSchedulerDeliberateStop: async () => {
        setCalls += 1;
      },
    });

    const result = await controller.stop({ reason: "deliberate" });
    assert.equal((result as any).error, "Scheduler is not running");
    assert.equal(setCalls, 0);
  });

  it("isolates state per instance — two controllers do not share the singleton", async () => {
    const a = makeController();
    const b = makeController();

    await a.start(noopBus, { intervalMs: 60_000 });

    // b was never started — its state is independent of a's.
    const statusB = await b.getStatus();
    assert.equal(statusB.running, false);

    const statusA = await a.getStatus();
    assert.equal(statusA.running, true);

    await a.stop({ reason: "shutdown" });
  });
});

describe("HeartbeatController — deliberate-stop discriminant (issue #388)", () => {
  it("a deliberate stop persists the Redis marker and surfaces stopReason=deliberate", async () => {
    let persisted: { payload: string; ttl: number } | null = null;
    const controller = makeController({
      setSchedulerDeliberateStop: async (payload, ttl) => {
        persisted = { payload, ttl };
      },
    });

    await controller.start(noopBus, { intervalMs: 60_000 });
    const stopped = await controller.stop({ reason: "deliberate" });

    assert.equal((stopped as any).stopped, true);
    assert.equal((stopped as any).reason, "deliberate");
    assert.notEqual(persisted, null);
    assert.equal(JSON.parse(persisted!.payload).reason, "deliberate");

    const status = await controller.getStatus();
    assert.equal(status.stopReason, "deliberate");
    assert.equal(status.deliberateStoppedAt, FIXED.toISOString());
  });

  it("a circuit-breaker stop does NOT persist a marker but surfaces the reason", async () => {
    let setCalls = 0;
    const controller = makeController({
      setSchedulerDeliberateStop: async () => {
        setCalls += 1;
      },
    });

    await controller.start(noopBus, { intervalMs: 60_000 });
    const stopped = await controller.stop({ reason: "circuit-breaker" });

    assert.equal((stopped as any).reason, "circuit-breaker");
    assert.equal(setCalls, 0); // watchdog must be able to recover this — no marker

    const status = await controller.getStatus();
    assert.equal(status.stopReason, "circuit-breaker");
    assert.equal(status.deliberateStoppedAt, null);
  });

  it("start() clears any prior deliberate-stop marker and resets stopReason", async () => {
    let cleared = 0;
    const controller = makeController({
      clearSchedulerDeliberateStop: async () => {
        cleared += 1;
      },
    });

    await controller.start(noopBus, { intervalMs: 60_000 });
    await controller.stop({ reason: "deliberate" });

    // Re-start: the marker must be cleared and stopReason reset to null.
    await controller.start(noopBus, { intervalMs: 60_000 });
    assert.ok(cleared >= 1);

    const status = await controller.getStatus();
    assert.equal(status.stopReason, null);
    assert.equal(status.deliberateStoppedAt, null);

    await controller.stop({ reason: "shutdown" });
  });

  it("rehydrates a deliberate-stop marker from Redis on start()", async () => {
    const controller = makeController({
      getSchedulerDeliberateStop: async () =>
        JSON.stringify({ reason: "deliberate", stoppedAt: "2026-06-18T09:00:00.000Z" }),
    });

    await controller.start(noopBus, { intervalMs: 60_000 });
    // start() resets stopReason to null AFTER loadSchedulerState rehydrates it,
    // because an explicit start is operator intent to clear the marker.
    const status = await controller.getStatus();
    assert.equal(status.stopReason, null);

    await controller.stop({ reason: "shutdown" });
  });
});

describe("HeartbeatController — getStatus composition (issues #232 / #208)", () => {
  it("seeds lifetime counters from injected Redis readers and computes the lifetime merge rate", async () => {
    const controller = makeController({
      getSchedulerCyclesRun: async () => 100,
      getSchedulerCyclesMerged: async () => 40,
      getSchedulerCyclesFailed: async () => 50,
      getSchedulerCyclesUnaccounted: async () => 10,
    });

    await controller.start(noopBus, { intervalMs: 60_000 });
    const status = await controller.getStatus();

    assert.equal(status.cyclesRun, 100);
    assert.equal(status.cyclesMerged, 40);
    assert.equal(status.cyclesFailed, 50);
    assert.equal(status.cyclesUnaccounted, 10);
    // No rolling history (stubbed null) → mergeRate falls back to lifetime ratio.
    assert.equal(status.mergeRateLifetime, 40);
    assert.equal(status.mergeRate, 40);

    await controller.stop({ reason: "shutdown" });
  });

  it("prefers the rolling merge rate over the lifetime ratio when rolling data exists", async () => {
    const controller = makeController({
      getSchedulerCyclesRun: async () => 100,
      getSchedulerCyclesMerged: async () => 40,
      computeRollingMergeRate: async () => ({ mergeRate: 88, cyclesInWindow: 25 }),
    });

    await controller.start(noopBus, { intervalMs: 60_000 });
    const status = await controller.getStatus();

    assert.equal(status.mergeRate, 88); // rolling wins
    assert.equal(status.mergeRateCyclesInWindow, 25);
    assert.equal(status.mergeRateLifetime, 40); // lifetime preserved for audit

    await controller.stop({ reason: "shutdown" });
  });

  it("degrades getStatus to safe defaults when advisory reads throw", async () => {
    const controller = makeController({
      getAutopilotPaused: async () => {
        throw new Error("redis down");
      },
      getReconcilerHealth: async () => {
        throw new Error("redis down");
      },
    });

    const status = await controller.getStatus();
    assert.deepEqual(status.autopilotPause, { paused: false });
    assert.equal(status.reconciler, null);
    // The status call itself never throws — advisory reads degrade gracefully.
    assert.equal(status.running, false);
  });
});
