/**
 * Regression tests for the merge-lock API router (`src/api/merge-lock.ts`,
 * issue #3652).
 *
 * Two POST control routes (extracted from `api/misc.ts`, issue #268) over the
 * short-lived Redis merge lock (60s TTL) that serializes merges across cycles:
 *
 *   POST /merge/lock    — acquire (409 `{ locked, holder }` if already held)
 *   POST /merge/unlock  — release
 *
 * The lock's Redis semantics live in `src/redis/cycle-tracking.ts` and are
 * tested there; this suite pins the ROUTER'S route table — that both control
 * routes are registered as POSTs and neither was dropped nor duplicated when the
 * routes were re-homed out of the `api/misc.ts` catch-all.
 *
 * The handlers reach straight into the Redis-backed `acquireMergeLock` /
 * `releaseMergeLock` accessors and the router exposes no `deps` factory, so
 * invoking them would require a live Redis connection (and would leave a
 * shared-Redis teardown for sibling suites to trip over). This suite therefore
 * inspects the Express route stack directly — hermetic, no Redis, its own
 * trivial standalone lifecycle.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMergeLockRouter } from "../src/api/merge-lock.ts";

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

describe("merge-lock router — route registration (issue #3652)", () => {
  test("registers exactly the lock + unlock POST routes", () => {
    const routes = routeTable(createMergeLockRouter()).sort();
    assert.deepEqual(routes, ["POST /merge/lock", "POST /merge/unlock"]);
  });

  test("both routes are POST control endpoints (not GET reads)", () => {
    for (const layer of createMergeLockRouter().stack ?? []) {
      const route = layer.route;
      if (!route) continue;
      const methods = Object.keys(route.methods ?? {});
      assert.deepEqual(
        methods,
        ["post"],
        `route ${route.path} should be POST-only; got ${JSON.stringify(methods)}`,
      );
    }
  });

  test("registers no other routes — nothing else came over from api/misc.ts (#268)", () => {
    const routes = routeTable(createMergeLockRouter());
    assert.equal(
      routes.length,
      2,
      `expected exactly 2 merge-lock routes; got ${JSON.stringify(routes)}`,
    );
  });
});
