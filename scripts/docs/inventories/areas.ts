/**
 * Areas family extractor (issue #4596 — docs-epic slice 10): one row per
 * CONTEXT-MAP row, joined with every inventory family.
 *
 * This is the ONLY family that reads OTHER families' built inventories —
 * through `FamilyContext.built`, which the runner fills as it iterates the
 * registry. That is why the 'areas' entry is the LAST registry entry: a family
 * it joins that is absent from `built` is an extraction error, never a silent
 * empty slice.
 *
 * Join rules (INV-5, exactly two):
 *   - routes join iff any of the area's code paths is an element of
 *     RouteRow.areas (exact string equality; never source.path);
 *   - every other family joins by ONE declared path field — source.path by
 *     default, the row `path` for tier-paths/config/units-scripts/skills
 *     (their row's subject IS a path) and corpus — with prefix semantics: an
 *     area path ending in '/' matches p === ap || p.startsWith(ap); a file
 *     path matches by equality.
 *
 * Everything on the row is DERIVED here (INV-6): counts are
 * slices[family].length at render time, never a stored field.
 *
 * Stdlib-only (ADR-0005) except `createSlugger`, imported from
 * dashboard/vite-plugins/docs-core.js — the ONE slugger the renderer uses, so
 * a term anchor computed here cannot disagree with the id the renderer emits.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
// Type-only: no runtime edge back into the registry module.
import type { FamilyContext } from "../generate-inventories.ts";
// Plain JS, typed as any here; test/docs-page.test.mts pins docs-core's behaviour.
import { createSlugger } from "../../../dashboard/vite-plugins/docs-core.js";
import type {
  AdrRow,
  AreaRow,
  AreaTerm,
  AreasInventory,
  Inventory,
  RouteRow,
} from "./envelope.ts";
import { areaSlug, corpusRoute, corpusRowLabel } from "./corpus.ts";
import { routeRowLabel } from "./routes.ts";
import { redisKeyRowLabel } from "./redis-keys.ts";
import { streamRowLabel } from "./streams.ts";
import { schemaRowLabel } from "./schemas.ts";
import { tierPathRowLabel } from "./tier-paths.ts";
import { choreRowLabel } from "./chores.ts";
import { envVarRowLabel } from "./env-vars.ts";
import { pageRowLabel } from "./pages.ts";
import { configRowLabel } from "./config.ts";
import { ciGateRowLabel } from "./ci-gates.ts";
import { unitScriptRowLabel } from "./units-scripts.ts";
import { classRowLabel } from "./classes.ts";
import { skillRowLabel } from "./skills.ts";
import { adrRowLabel } from "./adrs.ts";
import {
  normaliseArea,
  parseContextMapRows,
  parseModuleMapCell,
  parseTermsCell,
  readContextMap,
} from "./context-map.ts";

/** Extraction errors throw with this prefix so tests and humans can tell them from I/O failures. */
function fail(message: string): never {
  throw new Error(`[docs-inventories] ${message}`);
}

/** The `name [retired]` listing shape for an areas row (#4596). */
export function areaRowLabel(row: AreaRow): string {
  return `${row.name}${row.retired ? " [retired]" : ""}`;
}

/**
 * Families whose row `path` IS the join subject (INV-5). Every other family
 * joins by `source.path` (corpus rows carry no source, so their declared
 * field is `path` too — the member file is the subject).
 */
const ROW_PATH_FAMILIES = new Set(["tier-paths", "config", "units-scripts", "skills", "corpus"]);

/** The joined families and their registry label functions, in registry order. */
const FAMILY_LABELS: ReadonlyArray<{ family: string; label: (row: never) => string }> = [
  { family: "routes", label: routeRowLabel as (row: never) => string },
  { family: "redis-keys", label: redisKeyRowLabel as (row: never) => string },
  { family: "streams", label: streamRowLabel as (row: never) => string },
  { family: "schemas", label: schemaRowLabel as (row: never) => string },
  { family: "tier-paths", label: tierPathRowLabel as (row: never) => string },
  { family: "chores", label: choreRowLabel as (row: never) => string },
  { family: "env-vars", label: envVarRowLabel as (row: never) => string },
  { family: "pages", label: pageRowLabel as (row: never) => string },
  { family: "config", label: configRowLabel as (row: never) => string },
  { family: "ci-gates", label: ciGateRowLabel as (row: never) => string },
  { family: "units-scripts", label: unitScriptRowLabel as (row: never) => string },
  { family: "classes", label: classRowLabel as (row: never) => string },
  { family: "skills", label: skillRowLabel as (row: never) => string },
  { family: "corpus", label: corpusRowLabel as (row: never) => string },
  { family: "adrs", label: adrRowLabel as (row: never) => string },
];

