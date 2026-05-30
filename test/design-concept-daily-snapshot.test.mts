/**
 * Regression tests for the design-concept daily-snapshot writer
 * (issue #628 — the green-light validation gate before flipping Phase
 * C of #437 from warn-only to hard-block).
 *
 * Background: PR #567 retired the B-4 telemetry endpoint, taking the
 * "is the gate producing artifacts?" read path with it. This snapshot
 * is the lightweight replacement — one `ZCARD hydra:design-concept:index`
 * value per UTC day, stored in the `hydra:dc:daily-snapshot` HASH,
 * bounded to MAX_SNAPSHOT_DAYS=14.
 *
 * Tests pin:
 *   - The HASH layout (date → count).
 *   - The 14-day prune.
 *   - The consecutive-green-days computation (≥7 → Phase C green-light).
 *   - That `getDesignConceptIndexSize()` reports `ZCARD` honestly so
 *     the snapshot value is meaningful.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Force test DB before any module that reads REDIS_URL is loaded.
process.env.REDIS_URL = "redis://localhost:6379/1";

const SNAPSHOT_KEY = "hydra:dc:daily-snapshot";
const DC_INDEX_KEY = "hydra:design-concept:index";

let testRedis: any;
let dcRedisMod: any;

async function cleanDc() {
  const keys = await testRedis.keys("hydra:dc:*");
  if (keys.length > 0) await testRedis.del(...keys);
  const idxKeys = await testRedis.keys("hydra:design-concept:*");
  if (idxKeys.length > 0) await testRedis.del(...idxKeys);
}

describe("design-concept daily snapshot (#628)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
    if (!dcRedisMod) {
      dcRedisMod = await import("../src/redis/design-concept.ts");
    }
    await cleanDc();
  });

  after(async () => {
    await cleanDc();
    if (testRedis) testRedis.disconnect();
    const { closeRedisConnections } = await import(
      "../src/redis/connection.ts"
    );
    closeRedisConnections();
  });

  test("getDesignConceptIndexSize() reports ZCARD of the index", async () => {
    // Seed the DC index with 3 entries.
    await testRedis.zadd(DC_INDEX_KEY, 1, "a", 2, "b", 3, "c");
    const size = await dcRedisMod.getDesignConceptIndexSize();
    assert.equal(size, 3);
  });

  test("#736 getDesignConceptProductionCountForDate() counts entries created that UTC day", async () => {
    // Index is scored by createdAt epoch-ms. Seed three days.
    const may28 = Date.parse("2026-05-28T10:00:00.000Z");
    const may29a = Date.parse("2026-05-29T01:00:00.000Z");
    const may29b = Date.parse("2026-05-29T23:59:59.000Z");
    const may30 = Date.parse("2026-05-30T00:00:00.000Z");
    await testRedis.zadd(
      DC_INDEX_KEY,
      may28, "issue-1",
      may29a, "issue-2",
      may29b, "issue-3",
      may30, "issue-4",
    );
    assert.equal(
      await dcRedisMod.getDesignConceptProductionCountForDate("2026-05-28"),
      1,
    );
    assert.equal(
      await dcRedisMod.getDesignConceptProductionCountForDate("2026-05-29"),
      2,
      "both 05-29 entries (incl 23:59:59) count toward that day",
    );
    assert.equal(
      await dcRedisMod.getDesignConceptProductionCountForDate("2026-05-30"),
      1,
      "the entry at exactly 05-30T00:00 belongs to 05-30, not 05-29",
    );
    assert.equal(
      await dcRedisMod.getDesignConceptProductionCountForDate("2026-05-31"),
      0,
      "a day with no creations is zero",
    );
  });

  test("#736 production count is a malformed-date no-op (0, not a throw)", async () => {
    await testRedis.zadd(DC_INDEX_KEY, Date.now(), "issue-1");
    assert.equal(
      await dcRedisMod.getDesignConceptProductionCountForDate("not-a-date"),
      0,
    );
  });

  test("writeDailySnapshot writes one HASH field per date", async () => {
    await dcRedisMod.writeDailySnapshot("2026-05-26", 5);
    await dcRedisMod.writeDailySnapshot("2026-05-25", 4);
    const all = await testRedis.hgetall(SNAPSHOT_KEY);
    assert.equal(all["2026-05-26"], "5");
    assert.equal(all["2026-05-25"], "4");
  });

  test("writeDailySnapshot is idempotent on date (second call overwrites)", async () => {
    await dcRedisMod.writeDailySnapshot("2026-05-26", 5);
    await dcRedisMod.writeDailySnapshot("2026-05-26", 11);
    const v = await testRedis.hget(SNAPSHOT_KEY, "2026-05-26");
    assert.equal(v, "11");
  });

  test("readDailySnapshots returns entries newest-first", async () => {
    await dcRedisMod.writeDailySnapshot("2026-05-20", 1);
    await dcRedisMod.writeDailySnapshot("2026-05-22", 3);
    await dcRedisMod.writeDailySnapshot("2026-05-21", 2);
    const out = await dcRedisMod.readDailySnapshots();
    assert.equal(out.length, 3);
    assert.equal(out[0].date, "2026-05-22");
    assert.equal(out[0].count, 3);
    assert.equal(out[1].date, "2026-05-21");
    assert.equal(out[2].date, "2026-05-20");
  });

  test("writeDailySnapshot prunes to MAX_SNAPSHOT_DAYS (14) entries", async () => {
    // Seed 15 days. The 15th write should drop the oldest.
    for (let i = 1; i <= 15; i += 1) {
      const day = String(i).padStart(2, "0");
      await dcRedisMod.writeDailySnapshot(`2026-05-${day}`, i);
    }
    const all = await testRedis.hkeys(SNAPSHOT_KEY);
    assert.equal(all.length, 14, "HASH must be bounded to 14 entries");
    // The oldest (2026-05-01) must be the one that was dropped.
    assert.ok(!all.includes("2026-05-01"));
    assert.ok(all.includes("2026-05-15"));
  });

  test("empty HASH → readDailySnapshots returns []", async () => {
    const out = await dcRedisMod.readDailySnapshots();
    assert.deepEqual(out, []);
  });

  test("consecutive-green-days computation (manual) — Phase C trigger at ≥7", async () => {
    // 7 days of non-zero counts, newest-first. This is exactly the
    // green-light shape #628 §Acceptance requires.
    const days = [
      "2026-05-26", "2026-05-25", "2026-05-24", "2026-05-23",
      "2026-05-22", "2026-05-21", "2026-05-20",
    ];
    for (let i = 0; i < days.length; i += 1) {
      await dcRedisMod.writeDailySnapshot(days[i], i + 1);
    }
    const snaps = await dcRedisMod.readDailySnapshots();
    let green = 0;
    for (const s of snaps) {
      if (s.count > 0) green += 1;
      else break;
    }
    assert.equal(green, 7);
  });

  test("a zero day breaks the consecutive-green run", async () => {
    await dcRedisMod.writeDailySnapshot("2026-05-26", 3);
    await dcRedisMod.writeDailySnapshot("2026-05-25", 2);
    await dcRedisMod.writeDailySnapshot("2026-05-24", 0); // ← zero
    await dcRedisMod.writeDailySnapshot("2026-05-23", 1);
    const snaps = await dcRedisMod.readDailySnapshots();
    let green = 0;
    for (const s of snaps) {
      if (s.count > 0) green += 1;
      else break;
    }
    assert.equal(green, 2, "zero day must end the consecutive count");
  });
});
