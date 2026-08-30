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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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
   * Per-league sibling files written from the same fetch's `bySourceLeague`
   * map (issue #4247). Present only on runs that reached the per-league stage
   * (fetch + parse + a valid aggregate `brierScore`); empty when the response
   * carried no usable league data. Independent of `ok`, which reports ONLY the
   * aggregate write — a dark league is no-data, never an aggregate failure.
   */
  leagues?: PublishBrierLeagueResult[];
}

/** One per-league sibling file the Brier producer wrote (or attempted). */
export interface PublishBrierLeagueResult {
  /** League segment of the `bySourceLeague` key, verbatim (first spelling seen). */
  league: string;
  /** Dash-separated lowercase slug used in the sibling file name. */
  slug: string;
  /** Count-weighted pooled Brier over that league's source entries. */
  value: number;
  /** Absolute sibling path written (or attempted). */
  path: string;
  /** Whether the sibling write landed. */
  ok: boolean;
}

/**
 * Collapse a target `bySourceLeague` league string (free text from forecast
 * metadata, e.g. `baseball_mlb`, `MLB`, `soccer_epl`) to the dash-separated
 * lowercase slug used in sibling file names AND as the pooling key — two
 * spellings that differ only in case/separator pool into ONE league file.
 * Returns null when nothing slugifiable remains (defensive; the caller skips).
 */
function leagueSlug(league: string): string | null {
  const slug = league
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/**
 * Derive the per-league sibling metrics from the SAME parsed response the
 * aggregate came from, and write one file per league next to the aggregate
 * (issue #4247, hydra-betting ADR-0007 D5).
 *
 * `bySourceLeague` keys are `"<source>:<league>"` (e.g. `paper_llm:baseball_mlb`)
 * computed by the target over the identical scored-rows population as the
 * top-level `brierScore`, so pooling each league's entries with a
 * count-weighted average — `sum(count_i * brier_i) / sum(count_i)` — recovers
 * the exact per-league Brier (a mean of squared errors pools exactly under
 * count weighting). No hardcoded source list: whichever source keys appear for
 * a league contribute.
 *
 * NEVER writes a fabricated value (mirrors the aggregate's posture): a league
 * whose entries are all no-data (null/non-finite `brierScore`, non-positive
 * `count`) yields no file — its absence (or stale mtime) IS the no-data
 * signal, matching `getOutcomeValue`'s missing-file semantics. Malformed keys
 * (no `:` separator) are skipped with one loud line — a shape bug, not
 * no-data. Sibling names share the aggregate's basename prefix so an overridden
 * `filePath` (tests, alternate roots) keeps its siblings in the same directory.
 */
async function publishPerLeagueBrierFiles(
  body: unknown,
  aggregatePath: string,
): Promise<PublishBrierLeagueResult[]> {
  const raw = (body as { bySourceLeague?: unknown } | null)?.bySourceLeague;
  if (raw === undefined || raw === null) {
    logger.error(
      { path: aggregatePath },
      "[metrics-publisher] forecast-calibration-brier: response carried no bySourceLeague " +
        "(older target build?) — per-league files untouched",
    );
    return [];
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    logger.error(
      { path: aggregatePath, bySourceLeague: Array.isArray(raw) ? "array" : typeof raw },
      "[metrics-publisher] forecast-calibration-brier: bySourceLeague is not an object — per-league files untouched",
    );
    return [];
  }

  const dir = dirname(aggregatePath);
  const base = basename(aggregatePath).replace(/\.txt$/, "");
  const pools = new Map<string, { league: string; sum: number; weight: number }>();
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const sep = key.indexOf(":");
    if (sep <= 0 || sep >= key.length - 1) {
      logger.error(
        { key },
        '[metrics-publisher] forecast-calibration-brier: malformed bySourceLeague key (expected "<source>:<league>") — entry skipped',
      );
      continue;
    }
    const slug = leagueSlug(key.slice(sep + 1));
    if (slug === null) continue;
    const e = (entry ?? {}) as { count?: unknown; brierScore?: unknown };
    // No-data slice (null/non-finite Brier, non-positive count): quiet skip —
    // a league with too few settled forecasts is normal, not an error.
    if (typeof e.brierScore !== "number" || !Number.isFinite(e.brierScore)) continue;
    if (typeof e.count !== "number" || !Number.isFinite(e.count) || e.count <= 0) continue;
    const acc = pools.get(slug) ?? { league: key.slice(sep + 1).trim(), sum: 0, weight: 0 };
    acc.sum += e.count * e.brierScore;
    acc.weight += e.count;
    pools.set(slug, acc);
  }

  const results: PublishBrierLeagueResult[] = [];
  for (const [slug, acc] of pools) {
    const value = acc.sum / acc.weight;
    if (!Number.isFinite(value)) continue;
    const path = join(dir, `${base}-${slug}.txt`);
    const ok = await writeMetricFile(value, path);
    results.push({ league: acc.league, slug, value, path: resolveMetricPath(path), ok });
  }
  return results;
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
 * sibling files (`metrics/forecast-calibration-brier-<league>.txt`, e.g.
 * `…-baseball-mlb.txt`) derived from the response's `bySourceLeague` map —
 * see {@link publishPerLeagueBrierFiles}. The aggregate stays published
 * unchanged as a display number; Outcome Holdback no longer keys on it
 * (excluded in `src/holdback-policy.ts`).
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
    // No scoreable rows at all ⇒ bySourceLeague is over the same (empty)
    // population, so there is no per-league stage to run either.
    return { ok: false, reason: "no-score", path };
  }

  // Per-league siblings (#4247) run on the same parsed body, independently of
  // the aggregate write outcome — each stage leaves the other's files
  // untouched on its own failure paths.
  const leagues = await publishPerLeagueBrierFiles(body, path);

  const wrote = await writeMetricFile(brierScore, filePath);
  if (!wrote) {
    return { ok: false, reason: "write-failed", value: brierScore, path, leagues };
  }
  return { ok: true, value: brierScore, path, leagues };
}
