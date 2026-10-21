/**
 * Attention calibration policy — the pure half of the per-line calibration
 * ledger (issue #4627, ADR-0034 §8.4).
 *
 * This module owns the verdict CONSTANTS, the rolling-window day-key list,
 * the fold of daily calibration hashes into per-line totals, and the verdict
 * itself. It has ZERO Redis IO — `src/redis/attention.ts` does the reads and
 * calls in here, so the policy is testable (and reviewable) without a
 * server. Keeping "all three constants live in one src/ file" (§8.4) means
 * this file: window, minimum data, falsification ratio, retention.
 *
 * Verdict per admission line over a rolling 30 days (§8.4):
 *
 *   surfaced < 5                          → insufficient-data
 *   notAProblem / surfaced >= 0.5         → miscalibrated
 *   otherwise                             → calibrated
 *
 * Only *not-a-problem* enters the ratio (the acceptance criterion "only
 * not-a-problem moves a line toward miscalibrated" is structural:
 * `verdictFor` reads exactly two inputs). `handled-elsewhere`, `later` and
 * `resolved` are reported in the row but never falsify a line — an item the
 * operator routed elsewhere, deferred, or that cleared on its own says
 * nothing about whether the line was worth surfacing.
 *
 * Storage contract (the Redis half, for reference): daily hashes
 * `hydra:attention:calib:<YYYY-MM-DD>` (UTC) with fields
 * `<key>:surfaced | :not-a-problem | :handled-elsewhere | :later | :resolved`
 * and a 35-day TTL stamped on every write, so the 30-day window reads as 30
 * HGETALLs and self-cleans (precedent: `src/redis/scope-violations.ts`).
 */

import { ADMISSION_LINE_KEYS } from "./schemas/operator-actions.ts";

/** Rolling verdict window (§8.4). */
export const CALIBRATION_WINDOW_DAYS = 30;

/** Fewer surfaced episodes than this is `insufficient-data` (§8.4). */
export const CALIBRATION_MIN_SURFACED = 5;

/** notAProblem/surfaced at or above this ratio is `miscalibrated` (§8.4). */
export const MISCALIBRATED_NOT_A_PROBLEM_RATIO = 0.5;

/** Daily-hash retention — window + margin so day-boundary reads never gap. */
export const CALIBRATION_TTL_DAYS = 35;

/** CALIBRATION_TTL_DAYS as seconds, for the Redis-side EXPIRE. */
export const CALIBRATION_TTL_SECONDS = CALIBRATION_TTL_DAYS * 24 * 60 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The three verdicts of §8.4. */
export const CALIBRATION_VERDICTS = [
  "insufficient-data",
  "miscalibrated",
  "calibrated",
] as const;

export type AttentionCalibrationVerdict = (typeof CALIBRATION_VERDICTS)[number];

/** Per-line totals folded out of the daily calibration hashes. */
export interface CalibrationLineTotals {
  /** Episodes that surfaced at least once in the window. */
  surfaced: number;
  /** Surfaced episodes that cleared from a healthy source, never dismissed. */
  resolved: number;
  notAProblem: number;
  handledElsewhere: number;
  later: number;
}

/** One GET /attention/counts row: the totals plus their verdict. */
export interface CalibrationLineRow extends CalibrationLineTotals {
  /** The `<bucket>:<line>` admission-line key. */
  key: string;
  verdict: AttentionCalibrationVerdict;
  /** The §5.3 decomposition — cites the inputs and the constant. */
  because: string;
}

/** One day's calibration hash as Redis returns it (field → INT string). */
export type DailyCalibrationHash = Record<string, string>;

/** The UTC day key (`YYYY-MM-DD`) a write at `now` belongs to. */
export function calibrationDayDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The rolling window's day keys, newest first: `today .. today-29`. The
 * Redis read is one pipeline of HGETALLs over these; a missing day reads as
 * zeros.
 */
export function calibrationDayDates(now: Date = new Date()): string[] {
  return Array.from(
    { length: CALIBRATION_WINDOW_DAYS },
    (_, i) => calibrationDayDate(new Date(now.getTime() - i * DAY_MS)),
  );
}

