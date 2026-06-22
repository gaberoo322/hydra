/**
 * source-indexer.ts — Source-file indexing for OpenViking (issue #210).
 *
 * Extracted from src/learning.ts as the first scope-trimmed step toward
 * the broader split described in issue #211. Behavior is preserved
 * verbatim; learning.ts re-exports every public symbol so callers do
 * not break.
 *
 * Responsibility: enumerate src/, docs/, test/ trees, hash-dedupe their
 * contents, and push them through indexText so agents can semantically
 * retrieve actual implementation context (not just config + reports).
 *
 * Pure helpers (parseSourcePaths, shouldIndexSource, enumerateSourceFiles,
 * buildSourceTitle, runSourceInitialPass, getCoverageStats,
 * resetCoverageStats) are unit-tested via test/knowledge-indexer.test.mts.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, resolve, relative, basename } from "node:path";
import { createHash } from "node:crypto";
import { indexText } from "./ov-upload.ts";
import {
  loadSourceHashes as redisLoadSourceHashes,
  persistSourceHash as redisPersistSourceHash,
} from "../redis/source-index.ts";

const SKIP_DIRS = new Set([".git", "node_modules"]);
const DEBOUNCE_MS = parseInt(process.env.INDEXER_DEBOUNCE_MS as any) || 2000;

// Issue #210: Source-file indexing. Indexer also watches src/ (*.ts) and
// docs/ (*.md) so agents can semantically retrieve actual implementation
// context, not just config + reports. Comma-separated list of <path>:<ext>
// entries (extension is glob-less). Defaults to <hydra-root>/src:.ts and
// <hydra-root>/docs:.md. Override with HYDRA_INDEX_SOURCE_PATHS.
const HYDRA_ROOT_FOR_SOURCE =
  process.env.HYDRA_ROOT || resolve(process.env.HOME!, "hydra");
const DEFAULT_SOURCE_SPEC = `${join(HYDRA_ROOT_FOR_SOURCE, "src")}:.ts,${join(
  HYDRA_ROOT_FOR_SOURCE,
  "docs"
)}:.md,${join(HYDRA_ROOT_FOR_SOURCE, "test")}:.mts`;

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

export const SOURCE_PATHS: SourcePath[] = parseSourcePaths(
  process.env.HYDRA_INDEX_SOURCE_PATHS || DEFAULT_SOURCE_SPEC
);
// Files modified within this window get the initial-index pass on startup.
const SOURCE_INITIAL_WINDOW_MS =
  parseInt(process.env.HYDRA_INDEX_INITIAL_DAYS as any) > 0
    ? parseInt(process.env.HYDRA_INDEX_INITIAL_DAYS as any) * 86400_000
    : 7 * 86400_000;

// Issue #2335: pace the startup source-index pass so it does not burst its
// embed-triggering uploads at OpenViking. Each `indexSourceFile` upload that
// actually lands (a NEW/changed file, not a hash-dedup skip) makes OV embed the
// payload via its Ollama backend (#980/#1795). `runSourceInitialPass` walks the
// whole recently-modified tree in a tight serial loop, so a cold cache (every
// orchestrator restart) fires a burst of embed requests back-to-back. That
// burst is the indexing-load window that starves OV's `/api/v1/skills` POST
// handler (#1831), which is what leaves the skill catalog empty for hours
// (#2148/#2269/#2335) — the chore/probe/registration paths are all correct;
// the orchestrator's own indexer is a load contributor.
//
// SOURCE_EMBED_PACE_MS inserts a delay AFTER each upload that actually
// happened, BEFORE the next file's upload, so the embed queue drains between
// resources instead of being flooded. Defaults to 0 (no behaviour change —
// preserves the existing test timings and the pre-#2335 burst on hosts that
// don't set it); production sets a small positive value (e.g. 250) to smooth
// the embed load. A skip (hash dedup / out-of-window) costs no embed, so it is
// never paced.
const SOURCE_EMBED_PACE_MS = Math.max(
  0,
  parseInt(process.env.INDEXER_EMBED_PACE_MS as any) || 0,
);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Path-based dedup: tracks indexed source paths + content hash so we skip
// re-uploading unchanged files. This in-memory Map is a hot read cache for the
// per-file index path; the durable copy lives in Redis (issue #1123) and is
// hydrated into this Map on startup via loadPersistedHashes() and written
// through on each successful index. Before #1123 this Map was in-memory ONLY
// and reset on every restart, so each of the orchestrator's dozens-per-day
// bounces re-embedded the whole modified-window tree (~13k "Indexed text:"
// lines/day) for zero new information.
const indexedSourceHashes = new Map<string, string>();

// Persistence seam (issue #1123). Defaults to the real Redis accessors but is
// swappable so tests can drive the load/persist behavior without a live Redis.
// Both default impls are best-effort no-ops on a Redis error (the indexer then
// degrades to the pre-#1123 re-upload behavior — wasteful but correct).
type LoadHashesFn = () => Promise<Map<string, string>>;
type PersistHashFn = (path: string, hash: string) => Promise<void>;
let loadHashesImpl: LoadHashesFn = redisLoadSourceHashes;
let persistHashImpl: PersistHashFn = redisPersistSourceHash;

/**
 * Test-only: override the persistence layer so tests exercise the
 * load-on-startup + write-through behavior against an in-memory fake instead
 * of a live Redis. Pass no args to restore the real Redis-backed accessors.
 */
