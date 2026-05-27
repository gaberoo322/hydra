/**
 * Regression tests for GET /api/today/summary (issue #616, PRD #615).
 *
 * Pins:
 *   - Zod boundary parse — bad `windowHours` returns 400 with the
 *     `schema-validation-failed` envelope (same shape as POST /api/queue).
 *   - Happy path — aggregator stub plumbs through the route handler
 *     end-to-end without spawning subprocesses or touching Redis.
 *   - Default windowHours — omitted query param applies the 12h default.
 *
 * Follows the test/api-queue-schema.test.mts pattern: test the pure
 * schema directly AND wire the router with a stubbed aggregator to pin
 * the route shape, no Express server required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  OvernightSummaryQuerySchema,
  OvernightSummaryResponseSchema,
} from "../src/schemas/today-page.ts";
import { createTodayPageRouter } from "../src/api/today-page.ts";

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("OvernightSummaryQuerySchema — happy path", () => {
  test("defaults windowHours to 12 when omitted", () => {
    const result = OvernightSummaryQuerySchema.safeParse({});
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.windowHours, 12);
  });

  test("accepts a numeric windowHours", () => {
    const result = OvernightSummaryQuerySchema.safeParse({ windowHours: 24 });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.windowHours, 24);
  });

  test("coerces a string windowHours (Express query param shape)", () => {
    // req.query values arrive as strings — the schema MUST coerce so route
    // handlers don't need to pre-parse. Pre-zod this slipped through and
    // produced NaN-shaped windows in the aggregator.
    const result = OvernightSummaryQuerySchema.safeParse({ windowHours: "24" });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.windowHours, 24);
  });
});

describe("OvernightSummaryQuerySchema — rejection cases", () => {
  test("rejects windowHours <= 0", () => {
    const result = OvernightSummaryQuerySchema.safeParse({ windowHours: 0 });
    assert.equal(result.success, false);
  });

  test("rejects windowHours > 168 (one week)", () => {
    const result = OvernightSummaryQuerySchema.safeParse({ windowHours: 200 });
    assert.equal(result.success, false);
  });

  test("rejects non-numeric windowHours", () => {
    const result = OvernightSummaryQuerySchema.safeParse({ windowHours: "abc" });
    assert.equal(result.success, false);
  });

  test("rejects non-integer windowHours", () => {
    const result = OvernightSummaryQuerySchema.safeParse({ windowHours: 12.5 });
    assert.equal(result.success, false);
  });

  test("rejects unknown query keys (strict mode)", () => {
    const result = OvernightSummaryQuerySchema.safeParse({
      windowHours: 12,
      window: 12, // typo
    });
    assert.equal(result.success, false);
  });

  test("error.issues[] is the stable schema-validation-failed envelope", () => {
    const result = OvernightSummaryQuerySchema.safeParse({ windowHours: -1 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(Array.isArray(result.error.issues));
      for (const issue of result.error.issues) {
        assert.ok(Array.isArray(issue.path));
        assert.equal(typeof issue.message, "string");
      }
    }
  });
});

describe("OvernightSummaryResponseSchema — aggregator shape pin", () => {
  test("accepts a valid response shape", () => {
    const result = OvernightSummaryResponseSchema.safeParse({
      mergeCount: 3,
      runCount: 5,
      costSpent: 12.34,
      issuesOpened: 2,
      headroom: "green",
      windowHours: 12,
      generatedAt: "2026-05-26T12:00:00.000Z",
    });
    assert.equal(result.success, true);
  });

  test("rejects negative counters", () => {
    const result = OvernightSummaryResponseSchema.safeParse({
      mergeCount: -1,
      runCount: 0,
      costSpent: 0,
      issuesOpened: 0,
      headroom: "green",
      windowHours: 12,
      generatedAt: "2026-05-26T12:00:00.000Z",
    });
    assert.equal(result.success, false);
  });

  test("rejects an unknown headroom level", () => {
    const result = OvernightSummaryResponseSchema.safeParse({
      mergeCount: 0,
      runCount: 0,
      costSpent: 0,
      issuesOpened: 0,
      headroom: "purple",
      windowHours: 12,
      generatedAt: "2026-05-26T12:00:00.000Z",
    });
    assert.equal(result.success, false);
  });
});

// ---------------------------------------------------------------------------
// Route handler — wire the router with a stubbed aggregator and call the
// handler directly. Follows the mock-req/mock-res pattern from
// test/api-anchor-candidates.test.mts so we don't need a live Express server.
// ---------------------------------------------------------------------------

function mockReq(query: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/today/summary", headers: {}, query, params: {}, body: {} };
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

describe("GET /today/summary — route handler", () => {
  test("happy path: aggregator stub plumbs through unchanged", async () => {
    const stubSummary = {
      mergeCount: 4,
      runCount: 6,
      costSpent: 9.99,
      issuesOpened: 1,
      headroom: "yellow" as const,
      windowHours: 12,
      generatedAt: "2026-05-26T12:00:00.000Z",
    };
    let observedWindow: number | undefined;
    const router = createTodayPageRouter({
      getOvernightSummary: async (windowHours) => {
        observedWindow = windowHours;
        return stubSummary;
      },
    });
    const handler = findHandler(router, "GET", "/today/summary");
    assert.ok(handler);

    const req = mockReq({ windowHours: "12" });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal(observedWindow, 12);
    assert.deepEqual(res._body, stubSummary);
  });

  test("default windowHours applies when query param omitted", async () => {
    let observedWindow: number | undefined;
    const router = createTodayPageRouter({
      getOvernightSummary: async (windowHours) => {
        observedWindow = windowHours;
        return {
          mergeCount: 0,
          runCount: 0,
          costSpent: 0,
          issuesOpened: 0,
          headroom: "unknown" as const,
          windowHours,
          generatedAt: "2026-05-26T12:00:00.000Z",
        };
      },
    });
    const handler = findHandler(router, "GET", "/today/summary");

    const req = mockReq({});
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal(observedWindow, 12);
  });

  test("bad windowHours returns 400 with schema-validation-failed envelope", async () => {
    const router = createTodayPageRouter({
      getOvernightSummary: async () => {
        throw new Error("aggregator should not be called on bad input");
      },
    });
    const handler = findHandler(router, "GET", "/today/summary");

    const req = mockReq({ windowHours: "abc" });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues));
    assert.ok(res._body.issues.length > 0);
  });

  test("aggregator throwing surfaces as 500 (defensive — aggregator contract is never-throw)", async () => {
    const router = createTodayPageRouter({
      getOvernightSummary: async () => {
        throw new Error("simulated failure");
      },
    });
    const handler = findHandler(router, "GET", "/today/summary");

    const req = mockReq({ windowHours: "12" });
    const res = mockRes();
    await handler(req, res);

    // Bad input is 400, server-side trouble is 500 — the dashboard can
    // distinguish "fix your query" from "service degraded".
    assert.equal(res._status, 500);
    assert.equal(typeof res._body.error, "string");
  });
});
