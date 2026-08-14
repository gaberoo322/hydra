import { useMemo } from "react";
import { useApi } from "./useApi.js";
import { derivePageStatus } from "../lib/page-item-format.ts";

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
 * ## Trust contract (ADR-0034 §5, issue #4006)
 *
 * The status enum gains two states beyond loading / error / empty / ready:
 *
 *   - `unknown` — the payload is not trustworthy enough to render a value:
 *                 a first-load fetch failure (nothing received), a payload whose
 *                 own `sourcesOk === false` says the lookup didn't fully run, or
 *                 a payload with no parseable `generatedAt`. Renders UNKNOWN in
 *                 place of a confident-looking value (rule 1).
 *   - `stale`   — a payload is present but not current: either a later poll
 *                 failed and useApi retained the last-good data, or the payload's
 *                 `generatedAt` is older than the caller-declared `freshnessMs`
 *                 budget. The retained value may appear as context, never in the
 *                 position a current value would occupy (rule 1).
 *
 * The status priority order itself lives in the pure seam
 * (`derivePageStatus` in lib/page-item-format.ts) so the orchestrator's
 * node:test suite can pin it without a React tree. Backward compatibility:
 * endpoints that do not yet assert (no `sourcesOk` field) and callers that do
 * not declare `freshnessMs` skip those two rules, so the four other Today-page
 * panels keep their existing behaviour until each is migrated slice by slice.
 * useApi already retains `data` across a failed refresh (it never nulls it), so
 * the stale-with-context path needs no change there.
 *
 * @param {string} path - API path passed straight to useApi.
 * @param {object} [opts]
 * @param {number} [opts.poll=0]      - poll interval (ms), forwarded to useApi.
 * @param {boolean} [opts.skip=false] - forwarded to useApi.
 * @param {string} [opts.itemsKey="items"] - response field holding the array.
 * @param {(item:any)=>boolean} [opts.filter] - optional client-side predicate.
 * @param {number} [opts.freshnessMs=0] - ADR-0034 freshness budget (ms); 0 = no
 *   age-based staleness check (caller hasn't declared a budget). Per ADR-0034:
 *   minutes for is-it-on-fire, ~1h for activity, ~1d for weekly trends.
 * @returns {{
 *   items: any[], data: any,
 *   status: "loading"|"error"|"unknown"|"stale"|"empty"|"ready",
 *   error: string|null, loading: boolean, refresh: () => Promise<void>
 * }}
 */
export function usePageItems(path, { poll = 0, skip = false, itemsKey = "items", filter, freshnessMs = 0 } = {}) {
  const { data, error, loading, refresh } = useApi(path, { poll, skip });

  const items = useMemo(() => {
    const raw = Array.isArray(data?.[itemsKey]) ? data[itemsKey] : [];
    return typeof filter === "function" ? raw.filter(filter) : raw;
  }, [data, itemsKey, filter]);

  // A single derived status so pages stop re-spelling the
  // loading/error/empty/ready ternary in their <Section> props — now extended
  // with the trust contract's `unknown` and `stale` states (derivePageStatus).
  const status = derivePageStatus({ loading, error, data, items, freshnessMs });

  return { items, data, status, error, loading, refresh };
}
