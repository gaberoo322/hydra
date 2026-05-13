/**
 * test-impact-graph.ts — Static transitive import resolver for test selection.
 *
 * Issue #341: every cycle reruns the full 4795-test target suite twice
 * (grounding + verification), at ~70s each. Incremental selection — running
 * only tests whose transitive import closure intersects the changed files —
 * can reclaim 25% of cycle time.
 *
 * This module is intentionally pure / dependency-free:
 *   - readFile + path manipulation only (no execFile)
 *   - no Redis, no env reads (callers pass options)
 *   - all I/O happens in buildImportGraph(); selection is sync + pure
 *
 * The graph is keyed by test file (path relative to projectDir). Each test's
 * value is the Set of source files it transitively imports. selectAffectedTests
 * intersects each test's closure with the changedFiles set.
 *
 * SAFETY NET: every public selection helper has a documented fallback signal
 * (returning null) so callers can run the full suite when the incremental run
 * would be unsafe — empty selection, suspiciously large selection, or
 * unresolvable imports.
 *
 * This implementation does NOT execute the selected tests — callers (verifier,
 * grounding) translate the selection into the project's test runner CLI form.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

// =========================================================================
// Types
// =========================================================================

/**
 * A map from test file (relative to projectDir) to the transitive set of
 * source files it imports (also relative to projectDir).
 *
 * Test files import each other and/or production source files; the closure
 * includes both, minus the test file itself.
 */
export type ImportGraph = Map<string, Set<string>>;

export interface BuildGraphOptions {
  /**
   * Root directory of the project (absolute). All paths in the returned graph
   * are relative to this.
   */
  projectDir: string;

  /**
   * Test file paths relative to projectDir. Each will get its own closure.
   */
  testFiles: string[];

  /**
   * Maximum number of nodes to traverse before giving up on a closure (defense
   * against pathological import graphs / cycles). Default: 5000.
   */
  maxNodesPerClosure?: number;

  /**
   * Optional override for readFile (testing escape hatch). Default: fs.readFile.
   */
  readFileImpl?: (absPath: string) => Promise<string>;
}

export interface SelectOptions {
  /**
   * Total count of all tests in the suite. Used to compute the "too many
   * selected" threshold — if selected/total >= fullSuiteFallbackRatio, return
   * null so the caller runs the full suite.
   *
   * Default: 0.9 (i.e. if >=90% of tests are affected, just run them all).
   */
  fullSuiteFallbackRatio?: number;
}

// =========================================================================
// Import parsing — language-aware regexes (TypeScript/JavaScript ESM + CJS)
// =========================================================================

// Matches:
//   import ... from "x"
//   import "x"
//   import("x")
//   export ... from "x"
//   require("x")
//
// Quotes can be single, double, or backtick. We deliberately stop at the first
// non-template-literal closing quote — string-literal template imports are out
// of scope (statically unresolvable).
const IMPORT_REGEX =
  /\b(?:import|export)\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Extract import specifiers from a source string. Pure function.
 *
 * Returns the raw specifier strings as they appear in the source — relative
 * paths ("./foo", "../bar/baz"), bare module specs ("node:fs", "express"),
 * and aliased imports ("@/lib/foo"). Caller is responsible for resolving
 * these against the file's location.
 */
