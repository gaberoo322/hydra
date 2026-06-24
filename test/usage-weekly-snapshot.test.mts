/**
 * Regression tests for the Weekly Usage Snapshot seam + chore (issue #2404).
 *
 * Covers:
 *   - The typed Redis accessor (`src/redis/usage-snapshots.ts`): write/read
 *     round-trip, 30-day TTL stamp, prior-week read, corrupt-value → clean miss.
 *   - The Housekeeping chore (`src/scheduler/chores/usage-weekly-snapshot.ts`):
 *     samples the per-skill cross-tab, reduces to raw per-skill totals, and
 *     persists this ISO week's rollup via the accessor.
 *
 * These tests touch a shared Redis seam, so they live in their OWN top-level
 * describe with its own before/after lifecycle (per the CLAUDE.md authoring rule
 * about not piggybacking on a sibling suite's teardown timing).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

let testRedis: any;
let snapMod: any;

async function cleanSnapshots() {
  const keys = await testRedis.keys("hydra:metrics:usage-snapshot:*");
  if (keys.length > 0) await testRedis.del(...keys);
}

describe("weekly usage snapshot seam + chore (#2404)", () => {
  beforeEach(async () => {
    if (!testRedis) testRedis = new Redis(process.env.REDIS_URL);
    if (!snapMod) snapMod = await import("../src/redis/usage-snapshots.ts");
    await cleanSnapshots();
  });

  after(async () => {
    await cleanSnapshots();
    if (testRedis) testRedis.disconnect();
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("write → read round-trips the per-skill rollup", async () => {
    await snapMod.writeWeeklyUsageSnapshot({
      isoWeek: "2026-W26",
      takenAt: "2026-06-23T12:00:00.000Z",
      bySkill: { "hydra-dev": 100, "hydra-qa": 40 },
    });
    const read = await snapMod.readWeeklyUsageSnapshot("2026-W26");
    assert.equal(read.isoWeek, "2026-W26");
    assert.equal(read.bySkill["hydra-dev"], 100);
    assert.equal(read.bySkill["hydra-qa"], 40);
  });

  test("stamps the 30-day TTL on the key", async () => {
    await snapMod.writeWeeklyUsageSnapshot({
      isoWeek: "2026-W26",
      takenAt: "2026-06-23T12:00:00.000Z",
      bySkill: { "hydra-dev": 1 },
    });
    const ttl = await testRedis.ttl(snapMod.usageWeeklySnapshotKey("2026-W26"));
    // Within the 30-day window, comfortably positive (allows for clock skew).
    assert.ok(ttl > 0 && ttl <= 30 * 24 * 60 * 60, `ttl was ${ttl}`);
  });

  test("readWeeklyUsageSnapshot returns null for an absent week", async () => {
    const read = await snapMod.readWeeklyUsageSnapshot("1999-W01");
    assert.equal(read, null);
  });

  test("a corrupt stored value degrades to a clean miss (null), never throws", async () => {
    await testRedis.set(snapMod.usageWeeklySnapshotKey("2026-W26"), "{not json");
    const read = await snapMod.readWeeklyUsageSnapshot("2026-W26");
    assert.equal(read, null);
  });

  test("readPriorWeekUsageSnapshot reads the ISO week 7d before `at`", async () => {
    // 2026-06-16 is in 2026-W25 (the week prior to 2026-W26).
    await snapMod.writeWeeklyUsageSnapshot({
      isoWeek: "2026-W25",
      takenAt: "2026-06-16T12:00:00.000Z",
      bySkill: { "hydra-dev": 70 },
    });
    const prior = await snapMod.readPriorWeekUsageSnapshot(
      new Date("2026-06-23T12:00:00.000Z"),
    );
    assert.equal(prior.isoWeek, "2026-W25");
    assert.equal(prior.bySkill["hydra-dev"], 70);
  });

  test("chore persists this ISO week's raw per-skill totals from the cross-tab", async () => {
    const { runUsageWeeklySnapshot } = await import(
      "../src/scheduler/chores/usage-weekly-snapshot.ts"
    );
    const now = new Date("2026-06-23T12:00:00.000Z");
    // Inject a fake getUsage + the real accessor so the chore exercises the
    // reduce + write without a live transcript scan.
    const ran = await runUsageWeeklySnapshot({
      now: () => now,
      module: {
        getUsage: async () => ({
          bySkillByModel: {
            "hydra-dev": {
              opus: { total: 100 },
              sonnet: { total: 25 },
              haiku: { total: 5 },
              unknown: { total: 0 },
            },
            "hydra-qa": { opus: { total: 0 }, sonnet: { total: 40 }, haiku: { total: 0 }, unknown: { total: 0 } },
          },
        }),
        writeWeeklyUsageSnapshot: snapMod.writeWeeklyUsageSnapshot,
        isoWeekLabel: snapMod.isoWeekLabel,
      },
    });
    assert.equal(ran, true);
    const read = await snapMod.readWeeklyUsageSnapshot("2026-W26");
    assert.equal(read.bySkill["hydra-dev"], 130); // 100+25+5
    assert.equal(read.bySkill["hydra-qa"], 40);
  });
});
