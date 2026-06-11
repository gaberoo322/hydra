/**
 * Regression tests for `GET /api/design-concepts/snapshots` (issue #628).
 *
 * The endpoint reads the `hydra:dc:daily-snapshot` HASH written by the
 * scheduler's daily tick and exposes:
 *
 *   - `snapshots[]` newest-first (`{date, count}`) — `count` is the
 *     per-day PRODUCTION count since #736 (was index ZCARD)
 *   - `consecutiveGreenDays` — non-zero days from newest backward (legacy
 *     visibility field; no longer gates)
 *   - `greenDaysInWindow` / `windowDays` / `requiredGreenDays` — the
 *     idle-tolerant criterion introduced in #736
 *   - `indexSizeNow` — current ZCARD of `hydra:design-concept:index`
 *   - `greenLightReady` — `greenDaysInWindow >= requiredGreenDays`
 *     (≥7 of the last 10 days produced a concept; the trigger for filing
 *     Phase C of #437). Idle-tolerant per #736 so a quiet day is neutral.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

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
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
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

  test("zero in the middle resets consecutiveGreenDays (legacy field) but not green-light", async () => {
    await startApi();
    // Newest-first: 26, 25 (non-zero); 24 (zero); 23..22 (non-zero).
    await dcRedisMod.writeDailySnapshot("2026-05-26", 3);
    await dcRedisMod.writeDailySnapshot("2026-05-25", 2);
    await dcRedisMod.writeDailySnapshot("2026-05-24", 0);
    await dcRedisMod.writeDailySnapshot("2026-05-23", 1);
    await dcRedisMod.writeDailySnapshot("2026-05-22", 1);

    const res = await fetch(`${baseUrl}/api/design-concepts/snapshots`);
    const body = await res.json();
    // consecutiveGreenDays stops at the first zero (the two newest days).
    assert.equal(body.consecutiveGreenDays, 2);
    // 4 green of 5 days in window — still short of the 7-of-10 threshold.
    assert.equal(body.greenDaysInWindow, 4);
    assert.equal(body.greenLightReady, false);
  });

  test("#736 idle-tolerant: a quiet day inside a productive window stays green-light", async () => {
    await startApi();
    // 10 trailing days, one quiet (zero) day in the middle. 9 of 10 green
    // ⇒ >= 7 ⇒ green-light, even though the consecutive run is broken by
    // the zero day. This is the exact bug #736 reports: a quiet orch day
    // used to zero the streak; it must now be neutral.
    const days = [
      "2026-05-30", "2026-05-29", "2026-05-28", "2026-05-27", "2026-05-26",
      "2026-05-25", "2026-05-24", "2026-05-23", "2026-05-22", "2026-05-21",
    ];
    for (let i = 0; i < days.length; i += 1) {
      // Make 2026-05-27 the quiet day (production 0).
      const count = days[i] === "2026-05-27" ? 0 : 1;
      await dcRedisMod.writeDailySnapshot(days[i], count);
    }
    const res = await fetch(`${baseUrl}/api/design-concepts/snapshots`);
    const body = await res.json();
    assert.equal(body.windowDays, 10);
    assert.equal(body.requiredGreenDays, 7);
    assert.equal(body.greenDaysInWindow, 9);
    assert.equal(body.greenLightReady, true, "9 of 10 green days must satisfy the idle-tolerant gate");
    // The consecutive run is broken at the quiet day, but that no longer
    // gates the green light.
    assert.equal(body.consecutiveGreenDays, 3);
  });

  test("#736 idle-tolerant: 4 quiet days in the window blocks green-light", async () => {
    await startApi();
    // 6 of 10 green ⇒ < 7 ⇒ not ready. Demands sustained production.
    const greenDays = [
      "2026-05-30", "2026-05-29", "2026-05-28",
      "2026-05-25", "2026-05-24", "2026-05-23",
    ];
    const quietDays = ["2026-05-27", "2026-05-26", "2026-05-22", "2026-05-21"];
    for (const d of greenDays) await dcRedisMod.writeDailySnapshot(d, 1);
    for (const d of quietDays) await dcRedisMod.writeDailySnapshot(d, 0);
    const res = await fetch(`${baseUrl}/api/design-concepts/snapshots`);
    const body = await res.json();
    assert.equal(body.greenDaysInWindow, 6);
    assert.equal(body.greenLightReady, false);
  });
});
