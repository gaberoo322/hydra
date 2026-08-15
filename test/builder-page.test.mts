/**
 * test/builder-page.test.mts — the /builder page's server-side seams
 * (issue #4011, dashboard v3 cockpit slice zeta, ADR-0034 §2).
 *
 * The weekly page's only new server surface is the ranked most-tangled-module
 * view: /architecture re-rendered as a ranked list instead of the 363-node /
 * 1004-edge graph. Two layers are pinned here:
 *
 *   1. `rankTangledModules` — the pure ranking helper (fan-in + fan-out,
 *      dependency-cycle membership via SCC detection). Pure over the already-
 *      fetched graph: no filesystem, no Express, no I/O — the same inputs
 *      always produce the same ranked list.
 *   2. The /architecture HTTP boundary — the response is ADDITIVE: the legacy
 *      nodes/edges/groups/moduleCount/edgeCount/scannedAt/status fields keep
 *      their shape and semantics (the still-live Explore › Architecture tab
 *      consumes them unmodified), while the new `tangledModules` ranking and
 *      the `generatedAt` alias (the ADR-0034 §5 trust signal — the aggregator
 *      names its timestamp `scannedAt`, the trust seam reads `generatedAt`)
 *      ride alongside.
 *
 * Why server-side only: Builder.jsx / TangledModules.jsx / QualityGates.jsx
 * are React the orchestrator node:test suite cannot import (no JSX runner, no
 * react resolution in the worktree). The client half keys mechanically off
 * the fields pinned here — `generatedAt` (parseable ISO) is what
 * `usePageItems`' derivePageStatus needs to classify the panel
 * unknown/stale/empty/ready, and `tangledModules` is the itemsKey it reads.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createArchitectureRouter,
  rankTangledModules,
  type TangledModule,
} from "../src/api/architecture.ts";
import type {
  ArchitectureGraph,
  ArchitectureNode,
} from "../src/aggregators/architecture-graph.ts";

/** The aggregator's unexported edge shape, declared structurally for fixtures. */
interface EdgeLike {
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function node(id: string, group = "root"): ArchitectureNode {
  return { id, label: id, group, inDegree: 0, outDegree: 0, x: 0, y: 0 };
}

/**
 * Synthetic graph exercising every ranking input:
 *
 *   - a 3-cycle a→b→c→a (the "largest dependency cycle"),
 *   - a 2-cycle f↔g (smaller cycle — must rank below the 3-cycle),
 *   - acyclic d→a and d→e (fan without cycle membership),
 *   - e is a pure leaf (fan-in 1, no cycle).
 */
function tangledGraph(): ArchitectureGraph {
  const nodes = [
    node("a"), node("b"), node("c"), node("d"), node("e"),
    node("f", "api"), node("g", "api"),
  ];
  const edges: EdgeLike[] = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
    { from: "d", to: "a" },
    { from: "d", to: "e" },
    { from: "f", to: "g" },
    { from: "g", to: "f" },
  ];
  return {
    nodes,
    edges,
    groups: [],
    moduleCount: nodes.length,
    edgeCount: edges.length,
    scannedAt: "2026-08-14T00:00:00.000Z",
  };
}

function byId(ranked: TangledModule[]): Map<string, TangledModule> {
  return new Map(ranked.map((m) => [m.id, m]));
}

// ---------------------------------------------------------------------------
// rankTangledModules — the pure ranking helper
// ---------------------------------------------------------------------------

