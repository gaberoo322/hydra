/**
 * Regression tests for the reframe-queue enqueue path (issue #377).
 *
 * Background
 *   The acceptance criterion for #377 says: "When a cycle abandons with
 *   eligible failure mode, it is verifiably enqueued to reframe." The
 *   existing wiring in `trackAbandonment` (src/anchor-selection/abandonment.ts)
 *   enqueues after MAX_CONSECUTIVE_ABANDONMENTS (=3) consecutive abandons of
 *   the same anchor reference. This file pins that behaviour so a future
 *   refactor can't silently break it — the original "2/50 cycles" bug was
 *   partly an instrumentation gap (no signal that the enqueue *was* firing)
 *   and partly behavioural; this test catches the behavioural half.
 *
 * Requires Redis running on localhost:6379. Uses DB 1.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = redisUrl;
redis = new Redis(redisUrl);

after(async () => {
  if (redis) {
    await cleanKeys();
    redis.disconnect();
  }
});

const REFRAME_QUEUE_KEY = "hydra:anchors:reframe-queue";

describe("trackAbandonment → reframe queue enqueue (issue #377)", () => {
  beforeEach(async () => {
    await cleanKeys();
  });

  test("the first two abandonments do NOT enqueue (under the threshold)", async () => {
    const { trackAbandonment } = await import(
      "../src/anchor-selection/abandonment.ts"
    );
    const task = { title: "flaky-anchor", taskId: "t-1", anchorType: "user-request" };

    const escalated1 = await trackAbandonment("flaky-anchor", task, "scope-creep");
    const escalated2 = await trackAbandonment("flaky-anchor", task, "scope-creep");

    assert.equal(escalated1, false);
    assert.equal(escalated2, false);
    const len = await redis.llen(REFRAME_QUEUE_KEY);
    assert.equal(len, 0, "reframe queue stays empty until threshold");
  });

  test("the third consecutive abandonment enqueues with escalationSource", async () => {
    const { trackAbandonment } = await import(
      "../src/anchor-selection/abandonment.ts"
    );
    const task = {
      title: "repeatedly-abandoned",
      taskId: "t-2",
      anchorType: "research",
      anchorReference: "repeatedly-abandoned",
    };

    await trackAbandonment("repeatedly-abandoned", task, "verification-failed");
    await trackAbandonment("repeatedly-abandoned", task, "verification-failed");
    const escalated = await trackAbandonment(
      "repeatedly-abandoned",
      task,
      "verification-failed",
    );

    assert.equal(escalated, true);
    const queued = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    assert.equal(queued.length, 1, "exactly one reframe item enqueued");
    const item = JSON.parse(queued[0]);
    assert.equal(item.originalTitle, "repeatedly-abandoned");
    assert.equal(item.anchorType, "research");
    assert.equal(item.escalationSource, "abandonment-circuit-breaker");
    assert.equal(item.totalAttempts, 3);
    assert.equal(item.lastReason, "verification-failed");
    assert.ok(item.escalatedAt, "escalatedAt timestamp must be present");
  });

  test("abandonment counter resets after escalation (one clean shot)", async () => {
    const { trackAbandonment } = await import(
      "../src/anchor-selection/abandonment.ts"
    );
    const task = { title: "post-escalation", taskId: "t-3", anchorType: "doc" };

    // Three to escalate.
    await trackAbandonment("post-escalation", task, "r1");
    await trackAbandonment("post-escalation", task, "r2");
    await trackAbandonment("post-escalation", task, "r3");

    // The counter resets so a subsequent abandon does NOT immediately
    // re-escalate.
    const escalated4 = await trackAbandonment("post-escalation", task, "r4");
    assert.equal(escalated4, false);

    const queued = await redis.lrange(REFRAME_QUEUE_KEY, 0, -1);
    // Only the first escalation enqueued — a second cycle of 3 abandons would
    // be needed to enqueue again.
    assert.equal(queued.length, 1, "the counter reset prevents back-to-back escalations");
  });

  test("escalated reframe items are visible to the floor's prepare()", async () => {
    const { trackAbandonment } = await import(
      "../src/anchor-selection/abandonment.ts"
    );
    const { reframeFloorDecl } = await import(
      "../src/anchor-selection/capacity-floors.ts"
    );
    const { recordReframePassedReason } = await import(
      "../src/anchor-selection/reframe-starvation.ts"
    );

    const task = { title: "starved-then-served", taskId: "t-4", anchorType: "user-request" };
    await trackAbandonment("starved-then-served", task, "x");
    await trackAbandonment("starved-then-served", task, "x");
    await trackAbandonment("starved-then-served", task, "x");

    // Drive the cycles-since-served gauge past the cadence.
    for (let i = 0; i < 6; i++) await recordReframePassedReason("kanban_won");

    const ready = await reframeFloorDecl().prepare();
    assert.ok(ready, "floor must see the enqueued item as a candidate");
    assert.ok(ready!.deficit > 0, "deficit should be positive past the cadence");
  });
});
