/**
 * Anomaly-detector aggregator (issue #620, PRD #615) — Explore page Anomalies tab.
 *
 * Watches three time-series for deviations from their rolling baseline:
 *
 *   1. token-burn-rate           — daily token spend divided by the
 *                                    elapsed hours of the day.
 *   2. abandonment-rate           — abandoned-cycle count / dispatch count
 *                                    per day.
 *   3. dispatch-class-failure-rate — per-class failed-dispatch count divided
 *                                    by total dispatches for that class per
 *                                    day (one anomaly row per class that
 *                                    crosses the threshold).
 *
 * For each series we compute the z-score of the latest sample against the
 * baseline (mean + standard deviation of the prior window). A point counts
 * as anomalous when `|z| >= threshold`. The default threshold is 2.0
 * (≈ 2.3% of normally-distributed samples), configurable via
 * `AnomalyDetectorDeps.zThreshold`.
 *
 * # Design contract
 *
 * - **Pure math core.** `meanStd`, `zScore`, and `classifyZ` are tested
 *   directly. Boundary tests on the threshold (just-under / exactly-at /
 *   just-over) are part of the test plan in issue #620.
 * - **Stubbed series.** Tests pass `readSeries` so they can drive the math
 *   without touching Redis. Production wires up a Redis-backed reader.
 * - **Never throws.** A reader failure leaves that series out of the
 *   result list rather than aborting the whole call.
 * - **Floating-point safety.** All comparisons use `Number.isFinite()`
 *   gates. A zero-variance baseline yields `zScore = 0` (not NaN/∞) so a
 *   constant series doesn't masquerade as an anomaly when a new sample
 *   matches.
 */

import { getAutopilotDailyTokensRaw } from "../redis/cost.ts";

import type { AnomalyDirection, AnomalyMetric } from "./types.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface Anomaly {
  metric: AnomalyMetric;
  /** Sub-key — for `dispatch-class-failure-rate`, the autopilot class. Null otherwise. */
  subKey: string | null;
  /** Latest sample value (e.g. token-burn-rate tokens/hr, rate in [0,1]). */
  latest: number;
  /** Baseline mean across the preceding window. */
  baselineMean: number;
  /** Baseline standard deviation. */
  baselineStd: number;
  /** z = (latest - mean) / std. 0 when std == 0. */
  zScore: number;
  direction: AnomalyDirection;
  /** Echo of the threshold so the UI can label "≥ 2σ". */
  threshold: number;
  /** ISO timestamp of the latest sample. */
  sampleAt: string;
}

export interface AnomalyDetectorSnapshot {
  anomalies: Anomaly[];
  threshold: number;
  /** Echo of the baseline window so the UI can label "vs prior Nd". */
  baselineWindowDays: number;
  generatedAt: string;
}

export interface AnomalyDetectorDeps {
  now?: Date;
  /** Default 2.0. */
  zThreshold?: number;
  /**
   * How many days back the baseline covers. Default 14 days. The latest
   * sample is always evaluated against the [N+1-th most recent .. 2nd most
   * recent] points to avoid the trivial "latest matches itself" case.
   */
  baselineWindowDays?: number;
  /**
   * Stubbable series reader. Returns one named series per metric. For
   * `dispatch-class-failure-rate`, return multiple entries — one per class
   * — with `subKey` set to the class name. Tests pass a stub; production
   * passes the default Redis-backed reader.
   */
  readSeries?: () => Promise<SeriesInput[]>;
}

export interface SeriesInput {
  metric: AnomalyMetric;
  subKey: string | null;
  /**
   * Time-ordered samples (oldest first). Each sample has a `value` and an
   * ISO `at` timestamp. The detector evaluates the LAST sample against the
   * preceding `baselineWindowDays` samples.
   */
  samples: Array<{ at: string; value: number }>;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

const DEFAULT_Z_THRESHOLD = 2.0;
const DEFAULT_BASELINE_WINDOW_DAYS = 14;

export async function getAnomalies(
  deps: AnomalyDetectorDeps = {},
): Promise<AnomalyDetectorSnapshot> {
  const now = deps.now ?? new Date();
  const threshold = sanitizeThreshold(deps.zThreshold);
  const baselineWindowDays = sanitizeWindowDays(deps.baselineWindowDays);
  const reader = deps.readSeries ?? defaultReadSeries;

  let series: SeriesInput[];
  try {
    series = await reader();
  } catch (err: any) {
    console.error(`[anomaly-detector] reader failed: ${err?.message || err}`);
    series = [];
  }

  const anomalies: Anomaly[] = [];
  for (const s of series) {
    const candidate = evaluateSeries(s, threshold, baselineWindowDays);
    if (candidate) anomalies.push(candidate);
  }
  // Biggest |z| first — operators care about the worst offender.
  anomalies.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return {
    anomalies,
    threshold,
    baselineWindowDays,
    generatedAt: now.toISOString(),
  };
}

function sanitizeThreshold(t: number | undefined): number {
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return DEFAULT_Z_THRESHOLD;
  return t;
}

function sanitizeWindowDays(w: number | undefined): number {
  if (typeof w !== "number" || !Number.isFinite(w)) return DEFAULT_BASELINE_WINDOW_DAYS;
  const n = Math.floor(w);
  if (n < 2) return 2; // need at least 2 baseline points
  if (n > 90) return 90;
  return n;
}

// ---------------------------------------------------------------------------
// Pure math — exported for tests
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Returns the arithmetic mean and the
 * population standard deviation of `values`. Returns `{ mean: 0, std: 0 }`
 * for empty input. Drops non-finite values silently.
 */
export function meanStd(values: readonly number[]): { mean: number; std: number } {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { mean: 0, std: 0 };
  const sum = finite.reduce((a, b) => a + b, 0);
  const mean = sum / finite.length;
  const variance =
    finite.reduce((a, b) => a + (b - mean) * (b - mean), 0) / finite.length;
  const std = Math.sqrt(variance);
  return { mean, std };
}

/**
 * Pure helper — exported for tests. Returns the z-score of `value` against
 * a baseline `mean` + `std`. When `std` is 0, returns 0 (a constant series
 * has no anomaly information, no matter what the new sample looks like —
 * we prefer "no signal" over an Infinity that would always trip the
 * threshold).
 */
export function zScore(value: number, mean: number, std: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(mean) || !Number.isFinite(std)) return 0;
  if (std === 0) return 0;
  return (value - mean) / std;
}

