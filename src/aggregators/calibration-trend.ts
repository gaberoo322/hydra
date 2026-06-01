/**
 * Calibration-trend aggregator (issue #619, PRD #615 slice 4).
 *
 * Tracks how well two model predictions match reality over a rolling
 * window — for the Outcomes page's "is the orchestrator getting
 * better at predicting itself?" view:
 *
 *   - `tierAccuracy`  — did the tier classifier's predicted tier match
 *     the actual outcome bucket (merged vs failed)? A merged outcome on
 *     an auto-merge tier (legacy 1/2/3, per `isAutoMergeTier` in
 *     `tier-policy.ts`) counts as a correct prediction ("auto-mergeable");
 *     a non-merged outcome on Tier 0 (Verifier Core / operator-only)
 *     likewise confirms the non-auto-merge prediction. (ADR-0019)
 *   - `costAccuracy`  — did the confidence score predict the merge
 *     outcome? Predictions stored at the time of dispatch live in
 *     `predictedScore`; the actual is `actualOutcome === "merged"`. The
 *     time series is a windowed accuracy rate (0..1).
 *
 * Both buckets read the same data source — the calibration outcomes
 * stored under `hydra:anchors:calibration:*` keys with their ZSET index
 * `hydra:anchors:calibration:index`.
 *
 * # Design contract
 *
 * - **Pure helpers exported.** `bucketByDay`, `tierAccuracyForRecord`,
 *   and `costAccuracyForRecord` are tested directly. The aggregator
 *   wires them up against a real Redis reader (overridable for tests).
 * - **Never throws.** A failed Redis read returns both series as `[]`.
 * - **Daily buckets.** One point per UTC day so a 7-day window produces
 *   at most 7 points regardless of how many cycles ran that day.
 */

import { isAutoMergeTier } from "../tier-policy.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TimeSeries {
  /** Daily-bucketed accuracy points (0..1). */
  points: { t: string; v: number }[];
  /** Total records the average is computed from. */
  sampleSize: number;
}

export interface CalibrationTrendResponse {
  windowDays: number;
  generatedAt: string;
  tierAccuracy: TimeSeries;
  costAccuracy: TimeSeries;
}

/**
 * Minimal shape of one entry under `hydra:anchors:calibration:{cycleId}`.
 * Mirrors what `recordCalibrationOutcome()` writes in `anchor-scorer.ts`.
 */
export interface CalibrationRecord {
  cycleId: string;
  predictedScore?: number;
  tier?: number | null;
  actualOutcome?: "merged" | "failed" | "abandoned" | "no-task";
  recordedAt?: string;
}

export interface CalibrationTrendDeps {
  now?: Date;
  /**
   * Reader for calibration records inside the window. Returns the records
   * (oldest → newest). Default scans Redis via the typed connection.
   */
  readCalibrationRecords?: (
    windowStart: Date,
    now: Date,
  ) => Promise<CalibrationRecord[]>;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getCalibrationTrend(
  windowDays: number,
  deps: CalibrationTrendDeps = {},
): Promise<CalibrationTrendResponse> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const reader = deps.readCalibrationRecords ?? defaultReadCalibrationRecords;
  let records: CalibrationRecord[] = [];
  try {
    records = await reader(windowStart, now);
  } catch (err: any) {
    console.error(
      `[calibration-trend] reader failed: ${err?.message || err}`,
    );
    records = [];
  }

  const tierBuckets = bucketByDay(records, tierAccuracyForRecord);
  const costBuckets = bucketByDay(records, costAccuracyForRecord);

  return {
    windowDays,
    generatedAt: now.toISOString(),
    tierAccuracy: {
      points: tierBuckets,
      sampleSize: countSamples(records, tierAccuracyForRecord),
    },
    costAccuracy: {
      points: costBuckets,
      sampleSize: countSamples(records, costAccuracyForRecord),
    },
  };
}

