/**
 * hash-dedup.ts — HashDedupAdapter: the dedup + coverage state boundary
 * (issue #3229).
 *
 * Extracted from src/knowledge-base/indexer.ts Section 1a.
 *
 * PURPOSE OF THIS EXTRACTION
 * indexer.ts and indexer-lifecycle.ts formed a bidirectional import cycle:
 *   - indexer-lifecycle.ts imported HashDedupAdapter + defaultHashAdapter FROM indexer.ts
 *   - indexer.ts re-exported IndexerController FROM indexer-lifecycle.ts
 *
 * The cycle caused a production ReferenceError: Cannot access 'defaultHashAdapter'
 * before initialization (documented at indexer-lifecycle.ts line ~428 and patched
 * with lazy construction of defaultController). Extracting the dedup state into
 * this zero-circular leaf breaks the cycle: both indexer.ts and indexer-lifecycle.ts
 * now import DOWN from this leaf; neither imports from the other for these symbols.
 *
 * WHAT LIVES HERE
 * - CoverageStats             — the coverage stats shape for /api/learning/coverage
 * - HashDedupPersistence      — injectable persistence overrides for HashDedupAdapter
 * - HashDedupAdapter          — the dedup + coverage state boundary (class)
 * - defaultHashAdapter        — the production-shared singleton instance
 *
 * WHAT DOES NOT LIVE HERE
 * - indexText / indexerTargetUri  — OV upload primitives (ov-upload.ts)
 * - source-file enumeration       — source-enumerator.ts
 * - staleness probe               — indexer.ts (probeOvSourceResourcesPresent)
 * - lifecycle controller          — indexer-lifecycle.ts
 *
 * All external callers that previously imported these from indexer.ts continue
 * to do so; indexer.ts re-exports from this leaf (INV-2 zero-diff specifiers).
 */

import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, basename } from "node:path";
import { createHash } from "node:crypto";

// Issue #954: OV HTTP requests route through the OpenViking Request Adapter.
import {
  ovPostJson,
  isOvFailure,
} from "./ov-request.ts";
// Issue #3044: OV upload primitives live in the focused leaf ov-upload.ts.
import { indexText, indexerTargetUri } from "./ov-upload.ts";
// Issue #1123: durable Redis persistence for the source dedup map.
import {
  loadSourceHashes as redisLoadSourceHashes,
  persistSourceHash as redisPersistSourceHash,
} from "../redis/source-index.ts";
// Issue #2767: pure source-file enumeration helpers moved to source-enumerator.ts.
// source-enumerator.ts is a pure filesystem leaf with zero imports from this module
// (no cycle introduced).
import {
  shouldIndexSource,
  enumerateSourceFiles,
  buildSourceTitle,
  DEFAULT_SOURCE_PATHS,
  type SourcePath,
} from "./source-enumerator.ts";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Constants (preserved from indexer.ts Section 1a and Section 2).
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.HYDRA_CONFIG_PATH ||
  resolve(process.env.HOME!, "hydra", "config");
const OV_CONFIG_MOUNT = process.env.OV_CONFIG_MOUNT || "/config";
const DEBOUNCE_MS = parseInt(process.env.INDEXER_DEBOUNCE_MS as any) || 2000;
const SOURCE_INITIAL_WINDOW_MS =
  parseInt(process.env.HYDRA_INDEX_INITIAL_DAYS as any) > 0
    ? parseInt(process.env.HYDRA_INDEX_INITIAL_DAYS as any) * 86400_000
    : 7 * 86400_000;
// SOURCE_PATHS is the module-private alias for the shared default the initial
// pass falls back to when no explicit `paths` override is supplied.
const SOURCE_PATHS: SourcePath[] = DEFAULT_SOURCE_PATHS;

// ===========================================================================
// SECTION 1a — HashDedupAdapter: the dedup + coverage state boundary
// (originally issue #2603; extracted to this leaf by issue #3229).
//
// Formerly five module-level mutable singletons in indexer.ts (indexedConfigHashes,
// indexedSourceHashes, loadHashesImpl, persistHashImpl, coverageStats) reset
// only through the `_setHashPersistence` test-only escape-hatch. This class
// concentrates that state in one instance boundary. Constructing a fresh adapter
// starts fresh maps and re-wires the persistence seam from the constructor
// arguments — so tests inject persistence through the normal constructor path
// (no escape-hatch) and IndexerController that owns an adapter owns its dedup
// state. Production shares a single {@link defaultHashAdapter} so the running
// indexer and the controller-less API reader (getCoverageStats() in
// src/api/openviking.ts) observe the SAME state (INV-4).
// ===========================================================================

/** Issue #210: knowledge coverage stats for /api/learning/coverage */
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
      logger.info({ rel, targetUri }, "[Learning:Indexer] Indexed file");
    } else {
      const err = result.body ?? "";
      if (err.includes("not exist") || err.includes("ENOENT")) {
        logger.info({ rel }, "[Learning:Indexer] Skipped (removed)");
        this.indexedConfigHashes.delete(filePath);
      } else if (err.includes("file exists") || err.includes("point lock")) {
        logger.warn(
          { rel, body: err.slice(0, 160) },
          "[Learning:Indexer] Transient OV conflict — will retry on next change",
        );
      } else {
        logger.error(
          { rel, code: result.code, body: err.slice(0, 200) },
          "[Learning:Indexer] Failed to index file",
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

  /**
   * Narrow, read-only fallback-corpus getter (issue #3341): the merged set of
   * file paths this adapter currently knows as indexed — the source-file dedup
   * map (hydrated from the durable Redis `hydra:knowledge:source-hashes` copy
   * on startup, #1123) plus the config-tree hash map. Returns a defensive
   * snapshot; NO Redis read, no mutation surface — the private maps stay
   * private. Consumed by `trackedOvSearch`'s lexical-distance fallback ranking
   * (ov-search.ts) when OpenViking is unavailable; an unhydrated/empty adapter
   * returns `[]` and the search degrades to the pre-#3341 empty result.
   */
  getIndexedPaths(): string[] {
    const merged = new Set<string>(this.indexedSourceHashes.keys());
    for (const path of this.indexedConfigHashes.keys()) merged.add(path);
    return [...merged];
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
        logger.error(
          { path: filePath, err },
          "[Learning:Indexer] readFile failed",
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
            logger.error(
              { path: fullPath, err },
              "[Learning:Indexer] Source change index failed",
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
 * routed through the free-function delegators in indexer.ts) observe THIS single
 * object — the invariant that a fresh IndexerController must not orphan the
 * API view (issue #2603 INV-4).
 */
export const defaultHashAdapter = new HashDedupAdapter();
