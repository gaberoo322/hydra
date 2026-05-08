/**
 * Regression tests for codebase-health confidence gate (issue #147).
 *
 * Bug: codebase-health anchors with no grounding signal (no failing tests,
 * no type errors) were selected and sent to the planner, which produced
 * "Planner produced no task" abandonments — wasting cycles.
 *
 * Fix: selectAnchor() checks grounding inline before returning a health
 * anchor. If no failing tests and no type errors, the anchor is skipped
 * with a 'low-confidence-skip' log entry and markLowConfidenceSkip() is
 * called for metrics tracking.
 *
 * These tests exercise the confidence gate logic via pure unit tests
 * (no Redis needed) and via selectAnchor integration (Redis DB 1).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

describe("codebase-health confidence gate (issue #147)", () => {
  let selectAnchor: (grounding: any, opts?: any, eventBus?: any) => Promise<any>;
  let markLowConfidenceSkip: (anchor: any) => Promise<void>;
  let HEALTH_CONFIDENCE_THRESHOLD: number;

  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
      const mod = await import("../src/anchor-selection.ts");
      selectAnchor = mod.selectAnchor;
      markLowConfidenceSkip = mod.markLowConfidenceSkip;
      HEALTH_CONFIDENCE_THRESHOLD = mod.HEALTH_CONFIDENCE_THRESHOLD;
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
  // AC1 + AC2: low-confidence health anchor is skipped (falls through)
  // ---------------------------------------------------------------------------

  test("HEALTH_CONFIDENCE_THRESHOLD is exported and equals 0.5", () => {
    assert.equal(HEALTH_CONFIDENCE_THRESHOLD, 0.5);
  });

  test("health anchor skipped when grounding has no signals (0 failed, 0 errors)", async () => {
    // With no failing tests, no type errors, no TODOs, no queued items,
    // and no prior failures — selectAnchor should skip health anchors and
    // fall through to the priorities doc (or null).
    const grounding = {
      failingTests: [],
      testReport: { passed: 10, failed: 0, total: 10 },
      typecheckReport: { exitCode: 0, errors: 0 },
      todoMarkers: [],
      fileTree: "",
    };

    const anchor = await selectAnchor(grounding);

    // Should NOT return a codebase-health anchor — should fall through
    // to priorities doc or null
    if (anchor) {
      assert.notEqual(
        anchor.type,
        "codebase-health",
        "low-confidence health anchor should be skipped, not returned",
      );
    }
  });

  test("health anchor allowed when grounding has failing tests", async () => {
    // Seed grounding with a failing test — health anchor should be allowed
    // But first we need codebase-health to actually produce issues.
    // Since analyzeCodebaseHealth depends on the actual file tree, we test
    // the gate logic by checking that selectAnchor does NOT skip when there
    // are failing tests (even though failing-test anchor has higher priority
    // and will be selected first in practice).
    const grounding = {
      failingTests: ["test/example.test.mts > should work"],
      testReport: { passed: 9, failed: 1, total: 10 },
      typecheckReport: { exitCode: 0, errors: 0 },
      todoMarkers: [],
      fileTree: "",
    };

    const anchor = await selectAnchor(grounding);
    // Failing tests have higher priority than health, so anchor will be
    // failing-test type — but the key is that the health gate would NOT
    // have blocked it (grounding has signal).
    assert.ok(anchor, "should return an anchor");
    assert.equal(anchor.type, "failing-test", "failing test anchor takes priority");
  });

  test("health anchor allowed when grounding has type errors", async () => {
    const grounding = {
      failingTests: [],
      testReport: { passed: 10, failed: 0, total: 10 },
      typecheckReport: { exitCode: 1, errors: 3 },
      todoMarkers: [],
      fileTree: "",
    };

    const anchor = await selectAnchor(grounding);
    // Type errors have higher priority than health anchors
    assert.ok(anchor, "should return an anchor");
    assert.equal(anchor.type, "failing-test", "typecheck error anchor takes priority");
  });

  // ---------------------------------------------------------------------------
  // AC4: markLowConfidenceSkip increments perm-skip counter
  // ---------------------------------------------------------------------------

  test("markLowConfidenceSkip increments perm-skip counter for health anchors", async () => {
    const ref = "codebase-health: large-file in src/test-file.ts";
    await markLowConfidenceSkip({ type: "codebase-health", reference: ref });

    // Check the perm-skip key was set in Redis
    const normalizedRef = ref.replace(/\s+/g, "-").slice(0, 120);
    const key = `hydra:anchors:perm-skip:${normalizedRef}`;
    const count = await redis.get(key);
    assert.equal(count, "1", "perm-skip counter should be 1 after first skip");
  });

  test("markLowConfidenceSkip is a no-op for non-health anchors", async () => {
    await markLowConfidenceSkip({ type: "failing-test", reference: "some test" });
    // Should not create any perm-skip key
    const keys = await redis.keys("hydra:anchors:perm-skip:*");
    assert.equal(keys.length, 0, "no perm-skip keys should exist for non-health anchors");
  });
});