async function defaultReadCalibrationRecords(
  windowStart: Date,
  now: Date,
): Promise<CalibrationRecord[]> {
  // Use the typed seam — `src/redis/connection.ts` is the only allowed
  // Redis import outside `src/redis/`. ZRANGEBYSCORE on the calibration
  // index returns cycleIds in the window; we then GET each key.
  const { getRedisConnection } = await import("../redis/connection.ts");
  const r = getRedisConnection();
  const startMs = windowStart.getTime();
  const endMs = now.getTime();
  const cycleIds = await r.zrangebyscore(
    "hydra:anchors:calibration:index",
    startMs,
    endMs,
  );
  if (!Array.isArray(cycleIds) || cycleIds.length === 0) return [];

  const out: CalibrationRecord[] = [];
  for (const cycleId of cycleIds) {
    const raw = await r.get(`hydra:anchors:calibration:${cycleId}`);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        out.push(parsed as CalibrationRecord);
      }
    } catch (err: any) {
      console.error(
        `[calibration-trend] failed to parse ${cycleId}: ${err?.message || err}`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Returns 1 (correct) or 0 (incorrect) for the tier prediction on this
 * record, or null when the record can't be scored.
 *
 * Heuristic: an auto-merge-tier prediction (legacy 1, 2, or 3 — see
 * `isAutoMergeTier` in `tier-policy.ts`) is the orchestrator saying
 * "this should auto-merge". A `merged` outcome confirms; anything else
 * disconfirms. A Tier-0 (Verifier Core / operator-only) prediction is
 * "operator must merge"; a `merged` outcome there is the operator
 * merging manually as designed and counts as a CORRECT non-auto-merge
 * prediction, while `failed` or `abandoned` likewise confirm the
 * Tier-0 flag. The previous `tier <= 2` test mismodelled this: it
 * scored Tier-0 as predicted-auto-merge, so an operator-merged Tier-0
 * PR counted the classifier wrong. `isAutoMergeTier` fixes that —
 * Tier 0 is not an auto-merge tier. (ADR-0019.)
 */
export function tierAccuracyForRecord(rec: CalibrationRecord): number | null {
  const tier = rec?.tier;
  const outcome = rec?.actualOutcome;
  if (typeof tier !== "number") return null;
  if (outcome !== "merged" && outcome !== "failed" && outcome !== "abandoned") {
    return null;
  }
  const predictedAutoMerge = isAutoMergeTier(tier);
  const actualMerged = outcome === "merged";
  return predictedAutoMerge === actualMerged ? 1 : 0;
}

/**
 * Cost (= confidence) accuracy. We treat `predictedScore >= 0.5` as
 * "predict merge", and compare against the merged actual. Returns 1
 * (correct) or 0 (incorrect), or null when score / outcome are missing.
 *
 * Naming this `costAccuracy` follows the issue spec — the orchestrator
 * does not yet persist a dedicated predicted-cost field, so we use the
 * confidence score, which is the closest available proxy for "did the
 * scorer's risk estimate hold up?"
 */
export function costAccuracyForRecord(rec: CalibrationRecord): number | null {
  const score = rec?.predictedScore;
  const outcome = rec?.actualOutcome;
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (outcome !== "merged" && outcome !== "failed" && outcome !== "abandoned") {
    return null;
  }
  const predictedMerge = score >= 0.5;
  const actualMerged = outcome === "merged";
  return predictedMerge === actualMerged ? 1 : 0;
}

/**
 * Buckets records by UTC day. For each day in the window with at least
 * one scorable record, emits `{ t: <day-ISO>, v: <accuracy 0..1> }`.
 * Days with no scorable records are omitted (the dashboard renders
 * gaps gracefully).
 */
export function bucketByDay(
  records: CalibrationRecord[],
  score: (rec: CalibrationRecord) => number | null,
): { t: string; v: number }[] {
  if (!Array.isArray(records) || records.length === 0) return [];
  const byDay = new Map<string, { sum: number; n: number }>();
  for (const rec of records) {
    const s = score(rec);
    if (s === null) continue;
    const ts = typeof rec?.recordedAt === "string" ? rec.recordedAt : "";
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) continue;
    const day = dayBucketKey(new Date(ms));
    const entry = byDay.get(day) ?? { sum: 0, n: 0 };
    entry.sum += s;
    entry.n += 1;
    byDay.set(day, entry);
  }
  const out: { t: string; v: number }[] = [];
  for (const [day, { sum, n }] of byDay.entries()) {
    out.push({ t: day, v: n > 0 ? sum / n : 0 });
  }
  out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return out;
}

function countSamples(
  records: CalibrationRecord[],
  score: (rec: CalibrationRecord) => number | null,
): number {
  if (!Array.isArray(records)) return 0;
  let n = 0;
  for (const rec of records) {
    if (score(rec) !== null) n += 1;
  }
  return n;
}

function dayBucketKey(d: Date): string {
  // YYYY-MM-DDT00:00:00.000Z — start-of-day UTC.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}T00:00:00.000Z`;
}
