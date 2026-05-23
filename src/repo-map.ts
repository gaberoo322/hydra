/**
 * repo-map.ts — Regex-based TypeScript parser for exported symbols and import edges.
 *
 * Builds an adjacency graph (file A imports file B) from .ts/.tsx source files.
 * Zero runtime dependencies — regex only.
 *
 * Also provides a cached project-level entry point: `generateRepoMap()` reads
 * the file tree, builds the graph, and formats scope-aware context. Results are
 * cached per file-tree hash so repeated calls within the same grounding cycle
 * (unchanged project) are free.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SymbolDetail {
  /** For functions: parameter count */
  arity?: number;
  /** For interfaces/types: top-level field names (first 5) */
  fields?: string[];
  /** For classes: method names */
  methods?: string[];
}

export interface ExportedSymbol {
  name: string;
  kind: "function" | "class" | "const" | "let" | "var" | "type" | "interface" | "enum" | "default" | "re-export";
  detail?: SymbolDetail;
}

export interface ImportEdge {
  source: string; // the raw module specifier, e.g. './foo' or 'express'
  symbols: string[]; // imported names (empty for side-effect imports)
}

export interface ImportGraph {
  /** file path -> exported symbols */
  exports: Map<string, ExportedSymbol[]>;
  /** file path -> list of file paths it imports (resolved to keys in the map) */
  edges: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// parseExports
// ---------------------------------------------------------------------------

/**
 * Extract exported symbols from TypeScript source using regex.
 *
 * Handles:
 *   export function NAME
 *   export async function NAME
 *   export class NAME
 *   export const/let/var NAME
 *   export type NAME
 *   export interface NAME
 *   export enum NAME
 *   export default (function/class/expression)
 *   export { X, Y }           (named re-exports from local)
 *   export { X, Y } from '…' (re-exports from another module)
 */
export function parseExports(source: string): ExportedSymbol[] {
  const results: ExportedSymbol[] = [];
  const seen = new Set<string>();

  const add = (name: string, kind: ExportedSymbol["kind"], detail?: SymbolDetail) => {
    const key = `${kind}:${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(detail ? { name, kind, detail } : { name, kind });
    }
  };

  // export [async] function/class/const/let/var/type/interface/enum NAME
  const declRe = /\bexport\s+(?:async\s+)?(?:function\*?\s+|class\s+|const\s+|let\s+|var\s+|type\s+|interface\s+|enum\s+)(\w+)/g;
  const kindMap: Record<string, ExportedSymbol["kind"]> = {
    function: "function",
    class: "class",
    const: "const",
    let: "let",
    var: "var",
    type: "type",
    interface: "interface",
    enum: "enum",
  };

  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    // Determine kind from the match text
    const text = m[0];
    let kind: ExportedSymbol["kind"] = "const";
    for (const [kw, k] of Object.entries(kindMap)) {
      // Match the keyword before the symbol name
      if (new RegExp(`\\b${kw}\\b`).test(text)) {
        kind = k;
        break;
      }
    }

    let detail: SymbolDetail | undefined;
    const afterMatch = source.slice(m.index + m[0].length);

    if (kind === "function") {
      detail = { arity: extractArity(afterMatch) };
    } else if (kind === "interface" || kind === "type") {
      const fields = extractFields(afterMatch, kind);
      if (fields.length > 0) detail = { fields };
    } else if (kind === "class") {
      const methods = extractClassMethods(afterMatch);
      if (methods.length > 0) detail = { methods };
    }

    add(m[1], kind, detail);
  }

  // export default — capture optional name
  const defaultRe = /\bexport\s+default\s+(?:(?:async\s+)?function\*?\s+(\w+)|class\s+(\w+)|(\w+))/g;
  while ((m = defaultRe.exec(source)) !== null) {
    const name = m[1] ?? m[2] ?? m[3] ?? "default";
    add(name, "default");
  }

  // export { X, Y } and export { X, Y } from '…'
  const namedRe = /\bexport\s*\{([^}]+)\}(?:\s*from\s*['"][^'"]+['"])?/g;
  while ((m = namedRe.exec(source)) !== null) {
    const hasFrom = /from\s*['"]/.test(m[0]);
    const kind: ExportedSymbol["kind"] = hasFrom ? "re-export" : "const";
    const names = m[1].split(",").map((s) => {
      // handle `X as Y` — the exported name is Y
      const parts = s.trim().split(/\s+as\s+/);
      return parts[parts.length - 1].trim();
    });
    for (const n of names) {
      if (n) add(n, kind);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// parseImports
// ---------------------------------------------------------------------------

/**
 * Extract import edges from TypeScript source using regex.
 *
 * Handles:
 *   import X from '…'
 *   import { X, Y } from '…'
 *   import * as X from '…'
 *   import '…'                (side-effect)
 *   export { X } from '…'    (re-export)
 */
export function parseImports(source: string): ImportEdge[] {
  const results: ImportEdge[] = [];

  // Standard imports: import … from '…'
  const importRe = /\bimport\s+(?:(?:type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))(?:\s*,\s*(?:\{([^}]*)\}|(\*\s+as\s+\w+)))?)\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    const src = m[6];
    const symbols: string[] = [];

    // Named imports { X, Y }
    if (m[1]) {
      for (const s of m[1].split(",")) {
        const parts = s.trim().split(/\s+as\s+/);
        const name = parts[parts.length - 1].trim();
        if (name) symbols.push(name);
      }
    }
    // Namespace import * as X
    if (m[2]) {
      const name = m[2].replace(/\*\s+as\s+/, "").trim();
      if (name) symbols.push(name);
    }
    // Default import X
    if (m[3]) symbols.push(m[3]);
    // Additional named imports after default: import X, { Y }
    if (m[4]) {
      for (const s of m[4].split(",")) {
        const parts = s.trim().split(/\s+as\s+/);
        const name = parts[parts.length - 1].trim();
        if (name) symbols.push(name);
      }
    }
    // Additional namespace after default
    if (m[5]) {
      const name = m[5].replace(/\*\s+as\s+/, "").trim();
      if (name) symbols.push(name);
    }

    results.push({ source: src, symbols });
  }

  // Side-effect imports: import '…'
  const sideEffectRe = /\bimport\s+['"]([^'"]+)['"]/g;
  while ((m = sideEffectRe.exec(source)) !== null) {
    // Avoid matching imports already captured above (they have `from`)
    // Side-effect imports have no `from` keyword — they're just import 'path'
    results.push({ source: m[1], symbols: [] });
  }

  // Re-exports: export { … } from '…'
  const reExportRe = /\bexport\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = reExportRe.exec(source)) !== null) {
    const symbols: string[] = [];
    for (const s of m[1].split(",")) {
      const parts = s.trim().split(/\s+as\s+/);
      const name = parts[0].trim(); // original name from source module
      if (name) symbols.push(name);
    }
    results.push({ source: m[2], symbols });
  }

  // export * from '…'
  const exportStarRe = /\bexport\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = exportStarRe.exec(source)) !== null) {
    results.push({ source: m[1], symbols: [] });
  }

  return results;
}

// ---------------------------------------------------------------------------
// buildImportGraph
// ---------------------------------------------------------------------------

/**
 * Build an import graph from a map of file paths to source code.
 *
 * Resolves relative import specifiers (./foo, ../bar) against the importing
 * file's directory. Tries .ts, .tsx, and /index.ts extensions. Non-relative
 * imports (packages) are ignored for edge construction.
 */
export function buildImportGraph(files: Map<string, string>): ImportGraph {
  const fileSet = new Set(files.keys());
  const exportsMap = new Map<string, ExportedSymbol[]>();
  const edges = new Map<string, string[]>();

  for (const [filePath, source] of files) {
    exportsMap.set(filePath, parseExports(source));

    const imports = parseImports(source);
    const targets: string[] = [];

    for (const imp of imports) {
      // Only resolve relative imports
      if (!imp.source.startsWith(".")) continue;

      const resolved = resolveRelative(filePath, imp.source, fileSet);
      if (resolved) {
        targets.push(resolved);
      }
    }

    // Deduplicate
    edges.set(filePath, [...new Set(targets)]);
  }

  return { exports: exportsMap, edges };
}

// ---------------------------------------------------------------------------
// PageRank-style scoring
// ---------------------------------------------------------------------------

/**
 * Compute iterative weighted in-degree scores over the import graph.
 *
 * Simplified PageRank: each file distributes its score equally to its imports.
 * After `iterations` rounds the scores converge to reflect transitive
 * importance — files imported (directly or indirectly) by many others score
 * higher.
 *
 * @param graph  - The import graph produced by buildImportGraph()
 * @param iterations - Number of scoring iterations (default 10)
 * @param damping    - Damping factor (default 0.85, same as classic PageRank)
 * @returns Map of file path -> score (higher = more central)
 */
export function computePageRank(
  graph: ImportGraph,
  iterations = 10,
  damping = 0.85,
): Map<string, number> {
  const files = [...graph.edges.keys()];
  const n = files.length;
  if (n === 0) return new Map();

  const scores = new Map<string, number>();
  const base = 1 / n;
  for (const f of files) scores.set(f, base);

  // Build reverse edges (who imports me?)
  const reverseEdges = new Map<string, string[]>();
  for (const f of files) reverseEdges.set(f, []);
  for (const [src, targets] of graph.edges) {
    for (const tgt of targets) {
      reverseEdges.get(tgt)?.push(src);
    }
  }

  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    for (const f of files) {
      let incoming = 0;
      for (const src of reverseEdges.get(f) ?? []) {
        const outDegree = graph.edges.get(src)?.length ?? 1;
        incoming += (scores.get(src) ?? 0) / outDegree;
      }
      next.set(f, (1 - damping) / n + damping * incoming);
    }
    for (const [k, v] of next) scores.set(k, v);
  }

  return scores;
}

// ---------------------------------------------------------------------------
// Test-file detection
// ---------------------------------------------------------------------------

const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[tj]sx?$/;

/**
 * Returns true if the file path matches common test-file naming conventions:
 * *.test.ts, *.test.mts, *.spec.ts, etc.
 */
export function isTestFile(filePath: string): boolean {
  return TEST_FILE_RE.test(filePath);
}

/**
 * For each scope file, find the closest test file by filename heuristic.
 *
 * Heuristic: given `src/foo.ts`, look for files matching `foo.test.ts`,
 * `foo.test.mts`, `foo.spec.ts` anywhere in the graph's file set.
 * Also checks import edges: if a test file imports a scope file, it's
 * considered an affinity match.
 *
 * @returns Set of test file paths that have affinity with the scope files
 */
export function findTestFileAffinity(
  graph: ImportGraph,
  scopeFiles: string[],
): Set<string> {
  const allFiles = new Set(graph.edges.keys());
  const result = new Set<string>();

  // 1. Filename heuristic: foo.ts -> foo.test.ts, foo.test.mts, foo.spec.ts
  for (const scopeFile of scopeFiles) {
    // Strip extension to get the base name stem
    const stem = scopeFile.replace(/\.[cm]?[tj]sx?$/, "");
    for (const candidate of allFiles) {
      if (!isTestFile(candidate)) continue;
      const candidateStem = candidate.replace(/\.(?:test|spec)\.[cm]?[tj]sx?$/, "");
      if (candidateStem === stem) {
        result.add(candidate);
      }
    }
  }

  // 2. Import-edge heuristic: test files that import any scope file
  const scopeSet = new Set(scopeFiles);
  for (const [file, targets] of graph.edges) {
    if (!isTestFile(file)) continue;
    for (const tgt of targets) {
      if (scopeSet.has(tgt)) {
        result.add(file);
        break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scope-aware selection
// ---------------------------------------------------------------------------

/**
 * Given a set of scope files (e.g. from scopeBoundary.in), BFS outward
 * through the import graph to find the top-N most relevant neighbor files.
 *
 * Relevance = PageRank score, but only for files reachable within `maxDepth`
 * hops from the scope set (via both incoming and outgoing edges).
 *
 * Test files are detected and marked with `isTest: true` in the result.
 * Additionally, test files with filename affinity to scope files (e.g.
 * foo.ts -> foo.test.ts) are injected even if they fall outside the BFS
 * frontier, so the executor always sees related test files.
 *
 * @param graph      - The import graph
 * @param scopeFiles - Files that are in-scope for the current task
 * @param topN       - Maximum number of neighbors to return (default 15)
 * @param maxDepth   - BFS depth limit (default 2)
 * @returns Sorted array of { file, score, isTest } for the top-N relevant neighbors
 */
export function selectScopeNeighbors(
  graph: ImportGraph,
  scopeFiles: string[],
  topN = 15,
  maxDepth = 2,
): { file: string; score: number; isTest: boolean }[] {
  const scores = computePageRank(graph);
  const scopeSet = new Set(scopeFiles);

  // Build undirected adjacency for BFS (import edge = connection either way)
  const adj = new Map<string, Set<string>>();
  for (const f of graph.edges.keys()) adj.set(f, new Set());
  for (const [src, targets] of graph.edges) {
    for (const tgt of targets) {
      adj.get(src)?.add(tgt);
      adj.get(tgt)?.add(src);
    }
  }

  // BFS from scope files
  const visited = new Set<string>();
  let frontier = new Set<string>();
  for (const f of scopeFiles) {
    if (graph.edges.has(f)) {
      visited.add(f);
      frontier.add(f);
    }
  }

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextFrontier = new Set<string>();
    for (const f of frontier) {
      for (const neighbor of adj.get(f) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          nextFrontier.add(neighbor);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Filter to neighbors only (exclude scope files themselves)
  const neighbors = [...visited].filter((f) => !scopeSet.has(f));

  // Inject affinity test files that may be outside the BFS frontier
  const affinityTests = findTestFileAffinity(graph, scopeFiles);
  for (const testFile of affinityTests) {
    if (!scopeSet.has(testFile) && !neighbors.includes(testFile)) {
      neighbors.push(testFile);
    }
  }

  // Sort by score descending, take top N
  neighbors.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  return neighbors.slice(0, topN).map((f) => ({
    file: f,
    score: scores.get(f) ?? 0,
    isTest: isTestFile(f),
  }));
}

// ---------------------------------------------------------------------------
// Blast radius warnings for high-centrality scope files
// ---------------------------------------------------------------------------

/**
 * Identify scope files in the top 10% by PageRank and produce warning lines.
 *
 * For each high-centrality scope file, returns a warning string:
 *   ⚠ scanner.ts is imported by N files — changes here have wide blast radius
 *
 * @param graph      - The import graph
 * @param scopeFiles - Files in-scope for the current task
 * @param percentile - Top percentile threshold (default 0.10 = top 10%)
 * @returns Array of warning strings (empty if no scope file is high-centrality)
 */
export function computeBlastRadiusWarnings(
  graph: ImportGraph,
  scopeFiles: string[],
  percentile = 0.10,
): string[] {
  const scores = computePageRank(graph);
  if (scores.size === 0) return [];

  // Determine the percentile threshold score
  const allScores = [...scores.values()].sort((a, b) => b - a);
  const thresholdIndex = Math.max(0, Math.ceil(allScores.length * percentile) - 1);
  const thresholdScore = allScores[thresholdIndex];

  // Build in-degree count (direct importers)
  const importedByCount = new Map<string, number>();
  for (const [, targets] of graph.edges) {
    for (const tgt of targets) {
      importedByCount.set(tgt, (importedByCount.get(tgt) ?? 0) + 1);
    }
  }

  const warnings: string[] = [];
  for (const file of scopeFiles) {
    const score = scores.get(file);
    if (score !== undefined && score >= thresholdScore) {
      const importers = importedByCount.get(file) ?? 0;
      if (importers > 0) {
        warnings.push(
          `\u26A0 ${file} is imported by ${importers} files \u2014 changes here have wide blast radius`,
        );
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Token-budgeted formatting
// ---------------------------------------------------------------------------

/**
 * Format the repo map as a compact, human-readable string within a token budget.
 *
 * Output format per line: `file — exportName (imported by N files)`
 * For scope files, symbol detail is shown as indented sub-items:
 *   `  fn symbolName(arity)`
 *   `  fields: a, b, c`
 *   `  methods: x, y, z`
 *
 * Estimates ~4 chars per token (conservative). Stops adding lines when the
 * budget would be exceeded.
 *
 * @param graph       - The import graph
 * @param rankedFiles - Ordered list of files to include (from selectScopeNeighbors or PageRank).
 *                      If entries have `isTest: true`, they are prefixed with `[TEST]`.
 * @param tokenBudget - Maximum approximate tokens (default 2000)
 * @param scopeFiles  - Files that are in-scope (symbol detail shown only for these)
 * @returns Formatted string fitting within the token budget
 */
export function formatRepoMap(
  graph: ImportGraph,
  rankedFiles: { file: string; score: number; isTest?: boolean }[],
  tokenBudget = 2000,
  scopeFiles?: string[],
): string {
  // Build in-degree count: how many files import each file?
  const importedByCount = new Map<string, number>();
  for (const [, targets] of graph.edges) {
    for (const tgt of targets) {
      importedByCount.set(tgt, (importedByCount.get(tgt) ?? 0) + 1);
    }
  }

  const scopeSet = scopeFiles ? new Set(scopeFiles) : new Set<string>();
  const charsPerToken = 4;
  const charBudget = tokenBudget * charsPerToken;
  let totalChars = 0;
  const lines: string[] = [];

  for (const entry of rankedFiles) {
    const { file } = entry;
    const exports = graph.exports.get(file) ?? [];
    const importers = importedByCount.get(file) ?? 0;

    // Pick the most representative export name (first non-re-export, or first)
    const mainExport =
      exports.find((e) => e.kind !== "re-export") ?? exports[0];
    const exportLabel = mainExport
      ? mainExport.name
      : "(no exports)";

    // Determine test-file status: explicit flag, or fall back to filename detection
    const testMarker = (entry.isTest ?? isTestFile(file)) ? "[TEST] " : "";

    const line = `${testMarker}${file} — ${exportLabel} (imported by ${importers} files)`;
    let blockChars = line.length + 1; // +1 for newline

    // Build symbol detail lines for scope files
    const detailLines: string[] = [];
    if (scopeSet.has(file)) {
      for (const exp of exports) {
        if (!exp.detail) continue;
        if (exp.detail.arity !== undefined && (exp.kind === "function" || exp.kind === "default")) {
          const dl = `  fn ${exp.name}(${exp.detail.arity})`;
          detailLines.push(dl);
          blockChars += dl.length + 1;
        }
        if (exp.detail.fields && exp.detail.fields.length > 0) {
          const dl = `  ${exp.name} fields: ${exp.detail.fields.join(", ")}`;
          detailLines.push(dl);
          blockChars += dl.length + 1;
        }
        if (exp.detail.methods && exp.detail.methods.length > 0) {
          const dl = `  ${exp.name} methods: ${exp.detail.methods.join(", ")}`;
          detailLines.push(dl);
          blockChars += dl.length + 1;
        }
      }
    }

    if (totalChars + blockChars > charBudget && lines.length > 0) break;
    lines.push(line);
    for (const dl of detailLines) lines.push(dl);
    totalChars += blockChars;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Symbol detail extraction helpers (regex-only)
// ---------------------------------------------------------------------------

/**
 * Count parameters in a function's parameter list.
 * Expects `afterMatch` to start right after the function name.
 * Finds the first `(...)` and counts comma-separated params, ignoring
 * commas inside nested parens/brackets/braces.
 */
function extractArity(afterMatch: string): number {
  const parenStart = afterMatch.indexOf("(");
  if (parenStart === -1) return 0;

  let depth = 0;
  let count = 0;
  let hasContent = false;

  for (let i = parenStart; i < afterMatch.length; i++) {
    const ch = afterMatch[i];
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      depth--;
      if (depth === 0) break; // end of param list
    } else if (depth === 1) {
      if (ch === ",") {
        count++;
      } else if (!hasContent && /\S/.test(ch)) {
        hasContent = true;
      }
    }
  }

  return hasContent ? count + 1 : 0;
}

/**
 * Extract top-level field names from an interface or type body (first 5).
 * For interfaces: looks for `{ fieldName: ... ; ... }`.
 * For types: looks for `= { fieldName: ... ; ... }`.
 */
function extractFields(afterMatch: string, kind: "interface" | "type"): string[] {
  // Find the opening brace
  let startSearch = afterMatch;
  if (kind === "type") {
    // Type alias: skip past the `=` to find `{`
    const eqIdx = afterMatch.indexOf("=");
    if (eqIdx === -1) return [];
    startSearch = afterMatch.slice(eqIdx + 1);
  }

  const braceIdx = startSearch.indexOf("{");
  if (braceIdx === -1) return [];

  // Extract the body between balanced braces (depth 1 only)
  const fields: string[] = [];
  const seen = new Set<string>();
  let depth = 0;

  for (let i = braceIdx; i < startSearch.length && fields.length < 5; i++) {
    const ch = startSearch[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }

    // At depth 1, look for field names after statement boundaries
    if (depth === 1 && (ch === "{" || ch === ";" || ch === "\n")) {
      const rest = startSearch.slice(i + 1);
      const fieldMatch = rest.match(/^\s*(?:readonly\s+)?(\w+)\s*\??:/);
      if (fieldMatch && !seen.has(fieldMatch[1])) {
        seen.add(fieldMatch[1]);
        fields.push(fieldMatch[1]);
      }
    }
  }

  return fields;
}

/**
 * Extract method names from a class body.
 * Matches: public/private/protected, static, async, get/set, plus the method name
 * followed by `(`. Only captures names at depth 1 (top-level class body).
 */
function extractClassMethods(afterMatch: string): string[] {
  const braceIdx = afterMatch.indexOf("{");
  if (braceIdx === -1) return [];

  const methods: string[] = [];
  const seen = new Set<string>();
  let depth = 0;

  for (let i = braceIdx; i < afterMatch.length; i++) {
    const ch = afterMatch[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }

    // At depth 1, look for method declarations
    if (depth === 1 && (ch === "{" || ch === ";" || ch === "\n" || ch === "}")) {
      const rest = afterMatch.slice(i + 1);
      // Match method-like patterns: optional modifiers, then identifier, then (
      const methodMatch = rest.match(
        /^\s*(?:(?:public|private|protected|static|async|get|set|override|abstract)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/,
      );
      if (methodMatch) {
        const name = methodMatch[1];
        // Skip constructor and common non-method keywords
        if (name !== "constructor" && name !== "if" && name !== "for" && name !== "while" && name !== "switch" && !seen.has(name)) {
          seen.add(name);
          methods.push(name);
        }
      }
    }
  }

  return methods;
}

// ---------------------------------------------------------------------------
// Anchor-keyed file lookup (planner-prompt scoping — issue #366)
// ---------------------------------------------------------------------------

/**
 * Split an arbitrary string into lowercase tokens of length >= 3. Splits on
 * any non-alphanumeric run (so "kalshi-price-format.ts", "src/foo/bar.ts" and
 * "feed planner scoped tree" all yield clean word tokens). Stop tokens are
 * filtered out so generic words like "the", "and", "for", "ts", "test" don't
 * cause the matcher to fire on every file in the tree.
 *
 * Pure / deterministic — exported for unit tests so the tokenisation contract
 * is locked.
 */
export function tokenizeAnchorReference(reference: string): string[] {
  if (typeof reference !== "string" || reference.length === 0) return [];
  const STOP = new Set([
    "the", "and", "for", "with", "from", "this", "that", "into", "onto",
    "out", "off", "but", "not", "all", "any", "use", "let", "src", "lib",
    "ts", "tsx", "mts", "js", "jsx", "test", "tests", "spec", "specs",
    "index", "main", "type", "types", "util", "utils", "helper", "helpers",
    "file", "files", "code", "fix", "fixes", "add", "remove", "update",
  ]);
  return [...new Set(
    reference
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  )];
}

/**
 * Score a file path against a set of lowercase anchor tokens. Returns 0 if no
 * token matches. Scoring rewards:
 *   - directory-prefix matches (token appears as a /-separated path segment): +3
 *   - filename-stem substring matches: +2
 *   - any other path substring match: +1
 *
 * Score scales linearly with the number of distinct matching tokens so a path
 * that hits two tokens always outranks one that hits one, regardless of which
 * bucket each hit lands in.
 */
export function scoreFileAgainstTokens(filePath: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = filePath.toLowerCase();
  const segments = new Set(lower.split(/[\/\\.]/).filter(Boolean));
  // Strip extensions to get a normalised stem set: "foo.test.ts" → "foo"
  const stem = lower
    .replace(/^.*\//, "")
    .replace(/\.(test|spec)\.[cm]?[tj]sx?$/, "")
    .replace(/\.[cm]?[tj]sx?$/, "");
  let score = 0;
  for (const tok of tokens) {
    if (segments.has(tok)) {
      score += 3;
      continue;
    }
    if (stem.includes(tok)) {
      score += 2;
      continue;
    }
    if (lower.includes(tok)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Find the files in `fileTreeLines` most relevant to `anchorReference` using
 * cheap heuristics (token overlap + directory prefix). Returns an array of
 * paths sorted by relevance score descending, ties broken by:
 *   1. path length ascending (shorter = more likely to be the canonical module)
 *   2. lexicographic order
 *
 * Pairs implementation files with their test counterparts: for every selected
 * `.ts`/`.tsx` non-test file, if a sibling `*.test.*` or `*.spec.*` file is
 * present in the tree, the test file is forced into the result set (consuming
 * a slot from `limit`). This matches the planner's mental model — modify a
 * file, modify its tests — and keeps the prompt useful for test-anchored work.
 *
 * Returns an empty array when the anchor reference has no recognizable tokens
 * (e.g. doc anchors like "ADR-0004"). Callers should treat empty results as
 * a signal to omit the scoped file tree from the prompt entirely.
 *
 * @param anchorReference - The anchor.reference string (e.g.
 *   "reframe:execution-cost" or "kalshi-price-format implementation")
 * @param fileTreeLines   - Lines of `git ls-files` output (one path per line)
 * @param limit           - Max files to return (default 50)
 */
export function findRelatedFiles(
  anchorReference: string,
  fileTreeLines: string[],
  limit = 50,
): string[] {
  const tokens = tokenizeAnchorReference(anchorReference);
  if (tokens.length === 0) return [];
  if (fileTreeLines.length === 0) return [];

  type Scored = { path: string; score: number; isTest: boolean };
  const scored: Scored[] = [];
  for (const rawPath of fileTreeLines) {
    const path = rawPath.trim();
    if (!path) continue;
    const score = scoreFileAgainstTokens(path, tokens);
    if (score > 0) {
      scored.push({ path, score, isTest: isTestFile(path) });
    }
  }
  if (scored.length === 0) return [];

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  });

  // Force-pair implementation files with their nearest test file. Walk the
  // sorted list, accumulate up to `limit` paths, and for each non-test impl
  // path remember the matching test path (if it exists anywhere in the tree).
  const fileSet = new Set(fileTreeLines.map((l) => l.trim()).filter(Boolean));
  const selected: string[] = [];
  const seen = new Set<string>();

  const addPath = (p: string) => {
    if (!seen.has(p) && selected.length < limit) {
      seen.add(p);
      selected.push(p);
    }
  };

  for (const entry of scored) {
    addPath(entry.path);
    if (selected.length >= limit) break;

    // Pair impl → test (only when scoring an impl file).
    if (!entry.isTest && /\.[cm]?[tj]sx?$/.test(entry.path)) {
      const stemPath = entry.path.replace(/\.[cm]?[tj]sx?$/, "");
      const testCandidates = [
        `${stemPath}.test.ts`,
        `${stemPath}.test.tsx`,
        `${stemPath}.test.mts`,
        `${stemPath}.test.js`,
        `${stemPath}.spec.ts`,
        `${stemPath}.spec.mts`,
      ];
      for (const c of testCandidates) {
        if (fileSet.has(c)) {
          addPath(c);
          break;
        }
      }
    }
  }

  return selected;
}

/**
 * Format a list of files into a token-bounded human-readable block suitable
 * for injection into the planner prompt. Output format per line:
 *
 *   src/lib/foo.ts
 *   src/lib/foo.test.ts        [test]
 *
 * Uses the same ~4-chars-per-token approximation as `formatRepoMap()`.
 * Stops emitting lines when the budget would be exceeded and appends an
 * elision marker. Returns an empty string when `files` is empty.
 *
 * @param files       - Ordered list of paths (highest relevance first)
 * @param tokenBudget - Approximate token cap (default 2000 per issue #366 AC)
 */
export function formatScopedFileTree(
  files: string[],
  tokenBudget = 2000,
): string {
  if (files.length === 0) return "";
  const charsPerToken = 4;
  const charBudget = tokenBudget * charsPerToken;
  const lines: string[] = [];
  let totalChars = 0;
  let truncated = 0;

  for (const file of files) {
    const isTest = isTestFile(file);
    const line = isTest ? `${file}  [test]` : file;
    const cost = line.length + 1; // +1 for newline
    if (totalChars + cost > charBudget && lines.length > 0) {
      truncated = files.length - lines.length;
      break;
    }
    lines.push(line);
    totalChars += cost;
  }

  if (truncated > 0) {
    lines.push(`... (${truncated} more file(s) omitted to fit token budget)`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a relative import specifier against the importing file's directory.
 * Tries exact match, then .ts, .tsx, /index.ts, /index.tsx extensions.
 */
function resolveRelative(
  fromFile: string,
  specifier: string,
  fileSet: Set<string>,
): string | undefined {
  const dir = fromFile.replace(/\/[^/]+$/, "");
  const base = normalizePath(`${dir}/${specifier}`);

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];

  for (const c of candidates) {
    if (fileSet.has(c)) return c;
  }
  return undefined;
}

/**
 * Normalize a path by resolving . and .. segments.
 */
function normalizePath(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join("/");
}

// ---------------------------------------------------------------------------
// File-tree hashing + caching
// ---------------------------------------------------------------------------

interface RepoMapCache {
  fileTreeHash: string;
  graph: ImportGraph;
}

let _cache: RepoMapCache | null = null;

/**
 * Compute a SHA-256 hash of the sorted file-tree listing.
 * Used as the cache key — if the set of files hasn't changed, the graph is
 * still valid.
 */
export function hashFileTree(fileTree: string): string {
  const sorted = fileTree
    .split("\n")
    .filter(Boolean)
    .sort()
    .join("\n");
  return createHash("sha256").update(sorted).digest("hex");
}

/**
 * Clear the repo-map cache (useful for testing).
 */
export function clearRepoMapCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Recursive TS file collector
// ---------------------------------------------------------------------------

async function collectTsFiles(
  rootDir: string,
  dir: string,
  result: Map<string, string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    /* intentional: directory may not exist or be unreadable */
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    // Skip common non-source directories
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === "coverage"
      ) {
        continue;
      }
      await collectTsFiles(rootDir, fullPath, result);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      try {
        const content = await readFile(fullPath, "utf-8");
        const relPath = relative(rootDir, fullPath);
        result.set(relPath, content);
      } catch {
        /* intentional: file may be unreadable */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// generateRepoMap — cached project-level entry point
// ---------------------------------------------------------------------------

/**
 * Generate a scope-aware repo-map string for the executor prompt.
 *
 * Reads all .ts/.tsx files under `projectRoot`, builds the import graph,
 * selects neighbors of `scopeFiles`, and formats the result.
 *
 * Results are cached per file-tree hash (from grounding). If the file tree
 * hasn't changed since the last call, the cached graph is reused and only
 * the scope-aware selection + formatting is re-run (which is cheap).
 *
 * @param projectRoot - Absolute path to the project root
 * @param fileTree    - The file-tree string from grounding (used for cache key)
 * @param scopeFiles  - Files in-scope for the current task (from scopeBoundary.in)
 * @param tokenBudget - Max approximate tokens for the formatted output (default 1500)
 * @returns Formatted repo-map string, or empty string on error
 */
export async function generateRepoMap(
  projectRoot: string,
  fileTree: string,
  scopeFiles: string[],
  tokenBudget = 1500,
): Promise<string> {
  try {
    const treeHash = hashFileTree(fileTree);

    let graph: ImportGraph;
    if (_cache && _cache.fileTreeHash === treeHash) {
      graph = _cache.graph;
    } else {
      // Read all TS files and build the graph
      const files = new Map<string, string>();
      await collectTsFiles(projectRoot, join(projectRoot, "src"), files);
      // Also check root-level .ts files (e.g. drizzle.config.ts)
      try {
        const rootEntries = await readdir(projectRoot, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
            try {
              const content = await readFile(join(projectRoot, entry.name), "utf-8");
              files.set(entry.name, content);
            } catch {
              /* intentional: file may be unreadable */
            }
          }
        }
      } catch {
        /* intentional: root dir listing failure is non-fatal */
      }

      graph = buildImportGraph(files);

      // Update cache
      _cache = { fileTreeHash: treeHash, graph };
    }

    // Select scope-aware neighbors and format
    const neighbors = selectScopeNeighbors(graph, scopeFiles);

    // Also include scope files themselves (ranked first)
    const scores = computePageRank(graph);
    const scopeRanked = scopeFiles
      .filter((f) => graph.edges.has(f))
      .map((f) => ({ file: f, score: scores.get(f) ?? 0, isTest: isTestFile(f) }));

    const allRanked = [...scopeRanked, ...neighbors];
    if (allRanked.length === 0) return "";

    const warnings = computeBlastRadiusWarnings(graph, scopeFiles);
    const mapBody = formatRepoMap(graph, allRanked, tokenBudget, scopeFiles);

    if (warnings.length > 0) {
      return warnings.join("\n") + "\n\n" + mapBody;
    }
    return mapBody;
  } catch (err: any) {
    console.error(`[RepoMap] Failed to generate repo map: ${err.message}`);
    return "";
  }
}
