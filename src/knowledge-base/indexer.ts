/**
 * indexer.ts — consolidated OpenViking source/config indexing cluster (issue #2354).
 *
 * This module merges four formerly-separate shallow indexing modules that
 * together formed one coupled cluster layered over the OpenViking Request
 * Adapter Seam (`ov-request.ts`) and the search Seam (`ov-search.ts`):
 *
 *   - ov-upload.ts          — low-level OV upload helpers (indexFile / indexText)
 *   - source-indexer.ts     — source-tree enumeration, hash-dedup, initial pass
 *   - source-freshness.ts   — staleness probe over the OV search Seam
 *   - knowledge-indexer.ts  — the background indexer lifecycle (watch + poll)
 *
 * Per the approved design-concept for #2354 (Option C), only this genuinely-
 * coupled shallow cluster is consolidated; the named boundary Seams it depends
 * on — ov-request.ts (the OpenViking Request Adapter, the single raw-fetch
 * owner the openviking-seam-check ratchet exempts), ov-search.ts (search
 * metrics), ov-config.ts (the #231 single-source base URL), and
 * skill-registration.ts (the skill-catalog state machine) — are left UNTOUCHED.
 *
 * Behavior is preserved 1:1 from the four source files. Public symbols are
 * unchanged so importers only update their import specifier. The previous
 * file-level history references (#210, #211, #219, #313, #318, #866, #954,
 * #965, #1123, #2267) are retained inline at each block.
 */

import { watch } from "node:fs";
import { readFile, readdir, stat, writeFile, unlink } from "node:fs/promises";
import {
  extname,
  join,
  resolve,
  relative,
  basename,
  sep as pathSep,
} from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Issue #954: OV HTTP requests route through the OpenViking Request Adapter,
// which owns the URL join + auth headers + timeout + error classification +
// JSON/text unwrap. This cluster keeps its #313 temp_path unwrap and the
// multipart upload shape — pure domain behaviour layered on the transport.
import { ovPostJson, ovPostForm, isOvFailure } from "./ov-request.ts";
import { trackedOvSearch } from "./ov-search.ts";
import { getMemoryPatterns } from "../redis/agent-memory.ts";
import {
  loadSourceHashes as redisLoadSourceHashes,
  persistSourceHash as redisPersistSourceHash,
} from "../redis/source-index.ts";

// ---------------------------------------------------------------------------
// Shared constants (deduped across the merged modules — identical definitions).
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.HYDRA_CONFIG_PATH ||
  resolve(process.env.HOME!, "hydra", "config");
const OV_CONFIG_MOUNT = process.env.OV_CONFIG_MOUNT || "/config";
const SKIP_DIRS = new Set([".git", "node_modules"]);
const DEBOUNCE_MS = parseInt(process.env.INDEXER_DEBOUNCE_MS as any) || 2000;

// ===========================================================================
// SECTION 1 — OV upload helpers (formerly ov-upload.ts).
//
// Low-level fetch helpers used by both the config-file watcher and the
// source-file indexer to push content into OpenViking. Pure HTTP — no state
// beyond the per-file dedup map below, no Redis.
// ===========================================================================

// Per-file content hashes so unchanged re-writes (priorities-agent rewriting
// the same content, fs.watch firing twice, etc.) skip the OV round-trip.
const indexedConfigHashes = new Map<string, string>();

// Translate a config-relative path into the OV virtual-fs URI under
// viking://resources. Without an explicit `to:` target, OV defaults the
// destination to a top-level basename — stripping the directory prefix
// and the file extension — which both clobbers nested layout and
// conflicts with prior orphan entries on every subsequent re-index.
export function indexerTargetUri(rel: string): string {
  return `viking://resources/${rel.split(pathSep).join("/")}`;
}

/**
 * Index a file already mounted into the OV container (config tree).
 * Tells OV to ingest the file by container-relative path.
 *
 * Exported (issue #2523 forward-fix) so the IndexerController in
 * indexer-lifecycle.ts can inject it as the config-file index path — the
 * OV container-path ingestion (`/api/v1/resources` with `path:/config/<rel>,
 * to:viking://resources/<rel>`) WITH per-file SHA-256 hash-dedup via
 * indexedConfigHashes. The #2526 extraction wrongly re-routed config changes
 * through indexText (blob-upload to the hydra-memory/ namespace, no dedup);
 * this export restores the original 1:1 behaviour (INV-1, INV-5).
 */
