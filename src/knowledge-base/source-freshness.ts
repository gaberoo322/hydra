/**
 * source-freshness.ts — staleness probe for the OpenViking source index (issue #2267).
 *
 * THE PROBLEM. The source-indexer (`source-indexer.ts`) keeps a durable Redis
 * dedup map (`src/redis/source-index.ts`, issue #1123) of `path -> sha1` so it
 * can skip re-embedding unchanged files across the orchestrator's
 * dozens-of-bounces-a-day. That cache is correct as long as OpenViking still
 * holds what the cache claims it indexed. But if OpenViking is reset/restarted
 * out from under the cache (container reset, deployment, volume wipe), the cache
 * still says "all 633 files indexed" so the indexer skips every file — and the
 * knowledge base stays empty. Agents then search an empty source index and lose
 * semantic access to prior implementations.
 *
 * WHY NOT coverageStats.resourceCount. The naive fix ("clear the cache when
 * hashes>0 and resourceCount==0") is a footgun: `resourceCount` is a per-process
 * counter that resets to 0 on every restart and only increments on an actual
 * upload. On a HEALTHY restart everything is a cache-hit skip, so resourceCount
 * stays 0 while OV is fully indexed — the condition fires on every normal bounce
 * and would re-embed the whole tree every time, undoing #1123. So resourceCount
 * is unusable as the OV-truth signal.
 *
 * THE SOUND SIGNAL. OpenViking exposes no resource-count/list verb
 * (`GET /api/v1/resources` -> Method Not Allowed), so a count-vs-count compare
 * is not implementable. The only available probe is `POST /api/v1/search/find`.
 * Indexed source/config content lands under `viking://resources/...` (the
 * source-indexer's `indexText` -> `viking://resources/hydra-memory/...`, the
 * config indexer -> `viking://resources/...`), whereas transient uploads land
 * under `viking://temp/...`. So "OV holds indexed source resources" is decided
 * by: does a targeted search return ANY result URI under `viking://resources/`?
 * A stale (reset) OV returns only `viking://temp/...` URIs (or nothing); a
 * healthy OV returns at least one `viking://resources/...` hit.
 *
 * This module is the pure-ish probe shared by both consumers:
 *   - the lifecycle staleness detector (mutating: clears the cache), and
 *   - the read-only `/api/health/source-index` diagnostic.
 * The search call is injectable so it is unit-testable without a live OV, and it
 * is best-effort/never-throw — on any error it reports "present" (the safe
 * direction: do NOT clear the cache on an inconclusive probe).
 */

import { trackedOvSearch } from "./ov-search.ts";

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
