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
 * Uses real Redis since runHousekeeping reads/writes guard keys. Defers to
 * the per-run REDIS_URL the launcher derives (#1676) — a hard DB-4 pin here
 * collided across concurrent worktree runs — with DB 4 as the fallback for
 * direct single-file invocations (the dedicated-DB rationale from issue #948
 * predates --test-concurrency=1; serial files make the shared run DB safe).
 * REDIS_URL is pinned here — before the maintenance router is imported in
 * beforeEach — so the production singleton (getRedisConnection) and this
 * suite's own client both resolve to the same DB.
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/4";
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

    // Issue #1876: the stale-key sweep folded out of cleanup.ts must be in the
    // chore list and run on a clean DB. (The former `stale-inprogress-return`
    // no-guard cleanup chore was retired with the Redis backlog subsystem —
    // ADR-0031 contract phase, issue #3439; `review-pickup-notify` is now the
    // representative no-guard "always runs" chore.)
    assert.ok(
      body.ran.includes("stale-key-prune"),
      "stale-key-prune should run on a clean DB (daily guard unset)",
    );
    assert.ok(
      body.ran.includes("review-pickup-notify"),
      "review-pickup-notify should run (no guard — always runs)",
    );
  });

  // Issue #1876: the daily-guarded stale-key sweep must skip on the second
  // immediate call, exactly like memory-consolidation / weekly-summary.
  test("stale-key-prune skips on a second immediate call (daily guard)", async () => {
    const router = createMaintenanceRouter(mockEventBus());
    const handler = findHandler(router, "POST", "/maintenance/housekeeping");

    const res1 = mockRes();
    await handler(mockReq(), res1);
    assert.ok(
      res1._body.ran.includes("stale-key-prune"),
      "first call should run stale-key-prune",
    );

    const res2 = mockRes();
    await handler(mockReq(), res2);
    assert.ok(
      res2._body.skipped.includes("stale-key-prune"),
      "second call should skip stale-key-prune (daily guard set)",
    );
    assert.ok(
      !res2._body.ran.includes("stale-key-prune"),
      "second call must NOT re-run stale-key-prune",
    );
    // review-pickup-notify has no guard, so it runs every time.
    assert.ok(
      res2._body.ran.includes("review-pickup-notify"),
      "review-pickup-notify runs every call (no guard)",
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

/**
 * Unit coverage for the extracted guarded-chore runner (issue #1864).
 *
 * `runChore` encapsulates the guard → work → bookkeeping → error-log + Sentry
 * pattern that was re-spelled inline for each of the 9 housekeeping chores.
 * These tests inject thunks directly (no Redis, no HTTP endpoint) to pin the
 * runner's routing of ran/skipped across the four outcomes: guard-skip,
 * work-skip (work returns false), success, and failure.
 */
describe("runChore guarded-chore runner (issue #1864)", () => {
  let runChore: any;

  beforeEach(async () => {
    if (!runChore) {
      const mod = await import("../src/scheduler/housekeeping.ts");
      runChore = mod.runChore;
    }
  });

  test("a chore with no guard whose work succeeds is recorded as ran", async () => {
    const ran: string[] = [];
    const skipped: string[] = [];
    let invoked = false;
    await runChore(
      { name: "c-success", work: async () => { invoked = true; } },
      ran,
      skipped,
    );
    assert.ok(invoked, "work should be invoked when there is no guard");
    assert.deepEqual(ran, ["c-success"], "success should append to ran");
    assert.deepEqual(skipped, [], "success should not append to skipped");
  });

  test("a guard returning false skips work and records skipped", async () => {
    const ran: string[] = [];
    const skipped: string[] = [];
    let workInvoked = false;
    await runChore(
      {
        name: "c-guarded",
        guard: async () => false,
        work: async () => { workInvoked = true; },
      },
      ran,
      skipped,
    );
    assert.equal(workInvoked, false, "work must NOT run when the guard returns false");
    assert.deepEqual(skipped, ["c-guarded"], "a guard miss appends to skipped");
    assert.deepEqual(ran, [], "a guard miss does not append to ran");
  });

  test("work returning false routes to skipped (conditional no-op)", async () => {
    const ran: string[] = [];
    const skipped: string[] = [];
    await runChore(
      { name: "c-noop", work: async () => false },
      ran,
      skipped,
    );
    assert.deepEqual(skipped, ["c-noop"], "work returning false appends to skipped");
    assert.deepEqual(ran, [], "work returning false does not append to ran");
  });

  test("a throwing chore is caught, recorded as skipped, and does not propagate", async () => {
    const ran: string[] = [];
    const skipped: string[] = [];
    const originalError = console.error;
    let logged = "";
    console.error = (msg: any) => { logged = String(msg); };
    try {
      await runChore(
        {
          name: "c-throws",
          work: async () => { throw new Error("boom"); },
        },
        ran,
        skipped,
      );
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(skipped, ["c-throws"], "a throwing chore appends to skipped");
    assert.deepEqual(ran, [], "a throwing chore does not append to ran");
    assert.match(logged, /c-throws failed: boom/, "the error is logged with the chore name");
  });

  test("a guard that throws is caught and recorded as skipped", async () => {
    const ran: string[] = [];
    const skipped: string[] = [];
    let workInvoked = false;
    const originalError = console.error;
    console.error = () => {};
    try {
      await runChore(
        {
          name: "c-guard-throws",
          guard: async () => { throw new Error("guard-boom"); },
          work: async () => { workInvoked = true; },
        },
        ran,
        skipped,
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(workInvoked, false, "work must NOT run when the guard throws");
    assert.deepEqual(skipped, ["c-guard-throws"], "a throwing guard appends to skipped");
    assert.deepEqual(ran, [], "a throwing guard does not append to ran");
  });
});

/**
 * Unit coverage for the two cleanup chores folded out of the cleanup.ts
 * in-process timer (issue #1876). The work functions are now exported from
 * housekeeping.ts, so they are exercisable against real Redis without an HTTP
 * server or a live setInterval — the testability benefit the issue called out.
 *
 * Uses a DEDICATED Redis client (`redis2`) on the same REDIS_URL — NOT the
 * shared `redis` client above, whose `after` hook calls `redis.disconnect()`
 * once the first describe block finishes (the work functions reach Redis via
 * the production `getRedisConnection()` singleton, so DB targeting is the same).
 */
describe("cleanup chores folded into housekeeping (issue #1876)", () => {
  let pruneStaleRedisKeys: any;
  let redis2: any;

  async function cleanKeys2() {
    const keys = await redis2.keys("hydra:*");
    if (keys.length > 0) await redis2.del(...keys);
  }

  beforeEach(async () => {
    if (!redis2) {
      redis2 = new Redis(REDIS_URL);
    }
    await cleanKeys2();
    if (!pruneStaleRedisKeys) {
      const mod = await import("../src/scheduler/housekeeping.ts");
      pruneStaleRedisKeys = mod.pruneStaleRedisKeys;
    }
  });

  after(async () => {
    if (redis2) {
      await cleanKeys2();
      redis2.disconnect();
    }
  });

  test("pruneStaleRedisKeys deletes a >7d no-TTL cycle key and keeps a fresh one", async () => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const oldDate = "2020-01-01"; // well past the 7-day cutoff
    const staleKey = `hydra:cycle:cycle-${oldDate}-0000:tasks`;
    const freshKey = `hydra:cycle:cycle-${today}-0000:tasks`;

    await redis2.set(staleKey, "x"); // no TTL → eligible
    await redis2.set(freshKey, "x"); // dated today → kept

    await pruneStaleRedisKeys();

    assert.equal(await redis2.exists(staleKey), 0, "stale dated key should be deleted");
    assert.equal(await redis2.exists(freshKey), 1, "fresh dated key should be kept");
  });

  test("pruneStaleRedisKeys skips a key that already has a TTL", async () => {
    const ttlKey = "hydra:cycle:cycle-2020-01-01-0000:agents";
    await redis2.set(ttlKey, "x", "EX", 3600); // has a TTL → must be skipped

    await pruneStaleRedisKeys();

    assert.equal(await redis2.exists(ttlKey), 1, "a key with a TTL must not be pruned");
  });

  // The `returnStaleInProgressItems` cleanup chore (and its two tests) was
  // retired with the Redis backlog subsystem — ADR-0031 contract phase, issue
  // #3439. The Target now tracks work as GitHub Issues, so there is no Redis
  // inProgress lane to sweep. `pruneStaleRedisKeys` (above) survives.
});
