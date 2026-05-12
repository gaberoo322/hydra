/**
 * Regression tests for the research capacity floor (issue #327).
 *
 * Bug: anchor distribution drifted to 19 user-request / 1 research over a
 * 20-cycle window. The scheduler had an upper bound (RESEARCH_BUILD_RATIO_MAX)
 * that throttled excess research, but no lower bound — so when the work
 * queue stayed full, research could be starved indefinitely and the target-
 * direction (research-driven) lane was effectively shadowed by user requests.
 *
 * Fix: add a symmetric RESEARCH_BUILD_RATIO_MIN (default 1/20). When the
 * rolling 24h research:build ratio drops below this floor AND the min
 * interval has elapsed AND the daily cost cap is not exhausted, force a
 * research cycle even if the queue would normally suppress it.
 *
 * These tests verify the pure helper `shouldTriggerResearchFloor` against
 * the acceptance criteria called out in issue #327:
 *
 * - AC5: `buildCount24h=100, researchCount24h=0, lastResearchAt > 2h ago`
 *   triggers the floor.
 * - AC6: `buildCount24h=10, researchCount24h=5` keeps the floor silent
 *   (natural ratio 0.5 is far above the 1/20 default).
 * - AC7: the daily cost cap always wins — when spend has hit the cap, the
 *   floor returns triggered=false with a `cost cap` reason.
 *
 * Also covers:
 * - min-interval gate: floor refuses to fire when min interval hasn't elapsed.
 * - fresh-scheduler guard: with zero build events recorded the floor stays
 *   silent (don't burn money on a brand-new instance).
 * - default value: RESEARCH_BUILD_RATIO_MIN exported as 1/20.
 * - status surface: getStatus() exposes `research.buildRatioMin` and
 *   `research.researchFloorTriggered`.
 *
 * Uses Redis DB 1 — never touches production (DB 0). The pure helper tests
 * don't touch Redis at all, only the status-surface test does.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

const schedulerMod = await import("../src/scheduler.ts");
const {
  shouldTriggerResearchFloor,
  RESEARCH_BUILD_RATIO_MIN,
  getStatus,
} = schedulerMod as any;

const HOUR_MS = 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * HOUR_MS;

let testRedis: any;

async function cleanKeys() {
  const keys = await testRedis.keys("hydra:*");
  if (keys.length > 0) await testRedis.del(...keys);
}

describe("research capacity floor (issue #327) — pure helper", () => {
  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------

  test("default RESEARCH_BUILD_RATIO_MIN is 1/20 (one research per 20 builds)", () => {
    assert.equal(RESEARCH_BUILD_RATIO_MIN, 1 / 20);
  });

  // -------------------------------------------------------------------------
  // AC5 — floor fires when ratio is below threshold + interval elapsed
  // -------------------------------------------------------------------------

  test("AC5: 100 builds / 0 research / lastResearch >2h ago — floor triggers", () => {
    const now = Date.now();
    const result = shouldTriggerResearchFloor(
      /* buildCount24h */ 100,
      /* researchCount24h */ 0,
      /* lastResearchAtMs */ now - 3 * HOUR_MS, // 3 hours ago
      /* dailySpendUsd */ 0,
      { now },
    );
    assert.equal(result.triggered, true, "floor should fire");
    assert.match(result.reason || "", /ratio.*0\.000.*floor/i, "reason should reference ratio");
  });

  test("floor fires with no prior research at all (lastResearchAtMs = null)", () => {
    const result = shouldTriggerResearchFloor(
      100,
      0,
      null, // never researched
      0,
    );
    assert.equal(result.triggered, true);
  });

  // -------------------------------------------------------------------------
  // AC6 — floor does NOT fire when natural rate is healthy
  // -------------------------------------------------------------------------

  test("AC6: 10 builds / 5 research — floor stays silent (natural ratio above min)", () => {
    const result = shouldTriggerResearchFloor(
      /* buildCount24h */ 10,
      /* researchCount24h */ 5,
      /* lastResearchAtMs */ Date.now() - 3 * HOUR_MS,
      /* dailySpendUsd */ 0,
    );
    assert.equal(result.triggered, false, "0.5 ratio is far above 1/20 floor");
    assert.match(result.reason || "", /natural ratio.*>=.*floor/i);
  });

  test("floor stays silent at exact threshold (ratio == ratioMin)", () => {
    // 20 builds, 1 research → ratio 0.05 == 1/20 floor (boundary case).
    const result = shouldTriggerResearchFloor(20, 1, Date.now() - 3 * HOUR_MS, 0);
    assert.equal(result.triggered, false, "boundary ratio should not trigger");
  });

  test("floor fires just below threshold (ratio < ratioMin)", () => {
    // 40 builds, 1 research → ratio 0.025, below 1/20 = 0.05 floor.
    const result = shouldTriggerResearchFloor(40, 1, Date.now() - 3 * HOUR_MS, 0);
    assert.equal(result.triggered, true);
  });

  // -------------------------------------------------------------------------
  // AC7 — daily cost cap always wins
  // -------------------------------------------------------------------------

  test("AC7: daily cost cap exhausted — floor returns triggered=false with cost-cap reason", () => {
    const result = shouldTriggerResearchFloor(
      /* buildCount24h */ 100,
      /* researchCount24h */ 0,
      /* lastResearchAtMs */ Date.now() - 3 * HOUR_MS,
      /* dailySpendUsd */ 50, // already at the cap
      { dailyCostCapUsd: 50, now: Date.now() },
    );
    assert.equal(result.triggered, false, "cost cap must always win");
    assert.match(result.reason || "", /cost cap reached/i);
  });

  test("AC7: spend just over cap — floor still suppressed", () => {
    const result = shouldTriggerResearchFloor(100, 0, Date.now() - 3 * HOUR_MS, 50.01, {
      dailyCostCapUsd: 50,
    });
    assert.equal(result.triggered, false);
  });

  test("AC7: spend just under cap — floor still fires", () => {
    const result = shouldTriggerResearchFloor(100, 0, Date.now() - 3 * HOUR_MS, 49.99, {
      dailyCostCapUsd: 50,
    });
    assert.equal(result.triggered, true);
  });

  // -------------------------------------------------------------------------
  // Min-interval gate — floor never violates the research throttle
  // -------------------------------------------------------------------------

  test("min interval gate: lastResearchAtMs too recent — floor suppressed", () => {
    const now = Date.now();
    const result = shouldTriggerResearchFloor(
      100,
      0,
      now - 30 * 60 * 1000, // only 30 min ago, well under default 2h
      0,
      { minIntervalMs: TWO_HOURS_MS, now },
    );
    assert.equal(result.triggered, false);
    assert.match(result.reason || "", /min interval not elapsed/i);
  });

  // -------------------------------------------------------------------------
  // Fresh-scheduler guard — never trip with zero build events
  // -------------------------------------------------------------------------

  test("fresh scheduler (buildCount24h=0) — floor stays silent", () => {
    const result = shouldTriggerResearchFloor(0, 0, null, 0);
    assert.equal(result.triggered, false, "must not burn research on empty history");
    assert.match(result.reason || "", /no build events/i);
  });

  // -------------------------------------------------------------------------
  // Negative-rate sanity: explicit non-zero ratioMin override
  // -------------------------------------------------------------------------

  test("custom ratioMin override is honored", () => {
    // ratio = 5/100 = 0.05. With ratioMin=0.1, this is below the floor.
    const result = shouldTriggerResearchFloor(100, 5, Date.now() - 3 * HOUR_MS, 0, {
      ratioMin: 0.1,
    });
    assert.equal(result.triggered, true);
  });
});

