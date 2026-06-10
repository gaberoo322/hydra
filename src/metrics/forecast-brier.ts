/**
 * Forecast-calibration Brier producer (issue #1657).
 *
 * Bridges the Target's calibration API to the `file` adapter of the Target
 * Outcomes loader (`src/outcomes.ts`). The 2026-06-10 direction refresh
 * declared the `forecast-calibration-brier` leading outcome in
 * `config/direction/outcomes.yaml` (source: file, query:
 * `metrics/forecast-calibration-brier.txt`, direction: down). This module is
 * the producer that writes that file; without it the outcome reads as
 * no-data forever and Outcome Holdback has no real target-health leading
 * outcome to watch.
 *
 * Source of truth: the Target's aggregate Brier score served by
 * `GET ${HYDRA_BETTING_URL}/api/calibration/forecast-metrics` (hydra-betting,
 * port 3333) as the top-level `brierScore` field (`number | null` — null
 * while the target has no scoreable forecasts yet).
 *
 * Staleness contract (per the issue's acceptance criteria):
 *   - Target unreachable / non-2xx / malformed body / `brierScore` null →
 *     the metric file is LEFT UNTOUCHED. A stale mtime is the staleness
 *     signal; a fabricated value would silently poison holdback baselines.
 *   - Only a finite numeric `brierScore` is ever written (via the same
 *     `writeMetricFile` contract orchestrator-share uses: single numeric
 *     line + newline, parent dirs created on demand).
 *
 * Cadence: the Heartbeat tick (5 min) calls `maybePublishForecastBrierMetric`
 * fire-and-forget; an internal throttle limits real publish attempts to once
 * per `HYDRA_BRIER_PUBLISH_INTERVAL_MS` (default hourly). The throttle stamps
 * at attempt START so an unreachable target is retried on the hourly cadence,
 * not on every tick.
 *
 * CLAUDE.md conventions:
 *   - Zero new dependencies; global fetch + node:path only.
 *   - Never throws. All failure paths log with `[forecast-brier]` prefix.
 */

import { join, resolve } from "node:path";
import { writeMetricFile } from "./publish.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME || "", "hydra");

/**
 * Default on-disk path for the forecast-calibration-brier metric. Matches
 * `query: metrics/forecast-calibration-brier.txt` in
 * `config/direction/outcomes.yaml` (resolved against HYDRA_ROOT, same as the
 * outcomes file adapter does).
 */
const DEFAULT_BRIER_METRIC_PATH = join(HYDRA_ROOT, "metrics", "forecast-calibration-brier.txt");

/** Same env + default the reflections API uses for the Target base URL. */
const DEFAULT_TARGET_BASE_URL = process.env.HYDRA_BETTING_URL || "http://localhost:3333";

/** The calibration route serving the aggregate Brier score (verified live). */
const FORECAST_METRICS_ROUTE = "/api/calibration/forecast-metrics";

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