/** INV-5 prefix semantics: a directory path matches itself and everything under it; a file path only itself. */
export function areaPathMatches(areaPaths: string[], p: string): boolean {
  return areaPaths.some((ap) => (ap.endsWith("/") ? p === ap || p.startsWith(ap) : p === ap));
}

/** The join subject of one row of `family` (INV-5), or null when the row names no path. */
export function joinPathOf(family: string, row: unknown): string | null {
  if (family === "routes") return null; // routes join by areas membership, never a path
  const r = row as { path?: unknown; source?: { path?: unknown } };
  const p = ROW_PATH_FAMILIES.has(family) ? r.path : r.source?.path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** Which rows of `family`'s inventory join the area (INV-5). */
export function joinedRows(family: string, inventory: Inventory<unknown>, areaPaths: string[]): unknown[] {
  if (family === "routes") {
    const areaSet = new Set(areaPaths);
    return (inventory.rows as RouteRow[]).filter((r) => r.areas.some((a) => areaSet.has(a)));
  }
  return inventory.rows.filter((r) => {
    const p = joinPathOf(family, r);
    return p !== null && areaPathMatches(areaPaths, p);
  });
}

/**
 * CONTEXT.md bold-led term names (INV-11's widened rule) keyed to their term
 * anchors. Mirrors the renderer in dashboard/vite-plugins/docs-markdown.js,
 * which ids only TOP-LEVEL paragraphs led by a strong node (list items,
 * blockquotes and continuation lines never get an id): a term line here is a
 * column-0 `**X**` that STARTS a paragraph (previous line blank, a heading, a
 * fence delimiter, or the file start) outside a code fence. Every such
 * paragraph feeds the ONE slugger in document order — so a duplicated name
 * takes the renderer's `-1` suffix — while the map keeps the FIRST occurrence.
 * test/docs-areas.test.mts pins the parity against the real renderer.
 */
export function glossaryAnchors(contextSource: string): Map<string, string> {
  const slug = createSlugger();
  const out = new Map<string, string>();
  let fence = false;
  let paragraphStart = true;
  for (const line of contextSource.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fence = !fence;
      paragraphStart = true; // the line after a fence delimiter opens a new block
      continue;
    }
    if (fence) continue;
    const m = paragraphStart ? /^\*\*([^*]+)\*\*/.exec(line) : null;
    if (m) {
      const name = m[1].trim();
      const anchor = `term-${slug.slug(name)}`;
      if (!out.has(name)) out.set(name, anchor);
    }
    paragraphStart = line.trim() === "" || /^#{1,6}\s/.test(line);
  }
  return out;
}

const GENERATED_FROM = ["CONTEXT-MAP.md"];

/**
 * Build the areas inventory for `repoRoot` from the already-built families in
 * `ctx.built` (the 'areas' registry entry must be LAST — see the module doc).
 */
