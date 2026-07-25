/**
 * Regression tests for the Outcomes-page API router (`src/api/outcomes-page.ts`,
 * issue #3652).
 *
 * Three thin 7-day-trend routes (issue #619, PRD #615 slice 4), each a
 * `WindowedDaysQuerySchema`-validated adapter over a pure aggregator, wrapped in
 * the never-throw-500 isolation from `route-helpers.ts`. The aggregators have
 * their own tests (`test/aggregator-outcome-trends.test.mts`, …); this suite
 * pins the ROUTER contract — route registration, right-aggregator/right-param
 * delegation, the `?window=Nd`→N transform, 400 on a bad window, and never-throw
 * 500.
 *
 * Hermetic: every aggregator is stubbed via the `deps` factory, so no Redis /
 * subprocess / network, and the suite owns a trivial lifecycle (its own
 * top-level `describe`s, no shared-Redis teardown to nest under). Handlers are
 * invoked through `req`/`res` mocks (the `test/outcomes.test.mts` pattern).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createOutcomesPageRouter } from "../src/api/outcomes-page.ts";

// ---------------------------------------------------------------------------
// Express handler harness (mirrors test/outcomes.test.mts)
// ---------------------------------------------------------------------------

function routeTable(router: any): string[] {
  const entries: string[] = [];
  for (const layer of router.stack ?? []) {
    const route = layer.route;
    if (!route) continue;
    for (const method of Object.keys(route.methods ?? {})) {
      entries.push(`${method.toUpperCase()} ${route.path}`);
    }
  }
  return entries;
}

function findHandler(
  router: any,
  method: string,
  path: string,
): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      const methods = layer.route.methods;
      if (methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

function mockReq(query: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/", headers: {}, query, params: {}, body: {} };
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

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

describe("outcomes-page router — route registration (issue #3652)", () => {
  test("registers exactly the three outcomes GET routes", () => {
    const routes = routeTable(createOutcomesPageRouter()).sort();
    assert.deepEqual(routes, [
      "GET /outcomes/lessons",
      "GET /outcomes/quota",
      "GET /outcomes/trends",
    ]);
  });

  test("does NOT register the decommissioned /outcomes/calibration route (issue #2876)", () => {
    const routes = routeTable(createOutcomesPageRouter());
    assert.ok(
      !routes.some((r) => r.includes("/outcomes/calibration")),
      `calibration route was removed in #2876; got ${JSON.stringify(routes)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Delegation + the window transform
// ---------------------------------------------------------------------------

describe("outcomes-page router — aggregator delegation (issue #3652)", () => {
  test("GET /outcomes/trends passes the transformed window-day count", async () => {
    let windowDays: number | undefined;
    const router = createOutcomesPageRouter({
      getOutcomeTrends: async (days) => {
        windowDays = days;
        return { marker: "trends" } as any;
      },
    });
    const res = mockRes();
    await findHandler(router, "GET", "/outcomes/trends")!(
      mockReq({ window: "14d" }),
      res,
    );
    assert.equal(windowDays, 14, "'14d' → 14 via schema transform");
    assert.deepEqual(res._body, { marker: "trends" });
  });

  test("GET /outcomes/trends defaults the window to 7 days", async () => {
    let windowDays: number | undefined;
    const router = createOutcomesPageRouter({
      getOutcomeTrends: async (days) => {
        windowDays = days;
        return {} as any;
      },
    });
    await findHandler(router, "GET", "/outcomes/trends")!(mockReq(), mockRes());
    assert.equal(windowDays, 7, "absent window defaults to 7d → 7");
  });

  test("GET /outcomes/lessons delegates to getLessonsTrend with the window", async () => {
    let windowDays: number | undefined;
    const router = createOutcomesPageRouter({
      getLessonsTrend: async (days) => {
        windowDays = days;
        return { marker: "lessons" } as any;
      },
    });
    const res = mockRes();
    await findHandler(router, "GET", "/outcomes/lessons")!(
      mockReq({ window: "7d" }),
      res,
    );
    assert.equal(windowDays, 7);
    assert.deepEqual(res._body, { marker: "lessons" });
  });

  test("GET /outcomes/quota delegates to getQuotaTrend with the window", async () => {
    let windowDays: number | undefined;
    const router = createOutcomesPageRouter({
      getQuotaTrend: async (days) => {
        windowDays = days;
        return { marker: "quota" } as any;
      },
    });
    const res = mockRes();
    await findHandler(router, "GET", "/outcomes/quota")!(
      mockReq({ window: "30d" }),
      res,
    );
    assert.equal(windowDays, 30);
    assert.deepEqual(res._body, { marker: "quota" });
  });

  test("each route calls only its OWN aggregator, not a sibling's", async () => {
    const calls: string[] = [];
    const router = createOutcomesPageRouter({
      getOutcomeTrends: async () => {
        calls.push("trends");
        return {} as any;
      },
      getLessonsTrend: async () => {
        calls.push("lessons");
        return {} as any;
      },
      getQuotaTrend: async () => {
        calls.push("quota");
        return {} as any;
      },
    });
    await findHandler(router, "GET", "/outcomes/lessons")!(
      mockReq(),
      mockRes(),
    );
    assert.deepEqual(calls, ["lessons"], "only the lessons aggregator ran");
  });
});

// ---------------------------------------------------------------------------
// Schema validation — 400 on bad window
// ---------------------------------------------------------------------------

describe("outcomes-page router — schema validation (issue #3652)", () => {
  test("returns 400 schema-validation-failed on a malformed window", async () => {
    let called = false;
    const router = createOutcomesPageRouter({
      getOutcomeTrends: async () => {
        called = true;
        return {} as any;
      },
    });
    const res = mockRes();
    await findHandler(router, "GET", "/outcomes/trends")!(
      mockReq({ window: "1week" }),
      res,
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.equal(called, false, "aggregator must not run on a bad query");
  });

  test("returns 400 on an out-of-range window (> 30 days)", async () => {
    let called = false;
    const router = createOutcomesPageRouter({
      getQuotaTrend: async () => {
        called = true;
        return {} as any;
      },
    });
    const res = mockRes();
    await findHandler(router, "GET", "/outcomes/quota")!(
      mockReq({ window: "90d" }),
      res,
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// Never-throw-500 isolation
// ---------------------------------------------------------------------------

describe("outcomes-page router — never-throw-500 (issue #3652)", () => {
  test("a throwing aggregator becomes a logged 500, not an unhandled throw", async () => {
    const router = createOutcomesPageRouter({
      getLessonsTrend: async () => {
        throw new Error("kaboom");
      },
    });
    const res = mockRes();
    await findHandler(router, "GET", "/outcomes/lessons")!(mockReq(), res);
    assert.equal(res._status, 500);
    assert.equal(res._body.error, "kaboom");
  });
});
