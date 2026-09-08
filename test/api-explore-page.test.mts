/**
 * Regression tests for the Explore-page API router (`src/api/explore-page.ts`,
 * issue #3652).
 *
 * The router is a thin aggregator seam (issue #620, PRD #615): each of its
 * three (originally five — `anomalies`/`flow` removed as dead code, issue
 * #4356) GET routes parses `req.query` through a zod schema, delegates to a pure
 * aggregator, and wraps the result in the never-throw-500 isolation from
 * `route-helpers.ts`. Its backing aggregators are tested separately (see
 * `test/aggregator-friction-patterns.test.mts` et al.), but the ROUTER'S call
 * contract — that each route is registered, invokes the RIGHT aggregator with
 * the RIGHT parameters, returns a 400 `schema-validation-failed` on a bad query,
 * and never throws a 500 out of a misbehaving aggregator — had no coverage.
 *
 * This suite exercises the router hermetically: every aggregator is stubbed via
 * the `deps` factory parameter, so the tests never touch Redis, subprocesses, or
 * the network and own a trivial lifecycle (no shared-Redis teardown to nest
 * under). Handlers are invoked directly through `req`/`res` mocks — the same
 * pattern as `test/outcomes.test.mts`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createExplorePageRouter } from "../src/api/explore-page.ts";

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

describe("explore-page router — route registration (issue #3652)", () => {
  test("registers exactly the three explore GET routes", () => {
    const routes = routeTable(createExplorePageRouter()).sort();
    assert.deepEqual(routes, [
      "GET /explore/behavior",
      "GET /explore/friction",
      "GET /explore/lessons",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Backing-function delegation + parameter passing
// ---------------------------------------------------------------------------

describe("explore-page router — aggregator delegation (issue #3652)", () => {
  test("GET /explore/friction delegates to getFrictionPatterns", async () => {
    let called = false;
    const router = createExplorePageRouter({
      getFrictionPatterns: async () => {
        called = true;
        return { marker: "friction" } as any;
      },
    });
    const res = mockRes();
    await findHandler(router, "GET", "/explore/friction")!(mockReq(), res);
    assert.equal(called, true, "friction aggregator should be invoked");
    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { marker: "friction" });
  });

  test("GET /explore/behavior passes the parsed limit + filters through", async () => {
    let seen: { limit?: number; filters?: any } = {};
    const router = createExplorePageRouter({
      getBehaviorGallery: async (limit, filters) => {
        seen = { limit, filters };
        return [] as any;
      },
    });
    const res = mockRes();
    await findHandler(router, "GET", "/explore/behavior")!(
      mockReq({ limit: "10", class: "dev_orch", outcome: "success" }),
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(seen.limit, 10, "limit coerced from query string to number");
    assert.deepEqual(seen.filters, { class: "dev_orch", outcome: "success" });
    assert.equal(res._body.filters.class, "dev_orch");
    assert.equal(res._body.filters.outcome, "success");
    assert.equal(res._body.limit, 10);
  });

  test("GET /explore/behavior defaults limit to 50 and omits absent filters", async () => {
    let seen: { limit?: number; filters?: any } = {};
    const router = createExplorePageRouter({
      getBehaviorGallery: async (limit, filters) => {
        seen = { limit, filters };
        return [] as any;
      },
    });
    const res = mockRes();
    await findHandler(router, "GET", "/explore/behavior")!(mockReq(), res);
    assert.equal(seen.limit, 50, "limit defaults to 50");
    assert.deepEqual(seen.filters, {}, "no class/outcome filters when absent");
    assert.equal(res._body.filters.class, null);
    assert.equal(res._body.filters.outcome, null);
  });

  test("GET /explore/lessons forwards the skill filter", async () => {
    let filters: any;
    const router = createExplorePageRouter({
      getLessonsExplorer: async (f) => {
        filters = f;
        return { marker: "lessons" } as any;
      },
    });
    await findHandler(router, "GET", "/explore/lessons")!(
      mockReq({ skill: "hydra-dev" }),
      mockRes(),
    );
    assert.deepEqual(filters, { skill: "hydra-dev" });
  });

  test("GET /explore/lessons passes empty filters when no skill given", async () => {
    let filters: any;
    const router = createExplorePageRouter({
      getLessonsExplorer: async (f) => {
        filters = f;
        return {} as any;
      },
    });
    await findHandler(router, "GET", "/explore/lessons")!(mockReq(), mockRes());
    assert.deepEqual(filters, {});
  });
});

// ---------------------------------------------------------------------------
// Schema validation — 400 on bad query
// ---------------------------------------------------------------------------

describe("explore-page router — schema validation (issue #3652)", () => {
  test("GET /explore/behavior returns 400 schema-validation-failed on a non-numeric limit", async () => {
    let called = false;
    const router = createExplorePageRouter({
      getBehaviorGallery: async () => {
        called = true;
        return [] as any;
      },
    });
    const res = mockRes();
    await findHandler(router, "GET", "/explore/behavior")!(
      mockReq({ limit: "not-a-number" }),
      res,
    );
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues) && res._body.issues.length > 0);
    assert.equal(called, false, "aggregator must not run on a bad query");
  });
});

// ---------------------------------------------------------------------------
// Never-throw-500 isolation
// ---------------------------------------------------------------------------

describe("explore-page router — never-throw-500 (issue #3652)", () => {
  test("a throwing aggregator becomes a logged 500, not an unhandled throw", async () => {
    const router = createExplorePageRouter({
      getFrictionPatterns: async () => {
        throw new Error("boom");
      },
    });
    const res = mockRes();
    // logger.error is invoked inside isolateAggregator; the handler itself
    // must resolve (never re-throw) and set a 500.
    await findHandler(router, "GET", "/explore/friction")!(mockReq(), res);
    assert.equal(res._status, 500);
    assert.equal(res._body.error, "boom");
  });
});
