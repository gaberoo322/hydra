/**
 * indexer-lifecycle.ts — Background indexer lifecycle controller (issue #2523).
 *
 * Extracted from src/knowledge-base/indexer.ts Section 4, following the
 * HeartbeatController pattern (#2195). Section 4's three module-level mutable
 * singletons:
 *
 *   - indexerInterval   — the Redis-poll setInterval handle
 *   - lastRuleCounts    — per-agent pattern count (diff-detects new patterns)
 *   - indexerPending    — the debounce timer map shared by config + source watchers
 *
 * ...are now owned as private instance state of {@link IndexerController}.
 * The constructor accepts an optional {@link IndexerControllerDeps} bag so
 * tests can construct a fresh controller per case with injected stubs — no
 * module-level state to reset between cases (the exact testability win
 * HeartbeatController delivered for src/scheduler/heartbeat.ts).
 *
 * The module-level functions `startKnowledgeIndexer` / `stopKnowledgeIndexer`
 * are thin delegators to a {@link defaultController} singleton so all existing
 * callers (src/learning-lifecycle.ts, src/index.ts) remain zero-diff on their
 * import paths (interfaceImpact: none).
 *
 * Sections 1-3 of indexer.ts (OV upload helpers, source-file enumeration +
 * hash-dedup, staleness probe) are pure functions that remain in indexer.ts.
 * The lifecycle controller calls them via the deps bag (injectable for tests).
 */

import { watch } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { getMemoryPatterns } from "../redis/agent-memory.ts";
import {
  indexFile,
  indexText,
  loadPersistedHashes,
  makeSourceWatcher,
  runSourceInitialPass,
  setWatchedPaths,
  parseSourcePaths,
  type SourcePath,
} from "./indexer.ts";

// ---------------------------------------------------------------------------
// Internal constants (Section 4 — preserved 1:1 from indexer.ts)
// ---------------------------------------------------------------------------

const CONFIG_PATH =
  process.env.HYDRA_CONFIG_PATH ||
  resolve(process.env.HOME!, "hydra", "config");
const SKIP_DIRS = new Set([".git", "node_modules"]);
const DEBOUNCE_MS = parseInt(process.env.INDEXER_DEBOUNCE_MS as any) || 2000;
const INDEXABLE_EXTS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
const REDIS_POLL_MS = parseInt(process.env.INDEXER_POLL_MS as any) || 30000;

// Derive the default source paths the same way indexer.ts Section 2 does
// (reading HYDRA_INDEX_SOURCE_PATHS from env). This avoids exporting the
// private SOURCE_PATHS constant from indexer.ts.
const HYDRA_ROOT_FOR_SOURCE =
  process.env.HYDRA_ROOT || resolve(process.env.HOME!, "hydra");
const DEFAULT_SOURCE_SPEC_LC = `${HYDRA_ROOT_FOR_SOURCE}/src:.ts,${HYDRA_ROOT_FOR_SOURCE}/docs:.md,${HYDRA_ROOT_FOR_SOURCE}/test:.mts`;
const DEFAULT_SOURCE_PATHS: SourcePath[] = parseSourcePaths(
  process.env.HYDRA_INDEX_SOURCE_PATHS || DEFAULT_SOURCE_SPEC_LC
);

// ---------------------------------------------------------------------------
// Injectable deps surface
// ---------------------------------------------------------------------------

/**
 * Injectable production implementations for IndexerController. Every dep
 * defaults to the real side-effecting implementation; tests supply stubs.
 *
 * @see HeartbeatControllerDeps in src/scheduler/heartbeat.ts
 */
export interface IndexerControllerDeps {
  /** Poll memory patterns for a given agent. Defaults to getMemoryPatterns. */
  getMemoryPatterns?: (agent: string) => Promise<string | null>;

