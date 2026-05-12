/**
 * Regression tests for issue #312 — post-merge.ts was spamming
 * `[Backlog] complete() failed: Item ... not found in any lane` on every
 * non-kanban anchor merge (134 false errors over 2 days of production).
 *
 * Bug: `runPostMerge()` called `complete(anchor.reference, "merged", ...)`
 * unconditionally, but only kanban-claimed anchors (priority-3 in
 * selectAnchor) actually have a row to mark Done. Research, codebase-health,
 * failing-test, prior-failure, reframe, regression-hunt, doc, issue, and
 * work-queue user-request anchors never live on the board, so the call
 * always logged a benign-but-noisy error.
 *
 * Fix: `isKanbanAnchor(anchor)` predicate gates the complete() call. Only
 * anchors tagged `_fromKanban: true` (set by `selectKanbanAnchor()` in
 * src/anchor-selection/kanban-tier.ts) are considered kanban-resident.
 *
 * Requires Redis (DB 1). Skips if unreachable, mirroring backlog.test.mts.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";

let redis: any;
let redisAvailable = false;

async function cleanBacklogKeys() {
  const keys = await redis.keys("hydra:backlog:*");
  if (keys.length > 0) await redis.del(...keys);
}

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

before(async () => {
  redis = new Redis(process.env.REDIS_URL!);
  try {
    await redis.ping();
    redisAvailable = true;
  } catch {
    console.error("Redis unavailable, skipping post-merge kanban gate tests");
  }
});

after(async () => {
  if (redis) {
    if (redisAvailable) await cleanBacklogKeys();
    redis.disconnect();
  }
  const { closeRedisConnections } = await import("../src/redis-adapter.ts");
  closeRedisConnections();
});

describe("isKanbanAnchor predicate (issue #312)", () => {
  test("returns false for anchor without _fromKanban marker", async () => {
    const { isKanbanAnchor } = await import("../src/backlog.ts");

    // Every non-kanban anchor type from src/anchor-selection/*.ts:
    const researchAnchor = { type: "research", reference: "outcome-stuckness:foo" };
    const codebaseHealthAnchor = { type: "codebase-health", reference: "src/foo.ts" };
    const failingTestAnchor = { type: "failing-test", reference: "typecheck" };
    const priorFailureAnchor = { type: "prior-failure", reference: "abandoned task" };
    const reframeAnchor = { type: "reframe", reference: "old reframe" };
    const regressionHuntAnchor = { type: "regression-hunt", reference: "audit src/x.ts" };
    const docAnchor = { type: "doc", reference: "priorities item" };
    const issueAnchor = { type: "issue", reference: "TODO: fix x" };
    // Work-queue user-request: NOT from kanban despite the type
    const workQueueAnchor = { type: "user-request", reference: "from queue" };

    assert.equal(isKanbanAnchor(researchAnchor), false);
    assert.equal(isKanbanAnchor(codebaseHealthAnchor), false);
    assert.equal(isKanbanAnchor(failingTestAnchor), false);
    assert.equal(isKanbanAnchor(priorFailureAnchor), false);
    assert.equal(isKanbanAnchor(reframeAnchor), false);
    assert.equal(isKanbanAnchor(regressionHuntAnchor), false);
    assert.equal(isKanbanAnchor(docAnchor), false);
    assert.equal(isKanbanAnchor(issueAnchor), false);
    assert.equal(isKanbanAnchor(workQueueAnchor), false);
  });

  test("returns true for anchor with _fromKanban: true", async () => {
    const { isKanbanAnchor } = await import("../src/backlog.ts");
    const kanbanAnchor = {
      type: "user-request",
      reference: "Real kanban item",
      _fromKanban: true,
    };
    assert.equal(isKanbanAnchor(kanbanAnchor), true);
  });

  test("handles null/undefined safely", async () => {
    const { isKanbanAnchor } = await import("../src/backlog.ts");
    assert.equal(isKanbanAnchor(null), false);
    assert.equal(isKanbanAnchor(undefined), false);
    assert.equal(isKanbanAnchor({} as any), false);
  });
});

describe("selectKanbanAnchor tags anchors with _fromKanban marker (issue #312)", () => {
  beforeEach(async () => {
    if (!redisAvailable) return;
    await cleanBacklogKeys();
  });

  test("kanban-claimed anchor carries _fromKanban: true", async (t) => {
    requireRedis(t);

    const { _admin } = await import("../src/backlog.ts");
    const { selectKanbanAnchor } = await import(
      "../src/anchor-selection/kanban-tier.ts"
    );

    // Seed a queued kanban item that selectKanbanAnchor will claim.
    await _admin.addToBacklog({
      title: "issue-312 regression test seed item",
      description: "Test that kanban anchors get marked",
      priority: 5,
    });
    // Promote to queued so the claim Lua script can find it.
    await _admin.promoteToQueued(1);

    const result = await selectKanbanAnchor();
    assert.ok(result.anchor, "expected kanban tier to claim the seeded item");
    assert.equal(result.anchor!._fromKanban, true);
    assert.equal(result.anchor!.type, "user-request");
  });
});

describe("post-merge complete() gate (issue #312)", () => {
  beforeEach(async () => {
    if (!redisAvailable) return;
    await cleanBacklogKeys();
  });

  test("non-kanban anchor: complete() is skipped, no error logged", async (t) => {
    requireRedis(t);

    const { complete, isKanbanAnchor } = await import("../src/backlog.ts");

    // Capture console.error/console.warn so we can assert the spurious
    // "[Backlog] complete() failed" / "[Backlog] moveToDone: ... not found"
    // messages no longer appear when the gate is honored.
    const errors: string[] = [];
    const warns: string[] = [];
    const origErr = console.error;
    const origWarn = console.warn;
    console.error = (...args: any[]) => { errors.push(args.join(" ")); };
    console.warn = (...args: any[]) => { warns.push(args.join(" ")); };

    try {
      // Simulate the post-merge call site for a research anchor.
      const researchAnchor: any = {
        type: "research",
        reference: "outcome-stuckness:weekly-roi",
      };

      if (isKanbanAnchor(researchAnchor)) {
        // This is the buggy path — should NOT execute for non-kanban anchors.
        await complete(researchAnchor.reference, "merged");
      }
    } finally {
      console.error = origErr;
      console.warn = origWarn;
    }

    const noisy = [...errors, ...warns].filter(
      (m) =>
        m.includes("complete() failed") ||
        m.includes("moveToDone: item") ||
        m.includes("not found in any lane"),
    );
    assert.equal(
      noisy.length,
      0,
      `expected zero false-positive backlog logs, got: ${noisy.join(" | ")}`,
    );
  });

  test("kanban anchor: complete() still runs and succeeds when item is on board", async (t) => {
    requireRedis(t);

    const { complete, _admin, isKanbanAnchor } = await import(
      "../src/backlog.ts"
    );

    // Seed a real kanban item and put it in-progress so complete() can move
    // it to Done (mirrors the production path).
    const title = "issue-312 kanban happy-path";
    await _admin.addToBacklog({ title, priority: 5 });
    await _admin.promoteToQueued(1);
    await _admin.moveToInProgress(title);

    const kanbanAnchor: any = {
      type: "user-request",
      reference: title,
      _fromKanban: true,
    };

    assert.equal(isKanbanAnchor(kanbanAnchor), true);

    const result = await complete(kanbanAnchor.reference, "merged");
    assert.equal(result.ok, true, `complete() should succeed; got: ${result.error}`);
  });
});
