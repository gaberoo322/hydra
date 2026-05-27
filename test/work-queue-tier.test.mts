/**
 * Regression tests for the work-queue source allowlist (issue #449).
 *
 * Bug: `hydra:anchors:work-queue` accumulated items emitted by the
 * in-process `code-reviewer` and `adversarial-validation` agents that
 * PR #383 deleted on 2026-05-13. The producers were gone, but the items
 * weren't drained and `selectWorkQueueAnchor()` mapped them to
 * `user-request` anchors — losing provenance and confounding metrics.
 *
 * The operator manually `LREM`'d the 8 remaining items on 2026-05-26.
 * These tests pin the durable guard: a source allowlist that drops
 * items whose `source` is not in `{ "research", "user-request",
 * "operator", undefined }` BEFORE they reach the planner, and removes
 * them from the processing queue so they don't recur.
 *
 * Test design notes:
 *   - We use Redis db 1 (the project's test convention — see
 *     test/anchor-selection-drift.test.mts:95).
 *   - We do NOT seed cycle metrics, so the drift pre-filter inside
 *     `selectWorkQueueAnchor()` is a no-op and we can isolate the
 *     allowlist behaviour.
 *   - We assert against the live RPUSH/LPUSH state of WORK_QUEUE and
 *     PROCESSING_QUEUE, not just the function's return value, because
 *     "rejected items are removed in place" is part of the contract.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import { selectWorkQueueAnchor } from "../src/anchor-selection/work-queue-tier.ts";
import { WORK_QUEUE, PROCESSING_QUEUE } from "../src/anchor-selection/constants.ts";

let redis: any;

async function cleanQueues() {
  await redis.del(WORK_QUEUE);
  await redis.del(PROCESSING_QUEUE);
  // Also wipe anything else under hydra:* so a stray seeded metric from a
  // sibling suite can't activate the drift pre-filter against our items.
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

async function enqueue(item: Record<string, unknown>) {
  await redis.rpush(WORK_QUEUE, JSON.stringify(item));
}

before(async () => {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
  process.env.REDIS_URL = redisUrl;
  redis = new Redis(redisUrl);
});

beforeEach(async () => {
  await cleanQueues();
});

after(async () => {
  if (redis) {
    await cleanQueues();
    redis.disconnect();
  }
});

describe("selectWorkQueueAnchor source allowlist (issue #449)", () => {
  test("item with source: 'code-reviewer' is dropped and removed from processing queue", async () => {
    await enqueue({
      source: "code-reviewer",
      reference: "Fix code-reviewer finding in web/src/lib/foo.ts",
      reason: "Adversarial validation after cycle-2026-05-13-0733",
    });

    const result = await selectWorkQueueAnchor();

    assert.equal(result, null, "expected disallowed-source item to be dropped");
    const workLen = await redis.llen(WORK_QUEUE);
    const procLen = await redis.llen(PROCESSING_QUEUE);
    assert.equal(workLen, 0, "work queue should be empty (item claimed)");
    assert.equal(
      procLen,
      0,
      "processing queue should be empty (rejected item removed)",
    );
  });

  test("item with source: 'adversarial-validation' is also dropped", async () => {
    await enqueue({
      source: "adversarial-validation",
      reference: "Wire up integration in execute-arbitrage.ts",
    });

    const result = await selectWorkQueueAnchor();
    assert.equal(result, null);
    assert.equal(await redis.llen(WORK_QUEUE), 0);
    assert.equal(await redis.llen(PROCESSING_QUEUE), 0);
  });

  test("item with source: 'research' is kept and mapped to research anchor", async () => {
    await enqueue({
      source: "research",
      reference: "Index OpenViking sessions for cross-cycle context",
      reason: "Research strategist 2026-05-26",
    });

    const result = await selectWorkQueueAnchor();
    assert.notEqual(result, null);
    assert.equal(result!.type, "research");
    assert.equal(
      result!.reference,
      "Index OpenViking sessions for cross-cycle context",
    );
    // Item moved to processing queue (kept for crash recovery — released
    // when the cycle completes; not our concern here).
    assert.equal(await redis.llen(WORK_QUEUE), 0);
    assert.equal(await redis.llen(PROCESSING_QUEUE), 1);
  });

  test("item with no source field is kept and mapped to user-request", async () => {
    // Operator-queued items via POST /api/queue historically did not
    // include a `source` field. We must keep these working.
    await enqueue({
      reference: "Operator-queued: investigate runaway spend on 2026-05-26",
      reason: "manual operator request",
    });

    const result = await selectWorkQueueAnchor();
    assert.notEqual(result, null);
    assert.equal(result!.type, "user-request");
    assert.equal(await redis.llen(PROCESSING_QUEUE), 1);
  });

  test("item with source: 'user-request' is kept and mapped to user-request", async () => {
    await enqueue({
      source: "user-request",
      reference: "Add a feature the operator asked for",
    });

    const result = await selectWorkQueueAnchor();
    assert.notEqual(result, null);
    assert.equal(result!.type, "user-request");
  });

  test("item with source: 'operator' is kept (allowed alias)", async () => {
    await enqueue({
      source: "operator",
      reference: "Operator-tagged maintenance task",
    });

    const result = await selectWorkQueueAnchor();
    assert.notEqual(result, null);
    // Maps to user-request because the type discriminator is binary
    // (research vs user-request); operator-class items are operator
    // intent and so map to user-request.
    assert.equal(result!.type, "user-request");
  });

  test("item with unknown source string is dropped", async () => {
    // Forward-defence: any source not in the allowlist (e.g. a
    // resurrected agent name, a typo from an out-of-tree producer) is
    // refused at the read side. Producers don't get to expand the
    // allowlist by accident.
    await enqueue({
      source: "ghost-agent-v2",
      reference: "Something that should never reach the planner",
    });

    const result = await selectWorkQueueAnchor();
    assert.equal(result, null);
    assert.equal(await redis.llen(PROCESSING_QUEUE), 0);
  });

  test("disallowed item then allowed item — only allowed one is returned", async () => {
    // First call drains the orphan, second call should see the operator
    // request. Confirms the LREM happens in-place rather than the
    // orphan blocking subsequent items.
    await enqueue({ source: "code-reviewer", reference: "orphan finding" });
    await enqueue({ reference: "operator request next in line" });

    const first = await selectWorkQueueAnchor();
    assert.equal(first, null, "orphan should be dropped");

    const second = await selectWorkQueueAnchor();
    assert.notEqual(second, null);
    assert.equal(second!.type, "user-request");
    assert.equal(second!.reference, "operator request next in line");
  });

  test("corrupt JSON is still dropped (existing behaviour preserved)", async () => {
    // Pre-existing path — pre-#449 behaviour for malformed items. We
    // include this so the new allowlist code doesn't accidentally
    // swallow the JSON.parse() catch arm.
    await redis.rpush(WORK_QUEUE, "this is not json {");

    const result = await selectWorkQueueAnchor();
    assert.equal(result, null);
    assert.equal(await redis.llen(WORK_QUEUE), 0);
    assert.equal(await redis.llen(PROCESSING_QUEUE), 0);
  });
});
