/**
 * Pipeline flow integration tests — dry-run cycle orchestration.
 *
 * Tests the control loop pipeline step decision logic end-to-end
 * with real Redis (DB 1) but no Codex agent calls or git operations.
 * Exercises: handlePlanResult → runDriftCheck → runPreflightGate.
 *
 * Regression: control-loop.ts (1600+ lines) had zero direct test coverage.
 * These tests verify the pipeline makes correct continue/stop decisions
 * for each scenario.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

import { handlePlanResult, runDriftCheck, runPreflightGate } from "../src/pipeline-steps.ts";
import { classifyTaskComplexity } from "../src/preflight.ts";
import { createTracker } from "../src/task-tracker.ts";
import type { CycleContext } from "../src/cycle-helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let redis: any;

function makeNoOpSession() {
  return {
    sessionId: "test-session",
    cycleId: "test-cycle",
    active: false,
    async logPlanner() {},
    async logSkeptic() {},
    async logExecutor() {},
    async logOutcome() {},
    async logVerification() {},
    async markUsed() {},
    async commit() {},
  };
}

function makeNoOpEventBus() {
  const published: any[] = [];
  return {
    published,
    async publish(_stream: string, event: any) {
      published.push(event);
    },
  };
}

function makeGrounding(overrides: any = {}) {
  return {
    testReport: { passed: 42, failed: 0, total: 42, duration: 5000 },
    typecheckReport: { errors: 0 },
    groundingDurationMs: 5000,
    gitStatus: { clean: true },
    ...overrides,
  };
}

function makeAnchor(overrides: any = {}) {
  return {
    type: "priorities",
    reference: "Add widget feature",
    whyNow: "Listed in priorities.md",
    ...overrides,
  };
}

function makeTask(overrides: any = {}) {
  return {
    taskId: "task-test-001",
    title: "Implement widget component",
    description: "Add a reusable widget component to the UI layer",
    anchorType: "priorities",
    anchorReference: "Add widget feature",
    confidence: 0.8,
    risk: "low",
    scopeBoundary: {
      in: ["src/widget.ts", "src/widget.test.ts"],
      out: ["src/db.ts"],
    },
    acceptanceCriteria: [
      "Widget renders correctly",
      "Tests pass",
    ],
    verificationPlan: [
      { label: "Tests", command: "npm test", expected: "exit 0" },
    ],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CycleContext> = {}): CycleContext {
  return {
    cycleId: "cycle-2026-05-04-1200",
    startTime: Date.now(),
    grounding: makeGrounding(),
    groundingSummary: "Tests: 42 passed, 0 failed. Typecheck clean.",
    ovSession: makeNoOpSession(),
    eventBus: makeNoOpEventBus(),
    anchor: makeAnchor(),
    anchorConfidence: { score: 0.75, reason: "heuristic match", tier: "heuristic" as const },
    ...overrides,
  };
}

async function cleanTestKeys() {
  const patterns = [
    "hydra:reports:*", "hydra:metrics:*", "hydra:memory:*",
    "hydra:reflections:*", "hydra:task:*", "hydra:cycle:*",
    "hydra:backlog:*", "hydra:proposals:*",
  ];
  for (const pat of patterns) {
    const keys = await redis.keys(pat);
    if (keys.length > 0) await redis.del(...keys);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pipeline flow — dry-run cycle orchestration", () => {
  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379/1");
      process.env.REDIS_URL = "redis://localhost:6379/1";
      createTracker();
    }
    await cleanTestKeys();
  });

  after(async () => {
    if (redis) {
      await cleanTestKeys();
      redis.disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // handlePlanResult — null task, usage-limit, valid task
  // -------------------------------------------------------------------------

  describe("handlePlanResult", () => {
    test("null task → pipeline stops with 'no task' reason", async () => {
      const ctx = makeCtx();
      const result = await handlePlanResult(ctx, null, ctx.anchorConfidence);

      assert.equal(result.continue, false);
      if (!result.continue) {
        assert.ok(result.result.reason.includes("no task"), `Expected 'no task' in reason, got: ${result.result.reason}`);
        assert.deepEqual(result.result.tasks, []);
      }
    });

    test("usage-limit sentinel → pipeline stops with usage-limit", async () => {
      const ctx = makeCtx();
      const usageLimitTask = { __usageLimitHit: true };
      const result = await handlePlanResult(ctx, usageLimitTask, ctx.anchorConfidence);

      assert.equal(result.continue, false);
      if (!result.continue) {
        assert.ok(result.result.reason.includes("usage limit"), `Expected 'usage limit' in reason, got: ${result.result.reason}`);
        assert.equal(result.result.__usageLimitHit, true);
      }
    });

    test("valid task → pipeline continues", async () => {
      const ctx = makeCtx();
      const task = makeTask();
      const result = await handlePlanResult(ctx, task, ctx.anchorConfidence);

      assert.equal(result.continue, true);
    });
  });

  // -------------------------------------------------------------------------
  // classifyTaskComplexity — pure function, no I/O
  // -------------------------------------------------------------------------

  describe("classifyTaskComplexity", () => {
    test("failing-test anchor → quick-fix", () => {
      const task = makeTask();
      const anchor = makeAnchor({ type: "failing-test" });
      assert.equal(classifyTaskComplexity(task, anchor), "quick-fix");
    });

    test("small scope (<=2 files, <=3 criteria) → quick-fix", () => {
      const task = makeTask({
        scopeBoundary: { in: ["src/a.ts"], out: [] },
        acceptanceCriteria: ["Tests pass"],
      });
      const anchor = makeAnchor({ type: "prior-failure" });
      assert.equal(classifyTaskComplexity(task, anchor), "quick-fix");
    });

    test("standard scope → standard", () => {
      const task = makeTask({
        scopeBoundary: { in: ["src/a.ts", "src/b.ts", "src/c.ts"], out: [] },
        acceptanceCriteria: ["A works", "B works", "C works", "Tests pass"],
      });
      const anchor = makeAnchor({ type: "priorities" });
      assert.equal(classifyTaskComplexity(task, anchor), "standard");
    });

    test("large scope (>5 files) → complex", () => {
      const task = makeTask({
        scopeBoundary: { in: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"], out: [] },
        acceptanceCriteria: ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
      });
      const anchor = makeAnchor({ type: "priorities" });
      assert.equal(classifyTaskComplexity(task, anchor), "complex");
    });
  });

  // -------------------------------------------------------------------------
  // runDriftCheck — duplicate detection against recent cycle history
  // -------------------------------------------------------------------------

  describe("runDriftCheck", () => {
    test("novel task → pipeline continues", async () => {
      const ctx = makeCtx();
      const task = makeTask({ title: "Completely unique task title" });
      const result = await runDriftCheck(ctx, task, "task-drift-1");

      assert.equal(result.continue, true);
    });

    test("prior-failure anchor skips drift check → pipeline continues", async () => {
      const ctx = makeCtx({ anchor: makeAnchor({ type: "prior-failure" }) });
      const task = makeTask();
      const result = await runDriftCheck(ctx, task, "task-drift-2");

      assert.equal(result.continue, true);
    });

    test("user-request anchor skips drift check → pipeline continues", async () => {
      const ctx = makeCtx({ anchor: makeAnchor({ type: "user-request" }) });
      const task = makeTask();
      const result = await runDriftCheck(ctx, task, "task-drift-3");

      assert.equal(result.continue, true);
    });

    test("reframe anchor skips drift check → pipeline continues", async () => {
      const ctx = makeCtx({ anchor: makeAnchor({ type: "reframe" }) });
      const task = makeTask();
      const result = await runDriftCheck(ctx, task, "task-drift-4");

      assert.equal(result.continue, true);
    });
  });

  // -------------------------------------------------------------------------
  // runPreflightGate — deterministic preflight + high-risk review
  // -------------------------------------------------------------------------

  describe("runPreflightGate", () => {
    test("quick-fix complexity → auto-approve, pipeline continues", async () => {
      const ctx = makeCtx();
      const task = makeTask();
      const result = await runPreflightGate(
        ctx, task, "quick-fix", ctx.groundingSummary, "task-pf-1",
      );

      assert.equal(result.continue, true);
      if (result.continue) {
        assert.ok(result.skepticResult.reason.includes("quick-fix"));
        assert.equal(result.skepticResult.verdict, "approve");
      }
    });

    test("standard task with clean grounding → preflight passes", async () => {
      const ctx = makeCtx();
      const task = makeTask();
      const result = await runPreflightGate(
        ctx, task, "standard", ctx.groundingSummary, "task-pf-2",
      );

      assert.equal(result.continue, true);
    });
  });

  // -------------------------------------------------------------------------
  // Full pipeline flow — happy path through decision points
  // -------------------------------------------------------------------------

  describe("full pipeline flow (decision points only)", () => {
    test("valid task passes all gates: plan → drift → preflight", async () => {
      const ctx = makeCtx();
      const task = makeTask();
      const anchor = ctx.anchor;

      // Step 3: Plan result
      const planResult = await handlePlanResult(ctx, task, ctx.anchorConfidence);
      assert.equal(planResult.continue, true, "handlePlanResult should continue");

      // Step 3.1: Classify
      const complexity = classifyTaskComplexity(task, anchor);
      assert.ok(["quick-fix", "standard", "complex"].includes(complexity));

      // Step 3.5: Drift
      const driftResult = await runDriftCheck(ctx, task, "task-flow-1");
      assert.equal(driftResult.continue, true, "runDriftCheck should continue");

      // Step 4: Preflight
      const preflightResult = await runPreflightGate(
        ctx, task, complexity, ctx.groundingSummary, "task-flow-1",
      );
      assert.equal(preflightResult.continue, true, "runPreflightGate should continue");

      // After preflight, the next steps (execute, verify, merge) require
      // Codex agents and git — those are tested via the existing executor-agent
      // and scope-filter tests. This test verifies the orchestration logic
      // up to the agent boundary.
    });

    test("null plan → pipeline stops at first gate", async () => {
      const ctx = makeCtx();

      const planResult = await handlePlanResult(ctx, null, ctx.anchorConfidence);
      assert.equal(planResult.continue, false, "null task should stop pipeline");

      // Verify no downstream steps would run
      if (!planResult.continue) {
        assert.ok(planResult.result.cycleId, "result should include cycleId");
        assert.ok(planResult.result.durationMs >= 0, "result should include durationMs");
      }
    });

    test("event bus captures lifecycle events", async () => {
      const eventBus = makeNoOpEventBus();
      const ctx = makeCtx({ eventBus });
      const task = makeTask();

      // Run through gates
      await handlePlanResult(ctx, task, ctx.anchorConfidence);
      await runDriftCheck(ctx, task, "task-events-1");

      // Preflight for standard task may publish rejection events —
      // for a clean task it should pass silently
      const complexity = classifyTaskComplexity(task, ctx.anchor);
      await runPreflightGate(ctx, task, complexity, ctx.groundingSummary, "task-events-1");

      // No rejection events should be published for a clean flow
      const rejections = eventBus.published.filter(
        (e: any) => e.type === "task:rejected" || e.type === "task:drift_detected",
      );
      assert.equal(rejections.length, 0, "clean flow should not publish rejection events");
    });
  });
});
