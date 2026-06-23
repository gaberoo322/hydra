/**
 * Regression test for abandonment-cause aggregation (issue #195).
 *
 * Bug: Abandonment causes were buried in per-cycle `abandonReason` strings
 * with no aggregated breakdown — operators couldn't see that 7/20 cycles
 * abandoned for the same reason (e.g., Preflight scope rejection).
 *
 * Fix: New `getAbandonmentBreakdown(count)` aggregates `abandonReason` from
 * the last N cycles, buckets by leading category (split on `:` or first 4
 * words), returns counts + percentages + sample reasons. Exposed via
 * `GET /api/metrics/abandonment`.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Set test DB before any adapter imports
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { recordCycleMetrics } = await import("../src/metrics/record.ts");
const { getAbandonmentBreakdown, categorizeAbandonReason } = await import("../src/api/metrics.ts");

let testRedis: any;

async function cleanTestKeys() {
  const patterns = ["hydra:metrics:*", "hydra:cycle:costs:*"];
  for (const pat of patterns) {
    const keys = await testRedis.keys(pat);
    if (keys.length > 0) await testRedis.del(...keys);
  }
  await testRedis.del("hydra:metrics:index");
}

describe("abandonment metrics aggregation (issue #195)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis(process.env.REDIS_URL);
    }
    await cleanTestKeys();
  });

  after(async () => {
    await cleanTestKeys();
    if (testRedis) testRedis.disconnect();
  });

  // ----------------------------------------------------------------------
  // Pure categorization
  // ----------------------------------------------------------------------

  test("categorizeAbandonReason splits on first colon", () => {
    assert.equal(
      categorizeAbandonReason("Planner noWork: codebase-clean"),
      "Planner noWork",
    );
    assert.equal(
      categorizeAbandonReason("Preflight: scope-out-of-bounds"),
      "Preflight",
    );
    assert.equal(
      categorizeAbandonReason("Drift: same anchor reference used in cycle-foo"),
      "Drift",
    );
  });

  test("categorizeAbandonReason takes first 4 words when no colon", () => {
    assert.equal(
      categorizeAbandonReason("Auto-decomposed into smaller tasks for clarity"),
      "Auto-decomposed into smaller tasks",
    );
    assert.equal(
      categorizeAbandonReason("Planner produced no task"),
      "Planner produced no task",
    );
  });

  test("categorizeAbandonReason returns Unknown for empty input", () => {
    assert.equal(categorizeAbandonReason(""), "Unknown");
    assert.equal(categorizeAbandonReason("   "), "Unknown");
    assert.equal(categorizeAbandonReason(undefined), "Unknown");
    assert.equal(categorizeAbandonReason(null), "Unknown");
  });

  // ----------------------------------------------------------------------
  // Aggregation across fixture cycles
  // ----------------------------------------------------------------------

  test("getAbandonmentBreakdown aggregates 20 fixture cycles into expected categories", async () => {
    // Seed fixture: 20 cycles total, 11 abandoned with mixed reasons.
    //   - 5 "Preflight: ..." reasons
    //   - 4 "Auto-decomposed ..." reasons (no colon → first 4 words)
    //   - 2 "Planner noWork: ..." reasons
    //   - 9 successful (no abandonReason)
    const fixtures = [
      { cycleId: "cycle-abn-001", abandonReason: "Preflight: scope-out-of-bounds (3 files)" },
      { cycleId: "cycle-abn-002", abandonReason: "Preflight: duplicate of recent cycle" },
      { cycleId: "cycle-abn-003", abandonReason: "Preflight: scope-out-of-bounds (5 files)" },
      { cycleId: "cycle-abn-004", abandonReason: "Preflight: missing grounding evidence" },
      { cycleId: "cycle-abn-005", abandonReason: "Preflight: verification plan absent" },
      { cycleId: "cycle-abn-006", abandonReason: "Auto-decomposed into smaller tasks for issue #194" },
      { cycleId: "cycle-abn-007", abandonReason: "Auto-decomposed into smaller tasks pending parent" },
      { cycleId: "cycle-abn-008", abandonReason: "Auto-decomposed into smaller tasks awaiting child completion" },
      { cycleId: "cycle-abn-009", abandonReason: "Auto-decomposed into smaller tasks for issue #190" },
      { cycleId: "cycle-abn-010", abandonReason: "Planner noWork: codebase-clean" },
      { cycleId: "cycle-abn-011", abandonReason: "Planner noWork: no priorities found" },
      // 9 successful cycles (no abandonReason)
      { cycleId: "cycle-abn-012", taskTitle: "Merged feature A" },
      { cycleId: "cycle-abn-013", taskTitle: "Merged feature B" },
      { cycleId: "cycle-abn-014", taskTitle: "Merged feature C" },
      { cycleId: "cycle-abn-015", taskTitle: "Merged feature D" },
      { cycleId: "cycle-abn-016", taskTitle: "Merged feature E" },
      { cycleId: "cycle-abn-017", taskTitle: "Merged feature F" },
      { cycleId: "cycle-abn-018", taskTitle: "Merged feature G" },
      { cycleId: "cycle-abn-019", taskTitle: "Merged feature H" },
      { cycleId: "cycle-abn-020", taskTitle: "Merged feature I" },
    ];

    for (const f of fixtures) {
      const { cycleId, ...metrics } = f;
      await recordCycleMetrics(cycleId, {
        tasksAttempted: 1,
        tasksMerged: metrics.abandonReason ? 0 : 1,
        tasksAbandoned: metrics.abandonReason ? 1 : 0,
        ...metrics,
      });
    }

    const breakdown = await getAbandonmentBreakdown(20);

    assert.equal(breakdown.totalCycles, 20, "totalCycles should be 20");
    assert.equal(breakdown.totalAbandoned, 11, "totalAbandoned should be 11");
    assert.equal(breakdown.abandonRate, 55, "abandonRate should be 55%");

    // Categories ordered by descending count
    assert.equal(breakdown.byCategory.length, 3, "should have 3 distinct categories");

    const preflight = breakdown.byCategory.find((c) => c.category === "Preflight");
    assert.ok(preflight, "Preflight category should be present");
    assert.equal(preflight.count, 5);
    assert.equal(preflight.pct, Math.round((5 / 11) * 100));
    assert.equal(preflight.sampleReasons.length, 3, "should keep up to 3 sample reasons");

    const decomposedCategory = breakdown.byCategory.find((c) => c.category === "Auto-decomposed into smaller tasks");
    assert.ok(decomposedCategory, "Auto-decomposed category should be present");
    assert.equal(decomposedCategory.count, 4);
    assert.equal(decomposedCategory.pct, Math.round((4 / 11) * 100));

    const noWork = breakdown.byCategory.find((c) => c.category === "Planner noWork");
    assert.ok(noWork, "Planner noWork category should be present");
    assert.equal(noWork.count, 2);
    assert.equal(noWork.pct, Math.round((2 / 11) * 100));

    // Descending order
    assert.ok(breakdown.byCategory[0].count >= breakdown.byCategory[1].count);
    assert.ok(breakdown.byCategory[1].count >= breakdown.byCategory[2].count);
  });

  test("getAbandonmentBreakdown returns zero state when no cycles exist", async () => {
    const breakdown = await getAbandonmentBreakdown(50);
    assert.equal(breakdown.totalCycles, 0);
    assert.equal(breakdown.totalAbandoned, 0);
    assert.equal(breakdown.abandonRate, 0);
    assert.deepEqual(breakdown.byCategory, []);
  });

  test("getAbandonmentBreakdown deduplicates sample reasons within a category", async () => {
    // Seed 5 cycles, all abandoned with the same exact reason
    for (let i = 1; i <= 5; i++) {
      await recordCycleMetrics(`cycle-dup-${String(i).padStart(3, "0")}`, {
        tasksAttempted: 1,
        tasksAbandoned: 1,
        abandonReason: "Preflight: identical reason",
      });
    }

    const breakdown = await getAbandonmentBreakdown(10);
    assert.equal(breakdown.totalAbandoned, 5);
    assert.equal(breakdown.byCategory.length, 1);
    assert.equal(breakdown.byCategory[0].sampleReasons.length, 1, "duplicate sample reasons should be coalesced");
    assert.equal(breakdown.byCategory[0].sampleReasons[0], "Preflight: identical reason");
  });
});
