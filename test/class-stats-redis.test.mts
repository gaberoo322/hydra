/**
 * Regression tests for the class-stats snapshot Redis seam
 * (`src/redis/class-stats.ts`, issue #2943).
 *
 *   - put → get round-trips the scoreboard JSON;
 *   - a TTL is applied on write (self-expiring cache);
 *   - a missing key reads back null (recompute path);
 *   - a malformed value reads back null (never throws).
 *
 * Uses Redis DB 1 — never touches production (DB 0). Own top-level describe
 * with its own before/after lifecycle (CLAUDE.md shared-Redis teardown rule).
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

import {
  putClassScoreboard,
  getClassScoreboard,
  classStatsKey,
  CLASS_STATS_TTL_SECONDS,
} from "../src/redis/class-stats.ts";
import {
  computeClassScoreboard,
  type ClassScoreboard,
} from "../src/autopilot/class-stats-math.ts";

const NOW = 1_800_000_000_000;

function sampleBoard(): ClassScoreboard {
  return computeClassScoreboard([], { metrics: [] }, { now: NOW });
}

describe("class-stats Redis seam (issue #2943)", () => {
  // Typed `any` (not `Redis`) so `redis.ttl(...)` resolves — ioredis's
  // declaration-merged command methods (`ttl`/`pttl`/`expire`) do not surface on
  // the concrete `Redis` type under `tsconfig.test.json`, so a `Redis`-typed
  // handle trips TS2339. Every other TTL-asserting test here (dispatches,
  // cost-surrogate, backlog-stale-claim-reaper) uses the same `any` pattern.
  let redis: any;

  before(() => {
    redis = new Redis(REDIS_URL);
  });

  beforeEach(async () => {
    await redis.del(classStatsKey());
  });

  after(async () => {
    await redis.del(classStatsKey());
    redis.disconnect();
  });

  test("put → get round-trips the scoreboard", async () => {
    const board = sampleBoard();
    const put = await putClassScoreboard(board);
    assert.equal(put.ok, true);
    const got = await getClassScoreboard();
    assert.ok(got, "scoreboard reads back");
    assert.equal(got!.computedAt, NOW);
    assert.equal(got!.classes.length, board.classes.length);
  });

  test("a TTL is applied on write (self-expiring cache)", async () => {
    await putClassScoreboard(sampleBoard());
    const ttl = await redis.ttl(classStatsKey());
    assert.ok(ttl > 0, "TTL set");
    assert.ok(ttl <= CLASS_STATS_TTL_SECONDS, "TTL within the configured window");
  });

  test("a missing key reads back null (recompute path)", async () => {
    const got = await getClassScoreboard();
    assert.equal(got, null);
  });

  test("a malformed value reads back null, never throws", async () => {
    await redis.set(classStatsKey(), "{not json");
    const got = await getClassScoreboard();
    assert.equal(got, null);
  });
});
