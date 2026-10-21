// ---------------------------------------------------------------------------
// Notification-consumer Module (issue #1376) — the consumer-recovery lifecycle
// and consumer-registration index for the background streams. Originally lifted
// out of the process entry-point src/index.ts.
//
// The alert-routing grammar (which events become dashboard alerts, how each
// maps to a message, what severity it carries) was extracted into its own
// focused Seam at src/notification/alert-grammar.ts (issue #1979). The
// `cycle:completed` domain reaction (classify the merged files, stamp the
// capacity-floor side history, publish the orchestrator-share metric) was
// extracted into a sibling focused Seam at
// src/notification/cycle-completed-reactor.ts (issue #1983) for the same
// reason. This Module now owns ONLY two concerns: the generic consumer
// restart/backoff policy (`startConsumerWithRecovery`) and the
// consumer-registration index (`startConsumers`, `handleNotificationEvent`) —
// it imports both Seams and delegates. Its remaining imports all belong to the
// notification-routing domain. Process lifecycle (port guard, eventBus.init,
// SIGTERM) stays in index.ts.
//
// The three grammar symbols this Module still consumes internally
// (ALERT_TYPES, formatAlertMessage, classifyAlertSeverity) are imported
// directly from that Seam for use inside handleNotificationEvent. The
// compatibility re-export bridge that briefly forwarded the lifted grammar
// symbols (issue #1979) has been dropped — every importer (including
// test/notification-consumer.test.mts) now resolves the grammar from its
// single owner src/notification/alert-grammar.ts directly (issue #2000).
//
// Runtime behaviour is unchanged from the pre-extraction module: same events
// produce the same Redis alerts, the same capacity-floor side records, and the
// same restart/backoff sequence.
// ---------------------------------------------------------------------------

import { EventBus } from "./event-bus.ts";
import { STREAMS } from "./event-bus-stream-keys.ts";
import {
  NOTIFICATION_EVENT_TYPES as E,
  type NotificationEventPayload,
} from "./event-bus-vocabulary.ts";
import {
  operatorChannel,
  messageFromEvent,
  checkOperatorChannelCredentials,
  routeNotificationEvent,
  type OperatorChannel,
} from "./operator-channel/index.ts";
import { pushAlert } from "./redis/alerts.ts";
import { reactToCycleCompleted } from "./notification/cycle-completed-reactor.ts";
import { startSlotEventsBridge } from "./autopilot/slot-events-bridge.ts";
import { startRecommendationConsumer } from "./autopilot/recommendation-consumer.ts";
import {
  ALERT_TYPES,
  formatAlertMessage,
  classifyAlertSeverity,
} from "./notification/alert-grammar.ts";
import { logger } from "./logger.ts";

export const MAX_CONSUMER_RESTARTS = 5;
export const BACKOFF_BASE_MS = 5000;

const CONSUMER_NAMES = ["notifications", "dlq", "slot-events-bridge", "recs-engine"] as const;

/**
 * A bus-published event as the notification consumers observe it. Loosely
 * typed because the NOTIFICATIONS stream carries the full event vocabulary
 * (`NOTIFICATION_EVENT_TYPES`) plus the cycle-lifecycle events the Operator
 * Channel routes; the grammar below narrows on `type` at each switch arm.
 */
export interface NotificationEvent {
  type: string;
  id?: string;
  timestamp?: string;
  correlationId?: string;
  payload?: Record<string, unknown> &
    Pick<
      NotificationEventPayload,
      | "cycleId"
      | "reason"
      | "eventType"
      | "deliveryCount"
      | "error"
      | "consumer"
      | "restarts"
      | "title"
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
  channel: Pick<OperatorChannel, "page"> = operatorChannel,
): Promise<void> {
  let restarts = 0;
  while (true) {
    try {
      await startFn();
      break;
    } catch (err: any) {
      restarts++;
      logger.error(
        { name, restarts, maxRestarts: MAX_CONSUMER_RESTARTS, err },
        "[Consumer] crashed",
      );
      if (restarts > MAX_CONSUMER_RESTARTS) {
        logger.error({ name, restarts }, "[Consumer] exceeded max restarts — giving up");
        // A dead consumer is a Page (ADR-0045), deduped per consumer name.
        await channel
          .page(
            messageFromEvent({
              type: E.CONSUMER_DEAD,
              payload: { consumer: name, error: err.message, restarts },
            }),
          )
          .catch((pageErr) =>
            logger.error({ name, err: pageErr }, "[Consumer] failed to page consumer:dead"),
          );
        break;
      }
      const delay = BACKOFF_BASE_MS * restarts;
      logger.info({ name, delay, restarts }, "[Consumer] restarting after backoff");
      await sleep(delay);
    }
  }
}

