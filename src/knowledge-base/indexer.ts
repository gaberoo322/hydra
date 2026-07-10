/**
 * indexer.ts — consolidated OpenViking source/config indexing cluster (issue #2354).
 *
 * This module merges the formerly-separate shallow indexing modules that
 * together formed one coupled cluster layered over the OpenViking Request
 * Adapter Seam (`ov-request.ts`) and the search Seam (`ov-search.ts`):
 *
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
 * Issue #3044: the low-level OV upload primitives (indexText, indexerTargetUri,
 * IndexTextOptions, and the add-resource retry policy) were extracted into the
 * focused leaf `ov-upload.ts` — pure HTTP transport + retry policy with zero
 * Redis and zero domain knowledge of which files to index. They are imported
 * back here and re-exported below so all existing callers keep a zero-diff
 * import specifier (INV-2). Dependency flows ov-upload <- indexer, never the
 * reverse (INV-4, no circular import) — the same downward-edge idiom as the
 * source-enumerator.ts extraction (#2767). What REMAINS here is the domain-
 * orchestration surface: HashDedupAdapter (dedup + coverage state) + the
 * source-file indexer (which files, when) + the freshness probe.
 *
 * Behavior is preserved 1:1 from the source files. Public symbols are
 * unchanged so importers only update their import specifier. The previous
 * file-level history references (#210, #211, #219, #313, #318, #866, #954,
 * #965, #1123, #2267) are retained inline at each block.
 */

import { readFile, stat } from "node:fs/promises";
import {
  join,
  resolve,
  relative,
  basename,
} from "node:path";
import { createHash } from "node:crypto";

// Issue #954: OV HTTP requests route through the OpenViking Request Adapter,
// which owns the URL join + auth headers + timeout + error classification +
// JSON/text unwrap. The config-file index path below keeps its OV error-prose
// classification — pure domain behaviour layered on the transport.
import {
  ovPostJson,
  isOvFailure,
} from "./ov-request.ts";
import { trackedOvSearch } from "./ov-search.ts";
// Issue #3044: the OV upload primitives (indexText / indexerTargetUri +
// IndexTextOptions + the add-resource retry policy) were extracted into the
// focused leaf ov-upload.ts. HashDedupAdapter composes indexText/indexerTargetUri
// from here; indexer.ts re-exports them below so callers (indexer-lifecycle.ts,
// learning-lifecycle.ts, tests) keep a zero-diff import specifier (INV-2).
import { indexText, indexerTargetUri } from "./ov-upload.ts";
import {
  loadSourceHashes as redisLoadSourceHashes,
  persistSourceHash as redisPersistSourceHash,
} from "../redis/source-index.ts";
// Issue #2767: the pure source-file enumeration + path helpers were extracted
// into source-enumerator.ts (a zero-OV, purely-filesystem module). Import them
// back here; indexer.ts re-exports them below so all existing callers keep a
// zero-diff import specifier (INV-2). Dependency flows enumerator <- indexer
// only — never the reverse (INV-4, no circular import).
import {
  shouldIndexSource,
  enumerateSourceFiles,
  buildSourceTitle,
  DEFAULT_SOURCE_PATHS,
  type SourcePath,
} from "./source-enumerator.ts";

// ---------------------------------------------------------------------------
// Shared constants (deduped across the merged modules — identical definitions).
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.HYDRA_CONFIG_PATH ||
  resolve(process.env.HOME!, "hydra", "config");
const OV_CONFIG_MOUNT = process.env.OV_CONFIG_MOUNT || "/config";
// SKIP_DIRS moved to source-enumerator.ts (issue #2767) with the pure walk/
// filter helpers; indexer.ts no longer references it directly.
const DEBOUNCE_MS = parseInt(process.env.INDEXER_DEBOUNCE_MS as any) || 2000;

// Issue #3044: the add-resource retry policy + the OV upload helpers (indexText,
// indexerTargetUri, IndexTextOptions, isRetryableAddResource, the retry-tuning
// constants) were extracted into the focused leaf ov-upload.ts. HashDedupAdapter
// (Section 1a) composes indexText / indexerTargetUri from there, and those two are
// re-exported below for zero-diff callers. isRetryableAddResource + IndexTextOptions
// stay internal to ov-upload.ts — no caller imported them via this facade (#3062).

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
// context, not just config + reports. The env-derived default spec + its
// parsed SourcePath[] (HYDRA_ROOT_FOR_SOURCE / DEFAULT_SOURCE_SPEC /
// DEFAULT_SOURCE_PATHS) moved to source-enumerator.ts (issue #2850) so this
// module and indexer-lifecycle.ts share a single definition instead of each
// re-deriving it from process.env. SourcePath + parseSourcePaths already moved
// there in #2767 (imported back above, re-exported below for zero-diff callers,
// INV-2).

