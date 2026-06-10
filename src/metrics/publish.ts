/**
 * Metrics file publisher (issue #315).
 *
 * Bridges the runtime capacity-floor history (Redis) to the `file` adapter
 * of the Target Outcomes loader (`src/outcomes.ts`). `config/direction/
 * outcomes.yaml` seeds one leading outcome — `orchestrator-self-improvement-
 * share` — backed by `source: file` reading `metrics/orchestrator-share.txt`.
 * Until that file exists, the adapter logs an ENOENT every Meta-analysis
 * tick. (The stuckness detector that originally consumed this signal was
 * retired in ADR-0010; the metric still has value as a read-only outcome.)
 *
 * On each cycle completion we compute the current orchestrator-side share
 * from `getSelfImprovementShare()` and write it to disk so the outcomes
 * file adapter can read it. Best-effort: failures are logged but never
 * thrown — this is observability, not critical-path, and the outcomes
 * adapter itself treats missing/unreadable files as "no signal".
 *
 * CLAUDE.md conventions:
 *   - Zero new dependencies; node:fs only.
 *   - Never throws.
 *   - All catches log with `[metrics-publisher]` prefix.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  DEFAULT_WINDOW_CYCLES,
  getSelfImprovementShare,
  type ShareResult,
} from "../capacity-floor.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME || "", "hydra");

/**
 * Default on-disk path for the orchestrator-self-improvement-share metric.
 * Matches `query: metrics/orchestrator-share.txt` in
 * `config/direction/outcomes.yaml`. Relative paths are resolved against
 * HYDRA_ROOT so the same code works under systemd or `npx tsx`.
 */
const DEFAULT_SHARE_METRIC_PATH = join(HYDRA_ROOT, "metrics", "orchestrator-share.txt");

/**
 * Resolve a metric path against HYDRA_ROOT when relative.
 */
function resolveMetricPath(p: string): string {
  return isAbsolute(p) ? p : resolve(HYDRA_ROOT, p);
}

/**
 * Write a numeric metric value to disk, creating parent directories as
 * needed. Best-effort; logs and returns false on failure.
 *
 * Pure-ish: takes the value as input so it can be tested without touching
 * Redis / the capacity-floor history. The composing publisher below does
 * the Redis read.
 */
export async function writeMetricFile(value: number, filePath: string): Promise<boolean> {
  if (!Number.isFinite(value)) {
    console.error(`[metrics-publisher] refusing to write non-finite value ${value} to ${filePath}`);
    return false;
  }
  const resolved = resolveMetricPath(filePath);
  try {
    await mkdir(dirname(resolved), { recursive: true });
    // Outcomes file adapter does Number(raw.trim()); a single line + newline
    // is the simplest format and matches the example in the issue body ("0.18").
    // Cap precision to 6dp — share is a fraction so this is far below noise.
    const serialized = `${Number(value.toFixed(6))}\n`;
    await writeFile(resolved, serialized, "utf-8");
    return true;
  } catch (err: any) {
    console.error(
      `[metrics-publisher] failed to write ${resolved}: ${err?.message || String(err)}`,
    );
    return false;
  }
}

export interface PublishShareResult {
  ok: boolean;
  /** The value actually written. */
  value: number;
  /** Window count that produced the share (0 when no signal yet). */
  windowCount: number;
  /** Absolute path written (or attempted). */
  path: string;
}

/**
 * Read the current orchestrator-self-improvement share from the
 * capacity-floor history and publish it to disk so the outcomes file
 * adapter can read it on the next Meta-analysis tick.
 *
 * Always writes a finite number. When no cycles have been recorded yet
 * (windowCount === 0), the share is 0 by definition — writing 0 is still
 * useful: it tells the file adapter "the answer is currently zero". The
 * alternative — not writing at all — is exactly the failure mode this issue
 * exists to fix.
 */
export async function publishOrchestratorShareMetric(
  opts: { filePath?: string; windowCycles?: number } = {},
): Promise<PublishShareResult> {
  const filePath = opts.filePath || DEFAULT_SHARE_METRIC_PATH;
  const windowCycles = opts.windowCycles ?? DEFAULT_WINDOW_CYCLES;
  let share: ShareResult;
  try {
    share = await getSelfImprovementShare(windowCycles);
  } catch (err: any) {
    console.error(
      `[metrics-publisher] getSelfImprovementShare failed (non-fatal): ${err?.message || String(err)}`,
    );
    return { ok: false, value: 0, windowCount: 0, path: resolveMetricPath(filePath) };
  }
  const ok = await writeMetricFile(share.share, filePath);
  return {
    ok,
    value: share.share,
    windowCount: share.windowCount,
    path: resolveMetricPath(filePath),
  };
}

