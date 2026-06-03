/**
 * Regression tests for the maintenance housekeeping endpoint (issue #723,
 * scheduler fold PR-3/4).
 *
 * The five time-boxed housekeeping chores (blocked re-escalation, done-lane
 * pruning, weekly digest, memory consolidation, design-concept snapshot) were
 * extracted out of the 2-minute scheduler tick (`runScheduledCycle`) into an
 * exported `runHousekeeping(eventBus)`, surfaced by an idempotent
 * `POST /api/maintenance/housekeeping` endpoint that an hourly
 * `hydra-housekeeping.timer` triggers.
 *
 * These tests prove:
 *   1. POST /api/maintenance/housekeeping runs and returns a { ran, skipped }
 *      summary.
 *   2. It is idempotent — a second immediate call SKIPS the time-guarded chores
 *      that the first call already performed (the per-day / daily guards fire).
 *
 * Uses real Redis (DB 4) since runHousekeeping reads/writes guard keys. A
 * dedicated DB isolates this suite's bulk `keys("hydra:*")` + `del(...)`
 * cleanup from fixtures other suites (notably scheduler-status) seed
 * concurrently under default parallel node:test (issue #948). REDIS_URL is
 * overridden here — before the maintenance router is imported in beforeEach —
 * so the production singleton (getRedisConnection) and this suite's own
 * client both resolve to the same isolated DB.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = "redis://localhost:6379/4";
process.env.REDIS_URL = REDIS_URL;

let redis: any;

async function cleanKeys() {
  const keys = await redis.keys("hydra:*");
  if (keys.length > 0) await redis.del(...keys);
}

// Minimal eventBus stub — checkBlockedEscalation only publishes when there are
// stale blocked items, which there aren't in a clean test DB. publish is a
// no-op so the chore completes without touching a real stream.
function mockEventBus(): any {
  return {
    publish: async () => {},
    publisher: redis,
  };
}

// Mock Express req/res, mirroring api-scheduler.test.mts.
function mockReq(overrides: any = {}): any {
  return { method: "POST", url: "/", headers: {}, query: {}, params: {}, body: {}, ...overrides };
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

describe("Maintenance housekeeping endpoint (issue #723)", () => {
  let createMaintenanceRouter: any;

  beforeEach(async () => {
    if (!redis) {
      redis = new Redis(REDIS_URL);
    }
    await cleanKeys();
    if (!createMaintenanceRouter) {
      const mod = await import("../src/api/maintenance.ts");
      createMaintenanceRouter = mod.createMaintenanceRouter;
    }
  });

  after(async () => {
    if (redis) {
      await cleanKeys();
      redis.disconnect();
    }
  });

  test("POST /maintenance/housekeeping handler exists", async () => {
    const router = createMaintenanceRouter(mockEventBus());
    const handler = findHandler(router, "POST", "/maintenance/housekeeping");
    assert.ok(handler, "POST /maintenance/housekeeping handler should exist");
  });

  test("first call runs and returns a { ran, skipped } summary", async () => {
    const router = createMaintenanceRouter(mockEventBus());
    const handler = findHandler(router, "POST", "/maintenance/housekeeping");

    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._status, 200, "should respond 200");
    const body = res._body;
    assert.ok(body, "response body should be set");
    assert.equal(body.ok, true, "ok should be true");
    assert.ok(Array.isArray(body.ran), "ran should be an array");
    assert.ok(Array.isArray(body.skipped), "skipped should be an array");

    // On a clean DB, the daily/per-day guarded chores should RUN on the first
    // call (their guard keys are unset).
    assert.ok(
      body.ran.includes("memory-consolidation"),
      "memory-consolidation should run on a clean DB",
    );
    assert.ok(
      body.ran.includes("design-concept-snapshot"),
      "design-concept-snapshot should run on a clean DB",
    );
  });

  test("second immediate call skips the time-guarded chores (idempotent)", async () => {
    const router = createMaintenanceRouter(mockEventBus());
    const handler = findHandler(router, "POST", "/maintenance/housekeeping");

    // First call — performs the guarded chores and sets their guard keys.
    const res1 = mockRes();
    await handler(mockReq(), res1);
    assert.equal(res1._body.ok, true);
    assert.ok(
      res1._body.ran.includes("memory-consolidation"),
      "first call should run memory-consolidation",
    );
    assert.ok(
      res1._body.ran.includes("design-concept-snapshot"),
      "first call should run design-concept-snapshot",
    );

    // Second immediate call — the daily / per-day guards are now set, so the
    // time-guarded chores must SKIP. This is the idempotency contract that
    // makes hourly invocation safe.
    const res2 = mockRes();
    await handler(mockReq(), res2);
    assert.equal(res2._body.ok, true);
    assert.ok(
      res2._body.skipped.includes("memory-consolidation"),
      "second call should skip memory-consolidation (daily guard set)",
    );
    assert.ok(
      res2._body.skipped.includes("design-concept-snapshot"),
      "second call should skip design-concept-snapshot (per-day guard set)",
    );
    assert.ok(
      !res2._body.ran.includes("memory-consolidation"),
      "second call must NOT re-run memory-consolidation",
    );
    assert.ok(
      !res2._body.ran.includes("design-concept-snapshot"),
      "second call must NOT re-run design-concept-snapshot",
    );
  });
});