// SOURCE_PATHS is the module-private alias for the shared default the initial
// pass falls back to when no explicit `paths` override is supplied.
const SOURCE_PATHS: SourcePath[] = DEFAULT_SOURCE_PATHS;
// Files modified within this window get the initial-index pass on startup.
const SOURCE_INITIAL_WINDOW_MS =
  parseInt(process.env.HYDRA_INDEX_INITIAL_DAYS as any) > 0
    ? parseInt(process.env.HYDRA_INDEX_INITIAL_DAYS as any) * 86400_000
    : 7 * 86400_000;

// Issue #210: knowledge coverage stats for /api/learning/coverage
export interface CoverageStats {
  resourceCount: number;
  sourceFilesIndexed: number;
  sourceFilesSkipped: number;
  lastIndexAt: string | null;
  watchedPaths: string[];
}

// Persistence seam (issue #1123). Defaults to the real Redis accessors but is
// swappable so tests can drive the load/persist behavior without a live Redis.
// Both default impls are best-effort no-ops on a Redis error (the indexer then
// degrades to the pre-#1123 re-upload behavior — wasteful but correct).
type LoadHashesFn = () => Promise<Map<string, string>>;
type PersistHashFn = (path: string, hash: string) => Promise<void>;

/**
 * Injectable persistence overrides for {@link HashDedupAdapter}. Replaces the
 * deleted `_setHashPersistence` module-global escape-hatch (issue #2603): a
 * test now constructs an adapter with these overrides and gets a FRESH hash
 * map automatically — no cross-case dedup leakage, no reset required.
 */
export interface HashDedupPersistence {
  load?: LoadHashesFn;
  persist?: PersistHashFn;
}

// ===========================================================================
// SECTION 1a — HashDedupAdapter: the dedup + coverage state boundary
// (issue #2603).
//
// Formerly five module-level mutable singletons (indexedConfigHashes,
// indexedSourceHashes, loadHashesImpl, persistHashImpl, coverageStats) reset
// only through the `_setHashPersistence` test-only escape-hatch. That split-
// brain meant restarting IndexerController (the lifecycle owner) did NOT
// restart the dedup adapter (the hash maps): the two halves of the knowledge-
// base indexer were structurally decoupled.
//
// This class concentrates that state in one instance boundary. Constructing a
// fresh adapter starts fresh maps and re-wires the persistence seam from the
// constructor arguments — so tests inject persistence through the normal
// constructor path (no escape-hatch) and IndexerController that owns an adapter
// owns its dedup state. Production shares a single {@link defaultHashAdapter}
// so the running indexer and the controller-less API reader
// (getCoverageStats() in src/api/openviking.ts) observe the SAME state (INV-4).
// ===========================================================================
export class HashDedupAdapter {
  // Per-file config-tree content hashes so unchanged re-writes (priorities-agent
  // rewriting the same content, fs.watch firing twice, etc.) skip the OV
  // round-trip. Formerly the module-global indexedConfigHashes.
  private readonly indexedConfigHashes = new Map<string, string>();

  // Path-based source dedup: tracks indexed source paths + content hash so we
  // skip re-uploading unchanged files. This in-memory Map is a hot read cache
  // for the per-file index path; the durable copy lives in Redis (issue #1123)
  // and is hydrated into this Map on startup via loadPersistedHashes() and
  // written through on each successful index. Before #1123 this Map was
  // in-memory ONLY and reset on every restart, so each of the orchestrator's
  // dozens-per-day bounces re-embedded the whole modified-window tree (~13k
  // "Indexed text:" lines/day) for zero new information. Formerly the
  // module-global indexedSourceHashes.
  private readonly indexedSourceHashes = new Map<string, string>();

  // Persistence seam (issue #1123), wired from the constructor. Formerly the
  // module-global loadHashesImpl / persistHashImpl let-bindings.
  private readonly loadHashesImpl: LoadHashesFn;
  private readonly persistHashImpl: PersistHashFn;

