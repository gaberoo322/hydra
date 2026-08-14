import { useMemo } from "react";
import { useApi } from "./useApi.js";

/**
 * usePageItems — the shared dashboard page-item seam's data half (issue #822).
 *
 * Composes over useApi (whose public interface is unchanged) to give every
 * list-style page one typed shape instead of each re-deriving
 * `const items = data?.items ?? []`. Filtering is a first-class option on the
 * hook rather than a per-page reimplementation — it is client-side over the
 * returned items (no REST shape change; explicitly out of scope).
 *
 * Why compose, not widen useApi: useApi has non-list consumers (CostBurn,
 * Sparkline, ServiceStrip) — baking item semantics into it would couple them
 * to a shape they don't have. usePageItems wraps it instead.
 *
 * ## Trust status machine (ADR-0034 §5)
 *
 * A single derived `status` so pages stop re-spelling the
 * loading/error/empty/ready ternary, extended with the two trust states the
 * cockpit contract requires:
 *
 *   loading — first load in progress, no payload yet.
 *   unknown — UNVERIFIABLE. No payload (first-load fetch failed), OR the
 *             payload asserts the lookup did not run cleanly
 *             (`sourcesOk === false`), OR it carries no usable as-of
 *             timestamp. Renders UNKNOWN, never a confident-looking value.
 *   stale   — payload present and trustworthy but aged past its declared
 *             `freshnessMs` budget, OR a later refresh failed while the
 *             last-good payload is retained. The retained value is shown as
 *             context, never in the position a current value would occupy.
 *   empty   — an ASSERTED zero: the lookup ran cleanly (`sourcesOk !== false`)
 *             and produced no items.
 *   ready   — fresh, trustworthy, non-empty.
 *
 * A fetch failure no longer surfaces as a distinct `error` status — the trust
 * contract routes it to `unknown` (no prior data) or `stale` (prior data
 * retained). The raw failure message is still returned in the `error` field so
 * unconverted panels that pass `error` straight to a banner (e.g. RecentMerges)
 * keep working unchanged; trust-opted-in panels map failures to unknown/stale.
 *
 * @param {string} path - API path passed straight to useApi.
 * @param {object} [opts]
 * @param {number} [opts.freshnessMs=300000] - as-of budget in ms; a payload
 *   whose `generatedAt` is older demotes to `stale`. Defaults to a conservative
 *   5 min so a forgetful caller never renders stale data as current; panels
 *   override per ADR-0034's minutes / ~1h / ~1d tiers.
 * @param {number} [opts.poll=0]      - poll interval (ms), forwarded to useApi.
 * @param {boolean} [opts.skip=false] - forwarded to useApi.
 * @param {string} [opts.itemsKey="items"] - response field holding the array.
 * @param {(item:any)=>boolean} [opts.filter] - optional client-side predicate.
 * @returns {{
 *   items: any[], data: any,
 *   status: "loading"|"unknown"|"stale"|"empty"|"ready",
 *   error: string|null, loading: boolean, refresh: () => Promise<void>
 * }}
 */
export function usePageItems(
  path,
  { poll = 0, skip = false, itemsKey = "items", filter, freshnessMs = 5 * 60 * 1000 } = {},
) {
  const { data, error, loading, refresh } = useApi(path, { poll, skip });

  const items = useMemo(() => {
    const raw = Array.isArray(data?.[itemsKey]) ? data[itemsKey] : [];
    return typeof filter === "function" ? raw.filter(filter) : raw;
  }, [data, itemsKey, filter]);

  const status = useMemo(
    () => derivePageStatus({ data, error, loading, itemsLen: items.length, freshnessMs }),
    [data, error, loading, items.length, freshnessMs],
  );

  return { items, data, status, error, loading, refresh };
}

/**
 * Pure trust-status derivation — the ADR-0034 §5 state machine, extracted so
 * the priority order reads in one place. The dashboard ships no JSX test
 * runner and the worktree resolves no `react`, so this is verified at the HTTP
 * boundary (the `sourcesOk`/`scanned` fields it reads are pinned by
 * `test/today-page.test.mts`) rather than unit-tested directly.
 *
 * First match wins:
 *   1. loading && no data      → loading  (initial fetch in flight)
 *   2. no data                 → unknown  (first-load fetch failed, nothing yet)
 *   3. sourcesOk === false     → unknown  (lookup ran but not cleanly — partial
 *                                          failure; an incomplete list is not trustworthy)
 *   4. generatedAt unparseable → unknown  (no usable as-of timestamp)
 *   5. error set, data present → stale    (refresh failed; show retained data as context)
 *   6. aged past freshnessMs   → stale    (payload older than its budget)
 *   7. items empty             → empty    (ASSERTED zero)
 *   8. otherwise               → ready
 *
 * `sourcesOk === false` is a strict check: `undefined` (an endpoint not yet
 * opted into the asserted-emptiness contract) flows through so unconverted
 * panels keep their legacy empty/ready behaviour while their endpoints gain
 * the field in later slices.
 */
export function derivePageStatus({ data, error, loading, itemsLen, freshnessMs }) {
  if (loading && !data) return "loading";
  if (!data) return "unknown";
  if (data.sourcesOk === false) return "unknown";
  const generatedAtMs = Date.parse(data.generatedAt ?? "");
  if (!Number.isFinite(generatedAtMs)) return "unknown";
  // A failed refresh leaves `error` set while useApi retains the last-good
  // payload — surface it as stale context, not a confident current value.
  if (error) return "stale";
  if (Date.now() - generatedAtMs > freshnessMs) return "stale";
  if (itemsLen === 0) return "empty";
  return "ready";
}
