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
 * shapes, and the {@link productionOutputReader} that wires the declared seed
 * source to its real data plane.
 *
 * PRODUCTION DATA PLANE (issue #2578): the single declared `output` entry's
 * source — `/api/scanner/latest @ funnelBreakdown.registryPairs` — lives on the
 * TARGET (`~/hydra-betting/web`), NOT in-process. The orchestrator reaches it
 * over HTTP via `getTargetWebUrl()` (the established cross-process proxy seam,
 * same precedent as `src/api/reflections.ts` / `src/metrics/publish.ts`). The
 * issue title's "metric-trend source" is a MISNOMER: `getMetricsTrend()`
 * (`src/metrics/trend.ts`) reads orchestrator CYCLE metrics, which have no
 * knowledge of the betting scanner funnel — it is the wrong data plane and is
 * deliberately NOT wired here. Because the Target route returns ONE snapshot but
 * `evaluateOutputs` needs a trailing `runs`-length series, the production reader
 * ACCUMULATES the per-source series across hourly chore ticks in a bounded Redis
 * list, via the `src/redis/wiring-liveness-output-series.ts` typed accessor
 * (ADR-0009/ADR-0017). On a failed read it returns `{ ok: false }` and appends
 * NOTHING — a Target outage is UNREADABLE, never a fabricated zero observation.
 *
 * NEVER THROWS (CLAUDE.md fail-loud + host-probe never-throw conventions): a read
 * failure is an `{ ok: false, reason }` result, not an exception, so the chore
 * surfaces UNREADABLE rather than mistaking an absent series for a floor hit.
 */

import type { LivenessEntry, OutputEntry } from "../../schemas/liveness.ts";
import {
  appendOutputObservation,
  readOutputSeries,
} from "../../redis/wiring-liveness-output-series.ts";
import { getTargetWebUrl } from "../../target-config.ts";

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

// ---------------------------------------------------------------------------
// Production reader (issue #2578) — the real data plane for declared sources.
// ---------------------------------------------------------------------------

/**
 * Time-bound on the Target fetch so an unresponsive hydra-betting service can
 * never wedge the housekeeping run. Same discipline as
 * `publishForecastCalibrationBrierMetric` in `src/metrics/publish.ts`.
 */
const DEFAULT_OUTPUT_FETCH_TIMEOUT_MS = 10_000;

/**
 * The injectable surface the {@link productionOutputReader} closes over. Real
 * production uses the module defaults (`fetch`, `getTargetWebUrl()`, and the
 * `src/redis/wiring-liveness-output-series.ts` accessor); tests inject fakes so
 * the happy / non-2xx / missing-path / non-numeric / outage cases run without a
 * live Target or Redis.
 */
export interface ProductionOutputReaderDeps {
  /** Base URL of the Target web service. Defaults to `getTargetWebUrl()`. */
  baseUrl?: string;
  /** Fetch implementation. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-fetch timeout in ms. Defaults to {@link DEFAULT_OUTPUT_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Append one observation to the per-source bounded series. */
  appendObservation?: (source: string, jsonPath: string, value: number) => Promise<void>;
  /** Read back the accumulated series, most-recent-LAST. */
  readSeries?: (source: string, jsonPath: string) => Promise<number[]>;
}

/**
 * Extract a dotted JSON path (e.g. `funnelBreakdown.registryPairs`) from a parsed
 * response body, returning the leaf only when it is a finite number. Returns
 * `undefined` for a missing path or a non-numeric leaf — the caller folds that
 * into an `{ ok: false }` UNREADABLE result. Pure / no I/O, so it is unit-tested
 * directly.
 */
export function extractNumericPath(body: unknown, jsonPath: string): number | undefined {
  let cursor: unknown = body;
  for (const segment of jsonPath.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : undefined;
}

/**
 * The production {@link OutputSourceReader}. For one declared `output` entry it:
 *   1. fetches `${baseUrl}${entry.source}` from the Target (the
 *      `/api/scanner/latest` route lives in `~/hydra-betting/web`, reached via
 *      the `getTargetWebUrl()` proxy seam — NOT an orchestrator self-call);
 *   2. extracts `entry.jsonPath` as a finite number;
 *   3. APPENDS that one observation to the per-source bounded Redis series and
 *      reads the trailing series back, returning `{ ok: true, values }`
 *      (most-recent-LAST) for the pure `evaluateOutputs` to window over.
 *
 * On ANY failure — Target unreachable / timeout, non-2xx, malformed JSON, missing
 * path, non-numeric leaf — it returns `{ ok: false, reason }` and APPENDS NOTHING.
 * A transient Target outage is therefore UNREADABLE (informational), never a
 * fabricated zero that would later read back as a floor hit. NEVER THROWS: every
 * failure path is caught and folded into the result, honoring the module's
 * never-throw contract and the `evaluateOutputs` UNREADABLE-not-alarm invariant.
 *
 * `deps` is injectable so tests exercise every branch without a live Target/Redis.
 */
export function productionOutputReader(
  deps: ProductionOutputReaderDeps = {},
): OutputSourceReader {
  const baseUrl = deps.baseUrl ?? getTargetWebUrl();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_OUTPUT_FETCH_TIMEOUT_MS;
  const appendObservation = deps.appendObservation ?? appendOutputObservation;
  const readSeries = deps.readSeries ?? readOutputSeries;

  return async (entry: OutputEntry): Promise<OutputSeriesResult> => {
    const url = `${baseUrl}${entry.source}`;

    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err: any) {
      return { ok: false, reason: `target fetch failed (${url}): ${err?.message || String(err)}` };
    }

    if (!response.ok) {
      return { ok: false, reason: `target returned HTTP ${response.status} (${url})` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err: any) {
      return { ok: false, reason: `malformed JSON from ${url}: ${err?.message || String(err)}` };
    }

    const value = extractNumericPath(body, entry.jsonPath);
    if (value === undefined) {
      return {
        ok: false,
        reason: `missing or non-numeric jsonPath '${entry.jsonPath}' in response from ${url}`,
      };
    }

    // Success: append the fresh observation, then read the trailing series back.
    // The append/read are best-effort against Redis; a Redis failure surfaces as
    // UNREADABLE (never a throw, never a fabricated value).
    try {
      await appendObservation(entry.source, entry.jsonPath, value);
      const values = await readSeries(entry.source, entry.jsonPath);
      return { ok: true, values };
    } catch (err: any) {
      return {
        ok: false,
        reason: `output-series accumulation failed for '${entry.source}': ${err?.message || String(err)}`,
      };
    }
  };
}
