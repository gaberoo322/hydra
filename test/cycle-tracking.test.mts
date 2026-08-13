/**
 * cycle-tracking.test.mts — listCycleIds() index-based enumeration (#3997).
 *
 * Regression coverage for the /cycle/history empty-results bug. listCycleIds()
 * previously MATCH-scanned `hydra:cycle:cycle-*` — a pattern no real key can
 * match, because live cycle keys are `hydra:cycle:<hex>` (e.g.
 * `hydra:cycle:aeef970d909cccd8a`, written by recordCycle → initCycleHash +
 * addCycleToIndex). The scan therefore returned `[]`, getCycleHistory iterated
 * nothing, and GET /api/cycle/history answered 200 `[]` while Redis held 118
 * real cycle records — a silent wrong answer.
 *
 * listCycleIds() now reads the `hydra:cycle:index` ZSET (ZREVRANGE), the single
 * source of truth populated alongside every cycle hash by addCycleToIndex in
 * src/autopilot/cycle-close.ts. That also makes ordering chronologically correct
 * (score = completion epoch) instead of the old lexical `.sort().reverse()`,
 * which assumed ISO-timestamp-shaped ids and is meaningless for the real hex
 * shape.
 *
 * This file owns its own Redis lifecycle (CLAUDE.md authoring rule): top-level
 * describes with before/after for the connection and beforeEach cleanup so no
 * case leaks hydra:cycle:* state into a sibling. REDIS_URL is pinned (falling
 * back to DB 1 for a bare single-file run) before any accessor binds the shared
 * connection singleton, which reads REDIS_URL lazily on first call.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { redisKeys } from "../src/redis/keys.ts";
import { listCycleIds } from "../src/redis/cycle-tracking.ts";
import { getCycleHistory } from "../src/cycle.ts";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

/**
 * Delete every hydra:cycle:* key the suite might have seeded — both the
 * per-cycle hashes and the index ZSET itself — so each case starts clean.
 */
async function cleanupCycleKeys(r: any): Promise<void> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await r.scan(cursor, "MATCH", "hydra:cycle:*", "COUNT", 200);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");
  if (keys.length > 0) await r.del(...keys);
}

describe("cycle-tracking.listCycleIds — index-based enumeration (#3997)", () => {
  before(async () => {
    redis = new Redis(REDIS_URL);
  });

  after(async () => {
    await cleanupCycleKeys(redis);
    redis.disconnect();
  });

  beforeEach(async () => {
    await cleanupCycleKeys(redis);
  });

  test("enumerates a hydra:cycle:<hex> id via the index (regression: the cycle-* SCAN missed it)", async () => {
    // Production cycle keys are hydra:cycle:<hex>, e.g. the issue's sampled
    // hydra:cycle:aeef970d909cccd8a. The old MATCH hydra:cycle:cycle-* pattern
    // cannot match this shape, so listCycleIds() returned [] and /cycle/history
    // silently reported zero cycles. The id MUST now be discoverable via the
    // index that recordCycle populates alongside the hash.
    const id = "aeef970d909cccd8a";
    await redis.hset(redisKeys.cycle(id), { status: "completed", total: "1", completed: "1" });
    await redis.zadd(redisKeys.cycleIndex(), 1700000000000, id);

    const ids = await listCycleIds();
    assert.deepEqual(ids, [id]);
  });

  test("returns ids newest-first by index SCORE, not by a lexical id sort", async () => {
    // The index is scored by completion epoch (addCycleToIndex in
    // cycle-close.ts). ZREVRANGE yields highest-score (newest) first, which for
    // hex ids is NOT the lexical-reverse order the old .sort().reverse() gave.
    // Pick ids + scores where lexical-reverse != score-descending to prove the
    // ordering is score-based.
    await redis.hset(redisKeys.cycle("aaaa0001"), { status: "completed" });
    await redis.hset(redisKeys.cycle("bbbb0002"), { status: "completed" });
    await redis.hset(redisKeys.cycle("cccc0003"), { status: "completed" });
    await redis.zadd(redisKeys.cycleIndex(), 1000, "aaaa0001"); // oldest
    await redis.zadd(redisKeys.cycleIndex(), 3000, "bbbb0002"); // newest
    await redis.zadd(redisKeys.cycleIndex(), 2000, "cccc0003"); // middle

    const ids = await listCycleIds();
    // Score-descending: bbbb(3000), cccc(2000), aaaa(1000).
    // Lexical-reverse would be cccc, bbbb, aaaa — deliberately different.
    assert.deepEqual(ids, ["bbbb0002", "cccc0003", "aaaa0001"]);
  });

  test("cannot match non-cycle sibling keys that share the hydra:cycle: prefix", async () => {
    // The active pointer (string), per-source active pointers (string), and the
    // index ZSET itself all live under hydra:cycle:*. A keyspace SCAN would hit
    // them and HGETALL would WRONGTYPE; reading the index enumerates only the
    // ZSET members, so none of those structural siblings leak in as cycle ids
    // (and none can crash the read). addCycleToIndex only ever stores a bare
    // cycleId, so the index never contains a sub-key-shaped member either.
    const id = "bef0c1a55e9d0";
    await redis.hset(redisKeys.cycle(id), { status: "completed" });
    await redis.zadd(redisKeys.cycleIndex(), 4000, id);

    // Structural sibling keys that share the prefix but are NOT cycle records.
    await redis.set(redisKeys.cycleActive(), "something"); // hydra:cycle:active (string)
    await redis.set(redisKeys.cycleActiveSource("claude"), id); // hydra:cycle:active:claude (string)
    // A second index member (the index ZSET already exists by construction).
    await redis.zadd(redisKeys.cycleIndex(), 5000, "deadbeef0001");

    const ids = await listCycleIds();
    // Only the two index members, newest-first by score; "active" / the index
    // key itself never appear as enumerated ids.
    assert.deepEqual(ids, ["deadbeef0001", id]);
  });

  test("returns [] when the index holds no cycle ids", async () => {
    const ids = await listCycleIds();
    assert.deepEqual(ids, []);
  });
});

