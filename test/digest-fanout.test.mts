/**
 * Digest async fan-out assembler tests (issue #2215).
 *
 * Exercises `buildDailyHeartbeat` and `buildWeeklySummary` directly — the two
 * async fan-out assemblers lifted out of `src/digest-format.ts` into
 * `src/digest-fanout.ts`. Both take injectable `deps` (mirroring
 * `src/aggregators/builder-health.ts`), so every reader here is a stub: no
 * Redis, no usage tracker, no GitHub, no timers, no Telegram. The production
 * wrappers in `src/digest.ts` call them with no args.
 *
 * Each suite is its OWN top-level `describe` with its own lifecycle (no shared
 * Redis teardown to piggyback on — these are stub-only), per the repo authoring
 * rule against nesting under a sibling suite's teardown timing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildDailyHeartbeat, buildWeeklySummary } from "../src/digest-fanout.ts";

// ---------------------------------------------------------------------------
// buildDailyHeartbeat — fully injectable, no Redis/Telegram/timers
// ---------------------------------------------------------------------------
describe("buildDailyHeartbeat", () => {
  it("always returns a string and renders every section header with healthy stubs", async () => {
    const fixedNow = new Date("2026-06-07T12:00:00.000Z").getTime();
    const out = await buildDailyHeartbeat({
      now: () => fixedNow,
      listRecentAutopilotRunIds: async () => ["run-1"],
      getAutopilotRun: async () => ({
        started_epoch: Math.floor(fixedNow / 1000) - 30 * 60, // 30 min ago
        status: "ended",
        ended: true,
      }),
      getUsage: async () => ({
        calibrated: true,
        percentLast5h: 12,
        percentSinceReset: 40,
        emergencyStop: false,
        weeklyEmergencyStop: false,
      }),
      getBuilderHealthScorecard: async () => ({
        autonomyRate: { autonomous: 4, total: 5, window: 50 },
      }),
      getBacklogCounts: async () => ({ queued: 3, blocked: 1, triage: 2 }),
      readRecentAlerts: async () => [JSON.stringify({ timestamp: new Date(fixedNow).toISOString() })],
    });

    assert.equal(typeof out, "string");
    assert.match(out, /💓 \*Hydra Daily Heartbeat\*/);
    assert.match(out, /\*Autopilot:\* last run ended — started 30m ago/);
    assert.match(out, /\*Usage:\* 5h 12% · weekly 40% \(caps at 90%\)/);
    assert.match(out, /\*Throughput:\* 4\/5 PRs auto-merged \(last 50\)/);
    assert.match(out, /\*Target backlog:\* 3 queued, 1 blocked, 2 triage/);
    assert.match(out, /\*Alerts \(24h\):\* 1/);
  });

  it("degrades each section to n/a when a reader throws — never throws itself", async () => {
    const boom = async () => {
      throw new Error("redis down");
    };
    const out = await buildDailyHeartbeat({
      listRecentAutopilotRunIds: boom,
      getUsage: boom,
      getBuilderHealthScorecard: boom,
      getBacklogCounts: boom,
      readRecentAlerts: boom,
    });
    assert.match(out, /💓 \*Hydra Daily Heartbeat\*/);
    assert.match(out, /\*Autopilot:\* n\/a \(redis down\)/);
    assert.match(out, /\*Usage:\* n\/a \(redis down\)/);
    assert.match(out, /\*Throughput:\* n\/a \(redis down\)/);
    assert.match(out, /\*Target backlog:\* n\/a \(redis down\)/);
    assert.match(out, /\*Alerts \(24h\):\* n\/a \(redis down\)/);
  });

  it("marks usage uncalibrated when quota env vars are unset", async () => {
    const out = await buildDailyHeartbeat({
      listRecentAutopilotRunIds: async () => [],
      getUsage: async () => ({ calibrated: false }),
      getBuilderHealthScorecard: async () => ({}),
      getBacklogCounts: async () => ({}),
      readRecentAlerts: async () => [],
    });
    assert.match(out, /\*Autopilot:\* ⚠️ no recent run indexed/);
    assert.match(out, /\*Usage:\* uncalibrated \(quota env vars unset\)/);
    assert.match(out, /\*Throughput:\* no merges in window/);
    assert.match(out, /\*Target backlog:\* 0 queued, 0 blocked, 0 triage/);
    assert.match(out, /\*Alerts \(24h\):\* 0/);
  });
});

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
      getBacklogCounts: async () => ({}),
    });
    assert.equal(out, null);
  });

  it("summarises cycles, fix:feature ratio, milestone, and backlog", async () => {
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
      getBacklogCounts: async () => ({ queued: 4, blocked: 0, triage: 2 }),
    });
    assert.ok(out !== null);
    assert.match(out!, /📈 \*Hydra Weekly Summary\*/);
    assert.match(out!, /\*Cycles:\* 2 run — 1 merged, 1 failed, 0 rolled back, 0 abandoned/);
    assert.match(out!, /\*Fix:Feature ratio:\* 3:2 \(1\.5:1\)/);
    assert.match(out!, /\*Milestone:\* Beta — 60% \(3\/5 epics\)/);
    assert.match(out!, /\*Remaining:\* A, B, C \+1 more/);
    assert.match(out!, /\*Backlog:\* 4 queued, 0 blocked, 2 triage/);
  });

  it("emits warnings for a high fix ratio, rollbacks, blocked items, and a completed milestone", async () => {
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
      getBacklogCounts: async () => ({ queued: 0, blocked: 2, triage: 0 }),
    });
    assert.ok(out !== null);
    assert.match(out!, /⚠️ Fix ratio is 3:1 — most cycles are fixing previous work/);
    assert.match(out!, /⚠️ 3 rollbacks this week — executor quality needs attention/);
    assert.match(out!, /⚠️ 2 items blocked — check Telegram for unblock commands/);
    assert.match(out!, /🎉 Milestone "Beta" is 100% complete — ready for operator review/);
  });
});