  /**
   * Index a config-tree file via OV container-path ingestion (with per-file
   * SHA-256 hash-dedup). Defaults to indexFile from indexer.ts. This is the
   * config-file index path used by onFileChange — NOT indexText. Restoring
   * this dep (issue #2523) reverts the #2526 regression that re-routed config
   * changes through the blob-upload (indexText) path.
   */
  indexFile?: (filePath: string) => Promise<void>;

  /**
   * Upload arbitrary text to OV (blob-upload to the hydra-memory/ namespace).
   * Defaults to indexText from indexer.ts. Used only by pollRedisContent for
   * memory-pattern entries — config + source files route through indexFile /
   * makeSourceWatcher's indexSourceFile, never this.
   */
  indexText?: (title: string, content: string) => Promise<void>;

  /** Source paths to watch + index. Defaults to DEFAULT_SOURCE_PATHS. */
  sourcePaths?: SourcePath[];

  /** Load persisted source hashes from Redis. Defaults to loadPersistedHashes. */
  loadPersistedHashes?: () => Promise<number>;

  /** Run the initial source-file indexing pass. Defaults to runSourceInitialPass. */
  runSourceInitialPass?: (opts?: {
    paths?: SourcePath[];
    windowMs?: number;
    now?: number;
  }) => Promise<{ scanned: number; indexed: number; skipped: number }>;

  /**
   * setInterval. Defaults to globalThis.setInterval.
   * Tests inject a no-op to prevent polling during assertions.
   */
  setInterval?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;

  /** clearInterval. Defaults to globalThis.clearInterval. */
  clearInterval?: (id: ReturnType<typeof setInterval> | null) => void;

  /**
   * fs.watch. Defaults to node:fs watch.
   * Tests inject a no-op watcher to avoid side effects.
   */
  watch?: (
    path: string,
    options: { recursive: boolean },
    callback: (eventType: string, filename: string | null) => void
  ) => void;

  /** Redis poll interval in ms. Defaults to REDIS_POLL_MS (30000). */
  redisPollMs?: number;

  /** Config directory to watch. Defaults to CONFIG_PATH. */
  configPath?: string;

  /** Debounce window in ms. Defaults to DEBOUNCE_MS (2000). */
  debounceMs?: number;
}

// ---------------------------------------------------------------------------
// IndexerController
// ---------------------------------------------------------------------------

/**
 * Owns the background indexer lifecycle: config-file watcher, source-file
 * watcher, and Redis memory-pattern poll.
 *
 * Previously Section 4 of indexer.ts held these as module-level singletons;
 * they are now instance state so each test case can construct a fresh
 * controller with injected stubs and drive behavior deterministically without
 * module-level resets. Mirrors the HeartbeatController extraction (#2195).
 *
 * Public API:
 *   start()  — begin watching + polling
 *   stop()   — clear the poll interval (idempotent, issue #866)
 */
export class IndexerController {
  // Instance-owned singletons (formerly module-level in indexer.ts Section 4)
  private indexerInterval: ReturnType<typeof setInterval> | null = null;
  private lastRuleCounts: Record<string, number> = {};
  private readonly indexerPending = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly _getMemoryPatterns: NonNullable<IndexerControllerDeps["getMemoryPatterns"]>;
  private readonly _indexFile: NonNullable<IndexerControllerDeps["indexFile"]>;
  private readonly _indexText: NonNullable<IndexerControllerDeps["indexText"]>;
  private readonly _sourcePaths: SourcePath[];
  private readonly _loadPersistedHashes: NonNullable<IndexerControllerDeps["loadPersistedHashes"]>;
  private readonly _runSourceInitialPass: NonNullable<IndexerControllerDeps["runSourceInitialPass"]>;
  private readonly _setInterval: NonNullable<IndexerControllerDeps["setInterval"]>;
  private readonly _clearInterval: NonNullable<IndexerControllerDeps["clearInterval"]>;
  private readonly _watch: NonNullable<IndexerControllerDeps["watch"]>;
  private readonly _redisPollMs: number;
  private readonly _configPath: string;
  private readonly _debounceMs: number;