describe("research capacity floor — /api/scheduler/status surface (issue #327)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis("redis://localhost:6379/1");
    }
    await cleanKeys();
  });

  after(async () => {
    if (testRedis) {
      await cleanKeys();
      testRedis.disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // AC2 — /scheduler/status exposes buildRatioMin alongside buildRatioMax
  // -------------------------------------------------------------------------

  test("status response exposes research.buildRatioMin alongside buildRatioMax", async () => {
    const status = await getStatus();
    assert.ok("research" in status, "status should contain a research block");
    assert.ok(
      "buildRatioMin" in status.research,
      "research block should contain buildRatioMin",
    );
    assert.ok(
      "buildRatioMax" in status.research,
      "research block should contain buildRatioMax (existing)",
    );
    assert.equal(typeof status.research.buildRatioMin, "number");
    assert.equal(typeof status.research.buildRatioMax, "number");
    // Floor must be strictly below max — they bound opposite ends of the ratio.
    assert.ok(
      status.research.buildRatioMin < status.research.buildRatioMax,
      "buildRatioMin should be less than buildRatioMax",
    );
  });

  // -------------------------------------------------------------------------
  // AC4 — per-cycle metric researchFloorTriggered surfaced on status
  // -------------------------------------------------------------------------

  test("status response exposes research.researchFloorTriggered as a boolean", async () => {
    const status = await getStatus();
    assert.ok(
      "researchFloorTriggered" in status.research,
      "research block should contain researchFloorTriggered",
    );
    assert.equal(
      typeof status.research.researchFloorTriggered,
      "boolean",
      "researchFloorTriggered must be a boolean per AC4",
    );
  });
});
