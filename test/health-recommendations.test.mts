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

// Backlog-count shape the handler reads (triage, blocked, total, inProgress).
function counts(over: Partial<{ triage: number; blocked: number; total: number; inProgress: number }> = {}) {
  return { triage: 0, blocked: 0, total: 5, inProgress: 1, ...over };
}

// Build a router with fully-controlled deps, then return its /recommendations
// handler. Defaults are the "nothing to flag" baseline: non-empty backlog, no
// triage/blocked, scheduler running, no priorities.md, no kill file.
function handlerWith(over: RecommendationsReaderDeps = {}): Function {
  const deps: RecommendationsReaderDeps = {
    getBacklogCounts: async () => counts() as any,
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

  test("category 1: triage items awaiting review", async () => {
    const res = await run({ getBacklogCounts: async () => counts({ triage: 3 }) as any });
    const rec = res._body.find((r: any) => r.type === "review");
    assert.ok(rec, "a review rec is emitted when triage > 0");
    assert.equal(rec.priority, 2);
    assert.match(rec.title, /3 items in Triage/);
    assert.equal(rec.link, "/backlog");
  });

  test("category 1: singular wording when triage === 1", async () => {
    const res = await run({ getBacklogCounts: async () => counts({ triage: 1 }) as any });
    const rec = res._body.find((r: any) => r.type === "review");
    assert.match(rec.title, /1 item in Triage/);
  });

  test("category 2: blocked items need intervention", async () => {
    const res = await run({ getBacklogCounts: async () => counts({ blocked: 2 }) as any });
    const rec = res._body.find((r: any) => /blocked item/.test(r.title));
    assert.ok(rec);
    assert.equal(rec.priority, 1);
    assert.equal(rec.type, "action");
  });

  test("category 3: scheduler stopped", async () => {
    const res = await run({ getSchedulerStatus: async () => ({ running: false } as any) });
    const rec = res._body.find((r: any) => r.title === "Scheduler is stopped");
    assert.ok(rec);
    assert.equal(rec.priority, 1);
    assert.equal(rec.link, "/");
  });

  test("category 4: empty work pipeline", async () => {
    const res = await run({
      getBacklogCounts: async () => counts({ total: 0, inProgress: 0, triage: 0 }) as any,
    });
    const rec = res._body.find((r: any) => r.title === "Work pipeline is empty");
    assert.ok(rec);
    assert.equal(rec.priority, 3);
    assert.equal(rec.type, "info");
  });

  test("category 5: priorities.md [BLOCKED] headers surface", async () => {
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

  test("category 5: missing priorities.md degrades silently (no rec, no throw)", async () => {
    const res = await run({
      readPriorities: async () => {
        throw new Error("ENOENT: no such file");
      },
    });
    assert.equal(res._status, 200);
    assert.ok(!res._body.some((r: any) => /blocked on operator action/.test(r.title)));
  });

  test("category 6: kill switch active", async () => {
    const res = await run({ killFileExists: () => true });
    const rec = res._body.find((r: any) => r.title === "Kill switch is active");
    assert.ok(rec);
    assert.equal(rec.priority, 1);
    assert.equal(rec.link, "/health");
  });

  test("recs are sorted by priority ascending (1=urgent first)", async () => {
    const res = await run({
      getBacklogCounts: async () => counts({ triage: 1, blocked: 1 }) as any,
      killFileExists: () => true,
    });
    const priorities = res._body.map((r: any) => r.priority);
    const sorted = [...priorities].sort((a, b) => a - b);
    assert.deepEqual(priorities, sorted, "priorities are non-decreasing");
    assert.equal(priorities[0], 1, "the most urgent rec is first");
  });

  test("error contract: a throwing backlog read yields 200 with a partial array, NOT a 500", async () => {
    const res = await run({
      getBacklogCounts: async () => {
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
