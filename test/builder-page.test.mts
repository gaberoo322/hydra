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

// ---------------------------------------------------------------------------
// Issue #4637 — the /builder per-class yield view (GET /autopilot/class-stats).
// Structural source pins for the JSX half (no JSX runner, no react in the
// worktree); the route's memo is pinned at its HTTP boundary in
// test/api-class-stats.test.mts. Own top-level describe, no shared lifecycle.
// ---------------------------------------------------------------------------

describe("structural pins — /builder class yield (issue #4637)", () => {
  async function readDashboardSource(rel: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    return readFile(new URL(`../dashboard/src/${rel}`, import.meta.url), "utf8");
  }

  test("Builder.jsx mounts ClassYield", async () => {
    const src = await readDashboardSource("pages/Builder.jsx");
    assert.match(src, /import \{ ClassYield \} from "\.\.\/components\/pages\/builder\/ClassYield\.jsx"/);
    assert.match(src, /<ClassYield \/>/);
  });

  test("ClassYield reads class-stats on a 10-minute poll and derives a 1-day trust status (INV-9)", async () => {
    const src = await readDashboardSource("components/pages/builder/ClassYield.jsx");
    assert.match(src, /useApi\("\/autopilot\/class-stats", \{ poll: 600_?000 \}\)/);
    assert.match(src, /derivePageStatus\(\{/);
    assert.match(src, /itemsLen: classes\.length/);
    assert.match(src, /freshnessMs: DAY_MS/);
    assert.match(src, /const DAY_MS = 24 \* 60 \* 60 \* 1000;/);
    assert.match(src, /generatedAt=\{data\?\.generatedAt\}/, "the as-of is the scoreboard's generatedAt");
  });

  test("every verdict cell decomposes into its inputs (ADR-0034 §5.3)", async () => {
    const src = await readDashboardSource("components/pages/builder/ClassYield.jsx");
    assert.match(src, /verdictInputs\(stat, scoreboard\)/);
    assert.match(src, /scoreboard\.minSample/, "dispatches vs the min-sample floor");
    assert.match(src, /stat\.mergeRate/, "merge rate (dev role)");
    assert.match(src, /betaLabel\(stat\)/, "β (producer role)");
    assert.match(src, /scoreboard\.windowMs/, "the window");
    assert.match(src, /shadow\.verdicts/, "shadow multiplier joined by className");
  });

  test("ClassYield is read-only — no apiFetch, no POST, no controls (/builder anti-scope)", async () => {
    const src = await readDashboardSource("components/pages/builder/ClassYield.jsx");
    assert.equal(src.includes("apiFetch"), false);
    assert.equal(/method:\s*["']POST["']/.test(src), false);
    assert.equal(src.includes("<button"), false);
    assert.equal(src.includes("ActionAffordance"), false);
  });
});

// ===========================================================================
// Issue #4634 (design-concept a7e7fedb) — /builder homes five dark reads.
//
// Two layers, same rationale as the file header (no JSX runner):
//   1. INV-3 — the four routes that lacked an as-of gain an ADDITIVE
//      top-level `generatedAt` (pinned at the HTTP boundary, pre-existing
//      fields still present).
//   2. INV-2/4/5 — route-to-file literal ownership, the shared trust seam,
//      read-only panels and the derived-value decomposition (source pins).
// ===========================================================================

import { before as before4634, after as after4634 } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOutcomesRouter } from "../src/api/outcomes.ts";
import { createAttributionRouter } from "../src/api/attribution.ts";
import { createMetricsRouter } from "../src/api/metrics.ts";
import { createDesignConceptsRouter } from "../src/api/design-concepts.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";

const REPO_ROOT_4634 = fileURLToPath(new URL("..", import.meta.url));

function readRepo(rel: string): string {
  return readFileSync(join(REPO_ROOT_4634, rel), "utf8");
}

/** Every dashboard/src file (repo-relative), recursively. */
function dashboardFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(REPO_ROOT_4634, rel))) {
      if (name === "node_modules") continue;
      const child = `${rel}/${name}`;
      if (statSync(join(REPO_ROOT_4634, child)).isDirectory()) walk(child);
      else if (/\.(jsx?|tsx?)$/.test(name)) out.push(child);
    }
  };
  walk("dashboard/src");
  return out;
}

/**
 * Files holding an API call site (useApi / usePageItems / apiFetch / fetch /
 * a write hook) whose FIRST argument is exactly `literal` (quotes included in
 * the match, so "/outcomes" never false-matches a longer path or App.jsx's
 * client-side `path="/outcomes"` redirect).
 */
