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
export const DEFAULT_SHARE_METRIC_PATH = join(HYDRA_ROOT, "metrics", "orchestrator-share.txt");

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
