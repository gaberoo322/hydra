/**
 * Builder-Health Stagnation Detector — pure core (issue #3287, epic #3285).
 *
 * The trend-watcher half of the Builder-Health Measurement Subsystem
 * (ADR-0028). `builder-health.ts` composes a per-realm panel of trended
 * signals (autonomy rate, cycle yield, rework rate, time-to-merge); this
 * module answers the orthogonal question "has ONE of those signals stagnated
 * — drifted measurably worse than its own recent history and STAYED there?".
 *
 * # Why relative-to-self, not absolute (ADR-0028 Decision 2, #3129)
 *
 * The four watched signals have wildly different native rates across realms,
 * and an absolute cross-realm threshold both false-alarms at cold start and
 * fails to travel. Instead the baseline is the trailing rolling mean of the
 * signal's OWN preceding values (window = `baselineWindow`, EXCLUDING the
 * current point), and a breach is measured as a `band`-sized excursion below
 * (or above) that self-baseline, sustained for `sustain` consecutive cycles.
 *
 * # Design contract (mirrors builder-health.ts)
 *
 * - **Pure + dependency-free + never-throws.** `computeStagnation` reads only
 *   its `(series, opts)` arguments and returns a plain object — no Redis, no
 *   clock, no I/O. It never throws (matches the builder-health never-throws
 *   contract); a malformed option falls back to its default.
 * - **New file only (this slice).** `builder-health.ts` /
 *   `getBuilderHealthScorecard` is NOT modified here — the detector is wired
 *   into the scorecard in the next slice (#3288).
 *
 * # Accepted blind spot (ADR-0028 Consequences — "boiling-frog")
 *
 * The band comparison is STRICT: a signal flat AT its own baseline returns
 * `ok`. A slow monotone decay that never opens more than `band` of gap versus
 * its own trailing mean therefore never breaches. This is the documented,
 * accepted cost of a relative-to-self design — it is not patched here.
 */

/**
 * Which direction of movement counts as "worse" for this signal:
 *
 * - `'down'` — falling values are worse. Autonomy rate and cycle yield: a
 *   drop below the self-baseline is a regression.
 * - `'up'` — rising values are worse. Rework rate and time-to-merge: a climb
 *   above the self-baseline is a regression.
 */
export type StagnationDirection = "down" | "up";

type StagnationState = "ok" | "warming" | "breach";

export interface StagnationOptions {
  /**
   * Which direction is "worse" for this signal. Required — ADR-0028 Decision 1
   * fixes the four signals' worse-directions, so there is no safe default.
   */
  direction: StagnationDirection;
  /**
   * The excursion, in the signal's own units, that a cycle must clear beyond
   * the trailing baseline to count as a worse cycle. Compared STRICTLY, so a
   * flat-at-baseline cycle (`band` = 0 gap) is never worse.
   */
  band: number;
  /**
   * How many consecutive most-recent worse cycles are required before the
   * state flips to `'breach'`. A single-cycle excursion never fires.
   */
  sustain: number;
  /**
   * The minimum series length before a baseline is trusted. Below this the
   * state is `'warming'` (cold-start suppression, ADR-0028 Decision 3).
   */
  minBaselineCycles: number;
  /**
   * How many preceding values feed the trailing rolling-mean baseline.
   * Defaults to 50 (ADR-0028 / issue #3287 default).
   */
  baselineWindow?: number;
}

export interface StagnationResult {
  state: StagnationState;
  /** The most-recent value in the series, or `null` for an empty series. */
  current: number | null;
  /**
   * The trailing rolling-mean baseline of the values PRECEDING `current`, or
   * `null` when there is no trustworthy baseline yet (warming, or no preceding
   * values).
   */
  baseline: number | null;
  /**
   * How many consecutive most-recent cycles were worse-than-band. `>= sustain`
   * on a non-warming series is what produces `'breach'`.
   */
  sustainedCycles: number;
}

const DEFAULT_BASELINE_WINDOW = 50;

/**
 * Detect whether a single trended signal has stagnated relative to its own
 * recent history. Pure, dependency-free, never throws.
 *
 * @param series Chronological (oldest-first) numeric values of one signal.
 * @param opts   Direction, band, sustain, minBaselineCycles, baselineWindow.
 * @returns      `{ state, current, baseline, sustainedCycles }`.
 */
export function computeStagnation(
  series: readonly number[],
  opts: StagnationOptions,
): StagnationResult {
  const values = Array.isArray(series) ? series : [];
  const n = values.length;

  const direction: StagnationDirection = opts.direction === "up" ? "up" : "down";
  const band = Number.isFinite(opts.band) ? Number(opts.band) : 0;
  const sustain = normalizeCount(opts.sustain, 1);
  const minBaselineCycles = normalizeCount(opts.minBaselineCycles, 1);
  const baselineWindow = normalizeCount(opts.baselineWindow, DEFAULT_BASELINE_WINDOW);

  // Cold-start suppression: too little history to trust any baseline.
  if (n < minBaselineCycles) {
    return {
      state: "warming",
      current: n > 0 ? values[n - 1] : null,
      baseline: null,
      sustainedCycles: 0,
    };
  }

  // STRICT band comparison — a value exactly `band` away is NOT worse, and a
  // flat-at-baseline value (gap 0) is never worse.
  const worse = (cur: number, base: number): boolean =>
    direction === "down" ? cur < base - band : cur > base + band;

  // Count consecutive worse-than-band cycles from the newest backward. Each
  // cycle's baseline is the mean of ITS OWN strictly-preceding window, so the
  // excursion under test never dilutes its own baseline.
  let sustainedCycles = 0;
  for (let i = n - 1; i >= 0; i--) {
    const win = values.slice(Math.max(0, i - baselineWindow), i);
    if (win.length === 0) break; // no preceding values -> can't judge
    const base = mean(win);
    if (worse(values[i], base)) {
      sustainedCycles++;
    } else {
      break;
    }
  }

  // Baseline reported alongside the current point: the trailing window that
  // strictly precedes the newest value.
  const lastWin = values.slice(Math.max(0, n - 1 - baselineWindow), n - 1);
  const baseline = lastWin.length > 0 ? mean(lastWin) : null;

  return {
    state: sustainedCycles >= sustain ? "breach" : "ok",
    current: values[n - 1],
    baseline,
    sustainedCycles,
  };
}

function mean(win: readonly number[]): number {
  let sum = 0;
  for (const v of win) sum += v;
  return sum / win.length;
}

/** Clamp an option to a positive integer, falling back on a non-finite / <1 value. */
function normalizeCount(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}
