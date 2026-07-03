/**
 * Wiring-liveness DARK-OUTCOME check seam (issue #2753; parent epic #2286).
 *
 * One check type, one module — the third check family the wiring-liveness chore
 * fans out to, a sibling of the timer-diff path (`wiring-liveness.ts`) and the
 * output-series path (`wiring-liveness-output.ts`). Where the output check
 * catches a live source pinned at/below a floor, THIS check catches a declared
 * `kind: leading` outcome (`config/direction/outcomes.yaml`) whose current
 * reading is `null` — i.e. the metric has NO reading at all: its producer never
 * wrote the metric file, or the file went missing/unparseable.
 *
 * Why leading-only: only `kind: leading` outcomes ever drive an Outcome Holdback
 * decision (terminal outcomes are too slow for the window — see outcomes.yaml).
 * A leading outcome whose reading is permanently `null` is a SILENT blindness:
 * every holdback baseline carries `value: null` for it and no signal ever
 * surfaces the gap. The architecture review identifies the terminal learning
 * signal (`forecast-calibration-brier`) as having "never existed" — this check
 * makes that condition VISIBLE as an advisory liveness verdict with a producer
 * hint, so the operator can diagnose which producer is dark.
 *
 * Advisory only (success-criterion of #2753): a dark outcome is surfaced as a
 * verdict + a warn log line, NOT a merge gate, NOT a revert, NOT a critical
 * health failure. It mirrors the output check's UNREADABLE/BELOW-FLOOR reporting
 * discipline.
 *
 * NEVER THROWS (CLAUDE.md fail-loud + host-probe never-throw conventions): a
 * failed outcomes load or a per-outcome read error is folded into a verdict, not
 * an exception, so the check can never abort the housekeeping run.
 */

import {
  loadOutcomes,
  getOutcomeValue,
  DEFAULT_OUTCOMES_FILE,
  type Outcome,
  type LoadOutcomesResult,
} from "../../outcomes.ts";

/** Per-outcome verdict from evaluating a declared `kind: leading` outcome. */
export type OutcomeVerdict =
  | { name: string; kind: "leading"; status: "live"; value: number }
  | { name: string; kind: "leading"; status: "dark"; query: string; producerHint: string };

/** The aggregated verdicts a single dark-outcome pass produces. */
export interface OutcomeEvaluation {
  /** Declared leading outcomes whose current reading is `null` (no data). */
  darkOutcomes: string[];
  /** Every per-outcome verdict, for diagnostics/tests. */
  outcomeVerdicts: OutcomeVerdict[];
}

/**
 * Injectable outcomes loader (defaults to the real {@link loadOutcomes}). Tests
 * inject a fake so the load-failure / all-live / dark cases run without a real
 * config file. Never throws — a load failure is a `{ ok: false, errors }`
 * result.
 */
export type OutcomesLoader = (filePath?: string) => Promise<LoadOutcomesResult>;

/**
 * Injectable per-outcome value reader (defaults to the real
 * {@link getOutcomeValue}). Returns the numeric reading or `null` when the
 * source is unreachable / not-yet-produced. Tests inject a deterministic fake so
 * dark vs live cases are reproducible without touching the filesystem.
 */
export type OutcomeValueReader = (outcome: Outcome) => Promise<{ value: number } | null>;

/** The external touchpoints of the dark-outcome check. */
export interface DarkOutcomesDeps {
  /** Injectable outcomes loader; defaults to {@link loadOutcomes}. */
  loadOutcomes?: OutcomesLoader;
  /** Injectable per-outcome value reader; defaults to {@link getOutcomeValue}. */
  readOutcomeValue?: OutcomeValueReader;
  /** Path to the outcomes manifest; defaults to {@link DEFAULT_OUTCOMES_FILE}. */
  outcomesPath?: string;
}

