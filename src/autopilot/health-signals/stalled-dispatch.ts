/**
 * Health-signal heuristic 1: stalled live dispatch (issue #2866 — extracted
 * from the combined `autopilot/run-health.ts` heuristic bag).
 *
 * A live run is stalled when it is still `running`, its most-recent turn
 * carries an open dispatch, its per-turn heartbeat has crossed the threshold,
 * AND the continuously-written OS heartbeat is also stale (#1091). This leaf
 * owns that heuristic and its file-private turn-inspection helper; it evolves
 * with OS-heartbeat policy independently of the other three evaluators.
 */

import { isOsHeartbeatStale } from "../os-heartbeat.ts";
import {
  type AutopilotHealthThresholds,
  type LiveRunView,
  type StuckSignal,
  type StuckSignalSeverity,
  toNum,
  toStr,
} from "./common.ts";

/**
 * A live run is stalled when it is still `running`, its most-recent turn
 * carries at least one open dispatch action, the run's per-turn heartbeat age
 * has crossed the threshold (no fresh turn / tool-call activity), AND the
 * continuously-written OS heartbeat is ALSO stale (#1091). `warn` at the
 * threshold, `critical` at 2x. Returns `[]` for any run that is not live,
 * has no open dispatch in its latest turn, is within the cadence window, or
 * whose OS heartbeat is fresh (loop alive mid-long-turn).
 *
 * `osHbAgeS` is the OS-heartbeat age in seconds, or `null` when unreadable;
 * `null` fails open (treated as stale) so a genuinely hung run whose
 * heartbeat file vanished is still flagged. Omitting it (legacy 2-arg call)
 * also fails open — the cross-check then degrades to the per-turn-only
 * behaviour rather than silently suppressing the signal.
 */
export function detectStalledDispatch(
  live: LiveRunView | null,
  thresholds: AutopilotHealthThresholds,
  osHbAgeS: number | null = null,
): StuckSignal[] {
  if (!live) return [];
  if (toStr(live.status) !== "running") return [];

  const ageS = toNum(live.age_s);
  if (ageS < thresholds.stalledDispatchAgeS) return [];

  // #1091: a fresh OS heartbeat means the control loop is alive even though
  // the per-turn heartbeat lags during a long turn — not a stall.
  if (!isOsHeartbeatStale(osHbAgeS, thresholds.stalledDispatchAgeS)) return [];

  const turns = Array.isArray(live.turns) ? (live.turns as unknown[]) : [];
  if (turns.length === 0) return [];

  // `getCurrentRun` returns turns newest-first (descending turn_n). The first
  // entry is the most-recent turn; an open dispatch there with no newer turn
  // is the stall signature.
  const latest = turns[0];
  const dispatchCount = countOpenDispatchActions(latest);
  if (dispatchCount === 0) return [];

  const runId = toStr(live.run_id) || "current";
  const severity: StuckSignalSeverity =
    ageS >= thresholds.stalledDispatchAgeS * 2 ? "critical" : "warn";

  return [
    {
      type: "stalled-dispatch",
      severity,
      summary: `Live run ${runId} has an open dispatch with no new activity for ~${Math.floor(
        ageS / 60,
      )}m (heartbeat age ${ageS}s).`,
      evidence: {
        runId,
        ageSeconds: ageS,
        osHeartbeatAgeSeconds: osHbAgeS, // null = OS heartbeat unreadable (failed open to stale)
        openDispatches: dispatchCount,
        thresholdSeconds: thresholds.stalledDispatchAgeS,
      },
    },
  ];
}

/**
 * Count dispatch actions in a turn record that have no resolved outcome
 * (still pending / in-flight). A turn carries `actions: [{type, outcome?}]`
 * (see `fetchTurnsWithJoins`); a dispatch with `outcome: null` is open.
 */
function countOpenDispatchActions(turn: unknown): number {
  if (!turn || typeof turn !== "object") return 0;
  const actions = (turn as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const action = a as { type?: unknown; outcome?: unknown };
    if (action.type !== "dispatch") continue;
    // outcome null/undefined → still pending. A resolved (merged/failed)
    // outcome means the dispatch is no longer in-flight.
    if (action.outcome === null || action.outcome === undefined) n += 1;
  }
  return n;
}
