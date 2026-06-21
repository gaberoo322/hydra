/**
 * api-health-source-index.test.mts — GET /health/source-index route (issue #2267).
 *
 * Verifies the read-only freshness diagnostic: it reports the durable
 * source-hash cache size from real Redis, exposes the OV-truth probe result and
 * the `stale` fold, and MUTATES NOTHING (the cache count is unchanged after the
 * probe runs). Top-level describe with its own Redis lifecycle (CLAUDE.md
 * authoring rule) + beforeEach cleanup for per-case isolation.
 *
 * The `ovSourceResourcesPresent`/`stale` fields depend on a live OpenViking, so
 * this test asserts on the deterministic cache-driven contract (shape, the
 * cached count, read-only invariant) rather than pinning the OV-dependent value.
 * The pure `stale := cached>0 && !present` fold is exercised deterministically
 * by test/source-index-staleness.test.mts via the injectable lifecycle probe.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

const SOURCE_HASHES_KEY = "hydra:knowledge:source-hashes";

function mockReq(): any {
  return { method: "GET", url: "/health/source-index", headers: {}, query: {}, params: {}, body: {} };
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
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

describe("GET /health/source-index (issue #2267)", () => {
  let redis: any;
  let createHealthRouter: any;

  before(async () => {
    redis = new Redis(REDIS_URL);
    ({ createHealthRouter } = await import("../src/api/health.ts"));
  });

  after(async () => {
    await redis.del(SOURCE_HASHES_KEY);
    redis.disconnect();
  });

  beforeEach(async () => {
    await redis.del(SOURCE_HASHES_KEY);
  });

  test("route exists and returns the freshness diagnostic shape", async () => {
    const router = createHealthRouter({ publisher: redis });
    const handler = findHandler(router, "GET", "/health/source-index");
    assert.ok(handler, "GET /health/source-index handler should exist");

    const res = mockRes();
    await handler(mockReq(), res);

    assert.ok(res._body, "response body should be set");
    for (const field of ["status", "cachedSourceHashes", "ovSourceResourcesPresent", "stale", "diagnostic"]) {
      assert.ok(field in res._body, `response should contain '${field}'`);
    }
    assert.equal(typeof res._body.cachedSourceHashes, "number");
    assert.equal(typeof res._body.ovSourceResourcesPresent, "boolean");
    assert.equal(typeof res._body.stale, "boolean");
  });

  test("reports the real cached-hash count from Redis", async () => {
    await redis.hset(SOURCE_HASHES_KEY, "/a.ts", "h1", "/b.ts", "h2", "/c.ts", "h3");
    const router = createHealthRouter({ publisher: redis });
    const handler = findHandler(router, "GET", "/health/source-index");

    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._body.cachedSourceHashes, 3);
  });

  test("is READ-ONLY: the probe does not mutate the cache", async () => {
    await redis.hset(SOURCE_HASHES_KEY, "/a.ts", "h1", "/b.ts", "h2");
    const router = createHealthRouter({ publisher: redis });
    const handler = findHandler(router, "GET", "/health/source-index");

    await handler(mockReq(), mockRes());

    // The diagnostic must never clear the cache — only the lifecycle path does.
    assert.equal(await redis.hlen(SOURCE_HASHES_KEY), 2, "health probe must not mutate the source-hash cache");
  });

  test("empty cache reports cachedSourceHashes:0 and is never stale", async () => {
    const router = createHealthRouter({ publisher: redis });
    const handler = findHandler(router, "GET", "/health/source-index");

    const res = mockRes();
    await handler(mockReq(), res);

    assert.equal(res._body.cachedSourceHashes, 0);
    // stale requires cached>0, so an empty cache is never stale regardless of OV.
    assert.equal(res._body.stale, false);
  });
});
