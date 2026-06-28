/**
 * Regression tests for the dispatch-class taxonomy endpoint (issue #2524).
 *
 * Two layers:
 *   1. `deriveTaxonomyClasses` — the pure projection (no I/O): the typed
 *      taxonomy views → the wire shape, carrying optional `notes` only when
 *      present and the derived pipeline/signal/cooldown projections verbatim.
 *   2. The GET /taxonomy/classes route handler — that the views ride the
 *      response, validate against the schema, degrade to an empty
 *      `degraded:true` body when the loader throws (never a 500), and return
 *      400 on a malformed query.
 *
 * Follows the test/autopilot-board.test.mts pattern — wires the router with a
 * stubbed `loadTaxonomy` loader and calls the handler directly. No live Express
 * server, no real filesystem read, no Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createTaxonomyRouter,
  deriveTaxonomyClasses,
  defaultLoadTaxonomy,
  type TaxonomyViews,
  type TaxonomyRouterDeps,
} from "../src/api/taxonomy.ts";
import { TaxonomyClassesResponseSchema } from "../src/schemas/taxonomy.ts";
import type { DispatchClassRow } from "../src/taxonomy/classes.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse("2026-06-28T12:00:00.000Z");

const DEV_ROW: DispatchClassRow = {
  name: "dev_orch",
  kind: "pipeline",
  skill: "hydra-dev",
  costClass: "dev",
  learningAgent: "executor",
  cooldownSeconds: null,
  scope: "orch",
  provenanceLabel: null,
  notes: "the engineer",
};

const SWEEP_ROW: DispatchClassRow = {
  name: "sweep_orch",
  kind: "signal",
  skill: "hydra-sweep",
  costClass: "sweep",
  learningAgent: null,
  cooldownSeconds: 900,
  scope: "orch",
  provenanceLabel: null,
};

const FIXTURE_VIEWS: TaxonomyViews = {
  classes: [DEV_ROW, SWEEP_ROW],
  pipelineSlots: ["dev_orch"],
  signalClasses: ["sweep_orch"],
  signalCooldowns: { sweep_orch: 900 },
};

// ---------------------------------------------------------------------------
// deriveTaxonomyClasses — pure projection
// ---------------------------------------------------------------------------

describe("deriveTaxonomyClasses — projection (issue #2524)", () => {
  test("projects every row + the three derived views verbatim", () => {
    const out = deriveTaxonomyClasses(FIXTURE_VIEWS);
    assert.equal(out.classes.length, 2);
    assert.deepEqual(out.pipelineSlots, ["dev_orch"]);
    assert.deepEqual(out.signalClasses, ["sweep_orch"]);
    assert.deepEqual(out.signalCooldowns, { sweep_orch: 900 });
  });

  test("carries optional notes only when present; nullable columns stay explicit", () => {
    const out = deriveTaxonomyClasses(FIXTURE_VIEWS);
    const dev = out.classes.find((c) => c.name === "dev_orch")!;
    const sweep = out.classes.find((c) => c.name === "sweep_orch")!;
    assert.equal(dev.notes, "the engineer");
    assert.equal("notes" in sweep, false); // absent, not undefined-valued
    assert.equal(dev.cooldownSeconds, null);
    assert.equal(dev.provenanceLabel, null);
    assert.equal(sweep.cooldownSeconds, 900);
    assert.equal(sweep.learningAgent, null);
  });

  test("returns fresh arrays/objects, not the input references", () => {
    const out = deriveTaxonomyClasses(FIXTURE_VIEWS);
    assert.notEqual(out.pipelineSlots, FIXTURE_VIEWS.pipelineSlots);
    assert.notEqual(out.signalCooldowns, FIXTURE_VIEWS.signalCooldowns);
  });
});

// ---------------------------------------------------------------------------
// Route harness (mirrors test/autopilot-board.test.mts)
// ---------------------------------------------------------------------------

function mockReq(query: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/x", headers: {}, query, params: {}, body: {} };
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

const ROUTE = "/taxonomy/classes";

async function callRoute(
  deps: TaxonomyRouterDeps = {},
  query: Record<string, unknown> = {},
) {
  const router = createTaxonomyRouter({ now: () => NOW_MS, ...deps });
  const handler = findHandler(router, "GET", ROUTE);
  assert.ok(handler, "route handler must exist");
  const res = mockRes();
  await handler!(mockReq(query), res);
  return res;
}

// ---------------------------------------------------------------------------
// Route — happy path, degrade, validation, real default loader
// ---------------------------------------------------------------------------

describe("GET /taxonomy/classes — route (issue #2524)", () => {
  test("serves the views from the loader; degraded=false; validates against schema", async () => {
    const res = await callRoute({ loadTaxonomy: () => FIXTURE_VIEWS });
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, false);
    assert.equal(res._body.classes.length, 2);
    assert.deepEqual(res._body.pipelineSlots, ["dev_orch"]);
    assert.deepEqual(res._body.signalClasses, ["sweep_orch"]);
    assert.deepEqual(res._body.signalCooldowns, { sweep_orch: 900 });
    assert.equal(typeof res._body.generatedAt, "string");
    TaxonomyClassesResponseSchema.parse(res._body);
  });

  test("a throwing loader degrades to the empty alphabet, still 200 (never-throw)", async () => {
    const res = await callRoute({
      loadTaxonomy: () => {
        throw new Error("boom");
      },
    });
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, true);
    assert.deepEqual(res._body.classes, []);
    assert.deepEqual(res._body.pipelineSlots, []);
    assert.deepEqual(res._body.signalClasses, []);
    assert.deepEqual(res._body.signalCooldowns, {});
    TaxonomyClassesResponseSchema.parse(res._body);
  });

  test("malformed query (unexpected key) → 400 schema-validation-failed", async () => {
    const res = await callRoute({ loadTaxonomy: () => FIXTURE_VIEWS }, { forse: "1" });
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("default loader serves the real classes.json alphabet, schema-valid", async () => {
    // No loadTaxonomy override → exercises defaultLoadTaxonomy over the live
    // typed views (which read scripts/autopilot/classes.json at import time).
    const res = await callRoute();
    assert.equal(res._status, 200);
    assert.equal(res._body.degraded, false);
    assert.ok(res._body.classes.length > 0, "real taxonomy has rows");
    assert.ok(res._body.pipelineSlots.length > 0, "real taxonomy has pipeline slots");
    assert.ok(res._body.signalClasses.length > 0, "real taxonomy has signal classes");
    // Every signal class must have a cooldown entry (decide.py invariant).
    for (const cls of res._body.signalClasses) {
      assert.equal(
        typeof res._body.signalCooldowns[cls],
        "number",
        `signal class ${cls} must carry a cooldown`,
      );
    }
    TaxonomyClassesResponseSchema.parse(res._body);
  });

  test("defaultLoadTaxonomy exposes the four live views directly", () => {
    const views = defaultLoadTaxonomy();
    assert.ok(Array.isArray(views.classes) && views.classes.length > 0);
    assert.ok(views.pipelineSlots.length > 0);
    assert.ok(views.signalClasses.length > 0);
    assert.equal(typeof views.signalCooldowns, "object");
  });
});
