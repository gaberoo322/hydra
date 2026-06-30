/**
 * test/wiring-liveness-output-series.test.mts — the per-source output-series
 * Redis seam (issue #2578).
 *
 * Self-contained top-level describe with its own lifecycle (CLAUDE.md
 * no-nested-shared-teardown rule). Uses real Redis db 2 (same convention as
 * test/bounded-list.test.mts). Pins the accessor's contract: append accumulates,
 * read returns MOST-RECENT-LAST (the order evaluateOutputs windows over),
 * source+jsonPath key independence, the bounded cap, and non-numeric tolerance.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/2";

const { appendOutputObservation, readOutputSeries } = await import(
  "../src/redis/wiring-liveness-output-series.ts"
);
const { closeRedisConnections } = await import("../src/redis/connection.ts");

const SOURCE = "/api/scanner/latest";
const JSON_PATH = "funnelBreakdown.registryPairs";
const KEY = `hydra:wiring-liveness:output-series:${SOURCE}:${JSON_PATH}`;
const OTHER_PATH_KEY = `hydra:wiring-liveness:output-series:${SOURCE}:other.path`;

let raw: any;
async function rawRedis() {
  if (!raw) raw = new Redis(process.env.REDIS_URL);
  return raw;
}

after(async () => {
  if (raw) {
    await raw.del(KEY);
    await raw.del(OTHER_PATH_KEY);
    raw.disconnect();
  }
  closeRedisConnections();
});

describe("redis/wiring-liveness-output-series", () => {
  beforeEach(async () => {
    const r = await rawRedis();
    await r.del(KEY);
    await r.del(OTHER_PATH_KEY);
  });

  test("appends accumulate and read returns MOST-RECENT-LAST", async () => {
    await appendOutputObservation(SOURCE, JSON_PATH, 3);
    await appendOutputObservation(SOURCE, JSON_PATH, 5);
    await appendOutputObservation(SOURCE, JSON_PATH, 7);
    // Oldest-first, so a trailing slice(-runs) takes the freshest window.
    assert.deepEqual(await readOutputSeries(SOURCE, JSON_PATH), [3, 5, 7]);
  });

  test("an unseen source reads back as an empty series", async () => {
    assert.deepEqual(await readOutputSeries(SOURCE, JSON_PATH), []);
  });

  test("different jsonPaths off the same source keep independent series", async () => {
    await appendOutputObservation(SOURCE, JSON_PATH, 1);
    await appendOutputObservation(SOURCE, "other.path", 99);
    assert.deepEqual(await readOutputSeries(SOURCE, JSON_PATH), [1]);
    assert.deepEqual(await readOutputSeries(SOURCE, "other.path"), [99]);
  });

  test("the series is bounded (cap 16) and keeps the freshest window", async () => {
    for (let i = 1; i <= 20; i++) await appendOutputObservation(SOURCE, JSON_PATH, i);
    const series = await readOutputSeries(SOURCE, JSON_PATH);
    assert.equal(series.length, 16);
    // Most-recent-last: the freshest is 20, the oldest retained is 5.
    assert.equal(series[series.length - 1], 20);
    assert.equal(series[0], 5);
  });

  test("non-numeric stored members are filtered out on read", async () => {
    const r = await rawRedis();
    // Mix a string + null into the raw list (newest-first), plus valid numbers.
    await r.lpush(KEY, JSON.stringify(2));
    await r.lpush(KEY, JSON.stringify("oops"));
    await r.lpush(KEY, JSON.stringify(null));
    await r.lpush(KEY, JSON.stringify(8));
    // Raw list newest-first: [8, null, "oops", 2] -> numeric oldest-first: [2, 8].
    assert.deepEqual(await readOutputSeries(SOURCE, JSON_PATH), [2, 8]);
  });
});
