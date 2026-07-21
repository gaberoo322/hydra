/**
 * source-enumerator.ts — pure source-file enumeration + path helpers
 * (extracted from indexer.ts, issue #2767).
 *
 * This module owns the genuinely-pure "which files are indexable?" concern
 * that was previously interleaved with the OpenViking upload transport inside
 * the 903-line indexer.ts (consolidated in #2354). It answers a single
 * question with NO OpenViking dependency:
 *
 *   Given a `<root>:<ext>` source spec, which files under those trees are
 *   candidates for indexing (extension filter + SKIP_DIRS + recursive walk),
 *   and what stable OV title does each carry?
 *
 * Zero-OV by construction (issue #2767, INV-5): the only I/O is a filesystem
 * read (`readdir`), so this module is unit-testable with a pure
 * `readFile`/`readdir` stub and no OV stubs. `indexer.ts` imports these
 * helpers back (dependency flows enumerator <- indexer, never the reverse —
 * INV-4, no circular import).
 *
 * NOTE (issue #2767, INV-3): HashDedupAdapter / defaultHashAdapter deliberately
 * STAY in indexer.ts — they call indexText/ovPostJson (OV upload) and their
 * coverageStats is read by src/api/openviking.ts, so they are NOT zero-OV and
 * cannot live here.
 *
 * History references preserved from the original indexer.ts Section 2 (#210).
 */

import { extname, join, relative, basename, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { logger } from "../logger.ts";

/** Directory names never descended into / never indexed. */
export const SKIP_DIRS = new Set([".git", "node_modules"]);

// Issue #210: Source-file indexing. Comma-separated list of <path>:<ext>
// entries (extension is glob-less).
export interface SourcePath {
  root: string;
  ext: string;
}

export function parseSourcePaths(spec: string): SourcePath[] {
  const out: SourcePath[] = [];
  if (!spec) return out;
  for (const entry of spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const idx = entry.lastIndexOf(":");
    if (idx <= 0) continue;
    const root = entry.slice(0, idx);
    let ext = entry.slice(idx + 1);
    if (!root || !ext) continue;
    if (!ext.startsWith(".")) ext = "." + ext;
    out.push({ root, ext });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Env-derived default source-path configuration (issue #2850).
//
// The canonical answer to "what is the default indexer source-path spec, and
// which SourcePath[] does it parse to?" lives HERE, next to parseSourcePaths —
// the pure parser the spec flows through. Both OV-coupled consumers
// (indexer.ts's private SOURCE_PATHS, indexer-lifecycle.ts's IndexerController
// default) import these instead of each re-deriving them from process.env, so a
// change to the default spec (e.g. adding a new source tree) is a one-file edit
// with compiler enforcement that both callers stay in sync.
//
// Previously these were duplicated across indexer.ts and indexer-lifecycle.ts
// with a silent divergence: indexer.ts used `join()` (OS-native separator)
// while indexer-lifecycle.ts used a forward-slash template literal — equivalent
// on Linux, divergent on Windows. This single definition uses `join()` (the
// OS-native, portable form).

/** Hydra root the default source-path spec is derived under. Override with HYDRA_ROOT. */
const HYDRA_ROOT_FOR_SOURCE =
  process.env.HYDRA_ROOT || resolve(process.env.HOME!, "hydra");

/**
 * Default `<path>:<ext>` spec: <hydra-root>/src:.ts, /docs:.md, /test:.mts.
 * Built with `join()` so the path separator is OS-native. Override the whole
 * default set with HYDRA_INDEX_SOURCE_PATHS.
 */
const DEFAULT_SOURCE_SPEC = `${join(HYDRA_ROOT_FOR_SOURCE, "src")}:.ts,${join(
  HYDRA_ROOT_FOR_SOURCE,
  "docs"
)}:.md,${join(HYDRA_ROOT_FOR_SOURCE, "test")}:.mts`;

/**
 * The parsed default SourcePath[] the production indexer watches when
 * HYDRA_INDEX_SOURCE_PATHS is unset. The single source of truth both indexer.ts
 * and indexer-lifecycle.ts import (issue #2850).
 */
export const DEFAULT_SOURCE_PATHS: SourcePath[] = parseSourcePaths(
  process.env.HYDRA_INDEX_SOURCE_PATHS || DEFAULT_SOURCE_SPEC
);

// Issue #210: Source-file indexing helpers.
// shouldIndexSource is exported for testing.
export function shouldIndexSource(filePath: string, source: SourcePath): boolean {
  if (!filePath.startsWith(source.root)) return false;
  if (extname(filePath) !== source.ext) return false;
  const rel = relative(source.root, filePath);
  for (const skip of SKIP_DIRS) {
    if (rel === skip || rel.startsWith(skip + "/")) return false;
  }
  // Skip dist/build/coverage and dotfile dirs commonly under src trees.
  if (/(^|\/)(dist|build|coverage|\.next|\.vite|\.cache)(\/|$)/.test(rel))
    return false;
  return true;
}

// Recursively enumerate files under root, skipping standard ignore dirs and
// matching the configured extension. Exported for tests.
export async function enumerateSourceFiles(
  source: SourcePath,
  maxFiles = 2000
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      // Missing directory is fine — operator may not have docs/ for example.
      if (err.code !== "ENOENT") {
        logger.error(
          { dir, err },
          "[Learning:Indexer] readdir failed",
        );
      }
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      if (
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === "coverage"
      )
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && shouldIndexSource(full, source)) {
        out.push(full);
      }
    }
  }
  await walk(source.root);
  return out;
}

// Build a stable, OV-friendly title from an absolute source path.
// The OV resource title acts as a logical key; same title -> overwrite.
export function buildSourceTitle(filePath: string, source: SourcePath): string {
  const rel = relative(source.root, filePath);
  const folder = basename(source.root);
  const slug = `${folder}/${rel}`.replace(/\//g, "__");
  return `hydra-source:${slug}`;
}