/**
 * Best-effort producer identity for a dark outcome, so the surfaced verdict tells
 * the operator WHAT to go look at rather than just "it is null". Keyed on the
 * outcome's declared `query` file — the path the producer is supposed to write.
 * A dedicated hint for the known-critical `forecast-calibration-brier` metric
 * (its producer is the Target's directional/paper-execution runner feeding the
 * forecast-outcome settlement loop); a generic file-path hint otherwise.
 */
export function producerHintFor(outcome: Outcome): string {
  if (outcome.name === "forecast-calibration-brier") {
    return (
      "producer chain: Target's directional/paper-execution runner " +
      "(hydra-betting-directional-nomination.timer) → forecast-outcome settlement " +
      "(hydra-betting-forecast-outcomes.timer) → writes " +
      `${outcome.query}; a null reading means no forecast has settled yet or the ` +
      "chain is not live (see #1657/#2448)"
    );
  }
  return `producer must write a finite numeric value to '${outcome.query}' (relative to HYDRA_ROOT)`;
}

/**
 * Type guard narrowing a {@link LoadOutcomesResult} to its failure arm. The
 * orchestrator's `strict: false` tsconfig cannot discriminate this union on the
 * boolean `ok` field via a plain `if (!result.ok)` (same limitation the
 * host-probe `isProbeFailure` and wiring-liveness `isLoadFailure` guards work
 * around), so callers narrow through this guard to reach `.errors`.
 */
function isLoadOutcomesFailure(
  result: LoadOutcomesResult,
): result is { ok: false; errors: string[] } {
  return result.ok === false;
}

/**
 * Pure-ish evaluation of declared `kind: leading` outcomes against their current
 * reading. Loads the outcomes manifest, filters to leading outcomes, and reads
 * each value through the injected reader:
 *   - LIVE  — the reader returned a finite numeric value.
 *   - DARK  — the reader returned `null` (producer never wrote the file, or it is
 *             missing/unparseable). Advisory only; carries a producer hint.
 *
 * `terminal` outcomes are intentionally skipped — they never drive a holdback
 * decision and are expected to move slowly, so a null terminal reading is not a
 * liveness gap the same way a null leading reading is.
 *
 * Never throws: a manifest load failure returns an empty evaluation (nothing
 * flagged, no exception — the failure is logged by the caller), mirroring how a
 * failed timer probe routes to `evaluated: false` rather than fabricating alarms.
 */
export async function evaluateDarkOutcomes(
  deps: DarkOutcomesDeps = {},
): Promise<OutcomeEvaluation> {
  const load = deps.loadOutcomes ?? loadOutcomes;
  const readValue = deps.readOutcomeValue ?? getOutcomeValue;
  const outcomesPath = deps.outcomesPath ?? DEFAULT_OUTCOMES_FILE;

  const darkOutcomes: string[] = [];
  const outcomeVerdicts: OutcomeVerdict[] = [];

  const loaded = await load(outcomesPath);
  if (isLoadOutcomesFailure(loaded)) {
    // A load failure is not a per-outcome dark condition — the outcomes loader
    // already logs the parse/schema errors. Surface nothing here so a malformed
    // manifest never masquerades as a flock of dark outcomes.
    console.error(
      `[Housekeeping] wiring-liveness dark-outcome check: could not load outcomes — ${loaded.errors.join("; ")}`,
    );
    return { darkOutcomes, outcomeVerdicts };
  }

  for (const outcome of loaded.outcomes) {
    if (outcome.kind !== "leading") continue;
    const reading = await readValue(outcome);
    if (reading === null || reading === undefined || !Number.isFinite(reading.value)) {
      outcomeVerdicts.push({
        name: outcome.name,
        kind: "leading",
        status: "dark",
        query: outcome.query,
        producerHint: producerHintFor(outcome),
      });
      darkOutcomes.push(outcome.name);
      continue;
    }
    outcomeVerdicts.push({
      name: outcome.name,
      kind: "leading",
      status: "live",
      value: reading.value,
    });
  }

  return { darkOutcomes, outcomeVerdicts };
}
