import { useMemo } from "react";
import { useApi } from "./useApi.js";
import {
  deriveItemStatus,
  DEFAULT_FRESHNESS_MS,
} from "../lib/page-item-format.ts";

/**
 * usePageItems — the shared dashboard page-item seam's data half (issue #822).
 *
 * Composes over useApi (whose public Interface is unchanged) to give every
 * list-style page one typed shape instead of each re-deriving
 * `const items = data?.items ?? []`. Filtering becomes a first-class option
 * on the hook rather than a per-page reimplementation — it is client-side
 * over the returned items (no REST shape change; explicitly out of scope).
 *
 * Why compose, not widen useApi: useApi has non-list consumers (CostBurn,
 * Sparkline, ServiceStrip) — baking item semantics into it would couple them
 * to a shape they don't have. usePageItems wraps it instead.
 *
 * The derived `status` is the single seam through which the ADR-0034 §5 trust
 * contract lands on the client (issue #4006): beyond the legacy
 * loading/empty/ready states it gains `stale` (payload older than the panel's
 * declared freshness budget, or a refresh failed while prior data is retained)
 * and `unknown` (fetch failed with no prior data, payload carries no
 * timestamp, or the lookup did not run cleanly — `sourcesOk === false`). The
 * priority ladder itself lives in the pure `deriveItemStatus` seam so the
 * orchestrator node:test suite can pin it (the dashboard ships no JSX runner).
 *
 * @param {string} path - API path passed straight to useApi.
 * @param {object} [opts]
 * @param {number} [opts.poll=0]      - poll interval (ms), forwarded to useApi.
 * @param {boolean} [opts.skip=false] - forwarded to useApi.
 * @param {string} [opts.itemsKey="items"] - response field holding the array.
 * @param {(item:any)=>boolean} [opts.filter] - optional client-side predicate.
 * @param {number} [opts.freshnessMs] - ADR-0034 freshness budget (ms). A panel
 *   that opts into the trust contract declares its own tier here (minutes for
 *   is-it-on-fire, ~1h for activity). Defaults to the activity tier so a
 *   forgotten budget never means "always fresh".
 * @returns {{
 *   items: any[], data: any,
 *   status: "loading"|"stale"|"unknown"|"empty"|"ready",
 *   error: string|null, loading: boolean, refresh: () => Promise<void>
 * }}
 */
export function usePageItems(
  path,
  { poll = 0, skip = false, itemsKey = "items", filter, freshnessMs = DEFAULT_FRESHNESS_MS } = {},
) {
  const { data, error, loading, refresh } = useApi(path, { poll, skip });

  const items = useMemo(() => {
    const raw = Array.isArray(data?.[itemsKey]) ? data[itemsKey] : [];
    return typeof filter === "function" ? raw.filter(filter) : raw;
  }, [data, itemsKey, filter]);

  // A single derived status so pages stop re-spelling the trust-contract
  // ladder in their <Section> props. The priority (loading → error/no-data=
  //   unknown vs prior-data=stale → missing-timestamp=unknown → sourcesOk===
  //   false=unknown → aged=stale → empty → ready) lives in deriveItemStatus.
  // `sourcesOk` is undefined for endpoints not yet migrated to the asserted-
  // emptiness contract, which preserves their legacy emptiness semantics.
  const status = deriveItemStatus({
    loading,
    error,
    items,
    generatedAt: data?.generatedAt,
    sourcesOk: data?.sourcesOk,
    freshnessMs,
  });

  return { items, data, status, error, loading, refresh };
}
