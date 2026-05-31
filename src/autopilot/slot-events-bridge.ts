/**
 * slot-events-bridge.ts — bridge `hydra:autopilot:slot-events` to WS clients.
 *
 * The autopilot's bash hooks (on-subagent-stop, on-subagent-permission-wait)
 * XADD events onto `hydra:autopilot:slot-events` so the next decision turn
 * can react without polling. The /now-pixel dashboard (epic #642) wants the
 * same events live to drive one-shot sprite animations (excited / cheering /
 * hurt). This bridge XREADs from that stream and re-broadcasts each event
 * over the existing WebSocket channel under the synthetic stream name
 * `autopilot:slot-events`.
 *
 * Slice 4 of /now-pixel (#642, #646). The bridge is read-only with respect
 * to the autopilot — it does NOT XACK in a way that affects the autopilot's
 * own consumer (the autopilot uses a different consumer group, `autopilot`,
 * and we use `now-pixel-bridge`). Different groups have independent cursors,
 * so the bridge can lag or skip without breaking the autopilot's reads.
 *
 * # Design contract
 *
 * - **No XREADGROUP-only.** Use the existing `eventBus.consume()` helper.
 * - **Survives Redis disconnect.** The consume loop's blocking XREADGROUP
 *   reconnects on its own; `startConsumerWithRecovery` in src/index.ts
 *   wraps any throw with restart-with-backoff.
 * - **Best-effort broadcast.** A WebSocket `send` failure on any single
 *   client doesn't block the bridge — `_broadcastToClients` iterates and
 *   logs per-client.
 * - **Pure shape translation.** No business logic. The bridge does not
 *   classify, filter, or enrich; it just forwards the Redis-stream fields
 *   verbatim under a clean envelope shape.
 */

import type { EventBus } from "../event-bus.ts";

export const SLOT_EVENTS_STREAM = "hydra:autopilot:slot-events";
const CONSUMER_GROUP = "now-pixel-bridge";
const WS_STREAM_NAME = "autopilot:slot-events";

export interface SlotEventEnvelope {
  type: "slot-event";
  id: string;
  timestamp: string;
  payload: Record<string, string>;
}

/**
 * Start the bridge. Returns a stop function (best-effort; the underlying
 * consume loop is not cancelled — eventBus owns its loop lifecycle).
 */
export async function startSlotEventsBridge(
  eventBus: EventBus,
  opts: { consumerName?: string } = {},
): Promise<void> {
  const consumerName = opts.consumerName ?? `bridge-${process.pid}`;

  // Ensure the stream + consumer group exist. The hooks XADD with MKSTREAM
  // is opportunistic; we explicitly create the group here so the consumer can
  // start cleanly even if no event has fired yet this session. Start at "$"
  // (skip backlog) — this bridge only animates NEW events, replaying the
  // backlog on every restart would re-fire stale sprite animations.
  await eventBus.ensureConsumerGroup(SLOT_EVENTS_STREAM, CONSUMER_GROUP, "$");

  console.log(
    `[slot-events-bridge] consuming ${SLOT_EVENTS_STREAM} group=${CONSUMER_GROUP} consumer=${consumerName}`,
  );

  await eventBus.consume(
    SLOT_EVENTS_STREAM,
    CONSUMER_GROUP,
    consumerName,
    async (event: any) => {
      bridgeBroadcast(eventBus, event);
    },
    { count: 32, blockMs: 5000 },
  );
}

/**
 * Pure helper — translate a raw stream event into the WS envelope and
 * push it through the eventBus broadcaster. Exported for tests.
 *
 * The stream events emitted by the bash hooks store every field as a
 * string (Redis XADD field/value pairs). We forward them verbatim under
 * `payload` and let the dashboard be the one to interpret the wire shape.
 */
export function bridgeBroadcast(eventBus: EventBus, event: any): SlotEventEnvelope {
  const fields = event && typeof event === "object" ? event : {};
  const id: string = fields.id || fields.msgId || "";
  // The `event` field on slot-events is the discriminator (subagent_stop,
  // slot_waiting_permission, etc.). We keep it on the payload so clients
  // pattern-match on it.
  const envelope: SlotEventEnvelope = {
    type: "slot-event",
    id,
    timestamp: new Date().toISOString(),
    payload: extractPayload(fields),
  };
  eventBus._broadcastToClients(WS_STREAM_NAME, envelope);
  return envelope;
}

function extractPayload(fields: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fields || typeof fields !== "object") return out;
  // _parseFields in event-bus.ts hoists `type` / `id` / `timestamp` /
  // `correlationId` / `payload` to top-level when they exist. The slot
  // events store unstructured field/value pairs; what remains after
  // _parseFields lifting is either on the top-level object or under
  // payload-as-json. We support both shapes.
  if (fields.payload && typeof fields.payload === "object") {
    for (const [k, v] of Object.entries(fields.payload)) {
      if (typeof v === "string" || typeof v === "number") out[k] = String(v);
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (k === "payload" || k === "id" || k === "timestamp" || k === "msgId") continue;
    if (typeof v === "string" || typeof v === "number") out[k] = String(v);
  }
  return out;
}