  // Coverage stats for /api/learning/coverage (#210). Formerly the
  // module-global coverageStats object.
  private readonly coverageStats: CoverageStats = {
    resourceCount: 0,
    sourceFilesIndexed: 0,
    sourceFilesSkipped: 0,
    lastIndexAt: null,
    watchedPaths: [],
  };

  constructor(persistence: HashDedupPersistence = {}) {
    this.loadHashesImpl = persistence.load ?? redisLoadSourceHashes;
    this.persistHashImpl = persistence.persist ?? redisPersistSourceHash;
  }

  /**
   * Index a file already mounted into the OV container (config tree).
   * Tells OV to ingest the file by container-relative path, WITH per-file
   * SHA-256 hash-dedup via the instance-owned config-hash map — the OV
   * container-path ingestion (`/api/v1/resources` with `path:/config/<rel>,
   * to:viking://resources/<rel>`). This is the config-file index path
   * IndexerController.onFileChange fires (INV-1); it must NOT be indexText.
   */
  async indexFile(filePath: string): Promise<void> {
    const rel = relative(CONFIG_PATH, filePath);
    const containerPath = join(OV_CONFIG_MOUNT, rel);
    const targetUri = indexerTargetUri(rel);

    let hash: string | undefined;
    try {
      const buf = await readFile(filePath);
      hash = createHash("sha256").update(buf).digest("hex");
      if (this.indexedConfigHashes.get(filePath) === hash) return;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        this.indexedConfigHashes.delete(filePath);
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
      if (hash) this.indexedConfigHashes.set(filePath, hash);
      console.log(`[Learning:Indexer] Indexed file: ${rel} -> ${targetUri}`);
    } else {
      const err = result.body ?? "";
      if (err.includes("not exist") || err.includes("ENOENT")) {
        console.log(`[Learning:Indexer] Skipped (removed): ${rel}`);
        this.indexedConfigHashes.delete(filePath);
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
   * Hydrate the in-memory dedup cache from the durable Redis copy. Call once on
   * startup (from IndexerController.start()) BEFORE the initial-index pass so
   * files unchanged since a previous process's run are recognised as
   * already-indexed and skipped instead of re-embedded. Best-effort: a load
   * failure leaves the cache as-is (empty on a cold start), degrading to the
   * old re-upload behavior. Returns the number of entries loaded.
   */
  async loadPersistedHashes(): Promise<number> {
    const persisted = await this.loadHashesImpl();
    for (const [path, hash] of persisted) {
      // Don't clobber a hotter in-memory entry written this process lifetime.
      if (!this.indexedSourceHashes.has(path)) {
        this.indexedSourceHashes.set(path, hash);
      }
    }
    return persisted.size;
  }

  /** Snapshot of the coverage stats (defensive copy of watchedPaths). */
  getCoverageStats(): CoverageStats {
    return {
      ...this.coverageStats,
      watchedPaths: [...this.coverageStats.watchedPaths],
    };
  }

  /**
   * Reset coverage stats + clear the in-memory source-hash cache. Simulates a
   * process restart (drops the hot cache; the durable Redis copy is untouched).
   * Retained for the module-level test/reset delegator.
   */
  resetCoverageStats(): void {
    this.coverageStats.resourceCount = 0;
    this.coverageStats.sourceFilesIndexed = 0;
    this.coverageStats.sourceFilesSkipped = 0;
    this.coverageStats.lastIndexAt = null;
    this.coverageStats.watchedPaths = [];
    this.indexedSourceHashes.clear();
  }

  /**
   * Set the watchedPaths summary that the indexer reports through
   * getCoverageStats (#210). Called by IndexerController.start() so the
   * /api/learning/coverage endpoint reflects the live watch set (issue #2523,
   * INV-5).
   */
  setWatchedPaths(paths: string[]): void {
    this.coverageStats.watchedPaths = paths;
  }

  /**
   * Index a single source file through indexText, with content-hash dedup and
   * write-through persistence. Private to the adapter — callers use
   * runSourceInitialPass / makeSourceWatcher.
   */
  private async indexSourceFile(
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
    const prev = this.indexedSourceHashes.get(filePath);
    if (prev === hash) {
      this.coverageStats.sourceFilesSkipped++;
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
    this.indexedSourceHashes.set(filePath, hash);
    // Write through to the durable copy so the next process restart can skip this
    // file (issue #1123). Best-effort — persistHashImpl swallows Redis errors.
    await this.persistHashImpl(filePath, hash);
    this.coverageStats.sourceFilesIndexed++;
    this.coverageStats.resourceCount++;
    this.coverageStats.lastIndexAt = new Date().toISOString();
    return "indexed";
  }

  /**
   * Initial-index pass: enumerate, filter to recently-modified, upload missing.
   * Returns counts for tests + logging. Idempotent across restarts (hash-based).
   */
  async runSourceInitialPass(
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
        const result = await this.indexSourceFile(file, source);
        if (result === "indexed") indexed++;
        else if (result === "skipped") skipped++;
      }
    }
    return { scanned, indexed, skipped };
  }

  /**
   * Build a fs.watch callback that debounces source-file changes through a
   * shared `pending` map and indexes them via this adapter's indexSourceFile.
   * The map + debounce window are owned by the caller (IndexerController) so
   * the config watcher and source watcher share a single dedup queue.
   *
   * Consumed by import (INV-5) — IndexerController uses the single canonical
   * source-watcher rather than re-implementing it. The #2526 extraction's local
   * copy uploaded a "Source file changed" text blob via indexText, dropping the
   * real indexSourceFile content-index + hash-dedup.
   */
  makeSourceWatcher(
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
          this.indexSourceFile(fullPath, source).catch((err: any) =>
            console.error(
              `[Learning:Indexer] Source change index failed for ${fullPath}: ${err.message}`
            )
          );
        }, debounceMs)
      );
    };
  }
}