export function _setHashPersistence(
  impl?: { load?: LoadHashesFn; persist?: PersistHashFn },
): void {
  loadHashesImpl = impl?.load ?? redisLoadSourceHashes;
  persistHashImpl = impl?.persist ?? redisPersistSourceHash;
}

/**
 * Hydrate the in-memory dedup cache from the durable Redis copy. Call once on
 * startup (from startKnowledgeIndexer) BEFORE the initial-index pass so files
 * unchanged since a previous process's run are recognised as already-indexed
 * and skipped instead of re-embedded. Best-effort: a load failure leaves the
 * cache as-is (empty on a cold start), degrading to the old re-upload behavior.
 * Returns the number of entries loaded (for logging/tests).
 */
export async function loadPersistedHashes(): Promise<number> {
  const persisted = await loadHashesImpl();
  for (const [path, hash] of persisted) {
    // Don't clobber a hotter in-memory entry written this process lifetime.
    if (!indexedSourceHashes.has(path)) indexedSourceHashes.set(path, hash);
  }
  return persisted.size;
}

// Issue #210: knowledge coverage stats for /api/learning/coverage
interface CoverageStats {
  resourceCount: number;
  sourceFilesIndexed: number;
  sourceFilesSkipped: number;
  lastIndexAt: string | null;
  watchedPaths: string[];
}
const coverageStats: CoverageStats = {
  resourceCount: 0,
  sourceFilesIndexed: 0,
  sourceFilesSkipped: 0,
  lastIndexAt: null,
  watchedPaths: [],
};

export function getCoverageStats(): CoverageStats {
  return {
    ...coverageStats,
    watchedPaths: [...coverageStats.watchedPaths],
  };
}

// Test-only: reset coverage stats between tests.
export function resetCoverageStats(): void {
  coverageStats.resourceCount = 0;
  coverageStats.sourceFilesIndexed = 0;
  coverageStats.sourceFilesSkipped = 0;
  coverageStats.lastIndexAt = null;
  coverageStats.watchedPaths = [];
  indexedSourceHashes.clear();
}

/**
 * Test-only: set the watchedPaths summary that startKnowledgeIndexer
 * reports (kept here so the array stays colocated with the stats).
 */