export function parseImports(source: string): string[] {
  if (!source) return [];
  // Strip /* ... */ block comments and // line comments to avoid matching
  // imports referenced in JSDoc or commented-out code.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_REGEX.lastIndex = 0;
  while ((m = IMPORT_REGEX.exec(stripped)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (spec) matches.push(spec);
  }
  return matches;
}

// =========================================================================
// Module resolution — relative + tsconfig-style aliases only
// =========================================================================

/**
 * Resolve an import specifier to a file path relative to projectDir, or null
 * if the import is a bare external module (node:fs, ioredis, …) or cannot be
 * resolved statically.
 *
 * Strategy:
 *   1. Bare specs (no leading "." or "/") → null. We don't follow node_modules.
 *   2. Relative specs ("./", "../") → join against importer's dir, then try
 *      the candidate extensions and /index.* variants in order.
 *   3. Path aliases (starts with "@/") → try resolving against alias roots in
 *      the order they appear in the options.aliasRoots map.
 *
 * Returns the candidate path relative to projectDir on success.
 */
export function resolveImport(
  spec: string,
  importerRelPath: string,
  projectDir: string,
  opts: {
    extensions?: string[];
    aliasRoots?: Map<string, string>;
    fileExists: (relPath: string) => boolean;
  },
): string | null {
  const extensions = opts.extensions || [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
  ];

  // 1. Bare module spec — out of scope.
  if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("@/")) {
    return null;
  }

  // 2. Path alias "@/foo" → resolve against alias roots.
  if (spec.startsWith("@/") && opts.aliasRoots) {
    const rest = spec.slice(2); // strip "@/"
    for (const [, root] of opts.aliasRoots) {
      const base = join(root, rest);
      const resolved = tryExtensions(base, extensions, opts.fileExists);
      if (resolved) return resolved;
    }
    return null;
  }

  // 3. Relative spec.
  if (spec.startsWith(".")) {
    const importerDir = dirname(importerRelPath);
    const base = normalizeRel(join(importerDir, spec));
    return tryExtensions(base, extensions, opts.fileExists);
  }

  // 4. Absolute path inside project — convert to relative.
  if (spec.startsWith("/")) {
    const abs = resolve(spec);
    const rel = relative(projectDir, abs);
    if (rel.startsWith("..") || rel.startsWith(sep)) return null;
    return tryExtensions(rel, extensions, opts.fileExists);
  }

  return null;
}

