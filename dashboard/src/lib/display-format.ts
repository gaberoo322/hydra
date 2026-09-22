/**
 * display-format.ts — the dashboard's ONE canonical home for token-count
 * abbreviation and compound h/m/s duration rendering (issue #4564).
 *
 * Both concepts used to be reinvented independently and had already drifted
 * for the same input: autopilot-format.js rendered 1_500_000 tokens as
 * "1500.0k" while CostPanel.jsx rendered "1.5M"; formatElapsed rendered
 * "1h 2m 3s", runs-state.js's formatRunDuration rendered "1h", the /now
 * Console rendered "1.5h", and UsagePanel.jsx did its own Math.floor bucket
 * math for a countdown. Every one of those now delegates here, so tightening
 * a threshold is a one-file edit.
 *
 * Why lib/ and not pages/now-console/console-format.ts (which owned the
 * previously-tested formatTokens)? autopilot-format.js is itself in lib/, and
 * the dashboard has ZERO lib/→pages/ import edges — same reasoning as
 * relative-time-format.ts (#4400).
 *
 * Pure and DOM-free (no React, no Date.now(), no import.meta) so the
 * orchestrator's node:test suite pins it directly
 * (test/display-format.test.mts). Countdown framing ("resets in …",
 * "resets now") and caller-side null policies stay at the call sites — this
 * module only does the arithmetic and the unit strings.
 */

/**
 * Canonical token-count abbreviation: "—" for null/undefined/non-finite;
 * |n| >= 1M → one-decimal "M"; |n| >= 1K → zero-decimal uppercase "K"; else
 * the rounded integer. 1_500_000 → "1.5M", 814_897 → "815K", 512 → "512".
 */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(Math.round(v));
}

export type DurationPrecision = "seconds" | "minutes";

export interface FormatDurationOptions {
  /** Smallest unit rendered; the input is floored to it. */
  precision: DurationPrecision;
}

/**
 * Canonical compound duration: "—" for non-number / non-finite / negative.
 * Floors to the precision unit; leads with the largest non-zero unit among
 * h/m(/s) and ALWAYS renders every smaller unit down to the precision unit,
 * zeros included (so live counters don't jitter in width).
 *
 *   seconds: 0 → "0s", 45 → "45s", 125 → "2m 5s", 3600 → "1h 0m 0s"
 *   minutes: 0 → "0m", 707 → "11m", 3600 → "1h 0m", 3660 → "1h 1m"
 */
export function formatDuration(
  seconds: number | null | undefined,
  options: FormatDurationOptions,
): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (options.precision === "minutes") {
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
