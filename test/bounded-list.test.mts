/**
 * test/bounded-list.test.mts — pin the ADR-0017 Category-C shared primitive:
 * push=lpush+ltrim(0,max-1) (newest-first), read=lrange+tolerant JSON.parse
 * (skip corrupt), clear=del. Uses real Redis db 2 (same convention as the
 * other Redis-backed tests).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/2";

const { boundedJsonList } = await import("../src/redis/bounded-list.ts");
const { closeRedisConnections } = await import("../src/redis/connection.ts");

const KEY = "hydra:test:bounded-list";
let raw: any;

async function rawRedis() {
  if (!raw) raw = new Redis(process.env.REDIS_URL);
  return raw;
}

after(async () => {
  if (raw) {
    await raw.del(KEY);
    raw.disconnect();
  }
  closeRedisConnections();
});

describe("boundedJsonList", () => {
  beforeEach(async () => {
    const r = await rawRedis();
    await r.del(KEY);
  });

  test("push is newest-first and read returns newest-first", async () => {
    const list = boundedJsonList<{ n: number }>(KEY, 10);
    await list.push({ n: 1 });
    await list.push({ n: 2 });
    await list.push({ n: 3 });
    const entries = await list.read();
    assert.deepEqual(entries.map(e => e.n), [3, 2, 1]);
  });

  test("push trims to max (ltrim 0, max-1)", async () => {
    const list = boundedJsonList<number>(KEY, 3);
    for (const n of [1, 2, 3, 4, 5]) await list.push(n);
    const r = await rawRedis();
    const len = await r.llen(KEY);
    assert.equal(len, 3);
    assert.deepEqual(await list.read(), [5, 4, 3]);
  });

  test("read honours an explicit limit", async () => {
    const list = boundedJsonList<number>(KEY, 10);
    for (const n of [1, 2, 3, 4]) await list.push(n);
    assert.deepEqual(await list.read(2), [4, 3]);
  });

  test("read tolerates corrupt entries by skipping them", async () => {
    const r = await rawRedis();
    // Newest-first: a valid entry, then a corrupt one, then valid.
    await r.lpush(KEY, JSON.stringify({ ok: 1 }));
    await r.lpush(KEY, "{not valid json");
    await r.lpush(KEY, JSON.stringify({ ok: 2 }));
    const list = boundedJsonList<{ ok: number }>(KEY, 10);
    const entries = await list.read();
    assert.deepEqual(entries.map(e => e.ok), [2, 1]);
  });

  test("clear deletes the list", async () => {
    const list = boundedJsonList<number>(KEY, 10);
    await list.push(1);
    await list.clear();
    assert.deepEqual(await list.read(), []);
  });
});
