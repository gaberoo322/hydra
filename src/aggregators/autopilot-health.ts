/**
 * Autopilot-health aggregator (issue #890, now-console-3, PRD #887).
 *
 * Computes a ranked list of **stuck signals** over two data sources:
 *
 *   1. The live autopilot run (`getCurrentRun()`) — its projected view + the
 *      latest turn timeline. Drives the `stalled-dispatch` heuristic: a live
 *      run whose most-recent turn carries an open dispatch and whose
 *      heartbeat age has crossed a threshold (no fresh tool-call / turn
 *      activity) is wedged.
 *   2. The recent run-history window (`listRuns(historyWindow)`) — run
 *      digests carrying `merged_count` / `failed_count` / `dispatches` /
 *      `term_reason`. Drives the three cross-run heuristics:
 *        - `unproductive-loop` — a class dispatched repeatedly with zero
 *          merges or a high cumulative failed count.
 *        - `idle-streak` — a streak of runs terminating idle or producing no
 *          dispatch at all.
 *        - `issue-pr-churn` — the same issue/PR ref re-dispatched repeatedly
 *          across runs without ever landing a merge.
 *
 * # Design contract — same as stuck-items.ts / active-dispatches.ts
 *
 * - **Pure heuristic core lives in `autopilot/run-health.ts`** (issue #1378).
 *   The four heuristics + their threshold types are pure functions over
 *   already-read data, exported there so tests pin the boundary without
 *   stubbing Redis or instantiating this aggregator's `deps` bag. This module
 *   is the thin I/O caller that fans out the reads and delegates evaluation.
 * - **Never throws.** Each sub-source is wrapped via `Promise.allSettled`; a
 *   failed read logs and contributes an empty signal list — the rest still
 *   ship. The public entrypoint cannot throw.
 * - **Readers injectable.** The two run readers live in `deps` so tests run
 *   without Redis or subprocesses. Production callers pass nothing and the
 *   defaults thin-wrap `src/autopilot/runs.ts` (read-only consumption — this
 *   aggregator never mutates run state).
 * - **Ranked output.** Signals are sorted by severity (critical → warn →
 *   info), then by type for a deterministic order.
 */

import type { StuckSignal } from "../schemas/now-page.ts";
import { settledOr, settledOrEmpty, settledOrNull } from "./settle.ts";
import { osHeartbeatAgeS } from "../autopilot/os-heartbeat.ts";
import {
  DEFAULT_HEALTH_THRESHOLDS,
  detectStalledDispatch,
  detectUnproductiveLoops,
  detectIdleStreak,
  detectIssuePrChurn,
  oldestRunStartEpochS,
  rankSignals,
  type AutopilotHealthThresholds,
  type LiveRunView,
  type RunDigest,
} from "../autopilot/run-health.ts";

// Re-export the pure run-health surface so existing importers
// (`api/now-page.ts`, tests) keep a single import site through the aggregator
// while the analysis core lives in `autopilot/run-health.ts` (issue #1378).
export {
  DEFAULT_HEALTH_THRESHOLDS,
  detectStalledDispatch,
  detectUnproductiveLoops,
  detectIdleStreak,
  detectIssuePrChurn,
  oldestRunStartEpochS,
  rankSignals,
};
export type { AutopilotHealthThresholds, LiveRunView, RunDigest };

// ---------------------------------------------------------------------------
// I/O-facing dependency bag
// ---------------------------------------------------------------------------