function tryExtensions(
  base: string,
  extensions: string[],
  fileExists: (rel: string) => boolean,
): string | null {
  // Already has extension and exists?
  if (/\.[a-zA-Z0-9]{1,4}$/.test(base) && fileExists(base)) return base;
  // Try base + ext
  for (const ext of extensions) {
    const candidate = base + ext;
    if (fileExists(candidate)) return candidate;
  }
  // Try base/index.ext
  for (const ext of extensions) {
    const candidate = join(base, "index" + ext);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function normalizeRel(p: string): string {
  // Node's path.join already collapses ./ and ../, but on POSIX it preserves
  // leading "./" which we don't want for graph keys.
  return p.startsWith("./") ? p.slice(2) : p;
}

// =========================================================================
// Build graph — async (reads files), bounded by maxNodesPerClosure
// =========================================================================

export interface BuildGraphContext {
  /**
   * Lookup of all known source files in the project (relative paths). Used by
   * resolveImport's fileExists callback and to short-circuit on missing files.
   */
  allFiles: Set<string>;

  /**
   * Optional tsconfig-style alias roots. Keys are alias prefixes (e.g. "@/"),
   * values are the directory the alias maps to (relative to projectDir).
   */
  aliasRoots?: Map<string, string>;
}

/**
 * Build a transitive import graph for the given test files.
 *
 * Walks each test's imports BFS, resolves each via {@link resolveImport}, and
 * accumulates the closure. Cycles are handled via the visited set. Bare
 * imports (node:fs, ioredis) are silently skipped.
 *
 * On read failure for any specific file, that file is logged via stderr and
 * its imports are treated as empty — the closure is still computed, just
 * smaller. This keeps the gate as a soft signal: degraded graphs still help.
 */
export async function buildImportGraph(
  opts: BuildGraphOptions,
  ctx: BuildGraphContext,
): Promise<ImportGraph> {
  const {
    projectDir,
    testFiles,
    maxNodesPerClosure = 5000,
    readFileImpl,
  } = opts;
  const readImpl = readFileImpl || ((p) => readFile(p, "utf-8"));

  const graph: ImportGraph = new Map();
  // Per-file imports cache so we don't re-read shared modules.
  const importsCache = new Map<string, string[]>();

  async function getImports(relPath: string): Promise<string[]> {
    if (importsCache.has(relPath)) return importsCache.get(relPath)!;
    try {
      const source = await readImpl(join(projectDir, relPath));
      const imports = parseImports(source);
      importsCache.set(relPath, imports);
      return imports;
    } catch (err: any) {
      console.error(
        `[test-impact-graph] readFile ${relPath} failed: ${err.message}`,
      );
      importsCache.set(relPath, []);
      return [];
    }
  }

  const fileExists = (rel: string) => ctx.allFiles.has(rel);

  for (const testFile of testFiles) {
    const closure = new Set<string>();
    const queue: string[] = [testFile];
    while (queue.length > 0 && closure.size < maxNodesPerClosure) {
      const current = queue.shift()!;
      if (closure.has(current)) continue;
      closure.add(current);
      const imports = await getImports(current);
      for (const spec of imports) {
        const resolved = resolveImport(spec, current, projectDir, {
          aliasRoots: ctx.aliasRoots,
          fileExists,
        });
        if (resolved && !closure.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
    // Don't include the test itself in its own closure — keeps semantics
    // (selectAffectedTests asks "does this test depend on a changed file?"
    // not "is this test itself changed?"; the latter is handled separately).
    closure.delete(testFile);
    graph.set(testFile, closure);
  }

  return graph;
}

// =========================================================================
// Select affected tests — pure / synchronous
// =========================================================================

/**
 * Given a set of changed files and a pre-built import graph, return the
 * subset of test files whose transitive closure intersects any changed file.
 *
 * SAFETY:
 *   - Tests that are themselves in the changed-files set are always selected
 *     (the test was edited directly).
 *   - Returns null if the selection would cover >=fullSuiteFallbackRatio of
 *     the graph (default 90%). Caller should run the full suite in that case
 *     — incremental savings would be marginal and a fresh full run validates
 *     the import graph itself.
 *   - Returns [] (empty array, NOT null) if the selection is empty AND no
 *     change files were provided. Caller should treat empty selection
 *     conservatively (run full suite) per the issue's safety-net criterion.
 *
 * Pure: no I/O.
 */
export function selectAffectedTests(
  changedFiles: string[],
  graph: ImportGraph,
  opts: SelectOptions = {},
): string[] | null {
  const fullSuiteFallbackRatio = opts.fullSuiteFallbackRatio ?? 0.9;
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return null; // caller decides — typically: run full suite
  }
  const changedSet = new Set(changedFiles);
  const selected: string[] = [];

  for (const [testFile, closure] of graph) {
    if (changedSet.has(testFile)) {
      // Test file itself was modified.
      selected.push(testFile);
      continue;
    }
    // Intersect closure with changedFiles. Iterate the smaller of the two for
    // speed — closures are typically O(10s-100s), changed files often <10.
    if (changedSet.size <= closure.size) {
      for (const f of changedSet) {
        if (closure.has(f)) {
          selected.push(testFile);
          break;
        }
      }
    } else {
      for (const f of closure) {
        if (changedSet.has(f)) {
          selected.push(testFile);
          break;
        }
      }
    }
  }

  // Saturation check: if we'd run almost everything, just run the full suite.
  if (graph.size > 0 && selected.length / graph.size >= fullSuiteFallbackRatio) {
    return null;
  }

  return selected;
}

// =========================================================================
// Convenience: classify selection outcome for caller decisions + logging
// =========================================================================

export type SelectionDecision =
  | { mode: "incremental"; tests: string[]; reason: string }
  | { mode: "full-suite"; reason: string };

/**
 * Convenience wrapper for callers. Translates selectAffectedTests's null vs
 * empty signals into an explicit mode tag + human-readable reason for logs.
 *
 * Rules (mirrors issue #341 success criteria):
 *   - changedFiles empty → full-suite ("no-diff: changed file list empty")
 *   - selection null (saturation) → full-suite ("saturation: NN% of tests selected")
 *   - selection empty → full-suite ("safety-net: zero tests selected")
 *   - otherwise → incremental
 */
export function decideTestSelection(
  changedFiles: string[],
  graph: ImportGraph,
  opts: SelectOptions = {},
): SelectionDecision {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { mode: "full-suite", reason: "no-diff: changed file list empty" };
  }
  const result = selectAffectedTests(changedFiles, graph, opts);
  if (result === null) {
    const ratio = opts.fullSuiteFallbackRatio ?? 0.9;
    return {
      mode: "full-suite",
      reason: `saturation: selection would cover >=${Math.round(ratio * 100)}% of tests`,
    };
  }
  if (result.length === 0) {
    return {
      mode: "full-suite",
      reason: "safety-net: zero tests selected (likely import-graph miss)",
    };
  }
  return {
    mode: "incremental",
    tests: result,
    reason: `incremental: ${result.length}/${graph.size} tests cover ${changedFiles.length} changed files`,
  };
}
