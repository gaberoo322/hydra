// ---------------------------------------------------------------------------
// Alert-grammar Module (issue #1979) — the single owner of the alert-routing
// grammar lifted out of src/notification-consumer.ts.
//
// This Module concentrates the "what events become dashboard alerts, what each
// alert says, and what severity it carries" knowledge in one place — the same
// Seam pattern the sibling grammar extractions follow (notify-format.ts #1512
// via notify.ts; digest-format.ts #1181 via digest.ts). Adding a new alert type
// is now a one-file edit here, with no consumer-lifecycle or registration-index
// context in scope.
//
// Import direction is one-way: this module imports the NOTIFICATION_EVENT_TYPES
// vocabulary from event-bus.ts; notification-consumer.ts imports the grammar
// from here (and re-exports it for the existing test import surface). No cycle.
//
// The extraction is behaviour-neutral — the same events produce the same Redis
// alerts with the same message bodies and the same severity tiers; on-wire
// output is byte-identical to the pre-extraction notification-consumer.ts.
// ---------------------------------------------------------------------------

import {
  NOTIFICATION_EVENT_TYPES as E,
  type NotificationEventPayload,
} from "../event-bus.ts";

/**
 * The set of event types that get persisted as dashboard alerts. Kept as an
 * exported const (not an inline Set literal inside a closure) and in lock-step
 * with the `formatAlertMessage` switch below: every member here either has a
 * dedicated case or hits the default branch. Each entry references a
 * NOTIFICATION_EVENT_TYPES member so a misspelled type is a compile error
 * (issue #1182 contract preserved).
 */
export const ALERT_TYPES: ReadonlySet<string> = new Set<string>([
  E.CYCLE_FAILED, E.CYCLE_ROLLED_BACK, E.CYCLE_AUTO_KILLED, E.CYCLE_STALLED,
  E.DLQ_ALERT, E.CONSUMER_DEAD,
  E.RESEARCH_COMPLETED, E.SCHEDULER_ERROR, E.CYCLE_OPERATOR_BLOCKED,
  E.PATTERN_LOW_MERGE_RATE, E.PATTERN_CONSECUTIVE_FAILURES,
  E.PATTERN_RECURRING_REGRESSIONS, E.PATTERN_ANCHOR_STUCK,
  E.PATTERN_TEST_DECLINE, E.PATTERN_HIGH_ABANDONMENT,
]);

/**
 * Map a notification event to a human-readable dashboard-alert message.
 *
 * Each `case` references a NOTIFICATION_EVENT_TYPES member (aliased `E`) — the
 * typed vocabulary in event-bus.ts (issue #1182) — so a misspelled event type
 * is a compile error, kept in lock-step with the ALERT_TYPES set above. The
 * default branch handles any ALERT_TYPES member without a dedicated case.
 *
 * The `event` parameter is typed `AlertGrammarEvent` (issue #1889) so the
 * payload fields the switch reads are contract-checked too, not just the case
 * labels — mirroring `formatMessage(FormatMessageEvent)` in `notify-format.ts`
 * (#1857) and `buildDigestMessage(DigestGrammarEvent[])` in `digest-format.ts`
 * (#1835). A renamed read field is a compile error here, not a silent miss.
 */
export function formatAlertMessage(event: AlertGrammarEvent): string {
  const p = event.payload || {};
  switch (event.type) {
    case E.CYCLE_FAILED: return `Cycle failed: ${p.taskTitle || p.cycleId || "unknown"} — ${p.reason || "verification failed"}`;
    case E.CYCLE_ROLLED_BACK: return `Cycle rolled back: ${p.taskTitle || ""} — tests regressed`;
    case E.CYCLE_AUTO_KILLED: return `Cycle auto-killed after ${p.elapsed || "?"} (TTL exceeded)`;
    case E.CYCLE_STALLED: return `Cycle stalled: ${p.inProgress || 0} tasks running for ${p.elapsed || "?"}`;
    case E.DLQ_ALERT: return `Dead letter: ${p.eventType || "unknown"} failed ${p.deliveryCount || 0}x — ${p.error || ""}`;
    case E.CONSUMER_DEAD: return `Consumer ${p.consumer || "unknown"} died after ${p.restarts || 0} restarts`;
    case E.RESEARCH_COMPLETED: return `Research cycle complete: ${p.opportunityCount || 0} opportunities found`;
    case E.SCHEDULER_ERROR: return `Scheduler error: ${p.message || p.error || "unknown"}`;
    case E.CYCLE_OPERATOR_BLOCKED: return `BLOCKED — needs your action: "${p.title}" — ${p.blockedReason}`;
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
 * `taskTitle` → `title`, or `cycleId` → `id`) becomes a compile error at the
 * access site rather than a silent runtime miss in the dashboard-alert body.
 *
 * This mirrors `FormatMessageEvent` (`notify-format.ts`, issue #1857) and
 * `DigestGrammarEvent` (`digest-format.ts`, issue #1835) — the two sibling
 * formatters that fixed the same class of gap. All three now DERIVE their
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
      | "taskTitle"
      | "cycleId"
      | "reason"
      | "elapsed"
      | "inProgress"
      | "eventType"
      | "deliveryCount"
      | "error"
      | "consumer"
      | "restarts"
      | "opportunityCount"
      | "message"
      | "title"
      | "blockedReason"
    >;
}

/**
 * Severity tiers a dashboard alert can carry. The third leg of the
 * alert-build grammar alongside `ALERT_TYPES` (which events become alerts)
 * and `formatAlertMessage` (what the alert says).
 */
export type AlertSeverity = "error" | "warning" | "info";

/**
 * Classify a notification event type into its dashboard-alert severity tier.
 *
 * The named, exported sibling of `formatAlertMessage` — extracted from the
 * inline ternary that used to live in `handleNotificationEvent` (issue #1855).
 * Each branch references a NOTIFICATION_EVENT_TYPES member (aliased `E`) — the
 * typed vocabulary in event-bus.ts (issue #1182) — so a misspelled event type
 * is a compile error, the same compile-time-safety win that motivated the
 * member references in `ALERT_TYPES` / `formatAlertMessage`. Any event type
 * without a dedicated `error`/`warning` mapping falls through to `"info"`,
 * preserving the pre-extraction ternary's behaviour for every ALERT_TYPES
 * member (verified row-by-row in test/notification-consumer.test.mts).
 */
export function classifyAlertSeverity(eventType: string): AlertSeverity {
  switch (eventType) {
    case E.CYCLE_FAILED:
    case E.CYCLE_ROLLED_BACK:
    case E.CONSUMER_DEAD:
      return "error";
    case E.CYCLE_STALLED:
    case E.CYCLE_AUTO_KILLED:
      return "warning";
    default:
      return "info";
  }
}
