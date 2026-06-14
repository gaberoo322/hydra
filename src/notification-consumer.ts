// ---------------------------------------------------------------------------
// Notification-consumer Module (issue #1376) — the single owner of the
// alert-routing grammar that used to live inline in the process entry-point
// src/index.ts.
//
// This Module concentrates a piece of grammar (which events become dashboard
// alerts, how each maps to a message, the consumer restart/backoff policy)
// so a format change is a one-place edit rather than a writer-plus-readers
// sweep — the same Seam pattern CONTEXT.md documents for Feedback-File (#940)
// and Escalation (#823). It owns ONLY consumer registration + the grammar;
// process lifecycle (port guard, eventBus.init, SIGTERM) stays in index.ts.
//
// Runtime behaviour is unchanged from the pre-extraction index.ts: same events
// produce the same Redis alerts, the same capacity-floor side records, and the
// same restart/backoff sequence.
// ---------------------------------------------------------------------------

import { EventBus, STREAMS, NOTIFICATION_EVENT_TYPES as E } from "./event-bus.ts";
import { sendNotification } from "./notify.ts";
import { recordEvent } from "./digest.ts";
import { pushAlert } from "./redis/alerts.ts";
import { recordCycleSide, classifySide } from "./capacity-floor.ts";
import { publishOrchestratorShareMetric } from "./metrics/publish.ts";
import { startSlotEventsBridge } from "./autopilot/slot-events-bridge.ts";
import { startRecommendationConsumer } from "./autopilot/recommendation-engine.ts";

export const MAX_CONSUMER_RESTARTS = 5;
export const BACKOFF_BASE_MS = 5000;

/**
 * A bus-published event as the notification consumers observe it. Loosely
 * typed because the NOTIFICATIONS stream carries the full event vocabulary
 * (`NOTIFICATION_EVENT_TYPES`) plus the cycle-lifecycle events the digest
 * listens for; the grammar below narrows on `type` at each switch arm.
 */
export interface NotificationEvent {
  type: string;
  id?: string;
  timestamp?: string;
  correlationId?: string;
  payload?: Record<string, unknown> & {
    taskTitle?: string;
    cycleId?: string;
    reason?: string;
    elapsed?: string;
    inProgress?: number;
    eventType?: string;
    deliveryCount?: number;
    error?: string;
    consumer?: string;
    restarts?: number;
    opportunityCount?: number;
    message?: string;
    title?: string;
    blockedReason?: string;
    task?: { finalState?: string };
    filesChanged?: unknown;
    rolledBack?: boolean;
    commitSha?: string;
  };
}

