/**
 * The areas family (#4596 — docs-epic slice 10): parser, slug, join and term
 * rules, pinned AGGREGATE-OFFENDER style on injected markdown and throwaway
 * trees, plus one live-corpus parity check (the routes join recomputed from
 * routes.json against areas.json's stored slices).
 *
 * Per INV-17 the pins are rule-level — never one subtest per area or per row.
 * The LIVE-tree invariants (every Reference docs link resolves, no living
 * /docs/ref/ doc orphaned, areas.json byte-parity with a fresh run) live in
 * their homes: test/adr-roster.test.mts assertion 7 and
 * test/generated-inventories-drift.test.mts.
 *
 * No Redis, no network — filesystem reads and tmp trees only.
 */
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FAMILIES } from "../scripts/docs/generate-inventories.ts";
import type { FamilyContext } from "../scripts/docs/generate-inventories.ts";
import type { Inventory } from "../scripts/docs/inventories/envelope.ts";
import {
  parseContextMapAreas,
  parseContextMapRows,
  parseTermsCell,
  readContextMap,
} from "../scripts/docs/inventories/context-map.ts";
import { areaPathMatches, extractAreasFamily, joinPathOf, joinedRows } from "../scripts/docs/inventories/areas.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("docs-areas (#4596)", () => {
  test("INV-1 — the one CONTEXT-MAP parser: projection preserved, adr-roster imports it", () => {
    const live = readContextMap(REPO_ROOT);
    const projection = parseContextMapAreas(live);
    const rich = parseContextMapRows(live);

    assert.equal(projection.tables, 2, "expected the domain + infra routing tables");
    assert.ok(projection.rows.length >= 15, `parsed only ${projection.rows.length} routing rows`);
    assert.equal(projection.rows.length, rich.rows.length, "the two projections must cover the same rows");

    // Same rows, same ADRs: the projection's sorted+deduped numbers equal the
    // rich projection's cell-order deduped numbers, sorted.
    const offenders: string[] = [];
    projection.rows.forEach((p, i) => {
      const r = rich.rows[i];
      if (p.area !== r.name) offenders.push(`row ${i}: projection area "${p.area}" !== rich name "${r.name}"`);
      if (JSON.stringify(p.adrs) !== JSON.stringify([...r.adrs].sort())) {
        offenders.push(`row ${i} (${p.area}): projection adrs [${p.adrs}] !== rich adrs [${r.adrs}]`);
      }
    });
    assert.deepEqual(offenders, [], "the adr-area baseline projection drifted from the rich projection");

    // adr-roster imports the one parser and no longer declares its own copy.
    const rosterSrc = readFileSync(resolve(REPO_ROOT, "test/adr-roster.test.mts"), "utf8");
    assert.match(
      rosterSrc,
      /import\s*\{[^}]*parseContextMapAreas[^}]*\}\s*from\s*"\.\.\/scripts\/docs\/inventories\/context-map\.ts"/,
      "test/adr-roster.test.mts must import the parser from the extractor module",
    );
    assert.ok(!/export function parseContextMapAreas/.test(rosterSrc), "adr-roster still declares its own parser copy");
  });

  test("INV-2 — Reference docs is the LAST column on both tables; losing it fails loud", () => {
    // The live file: both routing tables end their header row with Reference docs.
    const headers = readContextMap(REPO_ROOT)
      .split("\n")
      .filter((line) => line.trim().startsWith("|") && /relevant adrs/i.test(line) && !/^[\s|:-]+$/.test(line));
    assert.equal(headers.length, 2, `expected 2 Relevant-ADRs header rows, found ${headers.length}`);
    const offenders = headers
      .map((line) => line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").pop()?.trim() ?? "")
      .filter((last) => !/^reference docs$/i.test(last));
    assert.deepEqual(
      offenders,
      [],
      "Reference docs must be the LAST header cell of both routing tables (an area view renders it)",
    );

    // Losing the column fails loud at parse time, never a silent skip.
    const withoutColumn = [
      "| Code area | Relevant ADRs |",
      "| --- | --- |",
      "| `src/example/` | ADR-0001 |",
    ].join("\n");
    assert.throws(() => parseContextMapRows(withoutColumn), /table 1 has no Reference docs column/);
  });

  test("INV-5 — join rules: routes by areas membership, every other family by one path field", () => {
    // Prefix semantics: a directory path matches itself and everything under
    // it; a file path matches only itself.
    assert.ok(areaPathMatches(["src/cost/"], "src/cost/"));
    assert.ok(areaPathMatches(["src/cost/"], "src/cost/ledger.ts"));
    assert.ok(!areaPathMatches(["src/cost/"], "src/costly.ts"));
    assert.ok(areaPathMatches(["src/target-config.ts"], "src/target-config.ts"));
    assert.ok(!areaPathMatches(["src/target-config.ts"], "src/target-config.ts.bak"));

    // The one declared path field: routes never; row `path` for the families
    // whose row subject IS a path; source.path for every other family.
    assert.equal(joinPathOf("routes", { areas: ["src/x/"] }), null);
    assert.equal(joinPathOf("config", { path: "config/orchestrator/vision.md" }), "config/orchestrator/vision.md");
    assert.equal(joinPathOf("corpus", { path: "src/cost/CONTEXT.md" }), "src/cost/CONTEXT.md");
    assert.equal(joinPathOf("schemas", { source: { path: "src/schemas/alert.ts" } }), "src/schemas/alert.ts");
    assert.equal(joinPathOf("schemas", { source: { path: "" } }), null);

    // Routes join by areas membership (exact string), never by source.path:
    // the route below lives in a file under src/api/ but IS joined to src/redis/.
    const routesInv = {
      family: "routes",
      schemaVersion: 1 as const,
      generatedFrom: [],
      rows: [
        { method: "GET", path: "/api/joined", areas: ["src/redis/"], source: { path: "src/api/router.ts" } },
        { method: "GET", path: "/api/other", areas: ["src/api/"], source: { path: "src/api/router.ts" } },
      ],
    };
    assert.deepEqual(
      joinedRows("routes", routesInv, ["src/redis/"]).map((r) => (r as { path: string }).path),
      ["/api/joined"],
    );
    // Every other family joins through its one path field with the prefix rule.
    const corpusInv = {
      family: "corpus",
      schemaVersion: 1 as const,
      generatedFrom: [],
      rows: [{ path: "src/cost/CONTEXT.md" }, { path: "src/redis/CONTEXT.md" }],
    };
    assert.deepEqual(
      joinedRows("corpus", corpusInv, ["src/cost/"]).map((r) => (r as { path: string }).path),
      ["src/cost/CONTEXT.md"],
    );

    // LIVE parity: every non-retired area's stored routes slice equals a fresh
    // join recomputed from routes.json's own rows (INV-17's one live check).
    const areasJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "docs/generated/areas.json"), "utf8"));
    const routesJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "docs/generated/routes.json"), "utf8"));
    const drift: string[] = [];
    for (const area of areasJson.rows) {
      if (area.retired) continue;
      const areaSet = new Set<string>(area.paths);
      const fresh = routesJson.rows
        .filter((r: { areas: string[] }) => r.areas.some((a) => areaSet.has(a)))
        .map((r: { method: string; path: string }) => `${r.method} ${r.path}`);
      if (JSON.stringify(area.slices.routes ?? []) !== JSON.stringify(fresh)) {
        drift.push(area.name);
      }
    }
    assert.deepEqual(
      drift,
      [],
      `docs/generated/areas.json routes slices disagree with a fresh join from routes.json for:\n  ${drift.join("\n  ")}\n` +
        `Fix: npm run docs:inventories`,
    );
  });

  test("INV-9 — buildViews emits Areas views for non-retired areas and module maps; retired rows produce no view", async () => {
    const { buildViews } = await import("../dashboard/vite-plugins/docs-core.js");
    const outlines = new Map();
    const corpusRows = [
      { path: "src/alpha/CONTEXT.md", tier: "module-map", route: "/docs/area/src-alpha", title: "Alpha module map" },
      { path: "src/orphan/CONTEXT.md", tier: "module-map", route: "/docs/area/src-orphan", title: "Orphan module map" },
    ];
    const areaRows = [
      { slug: "src-alpha", name: "src/alpha/", route: "/docs/area/src-alpha", retired: false },
      { slug: "src-beta", name: "src/beta/", route: "/docs/area/src-beta", retired: false },
      { slug: "src-gone", name: "src/gone/", route: null, retired: true },
      // Even a retired row carrying a stale route produces no view.
      { slug: "src-stale", name: "src/stale/", route: "/docs/area/src-stale", retired: true },
    ];

    const views = buildViews(corpusRows, outlines, areaRows).filter((v) => v.group === "Areas");
    const keys = views.map((v) => v.key).sort();
    assert.deepEqual(keys, ["area/src-alpha", "area/src-beta", "area/src-orphan"], "live areas + module-map-only keys, never retired rows");
    const alpha = views.find((v) => v.key === "area/src-alpha");
    assert.equal(alpha?.label, "src/alpha/", "an area with a row labels by the row's name");
    assert.deepEqual(
      alpha?.sources.map((s) => s.path),
      ["src/alpha/CONTEXT.md"],
      "an area with a module map sources it",
    );
    const beta = views.find((v) => v.key === "area/src-beta");
    assert.deepEqual(beta?.sources, [], "an area with no module map sources nothing");

    // The 2-argument call (every corpus row still routes to a built view):
    // the Areas group degrades to exactly the module-map keys.
    const bare = buildViews(corpusRows, outlines).filter((v) => v.group === "Areas");
    assert.deepEqual(
      bare.map((v) => v.key).sort(),
      ["area/src-alpha", "area/src-orphan"],
      "without areas.json rows, module-map corpus rows still get their views",
    );
  });

  test("INV-10 — terms parse (comma split, decoration strip) and an unknown term fails loud naming row and term", () => {
    // Cell rules on injected text.
    assert.deepEqual(parseTermsCell(""), []);
    assert.deepEqual(parseTermsCell("—"), []);
    assert.deepEqual(parseTermsCell("Orchestrator, Autopilot"), ["Orchestrator", "Autopilot"]);
    assert.deepEqual(parseTermsCell("**Builder** (via hydra-dev), Scheduler"), ["Builder", "Scheduler"]);

    // A throwaway tree exercises the extractor end to end: unknown terms fail
    // loud naming the row AND the term; known terms resolve to term- anchors;
    // retired rows keep their cell verbatim, never resolved.
    const tmp = mkdtempSync(join(tmpdir(), "docs-areas-"));
    const domainTable = [
      "| Code area | Relevant ADRs | Glossary terms | Module map | Reference docs |",
      "| --- | --- | --- | --- | --- |",
      "| `src/alpha/` | ADR-0001 ADR-0001 | Alpha Term | `src/alpha/CONTEXT.md` | — |",
      "| `src/beta/` | — | Not A Real Term | — | — |",
      "| ~~`src/gone/`~~ | — | Gone Verbatim | — | — |",
    ].join("\n");
    const infraTable = ["| Area | Relevant ADRs | Reference docs |", "| --- | --- | --- |", "| process | — | — |"].join("\n");
    const emptyInventory = (family: string): Inventory<unknown> => ({
      family,
      schemaVersion: 1,
      generatedFrom: [],
      rows: [],
    });
    const ctx: FamilyContext = {
      routes: emptyInventory("routes") as FamilyContext["routes"],
      corpus: emptyInventory("corpus") as FamilyContext["corpus"],
      classes: emptyInventory("classes") as FamilyContext["classes"],
      built: new Map(
        FAMILIES.filter((f) => f.family !== "areas").map((f) => [f.family, emptyInventory(f.family)]),
      ),
    };
    try {
      writeFileSync(join(tmp, "CONTEXT-MAP.md"), `${domainTable}\n\n${infraTable}\n`);
      writeFileSync(join(tmp, "CONTEXT.md"), "# Glossary\n\n**Alpha Term**: does alpha things.\n");

      assert.throws(
        () => extractAreasFamily(tmp, ctx),
        /row "src\/beta\/" names glossary term "Not A Real Term", but CONTEXT\.md has no bold-led/,
        "an unknown term must fail loud naming the row and the term",
      );

      writeFileSync(
        join(tmp, "CONTEXT-MAP.md"),
        `${domainTable.replace("Not A Real Term", "Alpha Term")}\n\n${infraTable}\n`,
      );
      const rows = extractAreasFamily(tmp, ctx).rows;
      const alpha = rows.find((r) => r.slug === "src-alpha");
      const gone = rows.find((r) => r.slug === "src-gone");
      assert.deepEqual(alpha?.terms, [{ name: "Alpha Term", anchor: "term-alpha-term" }]);
      assert.deepEqual(alpha?.adrs, ["0001"], "the Relevant ADRs cell is deduped in cell order");
      assert.deepEqual(gone?.terms, [{ name: "Gone Verbatim", anchor: null }], "a retired row keeps its cell verbatim");
      assert.equal(gone?.route, null, "a retired row has no route");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
