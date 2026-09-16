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

import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";

import {
  DEFAULT_WINDOW_CYCLES,
  getSelfImprovementShare,
  type ShareResult,
} from "../capacity-floor.ts";
import { logger } from "../logger.ts";
import { DEFAULT_OUTCOMES_FILE, loadOutcomes } from "../outcomes.ts";
import type { LoadOutcomesResult } from "../outcomes-types.ts";
import { getTargetWebUrl } from "../target-config.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME || "", "hydra");

/**
 * Default on-disk path for the orchestrator-self-improvement-share metric.
 * Matches `query: metrics/orchestrator-share.txt` in
 * `config/direction/outcomes.yaml`. Relative paths are resolved against
 * HYDRA_ROOT so the same code works under systemd or `npx tsx`.
 */
const ORCHESTRATOR_SHARE_METRIC_QUERY = "metrics/orchestrator-share.txt";
const DEFAULT_SHARE_METRIC_PATH = join(HYDRA_ROOT, ORCHESTRATOR_SHARE_METRIC_QUERY);

/**
 * Outcome `query` paths owned by IN-PROCESS orchestrator publishers (issue
 * #4477). The Target outcomes publisher below never writes these, even when the
 * Target's `/api/outcomes` response carries the same outcome name — a Target
 * value must never clobber an orchestrator-computed metric. Derived from the
 * same constant as `DEFAULT_SHARE_METRIC_PATH` so the two cannot drift.
 */
