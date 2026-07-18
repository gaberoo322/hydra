/**
 * test/health-recommendations.test.mts — covers the operator-action-items
 * surface extracted out of the health router in issue #1322:
 *
 *   GET /recommendations
 *
 * Named to avoid colliding with test/recommendations-api.test.mts, which covers
 * the unrelated #674 /now/recommendations engine endpoints.
 *
 * Same pattern as test/recommendations-api.test.mts — find the route on the
 * router, mock req/res, inject in-memory deps. No live Express, no Redis, no
 * filesystem.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createRecommendationsRouter,
  type RecommendationsReaderDeps,
} from "../src/api/recommendations.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockReq(): any {
  return { method: "GET", url: "/recommendations", headers: {}, query: {}, params: {}, body: {} };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
    send(body: any) {
      res._body = body;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {
      return res;
    },
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

// Build a router with fully-controlled deps, then return its /recommendations
// handler. Defaults are the "nothing to flag" baseline: scheduler running, no
// priorities.md, no kill file. (The triage / blocked / empty-pipeline action-item
// categories that read the Redis backlog were retired with the Redis backlog
// subsystem — ADR-0031 contract phase, issue #3439 — so `getBacklogCounts` is no
// longer a dep of this router.)
function handlerWith(over: RecommendationsReaderDeps = {}): Function {
  const deps: RecommendationsReaderDeps = {
    getSchedulerStatus: async () => ({ running: true } as any),
    readPriorities: async () => {
      throw new Error("ENOENT");
    },
    killFileExists: () => false,
    ...over,
  };
  const router = createRecommendationsRouter(deps);
  const handler = findHandler(router, "GET", "/recommendations");
  assert.ok(handler, "GET /recommendations handler must be registered");
  return handler!;
}

async function run(deps: RecommendationsReaderDeps = {}): Promise<any> {
  const handler = handlerWith(deps);
  const res = mockRes();
  await handler(mockReq(), res);
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /recommendations — operator action items (issue #1322)", () => {
  test("byte-identical wire shape: 200 with a bare JSON array", async () => {
    const res = await run();
    assert.equal(res._status, 200);
    assert.ok(Array.isArray(res._body), "body is a bare array, not an envelope");
  });

  test("baseline (nothing wrong) yields an empty array", async () => {
    const res = await run();
    assert.deepEqual(res._body, []);
  });

  test("scheduler stopped", async () => {
    const res = await run({ getSchedulerStatus: async () => ({ running: false } as any) });
    const rec = res._body.find((r: any) => r.title === "Scheduler is stopped");
    assert.ok(rec);
    assert.equal(rec.priority, 1);
    assert.equal(rec.link, "/");
  });

  test("priorities.md [BLOCKED] headers surface", async () => {
    const md = [
      "## 1) [BLOCKED] Wire the payout adapter",
      "  - Blocked on operator: provide the Stripe key",
      "",
      "## 2) Some normal priority",
    ].join("\n");
    const res = await run({ readPriorities: async () => md });
    const rec = res._body.find((r: any) => /blocked on operator action/.test(r.title));
    assert.ok(rec, "a priorities-blocked rec is emitted");
    assert.equal(rec.priority, 1);
    assert.equal(rec.link, "/vision");
    assert.match(rec.description, /Wire the payout adapter/);
    assert.match(rec.description, /provide the Stripe key/);
  });

  test("missing priorities.md degrades silently (no rec, no throw)", async () => {
    const res = await run({
      readPriorities: async () => {
        throw new Error("ENOENT: no such file");
      },
    });
    assert.equal(res._status, 200);
    assert.ok(!res._body.some((r: any) => /blocked on operator action/.test(r.title)));
  });

  test("kill switch active", async () => {
    const res = await run({ killFileExists: () => true });
    const rec = res._body.find((r: any) => r.title === "Kill switch is active");
    assert.ok(rec);
    assert.equal(rec.priority, 1);
    assert.equal(rec.link, "/health");
  });

  test("recs are sorted by priority ascending (1=urgent first)", async () => {
    const res = await run({
      getSchedulerStatus: async () => ({ running: false } as any),
      killFileExists: () => true,
    });
    const priorities = res._body.map((r: any) => r.priority);
    const sorted = [...priorities].sort((a, b) => a - b);
    assert.deepEqual(priorities, sorted, "priorities are non-decreasing");
    assert.equal(priorities[0], 1, "the most urgent rec is first");
    assert.ok(priorities.length >= 2, "both scheduler-stopped and kill-switch recs are emitted");
  });

  test("error contract: a throwing scheduler read yields 200 with a partial array, NOT a 500", async () => {
    const res = await run({
      getSchedulerStatus: async () => {
        throw new Error("redis down");
      },
    });
    // The bespoke inner try/catch swallows to a 200 partial array (here empty),
    // never a 500. This is the load-bearing reason it is NOT wrapped in
    // aggregatorRouteNoQuery.
    assert.equal(res._status, 200);
    assert.deepEqual(res._body, []);
  });

  test("deps default to real impls when none are injected (router constructs)", () => {
    const router = createRecommendationsRouter();
    const handler = findHandler(router, "GET", "/recommendations");
    assert.ok(handler, "router with no deps still registers the route");
  });
});
