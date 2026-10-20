/**
 * `recordCycle` testsAfter recording guard (issue #3187).
 *
 * The `testsAfter` metric field was near-empty (~6% of cycles) because it only
 * populates for cycles that ran the grounding test-count deposit — i.e. BUILD
 * cycles (a hydra-dev / hydra-target-build dispatch that ran `npm test` in its
 * worktree). Non-build cycles (relay / qa-review re-posts, signal classes,
 * empty/skipped cycles) legitimately produce no test delta and MUST leave
 * `testsAfter` NULL rather than fabricating a 0 — a 0 would collapse the
 * "ran-tests vs never-ran-tests" distinction the coverage-trend reads.
 *
 * The write path (reap → dispatch.sh cycle-record → recordCycle →
 * recordCycleMetrics) is correct end-to-end; the missing piece flagged by the
 * #3187 research was a REGRESSION TEST pinning the invariant. These tests file
 * a build-cycle record carrying grounding test counts and assert `testsAfter`
 * lands non-null, then file a relay-cycle record with NO test counts and assert
 * `testsAfter` stays null — so a future change that (a) drops the testsAfter
 * pass-through or (b) starts defaulting it to 0 fails loudly here.
 *
 * Exercises `recordCycle` against real Redis DB 1 (never touches production
 * DB 0), matching the cycle-metrics-test-count-mirror suite.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const { recordCycle } = await import("../src/autopilot/cycle-close.ts");
const { getCycleMetrics } = await import("../src/redis/cycle-metrics.ts");

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

describe("recordCycle testsAfter recording guard (issue #3187)", () => {
  beforeEach(async () => {
    if (!redis) redis = new Redis(REDIS_URL);
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  test("a BUILD-cycle record (grounding test counts present) carries non-null testsAfter", async () => {
    const cycleId = "worktree-agent-3187aaaa-t1-dev_orch";
    const res = await recordCycle({
      cycleId,
      status: "completed",
      source: "claude",
      anchorType: "work-queue",
      tasksAttempted: 1,
      tasksMerged: 0,
      tasksFailed: 0,
      tasksAbandoned: 0,
      // The grounding deposit reap forwards for a build cycle.
      testsBefore: 6100,
      testsAfter: 6142,
      testsPassingBefore: 6098,
      testsPassingAfter: 6140,
    });
    assert.equal(res.ok, true, "recordCycle succeeded");

    const m = await getCycleMetrics(cycleId);
    assert.equal(m.testsAfter, "6142", "build cycle records the deposited testsAfter");
    assert.equal(m.testsBefore, "6100");
    assert.equal(m.testsPassingBefore, "6098");
    assert.equal(m.testsPassingAfter, "6140");
  });

  test("a RELAY-cycle record (no test counts) leaves testsAfter NULL — not 0", async () => {
    const cycleId = "6fd1300b-t1-qa_orch"; // bare relay cycleId, no grounding deposit
    const res = await recordCycle({
      cycleId,
      status: "merged",
      source: "claude",
      anchorType: "qa-review",
      tasksAttempted: 1,
      tasksMerged: 1,
      tasksFailed: 0,
      tasksAbandoned: 0,
      // No testsBefore/testsAfter — a relay/qa re-post has no test delta.
    });
    assert.equal(res.ok, true, "recordCycle succeeded");

    const m = await getCycleMetrics(cycleId);
    assert.equal(
      m.testsAfter,
      undefined,
      "relay cycle leaves testsAfter unset (null), never fabricates 0",
    );
    // The record still exists and carries its real fields — only the test
    // counts are absent (the truthful 'never ran tests' state).
    assert.equal(m.tasksMerged, "1", "relay cycle still records its merged count");
  });

  test("testsAfter=0 is a legitimate recorded value (all tests deleted), distinct from absent", async () => {
    // Guard against a naive `if (testsAfter)` truthiness bug that would drop a
    // real 0 — a build that removed its last test genuinely has testsAfter=0,
    // which must record as "0", NOT be swallowed as absent.
    const cycleId = "worktree-agent-3187bbbb-t2-dev_orch";
    const res = await recordCycle({
      cycleId,
      status: "completed",
      source: "claude",
      anchorType: "work-queue",
      tasksAttempted: 1,
      tasksMerged: 0,
      tasksFailed: 0,
      tasksAbandoned: 0,
      testsBefore: 5,
      testsAfter: 0,
    });
    assert.equal(res.ok, true);
    const m = await getCycleMetrics(cycleId);
    assert.equal(m.testsAfter, "0", "an explicit testsAfter=0 is recorded, not dropped");
    assert.equal(m.testsBefore, "5");
  });
});
