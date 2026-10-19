/**
 * The ONE CONTEXT-MAP.md parser (issue #4596, INV-1).
 *
 * `normaliseArea` + `parseContextMapAreas` moved here VERBATIM from
 * test/adr-roster.test.mts, which now imports them — the
 * `{tables, rows: [{area, adrs}]}` projection and its semantics are the
 * adr-area baseline's contract and must not drift. The rich projection below
 * (`parseContextMapRows`) is a SUPERSET of that projection: same table scan,
 * same first-cell normalisation, plus the columns the areas family joins on
 * (paths, retired, terms, module map, reference docs).
 *
 * Pure text in / structured rows out — the rules are pinned on injected
 * markdown. Reading CONTEXT-MAP.md (and failing loud on live-tree drift) is
 * `areas.ts`'s job; {@link readContextMap} is that one filesystem read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One routing row of the ADR-area projection (the adr-roster baseline shape). */
export interface ContextMapAreaRow {
  area: string;
  adrs: string[];
}

/** Strip the markdown a `CONTEXT-MAP` area cell wraps its path in. */
export function normaliseArea(cell: string): string {
  return cell
    .replace(/~~/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every routing row in `CONTEXT-MAP.md` that carries a "Relevant ADRs" column.
 *
 * Generic over the table shape on purpose — the domain-map table has four
 * columns and the non-`src/` table has two, so the column index is read off
 * each header rather than hardcoded. A table that loses the column simply stops
 * being parsed, which is why the caller asserts on the table count.
 */
export function parseContextMapAreas(markdown: string): { tables: number; rows: ContextMapAreaRow[] } {
  const lines = markdown.split("\n");
  const rows: ContextMapAreaRow[] = [];
  let tables = 0;
  let adrColumn = -1;

  const cells = (line: string): string[] =>
    line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|");

  for (const line of lines) {
    if (!line.trim().startsWith("|")) {
      adrColumn = -1;
      continue;
    }
    const parts = cells(line);
    // Header row: the one naming the ADR column.
    const header = parts.findIndex((c) => /relevant adrs/i.test(c));
    if (header !== -1) {
      adrColumn = header;
      tables++;
      continue;
    }
    if (adrColumn === -1) continue;
    if (/^[\s|:-]+$/.test(line)) continue; // `|---|---|` separator
    if (parts.length <= adrColumn) continue;

    const area = normaliseArea(parts[0]);
    if (!area) continue;
    const adrs = [...parts[adrColumn].matchAll(/ADR-(\d{4})/g)].map((m) => m[1]);
    rows.push({ area, adrs: [...new Set(adrs)].sort() });
  }
  return { tables, rows };
}

// ---------------------------------------------------------------------------
// The rich projection (areas family, #4596)
// ---------------------------------------------------------------------------

/** One reference-doc link from a Reference docs cell: target plus optional anchor. */
export interface ReferenceDocLink {
  /** Repo-relative path, leading "./" stripped. */
  path: string;
  /** The `#anchor` fragment (heading slug), or null when the link targets the file. */
  anchor: string | null;
}

/** One CONTEXT-MAP row parsed at full richness — a superset of {@link ContextMapAreaRow}. */
export interface ParsedContextMapRow {
  /** Normalised first cell — byte-for-byte the projection's `area` key. */
  name: string;
  /** 'domain' for the first table, 'infra' for every later one. */
  table: "domain" | "infra";
  /** Code spans in the first cell that contain a '/' (INV-5 area code paths). */
  paths: string[];
  /** The row is struck through (`~~`) in the first cell — a retired area tombstone. */
  retired: boolean;
  /** Glossary-terms cell, raw (INV-10: retired rows keep it verbatim). */
  termsCell: string;
  /** Module-map cell, raw; '—'/empty when the area has no module map. */
  moduleMapCell: string;
  /** ADR-NNNN numbers of the Relevant ADRs cell in CELL ORDER (deduped, first-seen). */
  adrs: string[];
  /** Reference docs links, in cell order. */
  referenceDocs: ReferenceDocLink[];
  /** 1-based line of the row in CONTEXT-MAP.md. */
  line: number;
}

/**
 * Parse a glossary-terms cell into term names (INV-10): split on ',', strip
 * `~~` / `**` / `` ` `` decorations and links, strip ONE trailing
 * parenthetical. '—'-led or empty cells yield no terms.
 */
export function parseTermsCell(cell: string): string[] {
  const trimmed = cell.trim();
  if (!trimmed || trimmed.startsWith("—")) return [];
  return trimmed
    .split(",")
    .map((raw) =>
      normaliseArea(raw)
        .replace(/\s*\([^()]*\)\s*$/, "")
        .trim(),
    )
    .filter((t) => t.length > 0 && t !== "—");
}

/** Normalise a Reference-docs / Module-map cell target to a repo-relative path ('./' stripped). */
function normaliseTarget(raw: string): string {
  return raw.replace(/^\.\//, "").trim();
}

/** Markdown links of a cell as {text, target}; target may carry a `#anchor`. */
function cellLinks(cell: string): { text: string; target: string }[] {
  return [...cell.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({
    text: m[1],
    target: m[2],
  }));
}

/** The module-map file a Module map cell names, repo-relative, or null (INV-7: it must sit inside the area's first code path). */
export function parseModuleMapCell(cell: string): string | null {
  const trimmed = cell.trim();
  if (!trimmed || trimmed.startsWith("—") || /^n\/a$/i.test(trimmed)) return null;
  const links = cellLinks(trimmed);
  const target = links.length > 0 ? links[0].target : (trimmed.match(/`([^`]+)`/)?.[1] ?? trimmed);
  const normalised = normaliseArea(target).replace(/#.*$/, "");
  return normalised.length > 0 ? normaliseTarget(normalised) : null;
}

/**
 * Parse EVERY row of EVERY CONTEXT-MAP table at full richness.
 *
 * Same table scan as `parseContextMapAreas`, plus the Reference docs column
 * INV-2 makes mandatory: a table whose header names Relevant ADRs but not
 * Reference docs fails loud here — a silently-skipped column would orphan the
 * area's reference docs without a trace.
 */
export function parseContextMapRows(markdown: string): { tables: number; rows: ParsedContextMapRow[] } {
  const lines = markdown.split("\n");
  const rows: ParsedContextMapRow[] = [];
  let tables = 0;
  let adrColumn = -1;
  let termsColumn = -1;
  let moduleMapColumn = -1;
  let referenceColumn = -1;

  const cells = (line: string): string[] =>
    line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) {
      adrColumn = -1;
      termsColumn = -1;
      moduleMapColumn = -1;
      referenceColumn = -1;
      continue;
    }
    const parts = cells(line);
    // Header row: the one naming the ADR column.
    const header = parts.findIndex((c) => /relevant adrs/i.test(c));
    if (header !== -1) {
      adrColumn = header;
      tables++;
      termsColumn = parts.findIndex((c) => /glossary terms/i.test(c));
      moduleMapColumn = parts.findIndex((c) => /module map/i.test(c));
      referenceColumn = parts.findIndex((c) => /reference docs/i.test(c));
      if (referenceColumn === -1) {
        throw new Error(
          `[docs-inventories] CONTEXT-MAP.md table ${tables} has no Reference docs column`,
        );
      }
      continue;
    }
    if (adrColumn === -1) continue;
    if (/^[\s|:-]+$/.test(line)) continue; // `|---|---|` separator
    if (parts.length <= adrColumn) continue;

    const name = normaliseArea(parts[0]);
    if (!name) continue;
    const adrs = [...parts[adrColumn].matchAll(/ADR-(\d{4})/g)].map((m) => m[1]);
    const referenceCell = referenceColumn !== -1 && parts.length > referenceColumn ? parts[referenceColumn] : "";
    const referenceDocs: ReferenceDocLink[] = [];
    for (const link of cellLinks(referenceCell)) {
      const hashAt = link.target.indexOf("#");
      const path = hashAt === -1 ? link.target : link.target.slice(0, hashAt);
      const anchor = hashAt === -1 ? null : link.target.slice(hashAt + 1);
      if (path.length === 0) continue;
      referenceDocs.push({ path: normaliseTarget(path), anchor });
    }
    rows.push({
      name,
      table: tables === 1 ? "domain" : "infra",
      paths: [...parts[0].matchAll(/`([^`]*\/[^`]*)`/g)].map((m) => m[1].trim()),
      retired: parts[0].includes("~~"),
      termsCell: termsColumn !== -1 && parts.length > termsColumn ? parts[termsColumn] : "",
      moduleMapCell: moduleMapColumn !== -1 && parts.length > moduleMapColumn ? parts[moduleMapColumn] : "",
      adrs: [...new Set(adrs)],
      referenceDocs,
      line: i + 1,
    });
  }
  return { tables, rows };
}

/** Read CONTEXT-MAP.md under `repoRoot` (the areas family's one filesystem read of it). */
export function readContextMap(repoRoot: string): string {
  return readFileSync(join(repoRoot, "CONTEXT-MAP.md"), "utf8");
}
