/**
 * Regression tests for the architecture-graph aggregator (issue #1411;
 * taxonomy deepened in issue #1772).
 *
 * Tests the pure scanner with full filesystem dependency injection — no
 * Express, no real `src/` tree, no module-global cache. The aggregator's
 * contract is:
 *
 *   - a synthetic RECURSIVE directory listing + file bodies → one typed
 *     graph shape
 *   - `.ts` modules only (`.d.ts` filtered out)
 *   - relative `./` and `../` imports resolve against the importer's
 *     directory and become edges; in/out degree counted once per
 *     (module, target) pair even on duplicate imports
 *   - group membership is DERIVED from the module path: `src/<dir>/x.ts` →
 *     group `<dir>`, flat `src/x.ts` → group `root`. GROUP_META is display
 *     metadata only — a key with no modules on disk emits no group, and an
 *     unknown directory self-registers with a deterministic default.
 *   - layout is a deterministic row-packing over the derived groups — no
 *     fixed position table; group bounds never overlap.
 *
 * The scanner is deterministic given the same listing + contents; only
 * `scannedAt` varies (pinned here via the injected `now`).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  scanArchitecture,
  computeGroupLayout,
  LAYOUT_DEFAULTS,
  GROUP_META,
  type ArchitectureNode,
} from "../src/aggregators/architecture-graph.ts";

const NOW = new Date("2026-06-08T12:00:00.000Z");
const SRC = "/synthetic/src";

/**
 * Build injectable readdir/readFile stubs over a `relative-path -> body`
 * map. The scanner reads files as `resolve(srcDir, relPath)`, so the
 * readFile stub keys on the srcDir-relative remainder of the path.
 */
