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
import type { UsageSnapshot } from "../src/cost/index.ts";
import { emptyByDispatchKind } from "../src/cost/transcript-scan.ts";

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
    usageSource: "estimate",
    oauthError: null,
    oauthStale: false,
    oauthAgeMs: null,
    oauthFiveHourResetsAt: null,
    oauthSevenDayResetsAt: null,
    projectedWeeklyPercent: 50,
    pacingState: "under",
    emergencyStop: false,
    weeklyEmergencyStop: false,
    calibrated: true,
    byModel: {
      opus: { ...zero },
      sonnet: { ...zero },
      haiku: { ...zero },
      unknown: { ...zero },
    },
    bySkillByModel: {},
    bySkillWoW: {},
    byDispatchKind: emptyByDispatchKind(),
    attributedPercent: 0,
    quotaWeightLast5h: 0,
    quotaWeightLast7d: 0,
    quotaWeightCalibrated: false,
    weeklyQuotaTokens: 1000,
    fiveHourQuotaTokens: 100,
    filesScanned: 1,
    filesSkippedByMtime: 0,
    linesParsed: 1,
    linesWithUsage: 1,
    parseErrors: 0,
    generatedAt: NOW.toISOString(),
    cacheHitRatioLast5h: 0,
    cacheHitRatioLast7d: 0,
    tokensSinceReset: { ...zero },
    percentSinceReset: 0,
    weeklyResetAnchor: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("computeQuotaPoints — pure helper (current-only)", () => {
  const start = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);

  test("[] when no current snapshot", () => {
    assert.deepEqual(computeQuotaPoints(null, start, NOW), []);
  });

  test("returns single point with current snapshot", () => {
    const out = computeQuotaPoints(fakeSnapshot(), start, NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].v, 40);
  });

  test("drops the current snapshot when its timestamp falls outside the window", () => {
    const before = new Date(start.getTime() - 60_000).toISOString();
    const out = computeQuotaPoints(
      fakeSnapshot({ generatedAt: before, percentLast7d: 10 }),
      start,
      NOW,
    );
    assert.deepEqual(out, []);
  });

  test("keeps a current snapshot just inside the window", () => {
    const inside = new Date(start.getTime() + 60_000).toISOString();
    const out = computeQuotaPoints(
      fakeSnapshot({ generatedAt: inside, percentLast7d: 20 }),
      start,
      NOW,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].v, 20);
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

describe("getQuotaTrend — window boundary (current snapshot only)", () => {
  test("current snapshot just inside window is kept", async () => {
    const start = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const justInside = new Date(start.getTime() + 1_000).toISOString();
    const response = await getQuotaTrend(7, {
      now: NOW,
      readCurrentSnapshot: async () =>
        fakeSnapshot({ generatedAt: justInside, percentLast7d: 15 }),
    });
    assert.equal(response.percentBurned.points.length, 1);
    assert.equal(response.percentBurned.points[0].v, 15);
  });

  test("current snapshot just outside window is dropped", async () => {
    const start = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const justOutside = new Date(start.getTime() - 1_000).toISOString();
    const response = await getQuotaTrend(7, {
      now: NOW,
      readCurrentSnapshot: async () =>
        fakeSnapshot({ generatedAt: justOutside, percentLast7d: 15 }),
    });
    assert.deepEqual(response.percentBurned.points, []);
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
