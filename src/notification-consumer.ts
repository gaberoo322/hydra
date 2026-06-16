// ---------------------------------------------------------------------------
// Notification-consumer Module (issue #1376) — the consumer-recovery lifecycle
// and consumer-registration index for the background streams. Originally lifted
// out of the process entry-point src/index.ts.
//
// The alert-routing grammar (which events become dashboard alerts, how each
// maps to a message, what severity it carries) was extracted into its own
// focused Seam at src/notification/alert-grammar.ts (issue #1979). This Module
// now owns ONLY two concerns: the generic consumer restart/backoff policy
// (`startConsumerWithRecovery`) and the consumer-registration index
// (`startConsumers`, `handleNotificationEvent`) — it imports the grammar and
// delegates. Process lifecycle (port guard, eventBus.init, SIGTERM) stays in
// index.ts.
//
// The five lifted grammar symbols (ALERT_TYPES, formatAlertMessage,
// classifyAlertSeverity, AlertGrammarEvent, AlertSeverity) are RE-EXPORTED
// below so the existing test import surface (and any future importer) resolves
// them unchanged — the same re-export precedent as notify.ts (formatMessage)
// and digest.ts (its formatters).
//
// Runtime behaviour is unchanged from the pre-extraction module: same events
// produce the same Redis alerts, the same capacity-floor side records, and the
// same restart/backoff sequence.
// ---------------------------------------------------------------------------

import {
  EventBus,
  STREAMS,
  NOTIFICATION_EVENT_TYPES as E,
  type NotificationEventPayload,
} from "./event-bus.ts";
import { sendNotification } from "./notify.ts";
import { recordEvent } from "./digest.ts";
import { pushAlert } from "./redis/alerts.ts";
import { recordCycleSide, classifySide } from "./capacity-floor.ts";
import { publishOrchestratorShareMetric } from "./metrics/publish.ts";
import { startSlotEventsBridge } from "./autopilot/slot-events-bridge.ts";
import { startRecommendationConsumer } from "./autopilot/recommendation-engine.ts";
import {
  ALERT_TYPES,
  formatAlertMessage,
  classifyAlertSeverity,
  type AlertGrammarEvent,
  type AlertSeverity,
} from "./notification/alert-grammar.ts";

// Re-export the alert-routing grammar so callers that import it from this
// Module (e.g. test/notification-consumer.test.mts) keep resolving the same
// symbols after the extraction (issue #1979). The grammar's single owner is
// src/notification/alert-grammar.ts; this forward keeps the public surface
// behaviour-neutral — the notify.ts / digest.ts re-export precedent.
export {
  ALERT_TYPES,
  formatAlertMessage,
  classifyAlertSeverity,
  type AlertGrammarEvent,
  type AlertSeverity,
};

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
      | "task"
      | "filesChanged"
      | "rolledBack"
      | "commitSha"
    >;
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
    // `filesChanged` is typed `unknown[]` in the shared vocabulary
    // (`NotificationEventPayload`, #1915); keep the string paths the
    // capacity-floor side classifier expects and drop any non-string entry.
    const files: string[] = Array.isArray(p.filesChanged)
      ? p.filesChanged.filter((f): f is string => typeof f === "string")
      : [];
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
