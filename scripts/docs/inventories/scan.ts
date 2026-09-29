/**
 * Shared text-scan helpers for the code-imported inventory families (issue
 * #4594 — docs-epic 8/13). NOT a family: no docs/generated file derives from
 * this module. It holds the few scanning primitives several family extractors
 * share, so the comment-stripping and directory-walking rules are defined once.
 *
 * Stdlib-only (ADR-0005).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Extraction errors throw with this prefix so tests and humans can tell them from I/O failures. */
export function fail(message: string): never {
  throw new Error(`[docs-inventories] ${message}`);
}

/** 1-based line number of the character at `index` in `src`. */
export function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) {
    if (src.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Replace every non-newline character of `text` with a space (keeps offsets + line numbers). */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * Strip comments while preserving offsets and line numbers:
 *   - `/* … *\/` blocks that open at a line start, after whitespace, or after
 *     a punctuation boundary — so a glob inside a string (`"src/*"`) is not
 *     mistaken for a comment opener;
 *   - whole-line `//` comments (a trailing `// …` after code is kept, per the
 *     ratified recipe).
 * Comment text is blanked, never removed, so `lineOf` on the stripped text
 * equals `lineOf` on the original.
 */
export function stripComments(src: string): string {
  const noBlocks = src.replace(/(^|[\s;,(){}[\]=])(\/\*[\s\S]*?\*\/)/g, (_m, lead: string, body: string) => lead + blank(body));
  return noBlocks.replace(/^([ \t]*)(\/\/.*)$/gm, (_m, lead: string, body: string) => lead + blank(body));
}

/** A scanned source file: repo-relative path + raw text. */
export interface SourceFile {
  path: string;
  src: string;
}

/** Directories no scan ever descends into. */
const SKIP_DIRS = new Set(["node_modules", "dist", "worktrees"]);

/**
 * Walk `<repoRoot>/<dir>` recursively and return repo-relative forward-slash
 * paths of files whose name passes `accept`, sorted. Dot-directories,
 * node_modules, dist and worktrees are never entered, so a run from the main
 * checkout never picks up nested worktree copies. A missing root yields [].
 */
export function walkFiles(repoRoot: string, dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  const rootAbs = join(repoRoot, dir);
  if (!existsSync(rootAbs)) return out;
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(abs, entry.name), childRel);
      } else if (entry.isFile() && accept(entry.name)) {
        out.push(childRel);
      }
    }
  };
  walk(rootAbs, dir);
  return out.sort();
}

/** Resolve a relative import specifier against its importer into a repo-relative path. */
export function resolveRelative(importerRel: string, spec: string): string {
  const i = importerRel.lastIndexOf("/");
  const dirRel = i === -1 ? "" : importerRel.slice(0, i);
  const stack: string[] = [];
  for (const part of (dirRel === "" ? [] : dirRel.split("/")).concat(spec.split("/"))) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

/** One `import … from "<relative>"` statement: the imported names, target, and offset span. */
export interface ImportStatement {
  /** Local-side names in the clause (`{ A, B as C }` → A and B; default/namespace names too). */
  names: string[];
  /** Repo-relative resolved target (relative specifiers only). */
  target: string;
  start: number;
  end: number;
}

/** Every relative-specifier import statement in `src` (which should be comment-stripped). */
export function relativeImports(importerRel: string, src: string): ImportStatement[] {
  const out: ImportStatement[] = [];
  for (const m of src.matchAll(/\bimport\s+(?:type\s+)?([^;]*?)\s+from\s+["'](\.[^"']+)["']\s*;?/g)) {
    const clause = m[1];
    const names: string[] = [];
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const part of braced[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
        if (name) names.push(name);
      }
    }
    const outside = braced ? clause.replace(braced[0], "") : clause;
    for (const n of outside.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (n !== "type" && n !== "as") names.push(n);
    }
    const start = m.index ?? 0;
    out.push({ names, target: resolveRelative(importerRel, m[2]), start, end: start + m[0].length });
  }
  return out;
}

/** Deterministic string sort (code-unit order, never locale-dependent). */
export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A route row as the home join sees it (a routes.json row or the in-memory equivalent). */
export interface JoinRoute {
  method: string;
  path: string;
  home: string;
  source: { path: string };
}

/**
 * The FILE-level home join (#4594): `servedBy` = the sorted `METHOD /api/path`
 * labels of every route registered in one of `servingFiles`; `home` = the home
 * of the first of those routes by label, or null when nothing serves it —
 * never a guessed page. Joins through routes rows, never a second route scan.
 */
export function serveJoin(routes: JoinRoute[], servingFiles: Set<string>): { servedBy: string[]; home: string | null } {
  const served = routes
    .filter((r) => servingFiles.has(r.source.path))
    .map((r) => ({ label: `${r.method} ${r.path}`, home: r.home }))
    .sort((a, b) => byString(a.label, b.label));
  const servedBy = [...new Set(served.map((s) => s.label))];
  return { servedBy, home: served.length > 0 ? served[0].home : null };
}