function fsStub(files: Record<string, string>) {
  return {
    srcDir: SRC,
    now: NOW,
    readdir: async (_dir: string) => Object.keys(files),
    readFile: async (path: string) => {
      const rel = path.startsWith(`${SRC}/`) ? path.slice(SRC.length + 1) : path;
      const body = files[rel];
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
        "redis/CONTEXT.md": `# glossary, not a module`,
      } as Record<string, string>),
    );
    assert.equal(graph.moduleCount, 1);
    assert.deepEqual(graph.nodes.map((n) => n.id), ["index"]);
  });

  test("ignores imports to non-existent modules and self-imports", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "index.ts": `import { a } from "./missing.ts";\nimport { b } from "./index.ts";`,
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

  test("titlecases the basename of hyphenated and nested module ids", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "event-bus.ts": `export const x = 1;`,
        "scheduler/heartbeat-loop.ts": `export const y = 1;`,
      }),
    );
    const flat = graph.nodes.find((n) => n.id === "event-bus")!;
    assert.equal(flat.label, "Event Bus");
    const nested = graph.nodes.find((n) => n.id === "scheduler/heartbeat-loop")!;
    assert.equal(nested.label, "Heartbeat Loop");
  });

  test("derives group membership from the module path, not a name list", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "index.ts": `export const a = 1;`, // flat → root
        "redis/anchors.ts": `export const b = 1;`, // src/redis/ → redis
        "redis/client.ts": `export const c = 1;`,
        "schemas/backlog.ts": `export const d = 1;`, // src/schemas/ → schemas
      }),
    );
    const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n.group]));
    assert.equal(byId["index"], "root");
    assert.equal(byId["redis/anchors"], "redis");
    assert.equal(byId["redis/client"], "redis");
    assert.equal(byId["schemas/backlog"], "schemas");
  });

  test("a brand-new directory self-registers with deterministic default meta", async () => {
    // No GROUP_META entry exists for "newdomain" — it must still appear as a
    // correctly-derived group with a titlecased label and a palette color.
    assert.equal(GROUP_META["newdomain"], undefined);
    const graph = await scanArchitecture(
      fsStub({ "newdomain/thing-doer.ts": `export const a = 1;` }),
    );
    const group = graph.groups.find((g) => g.id === "newdomain");
    assert.ok(group, "expected derived group 'newdomain'");
    assert.equal(group!.label, "Newdomain");
    assert.ok(group!.color.length > 0, "default color assigned");
    assert.deepEqual(group!.modules, ["newdomain/thing-doer"]);
  });

  test("no ghost groups — GROUP_META keys with no modules emit nothing", async () => {
    // GROUP_META carries display overrides for e.g. "api" and "redis"; a scan
    // whose listing contains neither must not emit those groups.
    assert.ok(GROUP_META["api"], "precondition: api has a display override");
    const graph = await scanArchitecture(
      fsStub({ "index.ts": `export const a = 1;` }),
    );
    assert.deepEqual(graph.groups.map((g) => g.id), ["root"]);
    for (const g of graph.groups) {
      assert.ok(g.modules.length >= 1, `group ${g.id} must have members`);
    }
  });

  test("GROUP_META display overrides apply to derived groups", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "api/misc.ts": `export const a = 1;`,
        "index.ts": `export const b = 1;`,
      }),
    );
    const api = graph.groups.find((g) => g.id === "api")!;
    assert.equal(api.label, GROUP_META["api"].label);
    assert.equal(api.color, GROUP_META["api"].color);
    const root = graph.groups.find((g) => g.id === "root")!;
    assert.equal(root.label, "Top-level");
  });

  test("resolves ./ and ../ imports across directories into path-based edges", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "event-bus.ts": `export const bus = 1;`,
        "api/architecture.ts":
          `import { bus } from "../event-bus.ts";\n` +
          `import { scan } from "../aggregators/architecture-graph.ts";\n` +
          `import { helper } from "./misc.ts";`,
        "api/misc.ts": `export const helper = 1;`,
        "aggregators/architecture-graph.ts": `export const scan = 1;`,
      }),
    );
    const sorted = [...graph.edges].sort((a, b) =>
      (a.from + a.to).localeCompare(b.from + b.to),
    );
    assert.deepEqual(sorted, [
      { from: "api/architecture", to: "aggregators/architecture-graph" },
      { from: "api/architecture", to: "api/misc" },
      { from: "api/architecture", to: "event-bus" },
    ]);
    const importer = graph.nodes.find((n) => n.id === "api/architecture")!;
    assert.equal(importer.outDegree, 3);
  });

  test("ignores relative imports that escape srcDir", async () => {
    const graph = await scanArchitecture(
      fsStub({
        "index.ts": `import { x } from "../outside/module.ts";`,
      }),
    );
    assert.equal(graph.edgeCount, 0);
  });

  test("deterministic — two scans over the same synthetic tree are identical", async () => {
    const files = {
      "index.ts": `import { a } from "./cycle.ts";`,
      "cycle.ts": `export const a = 1;`,
      "redis/anchors.ts": `import { a } from "../cycle.ts";`,
      "schemas/backlog.ts": `export const s = 1;`,
    };
    const a = await scanArchitecture(fsStub(files));
    const b = await scanArchitecture(fsStub(files));
    assert.deepEqual(a, b);
  });

  test("derived group bounds never overlap, nodes sit inside their group", async () => {
    // Enough groups to force at least one row wrap on the 1400px canvas.
    const files: Record<string, string> = {};
    for (const dir of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]) {
      for (let i = 0; i < 4; i++) files[`${dir}/mod-${i}.ts`] = `export const x = ${i};`;
    }
    files["index.ts"] = `export const root = 1;`;
    const graph = await scanArchitecture(fsStub(files));

    assert.equal(graph.groups.length, 7);
    const overlaps = (
      a: { x: number; y: number; w: number; h: number },
      b: { x: number; y: number; w: number; h: number },
    ) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (let i = 0; i < graph.groups.length; i++) {
      for (let j = i + 1; j < graph.groups.length; j++) {
        assert.ok(
          !overlaps(graph.groups[i].bounds, graph.groups[j].bounds),
          `groups ${graph.groups[i].id} and ${graph.groups[j].id} overlap`,
        );
      }
    }
    for (const n of graph.nodes) {
      const g = graph.groups.find((g) => g.id === n.group)!;
      assert.ok(
        n.x >= g.bounds.x && n.x < g.bounds.x + g.bounds.w,
        `node ${n.id} x outside group ${g.id}`,
      );
      assert.ok(
        n.y >= g.bounds.y && n.y < g.bounds.y + g.bounds.h,
        `node ${n.id} y outside group ${g.id}`,
      );
    }
  });

  test("scannedAt reflects the injected clock", async () => {
    const graph = await scanArchitecture(
      fsStub({ "index.ts": `export const a = 1;` }),
    );
    assert.equal(graph.scannedAt, NOW.toISOString());
  });

  test("concurrent scans don't corrupt each other's import regex lastIndex", async () => {
    // Regression for PR #1416 QA blocker: a module-scoped `/g` regex carries
    // mutable `lastIndex`, and `scanArchitecture` awaits `readFile` mid-loop.
    // A shared hoisted regex would let two interleaved cache-miss scans clobber
    // each other's match position, silently dropping edges. With a per-call
    // regex, two scans run against the SAME synthetic tree must produce
    // identical edge sets — even when their readFile awaits interleave.
    //
    // Force interleaving: readFile returns a promise that only resolves once
    // BOTH concurrent scans have entered their first readFile. That guarantees
    // scan A is parked at the await while scan B starts (and vice versa), the
    // exact window where a shared regex would corrupt.
    const files: Record<string, string> = {
      "index.ts": `import { run } from "./cycle.ts";\nimport { x } from "./redis/client.ts";`,
      "cycle.ts": `import { y } from "./redis/client.ts";`,
      "redis/client.ts": `export const x = 1; export const y = 2;`,
    };

    let waiting = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const interleavingStub = () => ({
      srcDir: SRC,
      now: NOW,
      readdir: async (_dir: string) => Object.keys(files),
      readFile: async (path: string) => {
        const rel = path.startsWith(`${SRC}/`) ? path.slice(SRC.length + 1) : path;
        // Park on the first readFile of each scan until both have arrived,
        // then proceed concurrently from a shared await suspension point.
        if (++waiting <= 2) {
          if (waiting === 2) release();
          await gate;
        }
        const body = files[rel];
        if (body === undefined) throw new Error(`no stub for ${path}`);
        return body;
      },
    });

    const [a, b] = await Promise.all([
      scanArchitecture(interleavingStub()),
      scanArchitecture(interleavingStub()),
    ]);

    const sortEdges = (es: typeof a.edges) =>
      [...es].sort((p, q) => (p.from + p.to).localeCompare(q.from + q.to));

    // Expected edges: index->cycle, index->redis/client, cycle->redis/client.
    assert.equal(a.edgeCount, 3, "scan A must find all 3 edges");
    assert.equal(b.edgeCount, 3, "scan B must find all 3 edges");
    assert.deepEqual(
      sortEdges(a.edges),
      sortEdges(b.edges),
      "interleaved scans must produce identical edge sets",
    );
  });
});