export async function indexFile(filePath: string): Promise<void> {
  const rel = relative(CONFIG_PATH, filePath);
  const containerPath = join(OV_CONFIG_MOUNT, rel);
  const targetUri = indexerTargetUri(rel);

  let hash: string | undefined;
  try {
    const buf = await readFile(filePath);
    hash = createHash("sha256").update(buf).digest("hex");
    if (indexedConfigHashes.get(filePath) === hash) return;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      indexedConfigHashes.delete(filePath);
      return;
    }
    /* intentional: hash failure is non-fatal — fall through and try to index */
  }

  // The adapter owns transport (URL join + auth headers + 60000ms timeout +
  // non-2xx/transport classification). The OV error-prose classification below
  // — distinguishing a removed file from a transient conflict from a real
  // failure — is domain behaviour and stays here, reading the failure arm's
  // `body` (the raw non-2xx response text) instead of re-spelling a fetch.
  const result = await ovPostJson(
    "/api/v1/resources",
    { path: containerPath, to: targetUri },
    { timeout: 60000 },
  );
  if (!isOvFailure(result)) {
    if (hash) indexedConfigHashes.set(filePath, hash);
    console.log(`[Learning:Indexer] Indexed file: ${rel} -> ${targetUri}`);
  } else {
    const err = result.body ?? "";
    if (err.includes("not exist") || err.includes("ENOENT")) {
      console.log(`[Learning:Indexer] Skipped (removed): ${rel}`);
      indexedConfigHashes.delete(filePath);
    } else if (err.includes("file exists") || err.includes("point lock")) {
      console.warn(
        `[Learning:Indexer] Transient OV conflict on ${rel} — will retry on next change: ${err.slice(0, 160)}`
      );
    } else {
      console.error(
        `[Learning:Indexer] Failed to index ${rel}: ${result.code} ${err.slice(0, 200)}`
      );
    }
  }
}

/**
 * Index an arbitrary text blob by uploading it as a temp file then
 * registering it as a hydra-memory resource. Used for Redis-derived
 * content (reality reports, memory patterns) and source-file payloads.
 */
export async function indexText(title: string, content: string): Promise<void> {
  const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const tmpFile = join(tmpdir(), `hydra-indexer-${safeName}-${Date.now()}.md`);
  try {
    await writeFile(tmpFile, `# ${title}\n\n${content}`, "utf-8");

    const { readFile: rf } = await import("node:fs/promises");
    const fileContent = await rf(tmpFile);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([fileContent], { type: "text/markdown" }),
      `${safeName}.md`
    );

    // Multipart upload through the adapter (drops the JSON Content-Type so
    // FormData sets its own boundary; keeps X-Api-Key; 30000ms timeout).
    const uploadResult = await ovPostForm<any>(
      "/api/v1/resources/temp_upload",
      formData,
      { timeout: 30000 },
    );

    if (!isOvFailure(uploadResult)) {
      // OpenViking wraps responses as {status, result, error, telemetry}.
      // The temp_upload endpoint returns the path under `result.temp_path` —
      // older code read `uploadData.temp_path` directly and silently no-op'd
      // on every call (issue #313 in src/redis/work-queue.ts; same bug here
      // per #318). Read both wrapped and legacy unwrapped shapes for safety.
      const uploadData = uploadResult.data;
      const result = uploadData?.result ?? {};
      const tempPath =
        result.temp_path ?? result.path ?? uploadData.temp_path ?? uploadData.path;

      if (tempPath) {
        const addResult = await ovPostJson(
          "/api/v1/resources",
          {
            temp_path: tempPath,
            to: `viking://resources/hydra-memory/${safeName}`,
          },
          { timeout: 60000 },
        );
        if (!isOvFailure(addResult)) {
          console.log(`[Learning:Indexer] Indexed text: ${title}`);
        } else {
          console.error(
            `[Learning:Indexer] Failed to add text "${title}": ${addResult.code} body=${(addResult.body ?? "").slice(
              0,
              200
            )}`
          );
        }
      } else {
        // Fail loud (CLAUDE.md convention): log the full response body so a
        // future API shape change is debuggable from logs alone.
        console.error(
          `[Learning:Indexer] indexText "${title}": no temp_path in upload response — body=${JSON.stringify(
            uploadData
          ).slice(0, 300)}`
        );
      }
    } else {
      console.error(
        `[Learning:Indexer] Failed to upload text "${title}": ${uploadResult.code} body=${(uploadResult.body ?? "").slice(
          0,
          200
        )}`
      );
    }
  } catch (err: any) {
    console.error(
      `[Learning:Indexer] Failed to index text "${title}": ${err.message}`
    );
  } finally {
    await unlink(tmpFile).catch(() => {
      /* intentional: best-effort temp file cleanup */
    });
  }
}