export interface AutopilotHealthDeps {
  /** Wall-clock anchor — defaults to `new Date()`. Only used for `generatedAt`. */
  now?: Date;
  /** Override default thresholds. */
  thresholds?: Partial<AutopilotHealthThresholds>;
  /**
   * Reader for the live autopilot run view (the `view` payload of
   * `getCurrentRun()`, which carries `turns`). Returns `null` when no run
   * exists. Defaults to a thin call into `autopilot/runs.getCurrentRun()`.
   */
  readLiveRun?: () => Promise<LiveRunView | null>;
  /**
   * Reader for the recent run-history digests, newest-first. Defaults to a
   * thin call into `autopilot/runs.listRuns(limit)`.
   */
  readRecentRuns?: (limit: number) => Promise<RunDigest[]>;
  /**
   * Reader for the count of **real** master merges that landed at or after
   * `sinceEpochS` (epoch seconds). This is the out-of-band delivery proxy the
   * `unproductive-loop` heuristic cross-checks against, because per-run
   * `merged_count` is structurally near-zero when CI (the async merge gate)
   * lands PRs after their dispatching run has ended (issue #924). Defaults to a
   * thin `git log master --since` count via the recent-merges aggregator.
   * Returns 0 when no merges landed or the read fails (the latter logs and
   * fails open to the legacy per-run behaviour).
   */
  readWindowMergeCount?: (sinceEpochS: number) => Promise<number>;
  /**
   * Reader for the OS-heartbeat age in seconds (#1091), or `null` when the
   * heartbeat file can't be read. The `stalled-dispatch` heuristic
   * cross-checks this against the live run's per-turn `age_s`: a run is only
   * stalled when BOTH the per-turn heartbeat AND the continuously-written OS
   * heartbeat are stale, so a healthy run mid-long-turn (per-turn heartbeat
   * frozen at the previous turn boundary) is no longer a false positive.
   * Defaults to the real heartbeat-file reader and fails open (unreadable →
   * treated as stale). `nowS` is epoch seconds.
   */
  readOsHeartbeatAgeS?: (nowS: number) => number | null;
  /** How many recent runs the cross-run heuristics scan. Defaults to 14. */
  historyWindow?: number;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getAutopilotHealth(
  deps: AutopilotHealthDeps = {},
): Promise<StuckSignal[]> {
  const thresholds: AutopilotHealthThresholds = {
    ...DEFAULT_HEALTH_THRESHOLDS,
    ...(deps.thresholds ?? {}),
  };
  const historyWindow = deps.historyWindow ?? 14;
  const readLiveRun = deps.readLiveRun ?? defaultReadLiveRun;
  const readRecentRuns = deps.readRecentRuns ?? defaultReadRecentRuns;
  const readWindowMergeCount =
    deps.readWindowMergeCount ?? defaultReadWindowMergeCount;
  const readOsHeartbeatAgeS = deps.readOsHeartbeatAgeS ?? osHeartbeatAgeS;

  const [liveResult, historyResult] = await Promise.allSettled([
    readLiveRun(),
    readRecentRuns(historyWindow),
  ]);

  const live = settledOrNull(liveResult, "autopilot-health/live-run");
  const history = settledOrEmpty(historyResult, "autopilot-health/run-history");

  // Cross-check real out-of-band delivery (issue #924). Per-run `merged_count`
  // can't see CI merges that land after a run ends, so before flagging an
  // unproductive loop we count master merges over the same wall-clock span the
  // run window covers. The window start is the oldest run's `started_epoch`.
  // Read failures fail open to 0 (legacy per-run behaviour) — never throw.
  const windowStartEpochS = oldestRunStartEpochS(history);
  let realMergesInWindow = 0;
  if (windowStartEpochS !== null) {
    const [mergeResult] = await Promise.allSettled([
      readWindowMergeCount(windowStartEpochS),
    ]);
    realMergesInWindow = settledOr(
      mergeResult,
      0,
      "autopilot-health/window-merge-count",
    );
  }

  // OS-heartbeat cross-check (#1091). Read once, fail open: any error in the
  // reader is treated as "stale" inside detectStalledDispatch so a genuinely
  // hung run isn't silently un-flagged. nowS anchored to deps.now for tests.
  const nowS = Math.floor((deps.now ?? new Date()).getTime() / 1000);
  let osHbAgeS: number | null = null;
  try {
    osHbAgeS = readOsHeartbeatAgeS(nowS);
  } catch (err: any) {
    console.error(
      `[autopilot-health] os-heartbeat read failed: ${err?.message || err}`,
    );
    osHbAgeS = null; // fail open → treated as stale
  }

  const signals: StuckSignal[] = [
    ...detectStalledDispatch(live, thresholds, osHbAgeS),
    ...detectUnproductiveLoops(history, thresholds, realMergesInWindow),
    ...detectIdleStreak(history, thresholds),
    ...detectIssuePrChurn(history, thresholds),
  ];

  return rankSignals(signals);
}

// ---------------------------------------------------------------------------
// Default wiring — thin read-only consumption of autopilot/runs.ts
// ---------------------------------------------------------------------------

async function defaultReadLiveRun(): Promise<LiveRunView | null> {
  const { getCurrentRun } = await import("../autopilot/runs.ts");
  const result = await getCurrentRun();
  if (!result.ok) return null;
  return result.view as LiveRunView;
}

async function defaultReadRecentRuns(limit: number): Promise<RunDigest[]> {
  const { listRuns } = await import("../autopilot/runs.ts");
  const result = await listRuns(limit);
  if (!result.ok) return [];
  return result.runs as RunDigest[];
}

/**
 * Default `readWindowMergeCount` — counts master merges that landed at or after
 * `sinceEpochS` via the recent-merges aggregator (`git log master` through the
 * GitHub CLI Adapter seam, issue #924). This is the out-of-band delivery proxy
 * the per-run `merged_count` can't see because CI merges PRs after their
 * dispatching run ends. Never throws: any failure logs and returns 0, failing
 * open to the legacy per-run boundary.
 */
async function defaultReadWindowMergeCount(sinceEpochS: number): Promise<number> {
  try {
    const { getRecentMerges } = await import("./recent-merges.ts");
    // The aggregator caps at 50; that comfortably covers a healthy ~14-run
    // window (the issue's incident saw 10 merges in 14 runs) and is the most
    // recent slice of master — exactly where window merges live.
    const merges = await getRecentMerges(50);
    const sinceMs = sinceEpochS * 1000;
    let count = 0;
    for (const m of merges) {
      const mergedMs = Date.parse(m.mergedAt);
      if (Number.isFinite(mergedMs) && mergedMs >= sinceMs) count += 1;
    }
    return count;
  } catch (err: any) {
    console.error(
      `[autopilot-health] window-merge-count read failed: ${err?.message || err}`,
    );
    return 0;
  }
}