/** The five per-line counters stored on a daily calibration hash. */
const CALIBRATION_COUNTERS = [
  "surfaced",
  "resolved",
  "not-a-problem",
  "handled-elsewhere",
  "later",
] as const;

type CalibrationCounter = (typeof CALIBRATION_COUNTERS)[number];

const COUNTER_TO_TOTALS_KEY: Partial<
  Record<CalibrationCounter, "notAProblem" | "handledElsewhere" | "later">
> = {
  "not-a-problem": "notAProblem",
  "handled-elsewhere": "handledElsewhere",
  later: "later",
};

function zeroTotals(): CalibrationLineTotals {
  return { surfaced: 0, resolved: 0, notAProblem: 0, handledElsewhere: 0, later: 0 };
}

/**
 * Fold the window's daily hashes into per-line totals. Field names are
 * `<key>:<counter>` where `key` itself contains a colon, so the counter is
 * the segment AFTER the last colon; an unknown counter (or a foreign field)
 * is ignored, never mis-attributed.
 */
export function foldCalibrationWindow(
  days: readonly DailyCalibrationHash[],
): Map<string, CalibrationLineTotals> {
  const totals = new Map<string, CalibrationLineTotals>();
  for (const day of days) {
    for (const [field, raw] of Object.entries(day)) {
      const cut = field.lastIndexOf(":");
      if (cut <= 0) continue;
      const key = field.slice(0, cut);
      const counter = field.slice(cut + 1);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      let line = totals.get(key);
      if (!line) {
        line = zeroTotals();
        totals.set(key, line);
      }
      if (counter === "surfaced" || counter === "resolved") {
        line[counter] += n;
      } else {
        const prop = COUNTER_TO_TOTALS_KEY[counter as CalibrationCounter];
        if (prop) line[prop] += n;
      }
    }
  }
  return totals;
}

/**
 * The §8.4 verdict. Reads EXACTLY two inputs — surfaced and notAProblem —
 * so `handled-elsewhere` / `later` / `resolved` can never move a line toward
 * miscalibrated. `surfaced === 0` is insufficient-data; the ratio is never
 * computed below the minimum.
 */
export function verdictFor(line: {
  surfaced: number;
  notAProblem: number;
}): { verdict: AttentionCalibrationVerdict; because: string } {
  if (line.surfaced < CALIBRATION_MIN_SURFACED) {
    return {
      verdict: "insufficient-data",
      because: `${line.surfaced} surfaced < ${CALIBRATION_MIN_SURFACED} minimum over ${CALIBRATION_WINDOW_DAYS}d`,
    };
  }
  const ratio = line.notAProblem / line.surfaced;
  const r = formatRatio(ratio);
  const decomposition =
    `${line.notAProblem} not-a-problem / ${line.surfaced} surfaced = ${r} `;
  if (ratio >= MISCALIBRATED_NOT_A_PROBLEM_RATIO) {
    return {
      verdict: "miscalibrated",
      because: `${decomposition}>= ${MISCALIBRATED_NOT_A_PROBLEM_RATIO} over ${CALIBRATION_WINDOW_DAYS}d`,
    };
  }
  return {
    verdict: "calibrated",
    because: `${decomposition}< ${MISCALIBRATED_NOT_A_PROBLEM_RATIO} over ${CALIBRATION_WINDOW_DAYS}d`,
  };
}

/** Up to three decimals, trailing zeros trimmed: 0.5, 0.375, 1. */
function formatRatio(ratio: number): string {
  return ratio.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Build the /attention/counts rows: one per registry line, in
 * ADMISSION_LINE_KEYS drain order, zeros asserted for never-written lines
 * (a fresh install reads as 19 honest insufficient-data rows).
 */
export function calibrationRows(
  dailyHashes: readonly DailyCalibrationHash[],
  lineKeys: readonly string[] = ADMISSION_LINE_KEYS,
): CalibrationLineRow[] {
  const totals = foldCalibrationWindow(dailyHashes);
  return lineKeys.map((key) => {
    const t = totals.get(key) ?? zeroTotals();
    return { key, ...t, ...verdictFor(t) };
  });
}
