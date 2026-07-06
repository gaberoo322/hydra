/**
 * Regression tests for the repo-graph coupling adapter (issue #2939).
 *
 * The adapter wraps `scanArchitecture()` READ-ONLY and formats a deterministic
 * markdown coupling-summary block. These tests drive `getCouplingReport()`
 * through the same `ArchitectureGraphDeps` filesystem-injection points the
 * aggregator exposes — a synthetic recursive listing + file bodies — so the
 * whole path runs with no real I/O and is fully deterministic.
 *
 * Contract under test:
 *   - report lists ≥10 modules ranked by fan-in (inDegree) descending;
 *   - report lists the top-5 cross-group edge pairs (intra-group edges
 *     excluded), ranked by count descending;
 *   - rankings have a stable tiebreak (ties never reorder between runs);
 *   - the pure derivations (rankModulesByFanIn / crossGroupPairs) and the
 *     pure formatter (renderCouplingReport) are each testable in isolation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type {
  ArchitectureGraph,
  ArchitectureNode,
} from "../src/aggregators/architecture-graph.ts";
import {
  getCouplingReport,
  renderCouplingReport,
  rankModulesByFanIn,
  crossGroupPairs,
} from "../src/knowledge-base/repo-graph.ts";

const SRC = "/synthetic/src";

/**
 * Build injectable readdir/readFile stubs over a `relative-path -> body` map,
 * matching the aggregator's FS-injection contract (the readFile stub keys on
 * the srcDir-relative remainder of the resolved path).
 */
function fsStub(files: Record<string, string>) {
  return {
    srcDir: SRC,
    now: new Date("2026-07-06T00:00:00.000Z"),
    readdir: async (_dir: string) => Object.keys(files),
    readFile: async (path: string) => {
      const rel = path.startsWith(`${SRC}/`) ? path.slice(SRC.length + 1) : path;
      const body = files[rel];
      if (body === undefined) throw new Error(`no stub for ${path}`);
      return body;
    },
  };
}

/**
 * Synthetic tree with one clear fan-in hub per group and cross-group edges,
 * designed so ≥10 modules exist and the cross-group counts are unambiguous.
 * `redis/keys` is the top hub (imported by many); `api/*` modules all import
 * across into `redis/*` and `schemas/*` to create cross-group tension.
 */
function syntheticTree(): Record<string, string> {
  const files: Record<string, string> = {
    // redis group — keys is the shared hub every adapter imports.
    "redis/keys.ts": `export const K = 1;`,
    "redis/anchors.ts": `import { K } from "./keys.ts"; export const a = K;`,
    "redis/cycles.ts": `import { K } from "./keys.ts"; export const c = K;`,
    "redis/metrics.ts": `import { K } from "./keys.ts"; export const m = K;`,
    // schemas group.
    "schemas/anchor.ts": `export const s = 1;`,
    "schemas/queue.ts": `export const q = 1;`,
  };
  // Eight api modules, each importing across two groups (redis + schemas) so
  // api→redis and api→schemas dominate cross-group coupling, plus one root
  // module they all import.
  files["event-bus.ts"] = `export const bus = 1;`;
  for (let i = 0; i < 8; i++) {
    files[`api/route-${i}.ts`] =
      `import { K } from "../redis/keys.ts";\n` +
      `import { s } from "../schemas/anchor.ts";\n` +
      `import { bus } from "../event-bus.ts";\n` +
      `export const r${i} = K + s + bus;`;
  }
  return files;
}

