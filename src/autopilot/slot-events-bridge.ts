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
 *   client doesn't block the bridge — the WS registry's `broadcast` iterates
 *   over OPEN clients.
 * - **Pure shape translation.** No business logic. The bridge does not
 *   classify, filter, or enrich; it just forwards the Redis-stream fields
 *   verbatim under a clean envelope shape.
 */

import type { EventBus } from "../event-bus.ts";
import type { WsBroadcastRegistry } from "../ws-broadcast-registry.ts";
import { cascadeRecordFromEvent, recordCascade } from "../redis/cascade-telemetry.ts";

const SLOT_EVENTS_STREAM = "hydra:autopilot:slot-events";
const CONSUMER_GROUP = "now-pixel-bridge";
const WS_STREAM_NAME = "autopilot:slot-events";

/** Default consumer name for this process's bridge consumer (pid-scoped). */
function defaultBridgeConsumerName(): string {
  return `bridge-${process.pid}`;
}

/**
 * The `{stream, group, consumer}` descriptor for THIS process's bridge
 * consumer — so the SIGTERM shutdown path can best-effort DELCONSUMER its own
 * name on graceful exit (issue #1221). Mirrors the name `startSlotEventsBridge`
 * registers when called with no `consumerName` override.
 */
export function slotEventsBridgeConsumer(): { stream: string; group: string; consumer: string } {
  return { stream: SLOT_EVENTS_STREAM, group: CONSUMER_GROUP, consumer: defaultBridgeConsumerName() };
}

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
  const consumerName = opts.consumerName ?? defaultBridgeConsumerName();

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
      bridgeBroadcast(eventBus.wsRegistry, event);
      // Cascade-routing telemetry (issue #3284): persist the cascade decision
      // events into the durable bounded ring so the metrics surface can trend
      // escalation/block rate + cost delta across restarts. Best-effort — a
      // telemetry write must never break the animation broadcast it rides
      // (mirrors the bridge's existing best-effort-broadcast contract).
      await persistCascadeTelemetry(event);
    },
    // reapStale: this group is `$`-anchored (no backlog replay) and only
    // animates NEW events, so dropping a dead zombie's PEL is correct (#1221).
    { count: 32, blockMs: 5000, reapStale: true },
  );
}

/**
 * Best-effort persist of a cascade-routing telemetry event into the durable
 * ring (issue #3284). The bridge is `$`-anchored and lossy (it animates NEW
 * events and may lag/skip on restart), so this is a best-effort DURABILITY
 * layer, not an exactly-once ledger — the metrics card tolerates a dropped
 * record the same way the sprite feed tolerates a skipped frame. A non-cascade
 * event is a cheap no-op (`cascadeRecordFromEvent` returns null).
 */
export async function persistCascadeTelemetry(event: any): Promise<void> {
  try {
    const rec = cascadeRecordFromEvent(extractPayload(event));
    if (rec) await recordCascade(rec);
  } catch (err: any) {
    // Never propagate — telemetry must not break the bridge (fail-loud log).
    console.error(
      `[slot-events-bridge] cascade telemetry persist failed: ${err?.message || err}`,
    );
  }
}

/**
 * Pure helper — translate a raw stream event into the WS envelope and
 * push it through the WS broadcast registry. Exported for tests.
 *
 * Takes the `WsBroadcastRegistry` (the named broadcast surface) rather than
 * the full `EventBus` — the bridge needs only to fan out to WS clients, not
 * the Redis stream seam (issue #1965). `startSlotEventsBridge` passes
 * `eventBus.wsRegistry`.
 *
 * The stream events emitted by the bash hooks store every field as a
 * string (Redis XADD field/value pairs). We forward them verbatim under
 * `payload` and let the dashboard be the one to interpret the wire shape.
 */
export function bridgeBroadcast(
  wsRegistry: WsBroadcastRegistry,
  event: any,
): SlotEventEnvelope {
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
  wsRegistry.broadcast(WS_STREAM_NAME, envelope);
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
