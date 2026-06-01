import { useMemo } from "react";
import { useApi } from "./useApi.js";

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
 * @param {string} path - API path passed straight to useApi.
 * @param {object} [opts]
 * @param {number} [opts.poll=0]      - poll interval (ms), forwarded to useApi.
 * @param {boolean} [opts.skip=false] - forwarded to useApi.
 * @param {string} [opts.itemsKey="items"] - response field holding the array.
 * @param {(item:any)=>boolean} [opts.filter] - optional client-side predicate.
 * @returns {{
 *   items: any[], data: any, status: "loading"|"error"|"empty"|"ready",
 *   error: string|null, loading: boolean, refresh: () => Promise<void>
 * }}
 */
export function usePageItems(path, { poll = 0, skip = false, itemsKey = "items", filter } = {}) {
  const { data, error, loading, refresh } = useApi(path, { poll, skip });

  const items = useMemo(() => {
    const raw = Array.isArray(data?.[itemsKey]) ? data[itemsKey] : [];
    return typeof filter === "function" ? raw.filter(filter) : raw;
  }, [data, itemsKey, filter]);

  // A single derived status so pages stop re-spelling the
  // loading/error/empty/ready ternary in their <Section> props.
  let status;
  if (loading) status = "loading";
  else if (error) status = "error";
  else if (items.length === 0) status = "empty";
  else status = "ready";

  return { items, data, status, error, loading, refresh };
}
