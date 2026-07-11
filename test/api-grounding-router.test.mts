/**
 * Regression tests for the grounding router (`src/api/grounding.ts`, issue #3190).
 *
 * The `GET /grounding/latest` route was re-homed out of the misnamed
 * `src/api/tasks.ts` router — a module that bundled it with two always-dead
 * `/agents/*` routes and carried the vestigial name of the retired in-process
 * task tracker (issue #792 / ADR-0016). This suite pins two invariants of the
 * consolidation:
 *
 *   1. The live grounding read survives the move — `/grounding/latest` is
 *      registered on the new router.
 *   2. The two dead agent routes did NOT come along — `/agents/status` and
 *      `/agents/:id/pause` are absent from the router's route table.
 *
 * The router's Express route stack is inspected directly (no HTTP, no
 * `groundProject` invocation) so the suite is hermetic: it never spawns the
 * grounding subprocesses and never touches Redis, giving it its own trivial
 * lifecycle per the CLAUDE.md authoring rule.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createGroundingRouter } from "../src/api/grounding.ts";

/**
 * Collect `${method} ${path}` entries from an Express router's internal stack.
 * Express exposes registered routes on `router.stack[].route`.
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

describe("grounding router (issue #3190)", () => {
  test("registers GET /grounding/latest — the re-homed live route", () => {
    const routes = routeTable(createGroundingRouter());
    assert.ok(
      routes.includes("GET /grounding/latest"),
      `expected GET /grounding/latest to be registered; got ${JSON.stringify(routes)}`,
    );
  });

  test("does NOT carry the retired /agents/status route (ADR-0016 dead route)", () => {
    const routes = routeTable(createGroundingRouter());
    assert.ok(
      !routes.some((r) => r.endsWith(" /agents/status")),
      `retired /agents/status must not be re-homed; got ${JSON.stringify(routes)}`,
    );
  });

  test("does NOT carry the retired /agents/:id/pause route (always-404 dead route)", () => {
    const routes = routeTable(createGroundingRouter());
    assert.ok(
      !routes.some((r) => r.includes("/agents/")),
      `retired /agents/:id/pause must not be re-homed; got ${JSON.stringify(routes)}`,
    );
  });

  test("owns exactly the one grounding route — nothing else moved over", () => {
    const routes = routeTable(createGroundingRouter());
    assert.deepEqual(routes, ["GET /grounding/latest"]);
  });
});
