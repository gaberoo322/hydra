/**
 * Pure-core digest formatter tests (issue #1181).
 *
 * Exercises `buildDigestMessage`, `buildDailyHeartbeat`,
 * `buildWeeklySummary`, and `formatCriticalAlert` directly — no Telegram
 * calls, no timers, no module state. `buildDailyHeartbeat` and
 * `buildWeeklySummary` take injectable `deps` (mirroring
 * `src/aggregators/builder-health.ts`), so every reader here is a stub; the
 * production wrappers in `src/digest.ts` call them with no args.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDigestMessage,
  buildDailyHeartbeat,
  buildWeeklySummary,
  formatCriticalAlert,
} from "../src/digest-format.ts";

// ---------------------------------------------------------------------------
// buildDigestMessage
// ---------------------------------------------------------------------------
describe("buildDigestMessage", () => {
  it("renders the header and an empty-period digest with no events", () => {
    const msg = buildDigestMessage([]);
    assert.match(msg, /📊 \*Hydra Digest\*/);
    assert.match(msg, /\*Cycles:\* None completed in this period/);
    // Capacity block always renders, even with no snapshot.
    assert.match(msg, /\*Capacity split:\*/);
    assert.match(msg, /No cycle history yet/);
    // Builder-health block always renders its header.
    assert.match(msg, /\*Builder health:\*/);
    assert.match(msg, /No builder-health data yet/);
    assert.match(msg, /_Period: no events_/);
  });

  it("summarises merged and failed cycles", () => {
    const events = [
      {
        type: "cycle:completed",
        timestamp: "2026-06-07T08:00:00.000Z",
        payload: { task: { title: "Add thing", finalState: "merged" }, commitSha: "abcdef1234567" },
      },
      {
        type: "cycle:completed",
        timestamp: "2026-06-07T09:00:00.000Z",
        payload: { task: { title: "Broke thing", finalState: "failed" } },
      },
    ];
    const msg = buildDigestMessage(events);
    assert.match(msg, /\*Cycles:\* 2 completed — 1 merged, 1 failed, 0 abandoned/);
    assert.match(msg, /\*Merged:\*/);
    assert.match(msg, /• Add thing/);
    assert.match(msg, /\*Failed:\*/);
    assert.match(msg, /• Broke thing — failed/);
  });

  it("renders the capacity split when a snapshot is supplied", () => {
    const snapshot = {
      orchestrator: { share: 0.3, count: 3, window: 10, floor: 0.25 },
      target: { share: 0.7, count: 7 },
      idle: { count: 0 },
      floorMet: true,
      recent: [],
    };
    const msg = buildDigestMessage([], snapshot);
    assert.match(msg, /• Orchestrator: 30% \(3\/10\) ✅ floor 25%/);
    assert.match(msg, /• Target: 70% \(7\/10\)/);
  });

  it("flags an action item when verification failures cross the threshold", () => {
    const events = Array.from({ length: 3 }, (_, i) => ({
      type: "task:verification_failed",
      timestamp: `2026-06-07T0${i}:00:00.000Z`,
      payload: {},
    }));
    const msg = buildDigestMessage(events);
    assert.match(msg, /\*Action items:\*/);
    assert.match(msg, /3 verification failures/);
  });

  it("truncates messages that exceed the Telegram limit", () => {
    // A single merged event with a >4000-char title overflows the message
    // (the merged list caps at 10 rows, so length must come from row width).
    const events = [
      {
        type: "cycle:completed",
        timestamp: "2026-06-07T08:00:00.000Z",
        payload: {
          task: { title: "X".repeat(5000), finalState: "merged" },
        },
      },
    ];
    const msg = buildDigestMessage(events);
    assert.ok(msg.length <= 4000, `expected <= 4000 chars, got ${msg.length}`);
    assert.match(msg, /_\(truncated\)_$/);
  });
});

// ---------------------------------------------------------------------------
// formatCriticalAlert
// ---------------------------------------------------------------------------
describe("formatCriticalAlert", () => {
  it("formats a rollback-failed alert", () => {
    const out = formatCriticalAlert({
      type: "cycle:rollback_failed",
      payload: { title: "Risky change", commitSha: "deadbeefcafe", error: "merge conflict" },
    });
    assert.match(out, /🚨 \*CRITICAL: Rollback Failed\*/);
    assert.match(out, /Task: Risky change/);
    assert.match(out, /deadbee/);
    assert.match(out, /merge conflict/);
  });

  it("formats a scheduler-stopped alert", () => {
    const out = formatCriticalAlert({
      type: "scheduler:stopped",
      payload: { reason: "budget exhausted", cyclesRun: 12 },
    });
    assert.match(out, /🛑 \*Scheduler Stopped\*/);
    assert.match(out, /Reason: budget exhausted/);
    assert.match(out, /Cycles run: 12/);
  });

  it("falls back to a generic alert for unknown types", () => {
    const out = formatCriticalAlert({ type: "something:weird", payload: { a: 1 } });
    assert.match(out, /⚠️ \*something:weird\*/);
    assert.match(out, /"a":1/);
  });
});

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
