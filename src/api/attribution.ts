/**
 * Attribution view API (issue #2631, epic #2628 — the outcome-attribution spine).
 *
 * `GET /api/attribution` is the **read-only, positive-attribution sibling** of the
 * reactive Outcome-Holdback revert policy: it surfaces, per leading metric, the
 * ranked producer-class marginal effects β_c the ridge estimator (#2630) assigns
 * over the append-only ledger (#2629) — each row carrying its identifiability
 * flags and below-noise-floor marker so a consumer NEVER sees a bare point
 * estimate.
 *
 * Invariants (from the design concept for issue-2631):
 *
 *   - **Read-only.** The route registers only `GET /attribution` and performs no
 *     Redis write, no event emit, no dispatch, no revert. Holdback remains the
 *     sole revert authority (the epic is observe-only). The factory therefore
 *     takes no `eventBus` — it emits nothing.
 *
 *   - **Consumes the spine read-only.** It loads rows via `getObservations()`
 *     (`src/redis/attribution-ledger.ts`, the ledger seam) and fits them with
 *     `estimateMarginalEffects()` (the pure #2630 estimator). Both are shipped
 *     upstream and stay out of scope — this view mutates neither.
 *
 *   - **Never a bare point estimate.** Every ranked class row is the estimator's
 *     `ClassEffect` serialized VERBATIM — `beta` plus `lowVariance` / `collinear`
 *     / `collinearWith` / `belowNoiseFloor` / `identifiabilitySuspect`. Rows are
 *     ordered by descending `|beta|` (the "which class moves this metric most"
 *     question); the signed β stays on every row so a direction-aware consumer
 *     loses nothing. Suspect / below-floor rows are surfaced WITH their flags,
 *     never filtered out (filtering would collapse "cannot tell" into "no
 *     effect").
 *
 *   - **Dark/empty tolerance.** A metric with no non-zero class columns returns
 *     `effects: []`; an entirely-empty ledger returns `metrics: []`. Both are
 *     HTTP 200 — an empty ledger is the null-model data, not a missing resource.
 *     The ONLY 500 path is a `getObservations()` Redis-read failure.
 *
 *   - **Never throws to the client.** `getObservations()` returns a result object
 *     (never throws) and the estimator is pure and total; a defensive `catch`
 *     still guards the handler so Express never hands back a bodyless 500.
 */

import { Router } from "express";
import {
  getObservations as defaultGetObservations,
  type LoadObservationsResult,
} from "../redis/attribution-ledger.ts";
import {
  estimateMarginalEffects,
  type MetricEstimate,
} from "../outcome-attribution/estimator.ts";

/**
 * The one dependency the handler needs: the append-only ledger read. Defaults to
 * the live Redis seam; tests inject a fake returning a canned result object.
 */
type LoadObservations = () => Promise<LoadObservationsResult>;

/**
 * Order a metric's class effects by descending marginal-effect magnitude, so the
 * highest-|β| producer leads. Signed β is preserved on every row; only the ORDER
 * uses magnitude. Returns a new array — the estimator's output is not mutated.
 */
function rankByMagnitude(estimate: MetricEstimate): MetricEstimate {
  const effects = [...estimate.effects].sort(
    (a, b) => Math.abs(b.beta) - Math.abs(a.beta),
  );
  return { ...estimate, effects };
}

/**
 * @param loadObservations Optional ledger-read override (tests inject a fake).
 *   Defaults to the live `getObservations()` Redis seam.
 */
export function createAttributionRouter(
  loadObservations: LoadObservations = defaultGetObservations,
) {
  const router = Router();

  // GET /attribution — per-metric ranked β_c with identifiability + noise-floor
  // flags on every row. Read-only; dark/empty → 200 empty; Redis-read fail → 500.
  router.get("/attribution", async (_req, res) => {
    try {
      const loaded = await loadObservations();
      if (loaded.ok === false) {
        // The only 500: the append-only ledger could not be read.
        return res.status(500).json({ error: loaded.error });
      }

      const estimate = estimateMarginalEffects(loaded.observations);
      const metrics = estimate.metrics.map(rankByMagnitude);
      res.json({ metrics });
    } catch (err: any) {
      // Defensive — the seam returns a result object and the estimator is pure,
      // so neither throws; this guard just guarantees Express never returns a
      // bodyless 500 if that contract is ever broken upstream.
      console.error(
        `[attribution-api] unexpected error: ${err?.message || String(err)}`,
      );
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
