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
 * Redis and zero domain knowledge of which files to index. They are re-exported
 * below so all existing callers keep a zero-diff import specifier (INV-2).
 * Dependency flows ov-upload <- indexer, never the reverse (INV-4, no circular
 * import) — the same downward-edge idiom as the source-enumerator.ts extraction
 * (#2767).
 *
 * Issue #3229: HashDedupAdapter + the dedup + coverage state boundary were
 * extracted into the focused leaf `hash-dedup.ts`, breaking the bidirectional
 * import cycle with indexer-lifecycle.ts (which caused a production ReferenceError).
 * They are re-exported below so all existing callers keep a zero-diff specifier
 * (INV-2). What REMAINS here is the domain-orchestration surface: thin facade +
 * free-function delegators to the dedup leaf + the staleness probe.
 *
 * Behavior is preserved 1:1 from the source files. Public symbols are
 * unchanged so importers only update their import specifier. The previous
 * file-level history references (#210, #211, #219, #313, #318, #866, #954,
 * #965, #1123, #2267) are retained inline at each block.
 */

import { trackedOvSearch } from "./ov-search.ts";
// Issue #2767: the pure source-file enumeration + path helpers were extracted
// into source-enumerator.ts (a zero-OV, purely-filesystem module). SourcePath is
// imported here for the runSourceInitialPass delegator type annotation; all
// symbols are re-exported below so existing callers keep a zero-diff specifier (INV-2).
import { type SourcePath } from "./source-enumerator.ts";
// Issue #3229: HashDedupAdapter + defaultHashAdapter + related types extracted
// to the focused leaf hash-dedup.ts to break the bidirectional import cycle with
// indexer-lifecycle.ts. The free-function delegators below (getCoverageStats,
// resetCoverageStats, runSourceInitialPass) access defaultHashAdapter directly;
// the class + types are re-exported below so all existing callers keep a
// zero-diff import specifier (INV-2).
import {
  type CoverageStats,
  defaultHashAdapter,
} from "./hash-dedup.ts";

// ---------------------------------------------------------------------------
// Shared constants (deduped across the merged modules — identical definitions).
// ---------------------------------------------------------------------------

// SKIP_DIRS moved to source-enumerator.ts (issue #2767) with the pure walk/
// filter helpers; indexer.ts no longer references it directly.
// CONFIG_PATH, OV_CONFIG_MOUNT, DEBOUNCE_MS moved to hash-dedup.ts (issue #3229)
// with HashDedupAdapter; indexer.ts no longer references them directly.

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
// SOURCE_PATHS and SOURCE_INITIAL_WINDOW_MS moved to hash-dedup.ts (issue #3229)
// with HashDedupAdapter.runSourceInitialPass — they are private to the adapter.

// ===========================================================================
// SECTION 1a — HashDedupAdapter, CoverageStats, HashDedupPersistence, defaultHashAdapter
// (issue #2603; EXTRACTED to hash-dedup.ts by issue #3229).
//
// These were moved to the focused leaf src/knowledge-base/hash-dedup.ts to
// break the bidirectional import cycle between indexer.ts and indexer-lifecycle.ts.
// They are imported back here (via the import block at the top of this file) and
// re-exported below so all existing callers keep a zero-diff import specifier (INV-2).
// ===========================================================================

// ---------------------------------------------------------------------------
// Re-exports of hash-dedup leaf (zero-diff for callers — issue #3229, INV-2).
// ---------------------------------------------------------------------------
export type { CoverageStats, HashDedupPersistence } from "./hash-dedup.ts";
export { HashDedupAdapter, defaultHashAdapter } from "./hash-dedup.ts";

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

/**
 * @see HashDedupAdapter.getIndexedPaths (issue #3341 — the lexical
 * fallback-ranking corpus). NOTE: `trackedOvSearch` reads the corpus from the
 * hash-dedup leaf directly (this module imports ov-search.ts, so importing
 * back from here would recreate the #3229 cycle); this delegator keeps the
 * module-level facade complete for external callers, matching
 * getCoverageStats above.
 */
export function getIndexedPaths(): string[] {
  return defaultHashAdapter.getIndexedPaths();
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