describe("repo-graph coupling adapter (#2939)", () => {
  test("getCouplingReport emits ≥10 ranked modules and top cross-group pairs", async () => {
    const report = await getCouplingReport(fsStub(syntheticTree()));

    assert.match(report, /^## Repo coupling summary/m);
    // Header reflects the derived counts.
    assert.match(report, /Derived from the import graph \(\d+ modules, \d+ edges\)/);

    // The module table lists ≥10 rows (rows are the ``| `id` |`` lines).
    const moduleRows = report
      .split("\n")
      .filter((l) => /^\| `[^`]+` \|/.test(l));
    assert.ok(
      moduleRows.length >= 10,
      `expected ≥10 module rows, got ${moduleRows.length}`,
    );

    // The top fan-in hub (redis/keys, imported by every api route + 3 adapters)
    // must appear first in the ranked table.
    const firstRow = moduleRows[0];
    assert.match(firstRow, /`redis\/keys`/);

    // Cross-group section is present and lists the dominant api→* pairs.
    assert.match(report, /### Top cross-group coupling/);
    assert.match(report, /\| api \| redis \| \d+ \|/);
    assert.match(report, /\| api \| schemas \| \d+ \|/);
  });

  test("report is deterministic byte-for-byte across runs", async () => {
    const a = await getCouplingReport(fsStub(syntheticTree()));
    const b = await getCouplingReport(fsStub(syntheticTree()));
    assert.equal(a, b);
  });

  test("topGroupPairs option caps the cross-group section at 5 by default", async () => {
    const report = await getCouplingReport(fsStub(syntheticTree()));
    // Count the data rows under the cross-group table (right-aligned int col).
    const pairRows = report
      .split("\n")
      .filter((l) => /^\| \S+ \| \S+ \| \d+ \|$/.test(l));
    assert.ok(pairRows.length <= 5, `expected ≤5 cross-group pairs, got ${pairRows.length}`);
  });

  test("rankModulesByFanIn sorts by fan-in desc, then coupling desc, then id asc", () => {
    const nodes: ArchitectureNode[] = [
      { id: "b", label: "B", group: "g", inDegree: 2, outDegree: 0, x: 0, y: 0 },
      { id: "a", label: "A", group: "g", inDegree: 2, outDegree: 0, x: 0, y: 0 },
      { id: "hub", label: "Hub", group: "g", inDegree: 5, outDegree: 1, x: 0, y: 0 },
      { id: "c", label: "C", group: "g", inDegree: 2, outDegree: 3, x: 0, y: 0 },
    ];
    const ranked = rankModulesByFanIn(nodes);
    // hub first (fan-in 5); then among fan-in 2: c (coupling 5) before a/b
    // (coupling 2), and a before b on id tiebreak.
    assert.deepEqual(
      ranked.map((r) => r.id),
      ["hub", "c", "a", "b"],
    );
  });

  test("crossGroupPairs excludes intra-group edges and ranks by count", () => {
    const graph: ArchitectureGraph = {
      nodes: [
        { id: "api/x", label: "X", group: "api", inDegree: 0, outDegree: 2, x: 0, y: 0 },
        { id: "api/y", label: "Y", group: "api", inDegree: 1, outDegree: 1, x: 0, y: 0 },
        { id: "redis/keys", label: "Keys", group: "redis", inDegree: 2, outDegree: 0, x: 0, y: 0 },
      ],
      edges: [
        { from: "api/x", to: "redis/keys" }, // cross-group api->redis
        { from: "api/y", to: "redis/keys" }, // cross-group api->redis
        { from: "api/x", to: "api/y" }, // intra-group api->api (excluded)
      ],
      groups: [],
      moduleCount: 3,
      edgeCount: 3,
      scannedAt: "2026-07-06T00:00:00.000Z",
    };
    const pairs = crossGroupPairs(graph);
    assert.deepEqual(pairs, [{ from: "api", to: "redis", count: 2 }]);
  });

  test("renderCouplingReport reports 'No cross-group edges' when none exist", () => {
    const graph: ArchitectureGraph = {
      nodes: [
        { id: "a", label: "A", group: "root", inDegree: 1, outDegree: 0, x: 0, y: 0 },
        { id: "b", label: "B", group: "root", inDegree: 0, outDegree: 1, x: 0, y: 0 },
      ],
      edges: [{ from: "b", to: "a" }],
      groups: [],
      moduleCount: 2,
      edgeCount: 1,
      scannedAt: "2026-07-06T00:00:00.000Z",
    };
    const report = renderCouplingReport(graph);
    assert.match(report, /_No cross-group edges\._/);
  });
});
