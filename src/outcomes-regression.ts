/**
 * Outcome Regression Policy (extracted from `src/outcomes.ts`, issue #2095).
 *
 * This Module owns the Outcome Holdback regression policy: sampling the
 * leading outcomes, comparing a fresh snapshot against a baseline, and
 * deciding "did this outcome regress?". It was previously co-located with the
 * outcome loader/adapter in `src/outcomes.ts`, where a developer reasoning
 * about the holdback regression decision had to scan past the YAML-parsing and
 * source-adapter machinery to reach it (and vice-versa). Splitting it out gives
 * the regression policy a single home with exactly one production caller
 * (`src/holdback.ts`) and zero coupling to the YAML parser.
 *
 * It sits ON TOP of the loader: it imports `loadOutcomes` and `getOutcomeValue`
 * from `src/outcomes.ts` (the retained loader/adapter Module) and adds the
 * comparison policy. The pure helpers (`detectRegressions`, `isOutcomeRegressed`)
 * take plain arrays — no filesystem, no YAML, no adapter switching — so the
 * holdback policy is testable in isolation.
 *
 * Invariant: only `kind: leading` outcomes ever drive a holdback decision.
 * Terminal outcomes are too slow for any watch window (outcomes.yaml schema
 * comment + CONTEXT.md) and are filtered out here so a caller cannot
 * accidentally watch one.
 *
 * Per CLAUDE.md conventions:
 *   - Never throws: a failed load yields an empty snapshot (logged by
 *     `loadOutcomes`); the pure helpers return `false`/`[]` on no-data.
 *   - Adapter outages surface as `value: null` — never a synthetic 0 — so a
 *     missing reading is treated as no-data, never a false regression.
 */

import {
  loadOutcomes,
  getOutcomeValue,
  DEFAULT_OUTCOMES_FILE,
  type OutcomeDirection,
} from "./outcomes.ts";

/** One leading-outcome sample: the outcome's contract fields + current value. */
export interface LeadingOutcomeSample {
  name: string;
  direction: OutcomeDirection;
  /** Absolute change below this is treated as no-move. */
  noiseEpsilon: number;
  /** Current value, or null if the adapter returned no data (no-data, not 0). */
  value: number | null;
}

/**
 * Snapshot the current value of every `kind: leading` outcome.
 *
 * Returns one sample per leading outcome (terminal outcomes are excluded).
 * Adapter outages surface as `value: null` — never as a synthetic 0 — so the
 * regression detector can treat them as no-data rather than a false regression.
 * Never throws: a failed load yields an empty array (logged by `loadOutcomes`).
 */
export async function snapshotLeadingOutcomes(
  filePath: string = DEFAULT_OUTCOMES_FILE,
): Promise<LeadingOutcomeSample[]> {
  const result = await loadOutcomes(filePath);
  if (result.ok === false) return [];
  const leading = result.outcomes.filter((o) => o.kind === "leading");
  return Promise.all(
    leading.map(async (o) => {
      const reading = await getOutcomeValue(o);
      return {
        name: o.name,
        direction: o.direction,
        noiseEpsilon: o.noise_epsilon,
        value: reading?.value ?? null,
      };
    }),
  );
}

/**
 * Decide whether a single leading outcome has regressed vs its baseline.
 *
 * A regression is a move in the UNFAVORABLE direction (opposite `direction`)
 * whose magnitude EXCEEDS `noiseEpsilon`. A favorable move, a no-move (delta
 * ≤ epsilon), or missing data on either side is NOT a regression.
 *
 *   direction: "up"   → regressed when current < baseline by more than epsilon
 *   direction: "down" → regressed when current > baseline by more than epsilon
 *
 * Returns `false` (no regression) when either value is null — adapter outages
 * are no-data, never a synthetic regression (matches the historical watcher's
 * "no false revert" posture, docs/reference.md).
 */
export function isOutcomeRegressed(
  baselineValue: number | null,
  currentValue: number | null,
  direction: OutcomeDirection,
  noiseEpsilon: number,
): boolean {
  if (baselineValue == null || currentValue == null) return false;
  if (!Number.isFinite(baselineValue) || !Number.isFinite(currentValue)) return false;
  const eps = Number.isFinite(noiseEpsilon) ? Math.abs(noiseEpsilon) : 0;
  // Favorable delta is positive when moving the favorable way.
  const favorableDelta = direction === "up"
    ? currentValue - baselineValue
    : baselineValue - currentValue;
  // Regressed = moved unfavorably by MORE than epsilon.
  return favorableDelta < -eps;
}

/** A leading outcome that regressed past its noise epsilon vs baseline. */
export interface OutcomeRegression {
  name: string;
  baseline: number;
  current: number;
  direction: OutcomeDirection;
  noiseEpsilon: number;
}

/**
 * Compare a baseline snapshot against a current snapshot and return the leading
 * outcomes that regressed past their noise epsilon. The two arrays are matched
 * by outcome `name`; an outcome present in one but not the other, or with null
 * data on either side, is skipped (no-data, not a regression).
 *
 * Pure function — no I/O — so the producer (and its tests) can reason about the
 * revert decision deterministically.
 */
export function detectRegressions(
  baseline: Array<{ name: string; direction: OutcomeDirection; noiseEpsilon: number; value: number | null }>,
  current: Array<{ name: string; value: number | null }>,
): OutcomeRegression[] {
  const currentByName = new Map(current.map((c) => [c.name, c.value]));
  const regressions: OutcomeRegression[] = [];
  for (const b of baseline) {
    const cur = currentByName.has(b.name) ? currentByName.get(b.name)! : null;
    if (isOutcomeRegressed(b.value, cur, b.direction, b.noiseEpsilon)) {
      regressions.push({
        name: b.name,
        baseline: b.value as number,
        current: cur as number,
        direction: b.direction,
        noiseEpsilon: b.noiseEpsilon,
      });
    }
  }
  return regressions;
}
