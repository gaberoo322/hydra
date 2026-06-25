/**
 * Wiring-liveness OUTPUT-check seam (issue #2456; extracted from
 * `wiring-liveness.ts`, originally landed by #2288 slice 2; parent epic #2286).
 *
 * One check type, one module. The wiring-liveness chore owns two orthogonal
 * checks over the same `LivenessManifest`: the timer-diff path (live, exercised
 * hourly — stays in `wiring-liveness.ts`) and the output-series path (this
 * module). They share only the manifest schema (a discriminated union on
 * `type`); their data paths are otherwise independent. This module concentrates
 * the output path so "what does the output check do, and what is its production
 * data path?" is answerable from one focused file rather than a 500-line chore
 * that interleaves both checks — the same structural separation
 * `src/notification/alert-grammar.ts` / `cycle-completed-reactor.ts` gave the
 * notification path when they were extracted from `notification-consumer.ts`
 * (#1979/#1983).
 *
 * It owns: the `OutputSourceReader` injection surface, the pure
 * {@link evaluateOutputs} evaluator, the `OutputVerdict` / `OutputSeriesResult`
 * shapes, and the {@link defaultOutputReader} placeholder. The placeholder lives
 * HERE — next to where the real production reader (an Orchestrator metric-trend
 * query) belongs — so the wiring gap between the declared `output` entry in
 * `config/direction/liveness.yaml` and the no-op default is structurally visible
 * in this file's header rather than buried elsewhere.
 *
 * NEVER THROWS (CLAUDE.md fail-loud + host-probe never-throw conventions): a read
 * failure is an `{ ok: false, reason }` result, not an exception, so the chore
 * surfaces UNREADABLE rather than mistaking an absent series for a floor hit.
 */

import type { LivenessEntry, OutputEntry } from "../../schemas/liveness.ts";

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

/**
 * The trailing run-series for one output source, most-recent-LAST. The chore asks
 * the injected reader for observations of `source`@`jsonPath`; the reader returns
 * the numeric values it observed across recent runs (it MAY return fewer than the
 * window — a young source). A failed read returns an error result so the chore
 * surfaces UNREADABLE rather than mistaking an absent series for a floor hit.
 */
export type OutputSeriesResult =
  | { ok: true; values: number[] }
  | { ok: false; reason: string };

/**
 * Type guard narrowing an {@link OutputSeriesResult} to its failure arm. As with
 * the host-probe `isProbeFailure`, the orchestrator's `strict: false` tsconfig
 * cannot discriminate this union on `ok` via a plain `if (!series.ok)`, so callers
 * narrow through this guard instead.
 */
function isSeriesFailure(
  result: OutputSeriesResult,
): result is { ok: false; reason: string } {
  return result.ok === false;
}

/**
 * Injectable reader for an output source's trailing run-series. Real callers wire
 * this to whatever queries the live source (an Orchestrator API path / metric
 * history); tests inject a deterministic fake so below-floor / at-floor /
 * recovered cases are reproducible without network or time. Never throws — a read
 * failure is an `{ ok: false, reason }` result.
 */
export type OutputSourceReader = (entry: OutputEntry) => Promise<OutputSeriesResult>;

/** The aggregated verdicts a single output-evaluation pass produces. */
export interface OutputEvaluation {
  /** Declared output sources pinned at/below their floor across the run window. */
  belowFloor: string[];
  /** Declared output sources whose live value could not be read this run. */
  unreadable: string[];
  /** Every per-entry output verdict, for diagnostics/tests. */
  outputVerdicts: OutputVerdict[];
}

/**
 * Pure evaluation of declared `output` entries against their trailing run-series.
 * Exported so the verdict logic is unit-tested without I/O.
 *
 * For each `output` entry the reader is asked for the source's recent values; the
 * verdict is:
 *   - UNREADABLE  — the reader failed. Surfaced distinctly from a floor hit (an
 *                   unreadable source is NOT a zero-output source).
 *   - BELOW-FLOOR — the trailing window (the last `runs` observations) is full
 *                   AND every value in it is `<= minOverRuns.value`. This is the
 *                   live-but-inert signal: the source ran but stayed pinned at or
 *                   under the floor across the whole window.
 *   - OK          — at least one value in the window is ABOVE the floor (a
 *                   recovered source clears immediately — no sticky
 *                   false-positive), or the series is shorter than `runs` (not
 *                   yet enough history to conclude inert).
 */
export async function evaluateOutputs(
  entries: LivenessEntry[],
  read: OutputSourceReader,
): Promise<OutputEvaluation> {
  const belowFloor: string[] = [];
  const unreadable: string[] = [];
  const outputVerdicts: OutputVerdict[] = [];

  for (const entry of entries) {
    if (entry.type !== "output") continue;
    const source = entry.source;
    const jsonPath = entry.jsonPath;
    const floor = entry.minOverRuns.value;
    const runs = entry.minOverRuns.runs;

    const series = await read(entry);
    if (isSeriesFailure(series)) {
      outputVerdicts.push({ source, jsonPath, status: "unreadable", reason: series.reason });
      unreadable.push(source);
      continue;
    }

    // Take the trailing `runs` observations (most-recent-last).
    const window = series.values.slice(-runs);

    // Not enough history yet to conclude the source is inert → OK (no alarm).
    if (window.length < runs) {
      const latest = window.length > 0 ? window[window.length - 1] : floor;
      outputVerdicts.push({ source, jsonPath, status: "ok", latest });
      continue;
    }

    // BELOW-FLOOR only when EVERY value in the full window is at or below the
    // floor. A single value above the floor → OK (recovered, no sticky alert).
    const allAtOrBelow = window.every((v) => v <= floor);
    if (allAtOrBelow) {
      outputVerdicts.push({ source, jsonPath, status: "below-floor", window, floor, runs });
      belowFloor.push(source);
      continue;
    }

    outputVerdicts.push({ source, jsonPath, status: "ok", latest: window[window.length - 1] });
  }

  return { belowFloor, unreadable, outputVerdicts };
}

/**
 * The default output reader: a no-op that reports every output source UNREADABLE
 * with a "no live reader wired" reason. The live source reader (an Orchestrator
 * API / metric-history query) is a follow-up; until then output entries are
 * declared in the manifest and exercised by tests via an injected reader, but the
 * scheduled chore does not yet hit a real source — it stays silent because an
 * UNREADABLE verdict is informational, not an alert (see `runWiringLiveness`).
 *
 * It lives in this focused module — next to where the real production reader
 * belongs — so the wiring gap is structurally visible rather than buried in the
 * timer-check file.
 */
export const defaultOutputReader: OutputSourceReader = async (entry) => ({
  ok: false,
  reason: `no live output reader wired for source '${entry.source}'`,
});
