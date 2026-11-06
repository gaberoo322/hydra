// ---------------------------------------------------------------------------
// Alert-grammar Module (issue #1979) — the owner of the dashboard-alert MESSAGE
// grammar (`formatAlertMessage`) and the wire `AlertSeverity` union.
//
// Which events become alerts, and at what severity, is decided by the Operator
// Channel's one per-kind table (`KIND_TABLE` in src/operator-channel/page-list.ts,
// issue #5389); `ALERT_TYPES` and `classifyAlertSeverity` were deleted in its
// favour. This file stays a vocabulary-only leaf: it must NOT import from
// src/operator-channel/ (page-list.ts imports the `AlertSeverity` type from here).
// ---------------------------------------------------------------------------

import {
  NOTIFICATION_EVENT_TYPES as E,
  type NotificationEventPayload,
} from "../event-bus-vocabulary.ts";

/**
 * Map a notification event to a human-readable dashboard-alert message.
 *
 * Each `case` references a NOTIFICATION_EVENT_TYPES member (aliased `E`) — the
 * typed vocabulary in event-bus.ts (issue #1182) — so a misspelled event type
 * is a compile error, kept in lock-step with the per-kind table (`KIND_TABLE` in src/operator-channel/page-list.ts, which derives ALERT_TYPES). The
 * default branch handles any ALERT_TYPES member without a dedicated case.
 *
 * The `event` parameter is typed `AlertGrammarEvent` (issue #1889) so the
 * payload fields the switch reads are contract-checked too, not just the case
 * labels — the pattern the retired `formatMessage(FormatMessageEvent)`
 * (#1857) and `buildDigestMessage(DigestGrammarEvent[])` (#1835) formatters
 * introduced. A renamed read field is a compile error here, not a silent miss.
 */
/**
 * Render a launch-flow streak duration (issue #3848) for a dashboard-alert
 * message. The watchdog sends epoch-ms deltas; the operator reads minutes or
 * hours. Absent/garbage input renders as "?" so a malformed payload degrades
 * to a vague alert, never an exception.
 */
function fmtStreakMs(ms: unknown): string {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 60_000) return `${Math.round(n / 1000)}s`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)}min`;
  const hours = n / 3_600_000;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

export function formatAlertMessage(event: AlertGrammarEvent): string {
  const p = event.payload || {};
  switch (event.type) {
    case E.DLQ_ALERT: return `Dead letter: ${p.eventType || "unknown"} failed ${p.deliveryCount || 0}x — ${p.error || ""}`;
    case E.CONSUMER_DEAD: return `Consumer ${p.consumer || "unknown"} died after ${p.restarts || 0} restarts`;
    case E.LAUNCH_QUOTA_STRETCH: return `Launch quota stretch: autopilot blocked (${p.reason || "unknown reason"}) for ${fmtStreakMs(p.durationMs)} — sustained past the ${fmtStreakMs(p.thresholdMs)} alarm threshold`;
    case E.LAUNCH_LATENCY_BREACH: return `Launch latency breach: eligibility probe took ${fmtStreakMs(p.durationMs)} — sustained past the ${fmtStreakMs(p.thresholdMs)} alarm threshold`;
    case E.INFRA_NODE_MODULES_WIPED: return `node_modules integrity: ${p.signal || "unknown root"} — ${p.reason || "broken"}`;
    case E.INFRA_ORIGIN_IDENTITY_WRONG:
      // #5065: the watchdog self-heals; `repair` is absent on pre-#5065 payloads.
      if (p.repair === "repaired") return `~/hydra origin identity auto-repaired: ${p.reason || "wrong"} — origin ${p.url || "unknown"} -> ${p.newUrl || "canonical"}, fetch ${p.fetch || "ok"}; find the writer via the .git/config change breadcrumb in the watchdog journal`;
      if (p.repair === "failed") return `~/hydra origin identity: ${p.reason || "wrong"} — observed origin ${p.url || "unknown"}; ${p.note || "auto-repair FAILED"}; restore the orchestrator remote from an operator shell and fetch origin`;
      return `~/hydra origin identity: ${p.reason || "wrong"} — observed origin ${p.url || "unknown"}; restore the orchestrator remote from an operator shell and fetch origin`;
    case E.GLM_DRAINER_STERILE: return `GLM drainer sterile: heartbeat live and eligible work queued, but zero drainer PRs — sustained ${fmtStreakMs(p.durationMs)} past the ${fmtStreakMs(p.thresholdMs)} threshold; the #3754 partition is hiding glm-eligible work from the Opus lane`;
    default: return `${event.type}: ${JSON.stringify(p).slice(0, 200)}`;
  }
}

/**
 * The event vocabulary the alert grammar reads (issue #1889).
 *
 * `formatAlertMessage` is fed loosely-typed `NOTIFICATION_EVENT_TYPES` events
 * from the bus (ultimately the same `NotificationEvent` shapes the
 * notification-consumer Module carries). This type names exactly the payload
 * fields the `formatAlertMessage` switch dereferences via the
 * `p = event.payload || {}` accessor — so a renamed payload field (e.g.
 * `consumer` → `name`, or `signal` → `root`) becomes a compile error at the
 * access site rather than a silent runtime miss in the dashboard-alert body.
 *
 * This mirrors `FormatMessageEvent` (issue #1857) and `DigestGrammarEvent`
 * (issue #1835) — the two sibling formatters (since retired by ADR-0045) that
 * fixed the same class of gap. All three DERIVED their
 * payload shape from the single shared `NotificationEventPayload` vocabulary in
 * `event-bus.ts` (issue #1915) via `Pick`, so the payload contract lives in one
 * place. The three formatters now share one structural pattern:
 *
 * - `payload` stays OPEN (`Record<string, unknown> & Pick<…>`) because the bus
 *   carries the full event vocabulary; the picked fields are only the subset
 *   the alert grammar narrows on. A producer renaming a read field is caught;
 *   a producer adding an *unread* field is not constrained.
 * - `type` is REQUIRED because `formatAlertMessage` switches on it
 *   unconditionally and `handleNotificationEvent` only reaches it after an
 *   `ALERT_TYPES.has(event.type)` gate.
 *
 * The `Pick` list below is the exhaustive read set of the `formatAlertMessage`
 * switch — every `p.<x>` an arm dereferences. On-wire alert messages are
 * unchanged; this concentrates the payload contract in the shared vocabulary,
 * not the format. `AlertGrammarEvent` is structurally a subset of
 * `NotificationEvent`, so the bus-fed events `handleNotificationEvent` carries
 * remain assignable.
 */
export interface AlertGrammarEvent {
  type: string;
  payload?: Record<string, unknown> &
    Pick<
      NotificationEventPayload,
      | "reason"
      | "eventType"
      | "deliveryCount"
      | "error"
      | "consumer"
      | "restarts"
      | "signal"
      | "durationMs"
      | "thresholdMs"
      | "url"
    >;
}

/**
 * Severity tiers a dashboard alert can carry. The third leg of the
 * alert-build grammar alongside the per-kind table (which events become alerts)
 * and `formatAlertMessage` (what the alert says). `"warning"` stays in the
 * union even though no live type maps to it since issue #5044 — the dashboard
 * reads this field, so the union is a wire contract, not a formatter arm.
 */
export type AlertSeverity = "error" | "warning" | "info";
