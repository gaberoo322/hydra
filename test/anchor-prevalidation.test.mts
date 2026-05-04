/**
 * Regression tests for anchor pre-validation (issue #81).
 *
 * Bug: 28% of cycles waste ~61s of frontier inference producing "Planner
 * produced no task" because anchors referencing completed priorities, items
 * marked COMPLETED:, or duplicates of recently-merged tasks are not caught
 * before calling runPlannerAgent.
 *
 * Fix: isAnchorStale() in cycle-helpers.ts checks these conditions and
 * returns a skip reason before the planner is invoked.
 *
 * Tests the COMPLETED: prefix check (pure) and duplicate-of-recent-merge
 * check (requires Redis DB 1).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { redisKeys } from "../src/redis-keys.ts";

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

describe("anchor pre-validation — isAnchorStale (issue #81)", () => {
  let isAnchorStale: (anchor: any) => Promise<string | null>;

  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
      const helpers = await import("../src/cycle-helpers.ts");
      isAnchorStale = helpers.isAnchorStale;
    }
    await cleanKeys();
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  // ---------------------------------------------------------------------------
  // COMPLETED: prefix check (pure — no Redis needed)
  // ---------------------------------------------------------------------------

  test("anchor with COMPLETED: prefix is skipped", async () => {
    const reason = await isAnchorStale({
      type: "user-request",
      reference: "COMPLETED: Add per-leg fee evidence",
    });
    assert.ok(reason, "should return a skip reason");
    assert.match(reason!, /completed/i);
  });

  test("anchor with completed: prefix (lowercase) is skipped", async () => {
    const reason = await isAnchorStale({
      type: "user-request",
      reference: "completed: some old task",
    });
    assert.ok(reason, "should return a skip reason");
  });

  test("anchor without COMPLETED: prefix proceeds", async () => {
    // This anchor has no COMPLETED: prefix and won't match priorities.md
    // completed items (using a unique reference)
    const reason = await isAnchorStale({
      type: "user-request",
      reference: "xyzzy-unique-never-completed-task-12345",
    });
    assert.equal(reason, null, "should not be stale");
  });

  // ---------------------------------------------------------------------------
  // Duplicate-of-recent-merge detection (requires Redis)
  // ---------------------------------------------------------------------------

  test("anchor duplicating a recently merged task is skipped", async () => {
    // Seed a reality report with a merged task
    const reportId = "cycle-test-dup-001";
    const report = {
      task: {
        title: "Add per-leg fee evidence to sports arbitrage run-packets",
        finalState: "merged",
      },
      filesChanged: ["src/run-packets.ts"],
      commitSha: "abc1234",
    };
    await redis.zadd(redisKeys.realityReportIndex(), Date.now(), reportId);
    await redis.set(redisKeys.realityReport(reportId), JSON.stringify(report));

    const reason = await isAnchorStale({
      type: "user-request",
      reference: "Add per-leg fee evidence to sports arbitrage run-packets",
    });
    assert.ok(reason, "should return a skip reason for duplicate");
    assert.match(reason!, /recently merged/i);
  });

  test("anchor not matching any merged task proceeds", async () => {
    // Seed a reality report with a merged task that's completely different
    const reportId = "cycle-test-dup-002";
    const report = {
      task: {
        title: "Refactor authentication module for OAuth2",
        finalState: "merged",
      },
    };
    await redis.zadd(redisKeys.realityReportIndex(), Date.now(), reportId);
    await redis.set(redisKeys.realityReport(reportId), JSON.stringify(report));

    const reason = await isAnchorStale({
      type: "failing-test",
      reference: "xyzzy-unique-never-completed-task-67890",
    });
    assert.equal(reason, null, "non-matching anchor should proceed");
  });

  test("non-merged tasks in reports are ignored", async () => {
    // Seed a reality report with a failed (not merged) task using a unique title
    // that won't match any completed items in priorities.md
    const reportId = "cycle-test-dup-003";
    const uniqueTitle = "Implement xyzzy quantum flux capacitor subsystem module";
    const report = {
      task: {
        title: uniqueTitle,
        finalState: "failed",
      },
    };
    await redis.zadd(redisKeys.realityReportIndex(), Date.now(), reportId);
    await redis.set(redisKeys.realityReport(reportId), JSON.stringify(report));

    const reason = await isAnchorStale({
      type: "user-request",
      reference: uniqueTitle,
    });
    // Should NOT match because the task was not merged
    assert.equal(reason, null, "failed tasks should not trigger duplicate detection");
  });

  test("empty reference is not stale", async () => {
    const reason = await isAnchorStale({
      type: "user-request",
      reference: "",
    });
    assert.equal(reason, null);
  });
});
