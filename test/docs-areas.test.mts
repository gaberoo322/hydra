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
import {
  areaPathMatches,
  extractAreasFamily,
  glossaryAnchors,
  joinPathOf,
  joinedRows,
} from "../scripts/docs/inventories/areas.ts";
import { areaSlug } from "../scripts/docs/inventories/corpus.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const emptyInventory = (family: string): Inventory<unknown> => ({
  family,
  schemaVersion: 1,
  generatedFrom: [],
  rows: [],
});

/** A FamilyContext whose every joined family is an empty inventory; `omit` drops one (registry-order bug). */
function makeCtx(omit?: string): FamilyContext {
  return {
    routes: emptyInventory("routes") as FamilyContext["routes"],
    corpus: emptyInventory("corpus") as FamilyContext["corpus"],
    classes: emptyInventory("classes") as FamilyContext["classes"],
    built: new Map(
      FAMILIES.filter((f) => f.family !== "areas" && f.family !== omit).map((f) => [f.family, emptyInventory(f.family)]),
    ),
  };
}

const INFRA_TABLE = ["| Area | Relevant ADRs | Reference docs |", "| --- | --- | --- |", "| process | — | — |"].join("\n");
const domainTable = (...rows: string[]): string =>
  [
    "| Code area | Relevant ADRs | Glossary terms | Module map | Reference docs |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");