export function setWatchedPaths(paths: string[]): void {
  coverageStats.watchedPaths = paths;
}

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
        console.error(
          `[Learning:Indexer] readdir failed for ${dir}: ${err.message}`
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

async function indexSourceFile(
  filePath: string,
  source: SourcePath
): Promise<"indexed" | "skipped" | "error"> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(
        `[Learning:Indexer] readFile failed for ${filePath}: ${err.message}`
      );
    }
    return "error";
  }
  // Cap individual file size to keep payload reasonable (~256KB).
  const MAX_BYTES = 256 * 1024;
  if (content.length > MAX_BYTES) {
    content =
      content.slice(0, MAX_BYTES) + `\n\n... [truncated at ${MAX_BYTES} bytes]`;
  }
  const hash = createHash("sha1").update(content).digest("hex");
  const prev = indexedSourceHashes.get(filePath);
  if (prev === hash) {
    coverageStats.sourceFilesSkipped++;
    return "skipped";
  }
  const title = buildSourceTitle(filePath, source);
  const rel = relative(source.root, filePath);
  const folder = basename(source.root);
  const header = `# ${folder}/${rel}\n\n_Indexed source file (sha1=${hash.slice(
    0,
    12
  )})._\n\n`;
  // Reuse indexText machinery for upload.
  await indexText(title, `${header}\`\`\`\n${content}\n\`\`\``);
  indexedSourceHashes.set(filePath, hash);
  // Write through to the durable copy so the next process restart can skip this
  // file (issue #1123). Best-effort — persistHashImpl swallows Redis errors.
  await persistHashImpl(filePath, hash);
  coverageStats.sourceFilesIndexed++;
  coverageStats.resourceCount++;
  coverageStats.lastIndexAt = new Date().toISOString();
  return "indexed";
}

// Initial-index pass: enumerate, filter to recently-modified, upload missing.
// Returns counts for tests + logging. Idempotent across restarts (hash-based).
export async function runSourceInitialPass(
  opts: {
    paths?: SourcePath[];
    windowMs?: number;
    now?: number;
    /**
     * Inter-upload pacing (ms) applied AFTER each file that actually uploads,
     * before the next file's upload (issue #2335). Defaults to
     * {@link SOURCE_EMBED_PACE_MS} (env `INDEXER_EMBED_PACE_MS`, 0 if unset).
     * Tests pass 0 to keep timings instant; a skip (no embed) is never paced.
     */
    paceMs?: number;
  } = {}
): Promise<{ scanned: number; indexed: number; skipped: number }> {
  const paths = opts.paths ?? SOURCE_PATHS;
  const windowMs = opts.windowMs ?? SOURCE_INITIAL_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const paceMs = Math.max(0, opts.paceMs ?? SOURCE_EMBED_PACE_MS);
  let scanned = 0;
  let indexed = 0;
  let skipped = 0;
  for (const source of paths) {
    const files = await enumerateSourceFiles(source);
    for (const file of files) {
      scanned++;
      let mtimeMs: number;
      try {
        const s = await stat(file);
        mtimeMs = s.mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs > windowMs) {
        skipped++;
        continue;
      }
      const result = await indexSourceFile(file, source);
      if (result === "indexed") {
        indexed++;
        // Only an actual upload triggers an OV embed, so only pace after one —
        // skips (hash-dedup / out-of-window) cost no embed. This keeps the
        // orchestrator's startup pass from bursting embed requests at OV and
        // starving the load-gated /api/v1/skills handler (#1831/#2335).
        if (paceMs > 0) await sleep(paceMs);
      } else if (result === "skipped") {
        skipped++;
      }
    }
  }
  return { scanned, indexed, skipped };
}

/**
 * Build a fs.watch callback that debounces source-file changes through a
 * shared `pending` map and indexes them via indexSourceFile. The map +
 * debounce window are owned by the caller (learning.ts) so the config
 * watcher and source watcher share a single dedup queue.
 */
export function makeSourceWatcher(
  source: SourcePath,
  pending: Map<string, ReturnType<typeof setTimeout>>,
  debounceMs: number = DEBOUNCE_MS
): (eventType: string, filename: string | null) => void {
  return (_eventType: string, filename: string | null) => {
    if (!filename) return;
    const fullPath = resolve(source.root, filename);
    if (!shouldIndexSource(fullPath, source)) return;
    if (pending.has(fullPath)) clearTimeout(pending.get(fullPath)!);
    pending.set(
      fullPath,
      setTimeout(() => {
        pending.delete(fullPath);
        indexSourceFile(fullPath, source).catch((err: any) =>
          console.error(
            `[Learning:Indexer] Source change index failed for ${fullPath}: ${err.message}`
          )
        );
      }, debounceMs)
    );
  };
}