export const ORCHESTRATOR_OWNED_METRIC_QUERIES: ReadonlySet<string> = new Set([
  ORCHESTRATOR_SHARE_METRIC_QUERY,
]);

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
  // Issue #4477: atomic write — temp file in the SAME directory (so the rename
  // is a same-filesystem atomic replace), then rename onto the target. A reader
  // (the outcomes file adapter) sees either the old value or the new one, never
  // a torn file.
  const tmpPath = join(
    dirname(resolved),
    `.${basename(resolved)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await mkdir(dirname(resolved), { recursive: true });
    // Outcomes file adapter does Number(raw.trim()); a single line + newline
    // is the simplest format and matches the example in the issue body ("0.18").
    // Cap precision to 6dp — share is a fraction so this is far below noise.
    const serialized = `${Number(value.toFixed(6))}\n`;
    await writeFile(tmpPath, serialized, "utf-8");
    await rename(tmpPath, resolved);
    return true;
  } catch (err: any) {
    logger.error({ path: resolved, err }, "[metrics-publisher] failed to write metric file");
    try {
      await unlink(tmpPath);
    } catch {
      /* intentional: best-effort temp cleanup — the temp file often never existed */
    }
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
// Target outcomes publisher (issue #4477)
// ---------------------------------------------------------------------------
//
// Bridges the Target's `GET /api/outcomes` endpoint to the `file` adapter of
// the Outcomes loader. The Target's outcomes.yaml declares `source: file`
// outcomes whose `query` is a relative `metrics/...` path; this publisher
// samples the Target and writes each declared value to that path under
// HYDRA_ROOT so the loader and Tier-2 Outcome Holdback can read it.
//
// The file set is DERIVED from the loaded outcomes.yaml — never from the
// response and never from a hardcoded list — so the Target controls values
// only, never orchestrator filesystem paths.

/** Default per-fetch timeout: a slow Target must never wedge housekeeping. */
const DEFAULT_TARGET_OUTCOMES_TIMEOUT_MS = 10_000;

/** Whole-sample failure reasons — nothing is written for any of these. */
type TargetOutcomesFailureReason =
  | "outcomes-load-failed"
  | "fetch-failed"
  | "non-200"
  | "malformed-response";

export type TargetOutcomesPublishResult =
  | {
      ok: true;
      /** Number of candidate outcomes (0 => no fetch was made). */
      candidates: number;
      /** Whether an HTTP request was made. */
      fetched: boolean;
      /** Outcome names whose value was written. */
      written: string[];
      /** Outcome names whose value was `null` (nothing written). */
      nulls: string[];
      /** Candidate outcome names absent from the response (nothing written). */
      missing: string[];
      /** Names present with a non-number / non-finite value, or whose write failed. */
      invalid: string[];
    }
  | {
      ok: false;
      reason: TargetOutcomesFailureReason;
      /** Human-readable detail for the log line. */
      detail: string;
      /** URL sampled (empty when the failure preceded the fetch). */
      url: string;
    };

export interface TargetOutcomesPublishDeps {
  /** Outcomes loader. Defaults to `loadOutcomes(DEFAULT_OUTCOMES_FILE)`. */
  loadOutcomes?: () => Promise<LoadOutcomesResult>;
  /** Base URL of the Target web service. Defaults to `getTargetWebUrl()`. */
  baseUrl?: string;
  /** Fetch implementation. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-fetch timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /**
   * Root that relative `query` paths resolve against. Defaults to HYDRA_ROOT —
   * the same resolution `src/outcomes.ts` applies, so writer and file adapter
   * agree on location.
   */
  root?: string;
}

/**
 * Is `query` a path the Target publisher may write? True only for a relative
 * path that, after POSIX normalisation, starts with `metrics/`, contains no
 * `..` segment, and is not orchestrator-owned. Pure; exported for unit tests.
 */
export function isTargetMetricCandidateQuery(query: string): boolean {
  if (typeof query !== "string" || query.length === 0) return false;
  if (isAbsolute(query) || posix.isAbsolute(query)) return false;
  if (query.split("\\").join("/").split("/").includes("..")) return false;
  const normalized = posix.normalize(query);
  if (normalized.split("/").includes("..")) return false;
  if (!normalized.startsWith("metrics/")) return false;
  if (ORCHESTRATOR_OWNED_METRIC_QUERIES.has(normalized)) return false;
  return true;
}

/**
 * Sample the Target's `/api/outcomes` and publish each declared `file`
 * outcome's value to its `query` path. Never throws.
 *
 * - Zero candidates => returns immediately, no HTTP request.
 * - Whole-sample failure (load not ok, fetch throws/timeout, non-2xx,
 *   unparseable or non-object body) => writes NOTHING, `{ ok: false, reason }`.
 * - Per outcome: finite number => written atomically; `null` => nothing written
 *   (prior file untouched); absent => `missing`; anything else => `invalid`.
 */
export async function publishTargetOutcomeMetrics(
  deps: TargetOutcomesPublishDeps = {},
): Promise<TargetOutcomesPublishResult> {
  const load = deps.loadOutcomes ?? (() => loadOutcomes(DEFAULT_OUTCOMES_FILE));
  const root = deps.root ?? HYDRA_ROOT;

  let loaded: LoadOutcomesResult;
  try {
    loaded = await load();
  } catch (err: any) {
    return { ok: false, reason: "outcomes-load-failed", detail: err?.message || String(err), url: "" };
  }
  if (loaded.ok === false) {
    const errors = (loaded as { ok: false; errors: string[] }).errors;
    return { ok: false, reason: "outcomes-load-failed", detail: errors.join("; "), url: "" };
  }

  const candidates = loaded.outcomes.filter(
    (o) => o.source === "file" && isTargetMetricCandidateQuery(o.query),
  );
  if (candidates.length === 0) {
    return { ok: true, candidates: 0, fetched: false, written: [], nulls: [], missing: [], invalid: [] };
  }

  let url = "";
  let body: unknown;
  try {
    const baseUrl = deps.baseUrl ?? getTargetWebUrl();
    const fetchImpl = deps.fetchImpl ?? fetch;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TARGET_OUTCOMES_TIMEOUT_MS;
    url = `${baseUrl.replace(/\/+$/, "")}/api/outcomes`;

    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err: any) {
      return { ok: false, reason: "fetch-failed", detail: err?.message || String(err), url };
    }
    if (!response.ok) {
      return { ok: false, reason: "non-200", detail: `HTTP ${response.status}`, url };
    }
    try {
      body = JSON.parse(await response.text());
    } catch (err: any) {
      return {
        ok: false,
        reason: "malformed-response",
        detail: `unparseable JSON: ${err?.message || String(err)}`,
        url,
      };
    }
  } catch (err: any) {
    return { ok: false, reason: "fetch-failed", detail: err?.message || String(err), url };
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    const shape = Array.isArray(body) ? "array" : body === null ? "null" : typeof body;
    return {
      ok: false,
      reason: "malformed-response",
      detail: `expected a flat JSON object keyed by outcome name, got ${shape}`,
      url,
    };
  }

  const map = body as Record<string, unknown>;
  const written: string[] = [];
  const nulls: string[] = [];
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const outcome of candidates) {
    if (!Object.prototype.hasOwnProperty.call(map, outcome.name)) {
      missing.push(outcome.name);
      continue;
    }
    const value = map[outcome.name];
    if (value === null) {
      nulls.push(outcome.name);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      logger.warn(
        { outcome: outcome.name, value, url },
        "[metrics-publisher] target outcome value is not a finite number — not written",
      );
      invalid.push(outcome.name);
      continue;
    }
    const ok = await writeMetricFile(value, resolve(root, posix.normalize(outcome.query)));
    if (ok) written.push(outcome.name);
    else invalid.push(outcome.name);
  }

  return { ok: true, candidates: candidates.length, fetched: true, written, nulls, missing, invalid };
}