/**
 * Handle a single event off the NOTIFICATIONS stream: route it to the
 * Operator Channel (page or Morning Brief item), stamp the capacity-floor side
 * history on cycle:completed (best
 * effort — issue #245 / #315 contract preserved), and persist alert-worthy
 * events as dashboard alerts.
 */
async function handleNotificationEvent(event: NotificationEvent): Promise<void> {
  routeNotificationEvent(event);

  // React to a completed cycle (classify the merged files, stamp the
  // capacity-floor side history, publish the orchestrator-share metric). That
  // domain reaction lives in its own focused Seam (issue #1983); this router
  // just delegates. Best-effort — the reactor's writers swallow their own
  // errors so channel routing / alerting can never break a cycle.
  if (event.type === "cycle:completed") {
    await reactToCycleCompleted(event);
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
export function startConsumers(
  eventBus: EventBus,
  channel: Pick<OperatorChannel, "page" | "brief" | "resolve"> = operatorChannel,
): void {
  checkOperatorChannelCredentials();

  // A restart means the consumers are alive again: publish the one "recovered"
  // message for any consumer:dead page still open (no-op when none is).
  for (const consumerName of CONSUMER_NAMES) {
    channel
      .resolve(`consumer:dead:${consumerName}`, `Consumer ${consumerName} is running again`)
      .catch((err) =>
        logger.error({ consumerName, err }, "[Consumer] failed to resolve consumer:dead"),
      );
  }

  // Notification consumer — stores alerts in Redis for the dashboard and
  // routes every event to the Operator Channel (page / Morning Brief item)
  startConsumerWithRecovery("notifications", () =>
    eventBus.consume(STREAMS.NOTIFICATIONS, "openclaw", `notify-${process.pid}`,
      (event) => handleNotificationEvent(event as NotificationEvent),
      { count: 1, blockMs: 5000 }),
    undefined,
    channel,
  );

  // Dead-letter queue consumer — alert and mark tasks failed
  startConsumerWithRecovery("dlq", () =>
    eventBus.consume(STREAMS.DLQ, "dlq-processor", `dlq-${process.pid}`, async (event) => {
      const { originalStream, originalGroup, originalEvent, error, deliveryCount } = (event as NotificationEvent).payload || {} as any;
      logger.error(
        { originalStream, originalGroup, eventType: originalEvent?.type, error, deliveryCount },
        "[DLQ] failed event",
      );
      // Dead-letter is not on the closed page list (ADR-0045 Decision 3): a brief item.
      await channel
        .brief(
          messageFromEvent({
            type: E.DLQ_ALERT,
            payload: { originalStream, originalGroup, eventType: originalEvent?.type, error, deliveryCount },
          }),
        )
        .catch((err) => logger.error({ err }, "[DLQ] failed to append brief item"));
    }, { count: 1, blockMs: 10000 }),
    undefined,
    channel,
  );

  // Slot-events bridge — re-broadcasts hydra:autopilot:slot-events over WS
  // for the /now-pixel dashboard's one-shot sprite animations (epic #642,
  // slice 4 of #646). Read-only — the autopilot's own consumer group is
  // unaffected.
  startConsumerWithRecovery("slot-events-bridge", () =>
    startSlotEventsBridge(eventBus),
    undefined,
    channel,
  );

  // Recommendation engine — reacts to `turn_end` events from slice A
  // (#668) by firing at most one claude-haiku-4-5 call per turn (gated on
  // a 30s interval, a material-change predicate, and a daily USD cap).
  // Slice F of /now-pixel observability (#674).
  startConsumerWithRecovery("recs-engine", () =>
    startRecommendationConsumer(eventBus),
    undefined,
    channel,
  );

  logger.info(
    { consumers: [...CONSUMER_NAMES] },
    "[Hydra] background consumers started",
  );
}
