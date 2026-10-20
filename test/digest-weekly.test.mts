/**
 * Weekly-summary async fan-out assembler tests (issue #3394).
 *
 * Exercises `buildWeeklySummary` directly — the once-a-week async fan-out
 * assembler extracted from `src/digest-fanout.ts` into its own focused leaf
 * `src/digest-weekly.ts`. It takes injectable `deps` (mirroring
 * `src/aggregators/builder-health.ts`), so every reader here is a stub: no
 * Redis, no GitHub, no timers, no Telegram. The production wrapper in
 * `src/digest.ts` calls it with no args.
 *
 * This is its OWN top-level `describe` with its own lifecycle (no shared
 * Redis teardown to piggyback on — these are stub-only), per the repo authoring
 * rule against nesting under a sibling suite's teardown timing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildWeeklySummary } from "../src/digest-weekly.ts";

// ---------------------------------------------------------------------------
// buildWeeklySummary — fully injectable, no Redis/GitHub/timers (issue #1412)
// ---------------------------------------------------------------------------
describe("buildWeeklySummary", () => {
  const fixedNow = new Date("2026-06-08T12:00:00.000Z").getTime();
  const inWeek = new Date(fixedNow - 2 * 24 * 60 * 60 * 1000).toISOString();
  const beforeWeek = new Date(fixedNow - 10 * 24 * 60 * 60 * 1000).toISOString();

  it("returns null when no metrics were recorded in the last 7 days", async () => {
    const out = await buildWeeklySummary({
      now: () => fixedNow,
      getMetricsTrend: async () => [
        { recordedAt: beforeWeek, tasksMerged: "1" },
      ],
      getFixFeatureRatio: async () => ({ fixes: 0, features: 0, ratio: 0 }),
      getCurrentMilestoneProgress: async () => null,
    });
    assert.equal(out, null);
  });

  it("summarises cycles, fix:feature ratio, and milestone", async () => {
    const out = await buildWeeklySummary({
      now: () => fixedNow,
      getMetricsTrend: async () => [
        { recordedAt: inWeek, tasksMerged: "1", tasksFailed: "0", tasksAbandoned: "0", rolledBack: false },
        { recordedAt: inWeek, tasksMerged: "0", tasksFailed: "1", tasksAbandoned: "0", rolledBack: false },
        { recordedAt: beforeWeek, tasksMerged: "5" }, // excluded — outside the 7d window
      ],
      getFixFeatureRatio: async () => ({ fixes: 3, features: 2, ratio: 1.5 }),
      getCurrentMilestoneProgress: async () => ({
        name: "Beta",
        pctComplete: 60,
        done: 3,
        total: 5,
        remainingTitles: ["A", "B", "C", "D"],
      }),
    });
    assert.ok(out !== null);
    assert.match(out!, /📈 \*Hydra Weekly Summary\*/);
    assert.match(out!, /\*Cycles:\* 2 run — 1 merged, 1 failed, 0 rolled back, 0 abandoned/);
    assert.match(out!, /\*Fix:Feature ratio:\* 3:2 \(1\.5:1\)/);
    assert.match(out!, /\*Milestone:\* Beta — 60% \(3\/5 epics\)/);
    assert.match(out!, /\*Remaining:\* A, B, C \+1 more/);
  });

  it("emits warnings for a high fix ratio, rollbacks, and a completed milestone", async () => {
    const out = await buildWeeklySummary({
      now: () => fixedNow,
      getMetricsTrend: async () => [
        { recordedAt: inWeek, tasksMerged: "0", tasksFailed: "0", tasksAbandoned: "0", rolledBack: "true" },
        { recordedAt: inWeek, tasksMerged: "0", tasksFailed: "0", tasksAbandoned: "0", rolledBack: true },
        { recordedAt: inWeek, tasksMerged: "0", tasksFailed: "0", tasksAbandoned: "0", rolledBack: true },
      ],
      getFixFeatureRatio: async () => ({ fixes: 9, features: 3, ratio: 3 }),
      getCurrentMilestoneProgress: async () => ({
        name: "Beta",
        pctComplete: 100,
        done: 5,
        total: 5,
        remainingTitles: [],
      }),
    });
    assert.ok(out !== null);
    assert.match(out!, /⚠️ Fix ratio is 3:1 — most cycles are fixing previous work/);
    assert.match(out!, /⚠️ 3 rollbacks this week — executor quality needs attention/);
    assert.match(out!, /🎉 Milestone "Beta" is 100% complete — ready for operator review/);
  });
});