// ---------------------------------------------------------------------------
// forecast-calibration-brier producer (issue #1657)
// ---------------------------------------------------------------------------

/**
 * Default on-disk path for the forecast-calibration-brier metric. Matches
 * `query: metrics/forecast-calibration-brier.txt` in
 * `config/direction/outcomes.yaml` (declared in the 2026-06-10 direction
 * refresh, PR #1658).
 */
const DEFAULT_BRIER_METRIC_PATH = join(HYDRA_ROOT, "metrics", "forecast-calibration-brier.txt");

/**
 * Time-bound on the target fetch so an unresponsive hydra-betting service
 * can never wedge the housekeeping endpoint.
 */
const DEFAULT_BRIER_FETCH_TIMEOUT_MS = 10_000;

export interface PublishBrierResult {
  ok: boolean;
  /**
   * Why the file was left untouched (absent on success):
   *   - `fetch-failed`        target unreachable / timed out
   *   - `non-200`             target answered but not OK
   *   - `malformed-response`  body was not parseable JSON
   *   - `no-score`            `brierScore` was null / non-finite (null until
   *                           enough resolved forecasts exist — by design)
   *   - `write-failed`        fs write failed (already logged by writeMetricFile)
   */
  reason?: "fetch-failed" | "non-200" | "malformed-response" | "no-score" | "write-failed";
  /** The Brier score fetched (present once parsed, even if the write failed). */
  value?: number;
  /** Absolute path written (or attempted). */
  path: string;
}

/**
 * Fetch the target's aggregate Brier score and publish it to
 * `metrics/forecast-calibration-brier.txt` so the outcomes file adapter can
 * read the `forecast-calibration-brier` leading outcome (issue #1657).
 *
 * Source of truth: hydra-betting `GET /api/calibration/forecast-metrics`,
 * whose top-level `brierScore: number | null` is the aggregate over scoreable
 * resolved forecasts. Base URL comes from `HYDRA_BETTING_URL` (default
 * `http://localhost:3333`) — same precedent as `src/api/reflections.ts`.
 *
 * NEVER writes a fabricated value: on fetch failure, non-200, malformed JSON,
 * or null/non-finite `brierScore`, the metric file is left untouched — its
 * stale mtime is the staleness signal, and `getOutcomeValue` already treats a
 * missing file as no-data (never a regression). Never throws; every failure
 * path logs with `[metrics-publisher]` context and returns a result object.
 *
 * `fetchImpl` / `filePath` / `baseUrl` are injectable so tests run without a
 * live target.
 */
export async function publishForecastCalibrationBrierMetric(
  opts: {
    filePath?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<PublishBrierResult> {
  const filePath = opts.filePath || DEFAULT_BRIER_METRIC_PATH;
  const path = resolveMetricPath(filePath);
  const baseUrl = opts.baseUrl || process.env.HYDRA_BETTING_URL || "http://localhost:3333";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BRIER_FETCH_TIMEOUT_MS;
  const url = `${baseUrl}/api/calibration/forecast-metrics`;

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: any) {
    console.error(
      `[metrics-publisher] forecast-calibration-brier: target fetch failed (${url}): ${err?.message || String(err)} — leaving ${path} untouched`,
    );
    return { ok: false, reason: "fetch-failed", path };
  }

  if (!response.ok) {
    console.error(
      `[metrics-publisher] forecast-calibration-brier: target returned HTTP ${response.status} (${url}) — leaving ${path} untouched`,
    );
    return { ok: false, reason: "non-200", path };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err: any) {
    console.error(
      `[metrics-publisher] forecast-calibration-brier: malformed JSON from ${url}: ${err?.message || String(err)} — leaving ${path} untouched`,
    );
    return { ok: false, reason: "malformed-response", path };
  }

  const brierScore = (body as { brierScore?: unknown } | null)?.brierScore;
  if (typeof brierScore !== "number" || !Number.isFinite(brierScore)) {
    console.error(
      `[metrics-publisher] forecast-calibration-brier: brierScore is ${JSON.stringify(brierScore ?? null)} (null until enough resolved forecasts exist) — leaving ${path} untouched`,
    );
    return { ok: false, reason: "no-score", path };
  }

  const wrote = await writeMetricFile(brierScore, filePath);
  if (!wrote) {
    return { ok: false, reason: "write-failed", value: brierScore, path };
  }
  return { ok: true, value: brierScore, path };
}