// ===========================================================================
// SECTION 2 — Source-file indexing (formerly source-indexer.ts, issue #210).
//
// Responsibility: enumerate src/, docs/, test/ trees, hash-dedupe their
// contents, and push them through indexText so agents can semantically
// retrieve actual implementation context (not just config + reports).
//
// Pure helpers (parseSourcePaths, shouldIndexSource, enumerateSourceFiles,
// buildSourceTitle, runSourceInitialPass, getCoverageStats,
// resetCoverageStats) are unit-tested via test/knowledge-indexer.test.mts.
// ===========================================================================

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

const SOURCE_PATHS: SourcePath[] = parseSourcePaths(
  process.env.HYDRA_INDEX_SOURCE_PATHS || DEFAULT_SOURCE_SPEC
);
// Files modified within this window get the initial-index pass on startup.
const SOURCE_INITIAL_WINDOW_MS =
  parseInt(process.env.HYDRA_INDEX_INITIAL_DAYS as any) > 0
    ? parseInt(process.env.HYDRA_INDEX_INITIAL_DAYS as any) * 86400_000
    : 7 * 86400_000;

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
 * Set the watchedPaths summary that the indexer reports through
 * getCoverageStats (#210). Called by IndexerController.start() so the
 * /api/learning/coverage endpoint reflects the live watch set; kept here so
 * the array stays colocated with the stats it mutates (issue #2523, INV-5).
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
  } = {}
): Promise<{ scanned: number; indexed: number; skipped: number }> {
  const paths = opts.paths ?? SOURCE_PATHS;
  const windowMs = opts.windowMs ?? SOURCE_INITIAL_WINDOW_MS;
  const now = opts.now ?? Date.now();
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
      if (result === "indexed") indexed++;
      else if (result === "skipped") skipped++;
    }
  }
  return { scanned, indexed, skipped };
}

/**
 * Build a fs.watch callback that debounces source-file changes through a
 * shared `pending` map and indexes them via indexSourceFile. The map +
 * debounce window are owned by the caller (startKnowledgeIndexer) so the
 * config watcher and source watcher share a single dedup queue.
 *
 * Exported (issue #2523 forward-fix) so IndexerController consumes the single
 * canonical source-watcher by import (INV-5) instead of re-implementing it —
 * the #2526 extraction's local copy uploaded a "Source file changed" text blob
 * via indexText, dropping the real indexSourceFile content-index + hash-dedup.
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

// ===========================================================================
// SECTION 3 — Source-index staleness probe (formerly source-freshness.ts,
// issue #2267).
//
// THE PROBLEM. The source indexer (above) keeps a durable Redis dedup map
// (`src/redis/source-index.ts`, issue #1123) of `path -> sha1` so it can skip
// re-embedding unchanged files across the orchestrator's dozens-of-bounces-a-
// day. That cache is correct as long as OpenViking still holds what the cache
// claims it indexed. But if OpenViking is reset/restarted out from under the
// cache (container reset, deployment, volume wipe), the cache still says "all
// 633 files indexed" so the indexer skips every file — and the knowledge base
// stays empty. Agents then search an empty source index and lose semantic
// access to prior implementations.
//
// WHY NOT coverageStats.resourceCount. The naive fix ("clear the cache when
// hashes>0 and resourceCount==0") is a footgun: `resourceCount` is a per-process
// counter that resets to 0 on every restart and only increments on an actual
// upload. On a HEALTHY restart everything is a cache-hit skip, so resourceCount
// stays 0 while OV is fully indexed — the condition fires on every normal bounce
// and would re-embed the whole tree every time, undoing #1123. So resourceCount
// is unusable as the OV-truth signal.
//
// THE SOUND SIGNAL. OpenViking exposes no resource-count/list verb
// (`GET /api/v1/resources` -> Method Not Allowed), so a count-vs-count compare
// is not implementable. The only available probe is `POST /api/v1/search/find`.
// Indexed source/config content lands under `viking://resources/...` (the
// source-indexer's `indexText` -> `viking://resources/hydra-memory/...`, the
// config indexer -> `viking://resources/...`), whereas transient uploads land
// under `viking://temp/...`. So "OV holds indexed source resources" is decided
// by: does a targeted search return ANY result URI under `viking://resources/`?
// A stale (reset) OV returns only `viking://temp/...` URIs (or nothing); a
// healthy OV returns at least one `viking://resources/...` hit.
//
// The search call is injectable so it is unit-testable without a live OV, and it
// is best-effort/never-throw — on any error it reports "present" (the safe
// direction: do NOT clear the cache on an inconclusive probe).
// ===========================================================================

/** Prefix every indexed (non-transient) OV resource URI carries. */
export const OV_RESOURCE_URI_PREFIX = "viking://resources/";