describe("cycle.getCycleHistory — hex-shaped records via the index (#3997, AC1/AC2)", () => {
  before(async () => {
    redis = new Redis(REDIS_URL);
  });

  after(async () => {
    await cleanupCycleKeys(redis);
    redis.disconnect();
  });

  beforeEach(async () => {
    await cleanupCycleKeys(redis);
  });

  test("returns a hydra:cycle:<hex> record with parsed numeric fields (AC1/AC2)", async () => {
    // The exact shape from the issue's production sample: a hydra:cycle:<hex>
    // hash written through the recordCycle path (initCycleHash + addCycleToIndex).
    const id = "aeef970d909cccd8a";
    await redis.hset(redisKeys.cycle(id), {
      status: "completed",
      startedAt: "2026-08-10T18:00:00Z",
      completedAt: "2026-08-10T18:39:55Z",
      source: "claude",
      total: "7",
      completed: "5",
      failed: "1",
      abandoned: "1",
    });
    await redis.zadd(redisKeys.cycleIndex(), 1740000000000, id);

    const history = await getCycleHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].id, id);
    assert.equal(history[0].status, "completed");
    assert.equal(history[0].total, 7);
    assert.equal(history[0].completed, 5);
    assert.equal(history[0].failed, 1);
    assert.equal(history[0].abandoned, 1);
    // parseInt never leaks NaN through an absent numeric field.
    const rec: any = history[0];
    for (const k of ["total", "completed", "failed", "abandoned"]) {
      assert.ok(Number.isInteger(rec[k]), `${k} must be an integer, not NaN`);
    }
  });

  test("skips an indexed id whose hash is missing or lacks a status field", async () => {
    // good: indexed + has status.
    await redis.hset(redisKeys.cycle("good1"), { status: "completed", total: "1" });
    await redis.zadd(redisKeys.cycleIndex(), 3000, "good1");
    // indexed but hash absent (e.g. TTL-expired) -> skipped by the !status guard.
    await redis.zadd(redisKeys.cycleIndex(), 2000, "expired1");
    // indexed but hash has no status field -> skipped.
    await redis.hset(redisKeys.cycle("nostatus1"), { total: "9" });
    await redis.zadd(redisKeys.cycleIndex(), 1000, "nostatus1");

    const history = await getCycleHistory();
    assert.deepEqual(history.map((c: any) => c.id), ["good1"]);
  });

  test("honours the limit — never returns more than `limit` records", async () => {
    for (let i = 0; i < 5; i++) {
      const id = `hex${i.toString(16).padStart(4, "0")}`;
      await redis.hset(redisKeys.cycle(id), { status: "completed", total: String(i) });
      await redis.zadd(redisKeys.cycleIndex(), 1000 + i, id); // newer = higher score
    }
    const history = await getCycleHistory(2);
    assert.equal(history.length, 2, "must break after `limit` records");
    // Newest-first by score -> hex0004, hex0003.
    assert.deepEqual(history.map((c: any) => c.id), ["hex0004", "hex0003"]);
  });

  test("returns [] when the index is empty", async () => {
    const history = await getCycleHistory();
    assert.deepEqual(history, []);
  });
});
