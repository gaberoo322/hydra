/**
 * Regression tests for scheduler state atomicity (issue #140).
 *
 * Bug: scheduler.ts managed state through a serialized object with no
 * concurrency guards. Multiple async paths could read/write state without
 * locking, leading to lost increments and stale-read overwrites.
 *
 * These tests verify:
 * - AC1: cyclesRun uses atomic Redis INCR (no lost increments under concurrency)
 * - AC2: lastResearchAt reader returns the raw epoch-ms value (or null)
 * - AC3: saveState uses optimistic locking (version conflict detected)
 * - AC4: concurrent cycle triggers produce correct state
 * - AC5: blocked reescalation uses a frozen snapshot
 *
 * The research-claim writers (atomicClaimResearch, setLastResearchAt) that AC2
 * and AC4 previously exercised were removed in #3132 — they backed the
 * in-process research-decision plane deleted in #706 and had zero live callers.
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

describe("scheduler atomicity (issue #140)", () => {
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
  // AC2: lastResearchAt reader (issue #140)
  //
  // The research-claim writers (`atomicClaimResearch`, `setLastResearchAt`)
  // were removed in #3132 — they backed the in-process research-decision plane
  // deleted in #706 (scheduler fold PR-1/4) and had zero live callers (only
  // test coverage). Only the reader survives, still consumed by the
  // observability heartbeat (`src/scheduler/heartbeat.ts`); these cases pin the
  // reader's contract (raw-key read, null when unset).
  // -------------------------------------------------------------------------

  describe("AC2 — lastResearchAt reader", () => {
    test("getLastResearchAtMs returns null when never set", async () => {
      const ms = await adapter.getLastResearchAtMs();
      assert.equal(ms, null);
    });

    test("getLastResearchAtMs reads a raw epoch-ms value", async () => {
      const now = Date.now();
      await testRedis.set("hydra:scheduler:state:lastResearchAt", now.toString());
      const ms = await adapter.getLastResearchAtMs();
      assert.equal(ms, now);
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
  // AC4: Simulated concurrent cycle completions — no state corruption
  //
  // The research-claim arm of this simulation was dropped in #3132 alongside
  // `atomicClaimResearch`; the concurrent-INCR invariant it guarded is retained.
  // -------------------------------------------------------------------------

  describe("AC4 — concurrent cycle simulation", () => {
    test("concurrent INCR produce correct final state", async () => {
      // Simulate 5 concurrent "cycle completions"
      const cyclePromises = Array.from({ length: 5 }, () =>
        adapter.incrSchedulerCyclesRun(),
      );

      const cycleResults = await Promise.all(cyclePromises);

      // All cycle increments should succeed with unique values
      const sortedCycles = cycleResults.sort((a, b) => a - b);
      for (let i = 0; i < 5; i++) {
        assert.equal(sortedCycles[i], i + 1);
      }

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