/**
 * The probe query. Deliberately matches the kind of content the source-indexer
 * uploads (source files indexed under the `hydra-source:` title convention) so a
 * healthy OV returns a `viking://resources/` hit. Generic enough that a fully
 * indexed tree always matches at least one resource.
 */
const SOURCE_FRESHNESS_PROBE_QUERY = "hydra source architecture implementation";

/**
 * Injectable search seam: returns the raw result arrays from OpenViking. Defaults
 * to the production {@link trackedOvSearch}; tests pass a fake to drive the
 * present/absent/error branches without a live OV.
 */
export type OvSearchFn = (
  query: string,
  limit?: number,
) => Promise<{ resources: any[]; memories: any[] }>;

/**
 * Pure URI test: does this list contain any URI under `viking://resources/`?
 * Exported for unit tests; tolerant of malformed entries (missing/non-string
 * uri fields are ignored, never throw).
 */
export function hasIndexedResourceUri(
  results: Array<{ uri?: unknown }> | null | undefined,
): boolean {
  if (!Array.isArray(results)) return false;
  for (const r of results) {
    const uri = r?.uri;
    if (typeof uri === "string" && uri.startsWith(OV_RESOURCE_URI_PREFIX)) {
      return true;
    }
  }
  return false;
}

/**
 * Probe OpenViking for whether ANY indexed source/config resource is present
 * (a result URI under `viking://resources/`). Best-effort and never throws.
 *
 * Returns `true` (present) on:
 *   - at least one `viking://resources/...` hit, OR
 *   - any probe error (the SAFE default — an inconclusive probe must NOT be read
 *     as "OV is empty", because that would trigger a destructive cache clear and
 *     a full re-index on a transient OV hiccup).
 * Returns `false` (absent) ONLY when the probe succeeds and returns zero
 * `viking://resources/` URIs (only temp uploads, or nothing) — the genuine
 * "OV was reset out from under the cache" signal.
 */
export async function probeOvSourceResourcesPresent(
  search: OvSearchFn = trackedOvSearch,
): Promise<boolean> {
  try {
    const { resources, memories } = await search(SOURCE_FRESHNESS_PROBE_QUERY, 5);
    return hasIndexedResourceUri([...(resources || []), ...(memories || [])]);
  } catch (err: any) {
    // Fail safe (CLAUDE.md "fail loud" + never-throw): log, then report present
    // so the caller does NOT clear the cache on a probe failure.
    console.error(
      `[source-freshness] probe failed: ${err?.message || String(err)} — defaulting to present (no clear)`,
    );
    return true;
  }
}


// ===========================================================================
// SECTION 4 — Background indexer lifecycle (formerly knowledge-indexer.ts,
// issue #219). Extracted into IndexerController (issue #2523).
//
// The lifecycle state (indexerInterval, lastRuleCounts, indexerPending) and
// the free functions (startKnowledgeIndexer / stopKnowledgeIndexer) now live
// in src/knowledge-base/indexer-lifecycle.ts as a named, testable class.
// The thin delegators below keep import paths zero-diff for all callers.
//
// See IndexerController in indexer-lifecycle.ts for the full implementation
// and HeartbeatController (#2195) for the pattern rationale.
// ===========================================================================

export {
  IndexerController,
  startKnowledgeIndexer,
  stopKnowledgeIndexer,
} from "./indexer-lifecycle.ts";
export type { IndexerControllerDeps } from "./indexer-lifecycle.ts";
