/**
 * Pipeline consumers — notification, DLQ, and meta agent consumers.
 *
 * The V2 control loop (control-loop.mjs) handles all agent execution directly.
 * This module only provides background stream consumers for:
 * - Notifications (Telegram via OpenClaw)
 * - Dead-letter queue (alert + mark tasks failed)
 * - Meta agent (process improvement from hard metrics)
 */

import { STREAMS } from "./event-bus.mjs";
import { getTracker } from "./task-tracker.mjs";
import { runMetaAnalysis } from "./proposals.mjs";
import { sendNotification } from "./notify.mjs";
import { recordEvent } from "./digest.mjs";

// ---------------------------------------------------------------------------
// Consumer crash recovery — restart consumers with backoff on fatal errors
// ---------------------------------------------------------------------------

const MAX_CONSUMER_RESTARTS = 5;
const BACKOFF_BASE_MS = 5000;

async function startConsumerWithRecovery(name, startFn) {
  let restarts = 0;

  while (true) {
    try {
      await startFn();
      break; // normal exit via stopConsuming
    } catch (err) {
      restarts++;
      console.error(`[Pipeline] ${name} consumer crashed (restart ${restarts}/${MAX_CONSUMER_RESTARTS}):`, err.message);

      if (restarts > MAX_CONSUMER_RESTARTS) {
        console.error(`[Pipeline] ${name} consumer exceeded max restarts — giving up`);
        await sendNotification({
          type: "consumer:dead",
          payload: { consumer: name, error: err.message, restarts },
        });
        break;
      }

      const delay = BACKOFF_BASE_MS * restarts;
      console.log(`[Pipeline] Restarting ${name} consumer in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Notification consumer — sends events to Telegram via OpenClaw
// ---------------------------------------------------------------------------

async function consumeNotifications(eventBus) {
  const consumer = `notify-${process.pid}`;
  await eventBus.consume(
    STREAMS.NOTIFICATIONS,
    "openclaw",
    consumer,
    async (event) => {
      // Route to digest system instead of sending per-event
      recordEvent(event);
    },
    { count: 1, blockMs: 5000 },
  );
}

// ---------------------------------------------------------------------------
// Meta agent consumer — process improvement from measured failures
// ---------------------------------------------------------------------------

async function consumeMetaAgent(eventBus) {
  const consumer = `meta-${process.pid}`;
  await eventBus.consume(
    STREAMS.META,
    "meta",
    consumer,
    async (event) => {
      if (event.type === "cycle:report" || event.type === "eval:failed") {
        console.log(`[Pipeline] meta processing ${event.type}`);
        await runMetaAnalysis(eventBus, event);
      }
    },
    { count: 1, blockMs: 10000 },
  );
}

// ---------------------------------------------------------------------------
// DLQ consumer — process dead-letter entries, alert, and mark tasks failed
// ---------------------------------------------------------------------------

async function consumeDLQ(eventBus) {
  const consumer = `dlq-${process.pid}`;
  await eventBus.consume(
    STREAMS.DLQ,
    "dlq-processor",
    consumer,
    async (event) => {
      const { originalStream, originalGroup, originalEvent, error, deliveryCount } = event.payload || {};
      console.error(`[DLQ] Failed event from ${originalStream}/${originalGroup}: ${originalEvent?.type} — ${error} (${deliveryCount} attempts)`);

      await sendNotification({
        type: "dlq:alert",
        payload: { originalStream, originalGroup, eventType: originalEvent?.type, error, deliveryCount },
      });

      const taskId = originalEvent?.payload?.taskId;
      if (taskId) {
        const trackingTaskId = originalEvent?.payload?.originalTaskId || taskId;
        await getTracker().markTaskDone(trackingTaskId, "failed", eventBus);
      }
    },
    { count: 1, blockMs: 10000 },
  );
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Start background consumers for notifications, DLQ, and meta.
 * The V2 control loop handles agent execution — no agent consumers needed.
 */
async function startPipeline(eventBus) {
  console.log("[Pipeline] Starting background consumers...");

  // Recover held tasks from Redis (from previous cycle's dependency holds)
  try {
    const recovered = await getTracker().recoverHeldTasks();
    if (recovered.length > 0) {
      console.log(`[Pipeline] Recovered ${recovered.length} held task(s) from Redis`);
    }
  } catch (err) {
    console.error(`[Pipeline] Failed to recover held tasks:`, err.message);
  }

  // Start consumers with crash recovery
  startConsumerWithRecovery("meta", () => consumeMetaAgent(eventBus));
  console.log(`[Pipeline] meta listening on ${STREAMS.META}`);

  startConsumerWithRecovery("notifications", () => consumeNotifications(eventBus));
  console.log(`[Pipeline] notifications → Telegram bridge started`);

  startConsumerWithRecovery("dlq", () => consumeDLQ(eventBus));
  console.log(`[Pipeline] dlq-processor listening on ${STREAMS.DLQ}`);
}

function stopPipeline(eventBus) {
  eventBus.stopConsuming();
  console.log("[Pipeline] Consumers stopped");
}

export { startPipeline, stopPipeline };