  constructor(deps: IndexerControllerDeps = {}) {
    this._getMemoryPatterns = deps.getMemoryPatterns ?? getMemoryPatterns;
    this._indexFile = deps.indexFile ?? indexFile;
    this._indexText = deps.indexText ?? indexText;
    this._sourcePaths = deps.sourcePaths ?? DEFAULT_SOURCE_PATHS;
    this._loadPersistedHashes = deps.loadPersistedHashes ?? loadPersistedHashes;
    this._runSourceInitialPass = deps.runSourceInitialPass ?? runSourceInitialPass;
    this._setInterval = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
    this._clearInterval =
      deps.clearInterval ?? ((id) => { if (id != null) clearInterval(id); });
    this._watch = deps.watch ?? ((path, options, cb) => { watch(path, options, cb); });
    this._redisPollMs = deps.redisPollMs ?? REDIS_POLL_MS;
    this._configPath = deps.configPath ?? CONFIG_PATH;
    this._debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private shouldIndex(filePath: string): boolean {
    const rel = relative(this._configPath, filePath);
    for (const skip of SKIP_DIRS) {
      if (rel.startsWith(skip)) return false;
    }
    return INDEXABLE_EXTS.has(extname(filePath));
  }

  private onFileChange(_eventType: string, filename: string | null): void {
    if (!filename) return;
    const fullPath = resolve(this._configPath, filename);
    if (!this.shouldIndex(fullPath)) return;

    if (this.indexerPending.has(fullPath)) {
      clearTimeout(this.indexerPending.get(fullPath)!);
    }
    // Issue #2523: route config-file changes through indexFile — the OV
    // container-path ingestion with per-file SHA-256 hash-dedup — exactly as
    // the original startKnowledgeIndexer did. The #2526 extraction wrongly
    // used indexText (blob-upload, no dedup, different URI namespace); this
    // restores 1:1 behaviour (INV-1).
    const indexFileFn = this._indexFile;
    this.indexerPending.set(
      fullPath,
      setTimeout(() => {
        this.indexerPending.delete(fullPath);
        indexFileFn(fullPath).catch((err: any) =>
          console.error(
            `[Learning:Indexer] Config change index failed for ${fullPath}: ${err.message}`
          )
        );
      }, this._debounceMs)
    );
  }

  /**
   * Poll Redis for new memory patterns and upload additions to OV.
   * Behavior preserved 1:1 from pollRedisContent in indexer.ts.
   * Public so tests can drive it directly without starting the interval.
   */
  async pollRedisContent(): Promise<void> {
    try {
      for (const agent of ["planner", "executor", "skeptic"]) {
        const raw = await this._getMemoryPatterns(agent);
        if (!raw) continue;
        try {
          const patterns = JSON.parse(raw);
          const patternCount = patterns.length;
          const prev = this.lastRuleCounts[agent] || 0;
          if (patternCount > prev) {
            for (const p of patterns.slice(prev)) {
              const text =
                `${agent} pattern [${p.severity}]: ${p.category}` +
                ` (${p.hitCount}x) — ACTION: ${p.action}. Last: ${p.lastCycleId}`;
              await this._indexText(`memory:${agent}:${p.category}`, text);
            }
            this.lastRuleCounts[agent] = patternCount;
          }
        } catch {
          /* intentional: skip unparseable patterns */
        }
      }
    } catch (err: any) {
      console.error(`[Learning:Indexer] Redis poll failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the background indexer. Behavior preserved 1:1 from
   * startKnowledgeIndexer in indexer.ts Section 4.
   */
  start(): void {
    console.log(`[Learning:Indexer] Watching configs: ${this._configPath}`);
    console.log(
      `[Learning:Indexer] Polling Redis every ${this._redisPollMs / 1000}s`
    );

    // Record the live watch set for /api/learning/coverage (#210, INV-5):
    // the config dir plus each source root tagged with its extension. Must
    // run on every start() so the coverage endpoint never reports an empty
    // watch list (the defect a prior QA pass caught on issue #2523).
    setWatchedPaths([
      this._configPath,
      ...this._sourcePaths.map((s) => `${s.root}(${s.ext})`),
    ]);

    // Watch config files
    try {
      this._watch(
        this._configPath,
        { recursive: true },
        this.onFileChange.bind(this)
      );
    } catch (err: any) {
      console.error(`[Learning:Indexer] fs.watch failed: ${err.message}`);
    }

    // Watch source paths (src/, docs/, test/) — shared indexerPending with config watcher
    for (const source of this._sourcePaths) {
      try {
        this._watch(
          source.root,
          { recursive: true },
          makeSourceWatcher(source, this.indexerPending, this._debounceMs)
        );
        console.log(
          `[Learning:Indexer] Watching source: ${source.root} (${source.ext})`
        );
      } catch (err: any) {
        if (err.code === "ENOENT") {
          console.log(
            `[Learning:Indexer] Source path missing, skipping: ${source.root}`
          );
        } else {
          console.error(
            `[Learning:Indexer] fs.watch failed for ${source.root}: ${err.message}`
          );
        }
      }
    }

    // Hydrate dedup cache from Redis, then run initial source pass
    this._loadPersistedHashes()
      .then((loaded) => {
        console.log(
          `[Learning:Indexer] Loaded ${loaded} persisted source hashes`
        );
      })
      .catch((err: any) =>
        console.error(
          `[Learning:Indexer] Hash hydrate failed: ${err.message}`
        )
      )
      .then(() => this._runSourceInitialPass({ paths: this._sourcePaths }))
      .then(({ scanned, indexed, skipped }) => {
        console.log(
          `[Learning:Indexer] Initial source pass: scanned=${scanned} indexed=${indexed} skipped=${skipped}`
        );
      })
      .catch((err: any) =>
        console.error(
          `[Learning:Indexer] Initial source pass failed: ${err.message}`
        )
      );

    // Poll Redis for new content
    this.indexerInterval = this._setInterval(
      () => void this.pollRedisContent(),
      this._redisPollMs
    );
    void this.pollRedisContent();
  }

  /**
   * Stop the background indexer by clearing the Redis-poll interval.
   * Idempotent — double-call is a safe no-op (issue #866).
   */
  stop(): void {
    if (this.indexerInterval) {
      this._clearInterval(this.indexerInterval);
      this.indexerInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Test-only introspection
  // ---------------------------------------------------------------------------

  /** Test-only: read lastRuleCounts without accessing private fields. */
  _getLastRuleCounts(): Readonly<Record<string, number>> {
    return { ...this.lastRuleCounts };
  }

  /** Test-only: number of live debounce timers in indexerPending. */
  _getPendingSize(): number {
    return this.indexerPending.size;
  }
}

// ---------------------------------------------------------------------------
// Module-level default singleton + thin delegators (zero-diff for callers)
//
// Issue #2523 forward-fix: the config-file index path (onFileChange ->
// indexFile) and the source-file watcher (makeSourceWatcher -> indexSourceFile)
// are now consumed by import from indexer.ts (INV-5), not re-implemented here.
// The prior local indexConfigFile + makeSourceWatcher copies routed both
// surfaces through indexText (blob-upload, no hash-dedup, wrong URI namespace),
// a 1:1-behaviour regression (INV-1). Deleting them restores the original
// container-path + content-index behaviour.
// ---------------------------------------------------------------------------

/**
 * The production IndexerController singleton. Callers use the thin delegators
 * below so import paths remain unchanged.
 */
const defaultController = new IndexerController();

/**
 * Start the background knowledge indexer.
 * Zero-diff drop-in for the former free function in indexer.ts Section 4.
 */
export function startKnowledgeIndexer(): void {
  defaultController.start();
}

/**
 * Stop the background knowledge indexer. Idempotent (issue #866).
 * Zero-diff drop-in for the former free function in indexer.ts Section 4.
 */
export function stopKnowledgeIndexer(): void {
  defaultController.stop();
}
