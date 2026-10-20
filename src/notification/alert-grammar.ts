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
// vocabulary from event-bus-vocabulary.ts (issue #1985 — the zero-Redis-side-
// effect Seam); notification-consumer.ts imports the grammar from here (and
// re-exports it for the existing test import surface). No cycle.
//
// The extraction is behaviour-neutral — the same events produce the same Redis
// alerts with the same message bodies and the same severity tiers; on-wire
// output is byte-identical to the pre-extraction notification-consumer.ts.
// ---------------------------------------------------------------------------

import {
  NOTIFICATION_EVENT_TYPES as E,
  type NotificationEventPayload,
} from "../event-bus-vocabulary.ts";

/**
 * The set of event types that get persisted as dashboard alerts. Kept as an
 * exported const (not an inline Set literal inside a closure) and in lock-step
 * with the `formatAlertMessage` switch below: every member here either has a
 * dedicated case or hits the default branch. Each entry references a
 * NOTIFICATION_EVENT_TYPES member so a misspelled type is a compile error
 * (issue #1182 contract preserved).
 */
export const ALERT_TYPES: ReadonlySet<string> = new Set<string>([
  // Issue #5044: the codex-era cycle/research/scheduler/pattern members were
  // deleted with their types (no live producer); only live types remain.
  E.DLQ_ALERT, E.CONSUMER_DEAD,
  // Issue #3848: the two in-band launch-flow signals. Both are reached only
  // via a successfully-read pace-gate verdict, which proves the Orchestrator
  // was up at detection time, so a dashboard alert is the right surface. The
  // forgotten-pause signal is deliberately NOT an alert type — a deliberate
  // overnight operator pause must never leave a lingering unread dashboard
  // alert; pause surfaces as a digest line only (CRITICAL_EVENT_TYPES in
  // digest.ts — this file contains no pause member at all, by design).
  E.LAUNCH_QUOTA_STRETCH, E.LAUNCH_LATENCY_BREACH,
  // Issue #4175: a watched node_modules install root (e.g. a live Target
  // service's dependency tree) was found broken. Always reached via a
  // successfully-completed watchdog filesystem check, so the Orchestrator is
  // provably up — a dashboard alert is warranted alongside the digest line.
  E.INFRA_NODE_MODULES_WIPED,
  // Issue #4939: ~/hydra's origin URL is wrong or origin/master is missing;
  // detected by a successful watchdog read, so the Orchestrator is up.
  E.INFRA_ORIGIN_IDENTITY_WRONG,
  // Issue #3868: the GLM drainer is live but sterile — fresh heartbeat,
  // eligible work queued, zero drainer PRs in the window. A board-throughput
  // failure observed while the Orchestrator is demonstrably up (the watchdog
  // read the heartbeat and the board successfully), so in-band per the #3848
  // surface taxonomy: dashboard alert + immediate digest line.
  E.GLM_DRAINER_STERILE,
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
 * alert-build grammar alongside `ALERT_TYPES` (which events become alerts)
 * and `formatAlertMessage` (what the alert says). `"warning"` stays in the
 * union even though no live type maps to it since issue #5044 — the dashboard
 * reads this field, so the union is a wire contract, not a formatter arm.
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
 * without a dedicated `error` mapping falls through to `"info"`,
 * preserving the pre-extraction ternary's behaviour for every ALERT_TYPES
 * member (verified row-by-row in test/notification-consumer.test.mts).
 */
export function classifyAlertSeverity(eventType: string): AlertSeverity {
  switch (eventType) {
    case E.CONSUMER_DEAD:
      return "error";
    default:
      return "info";
  }
}
