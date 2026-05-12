/**
 * Regression tests for the research capacity floor (issue #327).
 *
 * Bug: the scheduler's `buildRatioMax` ceiling capped research from above,
 * but no symmetric floor protected research from being out-competed by an
 * always-full build queue. Production reported 1 research / 125 builds in
 * 24h — a 0.008 realised ratio against an intended self-improvement / new
 * opportunity cadence of at least 1:20 (0.05).
 *
 * Fix: introduce a `buildRatioMin` floor. When the realised 24h research:build
 * ratio is below the minimum AND enough builds have happened to make the
 * judgement meaningful, the scheduler forces a research cycle on the next
 * tick — overriding the queue-depth and ratio-cap suppressions, but never
 * bypassing the min-interval throttle or the daily cost cap.
 *
 * This file covers the *pure* predicate + Redis-backed state. The wiring
 * inside `maybeRunResearch` is covered indirectly via predicate behaviour;
 * we don't spin up the full cycle harness here because the existing
 * scheduler-status / scheduler-atomicity test files already exercise the
 * surrounding plumbing.
 *
 * Uses Redis DB 1 — never touches production (DB 0).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

const floorMod = await import("../src/scheduler-research-floor.ts");
const {
  shouldForceResearchFloor,
  getResearchBuildRatioMin,
  getResearchFloorWindow,
  DEFAULT_RESEARCH_BUILD_RATIO_MIN,
  DEFAULT_RESEARCH_FLOOR_WINDOW,
  RESEARCH_FLOOR_EMPTY_STREAK_THRESHOLD,
  incrResearchFloorEmptyStreak,
  resetResearchFloorEmptyStreak,
  getResearchFloorEmptyStreak,
  setResearchFloorSuppressedUntilMs,
  getResearchFloorSuppressedUntilMs,
  recordResearchFloorTriggered,
  getResearchFloorStats,
  _resetResearchFloorForTests,
} = floorMod as any;

let testRedis: any;

async function cleanFloorKeys() {
  const keys = await testRedis.keys("hydra:scheduler:research-floor:*");
  if (keys.length > 0) await testRedis.del(...keys);
}

describe("research capacity floor (issue #327)", () => {
  beforeEach(async () => {
    if (!testRedis) {
      testRedis = new Redis("redis://localhost:6379/1");
    }
    await cleanFloorKeys();
    await _resetResearchFloorForTests();
  });

  after(async () => {
    if (testRedis) {
      await cleanFloorKeys();
      testRedis.disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------

  describe("defaults", () => {
    test("DEFAULT_RESEARCH_BUILD_RATIO_MIN is 1/20", () => {
      assert.equal(DEFAULT_RESEARCH_BUILD_RATIO_MIN, 1 / 20);
    });

    test("DEFAULT_RESEARCH_FLOOR_WINDOW is 20", () => {
      assert.equal(DEFAULT_RESEARCH_FLOOR_WINDOW, 20);
    });

    test("getResearchBuildRatioMin reads env override", () => {
      assert.equal(getResearchBuildRatioMin({ HYDRA_RESEARCH_BUILD_RATIO_MIN: "0.1" }), 0.1);
    });

    test("getResearchBuildRatioMin falls back to default on garbage input", () => {
      // Negative, zero, NaN, >1, missing — all fall back to default.
      assert.equal(getResearchBuildRatioMin({ HYDRA_RESEARCH_BUILD_RATIO_MIN: "-1" }), DEFAULT_RESEARCH_BUILD_RATIO_MIN);
      assert.equal(getResearchBuildRatioMin({ HYDRA_RESEARCH_BUILD_RATIO_MIN: "0" }), DEFAULT_RESEARCH_BUILD_RATIO_MIN);
      assert.equal(getResearchBuildRatioMin({ HYDRA_RESEARCH_BUILD_RATIO_MIN: "nope" }), DEFAULT_RESEARCH_BUILD_RATIO_MIN);
      assert.equal(getResearchBuildRatioMin({ HYDRA_RESEARCH_BUILD_RATIO_MIN: "2" }), DEFAULT_RESEARCH_BUILD_RATIO_MIN);
      assert.equal(getResearchBuildRatioMin({}), DEFAULT_RESEARCH_BUILD_RATIO_MIN);
    });

    test("getResearchFloorWindow reads env override", () => {
      assert.equal(getResearchFloorWindow({ HYDRA_RESEARCH_FLOOR_WINDOW: "50" }), 50);
      assert.equal(getResearchFloorWindow({ HYDRA_RESEARCH_FLOOR_WINDOW: "0" }), DEFAULT_RESEARCH_FLOOR_WINDOW);
    });
  });

  // -------------------------------------------------------------------------
  // Pure predicate: shouldForceResearchFloor
  // -------------------------------------------------------------------------

  describe("shouldForceResearchFloor", () => {
    // AC: with buildCount24h=100, researchCount24h=0 → fire
    test("AC: fires when 100 builds, 0 research in 24h", () => {
      const d = shouldForceResearchFloor({ researchCount24h: 0, buildCount24h: 100 });
      assert.equal(d.shouldFire, true);
      assert.match(d.reason, /ratio 0\.000 < floor 0\.050/);
    });

    // AC: with buildCount24h=10, researchCount24h=5 → does NOT fire (ratio 0.5 well above 0.05)
    test("AC: does not fire when natural ratio is healthy (10 builds, 5 research)", () => {
      const d = shouldForceResearchFloor({ researchCount24h: 5, buildCount24h: 10 });
      // Two reasons it shouldn't fire: not enough builds yet (10 < 20 default),
      // and the natural ratio is already well above the floor. Either is a
      // pass — the contract is just "shouldFire === false".
      assert.equal(d.shouldFire, false);
    });

    test("does not fire when buildCount < floorWindow (insufficient sample)", () => {
      const d = shouldForceResearchFloor({ researchCount24h: 0, buildCount24h: 5, floorWindow: 20 });
      assert.equal(d.shouldFire, false);
      assert.match(d.reason, /not enough builds yet/);
    });

    test("fires at exact floor window when ratio < min", () => {
      // 20 builds, 0 research — boundary case for the window check.
      const d = shouldForceResearchFloor({
        researchCount24h: 0,
        buildCount24h: 20,
        floorWindow: 20,
        ratioMin: 0.05,
      });
      assert.equal(d.shouldFire, true);
    });

    test("does not fire when realised ratio equals floor", () => {
      // 20 builds, 1 research → ratio 0.05 == floor 0.05 → not below, do not fire.
      const d = shouldForceResearchFloor({
        researchCount24h: 1,
        buildCount24h: 20,
        floorWindow: 20,
        ratioMin: 0.05,
      });
      assert.equal(d.shouldFire, false);
      assert.match(d.reason, /natural ratio.*>= floor/);
    });

    test("does not fire when suppressedUntilMs is in the future", () => {
      const futureMs = Date.now() + 60_000;
      const d = shouldForceResearchFloor({
        researchCount24h: 0,
        buildCount24h: 100,
        suppressedUntilMs: futureMs,
      });
      assert.equal(d.shouldFire, false);
      assert.match(d.reason, /suppressed/);
    });

    test("DOES fire when suppressedUntilMs is in the past (expired)", () => {
      const pastMs = Date.now() - 60_000;
      const d = shouldForceResearchFloor({
        researchCount24h: 0,
        buildCount24h: 100,
        suppressedUntilMs: pastMs,
      });
      assert.equal(d.shouldFire, true);
    });

    test("reproduces production starvation scenario: 125 builds, 1 research", () => {
      // Issue #327 specific evidence: ratio 0.008, way below 0.05 floor.
      const d = shouldForceResearchFloor({ researchCount24h: 1, buildCount24h: 125 });
      assert.equal(d.shouldFire, true);
    });
  });

  // -------------------------------------------------------------------------
  // Empty-streak suppression accounting
  // -------------------------------------------------------------------------

  describe("empty-streak suppression", () => {
    test("incrResearchFloorEmptyStreak returns increasing counts", async () => {
      assert.equal(await incrResearchFloorEmptyStreak(), 1);
      assert.equal(await incrResearchFloorEmptyStreak(), 2);
      assert.equal(await getResearchFloorEmptyStreak(), 2);
    });

    test("reset clears the streak", async () => {
      await incrResearchFloorEmptyStreak();
      await incrResearchFloorEmptyStreak();
      await resetResearchFloorEmptyStreak();
      assert.equal(await getResearchFloorEmptyStreak(), 0);
    });

    test("RESEARCH_FLOOR_EMPTY_STREAK_THRESHOLD is 2 (two empty cycles trip suppression)", () => {
      assert.equal(RESEARCH_FLOOR_EMPTY_STREAK_THRESHOLD, 2);
    });

    test("setResearchFloorSuppressedUntilMs stores and reads back", async () => {
      const deadline = Date.now() + 24 * 60 * 60 * 1000;
      await setResearchFloorSuppressedUntilMs(deadline);
      const got = await getResearchFloorSuppressedUntilMs();
      assert.equal(got, deadline);
    });

    test("getResearchFloorSuppressedUntilMs returns null for expired suppression", async () => {
      const pastDeadline = Date.now() - 1000;
      await setResearchFloorSuppressedUntilMs(pastDeadline);
      const got = await getResearchFloorSuppressedUntilMs();
      assert.equal(got, null);
    });
  });

  // -------------------------------------------------------------------------
  // Stats aggregation (the /api/scheduler/status surface)
  // -------------------------------------------------------------------------

  describe("getResearchFloorStats", () => {
    test("returns zero counters on fresh state", async () => {
      const stats = await getResearchFloorStats();
      assert.equal(stats.triggered, 0);
      assert.equal(stats.lastTriggeredAt, null);
      assert.equal(stats.emptyStreak, 0);
      assert.equal(stats.suppressedUntilMs, null);
      assert.equal(stats.ratioMin, DEFAULT_RESEARCH_BUILD_RATIO_MIN);
      assert.equal(stats.floorWindow, DEFAULT_RESEARCH_FLOOR_WINDOW);
    });

    test("recordResearchFloorTriggered increments and timestamps", async () => {
      await recordResearchFloorTriggered();
      await recordResearchFloorTriggered();
      const stats = await getResearchFloorStats();
      assert.equal(stats.triggered, 2);
      assert.ok(stats.lastTriggeredAt, "lastTriggeredAt should be ISO timestamp");
      assert.doesNotThrow(() => new Date(stats.lastTriggeredAt).toISOString());
    });

    test("surfaces emptyStreak and suppressedUntilMs", async () => {
      const deadline = Date.now() + 60_000;
      await incrResearchFloorEmptyStreak();
      await setResearchFloorSuppressedUntilMs(deadline);
      const stats = await getResearchFloorStats();
      assert.equal(stats.emptyStreak, 1);
      assert.equal(stats.suppressedUntilMs, deadline);
    });
  });
});
