/**
 * The closed page list (ADR-0045 Decision 3, issue #5045).
 *
 * The channel — never the producer — decides severity. A Page is an event whose
 * kind is on this list; everything else is a Morning Brief item. Adding a page
 * type is an edit here plus the ADR's list. Bus-backed members reference
 * `NOTIFICATION_EVENT_TYPES` so a typo is a compile error; the rest are
 * string literals the operator-notify CLI (#5046) will emit.
 */

import { NOTIFICATION_EVENT_TYPES as E } from "../event-bus-vocabulary.ts";

export const PAGE_KINDS = [
  // Infra alarms
  E.INFRA_NODE_MODULES_WIPED,
  E.INFRA_ORIGIN_IDENTITY_WRONG,
  "infra:redis_backup_stale",
  E.LAUNCH_QUOTA_STRETCH,
  E.LAUNCH_LATENCY_BREACH,
  E.LAUNCH_PAUSE_FORGOTTEN,
  E.GLM_DRAINER_STERILE,
  // Launch-flow fail-safe / meter-dark (watchdog-only, out-of-band: the
  // orchestrator may be down, so they never ride the bus — issue #5046).
  "launch:fail_safe",
  "launch:meter_dark",
  // The notification consumer is dead
  E.CONSUMER_DEAD,
  // An Outcome Holdback revert failed (the on-wire spelling src/holdback.ts
  // publishes — issue #5047 replaced the mis-spelled `holdback:revert_failed`
  // literal that no producer emitted)
  E.HOLDBACK_REVERT_FAILED,
  // Orchestrator, autopilot, tunnel or backup service failures
  "service:orchestrator_failed",
  "service:autopilot_failed",
  "service:tunnel_failed",
  "service:backup_failed",
  // The /hydra-review pickup set going non-empty
  E.REVIEW_PICKUP_READY,
  // No Morning Brief delivered for 26h (ADR-0045 Decision 8, issue #5048):
  // raised by the watchdog from the Redis last-sent key, independent of the
  // scheduler's running state — a silent channel must itself be noticeable.
  "brief:missing",
] as const;

export type PageKind = (typeof PAGE_KINDS)[number];

const PAGE_KIND_SET: ReadonlySet<string> = new Set<string>(PAGE_KINDS);

export function isPageKind(kind: string): kind is PageKind {
  return PAGE_KIND_SET.has(kind);
}

/**
 * Event-aware page decision (#5065 QA round 2): a self-healed origin identity
 * (payload.repair === "repaired") needs no operator action, so it is a Morning
 * Brief item, not a Page. Every other page-kind event stays a Page.
 */
export function isPageEvent(kind: string, payload?: Record<string, unknown> | null): boolean {
  if (!isPageKind(kind)) return false;
  if (kind === E.INFRA_ORIGIN_IDENTITY_WRONG && payload?.repair === "repaired") return false;
  return true;
}

export function severityOf(kind: string): "page" | "brief" {
  return isPageKind(kind) ? "page" : "brief";
}
