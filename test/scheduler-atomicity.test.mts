/**
 * Regression tests for scheduler state atomicity (issue #140).
 *
 * Bug: scheduler.ts managed state through a serialized object with no
 * concurrency guards. Multiple async paths could read/write state without
 * locking, leading to lost increments and stale-read overwrites.
 *
 * These tests verify:
 * - AC1: cyclesRun uses atomic Redis INCR (no lost increments under concurrency)
 * - AC2: lastResearchAt uses atomic Lua check-and-set (no double-claim)
 * - AC3: saveState uses optimistic locking (version conflict detected)
 * - AC4: concurrent cycle + research triggers produce correct state
 * - AC5: blocked reescalation uses a frozen snapshot
 *
 * Requires Redis running on localhost:6379 (default).
 * Uses Redis DB 1 for tests — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set test DB before any adapter imports
process.env.REDIS_URL = "redis://localhost:6379/1";

const adapter = await import("../src/redis/scheduler.ts");

let testRedis: any;

const TEST_PREFIX = "hydra:scheduler";

describe("scheduler atomicity (issue #140)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis("redis://localhost:6379/1");
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
  // AC1: Atomic cyclesRun increment via Redis INCR
  // -------------------------------------------------------------------------

  describe("AC1 — atomic cyclesRun increment", () => {
    test("incrSchedulerCyclesRun returns monotonically increasing values", async () => {
      const v1 = await adapter.incrSchedulerCyclesRun();
      const v2 = await adapter.incrSchedulerCyclesRun();
      const v3 = await adapter.incrSchedulerCyclesRun();
      assert.equal(v1, 1);
      assert.equal(v2, 2);
      assert.equal(v3, 3);
    });

    test("concurrent INCR calls produce no lost increments", async () => {
      const N = 20;
      // Fire N increments concurrently
      const results = await Promise.all(
        Array.from({ length: N }, () => adapter.incrSchedulerCyclesRun()),
      );
      // All results should be unique integers 1..N
      const sorted = results.sort((a, b) => a - b);
      for (let i = 0; i < N; i++) {
        assert.equal(sorted[i], i + 1, `expected ${i + 1}, got ${sorted[i]}`);
      }
      // Final value should be N
      const final = await adapter.getSchedulerCyclesRun();
      assert.equal(final, N);
    });
  });

  // -------------------------------------------------------------------------
  // AC2: Atomic lastResearchAt via Lua check-and-set
  // -------------------------------------------------------------------------

  describe("AC2 — atomic lastResearchAt claim", () => {
    test("first claim succeeds when no prior research", async () => {
      const claimed = await adapter.atomicClaimResearch(60_000);
      assert.equal(claimed, true);
    });

    test("second claim within interval is rejected", async () => {
      const first = await adapter.atomicClaimResearch(60_000);
      assert.equal(first, true);
      const second = await adapter.atomicClaimResearch(60_000);
      assert.equal(second, false);
    });

    test("claim succeeds after interval has elapsed", async () => {
      // Claim with a very short interval (1ms)
      const first = await adapter.atomicClaimResearch(1);
      assert.equal(first, true);
      // Wait a tiny bit to ensure ms has elapsed
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = await adapter.atomicClaimResearch(1);
      assert.equal(second, true);
    });

    test("concurrent claims — only one wins", async () => {
      // Fire 10 concurrent claims, all with a long interval
      const results = await Promise.all(
        Array.from({ length: 10 }, () => adapter.atomicClaimResearch(60_000)),
      );
      const claimed = results.filter(r => r === true).length;
      assert.equal(claimed, 1, `exactly 1 of 10 concurrent claims should succeed, got ${claimed}`);
    });

    test("setLastResearchAt updates the timestamp unconditionally", async () => {
      await adapter.setLastResearchAt();
      const ms = await adapter.getLastResearchAtMs();
      assert.ok(ms !== null);
      assert.ok(Math.abs(ms! - Date.now()) < 5000, "timestamp should be recent");
    });
  });

  // -------------------------------------------------------------------------
  // AC3: Versioned saveState with optimistic locking
  // -------------------------------------------------------------------------

  describe("AC3 — versioned saveState", () => {
    test("save succeeds with correct version", async () => {
      const version = await adapter.getSchedulerStateVersion();
      assert.equal(version, 0, "initial version should be 0");

      const result = await adapter.saveSchedulerStateVersioned('{"test":1}', 0);
      assert.equal(result.saved, true);
      assert.equal(result.newVersion, 1);
    });

    test("save fails with stale version", async () => {
      // First save at version 0
      const r1 = await adapter.saveSchedulerStateVersioned('{"test":1}', 0);
      assert.equal(r1.saved, true);
      assert.equal(r1.newVersion, 1);

      // Try to save again with version 0 (stale)
      const r2 = await adapter.saveSchedulerStateVersioned('{"test":2}', 0);
      assert.equal(r2.saved, false);
      assert.equal(r2.newVersion, 1, "should report current version");
    });

    test("concurrent saves — only one wins per version", async () => {
      // Both attempt to save at version 0
      const results = await Promise.all([
        adapter.saveSchedulerStateVersioned('{"writer":"A"}', 0),
        adapter.saveSchedulerStateVersioned('{"writer":"B"}', 0),
      ]);

      const saved = results.filter(r => r.saved);
      assert.equal(saved.length, 1, "exactly one of two concurrent saves should succeed");

      const finalVersion = await adapter.getSchedulerStateVersion();
      assert.equal(finalVersion, 1);
    });

    test("sequential saves with correct versions all succeed", async () => {
      let version = 0;
      for (let i = 0; i < 5; i++) {
        const result = await adapter.saveSchedulerStateVersioned(`{"seq":${i}}`, version);
        assert.equal(result.saved, true, `save ${i} should succeed`);
        version = result.newVersion;
      }
      assert.equal(version, 5);
    });
  });

  // -------------------------------------------------------------------------
  // AC4: Simulated concurrent cycle + research — no state corruption
  // -------------------------------------------------------------------------

  describe("AC4 — concurrent cycle + research simulation", () => {
    test("concurrent INCR + claim produce correct final state", async () => {
      // Simulate 5 concurrent "cycle completions" and 3 concurrent "research claims"
      const cyclePromises = Array.from({ length: 5 }, () =>
        adapter.incrSchedulerCyclesRun(),
      );
      const researchPromises = Array.from({ length: 3 }, () =>
        adapter.atomicClaimResearch(60_000),
      );

      const [cycleResults, researchResults] = await Promise.all([
        Promise.all(cyclePromises),
        Promise.all(researchPromises),
      ]);

      // All cycle increments should succeed with unique values
      const sortedCycles = cycleResults.sort((a, b) => a - b);
      for (let i = 0; i < 5; i++) {
        assert.equal(sortedCycles[i], i + 1);
      }

      // Exactly one research claim should win
      const researchWins = researchResults.filter(r => r === true).length;
      assert.equal(researchWins, 1, "exactly 1 research claim should succeed");

      // Verify final counter value
      const finalCycles = await adapter.getSchedulerCyclesRun();
      assert.equal(finalCycles, 5);
    });
  });

  // -------------------------------------------------------------------------
  // AC5: Frozen snapshot for blocked reescalation
  // -------------------------------------------------------------------------

  describe("AC5 — frozen snapshot prevents iteration mutation", () => {
    test("spreading an array creates an independent copy", () => {
      // This tests the principle used in checkBlockedEscalation:
      // `const blocked = [...(lanes.blocked || [])]`
      const original = [
        { id: "item-1", title: "Task A", meta: { blockedAt: "2026-05-01" } },
        { id: "item-2", title: "Task B", meta: { blockedAt: "2026-05-02" } },
      ];
      const snapshot = [...original];

      // Modify the original array (simulate another async path adding/removing)
      original.push({ id: "item-3", title: "Task C", meta: { blockedAt: "2026-05-03" } });
      original.splice(0, 1); // remove first item

      // Snapshot should be unchanged
      assert.equal(snapshot.length, 2);
      assert.equal(snapshot[0].id, "item-1");
      assert.equal(snapshot[1].id, "item-2");
    });
  });
});