/** Run extractAreasFamily over a throwaway tree holding the given CONTEXT-MAP.md / CONTEXT.md. */
function extractIn(contextMap: string, context: string, ctx: FamilyContext = makeCtx()) {
  const tmp = mkdtempSync(join(tmpdir(), "docs-areas-"));
  try {
    writeFileSync(join(tmp, "CONTEXT-MAP.md"), contextMap);
    writeFileSync(join(tmp, "CONTEXT.md"), context);
    return extractAreasFamily(tmp, ctx);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

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
    const ctx = makeCtx();
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
  test("INV-7 — areaSlug rule and the fail-loud slug-collision / module-map-route throws", () => {
    assert.equal(areaSlug("src/Cost/"), "src-cost", "lowercase + trailing slash stripped");
    assert.equal(areaSlug("src/cost///"), "src-cost", "every trailing slash stripped");
    assert.equal(areaSlug("Scripts & Ops (misc)"), "scripts-ops-misc", "runs of non-alnum collapse to one dash, ends trimmed");
    assert.equal(areaSlug("src/target-config.ts"), "src-target-config-ts");

    const ok = ["| `src/alpha/` | — | — | — | — |"];
    // Two rows slugging identically fail loud naming both.
    assert.throws(
      () => extractIn(`${domainTable(...ok, "| `src/Alpha/` | — | — | — | — |")}\n\n${INFRA_TABLE}\n`, "# G\n"),
      /rows "src\/alpha\/" and "src\/Alpha\/" both slug to "src-alpha"/,
    );
    // A module map whose directory is not the row's first path fails loud.
    assert.throws(
      () => extractIn(`${domainTable("| `src/alpha/` | — | — | `src/other/CONTEXT.md` | — |")}\n\n${INFRA_TABLE}\n`, "# G\n"),
      /row "src\/alpha\/" names module map src\/other\/CONTEXT\.md, whose corpus route/,
    );
  });

  test("INV-4 — extractAreasFamily throws when a joined family is absent from built (registry-order bug)", () => {
    const map = `${domainTable("| `src/alpha/` | — | — | — | — |")}\n\n${INFRA_TABLE}\n`;
    assert.doesNotThrow(() => extractIn(map, "# G\n"));
    assert.throws(
      () => extractIn(map, "# G\n", makeCtx("adrs")),
      /areas joins family "adrs" but it is absent from FamilyContext\.built/,
    );
  });

  describe("INV-11 — glossaryAnchors equals the ids the docs-markdown renderer emits", async () => {
    let Marked: (new (opts: object) => { lexer(src: string): unknown[] }) | undefined;
    try {
      ({ Marked } = await import(new URL("../dashboard/node_modules/marked/lib/marked.esm.js", import.meta.url).href));
    } catch (err) {
      /* intentional: marked not installed in this checkout — the parity test skips */
      void err;
    }

    /** Render `source` as CONTEXT.md through the real renderer; return the term- ids in document order. */
    async function renderedTermIds(source: string): Promise<string[]> {
      const core = await import("../dashboard/vite-plugins/docs-core.js");
      const { createRenderer } = await import("../dashboard/vite-plugins/docs-markdown.js");
      const tokens = new Marked!({ gfm: true }).lexer(source);
      const outline = core.outlineTokens(tokens);
      const rows = [{ path: "CONTEXT.md", tier: "living", route: "/docs/ref/context", title: "Glossary" }];
      const outlines = new Map([["CONTEXT.md", { headings: outline.headings }]]);
      const views = core.buildViews(rows, outlines);
      const hosts = core.headingHosts(views, outlines);
      const resolveLink = core.createLinkResolver({ rows, outlines, hosts, fileKind: () => null, sha: "abc" });
      const render = createRenderer({ resolveLink, docs: new Map([["CONTEXT.md", { tokens, outline }]]) });
      const html = (render("CONTEXT.md") as { html: string }[]).map((x) => x.html).join("\n");
      return [...html.matchAll(/<p id="(term-[^"]+)">/g)].map((m) => m[1]);
    }

    test("tricky shapes: continuation lines, list/blockquote paragraphs, fences, duplicate names", { skip: Marked ? false : "marked not installed" }, async () => {
      const source = [
        "# Glossary",
        "",
        "**Alpha**: first.",
        "**Not A Term**: a lazy continuation line of Alpha's paragraph.",
        "",
        "- **List Item**: a list item, never a term anchor.",
        "",
        "> **Quoted**: a blockquote, never a term anchor.",
        "",
        "```",
        "**Fenced**: inside a fence.",
        "```",
        "",
        "**Beta**: second.",
        "",
        "**Alpha**: duplicate name takes the -1 suffix.",
      ].join("\n");
      const rendered = await renderedTermIds(source);
      assert.deepEqual(rendered, ["term-alpha", "term-beta", "term-alpha-1"]);
      const anchors = glossaryAnchors(source);
      assert.deepEqual([...anchors.entries()], [["Alpha", "term-alpha"], ["Beta", "term-beta"]], "the map keeps the FIRST occurrence and only paragraph-start bold lines");
    });

    test("the live CONTEXT.md: every anchor glossaryAnchors reports is an id the renderer emits", { skip: Marked ? false : "marked not installed" }, async () => {
      const source = readFileSync(resolve(REPO_ROOT, "CONTEXT.md"), "utf8");
      const rendered = new Set(await renderedTermIds(source));
      const dead = [...glossaryAnchors(source).entries()].filter(([, anchor]) => !rendered.has(anchor)).map(([n]) => n);
      assert.deepEqual(dead, [], `glossaryAnchors reports anchors the renderer never emits for: ${dead.join(", ")}`);
    });
  });

  test("INV-11 — the build-time parity guard (runs in the required dashboard-build job, where marked exists) throws on a dead term anchor", async () => {
    // The renderer-parity tests above skip wherever dashboard deps are not
    // installed (the required root `test` job). The same invariant is enforced
    // at dashboard build via this marked-free guard; pin its behaviour and wiring.
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    const html = '<p id="term-alpha"><strong>Alpha</strong></p><p id="term-beta">x</p>';
    const rows = [{ name: "A", terms: [{ name: "Alpha", anchor: "term-alpha" }] }];
    assert.doesNotThrow(() => core.assertTermAnchorParity(html, rows));
    assert.throws(
      () => core.assertTermAnchorParity(html, [...rows, { name: "B", terms: [{ name: "Gamma", anchor: "term-gamma" }] }]),
      /B: Gamma -> #term-gamma/,
    );
    const plugin = readFileSync(resolve(REPO_ROOT, "dashboard/vite-plugins/docs-markdown.js"), "utf8");
    const ensure = plugin.indexOf("const ensure = () =>");
    assert.ok(ensure !== -1 && plugin.indexOf("assertTermAnchorParity(html, areaRows)", ensure) !== -1, "ensure() must call the guard after createRenderer");
  });

  test("INV-16 — the Areas grid early-returns the unavailable frame before touching areas.rows", () => {
    const src = readFileSync(resolve(REPO_ROOT, "dashboard/src/pages/docs/Areas.jsx"), "utf8");
    const start = src.indexOf("export function AreasGrid");
    const guard = src.indexOf("if (!areas.ok)", start);
    const firstRows = src.indexOf("areas.rows", start);
    assert.ok(guard !== -1, "AreasGrid must guard on !areas.ok");
    assert.ok(guard < firstRows, "the !areas.ok guard must precede the first areas.rows access");
  });
});
