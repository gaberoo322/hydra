/**
 * Grounding-mode duration analysis (issue #341; extracted from a route in
 * #2126, relocated out of `trend.ts` into this focused leaf in #2614).
 *
 * This module owns the grounding-mode performance domain: the four
 * `GroundingDuration*` types and the `projectGroundingDuration` bucketing /
 * roll-up. It has exactly ONE production caller — `GET /metrics/grounding-duration`
 * in `src/api/metrics.ts` — which feeds it an already-fetched
 * `getMetricsTrend()` array. The percentile arithmetic is the shared
 * `percentileNearestRankFraction` primitive from the `metrics/math.ts` leaf
 * (consolidated in #2613/#2615), not a private copy.
 *
 * Why its own file: `trend.ts`'s documented contract is "the single read entry
 * for the last N cycle metrics hashes, parsed" — a Redis-read concern consumed
 * by ~6 modules. Grounding-mode bucketing (`incremental` vs `full`, p50/p95
 * stat shape) is a distinct domain that only happened to land in `trend.ts`
 * because it was the closest metrics module when #2126 pulled it out of the
 * route body. Concentrating it here makes a change to the bucketing logic a
 * one-file edit with no coupling to the trend-read protocol, and lets the
 * single caller stub `projectGroundingDuration` without importing
 * `getMetricsTrend`'s Redis reads.
 *
 * Everything here is pure: no Redis, no Express, no module-level state.
 */

import { percentileNearestRankFraction } from "./math.ts";

/** One projected grounding/verification sample from a cycle metrics record. */
export interface GroundingDurationSample {
  cycleId: any;
  groundingMode: string;
  groundingDurationMs: number;
  verificationDurationMs: number;
  testsSelected: number | null;
}

/** p50/p95/mean rollup over one mode's grounding (or verification) samples. */
export interface GroundingDurationStat {
  p50: number | null;
  p95: number | null;
  mean: number | null;
}

/** Per-mode bucket: cycle count + grounding & verification duration stats. */
export interface GroundingDurationBucket {
  cycles: number;
  grounding: GroundingDurationStat;
  verification: GroundingDurationStat;
}

/** The `{sampleSize, buckets, recent}` shape on the wire. */
export interface GroundingDurationResult {
  sampleSize: number;
  buckets: {
    incremental: GroundingDurationBucket;
    full: GroundingDurationBucket;
    unlabelled: GroundingDurationBucket;
  };
  recent: GroundingDurationSample[];
}

/**
 * Pure projection: bucket a metrics-trend array by `groundingMode`
 * ("incremental" | "full" | "") and roll up p50/p95/mean grounding &
 * verification durations per bucket (issue #341). Extracted verbatim from the
 * inline body of `GET /metrics/grounding-duration` (#2126) so the percentile
 * + bucketing math is unit-testable on a synthetic trend array without
 * standing up the Express router or stubbing Redis.
 *
 * Takes an already-fetched trend array; no Redis, no Express, no module-level
 * state.
 */
export function projectGroundingDuration(
  trend: Array<Record<string, any>>,
): GroundingDurationResult {
  const samples: GroundingDurationSample[] = trend.map((m: any) => ({
    cycleId: m.cycleId,
    groundingMode: typeof m.groundingMode === "string" ? m.groundingMode : "",
    groundingDurationMs: typeof m.groundingDurationMs === "number" ? m.groundingDurationMs : 0,
    verificationDurationMs: typeof m.verificationDurationMs === "number" ? m.verificationDurationMs : 0,
    // testsSelected: how many tests the incremental selector actually ran
    // (undefined for full-suite runs). Surfaced for rollout-vs-baseline
    // comparison without forcing callers to do bucket math.
    testsSelected: typeof m.incrementalTestsSelected === "number" ? m.incrementalTestsSelected : null,
  }));

  const bucket = (mode: string): GroundingDurationBucket => {
    const subset = samples.filter((s) => s.groundingMode === mode);
    const ground = subset.map((s) => s.groundingDurationMs).filter((x) => x > 0);
    const verify = subset.map((s) => s.verificationDurationMs).filter((x) => x > 0);
    return {
      cycles: subset.length,
      grounding: {
        p50: percentileNearestRankFraction(ground, 0.5),
        p95: percentileNearestRankFraction(ground, 0.95),
        mean: ground.length > 0 ? Math.round(ground.reduce((a, b) => a + b, 0) / ground.length) : null,
      },
      verification: {
        p50: percentileNearestRankFraction(verify, 0.5),
        p95: percentileNearestRankFraction(verify, 0.95),
        mean: verify.length > 0 ? Math.round(verify.reduce((a, b) => a + b, 0) / verify.length) : null,
      },
    };
  };

  const buckets = {
    incremental: bucket("incremental"),
    full: bucket("full"),
    unlabelled: bucket(""),
  };

  return {
    sampleSize: samples.length,
    buckets,
    recent: samples.slice(0, 20),
  };
}
