/**
 * schemas family extractor (issue #4594 — docs-epic 8/13, per the #4542
 * families table and ADR-0034 §10).
 *
 * One row per exported zod VALUE in src/schemas/*.ts (`export const X =`;
 * `export type` / `interface` are not rows). `importedBy` is every first-party
 * src file importing the identifier; `routes` joins each non-import use of the
 * identifier inside an importing src/api/*.ts router to the registration in
 * that file with the greatest line <= the use (nearest-preceding
 * registration, read from the routes inventory — never a second route scan).
 * A use above the file's first registration contributes no route.
 *
 * Text scan only — src/schemas/** is never imported or modified.
 * Stdlib-only (ADR-0005). Fail-loud (CLAUDE.md).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteRow, SchemaRow, SchemasInventory } from "./envelope.ts";
import { extractRoutes } from "./routes.ts";
import { byString, fail, lineOf, relativeImports, stripComments, walkFiles } from "./scan.ts";
import type { SourceFile } from "./scan.ts";

const GENERATED_FROM = ["src/schemas/*.ts", "src/**/*.ts", "docs/generated/routes.json"];

/** A route as the nearest-preceding join sees it. */
export interface SchemaJoinRoute {
  method: string;
  path: string;
  source: { path: string; line: number };
}

export interface SchemaInputs {
  /** The src/schemas/*.ts files, raw text. */
  schemaFiles: SourceFile[];
  /** Every first-party src/**\/*.ts file (importer candidates), raw text. */
  srcFiles: SourceFile[];
  routes: SchemaJoinRoute[];
}

/** Pure row-builder: injected inputs in, rows sorted by name out. */
export function buildSchemaRows(inputs: SchemaInputs): SchemaRow[] {
  const importers = inputs.srcFiles.map((f) => {
    const code = stripComments(f.src);
    return { path: f.path, code, imports: relativeImports(f.path, code) };
  });
  const regsByFile = new Map<string, SchemaJoinRoute[]>();
  for (const r of inputs.routes) {
    const list = regsByFile.get(r.source.path) ?? [];
    list.push(r);
    regsByFile.set(r.source.path, list);
  }
  for (const list of regsByFile.values()) list.sort((a, b) => a.source.line - b.source.line);

  const rows: SchemaRow[] = [];
  const seen = new Set<string>();
  for (const file of inputs.schemaFiles) {
    const code = stripComments(file.src);
    for (const m of code.matchAll(/^export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/gm)) {
      const name = m[1];
      if (seen.has(name)) fail(`${file.path}: schema export "${name}" is declared in more than one src/schemas file`);
      seen.add(name);
      const importedBy: string[] = [];
      const routes = new Set<string>();
      const useRe = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
      for (const imp of importers) {
        const stmts = imp.imports.filter((s) => s.target === file.path && s.names.includes(name));
        if (stmts.length === 0) continue;
        importedBy.push(imp.path);
        if (!/^src\/api\/[^/]+\.ts$/.test(imp.path)) continue;
        const regs = regsByFile.get(imp.path) ?? [];
        for (const use of imp.code.matchAll(useRe)) {
          const at = use.index ?? 0;
          if (imp.imports.some((s) => at >= s.start && at < s.end)) continue; // the import itself
          const line = lineOf(imp.code, at);
          let owner: SchemaJoinRoute | null = null;
          for (const reg of regs) {
            if (reg.source.line <= line) owner = reg;
            else break;
          }
          if (owner) routes.add(`${owner.method} ${owner.path}`);
        }
      }
      rows.push({
        name,
        file: file.path,
        importedBy: importedBy.sort(byString),
        routes: [...routes].sort(byString),
        source: { path: file.path, line: lineOf(code, m.index ?? 0) },
      });
    }
  }
  rows.sort((a, b) => byString(a.name, b.name));
  return rows;
}

/** The listing/sort label of a schemas row: its identifier. */
export function schemaRowLabel(row: SchemaRow): string {
  return row.name;
}

export function extractSchemas(repoRoot: string, routes?: RouteRow[]): SchemasInventory {
  const read = (path: string): SourceFile => ({ path, src: readFileSync(join(repoRoot, path), "utf8") });
  const srcFiles = walkFiles(repoRoot, "src", (n) => n.endsWith(".ts")).map(read);
  const schemaFiles = srcFiles.filter((f) => /^src\/schemas\/[^/]+\.ts$/.test(f.path));
  if (schemaFiles.length === 0) fail("src/schemas/*.ts: no schema files found");
  const rows = buildSchemaRows({ schemaFiles, srcFiles, routes: routes ?? extractRoutes(repoRoot).rows });
  return { family: "schemas", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}