/**
 * Pure helper — exported for tests. Returns `"high" | "low" | null`:
 *
 *   - `"high"` when `z >= threshold`
 *   - `"low"` when `z <= -threshold`
 *   - `null` when `|z| < threshold`
 *
 * Equality counts as anomalous (consistent with the documented "≥ 2σ"
 * rendering on the UI).
 */
export function classifyZ(z: number, threshold: number): AnomalyDirection | null {
  if (!Number.isFinite(z) || !Number.isFinite(threshold) || threshold < 0) return null;
  if (z >= threshold) return "high";
  if (z <= -threshold) return "low";
  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function evaluateSeries(
  s: SeriesInput,
  threshold: number,
  baselineWindowDays: number,
): Anomaly | null {
  const samples = (s.samples ?? []).filter(
    (x) => x && Number.isFinite(x.value) && typeof x.at === "string",
  );
  if (samples.length < 2) return null;
  const latest = samples[samples.length - 1];
  const baseline = samples.slice(
    Math.max(0, samples.length - 1 - baselineWindowDays),
    samples.length - 1,
  );
  if (baseline.length === 0) return null;
  const { mean, std } = meanStd(baseline.map((b) => b.value));
  const z = zScore(latest.value, mean, std);
  const direction = classifyZ(z, threshold);
  if (!direction) return null;
  return {
    metric: s.metric,
    subKey: s.subKey ?? null,
    latest: latest.value,
    baselineMean: mean,
    baselineStd: std,
    zScore: z,
    direction,
    threshold,
    sampleAt: latest.at,
  };
}

/**
 * Production-default series reader. The Redis-backed implementation is
 * intentionally minimal: it reads the daily-spend surrogate snapshots and
 * a small set of autopilot-run digests, projects them into the
 * `SeriesInput` shape, and returns the bundle. When the underlying
 * counters aren't populated the reader yields empty series and the
 * detector returns no anomalies — graceful degradation.
 *
 * Splitting this from the pure math means tests never need a live Redis;
 * the math is exhaustively covered, and the reader's correctness is the
 * shape of the Redis schema (which is exercised end-to-end by the
 * integration smoke test in `test/aggregator-anomaly-detector.test.mts`).
 */
async function defaultReadSeries(): Promise<SeriesInput[]> {
  // The first cut focuses on token-burn-rate because we have daily snapshots
  // on hand. abandonment-rate and dispatch-class-failure-rate will be
  // wired in once their daily-counter schemas land (issue #620 ships the
  // detector + UI; subsequent passes populate more series).
  const out: SeriesInput[] = [];
  try {
    // The daily-spend surrogate key shape + GET live behind the typed cost seam
    // (`getAutopilotDailyTokensRaw`) instead of a dynamically-imported raw
    // connection (issue #1121).
    // Walk the last 30 daily-spend surrogate keys (newest to oldest) and
    // turn each into a per-hour rate against the day's elapsed wall clock.
    const now = new Date();
    const samples: Array<{ at: string; value: number }> = [];
    for (let i = 29; i >= 0; i -= 1) {
      const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = day.toISOString().split("T")[0];
      const raw = await getAutopilotDailyTokensRaw(dateStr).catch(() => null);
      if (raw === null) continue;
      const tokens = Number(raw);
      if (!Number.isFinite(tokens)) continue;
      // Tokens per million (subscription model; no dollar meaning) — the
      // detector cares about variance, not absolute calibration.
      const tokenBurnRate = tokens / 1_000_000;
      const hours = i === 0
        ? Math.max(1, (now.getTime() - new Date(dateStr + "T00:00:00.000Z").getTime()) / 3_600_000)
        : 24;
      samples.push({ at: day.toISOString(), value: tokenBurnRate / hours });
    }
    if (samples.length >= 2) {
      out.push({ metric: "token-burn-rate", subKey: null, samples });
    }
  } catch (err: any) {
    console.error(`[anomaly-detector] token-burn-rate reader failed: ${err?.message || err}`);
  }
  return out;
}
