import { useApi } from "../../hooks/useApi.js";

/**
 * StopBanner — a loud hard-stop banner at the top of NowConsole (issue #2409,
 * now-status-5, parent #2408).
 *
 * Shows ONLY when the autopilot is hard-stopped, so it adds zero noise during
 * normal operation. Trigger predicate (any one):
 *   - reasons.sessionBlockedUntil is set (a pace-gate / session block window)
 *   - usage.emergencyStop === true        (5h emergency stop engaged)
 *   - usage.weeklyEmergencyStop === true  (weekly emergency stop engaged)
 *
 * Otherwise renders null (no empty box). Copy is token/percent wording only —
 * NO dollar metric anywhere (continues the #885/#704 $0-framing retirement).
 *
 * Self-fetches /usage/eligibility with a 30s poll, matching the established
 * now-console idiom (every sibling panel self-fetches via useApi). Lifting a
 * shared fetch into NowConsole was rejected in the design concept — it would
 * force UsagePanel to become props-driven, exceeding the mount-point-only
 * constraint on NowConsole.
 */
export default function StopBanner() {
  const { data } = useApi("/usage/eligibility", { poll: 30_000 });
  const usage = data?.usage ?? {};
  const reasons = data?.reasons ?? {};

  const sessionBlockedUntil = reasons.sessionBlockedUntil ?? null;
  const emergencyStop = usage.emergencyStop === true;
  const weeklyEmergencyStop = usage.weeklyEmergencyStop === true;

  const stopped = Boolean(sessionBlockedUntil) || emergencyStop || weeklyEmergencyStop;
  if (!stopped) return null;

  // Most-urgent reason first: weekly emergency stop, then 5h emergency stop,
  // then a session block window. Token/percent wording only.
  let headline = "Autopilot is hard-stopped.";
  let detail = "No new work will be dispatched until the quota window clears.";
  if (weeklyEmergencyStop) {
    headline = "WEEKLY EMERGENCY STOP engaged.";
    detail = "Weekly token utilization hit the emergency-stop threshold; autopilot will not dispatch new work until the 7-day window resets.";
  } else if (emergencyStop) {
    headline = "EMERGENCY STOP engaged.";
    detail = "5-hour token utilization hit the emergency-stop threshold; autopilot will not dispatch new work until the 5-hour window resets.";
  } else if (sessionBlockedUntil) {
    headline = "Session blocked.";
    detail = `Autopilot dispatch is blocked until ${String(sessionBlockedUntil)}.`;
  }

  return (
    <div
      data-testid="stop-banner"
      role="alert"
      className="rounded-lg border-2 border-rose-500/70 bg-rose-950/40 p-4 text-rose-100"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-lg leading-none">⛔</span>
        <span className="text-sm font-bold uppercase tracking-wide text-rose-200">
          {headline}
        </span>
      </div>
      <p className="mt-1 text-xs text-rose-200/90">{detail}</p>
    </div>
  );
}
