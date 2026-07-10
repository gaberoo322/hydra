/**
 * Target Outcomes domain types (issue #3086, architecture-scan leaf).
 *
 * Zero-I/O leaf holding the pure domain vocabulary for the outcome loader:
 * the `Outcome` record and its field enums (`OutcomeKind`, `OutcomeDirection`,
 * `OutcomeSource`), the point-in-time `OutcomeReading`, and the
 * `LoadOutcomesResult` result type. Extracted from `src/outcomes.ts` following
 * the `src/outcomes-yaml.ts` precedent (#933): the I/O coordinator
 * (`loadOutcomes`/`getOutcomeValue`, which touch `node:fs` and the network)
 * stays in `outcomes.ts` and re-exports these types for back-compat, so every
 * existing importer of `./outcomes.ts` is undisturbed.
 *
 * This module imports NOTHING with an effect — no `node:fs`, no `fetch`, no
 * Redis. A caller that needs only the `Outcome` type for a signature annotation
 * (or a test that constructs an `Outcome[]` fixture as plain literals) can
 * import from here without pulling the fetch/filesystem layer into module-load
 * scope.
 */

/** Whether an outcome is a fast leading indicator or a slow terminal one. */
export type OutcomeKind = "leading" | "terminal";

/** Which way "better" points for an outcome's value. */
export type OutcomeDirection = "up" | "down";

/**
 * Where an outcome's current value is read from. Today this is `file` only —
 * the single adapter that is actually implemented (#933). `prometheus | api |
 * sql` were live-looking stubs; they re-enter this union the day a real second
 * adapter lands (the "two adapters means a real seam" trigger, LANGUAGE.md).
 */
export type OutcomeSource = "file";

export interface Outcome {
  name: string;
  kind: OutcomeKind;
  direction: OutcomeDirection;
  source: OutcomeSource;
  query: string;
  baseline: number;
  target: number;
  noise_epsilon: number;
  /**
   * Per-metric attribution-window duration in milliseconds (issue #2632,
   * additive/optional). The outcome-attribution recorder opens one window per
   * live leading metric when a merge lands and closes each on ITS OWN duration
   * — a fast metric (test-count) settles in minutes, a slow one (Brier) needs
   * days — so this is keyed on how fast the metric moves, distinct from the
   * per-MERGE tier watch windows (`windowCyclesForTier`) keyed on blast radius.
   * Undefined ⇒ the recorder applies a conservative long default so an
   * unconfigured metric still closes eventually. Only meaningful for
   * `kind: leading` outcomes (the attribution spine only watches those).
   */
  attribution_window_ms?: number;
}

export interface OutcomeReading {
  value: number;
  ts: string;
}

export type LoadOutcomesResult =
  | { ok: true; outcomes: Outcome[] }
  | { ok: false; errors: string[] };
