/**
 * ADR-0016 collateral regression — the metrics + health surfaces that read the
 * retired reframe / prior-failure / abandonment lanes had their vacuous reads
 * removed (the lanes are empty; the accessors are deleted). These tests pin the
 * dropped fields + retired endpoints so they don't silently reappear.
 *
 * Uses Redis DB 1 for isolation, but the assertions are structural — they don't
 * depend on any seeded state.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";
process.env.REDIS_URL = REDIS_URL;

function mockReq(query: any = {}): any {
  return { method: "GET", url: "/", headers: {}, query, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    _type: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    type(t: string) { res._type = t; return res; },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const stack = layer.route.stack;
      if (layer.route.methods[method.toLowerCase()]) return stack[stack.length - 1].handle;
    }
  }
  return null;
}

describe("metrics router — ADR-0016 vacuous-read removal", () => {
  let createMetricsRouter: any;

  before(async () => {
    ({ createMetricsRouter } = await import("../src/api/metrics.ts"));
  });

  after(async () => {
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("/metrics/reframe-starvation endpoint is gone (retired with the reframe lane)", () => {
    const router = createMetricsRouter();
    assert.equal(findHandler(router, "GET", "/metrics/reframe-starvation"), null);
  });

  test("/metrics/capacity-floors endpoint is gone (the reframe-only dispatcher was deleted)", () => {
    const router = createMetricsRouter();
    assert.equal(findHandler(router, "GET", "/metrics/capacity-floors"), null);
  });

  test("/summary no longer reports a 'Prior failures' line", async () => {
    const router = createMetricsRouter();
    const handler = findHandler(router, "GET", "/summary");
    assert.ok(handler);
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(typeof res._body, "string");
    assert.ok(!/Prior failures/.test(res._body), `/summary must not mention prior failures: ${res._body}`);
  });

  test("/metrics/anchor-distribution covers only the live lanes (no reframe/prior-failure rows)", async () => {
    const router = createMetricsRouter();
    const handler = findHandler(router, "GET", "/metrics/anchor-distribution");
    assert.ok(handler);
    const res = mockRes();
    await handler(mockReq({ count: "10" }), res);
    assert.equal(res._status, 200);
    const priorities = res._body.distribution.map((d: any) => d.priority);
    assert.ok(!priorities.includes("reframe"), `reframe row must be gone: ${priorities}`);
    assert.ok(!priorities.includes("prior-failure"), `prior-failure row must be gone: ${priorities}`);
    assert.ok(priorities.includes("kanban"));
    assert.ok(priorities.includes("work-queue"));
  });
});

describe("health router — ADR-0016 vacuous-read removal", () => {
  let createHealthRouter: any;
  const fakeEventBus = { publisher: { ping: async () => "PONG" } };

  before(async () => {
    ({ createHealthRouter } = await import("../src/api/health.ts"));
  });

  after(async () => {
    const { closeRedisConnections } = await import("../src/redis/connection.ts");
    closeRedisConnections();
  });

  test("/health/deep pipeline block no longer carries a priorFailures field", async () => {
    const router = createHealthRouter(fakeEventBus);
    const handler = findHandler(router, "GET", "/health/deep");
    assert.ok(handler);
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._status, 200);
    assert.ok(res._body.pipeline, "pipeline block present");
    assert.equal(
      "priorFailures" in res._body.pipeline,
      false,
      "priorFailures must be dropped from the health pipeline block",
    );
    // Issue #3459: queueDepth + backlogCounts removed from pipeline wire shape
    // (always 0/empty after ADR-0031 retired the Redis backlog subsystem).
    assert.ok(!("queueDepth" in res._body.pipeline), "queueDepth must be removed from pipeline (issue #3459)");
    assert.ok(!("backlogCounts" in res._body.pipeline), "backlogCounts must be removed from pipeline (issue #3459)");
  });
});
