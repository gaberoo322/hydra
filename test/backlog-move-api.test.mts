/**
 * Regression tests for PATCH /backlog/:id/move — issue #2164.
 *
 * The PATCH handler previously dropped the `reason` field from the request
 * body, making it impossible to move an item to the blocked lane over HTTP.
 * moveItemToLane requires a reason for unexplained blocked moves and returns
 * { ok: false, error: "missing-blocked-reason" } without one.
 *
 * These tests exercise the HTTP boundary (via the Express router directly)
 * on top of a live Redis connection in DB 1.
 *
 * Design note: this is a NEW top-level describe with its OWN before/after
 * lifecycle — NOT nested inside backlog.test.mts's shared describe. Per the
 * CLAUDE.md pitfall, the shared Redis teardown in backlog.test.mts fires
 * when that suite finishes; nesting here would cause a disconnected Redis
 * connection for any later top-level suite.
 */
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

// Use Redis DB 1 for tests — same as backlog.test.mts, cleaned between tests.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

import { createBacklogRouter } from "../src/api/backlog.ts";
import { addToBacklog } from "../src/backlog/items.ts";
import { blockByTitle } from "../src/backlog/lanes.ts";

let redis: any;
let redisAvailable = false;

function requireRedis(t: any) {
  if (!redisAvailable) t.skip("Redis unavailable");
}

async function cleanBacklogKeys() {
  const keys = await redis.keys("hydra:backlog:*");
  if (keys.length > 0) await redis.del(...keys);
}

/**
 * Minimal Express-like mock objects for exercising router handlers directly.
 */