describe("rankTangledModules — pure ranking (issue #4011)", () => {
  test("computes fan-in and fan-out from the edge list", () => {
    const ranked = byId(rankTangledModules(tangledGraph()));
    // a is imported by c (cycle) and d → fan-in 2; imports b → fan-out 1.
    assert.equal(ranked.get("a")?.fanIn, 2);
    assert.equal(ranked.get("a")?.fanOut, 1);
    assert.equal(ranked.get("a")?.fanTotal, 3);
    // d imports two modules, is imported by none.
    assert.equal(ranked.get("d")?.fanIn, 0);
    assert.equal(ranked.get("d")?.fanOut, 2);
    // e is a leaf.
    assert.equal(ranked.get("e")?.fanIn, 1);
    assert.equal(ranked.get("e")?.fanOut, 0);
  });

  test("marks dependency-cycle membership with the cycle size; 0 for acyclic modules", () => {
    const ranked = byId(rankTangledModules(tangledGraph()));
    assert.equal(ranked.get("a")?.cycleSize, 3, "a is in the a→b→c cycle");
    assert.equal(ranked.get("b")?.cycleSize, 3);
    assert.equal(ranked.get("c")?.cycleSize, 3);
    assert.equal(ranked.get("f")?.cycleSize, 2, "f is in the f↔g cycle");
    assert.equal(ranked.get("g")?.cycleSize, 2);
    assert.equal(ranked.get("d")?.cycleSize, 0, "d is acyclic");
    assert.equal(ranked.get("e")?.cycleSize, 0, "e is acyclic");
  });

  test("every ranked module carries the inputs that produced its rank (derived-value rule)", () => {
    // ADR-0034 §5.3: a derived rank must decompose into its inputs. Each entry
    // shows the module id + label + group plus the three ranking inputs.
    for (const m of rankTangledModules(tangledGraph())) {
      assert.ok(typeof m.id === "string" && m.id.length > 0);
      assert.ok(typeof m.label === "string");
      assert.ok(typeof m.group === "string");
      assert.equal(m.fanTotal, m.fanIn + m.fanOut, `fanTotal decomposes for ${m.id}`);
    }
    assert.equal(byId(rankTangledModules(tangledGraph())).get("f")?.group, "api");
  });

  test("ranks cycle members first by cycle size, then by fan-in + fan-out, id as tiebreak", () => {
    const ids = rankTangledModules(tangledGraph()).map((m) => m.id);
    // The 3-cycle outranks the 2-cycle; inside the 3-cycle a (fanTotal 3)
    // outranks b and c (fanTotal 2 each, tie → id asc); the acyclic tail sorts
    // by fanTotal (d: 2, e: 1).
    assert.deepEqual(ids, ["a", "b", "c", "f", "g", "d", "e"]);
  });

  test("a larger cycle outranks a smaller one even at lower fan-in + fan-out", () => {
    // 3-cycle members have fanTotal 2 each; f↔g has fanTotal 2 each too, so
    // the ordering above already exercises size-first. Make it unambiguous:
    // give the acyclic d a huge fanTotal — it still ranks below every cycle.
    const g = tangledGraph();
    for (let i = 0; i < 10; i++) {
      g.nodes.push(node(`leaf${i}`));
      g.edges.push({ from: "d", to: `leaf${i}` });
    }
    const ids = rankTangledModules(g).map((m) => m.id);
    // d now has fanTotal 12 — higher than any cycle member — yet every cycle
    // member (cycleSize ≥ 2) ranks above it.
    const firstAcyclic = ids.indexOf("d");
    for (const cyclic of ["a", "b", "c", "f", "g"]) {
      assert.ok(ids.indexOf(cyclic) < firstAcyclic, `${cyclic} ranks above acyclic d`);
    }
  });

  test("caps the ranked list at the requested limit (default 25)", () => {
    const g: ArchitectureGraph = {
      nodes: Array.from({ length: 40 }, (_, i) => node(`m${String(i).padStart(2, "0")}`)),
      edges: [],
      groups: [],
      moduleCount: 40,
      edgeCount: 0,
      scannedAt: "2026-08-14T00:00:00.000Z",
    };
    assert.equal(rankTangledModules(g).length, 25, "default limit is 25");
    assert.equal(rankTangledModules(g, 5).length, 5, "explicit limit honoured");
  });

  test("is deterministic — the same graph yields the identical ranking", () => {
    const g = tangledGraph();
    assert.deepEqual(rankTangledModules(g), rankTangledModules(g));
  });

  test("an edgeless graph yields every module, ranked by id, with zeroed inputs", () => {
    const g: ArchitectureGraph = {
      nodes: [node("b"), node("a")],
      edges: [],
      groups: [],
      moduleCount: 2,
      edgeCount: 0,
      scannedAt: "2026-08-14T00:00:00.000Z",
    };
    const ranked = rankTangledModules(g);
    assert.deepEqual(ranked.map((m) => m.id), ["a", "b"]);
    assert.equal(ranked[0].cycleSize, 0);
    assert.equal(ranked[0].fanTotal, 0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/architecture — additive HTTP boundary
// ---------------------------------------------------------------------------

// The same mock-Express harness pattern as test/api-architecture.test.mts.

function mockReq(): any {
  return { method: "GET", url: "/architecture", headers: {}, query: {}, params: {}, body: {} };
}
function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
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

const eventBus: any = { publisher: { ping: async () => { throw new Error("no redis"); } } };

describe("GET /api/architecture — additive tangledModules + generatedAt (issue #4011)", () => {
  async function getBody(): Promise<any> {
    const router = createArchitectureRouter(eventBus, {
      scan: async () => tangledGraph(),
      now: () => 0,
    });
    const handler = findHandler(router, "GET", "/architecture")!;
    assert.ok(handler);
    const res = mockRes();
    await handler(mockReq(), res);
    assert.equal(res._status, 200);
    return res._body;
  }

  test("legacy fields keep their shape and semantics — Explore › Architecture stays working", async () => {
    const body = await getBody();
    // The exact field set ArchitectureTab.jsx (and any other live consumer)
    // reads today. INV-1 of the #4011 design concept: additive only.
    assert.ok(Array.isArray(body.nodes) && body.nodes.length === 7);
    assert.ok(Array.isArray(body.edges) && body.edges.length === 7);
    assert.ok(Array.isArray(body.groups));
    assert.equal(body.moduleCount, 7);
    assert.equal(body.edgeCount, 7);
    assert.equal(body.scannedAt, "2026-08-14T00:00:00.000Z");
    assert.equal(typeof body.status?.cycle, "string");
    assert.equal(body.status?.redis, false, "best-effort overlay unchanged");
  });

  test("adds generatedAt as an alias of scannedAt — the ADR-0034 §5 trust signal", async () => {
    const body = await getBody();
    assert.equal(body.generatedAt, body.scannedAt);
    // The trust seam (usePageItems.derivePageStatus) Date.parses this field;
    // an unparseable timestamp would pin the panel to `unknown` forever.
    assert.ok(Number.isFinite(Date.parse(body.generatedAt)), "generatedAt must be ISO-parseable");
  });

  test("adds the ranked tangledModules list — same ranking as the pure helper", async () => {
    const body = await getBody();
    const expected = rankTangledModules(tangledGraph());
    assert.deepEqual(body.tangledModules, expected);
    assert.equal(body.tangledModules[0].id, "a", "3-cycle member with the highest fanTotal ranks first");
  });
});
