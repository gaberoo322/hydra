/**
 * Outcome-attribution **impact-ranking lens** (issue #3283, epic #2628 —
 * completing the reverse-loop feedback path).
 *
 * The attribution spine measures, per leading metric, each producer class's
 * ridge marginal effect β_c (`estimator.ts`). That answers "which class moves
 * THIS metric most?" — but a discovery agent asks a different, cross-metric
 * question: **"which producer classes have the highest FAVORABLE outcome impact
 * per unit of build cost?"** — so the reverse loop can steer discovery toward
 * high-impact areas rather than merely high-*notice* ones (the frontier gap in
 * the architecture review, finding #6: "discovery is self-referential").
 *
 * This module is the public lens that answers that question. It is a PURE,
 * zero-I/O, non-mutating fold over the estimator's output:
 *
 *   1. It calls {@link estimateMarginalEffects} on the raw ledger rows the
 *      caller supplies (the same rows `/api/attribution` loads) — so it is a
 *      strict lens over the shipped estimator, never a re-derivation of credit.
 *   2. For each metric it converts each class's raw signed β into a **favorable
 *      effect** using the metric's `direction` ("up" ⇒ +β is good, "down" ⇒ −β
 *      is good). A metric with no supplied direction contributes its raw signed
 *      β (best-effort; the caller learns nothing was normalized via the
 *      `directedMetrics` roll-up on each row).
 *   3. It divides the accumulated favorable effect by a **cost proxy** — the
 *      mean tier of the class's contributing windows (deeper tiers cost more to
 *      build and verify) — yielding an impact-per-cost score.
 *   4. It ranks producer classes by that score, descending, and carries every
 *      class's identifiability posture forward so a consumer NEVER sees a bare
 *      point estimate (mirroring the `/api/attribution` "never a bare estimate"
 *      invariant).
 *
 * Invariants:
 *
 *   - **PURE / zero-I/O.** Deterministic function of `(observations, opts)`
 *     alone — no Redis, fs, clock. Preserves the module's AC5 purity invariant.
 *
 *   - **Never throws.** The estimator is total and this fold does no I/O; a
 *     degenerate input (no rows, no directed metrics) yields an empty ranking.
 *
 *   - **Never a bare estimate.** Each ranked row carries `identifiabilitySuspect`
 *     and `belowNoiseFloor` roll-ups so a consumer can tell "high impact" apart
 *     from "cannot tell" or "measured but small". Suspect / below-floor rows are
 *     surfaced WITH their flags, never silently filtered (filtering would
 *     collapse "cannot tell" into "no impact") — a `minConfidence` opt lets a
 *     caller that wants only trustworthy rows drop them EXPLICITLY.
 *
 *   - **Direction-aware, sign-preserving.** The raw signed β stays available on
 *     each metric contribution; only the FAVORABLE roll-up applies direction.
 */

import type { AttributionObservation } from "../redis/attribution-ledger.ts";
import { estimateMarginalEffects } from "./estimator.ts";

/**
 * Which way "better" points for a leading metric — mirrors
 * {@link OutcomeDirection} in `outcomes-types.ts` without importing the fs/net
 * outcome loader (keeps this lens zero-I/O). The caller (the API route) supplies
 * this from the loaded outcomes config.
 */
export type MetricDirection = "up" | "down";

/** One producer class's contribution from ONE metric, kept for auditability. */
export interface MetricContribution {
  /** Leading-metric name. */
  metric: string;
  /** Raw signed marginal effect β_c the estimator assigned for this metric. */
  beta: number;
  /**
   * The favorable-oriented effect: `+beta` when the metric's direction is "up",
   * `−beta` when "down". Equals the raw `beta` when no direction was supplied
   * for the metric (best-effort — see `directed`).
   */
  favorable: number;
  /** `true` when a direction was supplied for this metric and applied. */
  directed: boolean;
  /** `true` when the estimator flagged this class's β identifiability-suspect. */
  identifiabilitySuspect: boolean;
  /** `true` when the estimator marked this class's β below the noise floor. */
  belowNoiseFloor: boolean;
}

/**
 * One producer class's cross-metric impact ranking row. The discovery
 * reverse-loop consumes these ordered by descending `impactPerCost`.
 */
export interface ImpactRankRow {
  /** Producer class (e.g. `discover`, `dev`, `arch`). */
  producerClass: string;
  /**
   * Sum of the favorable effects across every metric this class contributed to
   * — the total measured outcome improvement attributed to the class.
   */
  favorableImpact: number;
  /**
   * Mean tier of the class's contributing windows — the **cost proxy**. Deeper
   * tiers cost more to build/verify, so a class that moves outcomes at shallow
   * tiers is more cost-efficient. `null` when no contributing window carried a
   * tier (then `impactPerCost` falls back to raw `favorableImpact`).
   */
  meanTier: number | null;
  /**
   * `favorableImpact` divided by the cost proxy (`max(meanTier, 1)`), or the raw
   * `favorableImpact` when `meanTier` is null. This is the reverse-loop's
   * ranking key: outcome improvement per unit of build cost.
   */
  impactPerCost: number;
  /** Per-metric breakdown, for auditability / a richer consumer. */
  contributions: MetricContribution[];
  /**
   * `true` when ANY contributing metric flagged this class identifiability-
   * suspect — a consumer must treat the impact as "cannot fully trust", not a
   * clean estimate.
   */
  identifiabilitySuspect: boolean;
  /**
   * `true` when EVERY contributing metric marked this class below the noise
   * floor — the measured impact is within exogenous drift and small. (ANY-of
   * for suspect, ALL-of for below-floor: one trustworthy above-floor metric is
   * enough to make the class worth surfacing.)
   */
  belowNoiseFloor: boolean;
}

