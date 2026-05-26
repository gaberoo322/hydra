/**
 * Regression tests for the work-queue-tier source allowlist (issue #449).
 *
 * Bug: 20/31 items in `hydra:anchors:work-queue` were `source: "code-reviewer"`
 * or `source: "adversarial-validation"` — emitted by in-process Codex agents
 * deleted in PR-3 (#383). selectWorkQueueAnchor()'s mapping line treated any
 * non-"research" source as `user-request`, so these orphan-source items were
 * silently re-surfaced as operator-queued work, losing provenance and
 * confounding cycle-metric anchor-type breakdowns.
 *
 * Fix: enforce an allowlist at the read site. Items whose `source` is not in
 * { "research", "user-request", "operator", undefined } are LREM'd from the
 * processing queue and dropped. Operator-queued items with no source field
 * stay supported (that's how they appear on the wire today).
 *
 * These tests cover:
 *   - pure-function shape: isAllowedWorkQueueSource()
 *   - integration: orphan-source item is dropped (LREM'd, returns null)
 *   - integration: source:"research" item is kept and mapped to type:"research"
 *   - integration: no-source item is kept and mapped to type:"user-request"
 *   - integration: source:"operator" item is kept and mapped to type:"user-request"
 *   - integration: source:"adversarial-validation" item is dropped (the
 *     specific failure mode that motivated #449)
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { WORK_QUEUE, PROCESSING_QUEUE } from "../src/anchor-selection/constants.ts";
import {
  isAllowedWorkQueueSource,
  WORK_QUEUE_SOURCE_ALLOWLIST,
} from "../src/anchor-selection/work-queue-tier.ts";

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

async function lpushItem(item: unknown) {
  // selectWorkQueueAnchor LMOVEs from WORK_QUEUE's LEFT, so pushing on
  // the left makes that item the next claimed entry.
  await redis.lpush(WORK_QUEUE, JSON.stringify(item));
}

describe("isAllowedWorkQueueSource (pure helper, issue #449)", () => {
  test("allowlist set contains the documented live sources", () => {
    assert.equal(WORK_QUEUE_SOURCE_ALLOWLIST.has("research"), true);
    assert.equal(WORK_QUEUE_SOURCE_ALLOWLIST.has("user-request"), true);
    assert.equal(WORK_QUEUE_SOURCE_ALLOWLIST.has("operator"), true);
  });

  test("undefined / null sources are allowed (operator-queued items)", () => {
    assert.equal(isAllowedWorkQueueSource(undefined), true);
    assert.equal(isAllowedWorkQueueSource(null), true);
  });

  test("retired in-process agent sources are rejected", () => {
    assert.equal(isAllowedWorkQueueSource("code-reviewer"), false);
    assert.equal(isAllowedWorkQueueSource("adversarial-validation"), false);
  });

  test("non-string source values are rejected", () => {
    assert.equal(isAllowedWorkQueueSource(42), false);
    assert.equal(isAllowedWorkQueueSource({}), false);
    assert.equal(isAllowedWorkQueueSource([]), false);
    assert.equal(isAllowedWorkQueueSource(true), false);
  });

  test("unknown string sources are rejected", () => {
    assert.equal(isAllowedWorkQueueSource("future-agent"), false);
    assert.equal(isAllowedWorkQueueSource(""), false);
  });

  test("live sources are accepted exactly", () => {
    assert.equal(isAllowedWorkQueueSource("research"), true);
    assert.equal(isAllowedWorkQueueSource("user-request"), true);
    assert.equal(isAllowedWorkQueueSource("operator"), true);
  });
});

describe("selectWorkQueueAnchor source allowlist (issue #449)", () => {
  let selectWorkQueueAnchor: () => Promise<any>;

  beforeEach(async () => {
    if (!redis) {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";
      process.env.REDIS_URL = redisUrl;
      redis = new Redis(redisUrl);
      const mod = await import("../src/anchor-selection/work-queue-tier.ts");
      selectWorkQueueAnchor = mod.selectWorkQueueAnchor;
    }
    await cleanKeys();
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  test("orphan source 'code-reviewer' is dropped (LREM'd, returns null)", async () => {
    await lpushItem({
      source: "code-reviewer",
      reason: "Stale finding from cycle-2026-05-13",
      reference: "Fix dangling import in legacy file",
    });
    const result = await selectWorkQueueAnchor();
    assert.equal(result, null, "orphan-source item must not surface as an anchor");
    // Processing queue must be empty — LREM removed it so it can't recover
    const processingDepth = await redis.llen(PROCESSING_QUEUE);
    assert.equal(processingDepth, 0, "orphan item must be LREM'd from processing queue");
    // Work queue must also be empty (consumed)
    const workDepth = await redis.llen(WORK_QUEUE);
    assert.equal(workDepth, 0);
  });

  test("orphan source 'adversarial-validation' is dropped (the #449 case)", async () => {
    await lpushItem({
      source: "adversarial-validation",
      reason: "Adversarial validation after cycle-2026-05-13-0733",
      reference: "Fix adversarial finding in web/src/lib/execution/run-packet.ts",
    });
    const result = await selectWorkQueueAnchor();
    assert.equal(result, null);
    const processingDepth = await redis.llen(PROCESSING_QUEUE);
    assert.equal(processingDepth, 0);
  });

  test("source 'research' is kept and mapped to type:'research'", async () => {
    await lpushItem({
      source: "research",
      reason: "Research recommendation 2026-05-26",
      reference: "Index OpenViking sessions for cross-cycle context",
    });
    const result = await selectWorkQueueAnchor();
    assert.ok(result, "research-source items must be surfaced");
    assert.equal(result.type, "research");
    assert.equal(result.reference, "Index OpenViking sessions for cross-cycle context");
    // The item was consumed off WORK_QUEUE and is still on PROCESSING_QUEUE
    // (caller is responsible for removing it when the cycle completes).
    const processingDepth = await redis.llen(PROCESSING_QUEUE);
    assert.equal(processingDepth, 1);
  });

  test("item with no source field is kept and mapped to type:'user-request'", async () => {
    await lpushItem({
      reference: "Operator-queued task without source field",
      reason: "Submitted via POST /api/queue",
    });
    const result = await selectWorkQueueAnchor();
    assert.ok(result, "no-source operator-queued items must be surfaced");
    assert.equal(result.type, "user-request");
    assert.equal(result.reference, "Operator-queued task without source field");
  });

  test("source 'operator' is kept and mapped to type:'user-request'", async () => {
    await lpushItem({
      source: "operator",
      reference: "Operator-tagged task",
      reason: "Manual queue entry",
    });
    const result = await selectWorkQueueAnchor();
    assert.ok(result, "operator-source items must be surfaced");
    assert.equal(result.type, "user-request");
    assert.equal(result.reference, "Operator-tagged task");
  });

  test("unknown future source is dropped (allowlist is closed)", async () => {
    await lpushItem({
      source: "some-new-agent",
      reference: "Task from a producer that has not been allowlisted yet",
    });
    const result = await selectWorkQueueAnchor();
    assert.equal(result, null);
    const processingDepth = await redis.llen(PROCESSING_QUEUE);
    assert.equal(processingDepth, 0);
  });

  test("empty queue returns null without touching processing queue", async () => {
    const result = await selectWorkQueueAnchor();
    assert.equal(result, null);
    const processingDepth = await redis.llen(PROCESSING_QUEUE);
    assert.equal(processingDepth, 0);
  });
});
