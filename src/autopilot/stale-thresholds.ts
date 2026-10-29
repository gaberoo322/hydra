/**
 * stale-thresholds.ts — the ONE home for the autopilot's named stale / wedge
 * thresholds (issue #5095, epic #5094).
 *
 * One home, NOT one value: each threshold answers a different question at a
 * different cost of being wrong (a read-only dashboard flag vs an irreversible
 * SIGKILL), so the numbers stay distinct. Only the declaration site is unified.
 * Each name below exists because a TS consumer imports it — add the next one
 * when the slice that ports its consumer lands (knip must stay clean).
 *
 * Pure constants. No I/O.
 */

/**
 * How stale may the OS heartbeat (/tmp/hydra-autopilot-heartbeat.txt) be before
 * the external watchdog SIGTERMs (then SIGKILLs) the autopilot PID? 25 minutes.
 *
 * scripts/autopilot/decide.py sets WALL_CLOCK_HEARTBEAT_SEC = 900 (15 min idle
 * wakeups); the threshold must absorb at least one dropped tick, so >15 min is
 * mandatory and 25 min gives ~1.6x margin. Do NOT shorten the SIGKILL
 * threshold — this is an irreversible kill of a live session.
 */
export const WATCHDOG_WEDGE_KILL_THRESHOLD_S = 1500;

/** Seconds between the watchdog's SIGTERM and its SIGKILL escalation. */
export const WATCHDOG_KILL_GRACE_S = 30;

/**
 * When does the read-time run view flag `wedge_likely`? A run whose
 * heartbeat is older than 10 minutes. Read-only metadata; no kill follows.
 */
export const WEDGE_AGE_THRESHOLD_S = 600;

/** When is an open dispatch "stalled" for the autopilot-health warn signal? 15 minutes. */
export const STALLED_DISPATCH_AGE_S = 900;

/**
 * How stale may the Observability Heartbeat's `lastTickAt` be before the
 * watchdog restarts the orchestrator and `/api/health/deep` reports Idle?
 * 15 minutes; ticks are 5 min so this is ~3x margin. Consumed by
 * src/watchdog/liveness.ts AND src/health/rules.ts (one predicate, issue #5096).
 */
export const SCHEDULER_TICK_STALE_S = 900;

/** The module as one JSON-serialisable object (the `thresholds` CLI subcommand, read by status.sh). */
export function staleThresholdsJson(): {
  wedgeKillS: number;
  killGraceS: number;
  wedgeAgeS: number;
  stalledDispatchAgeS: number;
  schedulerTickStaleS: number;
} {
  return {
    wedgeKillS: WATCHDOG_WEDGE_KILL_THRESHOLD_S,
    killGraceS: WATCHDOG_KILL_GRACE_S,
    wedgeAgeS: WEDGE_AGE_THRESHOLD_S,
    stalledDispatchAgeS: STALLED_DISPATCH_AGE_S,
    schedulerTickStaleS: SCHEDULER_TICK_STALE_S,
  };
}
