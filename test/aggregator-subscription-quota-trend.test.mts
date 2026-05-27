/**
 * Regression tests for the subscription-quota-trend aggregator (issue #619).
 *
 * Pure helpers (`computeQuotaPoints`) are tested directly. Integration
 * uses a stub snapshot reader so no JSONL files are required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getQuotaTrend,
  computeQuotaPoints,
} from "../src/aggregators/subscription-quota-trend.ts";
import type { UsageSnapshot } from "../src/cost/usage-tracker.ts";

const NOW = new Date("2026-05-26T12:00:00.000Z");

function fakeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  const zero = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    total: 0,
  };
  return {
    tokensLast5h: zero,
    tokensLast7d: { ...zero, total: 100 },
    tokensLast24h: 0,
    percentLast5h: 0,
    percentLast7d: 40,
    projectedWeeklyPercent: 50,
    pacingState: "under",
    emergencyStop: false,
    calibrated: true,
    weeklyQuotaTokens: 1000,
    fiveHourQuotaTokens: 100,
    filesScanned: 1,
    filesSkippedByMtime: 0,
    linesParsed: 1,
    linesWithUsage: 1,
    parseErrors: 0,
    generatedAt: NOW.toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("computeQuotaPoints — pure helper", () => {
  const start = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);

  test("[] when no historical and no current", () => {
    assert.deepEqual(computeQuotaPoints([], null, start, NOW), []);
  });

  test("returns single point with current snapshot only", () => {
    const out = computeQuotaPoints([], fakeSnapshot(), start, NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].v, 40);
  });

  test("drops historical points outside the window", () => {
    const before = new Date(start.getTime() - 60_000).toISOString();
    const inside = new Date(start.getTime() + 60_000).toISOString();
    const out = computeQuotaPoints(
      [
        { t: before, percentLast7d: 10 },
        { t: inside, percentLast7d: 20 },
      ],
      null,
      start,
      NOW,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].v, 20);
  });

  test("sorts oldest → newest", () => {
    const t1 = new Date(start.getTime() + 60_000).toISOString();
    const t2 = new Date(start.getTime() + 120_000).toISOString();
    const out = computeQuotaPoints(
      [
        { t: t2, percentLast7d: 50 },
        { t: t1, percentLast7d: 20 },
      ],
      null,
      start,
      NOW,
    );
    assert.deepEqual(out.map((p) => p.v), [20, 50]);
  });
});

// ---------------------------------------------------------------------------
// Integration shape
// ---------------------------------------------------------------------------

describe("getQuotaTrend — happy path", () => {
  test("current snapshot becomes both percentBurned and headroom points", async () => {
    const response = await getQuotaTrend(7, {
      now: NOW,
      readCurrentSnapshot: async () => fakeSnapshot({ percentLast7d: 30 }),
    });
    assert.equal(response.windowDays, 7);
    assert.equal(response.calibrated, true);
    assert.equal(response.percentBurned.points.length, 1);
    assert.equal(response.percentBurned.points[0].v, 30);
    assert.equal(response.headroom.points.length, 1);
    assert.equal(response.headroom.points[0].v, 70);
  });

  test("uncalibrated snapshot → calibrated: false in response", async () => {
    const response = await getQuotaTrend(7, {
      now: NOW,
      readCurrentSnapshot: async () =>
        fakeSnapshot({ calibrated: false, percentLast7d: 0 }),
    });
    assert.equal(response.calibrated, false);
    assert.equal(response.percentBurned.points[0].v, 0);
    assert.equal(response.headroom.points[0].v, 100);
  });
});

describe("getQuotaTrend — empty state", () => {
  test("snapshot read fails → both series empty, never throws", async () => {
    const response = await getQuotaTrend(7, {
      now: NOW,
      readCurrentSnapshot: async () => {
        throw new Error("disk read failed");
      },
    });
    assert.deepEqual(response.percentBurned.points, []);
    assert.deepEqual(response.headroom.points, []);
    assert.equal(response.calibrated, false);
  });
});

describe("getQuotaTrend — window boundary", () => {
  test("historical point just inside window is kept", async () => {
    const start = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const justInside = new Date(start.getTime() + 1_000).toISOString();
    const response = await getQuotaTrend(7, {
      now: NOW,
      readCurrentSnapshot: async () => fakeSnapshot(),
      readHistoricalSnapshots: async () => [
        { t: justInside, percentLast7d: 15 },
      ],
    });
    // historical + current
    assert.equal(response.percentBurned.points.length, 2);
    assert.equal(response.percentBurned.points[0].v, 15);
  });

  test("historical point just outside window is dropped", async () => {
    const start = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const justOutside = new Date(start.getTime() - 1_000).toISOString();
    const response = await getQuotaTrend(7, {
      now: NOW,
      readCurrentSnapshot: async () => fakeSnapshot(),
      readHistoricalSnapshots: async () => [
        { t: justOutside, percentLast7d: 15 },
      ],
    });
    // only current remains
    assert.equal(response.percentBurned.points.length, 1);
    assert.equal(response.percentBurned.points[0].v, 40);
  });
});

describe("getQuotaTrend — headroom clamping", () => {
  test("burned > 100 clamps headroom to 0", async () => {
    const response = await getQuotaTrend(7, {
      now: NOW,
      readCurrentSnapshot: async () =>
        fakeSnapshot({ percentLast7d: 120 }),
    });
    assert.equal(response.headroom.points[0].v, 0);
  });
});
