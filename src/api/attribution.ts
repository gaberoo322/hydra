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
 * `GET /api/attribution/impact` is the **reverse-loop read surface** (issue
 * #3283, completing epic #2628): it folds those per-metric β_c ACROSS every
 * leading metric — orienting each with the metric's `direction` into a favorable
 * effect and dividing by a tier cost proxy — to rank producer classes (anchor
 * types) by outcome-impact-per-cost. Discovery classes consume it to steer
 * toward high-IMPACT areas rather than merely high-NOTICE ones. Same read-only /
 * never-a-bare-estimate discipline as the base view.
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
  getTopImpactAnchorTypes,
  type MetricEstimate,
  type MetricDirection,
} from "../outcome-attribution/index.ts";
import { loadOutcomes } from "../outcomes.ts";

/**
 * The one dependency the handler needs: the append-only ledger read. Defaults to
 * the live Redis seam; tests inject a fake returning a canned result object.
 */
type LoadObservations = () => Promise<LoadObservationsResult>;

/**
 * Per-metric "which way is better" map for the impact view — resolves each
 * leading metric's `direction` so the ridge estimator's raw signed β can be
 * oriented into a FAVORABLE effect. Defaults to the live outcomes config;
 * tests inject a fake so the impact ranking is asserted without touching fs.
 */
type LoadMetricDirections = () => Promise<Record<string, MetricDirection>>;

/**
 * Live metric-direction loader: read the outcomes config and keep the LEADING
 * outcomes only (the attribution spine watches leading metrics), mapping each to
 * its `direction`. Best-effort — a load failure yields an empty map, so the
 * impact view degrades to raw signed β (never throws, never a bare 500 here).
 */
async function defaultLoadMetricDirections(): Promise<
  Record<string, MetricDirection>
> {
  const loaded = await loadOutcomes();
  if (loaded.ok === false) return {};
  const out: Record<string, MetricDirection> = {};
  for (const o of loaded.outcomes) {
    if (o.kind === "leading") out[o.name] = o.direction;
  }
  return out;
}

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
 * Parse the optional `topN` query param into a non-negative integer, or
 * `undefined` when absent/malformed (⇒ return all ranked rows).
 */
function parseTopN(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * @param loadObservations Optional ledger-read override (tests inject a fake).
 *   Defaults to the live `getObservations()` Redis seam.
 * @param loadMetricDirections Optional metric-direction override (tests inject a
 *   fake). Defaults to the live outcomes-config loader.
 */
export function createAttributionRouter(
  loadObservations: LoadObservations = defaultGetObservations,
  loadMetricDirections: LoadMetricDirections = defaultLoadMetricDirections,
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

  // GET /attribution/impact — the reverse-loop read surface (issue #3283, epic
  // #2628). Ranks producer classes (anchor types) by FAVORABLE outcome impact
  // PER unit of build cost, folding the ridge estimator across every leading
  // metric and orienting each raw β with the metric's direction. Discovery
  // classes consume this to steer toward high-IMPACT areas over high-NOTICE
  // ones. Read-only; dark/empty ledger → 200 with rows:[] (no impact signal
  // yet); Redis-read fail → 500. Optional `?topN=N` caps the ranking.
  router.get("/attribution/impact", async (req, res) => {
    try {
      const loaded = await loadObservations();
      if (loaded.ok === false) {
        // The only 500: the append-only ledger could not be read.
        return res.status(500).json({ error: loaded.error });
      }

      // Direction load is best-effort — an empty map degrades to raw signed β,
      // it does NOT fail the request (an impact ranking without favorability
      // orientation is still a usable notice-vs-impact signal).
      const metricDirections = await loadMetricDirections();
      const topN = parseTopN(req.query.topN);

      const ranking = getTopImpactAnchorTypes(loaded.observations, {
        metricDirections,
        topN,
      });
      res.json(ranking);
    } catch (err: any) {
      // Defensive — the seam returns a result object and the lens is pure, so
      // neither throws; this guard just guarantees Express never returns a
      // bodyless 500 if that contract is ever broken upstream.
      console.error(
        `[attribution-api] unexpected error (impact): ${err?.message || String(err)}`,
      );
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
