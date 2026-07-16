/**
 * Daily-heartbeat async fan-out assembler tests (issue #2215; weekly summary
 * tests moved to `test/digest-weekly.test.mts` in #3394).
 *
 * Exercises `buildDailyHeartbeat` directly — the async fan-out assembler lifted
 * out of `src/digest-format.ts` into `src/digest-fanout.ts`. It takes injectable
 * `deps` (mirroring `src/aggregators/builder-health.ts`), so every reader here
 * is a stub: no Redis, no usage tracker, no GitHub, no timers, no Telegram. The
 * production wrapper in `src/digest.ts` calls it with no args.
 *
 * This is its OWN top-level `describe` with its own lifecycle (no shared
 * Redis teardown to piggyback on — these are stub-only), per the repo authoring
 * rule against nesting under a sibling suite's teardown timing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildDailyHeartbeat } from "../src/digest-fanout.ts";

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

  it("degrades Throughput+Stagnation to n/a when the FULFILLED scorecard throws during processing — never throws itself (regression #3377/#3379)", async () => {
    // The scorecard READ resolves (fulfilled), but reading its fields throws.
    // With the single shared `allSettled` read, only a *rejection* is caught by
    // the settled-status branch; a throw while processing a fulfilled value must
    // still be guarded per-section so the heartbeat never throws. A bare
    // `if (fulfilled) { …access… }` without an inner try/catch would let this
    // propagate and blank the whole digest.
    const throwingScorecard: any = {
      get autonomyRate() {
        throw new Error("scorecard field boom");
      },
      get stagnation() {
        throw new Error("scorecard field boom");
      },
    };
    const out = await buildDailyHeartbeat({
      listRecentAutopilotRunIds: async () => [],
      getUsage: async () => ({ calibrated: false }),
      getBuilderHealthScorecard: async () => throwingScorecard,
      getBacklogCounts: async () => ({}),
      readRecentAlerts: async () => [],
    });
    assert.match(out, /💓 \*Hydra Daily Heartbeat\*/);
    assert.match(out, /\*Throughput:\* n\/a \(scorecard field boom\)/);
    assert.match(out, /\*Stagnation:\* n\/a \(scorecard field boom\)/);
    // The rest of the digest still ships around the degraded sections.
    assert.match(out, /\*Target backlog:\* 0 queued, 0 blocked, 0 triage/);
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
