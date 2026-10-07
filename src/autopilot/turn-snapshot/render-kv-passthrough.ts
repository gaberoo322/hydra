/**
 * turn-snapshot/render-kv-passthrough.ts — the `kv` renderer for the
 * passthrough collectors (ADR-0043 Decision 4; slice 5, #4933).
 *
 * The ONE place a degraded passthrough field turns back into today's fallback
 * line. Every line is byte-identical to the `collect-state.sh` function it
 * replaces (golden files under test/fixtures/turn-snapshot/passthrough/),
 * including two legacy pipefail quirks kept for parity until slice 6: a
 * second `0` line after `failed_services=` (zero matches or failed systemctl)
 * and after `scout_alert_eligible_count=` (failed fetch). A sibling of
 * render-kv.ts so parallel slices never edit one file.
 */

import type { Classified } from "./collector.ts";
import type { CapacityValue, HealthValue, RecommendationsValue, SchedulerValue, ScoutAlertsValue } from "./passthrough.ts";
import { pyFormatFixed, pyReprValue, pyStrValue } from "./py-format.ts";

export const USAGE_ELIGIBILITY_FALLBACK = '{"allow":true,"shed":[],"reasons":{"calibrated":false}}';
export const EMERGENCY_BRAKE_FALLBACK = '{"engaged":false}';
export const CLASS_STATS_FALLBACK = '{"scoreboard":{"classes":[]},"shadow":{"verdicts":[]}}';
export const SLOT_EVENTS_FALLBACK = '{"events": [], "last_id": null}';

export function renderHealthKv(v: HealthValue): string {
  const health = v.service.ok ? `health=${pyStrValue(v.service.value.status)} redis=${pyStrValue(v.service.value.redis)}` : "health=FAIL";
  return `${health}\nfailed_services=${v.failedServices}\n${v.failedServicesFallbackZero ? "0\n" : ""}`;
}

export function renderDirectionDriftKv(drift: boolean): string {
  return `direction_drift=${drift ? "true" : "false"}\n`;
}

export function renderScoutAlertsKv(v: ScoutAlertsValue): string {
  return `scout_alert_eligible_count=${v.eligible.ok ? v.eligible.value : 0}\n${v.fetchFailed ? "0\n" : ""}`;
}

export function renderRealmShareKv(share: Classified<number>): string {
  return `orch_realm_weekly_share=${share.ok ? pyFormatFixed(share.value, 4) : "unavailable"}\n`;
}

const body = (key: string, b: Classified<string>, fallback: string) => `${key}=${b.ok ? b.value : fallback}\n`;

export const renderUsageEligibilityKv = (b: Classified<string>) => body("usage_eligibility_json", b, USAGE_ELIGIBILITY_FALLBACK);
export const renderEmergencyBrakeKv = (b: Classified<string>) => body("emergency_brake_json", b, EMERGENCY_BRAKE_FALLBACK);
export const renderClassStatsKv = (b: Classified<string>) => body("class_stats_json", b, CLASS_STATS_FALLBACK);
export const renderSlotEventsKv = (b: Classified<string>) => body("slot_events_json", b, SLOT_EVENTS_FALLBACK);

export function renderCapacityKv(c: Classified<CapacityValue>): string {
  if (!c.ok) return "capacity_floor_met=None capacity_floor_status=unmeasured capacity_window=0\n";
  const v = c.value;
  return (
    `capacity_orch_share=${pyFormatFixed(v.share, 2)} capacity_floor_met=${pyStrValue(v.floorMet)} ` +
    `capacity_floor_status=${pyStrValue(v.floorStatus)} capacity_window=${pyStrValue(v.window)}\n`
  );
}

/** The scheduler stall band: `<5` ok, `>=8` hard-stop, else alert. */
export function stallBand(nonMerges: number | boolean): "ok" | "alert" | "hard-stop" {
  const n = Number(nonMerges);
  return n < 5 ? "ok" : n >= 8 ? "hard-stop" : "alert";
}

export function renderSchedulerKv(v: SchedulerValue): string {
  const codex = v.codexRunning.ok && v.codexRunning.value ? "CODEX_ACTIVE" : "CODEX_IDLE";
  const s = v.scheduler;
  const sched = s.ok
    ? `scheduler=${pyStrValue(s.value.state)} nonmerges=${pyStrValue(s.value.nonMerges)} stall=${stallBand(s.value.nonMerges)}`
    : "scheduler=unknown stall=unknown";
  return `${codex}\n${sched}\n`;
}

export function renderRecommendationsKv(r: Classified<RecommendationsValue>): string {
  if (!r.ok) return "recommendations=unavailable\n";
  const { count, firstAction } = r.value;
  if (firstAction === null) return "recommendations=0\n";
  const action = typeof firstAction === "string" ? firstAction : pyReprValue(firstAction);
  return `recommendations=${count}: ${action}\n`;
}