/** Minimum gap between publish attempts. Hourly by default (issue #1657). */
const DEFAULT_PUBLISH_INTERVAL_MS = (() => {
  const raw = parseInt(process.env.HYDRA_BRIER_PUBLISH_INTERVAL_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
})();

export type PublishBrierReason =
  | "written" // finite brierScore fetched and written to disk
  | "write-failed" // fetched fine, but the disk write failed (writeMetricFile logged)
  | "target-unreachable" // network error / timeout / non-2xx — file untouched
  | "malformed-response" // body not JSON, or brierScore not number|null — file untouched
  | "no-data"; // target healthy but brierScore is null (no scoreable forecasts) — file untouched

export interface PublishBrierResult {
  ok: boolean;
  /** True only when the metric file was actually (re)written. */
  wrote: boolean;
  /** The Brier value written, when wrote === true. */
  value: number | null;
  reason: PublishBrierReason;
  /** Absolute path written (or that would have been written). */
  path: string;
}

export interface PublishBrierOptions {
  /** Override the metric file path (tests). Defaults to the outcomes.yaml query path. */
  filePath?: string;
  /** Override the Target base URL (tests). Defaults to HYDRA_BETTING_URL / localhost:3333. */
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Fetch the Target's aggregate Brier score and publish it to disk for the
 * outcomes `file` adapter. Never throws; every no-write path is logged with
 * enough context to diagnose (fail-loud convention).
 */
export async function publishForecastBrierMetric(
  opts: PublishBrierOptions = {},
): Promise<PublishBrierResult> {
  const filePath = opts.filePath || DEFAULT_BRIER_METRIC_PATH;
  const baseUrl = opts.baseUrl || DEFAULT_TARGET_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const url = `${baseUrl}${FORECAST_METRICS_ROUTE}`;

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    console.error(
      `[forecast-brier] target unreachable at ${url} — leaving ${filePath} untouched (stale mtime is the staleness signal): ${err?.message || String(err)}`,
    );
    return { ok: false, wrote: false, value: null, reason: "target-unreachable", path: filePath };
  }

  if (!response.ok) {
    console.error(
      `[forecast-brier] ${url} returned HTTP ${response.status} — leaving ${filePath} untouched`,
    );
    return { ok: false, wrote: false, value: null, reason: "target-unreachable", path: filePath };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err: any) {
    console.error(
      `[forecast-brier] ${url} body is not valid JSON — leaving ${filePath} untouched: ${err?.message || String(err)}`,
    );
    return { ok: false, wrote: false, value: null, reason: "malformed-response", path: filePath };
  }

  const brierScore = (body as { brierScore?: unknown } | null)?.brierScore;

  if (brierScore === null) {
    // Target is up but has no scoreable forecasts yet. Legitimate no-data —
    // not an error, but worth a trace line so a permanently-null score is
    // diagnosable from the logs.
    console.log(
      `[forecast-brier] ${url} reports brierScore=null (no scoreable forecasts yet) — leaving ${filePath} untouched`,
    );
    return { ok: true, wrote: false, value: null, reason: "no-data", path: filePath };
  }

  if (typeof brierScore !== "number" || !Number.isFinite(brierScore)) {
    console.error(
      `[forecast-brier] ${url} brierScore is not a finite number (got ${JSON.stringify(brierScore)}) — leaving ${filePath} untouched`,
    );
    return { ok: false, wrote: false, value: null, reason: "malformed-response", path: filePath };
  }

  const wrote = await writeMetricFile(brierScore, filePath);
  if (!wrote) {
    // writeMetricFile already logged the failure with path context.
    return { ok: false, wrote: false, value: brierScore, reason: "write-failed", path: filePath };
  }
  return { ok: true, wrote: true, value: brierScore, reason: "written", path: filePath };
}

// ---------------------------------------------------------------------------
// Heartbeat-facing throttle wrapper
// ---------------------------------------------------------------------------

let lastAttemptAtMs = 0;

/** Test seam: reset the throttle so each test starts from a cold state. */
export function resetForecastBrierThrottle(): void {
  lastAttemptAtMs = 0;
}

/**
 * Throttled entry point for the Heartbeat tick. Publishes at most once per
 * `HYDRA_BRIER_PUBLISH_INTERVAL_MS` (default hourly); returns `null` when the
 * call is inside the cool-down window (no fetch performed). The attempt time
 * is stamped BEFORE the fetch so an unreachable target retries hourly rather
 * than on every 5-minute tick.
 */
export async function maybePublishForecastBrierMetric(
  opts: PublishBrierOptions & { nowMs?: number; intervalMs?: number } = {},
): Promise<PublishBrierResult | null> {
  const now = opts.nowMs ?? Date.now();
  const intervalMs = opts.intervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS;
  if (now - lastAttemptAtMs < intervalMs) return null;
  lastAttemptAtMs = now;
  return publishForecastBrierMetric(opts);
}
