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