/**
 * Direct unit tests for the extracted pure layout algorithm (issue #2246).
 *
 * `computeGroupLayout` was carved out of `scanArchitecture` so the grid-packing
 * concern is testable without a filesystem: feed it a synthetic `byGroup` map
 * and assert node coordinates + group bounding boxes. The interface IS the test
 * surface — no `readdir`/`readFile` stub required.
 *
 * Separate top-level `describe` with no shared lifecycle (these tests touch no
 * Redis seam and no shared mutable module state — each builds its own nodes).
 */
describe("computeGroupLayout (pure layout algorithm)", () => {
  let nodeSeq = 0;
  /** Synthetic node factory — only the fields layout reads/writes matter. */
  function node(group: string): ArchitectureNode {
    return {
      id: `${group}/n${nodeSeq++}`,
      label: "N",
      group,
      inDegree: 0,
      outDegree: 0,
      x: -1,
      y: -1,
    };
  }
  function byGroup(spec: Record<string, number>): Record<string, ArchitectureNode[]> {
    const out: Record<string, ArchitectureNode[]> = {};
    for (const [g, count] of Object.entries(spec)) {
      out[g] = Array.from({ length: count }, () => node(g));
    }
    return out;
  }

  test("single group: first node sits at the pad+label origin", () => {
    const groups = byGroup({ alpha: 1 });
    const { groupBounds } = computeGroupLayout(groups);
    const L = LAYOUT_DEFAULTS;

    const n = groups.alpha[0];
    assert.equal(n.x, L.GROUP_PAD, "first node x is one GROUP_PAD in");
    assert.equal(n.y, L.GROUP_PAD + L.GROUP_LABEL_H, "first node y clears the label band");

    // One node → one column, one row.
    const b = groupBounds.alpha;
    assert.equal(b.x, 0);
    assert.equal(b.y, 0);
    assert.equal(b.w, L.GROUP_PAD * 2 + L.NODE_W);
    assert.equal(b.h, L.GROUP_PAD * 2 + L.GROUP_LABEL_H + L.NODE_H);
  });

  test("a group larger than COLS_PER_GROUP wraps onto a second internal row", () => {
    // 4 members with COLS_PER_GROUP=3 → 3 in row 0, 1 in row 1.
    const groups = byGroup({ alpha: 4 });
    const L = LAYOUT_DEFAULTS;
    const { groupBounds } = computeGroupLayout(groups);

    const [n0, n1, n2, n3] = groups.alpha;
    // Row 0, columns 0..2.
    assert.equal(n0.x, L.GROUP_PAD + 0 * (L.NODE_W + L.NODE_GAP_X));
    assert.equal(n2.x, L.GROUP_PAD + 2 * (L.NODE_W + L.NODE_GAP_X));
    assert.equal(n0.y, n2.y, "row-0 members share a y");
    // 4th member drops to internal row 1, column 0.
    assert.equal(n3.x, L.GROUP_PAD, "wrapped member returns to column 0");
    assert.equal(n3.y, n0.y + (L.NODE_H + L.NODE_GAP_Y), "wrapped member is one row down");
    void n1;

    // Bounds height reflects 2 rows.
    assert.equal(
      groupBounds.alpha.h,
      L.GROUP_PAD * 2 + L.GROUP_LABEL_H + 2 * L.NODE_H + 1 * L.NODE_GAP_Y,
    );
  });

  test("groups are placed in sorted-id order, packed left to right", () => {
    // Insertion order bravo, alpha — layout must sort to alpha, bravo.
    const groups: Record<string, ArchitectureNode[]> = {
      bravo: [node("bravo")],
      alpha: [node("alpha")],
    };
    const L = LAYOUT_DEFAULTS;
    const { groupBounds } = computeGroupLayout(groups);

    assert.equal(groupBounds.alpha.x, 0, "alpha sorts first → x=0");
    assert.equal(
      groupBounds.bravo.x,
      groupBounds.alpha.w + L.GROUP_GAP,
      "bravo follows alpha by its width + GROUP_GAP",
    );
    assert.equal(groupBounds.alpha.y, groupBounds.bravo.y, "same row");
  });

  test("groups wrap to a new row when the next would overflow CANVAS_W", () => {
    const L = LAYOUT_DEFAULTS;
    // A full COLS_PER_GROUP-wide group is GROUP_PAD*2 + 3*NODE_W + 2*NODE_GAP_X
    // = 40 + 450 + 32 = 522 wide; stride = 522 + GROUP_GAP(40) = 562. On the
    // 1400px canvas: a@0, b@562; placing c at 1124 → 1124+522=1646 > 1400, so
    // the 3rd group wraps to row 1. Five such groups guarantees a wrap.
    const spec: Record<string, number> = {};
    for (const g of ["a", "b", "c", "d", "e"]) spec[g] = L.COLS_PER_GROUP;
    const groups = byGroup(spec);
    const { groupBounds } = computeGroupLayout(groups);

    // Row 0 holds the groups that fit; at least one later group must wrap.
    assert.equal(groupBounds.a.y, 0, "first group is on row 0");
    assert.equal(groupBounds.a.x, 0, "first group starts at x=0");
    const wrapped = ["a", "b", "c", "d", "e"].filter((g) => groupBounds[g].y > 0);
    assert.ok(wrapped.length > 0, "at least one group wraps to a new row");

    const firstWrapped = wrapped[0];
    assert.equal(groupBounds[firstWrapped].x, 0, "wrapped group restarts at x=0");
    assert.equal(
      groupBounds[firstWrapped].y,
      groupBounds.a.h + L.GROUP_GAP,
      "row-1 y clears the tallest row-0 group + GROUP_GAP",
    );
  });

  test("returns the same node objects it mutated, flattened in sorted-group order", () => {
    const groups: Record<string, ArchitectureNode[]> = {
      bravo: [node("bravo")],
      alpha: [node("alpha"), node("alpha")],
    };
    const { nodes } = computeGroupLayout(groups);
    assert.deepEqual(
      nodes.map((n) => n.group),
      ["alpha", "alpha", "bravo"],
      "flattened in sorted-group-id order",
    );
    // Same identities (mutated in place), not copies.
    assert.ok(nodes.includes(groups.alpha[0]));
    assert.ok(nodes.includes(groups.bravo[0]));
    for (const n of nodes) {
      assert.ok(n.x >= 0 && n.y >= 0, "every node got real coordinates");
    }
  });

  test("empty group map yields empty bounds and no nodes", () => {
    const { nodes, groupBounds } = computeGroupLayout({});
    assert.deepEqual(nodes, []);
    assert.deepEqual(groupBounds, {});
  });

  test("override layout constants are honoured", () => {
    const groups = byGroup({ alpha: 1 });
    const wide = { ...LAYOUT_DEFAULTS, GROUP_PAD: 100 };
    const { groupBounds } = computeGroupLayout(groups, wide);
    assert.equal(groupBounds.alpha.w, 100 * 2 + LAYOUT_DEFAULTS.NODE_W);
    assert.equal(groups.alpha[0].x, 100);
  });

  test("matches scanArchitecture's coordinates for the same bucketed nodes (no behaviour change)", async () => {
    // End-to-end equivalence: the coordinates the full scanner emits must equal
    // what computeGroupLayout produces when fed the same group buckets.
    const files: Record<string, string> = {};
    for (const dir of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]) {
      for (let i = 0; i < 4; i++) files[`${dir}/mod-${i}.ts`] = `export const x = ${i};`;
    }
    files["index.ts"] = `export const root = 1;`;
    const graph = await scanArchitecture(fsStub(files));

    // Rebuild the byGroup map from the scanner's emitted nodes (coords zeroed),
    // run the pure layout, and assert the coordinates + bounds match.
    const reGroup: Record<string, ArchitectureNode[]> = {};
    for (const n of graph.nodes) {
      (reGroup[n.group] ??= []).push({ ...n, x: 0, y: 0 });
    }
    const { groupBounds } = computeGroupLayout(reGroup);

    for (const g of graph.groups) {
      assert.deepEqual(groupBounds[g.id], g.bounds, `bounds match for group ${g.id}`);
    }
    for (const [gid, members] of Object.entries(reGroup)) {
      for (const m of members) {
        const orig = graph.nodes.find((n) => n.id === m.id)!;
        assert.equal(m.x, orig.x, `x matches for ${m.id} in ${gid}`);
        assert.equal(m.y, orig.y, `y matches for ${m.id} in ${gid}`);
      }
    }
  });
});
