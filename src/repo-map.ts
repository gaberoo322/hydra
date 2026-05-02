/**
 * repo-map.ts — Regex-based TypeScript parser for exported symbols and import edges.
 *
 * Builds an adjacency graph (file A imports file B) from .ts/.tsx source files.
 * Zero runtime dependencies — regex only.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportedSymbol {
  name: string;
  kind: "function" | "class" | "const" | "let" | "var" | "type" | "interface" | "enum" | "default" | "re-export";
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

  const add = (name: string, kind: ExportedSymbol["kind"]) => {
    const key = `${kind}:${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ name, kind });
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
    add(m[1], kind);
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
// Scope-aware selection
// ---------------------------------------------------------------------------

/**
 * Given a set of scope files (e.g. from scopeBoundary.in), BFS outward
 * through the import graph to find the top-N most relevant neighbor files.
 *
 * Relevance = PageRank score, but only for files reachable within `maxDepth`
 * hops from the scope set (via both incoming and outgoing edges).
 *
 * @param graph      - The import graph
 * @param scopeFiles - Files that are in-scope for the current task
 * @param topN       - Maximum number of neighbors to return (default 15)
 * @param maxDepth   - BFS depth limit (default 2)
 * @returns Sorted array of { file, score } for the top-N relevant neighbors
 */
export function selectScopeNeighbors(
  graph: ImportGraph,
  scopeFiles: string[],
  topN = 15,
  maxDepth = 2,
): { file: string; score: number }[] {
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

  // Sort by score descending, take top N
  neighbors.sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  return neighbors.slice(0, topN).map((f) => ({
    file: f,
    score: scores.get(f) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Token-budgeted formatting
// ---------------------------------------------------------------------------

/**
 * Format the repo map as a compact, human-readable string within a token budget.
 *
 * Output format per line: `file — exportName (imported by N files)`
 *
 * Estimates ~4 chars per token (conservative). Stops adding lines when the
 * budget would be exceeded.
 *
 * @param graph       - The import graph
 * @param rankedFiles - Ordered list of files to include (from selectScopeNeighbors or PageRank)
 * @param tokenBudget - Maximum approximate tokens (default 1500)
 * @returns Formatted string fitting within the token budget
 */
export function formatRepoMap(
  graph: ImportGraph,
  rankedFiles: { file: string; score: number }[],
  tokenBudget = 1500,
): string {
  // Build in-degree count: how many files import each file?
  const importedByCount = new Map<string, number>();
  for (const [, targets] of graph.edges) {
    for (const tgt of targets) {
      importedByCount.set(tgt, (importedByCount.get(tgt) ?? 0) + 1);
    }
  }

  const charsPerToken = 4;
  const charBudget = tokenBudget * charsPerToken;
  let totalChars = 0;
  const lines: string[] = [];

  for (const { file } of rankedFiles) {
    const exports = graph.exports.get(file) ?? [];
    const importers = importedByCount.get(file) ?? 0;

    // Pick the most representative export name (first non-re-export, or first)
    const mainExport =
      exports.find((e) => e.kind !== "re-export") ?? exports[0];
    const exportLabel = mainExport
      ? mainExport.name
      : "(no exports)";

    const line = `${file} — ${exportLabel} (imported by ${importers} files)`;
    const lineChars = line.length + 1; // +1 for newline

    if (totalChars + lineChars > charBudget && lines.length > 0) break;
    lines.push(line);
    totalChars += lineChars;
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