function callSiteOwners(literal: string): string[] {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b(?:useApi|usePageItems|apiFetch|fetch|write\\w*)\\(\\s*${escaped}`);
  return dashboardFiles().filter((f) => re.test(readRepo(f)));
}

async function invoke(router: any, path: string, query: Record<string, string> = {}): Promise<any> {
  const handler = findHandler(router, "GET", path);
  assert.ok(handler, `GET ${path} handler must exist`);
  const res = mockRes();
  await handler!({ ...mockReq(), url: path, query }, res);
  return res;
}

function assertIsoGeneratedAt(body: any, route: string) {
  assert.equal(typeof body.generatedAt, "string", `${route} must carry a top-level generatedAt`);
  assert.ok(Number.isFinite(Date.parse(body.generatedAt)), `${route} generatedAt must parse as ISO`);
}

describe("#4634 INV-3 — additive generatedAt on GET /outcomes and /attribution/impact", () => {
  let dir: string;
  before4634(async () => {
    dir = await mkdtemp(join(tmpdir(), "hydra-4634-outcomes-"));
  });
  after4634(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("/outcomes keeps its outcomes rows and gains generatedAt", async () => {
    const valFile = join(dir, "fictional-reading.txt");
    await writeFile(valFile, "3\n");
    const outcomesFile = join(dir, "fictional-outcomes.yaml");
    await writeFile(
      outcomesFile,
      `
outcomes:
  - name: fictional-outcome
    kind: leading
    direction: up
    source: file
    query: ${valFile}
    baseline: 0
    target: 5
`,
    );
    const res = await invoke(createOutcomesRouter(outcomesFile), "/outcomes");
    assert.equal(res._status, 200);
    assertIsoGeneratedAt(res._body, "/outcomes");
    assert.equal(res._body.outcomes.length, 1);
    const row = res._body.outcomes[0];
    for (const field of ["name", "kind", "direction", "baseline", "target", "current", "ts", "holdback"]) {
      assert.ok(field in row, `pre-existing row field ${field} survives`);
    }
    assert.equal(row.current, 3);
  });

  test("/attribution/impact keeps rows + metricCount and gains generatedAt", async () => {
    const router = createAttributionRouter(
      async () => ({ ok: true, observations: [] }) as any,
      async () => ({}),
    );
    const res = await invoke(router, "/attribution/impact", { topN: "8" });
    assert.equal(res._status, 200);
    assertIsoGeneratedAt(res._body, "/attribution/impact");
    assert.deepEqual(res._body.rows, []);
    assert.equal(res._body.metricCount, 0);
  });
});

describe("#4634 INV-3 — additive generatedAt on GET /metrics/unclassified and /design-concepts/snapshots", () => {
  after4634(() => {
    closeRedisConnections();
  });

  test("/metrics/unclassified keeps every aggregator field and gains generatedAt", async () => {
    const res = await invoke(createMetricsRouter(), "/metrics/unclassified", { count: "50" });
    assert.equal(res._status, 200);
    assertIsoGeneratedAt(res._body, "/metrics/unclassified");
    for (const field of ["windowCycles", "unclassified", "rate", "fixable", "noAttribution", "fixableRate", "noAttributionShapes"]) {
      assert.ok(field in res._body, `pre-existing field ${field} survives`);
    }
    assert.ok(Array.isArray(res._body.unclassified));
  });

  test("/design-concepts/snapshots keeps the green-light fields and gains generatedAt", async () => {
    const res = await invoke(createDesignConceptsRouter(), "/design-concepts/snapshots");
    assert.equal(res._status, 200);
    assertIsoGeneratedAt(res._body, "/design-concepts/snapshots");
    for (const field of ["snapshots", "greenDaysInWindow", "windowDays", "requiredGreenDays", "greenLightReady", "indexSizeNow"]) {
      assert.ok(field in res._body, `pre-existing field ${field} survives`);
    }
  });
});

describe("#4634 INV-2/4/5 — /builder panel source pins", () => {
  const PANELS: Array<[string, string, string]> = [
    ['"/outcomes"', "dashboard/src/components/pages/builder/DeclaredOutcomes.jsx", "outcomes"],
    ['"/attribution/impact?topN=8"', "dashboard/src/components/pages/builder/ImpactRanking.jsx", "rows"],
    ['"/metrics/unclassified?count=50"', "dashboard/src/components/pages/builder/UnclassifiedResidue.jsx", "unclassified"],
    ['"/design-concepts/snapshots"', "dashboard/src/components/pages/builder/DesignConceptGreenLight.jsx", "snapshots"],
    ['"/attention/counts"', "dashboard/src/components/pages/builder/FeedCalibration.jsx", "lines"],
  ];

  for (const [literal, file] of PANELS) {
    test(`${literal} is fetched from exactly one dashboard file: ${file}`, () => {
      assert.deepEqual(callSiteOwners(literal), [file]);
    });
  }

  test("each panel rides usePageItems with its items key (never a hand-rolled ternary)", () => {
    for (const [literal, file, itemsKey] of PANELS) {
      const src = readRepo(file);
      assert.ok(src.includes("usePageItems"), `${file} must import the usePageItems seam`);
      assert.ok(src.includes(`usePageItems(${literal}`), `${file} must source ${literal} via usePageItems`);
      assert.ok(src.includes(`itemsKey: "${itemsKey}"`), `${file} must read the ${itemsKey} array`);
      assert.ok(!src.includes("useApi("), `${file} must not call useApi directly`);
    }
  });

  test("Builder.jsx only mounts the panels — no route literal, no fetch", () => {
    const src = readRepo("dashboard/src/pages/Builder.jsx");
    for (const [literal] of PANELS) assert.ok(!src.includes(literal), `Builder.jsx must not own ${literal}`);
    assert.ok(!/\b(?:useApi|usePageItems|apiFetch)\(/.test(src), "Builder.jsx must not fetch");
    for (const name of ["DeclaredOutcomes", "ImpactRanking", "UnclassifiedResidue", "DesignConceptGreenLight", "FeedCalibration"]) {
      assert.ok(src.includes(`<${name} />`), `Builder.jsx must mount ${name}`);
    }
  });

  test("the five panels are read-only — no button, no apiFetch (ADR-0034 §2)", () => {
    for (const [, file] of PANELS) {
      const src = readRepo(file);
      assert.ok(!src.includes("<button"), `${file} must carry no button`);
      assert.ok(!src.includes("apiFetch"), `${file} must not write`);
    }
  });

  test("FeedCalibration sorts miscalibrated first and cites `because` verbatim — never the server's constants", () => {
    const src = readRepo("dashboard/src/components/pages/builder/FeedCalibration.jsx");
    assert.match(src, /miscalibrated: 0, calibrated: 1, "insufficient-data": 2/);
    assert.ok(src.includes("{line.because}"), "the verdict's decomposition is the server's because string");
    // The ratio / minimum-episode constants live in src/attention-calibration.ts
    // only: no constant import and no notAProblem ÷ surfaced recomputation.
    assert.ok(!/CALIBRATION_|MISCALIBRATED_|notAProblem\s*\//.test(src), "the client must not recompute verdicts");
  });

  test("ImpactRanking renders impactPerCost beside its inputs and per-metric flags (§5.3)", () => {
    const src = readRepo("dashboard/src/components/pages/builder/ImpactRanking.jsx");
    for (const field of ["row.impactPerCost", "row.favorableImpact", "row.meanTier", "row.contributions", "c.beta", "c.directed", "belowNoiseFloor", "identifiabilitySuspect"]) {
      assert.ok(src.includes(field), `ImpactRanking must render ${field}`);
    }
  });

  test("DesignConceptGreenLight shows greenLightReady only beside its window inputs, reusing Sparkline", () => {
    const src = readRepo("dashboard/src/components/pages/builder/DesignConceptGreenLight.jsx");
    for (const field of ["greenLightReady", "greenDaysInWindow", "requiredGreenDays", "windowDays", "indexSizeNow"]) {
      assert.ok(src.includes(field), `DesignConceptGreenLight must render ${field}`);
    }
    assert.ok(src.includes('from "../outcomes/Sparkline.jsx"'), "the shared Sparkline is reused, not rebuilt");
  });

  test("UnclassifiedResidue labels rate / fixableRate / noAttributionShapes over windowCycles; zero needs cycles", () => {
    const src = readRepo("dashboard/src/components/pages/builder/UnclassifiedResidue.jsx");
    for (const field of ["data?.rate", "data?.fixableRate", "noAttributionShapes", "windowCycles"]) {
      assert.ok(src.includes(field), `UnclassifiedResidue must render ${field}`);
    }
    assert.match(src, /windowCycles === 0/, "an empty window must not assert a zero");
  });

  test("DeclaredOutcomes shows each row's own ts as-of and a missing reading as no reading", () => {
    const src = readRepo("dashboard/src/components/pages/builder/DeclaredOutcomes.jsx");
    assert.ok(src.includes("o.ts"), "each row carries its reading's own as-of");
    assert.ok(src.includes("—, no reading"), "a null current renders as no reading, never a zero");
  });
});
