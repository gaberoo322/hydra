/**
 * Regression tests for the architecture-graph aggregator (issue #1411).
 *
 * Tests the pure scanner with full filesystem dependency injection — no
 * Express, no real `src/` tree, no module-global cache. The aggregator's
 * contract is:
 *
 *   - a synthetic directory listing + file bodies → one typed graph shape
 *   - `.ts` modules only (`.d.ts` filtered out)
 *   - relative `./mod` imports become edges; in/out degree counted once per
 *     (module, target) pair even on duplicate imports
 *   - GROUP_MAP / GROUP_POSITIONS drive grouping + layout, module-level
 *
 * The scanner is deterministic given the same listing + contents; only
 * `scannedAt` varies (pinned here via the injected `now`).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  scanArchitecture,
  GROUP_MAP,
  GROUP_POSITIONS,
  GROUPS,
} from "../src/aggregators/architecture-graph.ts";

const NOW = new Date("2026-06-08T12:00:00.000Z");

/**
 * Build injectable readdir/readFile stubs over a `name -> body` map. The
 * scanner reads files as `resolve(srcDir, name)`, so the readFile stub keys
 * on the trailing basename to stay independent of the synthetic srcDir.
 */
function fsStub(files: Record<string, string>) {
  return {
    srcDir: "/synthetic/src",
    now: NOW,
    readdir: async (_dir: string) => Object.keys(files),
    readFile: async (path: string) => {
      const base = path.split("/").pop() ?? path;
      const body = files[base];
      if (body === undefined) throw new Error(`no stub for ${path}`);
      return body;
    },
  };
}

describe("architecture-graph aggregator", () => {
  test("scans modules, parses relative imports into edges", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "index.ts": `import { run } from "./cycle.ts";`,
        "cycle.ts": `export const run = 1;`,
      }),
    );

    assert.equal(graph.moduleCount, 2);
    assert.equal(graph.edgeCount, 1);
    assert.deepEqual(graph.edges, [{ from: "index", to: "cycle" }]);

    const index = graph.nodes.find((n) => n.id === "index")!;
    const cycle = graph.nodes.find((n) => n.id === "cycle")!;
    assert.equal(index.outDegree, 1);
    assert.equal(index.inDegree, 0);
    assert.equal(cycle.inDegree, 1);
    assert.equal(cycle.outDegree, 0);
  });

  test("filters .d.ts and non-.ts entries", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "index.ts": `export const a = 1;`,
        "types.d.ts": `export type T = number;`,
        "README.md": `# not a module`,
      } as Record<string, string>),
    );
    assert.equal(graph.moduleCount, 1);
    assert.deepEqual(graph.nodes.map((n) => n.id), ["index"]);
  });

  test("ignores imports to non-existent modules and self-imports", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "index.ts": `import "./missing.ts"; import "./index.ts";`,
      }),
    );
    assert.equal(graph.edgeCount, 0);
    assert.equal(graph.edges.length, 0);
  });

  test("counts a duplicate import to the same target only once", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "index.ts": `import { a } from "./cycle.ts";\nimport { b } from "./cycle.ts";`,
        "cycle.ts": `export const a = 1; export const b = 2;`,
      }),
    );
    assert.equal(graph.edgeCount, 1);
    const index = graph.nodes.find((n) => n.id === "index")!;
    assert.equal(index.outDegree, 1);
  });

  test("titlecases hyphenated module names into node labels", async () => {
    const graph = await scanArchitecture(
      fsStub({ "event-bus.ts": `export const x = 1;` }),
    );
    const node = graph.nodes[0];
    assert.equal(node.id, "event-bus");
    assert.equal(node.label, "Event Bus");
  });

  test("assigns known modules to their GROUP_MAP group, unknowns to 'other'", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "index.ts": `export const a = 1;`, // core
        "redis.ts": `export const b = 1;`, // state
        "totally-unknown.ts": `export const c = 1;`, // other
      }),
    );
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n.group]));
    assert.equal(byId["index"], "core");
    assert.equal(byId["redis"], "state");
    assert.equal(byId["totally-unknown"], "other");
  });

  test("lays out nodes from GROUP_POSITIONS with group-relative offsets", async () => {
    const graph = await scanArchitecture(
      fsStub({ "index.ts": `export const a = 1;` }),
    );
    const index = graph.nodes.find((n) => n.id === "index")!;
    // core group base is { x: 0, y: 0 }; first node sits at base + pad (20),
    // y additionally offset by the 28px group-label band.
    const base = GROUP_POSITIONS["core"];
    assert.equal(index.x, base.x + 20);
    assert.equal(index.y, base.y + 20 + 28);
  });

  test("emits an 'other' group entry when unmapped modules appear", async () => {
    const graph = await scanArchitecture(
      fsStub({ "totally-unknown.ts": `export const a = 1;` }),
    );
    const other = graph.groups.find((g) => g.id === "other");
    assert.ok(other, "expected an 'other' group");
    assert.deepEqual(other!.modules, ["totally-unknown"]);
    assert.ok(other!.bounds.w > 0);
  });

  test("always includes every taxonomy group, even when empty", async () => {
    const graph = await scanArchitecture(
      fsStub({ "index.ts": `export const a = 1;` }),
    );
    for (const g of GROUPS) {
      assert.ok(
        graph.groups.some((out) => out.id === g.id),
        `expected group ${g.id} in output`,
      );
    }
  });

  test("scannedAt reflects the injected clock", async () => {
    const graph = await scanArchitecture(
      fsStub({ "index.ts": `export const a = 1;` }),
    );
    assert.equal(graph.scannedAt, NOW.toISOString());
  });

  test("GROUP_MAP and GROUP_POSITIONS are module-level constants", () => {
    // GROUP_MAP is derived from GROUPS; spot-check a couple of mappings.
    assert.equal(GROUP_MAP["index"].id, "core");
    assert.equal(GROUP_MAP["api"].id, "infra");
    // GROUP_POSITIONS keys every group except the dynamic 'other'.
    assert.ok(GROUP_POSITIONS["core"]);
    assert.ok(GROUP_POSITIONS["infra"]);
  });
});
