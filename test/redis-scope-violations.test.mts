/**
 * Unit tests for the scope-violation counter Redis seam
 * (`src/redis/scope-violations.ts`, issue #732) — slice of #2972.
 *
 * Covers the pure `utcDateKey` helper, the INT increment + TTL stamp of
 * `incrScopeViolation`, and the newest-first / missing-days-as-0 / pipelined
 * read of `getScopeViolationsByDay`. The daily keys are UTC-date-bucketed
 * (`hydra:metrics:scope-violations:daily:<date>`); the suite seeds and cleans
 * a fixed set of far-future sentinel dates so it never collides with a real
 * counter and never FLUSHDBs the run-shared test DB.
 *
 * REDIS_URL is set by the test launcher to a per-worktree DB (never DB 0).
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  incrScopeViolation,
  getScopeViolationsByDay,
  utcDateKey,
} = await import("../src/redis/scope-violations.ts");

const keyFor = (date: string) => `hydra:metrics:scope-violations:daily:${date}`;

// Far-future sentinel dates — never a real counter, so seeding/cleaning them
// cannot disturb production-shaped data even if a run pointed at DB 0.
const SENTINEL_DATES = ["2999-01-01", "2999-01-02", "2999-01-03", "2999-01-04"];

describe("redis/scope-violations — utcDateKey (pure)", () => {
  test("formats UTC YYYY-MM-DD with zero-padding", () => {
    assert.equal(utcDateKey(new Date("2026-03-05T12:00:00Z")), "2026-03-05");
    assert.equal(utcDateKey(new Date("2026-11-30T23:59:59Z")), "2026-11-30");
  });

  test("uses UTC, not local time, at a day boundary", () => {
    // 2026-01-01T00:30:00Z is still Jan 1 in UTC regardless of the host TZ.
    assert.equal(utcDateKey(new Date("2026-01-01T00:30:00Z")), "2026-01-01");
  });
});

describe("redis/scope-violations — counter seam", () => {
  let raw: any;

  before(() => {
    raw = new Redis(process.env.REDIS_URL as string);
  });

  // Per-case reset: increments accumulate on the same date key, so a sibling
  // case would read a prior case's total without a fresh-per-case clean.
  beforeEach(async () => {
    await raw.del(...SENTINEL_DATES.map(keyFor));
  });

  after(async () => {
    await raw.del(...SENTINEL_DATES.map(keyFor));
    raw.disconnect();
  });

  test("incr returns the running total and defaults by=1", async () => {
    const d = SENTINEL_DATES[0];
    assert.equal(await incrScopeViolation(d), 1);
    assert.equal(await incrScopeViolation(d), 2);
    assert.equal(await incrScopeViolation(d, 3), 5);
  });

  test("incr stamps a bounded 90-day TTL", async () => {
    const d = SENTINEL_DATES[0];
    await incrScopeViolation(d);
    const ttl = await raw.ttl(keyFor(d));
    const NINETY_DAYS = 90 * 24 * 60 * 60;
    assert.ok(
      ttl > 0 && ttl <= NINETY_DAYS,
      `TTL should be 1..${NINETY_DAYS}, got ${ttl}`,
    );
  });

  test("getByDay returns counts newest-first ending at `now`", async () => {
    // now = day[0]; day[1] = yesterday, day[2] = two days ago.
    const now = new Date(`${SENTINEL_DATES[0]}T12:00:00Z`);
    await incrScopeViolation(SENTINEL_DATES[0], 2); // today
    // yesterday of 2999-01-01 is 2998-12-31 — seed the actual prior date keys.
    const yesterday = utcDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const twoAgo = utcDateKey(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000));
    await raw.set(keyFor(yesterday), "7");
    await raw.set(keyFor(twoAgo), "0");
    try {
      const rows = await getScopeViolationsByDay(3, now);
      assert.equal(rows.length, 3);
      // Newest-first.
      assert.deepEqual(rows[0], { date: SENTINEL_DATES[0], count: 2 });
      assert.deepEqual(rows[1], { date: yesterday, count: 7 });
      assert.deepEqual(rows[2], { date: twoAgo, count: 0 });
    } finally {
      await raw.del(keyFor(yesterday), keyFor(twoAgo));
    }
  });

  test("getByDay reads a missing day as 0", async () => {
    const now = new Date(`${SENTINEL_DATES[0]}T12:00:00Z`);
    const rows = await getScopeViolationsByDay(1, now);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { date: SENTINEL_DATES[0], count: 0 });
  });

  test("getByDay floors a fractional `days` and clamps to at least 1", async () => {
    const now = new Date(`${SENTINEL_DATES[0]}T12:00:00Z`);
    assert.equal((await getScopeViolationsByDay(2.9, now)).length, 2);
    assert.equal((await getScopeViolationsByDay(0, now)).length, 1);
  });
});