/** The full impact ranking: producer classes ordered by descending impact/cost. */
export interface ImpactRanking {
  /** Producer classes, highest `impactPerCost` first. */
  rows: ImpactRankRow[];
  /**
   * Count of distinct metrics the ranking folded over — 0 signals a dark/empty
   * ledger (the reverse loop then has no impact signal yet and falls back to
   * notice-based discovery).
   */
  metricCount: number;
}

export interface ImpactRankingOptions {
  /**
   * Per-metric "which way is better" map. A metric present here has its β
   * oriented to a favorable effect; a metric absent contributes its raw signed
   * β (best-effort). Supplied by the API route from the loaded outcomes config.
   */
  metricDirections?: Record<string, MetricDirection>;
  /**
   * When `true`, drop rows whose impact is not trustworthy —
   * `identifiabilitySuspect` OR `belowNoiseFloor`. Default `false`: surface ALL
   * rows with their flags so the consumer decides (never silently collapse
   * "cannot tell" into "no impact").
   */
  onlyConfident?: boolean;
  /**
   * Optional cap on the number of ranked rows returned (the "top-N" of
   * {@link getTopImpactProducerClasses}). Applied AFTER ranking and any
   * `onlyConfident` filter. `undefined` ⇒ return all.
   */
  topN?: number;
  /**
   * Estimator tunable overrides forwarded verbatim (tests pin λ/k
   * deterministically). Defaults to the estimator's env-backed constants.
   */
  estimatorOpts?: Parameters<typeof estimateMarginalEffects>[1];
}

/**
 * Rank producer classes by **favorable outcome impact per unit of build cost**,
 * folding the ridge estimator's per-metric marginal effects across every leading
 * metric. PURE — no I/O, never throws.
 *
 * This is the reverse-loop's public read surface: discovery classes consume the
 * ranked `producerClass`es to steer toward high-impact areas rather than merely
 * high-notice ones.
 *
 * @param observations Raw ledger rows (the same `getObservations()` feeds the
 *   `/api/attribution` view). Consumed read-only.
 * @param opts Direction map, confidence filter, top-N cap, estimator tunables.
 */
export function getTopImpactProducerClasses(
  observations: AttributionObservation[],
  opts: ImpactRankingOptions = {},
): ImpactRanking {
  const directions = opts.metricDirections ?? {};
  const estimate = estimateMarginalEffects(observations, opts.estimatorOpts);

  // Tier accumulator per class: summed tier + count of tier-bearing windows the
  // class had a non-zero merge in. Derived straight from the raw observations so
  // the cost proxy reflects the class's OWN contributing windows, not a global
  // average.
  const tierSum = new Map<string, number>();
  const tierCount = new Map<string, number>();
  for (const obs of observations) {
    if (obs.tier === null || obs.tier === undefined) continue;
    for (const [cls, count] of Object.entries(obs.classCounts)) {
      if (count === 0) continue;
      tierSum.set(cls, (tierSum.get(cls) ?? 0) + obs.tier);
      tierCount.set(cls, (tierCount.get(cls) ?? 0) + 1);
    }
  }

  // Fold the estimator's per-metric effects into a per-class accumulator.
  const acc = new Map<
    string,
    { favorable: number; contributions: MetricContribution[] }
  >();
  const seenMetrics = new Set<string>();
  for (const metric of estimate.metrics) {
    seenMetrics.add(metric.metric);
    const dir = directions[metric.metric];
    for (const eff of metric.effects) {
      const favorable = dir === "down" ? -eff.beta : eff.beta;
      const contribution: MetricContribution = {
        metric: metric.metric,
        beta: eff.beta,
        favorable,
        directed: dir !== undefined,
        identifiabilitySuspect: eff.identifiabilitySuspect,
        belowNoiseFloor: eff.belowNoiseFloor,
      };
      const entry = acc.get(eff.producerClass);
      if (entry) {
        entry.favorable += favorable;
        entry.contributions.push(contribution);
      } else {
        acc.set(eff.producerClass, {
          favorable,
          contributions: [contribution],
        });
      }
    }
  }

  const rows: ImpactRankRow[] = [];
  for (const [producerClass, entry] of acc) {
    const sum = tierSum.get(producerClass);
    const cnt = tierCount.get(producerClass);
    const meanTier = cnt && cnt > 0 ? sum! / cnt : null;
    // Cost proxy: mean tier, floored at 1 so a T1 class isn't divided by <1 and
    // a null-tier class ranks on its raw favorable impact.
    const impactPerCost =
      meanTier === null ? entry.favorable : entry.favorable / Math.max(meanTier, 1);

    const identifiabilitySuspect = entry.contributions.some(
      (c) => c.identifiabilitySuspect,
    );
    // ALL-of for below-floor: one above-floor metric is enough to trust the row.
    const belowNoiseFloor = entry.contributions.every((c) => c.belowNoiseFloor);

    rows.push({
      producerClass,
      favorableImpact: entry.favorable,
      meanTier,
      impactPerCost,
      contributions: entry.contributions,
      identifiabilitySuspect,
      belowNoiseFloor,
    });
  }

  // Rank by descending impact-per-cost. Ties broken by descending raw favorable
  // impact then producerClass (stable, deterministic ordering).
  rows.sort(
    (a, b) =>
      b.impactPerCost - a.impactPerCost ||
      b.favorableImpact - a.favorableImpact ||
      a.producerClass.localeCompare(b.producerClass),
  );

  let out = rows;
  if (opts.onlyConfident) {
    out = out.filter(
      (r) => !r.identifiabilitySuspect && !r.belowNoiseFloor,
    );
  }
  if (opts.topN !== undefined && opts.topN >= 0) {
    out = out.slice(0, opts.topN);
  }

  return { rows: out, metricCount: seenMetrics.size };
}
