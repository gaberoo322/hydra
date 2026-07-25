/**
 * Regression tests for the metrics-cost API router (`src/api/metrics-cost.ts`,
 * issue #3652).
 *
 * This is the cost-accounting READ seam split out of `src/api/metrics.ts`
 * (architecture-scan #3495): five GET routes, each a thin wrapper that parses
 * its query, delegates to a Cost-module / metrics pure function, and JSONs the
 * result under the never-throw-500 isolation. The backing logic
 * (`src/cost/index.ts`, `src/metrics/trend.ts`, `src/metrics/aggregate.ts`) is
 * tested separately (`test/metrics-aggregators.test.mts`, the cost suites) — but
 * the ROUTER'S route table (that all five cost paths are registered and none was
 * dropped in the split) had no dedicated coverage.
 *
 * Unlike the explore/outcomes routers, `createMetricsCostRouter()` takes no
 * `deps` factory — its handlers reach straight into Redis-backed Cost readers,
 * so invoking them would require a live Redis. This suite therefore inspects the
 * router's Express route stack directly (no HTTP, no handler invocation), which
 * keeps it hermetic and gives it a trivial standalone lifecycle — no shared
 * Redis connection, nothing to nest under another suite's teardown. The five
 * route PATHS are the router's stable public contract; that they resolve
 * byte-identically after the metrics.ts split is exactly what the extraction
 * comment promises.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMetricsCostRouter } from "../src/api/metrics-cost.ts";

/**
 * Collect `${method} ${path}` entries from an Express router's internal stack.
 */
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

describe("metrics-cost router — route registration (issue #3652)", () => {
  test("registers exactly the five cost-accounting GET routes", () => {
    const routes = routeTable(createMetricsCostRouter()).sort();
    assert.deepEqual(routes, [
      "GET /metrics/cost",
      "GET /metrics/cost-by-class",
      "GET /metrics/cost-by-outcome",
      "GET /metrics/cost-efficiency",
      "GET /metrics/cost-per-merged-pr",
    ]);
  });

  test("every registered route is a GET (this is a pure READ seam)", () => {
    for (const layer of createMetricsCostRouter().stack ?? []) {
      const route = layer.route;
      if (!route) continue;
      const methods = Object.keys(
        (route as { methods?: Record<string, boolean> }).methods ?? {},
      );
      assert.deepEqual(
        methods,
        ["get"],
        `route ${route.path} should be GET-only; got ${JSON.stringify(methods)}`,
      );
    }
  });

  test("registers no other routes — nothing bled in from the metrics.ts split (#3495)", () => {
    const routes = routeTable(createMetricsCostRouter());
    assert.equal(
      routes.length,
      5,
      `expected exactly 5 cost routes; got ${JSON.stringify(routes)}`,
    );
    // In particular the cycle-performance reads (/metrics itself, abandonment,
    // grounding-duration) stay on createMetricsRouter, not here.
    assert.ok(
      !routes.some((r) => r === "GET /metrics"),
      "the base /metrics cycle-performance read must stay on the metrics router",
    );
  });
});
