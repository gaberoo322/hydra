/**
 * Regression tests for anchor-selection drift pre-filter (issue #233).
 *
 * Bug: drift was the #1 abandonment cause (40% of abandoned cycles, ~$2-4/day
 * waste) because detectDrift() ran AFTER the planner. Moving the same string
 * similarity check into anchor-selection lets us reject near-duplicate work
 * before the planner is invoked.
 *
 * These tests cover:
 *   - identical title rejected (100% match → drift)
 *   - 80% similar title rejected (above 0.7 threshold)
 *   - 50% similar title accepted (below threshold)
 *   - failing-test anchors are exempt (legitimately repeat)
 *   - typecheck-error anchors are exempt
 *   - empty/missing references handled safely
 *   - computeTitleSimilarity is a pure helper (no Redis needed)
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

// Seed a recent cycle metric with the given task title so the pre-filter
// has something to compare against.
async function seedCycleMetric(cycleId: string, taskTitle: string, score = Date.now()) {
  await redis.zadd(redisKeys.metricsIndex(), score, cycleId);
  await redis.hset(redisKeys.metrics(cycleId), {
    cycleId,
    taskTitle,
    anchorType: "doc",
    anchorReference: "direction/priorities.md",
    recordedAt: new Date().toISOString(),
  });
}

describe("computeTitleSimilarity (pure helper, issue #233)", () => {
  test("identical strings score 1.0", async () => {
    const { computeTitleSimilarity } = await import("../src/metrics.ts");
    const score = computeTitleSimilarity(
      "Rank Polymarket reward windows by bankroll fit",
      "Rank Polymarket reward windows by bankroll fit",
    );
    assert.equal(score, 1);
  });

  test("80% overlap scores above 0.7", async () => {
    const { computeTitleSimilarity } = await import("../src/metrics.ts");
    // 4 of 5 long words shared
    const score = computeTitleSimilarity(
      "Rank Polymarket reward windows by bankroll fit",
      "Rank Polymarket reward windows for sizing fit",
    );
    assert.ok(score > 0.7, `expected >0.7, got ${score}`);
  });

  test("disjoint titles score 0", async () => {
    const { computeTitleSimilarity } = await import("../src/metrics.ts");
    const score = computeTitleSimilarity(
      "Rank Polymarket reward windows by bankroll fit",
      "Refactor authentication module for OAuth integration",
    );
    assert.equal(score, 0);
  });

  test("empty input is safe", async () => {
    const { computeTitleSimilarity } = await import("../src/metrics.ts");
    assert.equal(computeTitleSimilarity("", "anything else"), 0);
    assert.equal(computeTitleSimilarity("anything", ""), 0);
    assert.equal(computeTitleSimilarity("", ""), 0);
  });

  test("non-string input is safe", async () => {
    const { computeTitleSimilarity } = await import("../src/metrics.ts");
    // @ts-expect-error — runtime guard
    assert.equal(computeTitleSimilarity(null, "x"), 0);
    // @ts-expect-error — runtime guard
    assert.equal(computeTitleSimilarity(undefined, undefined), 0);
  });
});

describe("anchor-selection drift pre-filter (issue #233)", () => {
  let isAnchorDriftDuplicate: (anchor: any) => Promise<{ drift: boolean; match?: any }>;
  let consumeDriftPreFilteredCount: () => number;

  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
      const mod = await import("../src/anchor-selection.ts");
      isAnchorDriftDuplicate = mod._testing.isAnchorDriftDuplicate;
      consumeDriftPreFilteredCount = mod.consumeDriftPreFilteredCount;
    }
    await cleanKeys();
    // Reset the per-process counter so each test starts at zero.
    consumeDriftPreFilteredCount();
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  test("identical title is rejected as drift", async () => {
    await seedCycleMetric(
      "cycle-2026-05-10-0001",
      "Rank Polymarket reward windows by bankroll fit",
    );
    const result = await isAnchorDriftDuplicate({
      type: "user-request",
      reference: "Rank Polymarket reward windows by bankroll fit",
    });
    assert.equal(result.drift, true);
    assert.ok(result.match);
    assert.equal(result.match!.similarity, 1);
    // Counter should have incremented
    assert.equal(consumeDriftPreFilteredCount(), 1);
  });

  test("80% similar title is rejected as drift", async () => {
    await seedCycleMetric(
      "cycle-2026-05-10-0002",
      "Add RFQ endpoint cost evidence to sports quote packets",
    );
    const result = await isAnchorDriftDuplicate({
      type: "user-request",
      reference: "Expose RFQ endpoint cost evidence on sports run packets",
    });
    assert.equal(result.drift, true, `expected drift, got match=${JSON.stringify(result.match)}`);
    assert.ok(result.match!.similarity > 0.7);
  });

  test("50% similar title is accepted (below threshold)", async () => {
    await seedCycleMetric(
      "cycle-2026-05-10-0003",
      "Refactor authentication module for OAuth integration",
    );
    const result = await isAnchorDriftDuplicate({
      type: "user-request",
      // Shares ~2 long tokens of 5 — well below the 0.7 cutoff
      reference: "Refactor logging module for structured output",
    });
    assert.equal(result.drift, false);
    assert.equal(consumeDriftPreFilteredCount(), 0);
  });

  test("failing-test anchor is exempt from pre-filter", async () => {
    // Even when a recent cycle had the EXACT same title, failing-test anchors
    // legitimately repeat (the test came back red) and must not be filtered.
    await seedCycleMetric(
      "cycle-2026-05-10-0004",
      "test/auth.test.mts > login validates",
    );
    const result = await isAnchorDriftDuplicate({
      type: "failing-test",
      reference: "test/auth.test.mts > login validates",
    });
    assert.equal(result.drift, false);
    assert.equal(consumeDriftPreFilteredCount(), 0);
  });

  test("typecheck error anchor is exempt", async () => {
    await seedCycleMetric(
      "cycle-2026-05-10-0005",
      "typecheck",
    );
    // The control loop labels typecheck anchors as `failing-test` with
    // reference `typecheck` — confirm those still pass through cleanly.
    const result = await isAnchorDriftDuplicate({
      type: "failing-test",
      reference: "typecheck",
    });
    assert.equal(result.drift, false);
  });

  test("prior-failure anchor is exempt", async () => {
    // Prior failures already have their own retry-cap escalation logic; they
    // should not be re-filtered by the drift pre-check.
    await seedCycleMetric(
      "cycle-2026-05-10-0006",
      "task-cycle-2026-05-09-0100-1",
    );
    const result = await isAnchorDriftDuplicate({
      type: "prior-failure",
      reference: "task-cycle-2026-05-09-0100-1",
    });
    assert.equal(result.drift, false);
  });

  test("missing reference is treated as not-drift", async () => {
    const result = await isAnchorDriftDuplicate({
      type: "user-request",
      reference: "",
    });
    assert.equal(result.drift, false);
  });

  test("empty cycle history accepts every candidate", async () => {
    // No seeded metrics — pre-filter has nothing to compare against.
    const result = await isAnchorDriftDuplicate({
      type: "user-request",
      reference: "Some brand new task title with five words",
    });
    assert.equal(result.drift, false);
  });

  test("research anchor source is filtered", async () => {
    // Research-queued items show up as type:"research" via the work queue.
    await seedCycleMetric(
      "cycle-2026-05-10-0007",
      "Index OpenViking sessions for cross-cycle context",
    );
    const result = await isAnchorDriftDuplicate({
      type: "research",
      reference: "Index OpenViking sessions for cross-cycle context",
    });
    assert.equal(result.drift, true);
  });

  test("reframe anchor source is filtered", async () => {
    await seedCycleMetric(
      "cycle-2026-05-10-0008",
      "Reduce executor scope drift on multi-file changes",
    );
    const result = await isAnchorDriftDuplicate({
      type: "reframe",
      reference: "Reduce executor scope drift on multi-file changes",
    });
    assert.equal(result.drift, true);
  });

  test("doc anchor source is filtered", async () => {
    // The doc anchor reference is currently a static path that won't normally
    // collide, but the pre-filter must run on it for forward-compat.
    await seedCycleMetric(
      "cycle-2026-05-10-0009",
      "direction priorities.md document refresh",
    );
    const result = await isAnchorDriftDuplicate({
      type: "doc",
      // Trigger a >0.7 match by sharing 4 of 5 long tokens
      reference: "direction priorities.md document review",
    });
    assert.equal(result.drift, true);
  });

  test("counter accumulates across multiple rejections", async () => {
    await seedCycleMetric("cycle-aaa", "Add foo bar baz quux feature");
    await isAnchorDriftDuplicate({ type: "user-request", reference: "Add foo bar baz quux feature" });
    await isAnchorDriftDuplicate({ type: "research", reference: "Add foo bar baz quux feature" });
    await isAnchorDriftDuplicate({ type: "reframe", reference: "Add foo bar baz quux feature" });
    // failing-test is exempt → does NOT increment
    await isAnchorDriftDuplicate({ type: "failing-test", reference: "Add foo bar baz quux feature" });
    assert.equal(consumeDriftPreFilteredCount(), 3);
    // Consume again — should reset to 0
    assert.equal(consumeDriftPreFilteredCount(), 0);
  });
});
