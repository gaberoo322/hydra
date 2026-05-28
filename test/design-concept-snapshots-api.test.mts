/**
 * Regression tests for `GET /api/design-concepts/snapshots` (issue #628).
 *
 * The endpoint reads the `hydra:dc:daily-snapshot` HASH written by the
 * scheduler's daily tick and exposes:
 *
 *   - `snapshots[]` newest-first (`{date, count}`)
 *   - `consecutiveGreenDays` — non-zero days from newest backward
 *   - `indexSizeNow` — current ZCARD of `hydra:design-concept:index`
 *   - `greenLightReady` — `consecutiveGreenDays >= 7` (the trigger for
 *     filing Phase C of #437)
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

const { createDesignConceptsRouter } = await import(
  "../src/api/design-concepts.ts"
);
const dcRedisMod = await import("../src/redis/design-concept.ts");

const SNAPSHOT_KEY = "hydra:dc:daily-snapshot";
const DC_INDEX_KEY = "hydra:design-concept:index";

let testRedis: any;
let server: any;
let baseUrl: string;

async function startApi(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api", createDesignConceptsRouter());
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve(baseUrl);
    });
  });
}

async function stopApi(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server = null;
}

async function cleanAll() {
  await testRedis.del(SNAPSHOT_KEY);
  await testRedis.del(DC_INDEX_KEY);
}

describe("GET /api/design-concepts/snapshots (#628)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
    await cleanAll();
  });

  after(async () => {
    if (testRedis) {
      await cleanAll();
      testRedis.disconnect();
    }
    await stopApi();
    const { closeRedisConnections } = await import(
      "../src/redis/connection.ts"
    );
    closeRedisConnections();
  });

  test("empty HASH → snapshots:[], consecutiveGreenDays:0, greenLightReady:false", async () => {
    await startApi();
    const res = await fetch(`${baseUrl}/api/design-concepts/snapshots`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.snapshots, []);
    assert.equal(body.consecutiveGreenDays, 0);
    assert.equal(body.indexSizeNow, 0);
    assert.equal(body.greenLightReady, false);
  });

  test("7 consecutive non-zero days → greenLightReady:true", async () => {
    await startApi();
    const days = [
      "2026-05-26", "2026-05-25", "2026-05-24", "2026-05-23",
      "2026-05-22", "2026-05-21", "2026-05-20",
    ];
    for (let i = 0; i < days.length; i += 1) {
      await dcRedisMod.writeDailySnapshot(days[i], i + 1);
    }
    // Seed the index too, so indexSizeNow is non-zero.
    await testRedis.zadd(DC_INDEX_KEY, 1, "issue-1", 2, "issue-2");

    const res = await fetch(`${baseUrl}/api/design-concepts/snapshots`);
    const body = await res.json();
    assert.equal(body.snapshots.length, 7);
    assert.equal(body.snapshots[0].date, "2026-05-26");
    assert.equal(body.consecutiveGreenDays, 7);
    assert.equal(body.greenLightReady, true);
    assert.equal(body.indexSizeNow, 2);
  });

  test("6 consecutive days → NOT yet green-light", async () => {
    await startApi();
    const days = [
      "2026-05-26", "2026-05-25", "2026-05-24",
      "2026-05-23", "2026-05-22", "2026-05-21",
    ];
    for (let i = 0; i < days.length; i += 1) {
      await dcRedisMod.writeDailySnapshot(days[i], 1);
    }
    const res = await fetch(`${baseUrl}/api/design-concepts/snapshots`);
    const body = await res.json();
    assert.equal(body.consecutiveGreenDays, 6);
    assert.equal(body.greenLightReady, false);
  });

  test("zero in the middle resets the streak (counts from newest non-zero run)", async () => {
    await startApi();
    // Newest-first: 26, 25 (non-zero); 24 (zero); 23..20 (non-zero — but
    // those don't count once we hit the zero walking backwards).
    await dcRedisMod.writeDailySnapshot("2026-05-26", 3);
    await dcRedisMod.writeDailySnapshot("2026-05-25", 2);
    await dcRedisMod.writeDailySnapshot("2026-05-24", 0);
    await dcRedisMod.writeDailySnapshot("2026-05-23", 1);
    await dcRedisMod.writeDailySnapshot("2026-05-22", 1);

    const res = await fetch(`${baseUrl}/api/design-concepts/snapshots`);
    const body = await res.json();
    assert.equal(body.consecutiveGreenDays, 2);
    assert.equal(body.greenLightReady, false);
  });
});
