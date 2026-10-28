/**
 * health/tick-liveness.ts — the ONE scheduler-tick liveness predicate (issue #5096).
 *
 * Shared by the watchdog liveness CLI (src/watchdog/liveness.ts) and the
 * `/api/health/deep` "Idle Nm" Health Diagnostic (src/health/rules.ts), so the
 * thing the watchdog acts on is exactly what the deep-health route reports.
 * The Observability Heartbeat stamps `lastTickAt` every 5 minutes and leaves
 * `lastCycleAt` null on purpose (src/scheduler/heartbeat.ts), so `lastTickAt`
 * is the only liveness signal.
 *
 * Pure, zero-dependency leaf. No I/O, no clock read (the caller passes `nowMs`).
 */

/**
 * Age in whole seconds of the scheduler's `lastTickAt` ISO string at `nowMs`.
 * `null` for a null/empty value (fresh restart), `'unparseable'` when the
 * string is not a date. Negative ages are returned as-is so a caller can name
 * clock skew.
 */
export function schedulerTickAgeS(lastTickAt: string | null | undefined, nowMs: number): number | null | "unparseable" {
  if (lastTickAt === null || lastTickAt === undefined || lastTickAt === "") return null;
  const t = Date.parse(lastTickAt);
  if (Number.isNaN(t)) return "unparseable";
  return Math.floor((nowMs - t) / 1000);
}

/** Strict `>`: a tick exactly `thresholdS` old is not yet stale (the bash `age > STALE_THRESHOLD_SECONDS`). */
export function isSchedulerTickStale(ageS: number, thresholdS: number): boolean {
  return ageS > thresholdS;
}
