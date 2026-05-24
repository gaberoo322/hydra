/**
 * Regression tests for `src/scout/stats.ts` and the
 * `GET /api/scout/stats` rollup (issue #485 — Phase B).
 *
 * Coverage:
 *
 *  1. incrStat — basic increment + idempotent re-write.
 *  2. incrStat — TTL set on first write (key expires after 14d).
 *  3. getStatsRollup — aggregates last N days across categories.
 *  4. getStatsRollup — clamps window to [1, MAX_ROLLUP_WINDOW_DAYS].
 *  5. Unknown metric throws RangeError.
 *  6. toIsoDay is UTC.
 */

import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

const {
  incrStat,
  getStatsRollup,
  toIsoDay,
  MAX_ROLLUP_WINDOW_DAYS,
} = await import("../src/scout/stats.ts");

let testRedis: any = null;
function getTestRedis(): any {
  if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
  return testRedis;
}

async function cleanScoutStats(): Promise<void> {
  const r = getTestRedis();
  const keys = await r.keys("hydra:scout:stats:*");
  if (keys.length > 0) await r.del(...keys);
}

after(async () => {
  if (testRedis && testRedis.status !== "end") {
    testRedis.disconnect();
    testRedis = null;
  }
  try {
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  } catch (err) {
    console.error("scout-stats teardown: closeRedisConnections failed", err);
  }
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("scout-stats", () => {
  beforeEach(async () => {
    await cleanScoutStats();
  });

  test("toIsoDay returns UTC YYYY-MM-DD", () => {
    assert.equal(toIsoDay(new Date("2026-05-19T03:00:00Z")), "2026-05-19");
    // Late-night UTC stays on the same day even from a non-UTC locale clock.
    assert.equal(toIsoDay(new Date("2026-05-19T23:30:00Z")), "2026-05-19");
    // Wraps into next day at midnight UTC.
    assert.equal(toIsoDay(new Date("2026-05-20T00:00:01Z")), "2026-05-20");
  });

  test("incrStat increments a single (category, metric) on the right day", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    const n1 = await incrStat("typed-schemas", "candidates", 3, now);
    const n2 = await incrStat("typed-schemas", "candidates", 2, now);
    assert.equal(n1, 3);
    assert.equal(n2, 5);

    const r = getTestRedis();
    const stored = await r.hget("hydra:scout:stats:2026-05-19", "typed-schemas:candidates");
    assert.equal(stored, "5");
  });

  test("incrStat sets a 14-day TTL on the day-hash", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    await incrStat("typed-schemas", "filed", 1, now);
    const r = getTestRedis();
    const ttl = await r.ttl("hydra:scout:stats:2026-05-19");
    // Between 13d and 14d (clock drift tolerant — TTL is at most 14d * 86400s).
    assert.ok(ttl > 13 * 86400, `expected TTL > 13d, got ${ttl}s`);
    assert.ok(ttl <= 14 * 86400, `expected TTL <= 14d, got ${ttl}s`);
  });

  test("incrStat rejects unknown metric", async () => {
    await assert.rejects(
      () => incrStat("typed-schemas", "junk" as any, 1, new Date()),
      RangeError,
    );
  });

  test("incrStat rejects empty category", async () => {
    await assert.rejects(
      () => incrStat("", "candidates", 1, new Date()),
      TypeError,
    );
  });

  test("getStatsRollup aggregates last 7 days across days + categories", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    // Today: 5 candidates / 2 filed for typed-schemas, 1 rejected for structured-errors.
    await incrStat("typed-schemas", "candidates", 5, now);
    await incrStat("typed-schemas", "filed", 2, now);
    await incrStat("structured-errors", "rejected", 1, now);
    // 3 days ago: 2 candidates for typed-schemas.
    await incrStat("typed-schemas", "candidates", 2, new Date(now.getTime() - 3 * MS_PER_DAY));
    // 10 days ago: outside the 7d window.
    await incrStat("typed-schemas", "candidates", 99, new Date(now.getTime() - 10 * MS_PER_DAY));

    const rollup = await getStatsRollup(7, now);
    assert.equal(rollup["typed-schemas"].candidates, 7); // 5 + 2, NOT 7+99
    assert.equal(rollup["typed-schemas"].filed, 2);
    assert.equal(rollup["structured-errors"].rejected, 1);
    // Buckets exist with zero-defaults for untouched metrics.
    assert.equal(rollup["typed-schemas"].rejected, 0);
    assert.equal(rollup["structured-errors"].candidates, 0);
  });

  test("getStatsRollup clamps window to MAX_ROLLUP_WINDOW_DAYS", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    // 1000 should not crash — clamped to MAX_ROLLUP_WINDOW_DAYS (14).
    const rollup = await getStatsRollup(1000, now);
    assert.equal(typeof rollup, "object");
    // No data → empty map.
    assert.equal(Object.keys(rollup).length, 0);
  });

  test("getStatsRollup clamps window to >= 1", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    await incrStat("typed-schemas", "candidates", 4, now);
    const rollup = await getStatsRollup(0, now);
    // Clamped to 1 → today only.
    assert.equal(rollup["typed-schemas"].candidates, 4);
  });

  test("MAX_ROLLUP_WINDOW_DAYS exported and matches the TTL", () => {
    assert.equal(MAX_ROLLUP_WINDOW_DAYS, 14);
  });
});
