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
import { getTargetWebUrl } from "../target-config.ts";
import { logger } from "../logger.ts";

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
    logger.error(
      { value, filePath },
      "[metrics-publisher] refusing to write non-finite value",
    );
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
    logger.error({ path: resolved, err }, "[metrics-publisher] failed to write metric file");
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
    logger.error(
      { err },
      "[metrics-publisher] getSelfImprovementShare failed (non-fatal)",
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
 * Default on-disk directory for the per-league Brier sibling files (issue
 * #4247 / ADR-0007 D5). One file per league — `metrics/forecast-calibration-
 * brier-league/mlb.txt`, `…/nba.txt`, … — each holding a single numeric value
 * so the outcomes.yaml `file` source keeps its one-numeric-value-per-file
 * contract with no new source kind. Per-league outcomes in
 * `config/direction/outcomes.yaml` point their `query` here.
 */
const DEFAULT_BRIER_LEAGUE_DIR = join(HYDRA_ROOT, "metrics", "forecast-calibration-brier-league");

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
  /**
   * Per-league sibling files written from the same response (issue #4247).
   * Empty when no league slice carried data — a league with zero settled
   * forecasts is ABSENT (no file, no entry), never a phantom zero. Absent on
   * the failure arms: a failed fetch/parse writes nothing anywhere.
   */
  leagues?: LeagueBrierEntry[];
}

/** One published per-league Brier value (issue #4247 / ADR-0007 D5). */
export interface LeagueBrierEntry {
  /** Normalized league token (trim + lowercase), e.g. `mlb`. */
  league: string;
  /** The pooled per-league Brier as written to disk (6dp, like the aggregate). */
  value: number;
  /** Absolute path of the sibling file. */
  path: string;
}

/**
 * Fetch the target's aggregate Brier score and publish it to
 * `metrics/forecast-calibration-brier.txt` so the outcomes file adapter can
 * read the `forecast-calibration-brier` leading outcome (issue #1657).
 *
 * Source of truth: hydra-betting `GET /api/calibration/forecast-metrics`,
 * whose top-level `brierScore: number | null` is the aggregate over scoreable
 * resolved forecasts. Base URL comes from `getTargetWebUrl()`
 * (`HYDRA_TARGET_WEB_URL`, legacy `HYDRA_BETTING_URL`, default
 * `http://localhost:3333`) — same precedent as `src/api/reflections.ts`.
 *
 * Since issue #4247 (ADR-0007 D5) the SAME fetch also publishes per-league
 * sibling files under `metrics/forecast-calibration-brier-league/<league>.txt`
 * (see {@link DEFAULT_BRIER_LEAGUE_DIR}): the response's `bySourceLeague`
 * entries — keyed `"<source>:<league>"` — are grouped by their league segment
 * and pooled per league with a count-weighted average of the per-source
 * Briers. That pooling is mathematically exact, not an approximation: Brier
 * is a mean of squared errors, so `sum(count_i * brier_i) / sum(count_i)`
 * over the bySourceLeague entries of one league recovers the pooled Brier of
 * exactly the rows that league contributed (both groupings are computed over
 * the identical scored-rows population server-side). No hardcoded source
 * list is needed — whichever sources appear for a league contribute their
 * weight. The aggregate file itself keeps its sport-blind semantics and its
 * existing consumers; per-league outcomes in outcomes.yaml read the siblings.
 *
 * NEVER writes a fabricated value: on fetch failure, non-200, malformed JSON,
 * or null/non-finite `brierScore`, the metric file AND every league file are
 * left untouched — stale mtime is the staleness signal, and `getOutcomeValue`
 * already treats a missing file as no-data (never a regression). A league
 * whose slices carry no finite Brier is ABSENT (no file), never a phantom
 * zero — matching the target's own absent-not-phantom convention. Never
 * throws; every failure path logs with `[metrics-publisher]` context and
 * returns a result object.
 *
 * `fetchImpl` / `filePath` / `leagueDirPath` / `baseUrl` are injectable so
 * tests run without a live target.
 */
export async function publishForecastCalibrationBrierMetric(
  opts: {
    filePath?: string;
    /** Directory for the per-league sibling files (issue #4247). */
    leagueDirPath?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<PublishBrierResult> {
  const filePath = opts.filePath || DEFAULT_BRIER_METRIC_PATH;
  const leagueDirPath = opts.leagueDirPath || DEFAULT_BRIER_LEAGUE_DIR;
  const path = resolveMetricPath(filePath);
  const baseUrl = opts.baseUrl || getTargetWebUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BRIER_FETCH_TIMEOUT_MS;
  const url = `${baseUrl}/api/calibration/forecast-metrics`;

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: any) {
    logger.error(
      { url, path, err },
      "[metrics-publisher] forecast-calibration-brier: target fetch failed — leaving file untouched",
    );
    return { ok: false, reason: "fetch-failed", path };
  }

  if (!response.ok) {
    logger.error(
      { url, path, status: response.status },
      "[metrics-publisher] forecast-calibration-brier: target returned non-200 — leaving file untouched",
    );
    return { ok: false, reason: "non-200", path };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err: any) {
    logger.error(
      { url, path, err },
      "[metrics-publisher] forecast-calibration-brier: malformed JSON — leaving file untouched",
    );
    return { ok: false, reason: "malformed-response", path };
  }

  const brierScore = (body as { brierScore?: unknown } | null)?.brierScore;
  if (typeof brierScore !== "number" || !Number.isFinite(brierScore)) {
    logger.error(
      { url, path, brierScore: brierScore ?? null },
      "[metrics-publisher] forecast-calibration-brier: brierScore is null/non-finite " +
        "(null until enough resolved forecasts exist) — leaving file untouched",
    );
    return { ok: false, reason: "no-score", path };
  }

  const wrote = await writeMetricFile(brierScore, filePath);
  // Per-league siblings (issue #4247) — from the SAME parsed body, after the
  // legacy aggregate file has been attempted. A failed aggregate write does
  // not suppress the league files: the two are independent outputs of one
  // sample, and a league file is still an honest reading of this response.
  const leagues = await publishLeagueBrierFiles(body, leagueDirPath);
  if (!wrote) {
    return { ok: false, reason: "write-failed", value: brierScore, path, leagues };
  }
  return { ok: true, value: brierScore, path, leagues };
}

/**
 * Publish one sibling metric file per league found in the response's
 * `bySourceLeague` map (issue #4247). See the publisher doc above for the
 * count-weighted pooling argument. Never throws; a per-league write failure is
 * logged by `writeMetricFile` and the league is simply absent from the
 * returned entries (the file's stale mtime remains the staleness signal).
 */
async function publishLeagueBrierFiles(
  body: unknown,
  leagueDirPath: string,
): Promise<LeagueBrierEntry[]> {
  const bySourceLeague = (body as { bySourceLeague?: unknown } | null)?.bySourceLeague;
  if (bySourceLeague === null || typeof bySourceLeague !== "object" || Array.isArray(bySourceLeague)) {
    return [];
  }

  // Pool per-source Briers into per-league weighted sums.
  const pools = new Map<string, { weight: number; weightedSum: number }>();
  for (const [key, slice] of Object.entries(bySourceLeague as Record<string, unknown>)) {
    const separator = key.indexOf(":");
    if (separator === -1) {
      logger.warn(
        { key },
        "[metrics-publisher] forecast-calibration-brier: bySourceLeague key without '<source>:<league>' shape — skipped",
      );
      continue;
    }
    const league = key.slice(separator + 1).trim().toLowerCase();
    if (!isSafeLeagueToken(league)) {
      logger.warn(
        { key, league },
        "[metrics-publisher] forecast-calibration-brier: unsafe/unusable league token — skipped",
      );
      continue;
    }
    const brier = (slice as { brierScore?: unknown } | null)?.brierScore;
    if (typeof brier !== "number" || !Number.isFinite(brier)) continue; // absent, not phantom
    const count = (slice as { count?: unknown } | null)?.count;
    const weight = typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
    if (weight === 0) continue; // nothing to pool
    const pool = pools.get(league) ?? { weight: 0, weightedSum: 0 };
    pool.weight += weight;
    pool.weightedSum += weight * brier;
    pools.set(league, pool);
  }

  const written: LeagueBrierEntry[] = [];
  for (const [league, { weight, weightedSum }] of pools) {
    // Match the on-disk 6dp serialization so the reported value equals the
    // value a consumer reads back through the file adapter.
    const value = Number((weightedSum / weight).toFixed(6));
    const path = join(leagueDirPath, `${league}.txt`);
    if (await writeMetricFile(value, path)) {
      written.push({ league, value, path });
    }
  }
  return written;
}

/**
 * League tokens that may name a sibling file: non-empty, no path separators,
 * no dot-only segments — conservative allowlist evaluated after the
 * trim+lowercase normalization, so a hostile or malformed league string is
 * routed OUT (skipped with a warn) rather than bucketed or written outside
 * the league directory.
 */
function isSafeLeagueToken(league: string): boolean {
  if (league === "." || league === "..") return false;
  return /^[a-z0-9._-]+$/.test(league);
}
