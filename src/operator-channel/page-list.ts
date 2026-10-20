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
  // The notification consumer is dead
  E.CONSUMER_DEAD,
  // An Outcome Holdback revert failed
  E.HOLDBACK_REVERT_FAILED,
  // Orchestrator, autopilot, tunnel or backup service failures
  "service:orchestrator_failed",
  "service:autopilot_failed",
  "service:tunnel_failed",
  "service:backup_failed",
  // The /hydra-review pickup set going non-empty
  E.REVIEW_PICKUP_READY,
] as const;

export type PageKind = (typeof PAGE_KINDS)[number];

const PAGE_KIND_SET: ReadonlySet<string> = new Set<string>(PAGE_KINDS);

export function isPageKind(kind: string): kind is PageKind {
  return PAGE_KIND_SET.has(kind);
}

export function severityOf(kind: string): "page" | "brief" {
  return isPageKind(kind) ? "page" : "brief";
}
