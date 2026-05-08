/**
 * Regression tests for the health API routes (issue #164).
 *
 * Bug: The /api/health endpoint had zero automated test coverage despite
 * being the primary monitoring surface for the operator dashboard and
 * watchdog timer.
 *
 * These tests exercise the GET /health route handler via mock Express
 * req/res objects and a mock eventBus, using real Redis (DB 1) for
 * the adapter functions called by the handler.
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
  return { method: "GET", url: "/health", headers: {}, query: {}, params: {}, body: {}, ...overrides };
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
// Express stores route layers in router.stack; each layer has a route
// with a path and method handlers.
// ---------------------------------------------------------------------------

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const handlers = layer.route.methods;
      if (handlers[method.toLowerCase()]) {
        // Return the last handler in the stack (the actual handler, not middleware)
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

describe("GET /health — basic health check (issue #164)", () => {
  let createHealthRouter: any;

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanKeys();
    if (!createHealthRouter) {
      const mod = await import("../src/api/health.ts");
      createHealthRouter = mod.createHealthRouter;
    }
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  test("returns status, redis, uptime, and cycle fields", async () => {
    const eventBus = { publisher: redis };
    const router = createHealthRouter(eventBus);
    const handler = findHandler(router, "GET", "/health");
    assert.ok(handler, "GET /health handler should exist on the router");

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.ok(res._body, "response body should be set");
    assert.ok("status" in res._body, "response should contain 'status' field");
    assert.ok("redis" in res._body, "response should contain 'redis' field");
    assert.ok("uptime" in res._body, "response should contain 'uptime' field");
    assert.ok("cycle" in res._body, "response should contain 'cycle' field");
  });

  test("status is 'ok' when no kill file exists", async () => {
    const eventBus = { publisher: redis };
    const router = createHealthRouter(eventBus);
    const handler = findHandler(router, "GET", "/health");

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // Unless a kill file happens to exist in the test environment,
    // status should be "ok"
    assert.equal(res._body.status, "ok");
  });

  test("redis field is true when Redis is connected", async () => {
    const eventBus = { publisher: redis };
    const router = createHealthRouter(eventBus);
    const handler = findHandler(router, "GET", "/health");

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._body.redis, true, "redis should be true when publisher.ping() succeeds");
  });

  test("redis field is false when publisher.ping() fails", async () => {
    // Create a broken eventBus whose publisher.ping() rejects
    const brokenPublisher = {
      async ping() { throw new Error("connection refused"); },
    };
    const eventBus = { publisher: brokenPublisher };
    const router = createHealthRouter(eventBus);
    const handler = findHandler(router, "GET", "/health");

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._body.redis, false, "redis should be false when ping fails");
  });

  test("uptime is a positive number", async () => {
    const eventBus = { publisher: redis };
    const router = createHealthRouter(eventBus);
    const handler = findHandler(router, "GET", "/health");

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.equal(typeof res._body.uptime, "number");
    assert.ok(res._body.uptime > 0, "uptime should be positive");
  });

  test("cycle field defaults to 'idle' when no cycle is running", async () => {
    const eventBus = { publisher: redis };
    const router = createHealthRouter(eventBus);
    const handler = findHandler(router, "GET", "/health");

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._body.cycle, "idle");
  });

  test("response shape matches what watchdog expects (status + redis)", async () => {
    // The watchdog script checks:
    //   1. /health responds with status: "ok" and redis: true
    //   2. Scheduler lastCycleAt not stale
    // This test verifies the response has the fields the watchdog needs.
    const eventBus = { publisher: redis };
    const router = createHealthRouter(eventBus);
    const handler = findHandler(router, "GET", "/health");

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    // Watchdog checks: status === "ok" && redis === true
    assert.equal(typeof res._body.status, "string", "status must be a string for watchdog comparison");
    assert.equal(typeof res._body.redis, "boolean", "redis must be a boolean for watchdog comparison");
  });

  test("response shape matches what dashboard expects", async () => {
    // Dashboard OverviewPage fetches /api/health and renders:
    //   status, redis, cycle, uptime
    const eventBus = { publisher: redis };
    const router = createHealthRouter(eventBus);
    const handler = findHandler(router, "GET", "/health");

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    const body = res._body;
    const requiredFields = ["status", "redis", "cycle", "uptime"];
    for (const field of requiredFields) {
      assert.ok(field in body, `dashboard requires '${field}' field in health response`);
    }
  });
});