function makeRes() {
  const res: any = { _status: 200, _body: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (body: any) => { res._body = body; return res; };
  return res;
}

function makeReq(params: Record<string, string>, body: any) {
  return {
    method: "PATCH",
    params,
    body,
    query: {},
    headers: {},
  } as any;
}

/** Find the PATCH /backlog/:id/move handler in the router stack. */
function findMoveHandler(router: any): Function {
  for (const layer of router.stack) {
    if (
      layer.route &&
      layer.route.path === "/backlog/:id/move" &&
      layer.route.methods.patch
    ) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error("PATCH /backlog/:id/move handler not found in router");
}

describe("PATCH /backlog/:id/move — reason forwarding (issue #2164)", () => {
  before(async () => {
    redis = new Redis(process.env.REDIS_URL!);
    try {
      await redis.ping();
      redisAvailable = true;
    } catch {
      console.error(
        "Redis unavailable at localhost:6379/1, skipping backlog-move-api tests",
      );
    }
    if (redisAvailable) await cleanBacklogKeys();
  });

  beforeEach(async () => {
    if (redisAvailable) await cleanBacklogKeys();
  });

  after(async () => {
    if (redis) {
      if (redisAvailable) await cleanBacklogKeys();
      redis.disconnect();
    }
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("move→blocked with reason succeeds and stamps blockedReason", async (t) => {
    requireRedis(t);
    const { id } = await addToBacklog({ title: "HTTP blocked reason test", category: "test" });

    const router = createBacklogRouter();
    const handler = findMoveHandler(router);
    const req = makeReq({ id }, { lane: "blocked", reason: "waiting on external key" });
    const res = makeRes();

    await handler(req, res, () => {});

    assert.equal(res._status, 200, `expected 200, got ${res._status} — body: ${JSON.stringify(res._body)}`);
    assert.equal(res._body?.ok, true, `expected ok:true, got: ${JSON.stringify(res._body)}`);

    // Verify blockedReason was stamped on the item.
    const { loadBacklog } = await import("../src/backlog/reads.ts");
    const lanes = await loadBacklog();
    const item = lanes.blocked.find((i: any) => i.id === id);
    assert.ok(item, "item must be in blocked lane after move");
    assert.equal(
      item.meta?.blockedReason,
      "waiting on external key",
      "blockedReason must be stamped on the item for downstream actionability",
    );
  });

  test("move→blocked without reason returns missing-blocked-reason (not 500)", async (t) => {
    requireRedis(t);
    const { id } = await addToBacklog({ title: "HTTP blocked no-reason test", category: "test" });

    const router = createBacklogRouter();
    const handler = findMoveHandler(router);
    const req = makeReq({ id }, { lane: "blocked" }); // no reason field
    const res = makeRes();

    await handler(req, res, () => {});

    // The handler must surface the lane-layer's {ok:false, error:"missing-blocked-reason"}
    // as a 404, not crash with 500 or silently return 200.
    assert.equal(
      res._status,
      404,
      `expected 404 (missing-blocked-reason), got ${res._status} — body: ${JSON.stringify(res._body)}`,
    );
    assert.equal(
      res._body?.error,
      "missing-blocked-reason",
      `expected error:"missing-blocked-reason", got: ${JSON.stringify(res._body)}`,
    );

    // The item must NOT have moved to the blocked lane.
    const { loadBacklog } = await import("../src/backlog/reads.ts");
    const lanes = await loadBacklog();
    assert.ok(
      !lanes.blocked.some((i: any) => i.id === id),
      "item must not appear in blocked lane when reason is missing",
    );
  });

  test("move→blocked without reason succeeds when item already has blockedReason", async (t) => {
    requireRedis(t);
    // blockByTitle stamps meta.blockedReason, so a later move-to-blocked without
    // a fresh reason satisfies the guard via the pre-existing reason.
    await addToBacklog({ title: "HTTP pre-blocked 2164", category: "test" });
    await blockByTitle("HTTP pre-blocked 2164", "original operator reason");

    const { loadBacklog } = await import("../src/backlog/reads.ts");
    let lanes = await loadBacklog();
    const item = lanes.blocked.find((i: any) => i.title === "HTTP pre-blocked 2164");
    assert.ok(item, "item must be in blocked lane after blockByTitle");

    // Move it out to queued, then back to blocked without a new reason — should succeed.
    const router = createBacklogRouter();
    const handler = findMoveHandler(router);

    const reqQueued = makeReq({ id: item.id }, { lane: "queued" });
    const resQueued = makeRes();
    await handler(reqQueued, resQueued, () => {});
    assert.equal(resQueued._status, 200, "move to queued must succeed");

    const reqBlocked = makeReq({ id: item.id }, { lane: "blocked" }); // no new reason
    const resBlocked = makeRes();
    await handler(reqBlocked, resBlocked, () => {});

    assert.equal(
      resBlocked._status,
      200,
      `expected 200 (pre-existing reason satisfies guard), got ${resBlocked._status} — body: ${JSON.stringify(resBlocked._body)}`,
    );
    assert.equal(resBlocked._body?.ok, true);
  });

  test("move→blocked without lane returns 400 schema-validation-failed", async (t) => {
    requireRedis(t);
    const { id } = await addToBacklog({ title: "HTTP missing lane test", category: "test" });

    const router = createBacklogRouter();
    const handler = findMoveHandler(router);
    const req = makeReq({ id }, {}); // no lane field
    const res = makeRes();

    await handler(req, res, () => {});

    assert.equal(
      res._status,
      400,
      `expected 400 for missing lane, got ${res._status}`,
    );
    assert.equal(
      res._body?.code,
      "schema-validation-failed",
      `expected code:"schema-validation-failed", got: ${JSON.stringify(res._body)}`,
    );
  });

  test("move to non-blocked lane with reason still succeeds (reason is optional)", async (t) => {
    requireRedis(t);
    const { id } = await addToBacklog({ title: "HTTP reason non-blocked test", category: "test" });

    const router = createBacklogRouter();
    const handler = findMoveHandler(router);
    const req = makeReq({ id }, { lane: "queued", reason: "promoted by operator" });
    const res = makeRes();

    await handler(req, res, () => {});

    assert.equal(res._status, 200, `expected 200, got ${res._status}`);
    assert.equal(res._body?.ok, true);

    const { loadBacklog } = await import("../src/backlog/reads.ts");
    const lanes = await loadBacklog();
    assert.ok(lanes.queued.some((i: any) => i.id === id), "item must be in queued lane");
  });
});