/**
 * Production-shared dedup + coverage adapter. Both the running indexer
 * (via IndexerController, which defaults to this instance) and the
 * controller-less API reader (getCoverageStats() in src/api/openviking.ts,
 * routed through the free-function delegators below) observe THIS single
 * object — the invariant that a fresh IndexerController must not orphan the
 * API view (issue #2603 INV-4).
 */
export const defaultHashAdapter = new HashDedupAdapter();

// ---------------------------------------------------------------------------
// Free-function delegators (interfaceImpact:none — issue #2603 INV-6).
//
// External callers (src/api/openviking.ts, tests, indexer-lifecycle.ts) keep
// their existing import specifiers + signatures. Each delegates to the
// production-shared defaultHashAdapter so the module-level surface is a thin
// facade over the single shared state object.
// ---------------------------------------------------------------------------

/** @see HashDedupAdapter.getCoverageStats */
export function getCoverageStats(): CoverageStats {
  return defaultHashAdapter.getCoverageStats();
}

/** @see HashDedupAdapter.resetCoverageStats (test-only reset of shared state) */
export function resetCoverageStats(): void {
  defaultHashAdapter.resetCoverageStats();
}

/** @see HashDedupAdapter.runSourceInitialPass */
export function runSourceInitialPass(opts: {
  paths?: SourcePath[];
  windowMs?: number;
  now?: number;
} = {}): Promise<{ scanned: number; indexed: number; skipped: number }> {
  return defaultHashAdapter.runSourceInitialPass(opts);
}

// Issue #2767: shouldIndexSource / enumerateSourceFiles / buildSourceTitle
// (the pure source-file enumeration + title helpers) moved to
// source-enumerator.ts. Re-exported here (alongside parseSourcePaths +
// SourcePath) so external callers (tests, indexer-lifecycle.ts) keep their
// existing `from "./indexer.ts"` import specifiers unchanged (INV-2) — the
// same facade-re-export idiom used for IndexerController below and the
// coverage/source-pass delegators above.
export {
  parseSourcePaths,
  shouldIndexSource,
  enumerateSourceFiles,
  buildSourceTitle,
} from "./source-enumerator.ts";
export type { SourcePath } from "./source-enumerator.ts";

// Issue #3044: the OV upload primitives moved to ov-upload.ts. Re-exported here
// (alongside the source-enumerator re-exports above) so external callers
// (indexer-lifecycle.ts, learning-lifecycle.ts, tests) keep their existing
// `from "./indexer.ts"` import specifiers unchanged (INV-2) — the same facade-
// re-export idiom used for the source-enumerator helpers and the IndexerController
// delegators. Only the two symbols HashDedupAdapter actually composes (indexText,
// indexerTargetUri) are re-exported; isRetryableAddResource + IndexTextOptions
// import from ov-upload.ts directly (unused via this facade — issue #3062).
export {
  indexText,
  indexerTargetUri,
} from "./ov-upload.ts";

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