export function extractAreasFamily(repoRoot: string, ctx: FamilyContext): AreasInventory {
  const { tables, rows: parsed } = parseContextMapRows(readContextMap(repoRoot));
  if (tables < 2) {
    fail(`CONTEXT-MAP.md parsed ${tables} ADR-routed table(s), expected the domain + infra tables`);
  }

  // The inventories this family joins — absent = registry-order bug, fail loud (INV-4).
  const built = new Map<string, Inventory<unknown>>();
  for (const { family } of FAMILY_LABELS) {
    const inv = ctx.built.get(family);
    if (!inv) {
      fail(`areas joins family "${family}" but it is absent from FamilyContext.built — the areas entry must be the LAST registry entry`);
    }
    built.set(family, inv);
  }

  const glossary = glossaryAnchors(readFileSync(join(repoRoot, "CONTEXT.md"), "utf8"));
  const adrRows = built.get("adrs")?.rows as AdrRow[];

  const rows: AreaRow[] = [];
  const seenSlugs = new Map<string, string>();
  for (const p of parsed) {
    const slug = p.paths.length > 0 ? areaSlug(p.paths[0]) : areaSlug(p.name);
    const prior = seenSlugs.get(slug);
    if (prior !== undefined) {
      fail(`CONTEXT-MAP.md rows "${prior}" and "${p.name}" both slug to "${slug}" — area slugs must be unique`);
    }
    seenSlugs.set(slug, p.name);

    const route = p.retired ? null : `/docs/area/${slug}`;
    const moduleMap = p.retired ? null : parseModuleMapCell(p.moduleMapCell);
    if (moduleMap !== null && corpusRoute(moduleMap) !== route) {
      fail(
        `CONTEXT-MAP.md row "${p.name}" names module map ${moduleMap}, whose corpus route ` +
          `${corpusRoute(moduleMap)} !== the row's route ${route} — the map's directory must be the row's first code path`,
      );
    }

    // Terms: non-retired rows must resolve against the CONTEXT.md lex or the
    // extraction fails naming the row and the term (INV-10); retired rows keep
    // their cell verbatim, never resolved.
    let terms: AreaTerm[];
    if (p.retired) {
      const verbatim = normaliseArea(p.termsCell);
      terms = verbatim.length > 0 && verbatim !== "—" ? [{ name: verbatim, anchor: null }] : [];
    } else {
      terms = parseTermsCell(p.termsCell).map((name) => {
        const anchor = glossary.get(name);
        if (anchor === undefined) {
          fail(`CONTEXT-MAP.md row "${p.name}" names glossary term "${name}", but CONTEXT.md has no bold-led **${name}** line`);
        }
        return { name, anchor };
      });
    }

    // Slices: the registry label strings of every family's joined rows (INV-5/6).
    const slices: Record<string, string[]> = {};
    const joined = new Map<string, unknown[]>();
    for (const { family, label } of FAMILY_LABELS) {
      const rowsOfFamily = joinedRows(family, built.get(family) as Inventory<unknown>, p.paths);
      joined.set(family, rowsOfFamily);
      if (rowsOfFamily.length > 0) {
        slices[family] = rowsOfFamily.map((r) => (label as (row: unknown) => string)(r));
      }
    }

    // Derived homes: distinct non-/api homes of joined routes + redis-keys +
    // streams rows, first-seen order (INV-6) — never typed by hand.
    const homes: string[] = [];
    const seenHome = new Set<string>();
    const pushHome = (h: string | null | undefined): void => {
      if (typeof h !== "string" || h.length === 0 || h.startsWith("/api")) return;
      if (seenHome.has(h)) return;
      seenHome.add(h);
      homes.push(h);
    };
    for (const family of ["routes", "redis-keys", "streams"]) {
      for (const r of joined.get(family) ?? []) {
        const home = (r as { home?: unknown }).home;
        pushHome(typeof home === "string" ? home : null);
      }
    }

    // ADRs cited by this area's docs (module map + reference docs) minus the
    // row's own Relevant ADRs (INV-6) — adrs.json citedBy covers module maps
    // by construction once they join the corpus (#4596 INV-8).
    const docPaths = [moduleMap, ...p.referenceDocs.map((d) => d.path)].filter(
      (x): x is string => x !== null,
    );
    const adrsCited = [
      ...new Set(
        adrRows
          .filter((adr) => !p.adrs.includes(adr.number))
          .filter((adr) => docPaths.some((dp) => adr.citedBy.includes(dp)))
          .map((adr) => adr.number),
      ),
    ].sort();

    rows.push({
      slug,
      name: p.name,
      table: p.table,
      paths: p.paths,
      retired: p.retired,
      terms,
      moduleMap,
      adrs: p.adrs,
      adrsCited,
      referenceDocs: p.referenceDocs,
      slices,
      homes,
      route,
      source: { path: "CONTEXT-MAP.md", line: p.line },
    });
  }

  return { family: "areas", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}