/**
 * Injectable delay. Production passes nothing (real setTimeout-backed timer,
 * so timing is unchanged); tests pass a synchronous no-op / recorder to drive
 * the restart loop without real waits.
 */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a consumer start function, restarting it with a linear backoff on crash
 * up to MAX_CONSUMER_RESTARTS, then emitting a CONSUMER_DEAD notification and
 * returning. Never throws to its caller — a dead consumer alerts, it does not
 * crash the process.
 *
 * The `sleep` parameter is injectable (defaults to the real timer) so the
 * restart-count behaviour can be asserted without real waits (issue #1376).
 */
export async function startConsumerWithRecovery(
  name: string,
  startFn: () => Promise<unknown>,
  sleep: Sleep = realSleep,
): Promise<void> {
  let restarts = 0;
  while (true) {
    try {
      await startFn();
      break;
    } catch (err: any) {
      restarts++;
      console.error(`[Consumer] ${name} crashed (restart ${restarts}/${MAX_CONSUMER_RESTARTS}):`, err.message);
      if (restarts > MAX_CONSUMER_RESTARTS) {
        console.error(`[Consumer] ${name} exceeded max restarts — giving up`);
        await sendNotification({
          type: E.CONSUMER_DEAD,
          payload: { consumer: name, error: err.message, restarts },
        });
        break;
      }
      const delay = BACKOFF_BASE_MS * restarts;
      console.log(`[Consumer] Restarting ${name} in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

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
 */
export function formatAlertMessage(event: NotificationEvent): string {
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

/**
 * Handle a single event off the NOTIFICATIONS stream: record it for the
 * digest, stamp the capacity-floor side history on cycle:completed (best
 * effort — issue #245 / #315 contract preserved), and persist alert-worthy
 * events as dashboard alerts.
 */
async function handleNotificationEvent(event: NotificationEvent): Promise<void> {
  recordEvent(event);

  // Issue #245: stamp each completed cycle's "side" in the capacity-floor
  // history so autopilot can enforce the 25% orchestrator self-improvement
  // floor. Codex cycles only ever merge against the target workspace, but
  // we still run classifySide() so the call site stays honest if that
  // ever changes (e.g. mixed-repo cycles). Best-effort — recordCycleSide
  // swallows its own errors so digest/alerting can never break a cycle.
  if (event.type === "cycle:completed") {
    const p = event.payload || {};
    const finalState = p.task?.finalState;
    const files: string[] = Array.isArray(p.filesChanged) ? p.filesChanged : [];
    const isMerged = (finalState === "merged") && !p.rolledBack;
    const side = isMerged ? classifySide(files, { workspaceHint: "target" }) : "idle";
    await recordCycleSide(p.cycleId || event.correlationId || `evt-${Date.now()}`, side, {
      commitSha: p.commitSha || undefined,
      filesChanged: files.length > 0 ? files.slice(0, 50) : undefined,
      source: "cycle-completed-listener",
    });

    // Issue #315: publish the current self-improvement share to disk so
    // the outcomes file adapter (config/direction/outcomes.yaml ->
    // metrics/orchestrator-share.txt) has a real value to read. Without
    // this, the only seeded Target Outcome is permanently unobservable.
    // (The stuckness detector + 25% capacity floor that originally
    // consumed this signal were retired in ADR-0010.) Best-effort —
    // publisher logs and never throws.
    await publishOrchestratorShareMetric();
  }

  // Persist important events as dashboard alerts
  if (ALERT_TYPES.has(event.type)) {
    const alert = {
      id: event.id || `alert-${Date.now()}`,
      type: event.type,
      timestamp: event.timestamp || new Date().toISOString(),
      message: formatAlertMessage(event),
      severity: classifyAlertSeverity(event.type),
      dismissed: false,
      payload: event.payload,
    };
    await pushAlert(JSON.stringify(alert), 100);
  }
}

/**
 * Register the four background stream consumers (notifications, DLQ,
 * slot-events bridge, recommendation engine) on the given Event Bus, each
 * wrapped in `startConsumerWithRecovery`. This is the thin caller index.ts
 * delegates to — index.ts retains process lifecycle, this Module owns
 * consumer registration + grammar.
 */
export function startConsumers(eventBus: EventBus): void {
  // Notification consumer — stores alerts in Redis for dashboard + digest
  startConsumerWithRecovery("notifications", () =>
    eventBus.consume(STREAMS.NOTIFICATIONS, "openclaw", `notify-${process.pid}`,
      (event) => handleNotificationEvent(event as NotificationEvent),
      { count: 1, blockMs: 5000 }),
  );

  // Dead-letter queue consumer — alert and mark tasks failed
  startConsumerWithRecovery("dlq", () =>
    eventBus.consume(STREAMS.DLQ, "dlq-processor", `dlq-${process.pid}`, async (event) => {
      const { originalStream, originalGroup, originalEvent, error, deliveryCount } = (event as NotificationEvent).payload || {} as any;
      console.error(`[DLQ] Failed event from ${originalStream}/${originalGroup}: ${originalEvent?.type} — ${error} (${deliveryCount} attempts)`);
      await sendNotification({
        type: E.DLQ_ALERT,
        payload: { originalStream, originalGroup, eventType: originalEvent?.type, error, deliveryCount },
      });
    }, { count: 1, blockMs: 10000 }),
  );

  // Slot-events bridge — re-broadcasts hydra:autopilot:slot-events over WS
  // for the /now-pixel dashboard's one-shot sprite animations (epic #642,
  // slice 4 of #646). Read-only — the autopilot's own consumer group is
  // unaffected.
  startConsumerWithRecovery("slot-events-bridge", () =>
    startSlotEventsBridge(eventBus),
  );

  // Recommendation engine — reacts to `turn_end` events from slice A
  // (#668) by firing at most one claude-haiku-4-5 call per turn (gated on
  // a 30s interval, a material-change predicate, and a daily USD cap).
  // Slice F of /now-pixel observability (#674).
  startConsumerWithRecovery("recs-engine", () =>
    startRecommendationConsumer(eventBus),
  );

  console.log(
    "[Hydra] Background consumers started (notifications, dlq, slot-events-bridge, recs-engine)",
  );
}
