/**
 * Wiring-liveness TYPE-VOCABULARY leaf (issue #3241; parent epic #3239).
 *
 * Zero-logic, zero-I/O, zero-singleton leaf that owns the shared type vocabulary
 * of the wiring-liveness chore cluster: the aggregate {@link WiringLivenessResult}
 * and the per-check-family verdict/result types ({@link TimerVerdict},
 * {@link OutputVerdict}, {@link OutcomeVerdict}, {@link DarkAlarmResult}).
 *
 * The wiring-liveness chore composes four structurally-independent CHECK FAMILIES
 * — timer / output / dark-outcomes / dark-alarm (see `wiring-liveness.ts`) — into
 * a single aggregate result. Before this leaf, the check-family taxonomy (what
 * families exist, what verdict each returns, how they contribute to the aggregate)
 * lived implicitly across the coordinator and its four siblings: each verdict type
 * was declared in its own family module and the aggregate was declared in the
 * coordinator. Adding a new check family meant understanding all five files to
 * find the right merge point.
 *
 * This leaf concentrates that taxonomy behind a clean seam. The coordinator imports
 * {@link WiringLivenessResult} DOWN from here; each family sibling imports its own
 * verdict type from here rather than declaring it locally. Adding a new check
 * family then touches this types leaf (new verdict type) and the coordinator (new
 * merge point) only — the check-family vocabulary is answerable from one focused
 * file. Mirrors the HealthSnapshot type-vocabulary leaf (`src/health/types.ts`,
 * #3230/#3246) and the CandidateSuppressionDecision leaf (#3240/#3247).
 *
 * Wire shapes are byte-identical to their previous per-module homes — this is a
 * pure type-relocation with no API-surface change.
 */

// ---------------------------------------------------------------------------
// Timer check family (slice 1, #2287; family sibling wiring-liveness-timer.ts)
// ---------------------------------------------------------------------------

/** Per-entry verdict from diffing a declared timer against the live set. */
export type TimerVerdict =
  | { unit: string; status: "ok"; lastFiredMsAgo: number }
  | { unit: string; status: "missing" }
  | { unit: string; status: "not-yet-fired" }
  | { unit: string; status: "stale"; lastFiredMsAgo: number; maxStaleMinutes: number };

// ---------------------------------------------------------------------------
// Output check family (slice 2, #2288; family sibling wiring-liveness-output.ts)
// ---------------------------------------------------------------------------

/** Per-entry verdict from evaluating a declared output source (slice 2). */
export type OutputVerdict =
  | { source: string; jsonPath: string; status: "ok"; latest: number }
  | {
      source: string;
      jsonPath: string;
      status: "below-floor";
      window: number[];
      floor: number;
      runs: number;
    }
  | { source: string; jsonPath: string; status: "unreadable"; reason: string };

// ---------------------------------------------------------------------------
// Dark-outcomes check family (#2753; family sibling wiring-liveness-outcomes.ts)
// ---------------------------------------------------------------------------

/**
 * Per-outcome verdict from evaluating a declared `kind: leading` outcome.
 *
 * Invariant 3 (approved design concept, issue #2753): DARK (a `null` reading —
 * no data ever produced) and STALE (a finite reading whose file mtime is older
 * than the grace window) are DISTINCT verdicts. A present-but-old value is never
 * conflated with a never-produced one.
 */
export type OutcomeVerdict =
  | { name: string; kind: "leading"; status: "live"; value: number; ts: string; ageMs: number }
  | { name: string; kind: "leading"; status: "dark"; query: string; producerHint: string }
  | {
      name: string;
      kind: "leading";
      status: "stale";
      value: number;
      ts: string;
      ageMs: number;
      maxStaleMs: number;
      query: string;
      producerHint: string;
    };

// ---------------------------------------------------------------------------
// Dark-alarm check family (#2805; family sibling wiring-liveness-dark-alarm.ts)
// ---------------------------------------------------------------------------

/** Per-outcome outcome of one dark-alarm pass, for diagnostics/tests. */
export type DarkAlarmOutcome =
  /** Dark, but the streak has not yet reached the threshold — nothing filed. */
  | { name: string; action: "below-threshold"; darkForMs: number }
  /** Dark past threshold, but an issue was already filed this streak — deduped. */
  | { name: string; action: "already-filed"; darkForMs: number }
  /** Dark past threshold and freshly filed — carries the new issue number (0 on parse miss). */
  | { name: string; action: "filed"; darkForMs: number; issueNumber: number }
  /** The gh file attempt failed — logged, never thrown (Invariant 3). */
  | { name: string; action: "file-failed"; darkForMs: number; reason: string };

/** The aggregated result of one dark-alarm pass. */
export interface DarkAlarmResult {
  /** Outcome names for which a NEW needs-triage issue was filed this pass. */
  filed: string[];
  /** Every per-outcome alarm outcome, for diagnostics/tests. */
  outcomes: DarkAlarmOutcome[];
}

// ---------------------------------------------------------------------------
// Aggregate result (issue #2844: assembled by the coordinator from all four
// check families; relocated here from wiring-liveness.ts by #3241)
// ---------------------------------------------------------------------------

/**
 * The chore's aggregate never-throwing result object. Assembled by the coordinator
 * (`runWiringLiveness` in `wiring-liveness.ts`) from all four check-family results:
 * timer-diff (slice 1, #2287), output-series (slice 2, #2288), dark-outcomes
 * (#2753), and dark-alarm (#2805).
 */
export interface WiringLivenessResult {
  /** True when the manifest loaded and the live timers were read. */
  evaluated: boolean;
  /** When `evaluated` is false, why (load/probe failure). */
  reason?: string;
  /** Declared timers absent from the live set. */
  missing: string[];
  /** Declared timers present but staler than their window. */
  stale: string[];
  /** Declared timers present but never-fired-yet (false-positive guard). */
  notYetFired: string[];
  /** Declared output sources pinned at/below their floor across the run window. */
  belowFloor: string[];
  /** Declared output sources whose live value could not be read this run. */
  unreadable: string[];
  /**
   * Declared `kind: leading` outcomes whose current reading is `null` — no data
   * (producer never wrote the metric, or the file went missing/unparseable).
   * Advisory (issue #2753): a dark leading outcome is silent holdback blindness.
   */
  darkOutcomes: string[];
  /**
   * Declared `kind: leading` outcomes with a finite reading whose file mtime is
   * OLDER than the grace window — a present-but-old value (a stalled producer),
   * distinct from a `null` (never-produced) DARK outcome. Invariant 3 (issue
   * #2753): STALE and DARK are separate verdicts, never conflated. Advisory only.
   */
  staleOutcomes: string[];
  /** Every per-entry timer verdict, for diagnostics/tests. */
  verdicts: TimerVerdict[];
  /** Every per-entry output verdict, for diagnostics/tests. */
  outputVerdicts: OutputVerdict[];
  /** Every per-outcome dark/live verdict, for diagnostics/tests (issue #2753). */
  outcomeVerdicts: OutcomeVerdict[];
  /**
   * Outcome-alarm result (issue #2805): which dark leading outcomes crossed the
   * 7-day sustained-dark threshold and got a fresh `needs-triage` issue filed
   * this tick, plus the per-outcome alarm actions (below-threshold / already-filed
   * / filed / file-failed). `undefined` when the alarm did not run (e.g. an
   * evaluation short-circuit). Advisory — a file failure never aborts the chore.
   */
  darkAlarm?: DarkAlarmResult;
}
