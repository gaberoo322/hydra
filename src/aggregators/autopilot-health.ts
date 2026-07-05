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

import { settledOr, settledOrEmpty, settledOrNull } from "./settle.ts";
import { getAutopilotStatusSnapshot } from "../autopilot/status.ts";
import { listRecentMergeCommits } from "./recent-merges.ts";
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
  type StuckSignal,
} from "../autopilot/run-health.ts";

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
   * thin `git log origin/master` count via the recent-merges aggregator
   * (remote-tracking ref, not local master — issue #1757).
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
  const readWindowMergeCount =
    deps.readWindowMergeCount ?? defaultReadWindowMergeCount;
  const nowS = Math.floor((deps.now ?? new Date()).getTime() / 1000);

  // The live-run + run-history + os-heartbeat slices are the AutopilotStatus
  // seam's `history` field-group (issue #2673). When NONE of those three
  // readers is overridden, they are all projected off ONE seam call — a single
  // composed read instead of three independent fan-outs. A test that stubs any
  // of the three still overrides exactly its slice; the seam is only consulted
  // for the slices left at their defaults, and only then (opt-in `history`).
  let historySnapPromise: ReturnType<typeof getAutopilotStatusSnapshot> | null =
    null;
  const historySnap = () =>
    (historySnapPromise ??= getAutopilotStatusSnapshot(
      {},
      {
        history: true,
        historyWindow,
        now: deps.now ?? new Date(),
      },
    ));

  const readLiveRun =
    deps.readLiveRun ??
    (async () => (await historySnap()).history?.liveRun ?? null);
  const readRecentRuns =
    deps.readRecentRuns ??
    (async () => (await historySnap()).history?.recentRuns ?? []);

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
  //
  // Issue #2369: extend the window backward by `mergeWindowLookbackS` so that
  // merges which landed BEFORE the run cluster began are still counted. The
  // incident: all 14 runs burst in one afternoon; every master merge had landed
  // ~38 min earlier, putting them outside the raw `oldestRunStart` window.
  const rawWindowStartEpochS = oldestRunStartEpochS(history);
  let realMergesInWindow = 0;
  if (rawWindowStartEpochS !== null) {
    const windowStartEpochS = Math.max(0, rawWindowStartEpochS - thresholds.mergeWindowLookbackS);
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
  // hung run isn't silently un-flagged. When the os-heartbeat reader is NOT
  // overridden, the age is taken from the shared seam's `history` slice (which
  // reads it against the same `deps.now`-anchored clock, and fails open to
  // `null` internally). An explicit `deps.readOsHeartbeatAgeS` override still
  // wins and is anchored to `nowS` exactly as before.
  let osHbAgeS: number | null = null;
  if (deps.readOsHeartbeatAgeS) {
    try {
      osHbAgeS = deps.readOsHeartbeatAgeS(nowS);
    } catch (err: any) {
      console.error(
        `[autopilot-health] os-heartbeat read failed: ${err?.message || err}`,
      );
      osHbAgeS = null; // fail open → treated as stale
    }
  } else {
    osHbAgeS = (await historySnap()).history?.osHeartbeatAgeS ?? null;
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
// Default wiring — the live-run / run-history / os-heartbeat slices are
// projected off the shared AutopilotStatus seam (issue #2673); only the
// window-merge-count delivery proxy (a git-log read, not an autopilot-status
// read) remains a local reader.
// ---------------------------------------------------------------------------

/**
 * Default `readWindowMergeCount` — counts master merges that landed at or after
 * `sinceEpochS` via the recent-merges aggregator (`git log origin/master`
 * through the GitHub CLI Adapter seam, issue #924; the remote-tracking ref —
 * not the deploy-lagged local `master` — so the count stays truthful during
 * merge waves, issue #1757). This is the out-of-band delivery proxy the
 * per-run `merged_count` can't see because CI merges PRs after their
 * dispatching run ends. Never throws: any failure logs and returns 0, failing
 * open to the legacy per-run boundary.
 */
async function defaultReadWindowMergeCount(sinceEpochS: number): Promise<number> {
  try {
    // Use the cheap git-log primitive (issue #2177), NOT getRecentMerges: this
    // count caller only needs {prNumber, mergedAt} pairs and the since-epoch
    // filter, so it must not pay the N-parallel `gh pr view` fan-out for the
    // titles/labels it discards. The committer date from git-log IS the merge
    // time for Hydra's squash-merge mode (issue #2177). The aggregator caps at
    // 50; that comfortably covers a healthy ~14-run window (the issue's
    // incident saw 10 merges in 14 runs) and is the most recent slice of
    // master — exactly where window merges live.
    const commits = await listRecentMergeCommits(50);
    const sinceMs = sinceEpochS * 1000;
    let count = 0;
    for (const c of commits) {
      const mergedMs = Date.parse(c.mergedAt);
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
