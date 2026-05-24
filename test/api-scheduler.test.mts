/**
 * Regression tests for the scheduler API routes (issue #164).
 *
 * Bug: The scheduler endpoints (POST /scheduler/start, POST /scheduler/stop,
 * GET /scheduler/status) had zero automated test coverage despite controlling
 * the autonomous cycle management system.
 *
 * These tests exercise the route handlers via mock Express req/res objects.
 * The scheduler module's start/stop/getStatus functions are tested through
 * the router layer to verify correct HTTP status codes and response shapes.
 *
 * Uses real Redis (DB 1) since the scheduler module's getStatus() calls
 * Redis adapter functions internally.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Setup: point Redis adapter at test DB before importing the router
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

// ---------------------------------------------------------------------------
// Mock Express req/res
// ---------------------------------------------------------------------------

function mockReq(overrides: any = {}): any {
  return { method: "GET", url: "/", headers: {}, query: {}, params: {}, body: {}, ...overrides };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Extract a route handler from an Express Router's internal stack.
// ---------------------------------------------------------------------------

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const handlers = layer.route.methods;
      if (handlers[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Scheduler API routes (issue #164)", () => {
  let createSchedulerRouter: any;
  let stopScheduler: any;

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanKeys();
    if (!createSchedulerRouter) {
      const routerMod = await import("../src/api/scheduler.ts");
      createSchedulerRouter = routerMod.createSchedulerRouter;
      const schedMod = await import("../src/scheduler.ts");
      stopScheduler = schedMod.stop;
    }
    // Ensure scheduler is stopped before each test
    try { stopScheduler(); } catch { /* intentional: may not be running */ }
  });

  after(async () => {
    // Ensure scheduler is stopped after all tests
    try { stopScheduler(); } catch { /* intentional: may not be running */ }
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  // -----------------------------------------------------------------------
  // GET /scheduler/status
  // -----------------------------------------------------------------------

  describe("GET /scheduler/status", () => {
    test("returns expected top-level fields", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const handler = findHandler(router, "GET", "/scheduler/status");
      assert.ok(handler, "GET /scheduler/status handler should exist");

      const req = mockReq();
      const res = mockRes();
      await handler(req, res);

      const body = res._body;
      assert.ok(body, "response body should be set");

      // Required fields per scheduler.ts getStatus()
      const requiredFields = [
        "running", "intervalMs", "cyclesRun", "cyclesMerged",
        "cyclesFailed", "mergeRate",
        // Issue #232: rolling/lifetime split for operator-visible metrics
        "mergeRateLifetime", "mergeRateWindow", "mergeRateCyclesInWindow",
        "lastTickAt", "lastError",
        "startedAt", "consecutiveErrors",
        "research",
      ];
      for (const field of requiredFields) {
        assert.ok(field in body, `status response should contain '${field}' field`);
      }
    });

    test("running is false when scheduler is stopped", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const handler = findHandler(router, "GET", "/scheduler/status");

      const req = mockReq();
      const res = mockRes();
      await handler(req, res);

      assert.equal(res._body.running, false);
    });

    test("research sub-object has expected fields", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const handler = findHandler(router, "GET", "/scheduler/status");

      const req = mockReq();
      const res = mockRes();
      await handler(req, res);

      const research = res._body.research;
      assert.ok(research, "research sub-object should exist");
      const researchFields = [
        "queueThreshold", "buildRatioMax", "currentRatio",
        "researchCount24h", "buildCount24h", "minIntervalHuman",
        "cyclesRun", "lastResearchAt",
        "dailyCostCapUsd", "dailySpendUsd", "dailySpendDate",
      ];
      for (const field of researchFields) {
        assert.ok(field in research, `research should contain '${field}' field`);
      }
    });

    test("mergeRate is 0 when no cycles have run", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const handler = findHandler(router, "GET", "/scheduler/status");

      const req = mockReq();
      const res = mockRes();
      await handler(req, res);

      assert.equal(res._body.mergeRate, 0, "mergeRate should be 0 with no cycles");
    });

    test("cyclesRun, cyclesMerged, cyclesFailed are numbers", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const handler = findHandler(router, "GET", "/scheduler/status");

      const req = mockReq();
      const res = mockRes();
      await handler(req, res);

      assert.equal(typeof res._body.cyclesRun, "number");
      assert.equal(typeof res._body.cyclesMerged, "number");
      assert.equal(typeof res._body.cyclesFailed, "number");
    });
  });

  // -----------------------------------------------------------------------
  // POST /scheduler/stop
  // -----------------------------------------------------------------------

  describe("POST /scheduler/stop", () => {
    test("returns error when scheduler is not running", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const handler = findHandler(router, "POST", "/scheduler/stop");
      assert.ok(handler, "POST /scheduler/stop handler should exist");

      const req = mockReq({ method: "POST" });
      const res = mockRes();
      await handler(req, res);

      assert.equal(res._status, 409, "should return 409 when not running");
      assert.ok(res._body.error, "should return an error message");
      assert.ok(res._body.error.includes("not running"), "error should mention not running");
    });
  });

  // -----------------------------------------------------------------------
  // POST /scheduler/start
  // -----------------------------------------------------------------------

  describe("POST /scheduler/start", () => {
    test("handler exists on the router", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const handler = findHandler(router, "POST", "/scheduler/start");
      assert.ok(handler, "POST /scheduler/start handler should exist");
    });

    test("returns error for too-short interval", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const handler = findHandler(router, "POST", "/scheduler/start");

      // 1ms is way below the 30s minimum
      const req = mockReq({ method: "POST", body: { intervalMs: 1 } });
      const res = mockRes();
      await handler(req, res);

      // scheduler start should reject with error (not 409, it returns JSON with error field)
      assert.ok(res._body.error, "should return an error for too-short interval");
      assert.ok(res._body.error.includes("at least"), "error should mention minimum interval");
    });

    test("start then stop produces correct state transitions", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const startHandler = findHandler(router, "POST", "/scheduler/start");
      const stopHandler = findHandler(router, "POST", "/scheduler/stop");
      const statusHandler = findHandler(router, "GET", "/scheduler/status");

      // Start with a long interval so no actual cycle runs during the test
      const startReq = mockReq({ method: "POST", body: { intervalMs: 600000 } });
      const startRes = mockRes();
      await startHandler(startReq, startRes);

      assert.ok(startRes._body.started, "start should return started: true");
      assert.equal(startRes._body.intervalMs, 600000);

      // Check status shows running
      const statusReq = mockReq();
      const statusRes = mockRes();
      await statusHandler(statusReq, statusRes);
      assert.equal(statusRes._body.running, true, "status should show running after start");

      // Stop
      const stopReq = mockReq({ method: "POST" });
      const stopRes = mockRes();
      await stopHandler(stopReq, stopRes);

      assert.ok(stopRes._body.stopped, "stop should return stopped: true");
      assert.equal(typeof stopRes._body.cyclesRun, "number");
      assert.equal(typeof stopRes._body.stoppedAt, "string");

      // Verify stopped
      const statusReq2 = mockReq();
      const statusRes2 = mockRes();
      await statusHandler(statusReq2, statusRes2);
      assert.equal(statusRes2._body.running, false, "status should show not running after stop");
    });

    test("starting when already running returns 409", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const startHandler = findHandler(router, "POST", "/scheduler/start");

      // Start once
      const req1 = mockReq({ method: "POST", body: { intervalMs: 600000 } });
      const res1 = mockRes();
      await startHandler(req1, res1);
      assert.ok(res1._body.started);

      // Try to start again
      const req2 = mockReq({ method: "POST", body: { intervalMs: 600000 } });
      const res2 = mockRes();
      await startHandler(req2, res2);

      assert.equal(res2._status, 409, "double-start should return 409");
      assert.ok(res2._body.error, "should return an error message");
      assert.ok(res2._body.error.includes("already running"), "error should mention already running");

      // Clean up: stop the scheduler
      stopScheduler();
    });
  });

  // -----------------------------------------------------------------------
  // Status reflects accurate cycle counts
  // -----------------------------------------------------------------------

  describe("scheduler status accuracy", () => {
    test("consecutiveErrors starts at 0", async () => {
      const eventBus = { publisher: redis };
      const router = createSchedulerRouter(eventBus);
      const handler = findHandler(router, "GET", "/scheduler/status");

      const req = mockReq();
      const res = mockRes();
      await handler(req, res);

      assert.equal(res._body.consecutiveErrors, 0);
    });

  });
});
