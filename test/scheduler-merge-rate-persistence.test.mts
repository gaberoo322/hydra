/**
 * Regression tests for scheduler mergeRate persistence (issue #208).
 *
 * Bug: `cyclesRun` was persisted to Redis via an atomic counter (issue #140),
 * but `cyclesMerged` and `cyclesFailed` lived only in in-memory `state`.
 * After every orchestrator restart, mergeRate snapped to 0% (numerator reset
 * but denominator persisted), which made the zero-output circuit breaker fire
 * on transient resets and produced misleading stall alerts.
 *
 * This test file verifies:
 * - AC1: incrSchedulerCyclesMerged / getSchedulerCyclesMerged round-trip and increment atomically.
 * - AC2: incrSchedulerCyclesFailed / getSchedulerCyclesFailed round-trip and increment atomically.
 * - AC3: After simulating two consecutive merges, the persisted counter reads 2.
 * - AC4: After "restarting" (reading from Redis), the merge counter is preserved.
 * - AC5: Concurrent INCRs produce no lost increments.
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set test DB before any adapter imports
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const adapter = await import("../src/redis/scheduler.ts");

let testRedis: any;

const TEST_PREFIX = "hydra:scheduler";

describe("scheduler mergeRate persistence (issue #208)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis(process.env.REDIS_URL);
    }
    // Clean scheduler keys used in tests
    const keys = await testRedis.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) await testRedis.del(...keys);
  });

  after(async () => {
    const keys = await testRedis.keys(`${TEST_PREFIX}*`);
    if (keys.length > 0) await testRedis.del(...keys);
    if (testRedis) testRedis.disconnect();
  });

  // -------------------------------------------------------------------------
  // AC1 — atomic cyclesMerged increment + read
  // -------------------------------------------------------------------------

  describe("AC1 — incrSchedulerCyclesMerged is atomic and monotonic", () => {
    test("incrSchedulerCyclesMerged returns monotonically increasing values", async () => {
      const v1 = await adapter.incrSchedulerCyclesMerged();
      const v2 = await adapter.incrSchedulerCyclesMerged();
      const v3 = await adapter.incrSchedulerCyclesMerged();
      assert.equal(v1, 1);
      assert.equal(v2, 2);
      assert.equal(v3, 3);
    });

    test("getSchedulerCyclesMerged returns 0 when no counter exists", async () => {
      const v = await adapter.getSchedulerCyclesMerged();
      assert.equal(v, 0);
    });

    test("getSchedulerCyclesMerged matches latest INCR result", async () => {
      await adapter.incrSchedulerCyclesMerged();
      await adapter.incrSchedulerCyclesMerged();
      await adapter.incrSchedulerCyclesMerged();
      const v = await adapter.getSchedulerCyclesMerged();
      assert.equal(v, 3);
    });
  });

  // -------------------------------------------------------------------------
  // AC2 — atomic cyclesFailed increment + read
  // -------------------------------------------------------------------------

  describe("AC2 — incrSchedulerCyclesFailed is atomic and monotonic", () => {
    test("incrSchedulerCyclesFailed returns monotonically increasing values", async () => {
      const v1 = await adapter.incrSchedulerCyclesFailed();
      const v2 = await adapter.incrSchedulerCyclesFailed();
      assert.equal(v1, 1);
      assert.equal(v2, 2);
    });

    test("getSchedulerCyclesFailed returns 0 when no counter exists", async () => {
      const v = await adapter.getSchedulerCyclesFailed();
      assert.equal(v, 0);
    });

    test("merged and failed counters are stored independently", async () => {
      await adapter.incrSchedulerCyclesMerged();
      await adapter.incrSchedulerCyclesMerged();
      await adapter.incrSchedulerCyclesFailed();
      const merged = await adapter.getSchedulerCyclesMerged();
      const failed = await adapter.getSchedulerCyclesFailed();
      assert.equal(merged, 2);
      assert.equal(failed, 1);
    });
  });

  // -------------------------------------------------------------------------
  // AC3 — primary regression scenario from issue body:
  // "simulating two consecutive cycles, restarting state, and reading the
  //  counter returns 2"
  // -------------------------------------------------------------------------

  describe("AC3 — counters survive simulated restart", () => {
    test("two merge increments + restart still reports 2", async () => {
      // First "process": run two merges.
      await adapter.incrSchedulerCyclesMerged();
      await adapter.incrSchedulerCyclesMerged();

      // "Restart" the orchestrator — wipe in-memory state, then load from Redis.
      const inMemoryAfterRestart = { cyclesMerged: 0 };
      const persisted = await adapter.getSchedulerCyclesMerged();
      if (persisted > 0) inMemoryAfterRestart.cyclesMerged = persisted;

      assert.equal(
        inMemoryAfterRestart.cyclesMerged,
        2,
        "after restart, in-memory cyclesMerged should reload from Redis",
      );
    });

    test("mergeRate is stable across restart given persisted counters", async () => {
      // Pretend the scheduler ran 10 cycles, of which 8 merged and 2 failed.
      for (let i = 0; i < 10; i++) await adapter.incrSchedulerCyclesRun();
      for (let i = 0; i < 8; i++) await adapter.incrSchedulerCyclesMerged();
      for (let i = 0; i < 2; i++) await adapter.incrSchedulerCyclesFailed();

      // Simulate /api/scheduler/status restart: reload everything from Redis.
      const cyclesRun = await adapter.getSchedulerCyclesRun();
      const cyclesMerged = await adapter.getSchedulerCyclesMerged();
      const cyclesFailed = await adapter.getSchedulerCyclesFailed();

      const mergeRate = cyclesRun > 0 ? Math.round((cyclesMerged / cyclesRun) * 100) : 0;

      assert.equal(cyclesRun, 10);
      assert.equal(cyclesMerged, 8);
      assert.equal(cyclesFailed, 2);
      assert.equal(
        mergeRate,
        80,
        "mergeRate should be 80% immediately after restart, not 0%",
      );
    });
  });

  // -------------------------------------------------------------------------
  // AC4 — concurrent merge increments produce no lost updates
  // -------------------------------------------------------------------------

  describe("AC4 — concurrent INCR has no lost updates", () => {
    test("concurrent merged INCRs produce unique sequential values", async () => {
      const N = 15;
      const results = await Promise.all(
        Array.from({ length: N }, () => adapter.incrSchedulerCyclesMerged()),
      );
      const sorted = [...results].sort((a, b) => a - b);
      for (let i = 0; i < N; i++) {
        assert.equal(sorted[i], i + 1, `expected ${i + 1}, got ${sorted[i]}`);
      }
      const final = await adapter.getSchedulerCyclesMerged();
      assert.equal(final, N);
    });

    test("concurrent failed INCRs produce unique sequential values", async () => {
      const N = 10;
      const results = await Promise.all(
        Array.from({ length: N }, () => adapter.incrSchedulerCyclesFailed()),
      );
      const sorted = [...results].sort((a, b) => a - b);
      for (let i = 0; i < N; i++) {
        assert.equal(sorted[i], i + 1);
      }
    });
  });
});
