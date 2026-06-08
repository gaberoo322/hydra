/**
 * Regression tests for scheduler stop semantics (issue #385).
 *
 * Bug (2026-05 incident): `hydra scheduler stop` cleared `state.timer` and
 * set `state.running = false` but a chained `setTimeout` inside an
 * in-flight `runScheduledCycle()` could still fire after stop. The
 * chained call would early-exit because another cycle was mid-flight,
 * but the failure handler re-armed the timer immediately, producing a
 * tight loop. Result: cyclesRun jumped 1,734 in two minutes after a
 * single `hydra scheduler stop` invocation.
 *
 * The fix lives in `runScheduledCycle()`:
 *   1. Line 706 — `if (!state.running) return;` — early-exit a chained
 *      tick that fires after stop.
 *   2. Line 785 — `if (state.running) { state.timer = setTimeout(...) }`
 *      — only chain a new tick when the scheduler is still running.
 *
 * Together these mean: a stop() called at any point — before, during, or
 * after a chained tick — produces a quiescent scheduler.
 *
 * AC coverage:
 *   - AC1: stop makes `runScheduledCycle()` early-exit before any timer fires
 *   - AC2: in-flight cycle is allowed to finish but no chained ticks fire
 *   - AC3: after stop, `cyclesRun` and `lastTickAt` do not advance
 *   - AC4: documented "drains in-flight, no new ticks" semantics via help text
 *          (`bin/hydra scheduler stop`)
 *
 * Uses Redis DB 1 — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

// Typed dynamic import (not `as any`): the `typeof import(...)` cast keeps the
// runtime dynamic-import — needed for the module-reset / DB-1 isolation intent —
// while letting knip statically resolve the export references. A bare `as any`
// destructure defeats knip's reference tracker, so test-only seam exports like
// `runScheduledCycle` get false-positived as unused (issue #1170).
const schedulerMod = (await import(
  "../src/scheduler/heartbeat.ts"
)) as typeof import("../src/scheduler/heartbeat.ts");
const { start, stop, getStatus, runScheduledCycle } = schedulerMod;

let testRedis: any;

async function cleanKeys() {
  const keys = await testRedis.keys("hydra:*");
  if (keys.length > 0) await testRedis.del(...keys);
}

function mockEventBus() {
  return {
    publisher: testRedis,
    publish: async () => 0,
  };
}

/**
 * Sleep a real wall-clock interval. Used to give chained setTimeout calls
 * a chance to fire if the early-exit guards were missing.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("scheduler stop semantics (issue #385)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis("redis://localhost:6379/1");
    }
    await cleanKeys();
    // Ensure scheduler is stopped before each test — silent failure is
    // intentional because most tests start from a stopped baseline.
    //
    // stop() became `async` in #468 (deliberate-stop marker persistence).
    // Awaiting here is required so the in-memory flip + Redis marker
    // settle before the next test starts; otherwise a not-yet-resolved
    // stop promise can race the next `start()` and the assertions below
    // observe a stale `state.running`.
    try { await stop(); } catch { /* intentional: not running */ }
  });

  after(async () => {
    try { await stop(); } catch { /* intentional: may not be running */ }
    if (testRedis) {
      await cleanKeys();
      testRedis.disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // AC1 — runScheduledCycle() is a no-op when state.running is false.
  //
  // This is the early-exit guard at scheduler.ts line 706. If the guard
  // is removed, a chained tick fired after stop() will execute the
  // housekeeping body (including updating lastTickAt) instead of bailing.
  // -------------------------------------------------------------------------

  test("AC1 — runScheduledCycle is a no-op when scheduler is stopped", async () => {
    // Precondition: scheduler is stopped (default state).
    const before = await getStatus();
    assert.equal(before.running, false, "precondition: scheduler stopped");
    const lastTickBefore = before.lastTickAt;

    // Directly invoke runScheduledCycle as if a chained setTimeout fired
    // after stop(). The function must early-exit at line 706 before
    // touching any housekeeping state.
    await runScheduledCycle(mockEventBus());

    const after = await getStatus();
    assert.equal(after.running, false, "stop state preserved");
    assert.equal(
      after.lastTickAt,
      lastTickBefore,
      "lastTickAt must not advance — runScheduledCycle bailed at the running-guard",
    );
  });

  // -------------------------------------------------------------------------
  // AC2 — start() then stop() then wait: no chained ticks fire.
  //
  // This is the public-API contract operators rely on. After `hydra
  // scheduler stop`, the scheduler must be quiescent — no further cycles,
  // no further lastTickAt updates, no counter advancement.
  //
  // We use a long intervalMs (10min) so the chained-tick timer wouldn't
  // fire during the test even without the running-guard. The test isn't
  // claiming "the timer fires fast" — it's claiming "after stop, even
  // if a stale timer slipped through, the cycle body would early-exit".
  // We force-exercise that by calling runScheduledCycle directly post-stop.
  // -------------------------------------------------------------------------

  test("AC2 — stop drains in-flight; chained ticks fire as no-ops", async () => {
    const eventBus = mockEventBus();

    // Start with a long interval. start() fires the first cycle
    // immediately as fire-and-forget; we await a moment for it to begin.
    const startResult = await start(eventBus, { intervalMs: 600_000 });
    assert.ok(startResult.started, "start should succeed");

    // Give the immediately-fired first cycle a tick to begin.
    await sleep(50);

    // Stop the scheduler. The in-flight cycle may still be running its
    // housekeeping; the guard at line 785 ensures it WILL NOT chain a
    // new timer once it reaches its tail.
    //
    // stop() became `async` in #468 — it awaits a Redis `setString` to
    // persist the deliberate-stop marker. Must be awaited here or
    // `stopResult` is a Promise and `.stopped` is undefined.
    const stopResult = await stop();
    assert.ok(stopResult.stopped, "stop should succeed");

    const cyclesRunAtStop = stopResult.cyclesRun;

    // Wait long enough for any in-flight cycle to drain. The housekeeping
    // body has bounded I/O against Redis DB 1, so 500ms is generous.
    await sleep(500);

    // Now simulate a stale chained tick by invoking runScheduledCycle
    // directly. Without the line-706 guard, this would execute the body
    // and bump lastTickAt. With the guard, it must early-exit.
    const lastTickPostDrain = (await getStatus()).lastTickAt;
    await runScheduledCycle(eventBus);
    await runScheduledCycle(eventBus);
    await runScheduledCycle(eventBus);

    const final = await getStatus();
    assert.equal(final.running, false, "scheduler stays stopped");
    assert.equal(
      final.lastTickAt,
      lastTickPostDrain,
      "lastTickAt must not advance after stop — the running-guard catches every chained tick",
    );
    // cyclesRun is a lifetime counter that may have advanced once for
    // the first immediate cycle (or stayed at the previous value if
    // start() raced with stop()); the contract is that it doesn't keep
    // climbing once stop has been called.
    assert.equal(
      final.cyclesRun,
      cyclesRunAtStop,
      "cyclesRun must not advance after stop",
    );
  });

  // -------------------------------------------------------------------------
  // AC3 — stop after stop is rejected, not a silent no-op that resets state.
  //
  // Important for operator UX: if you accidentally double-stop you should
  // get a clear error, not a fake success that hides whether the first
  // stop took effect.
  // -------------------------------------------------------------------------

  test("AC3 — double-stop returns an explicit error", async () => {
    // Initial state: not running. stop() should report the error.
    //
    // stop() is async since #468; without await, `first` is a Promise
    // and `"error" in first` is false. Awaiting unwraps to the
    // `{ error: "Scheduler is not running" }` short-circuit.
    const first = await stop();
    assert.ok("error" in first, "stop while not running should return an error");
    assert.match(first.error, /not running/i);
  });

  // -------------------------------------------------------------------------
  // AC4 — bin/hydra documents the stop semantics in its help text so
  // operators don't have to read scheduler.ts to know what `hydra
  // scheduler stop` does (drains in-flight, no new ticks).
  // -------------------------------------------------------------------------

  test("AC4 — bin/hydra help text documents stop semantics", async () => {
    const fs = await import("node:fs/promises");
    const path = new URL("../bin/hydra", import.meta.url);
    const text = await fs.readFile(path, "utf8");
    // The help text lives in the leading "# Usage examples:" block. We
    // assert that the stop semantics are spelled out somewhere in the
    // file so operators reading `hydra scheduler stop --help` (or just
    // opening the script) find them.
    assert.match(
      text,
      /scheduler[\s\/|]+stop/i,
      "bin/hydra must reference 'scheduler stop' (in any form)",
    );
    assert.match(
      text,
      /drains? in-flight|no (?:new )?ticks|no chained|quiescent/i,
      "bin/hydra must document the stop semantics: drains in-flight, no chained ticks",
    );
  });
});
