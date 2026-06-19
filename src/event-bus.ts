import { randomUUID } from "node:crypto";

import type Redis from "ioredis";
import type { WebSocket } from "ws";

import { getRedisConnection, getRedisSubscriber, closeRedisConnections } from "./redis/connection.ts";
import { makeWsBroadcastRegistry, type WsBroadcastRegistry } from "./ws-broadcast-registry.ts";
// Consumer-group lifecycle (XGROUP/XINFO setup, teardown, zombie reaping) was
// extracted into a sibling Module (this issue; mirrors the #1965 WS-registry
// split). The bus keeps thin delegator methods that forward into these so every
// caller stays zero-diff while the implementation boundary sharpens.
import {
  ensureConsumerGroup as lifecycleEnsureConsumerGroup,
  reapStaleConsumers as lifecycleReapStaleConsumers,
  delConsumer as lifecycleDelConsumer,
  initConsumerGroups as lifecycleInitConsumerGroups,
} from "./event-bus-lifecycle.ts";
// The notification event vocabulary lives in its own zero-Redis-side-effect Seam
// (issue #1985) so pure formatters can derive their event interfaces without
// pulling the Redis connection into scope. event-bus.ts imports the symbols BACK:
// `NOTIFICATION_EVENT_TYPES` is a runtime value (the DLQ_ENTRY type below), and
// `NotificationEventType` is the type `EventInput.type` widens from.
import { NOTIFICATION_EVENT_TYPES } from "./event-bus-vocabulary.ts";
import type { NotificationEventType } from "./event-bus-vocabulary.ts";

// ---------------------------------------------------------------------------
// Stream topology — the Event Bus alphabet (CONTEXT.md).
//
// Stream key shapes live here (not in redis-keys.ts) because the event bus
// IS the owner of these names — every reader/writer goes through the bus,
// not through the key registry. Adding a new stream means adding it here
// AND wiring a publisher/consumer, not just registering a key.
// ---------------------------------------------------------------------------

/**
 * The live stream set — streams a current consumer actually reads. Typed as
 * a frozen `const` map so `StreamKey` (below) is the closed union of values
 * the bus owns; a caller cannot publish to a stream that is not in this set
 * without a compile error.
 */
const STREAMS = {
  NOTIFICATIONS: "hydra:notifications",
  DLQ: "hydra:dlq",
} as const;

/**
 * Streams retained for back-compat only — NO live consumer reads them. Kept
 * as a separate, explicitly-named map (not folded into `STREAMS`) so the
 * advertised live set matches reality, while the names survive for any
 * external listener:
 *
 *   - `CYCLE` — cycle-start events; no in-process bus consumer today.
 *
 * (`TASKS` / `META` were deleted in #1655 — zero producers and zero consumers
 * after the #345 / legacy-pipeline retirements left nothing writing them.)
 *
 * Producing to these is intentionally NOT type-checked against `StreamKey`;
 * a caller that needs one passes the literal explicitly via `RETAINED_STREAMS`.
 */
const RETAINED_STREAMS = {
  CYCLE: "hydra:cycle",
} as const;

/**
 * A stream the bus owns and a live consumer reads. The closed union of
 * `STREAMS` values — `publish()`/`consume()` accept this so callers cannot
 * target a stream the bus does not advertise. `streamKey()` widens to
 * `string` for the dynamic `/events/:stream` surface; that is the one
 * sanctioned escape hatch.
 */
type StreamKey = (typeof STREAMS)[keyof typeof STREAMS];

// The notification event vocabulary (NOTIFICATION_EVENT_TYPES /
// NotificationEventType / NotificationEventPayload) was extracted into the
// zero-Redis-side-effect Seam `./event-bus-vocabulary.ts` (issue #1985) and is
// imported back at the top of this file.

/**
 * What a producer passes to `publish()`. The bus wraps this into a fixed
 * `EventEnvelope` (below). `payload` is serialised to JSON on the wire.
 *
 * `type` is the `NotificationEventType` vocabulary — the union members surface
 * the known event types in tooling and let in-process producers be checked
 * against the source-of-truth map. The `(string & {})` widening keeps the one
 * sanctioned dynamic boundary (`POST /events/publish`, where `type` arrives
 * from an external request body) able to forward arbitrary strings without a
 * cast, exactly as the `streamKey()` escape hatch widens `StreamKey`.
 */
interface EventInput {
  type: NotificationEventType | (string & {});
  source: string;
  payload?: unknown;
  correlationId?: string | null;
}

/**
 * The fixed envelope `publish()` constructs and XADDs — the first sanctioned
 * wire format (ADR-0017 Category A). `payload` is JSON-stringified on the
 * stream; the WS broadcast carries the parsed `payload` instead (see
 * `publish()`), which is why this names only the on-wire string shape.
 */
interface EventEnvelope {
  id: string;
  type: string;
  source: string;
  timestamp: string;
  correlationId: string | null;
  payload: string;
}

/**
 * A parsed inbound event handed to a `consume()` handler. `_parseFields`
 * folds the flat Redis field list back into an object and JSON-parses the
 * `payload` field when present, so handlers see a structured `payload`.
 */
interface ConsumedEvent {
  type?: string;
  source?: string;
  payload?: unknown;
  [field: string]: unknown;
}

type EventHandler = (event: ConsumedEvent) => void | Promise<void>;

/**
 * One raw stream entry as Redis returns it: `[msgId, [k0, v0, k1, v1, ...]]`.
 * The flat field list is what `_parseFields` folds back into an object.
 */
type RawStreamEntry = [string, string[]];

/** Options for the long-poll consume loop. */
interface ConsumeOptions {
  count?: number;
  blockMs?: number;
  /**
   * When true, sweep STALE (zombie) consumers from this group once at startup,
   * BEFORE the XAUTOCLAIM pass, via `reapStaleConsumers()` (issue #1221). Opt-in
   * because DELCONSUMER drops a consumer's pending entries — only safe on the
   * `$`-anchored slot-events groups (now-pixel-bridge, recs-engine), NEVER on
   * the at-least-once notifications/DLQ groups whose PELs must survive restart.
   */
  reapStale?: boolean;
}

/** Dynamic stream name lookup for `/events/:stream` and similar surfaces. */
export function streamKey(name: string): string {
  return `hydra:${name}`;
}

// Consumer groups — only streams with active consumers.
// META consumer removed in #345 (meta agent deleted); its stream name now
// lives in RETAINED_STREAMS, so it no longer appears here.
const CONSUMER_GROUPS: Record<StreamKey, string[]> = {
  [STREAMS.NOTIFICATIONS]: ["telegram"],
  [STREAMS.DLQ]: ["dlq-processor"],
};

class EventBus {
  publisher: Redis;
  subscriber: Redis;
  /**
   * The in-process WebSocket client registry (issue #1965). `EventBus` owns
   * the Redis *stream* alphabet; WS broadcast is a distinct transport concern,
   * so it lives behind this composed Module rather than as inline class state.
   * Read-only: callers register clients via `addWsClient` (a one-line
   * delegator that keeps `src/index.ts` zero-diff) and the broadcast path
   * delegates to `this.wsRegistry.broadcast(...)`.
   */
  readonly wsRegistry: WsBroadcastRegistry;
  _consuming: boolean;
  constructor() {
    this.publisher = getRedisConnection();
    this.subscriber = getRedisSubscriber();
    this.wsRegistry = makeWsBroadcastRegistry();
    this._consuming = false;
  }

  /**
   * Register a WebSocket client for event broadcasting. One-line delegator to
   * the composed `wsRegistry` so the WS-upgrade handler in `src/index.ts`
   * stays zero-diff (it calls `eventBus.addWsClient(ws)`).
   */
  addWsClient(ws: WebSocket): void {
    this.wsRegistry.add(ws);
  }

  /**
   * Create every declared consumer group at startup. One-line delegator to the
   * lifecycle Module — group setup is an operational bootstrap concern, not part
   * of the bus's hot stream-transport path.
   */
  async init(): Promise<this> {
    await lifecycleInitConsumerGroups(this.publisher, CONSUMER_GROUPS);
    return this;
  }

  /**
   * Idempotently create a consumer group on a stream. One-line delegator to the
   * lifecycle Module's `ensureConsumerGroup`; kept on the class so callers
   * (slot-events bridge, recs consumer) stay zero-diff. See that function for
   * the BUSYGROUP / startId semantics.
   */
  async ensureConsumerGroup(stream: string, group: string, startId: string = "0"): Promise<void> {
    await lifecycleEnsureConsumerGroup(this.publisher, stream, group, startId);
  }

  /**
   * Reap STALE (zombie) consumers from a consumer group (issue #1221). One-line
   * delegator to the lifecycle Module's `reapStaleConsumers`, passing the bus's
   * own `_parseFields` to fold the XINFO rows. Kept on the class so `consume()`
   * (and the tests) call it unchanged. See that function for the full
   * reap-safety contract.
   */
  async reapStaleConsumers(
    stream: string,
    group: string,
    ourConsumerName: string,
    idleMs: number = 300_000,
  ): Promise<string[]> {
    return lifecycleReapStaleConsumers(
      this.publisher,
      (fields) => this._parseFields(fields),
      stream,
      group,
      ourConsumerName,
      idleMs,
    );
  }

  /**
   * Publish a RAW event to a stream — a flat field/value list with no JSON
   * envelope, trimmed with `MAXLEN ~ <maxlen>`. This is the second sanctioned
   * wire format (ADR-0017 Category B): it matches shell producers like
   * `on-subagent-stop.sh` that XADD an `event`-discriminated flat field map,
   * so a TypeScript producer can write the identical shape without the
   * envelope that `publish()` wraps around every event.
   *
   * Still fans out via `this.wsRegistry.broadcast` so dashboard WS subscribers
   * receive the frame live, exactly as `publish()` does.
   *
   * @param stream - Stream key.
   * @param fields - Flat [k0, v0, k1, v1, ...] field list.
   * @param opts   - { maxlen } — XADD `MAXLEN ~` cap.
   * @returns The Redis message ID.
   */
  async publishRaw(
    stream: string,
    fields: string[],
    opts: { maxlen?: number } = {},
  ): Promise<string | null> {
    const { maxlen } = opts;
    const args: string[] =
      maxlen != null
        ? [stream, "MAXLEN", "~", String(maxlen), "*", ...fields]
        : [stream, "*", ...fields];
    const msgId = await this.publisher.xadd(...(args as [string, ...string[]]));

    // Broadcast the flat fields to connected WebSocket clients as a plain
    // key/value object so subscribers can pattern-match on the discriminator.
    const obj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    this.wsRegistry.broadcast(stream, obj);

    return msgId;
  }

  /**
   * Publish an enveloped event to a stream (ADR-0017 Category A wire format).
   *
   * @param stream - A live stream the bus owns (one of `STREAMS.*`).
   * @param event  - Must carry `{ type, source }`; `payload`/`correlationId`
   *                 optional.
   * @returns The Redis message ID.
   */
  async publish(stream: StreamKey, event: EventInput): Promise<string | null> {
    const envelope: EventEnvelope = {
      id: randomUUID(),
      type: event.type,
      source: event.source,
      timestamp: new Date().toISOString(),
      correlationId: event.correlationId || null,
      payload: JSON.stringify(event.payload || {}),
    };

    const msgId = await this.publisher.xadd(
      stream,
      "*",
      ...(Object.entries(envelope).flat() as string[])
    );

    // Broadcast to connected WebSocket clients with the parsed payload.
    this.wsRegistry.broadcast(stream, { ...envelope, payload: event.payload || {} });

    return msgId;
  }

  /**
   * Claim and process messages from a stream's consumer group.
   * @param stream    - Stream name
   * @param group     - Consumer group name
   * @param consumer  - Consumer name (unique per instance)
   * @param handler   - async (event) => void
   * @param opts      - { count, blockMs }
   */
  async consume(
    stream: string,
    group: string,
    consumer: string,
    handler: EventHandler,
    opts: ConsumeOptions = {},
  ): Promise<void> {
    const { count = 1, blockMs = 5000, reapStale = false } = opts;

    // Before reclaiming, sweep ZOMBIE consumers (issue #1221). Opt-in via
    // `reapStale` and gated to the PEL-loss-tolerant slot-events groups. This
    // must run BEFORE XAUTOCLAIM so reclamation scans ~1 consumer (this one),
    // not the hundreds an ungraceful-restart history would otherwise leave.
    if (reapStale) {
      await this.reapStaleConsumers(stream, group, consumer);
    }

    // First, reclaim pending messages from dead consumers via XAUTOCLAIM.
    // XREADGROUP with "0" only returns messages owned by THIS consumer,
    // missing messages orphaned by old consumers (e.g., after a restart).
    const MIN_IDLE_MS = 60_000; // claim messages idle > 1 minute
    try {
      let startId = "0-0";
      while (true) {
        // ioredis types XAUTOCLAIM's reply loosely; narrow at this seam to the
        // documented shape: [nextStartId, [[msgId, fields], ...], deletedIds].
        const result = (await this.subscriber.xautoclaim(
          stream, group, consumer, MIN_IDLE_MS, startId, "COUNT", 10
        )) as [string, RawStreamEntry[], ...unknown[]];
        const [nextId, claimed] = result;
        if (claimed.length === 0) break;

        for (const [msgId, fields] of claimed) {
          if (!fields || fields.length === 0) continue; // deleted message
          const event = this._parseFields(fields);
          try {
            console.log(`[EventBus] Reclaimed orphan ${event.type} on ${stream}/${group} (msg ${msgId})`);
            await handler(event);
            await this.subscriber.xack(stream, group, msgId);
          } catch (err: any) {
            await this._handleFailure(stream, group, msgId, event, err);
          }
        }
        if (nextId === "0-0") break;
        startId = nextId;
      }
    } catch (err: any) {
      console.error(`[EventBus] XAUTOCLAIM failed on ${stream}/${group}:`, err.message);
    }

    // Then listen for new messages
    this._consuming = true;
    while (this._consuming) {
      try {
        // XREADGROUP reply: [[streamName, [[msgId, fields], ...]], ...] | null.
        const result = (await this.subscriber.xreadgroup(
          "GROUP", group, consumer,
          "COUNT", count,
          "BLOCK", blockMs,
          "STREAMS", stream, ">"
        )) as [string, RawStreamEntry[]][] | null;
        if (!result) continue;

        for (const [msgId, fields] of result[0][1]) {
          const event = this._parseFields(fields);
          try {
            await handler(event);
            await this.subscriber.xack(stream, group, msgId);
          } catch (err: any) {
            await this._handleFailure(stream, group, msgId, event, err);
          }
        }
      } catch (err: any) {
        if (this._consuming) {
          console.error(`[EventBus] consume error on ${stream}/${group}:`, err.message);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  stopConsuming(): void {
    this._consuming = false;
  }

  /**
   * Best-effort DELCONSUMER of a single named consumer on graceful shutdown
   * (issue #1221). One-line delegator to the lifecycle Module's `delConsumer`;
   * kept on the class so the SIGTERM path in `src/index.ts` stays zero-diff.
   * See that function for the never-throw / SIGKILL-backstop contract.
   */
  async delConsumer(stream: string, group: string, consumer: string): Promise<void> {
    await lifecycleDelConsumer(this.publisher, stream, group, consumer);
  }

  async _handleFailure(
    stream: string,
    group: string,
    msgId: string,
    event: ConsumedEvent,
    err: Error,
  ): Promise<void> {
    console.error(`[EventBus] Handler failed for ${event.type}:`, err.message);

    // Check retry count via XPENDING
    const info = (await this.publisher.xpending(
      stream, group, msgId, msgId, 1,
    )) as [string, string, number, number][];
    const deliveryCount = info?.[0]?.[3] || 0;

    if (deliveryCount >= 3) {
      // Move to DLQ after 3 attempts
      await this.publish(STREAMS.DLQ, {
        type: NOTIFICATION_EVENT_TYPES.DLQ_ENTRY,
        source: "event-bus",
        payload: {
          originalStream: stream,
          originalGroup: group,
          originalEvent: event,
          error: err.message,
          deliveryCount,
        },
      });
      await this.publisher.xack(stream, group, msgId);
      console.error(`[EventBus] Moved ${event.type} to DLQ after ${deliveryCount} attempts`);
    }
  }

  _parseFields(fields: string[]): ConsumedEvent {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    if (typeof obj.payload === "string") {
      try { obj.payload = JSON.parse(obj.payload); } catch { /* intentional: payload may not be JSON, keep as raw string */ }
    }
    return obj;
  }

  /**
   * Read recent events from a stream (for status/history APIs).
   */
  async readRecent(stream: string, count: number = 10): Promise<(ConsumedEvent & { id: string })[]> {
    const raw = (await this.publisher.xrevrange(
      stream, "+", "-", "COUNT", count,
    )) as RawStreamEntry[];
    return raw.map(([id, fields]) => ({ id, ...this._parseFields(fields) }));
  }

  async getStreamInfo(stream: string): Promise<Record<string, unknown> | null> {
    try {
      const info = (await this.publisher.xinfo("STREAM", stream)) as unknown[];
      const parsed: Record<string, unknown> = {};
      for (let i = 0; i < info.length; i += 2) {
        parsed[info[i] as string] = info[i + 1];
      }
      return parsed;
    } catch (err: any) {
      console.error(`[EventBus] XINFO failed on ${stream} (stream missing or unexpected reply):`, err.message);
      return null;
    }
  }

  async close(): Promise<void> {
    this._consuming = false;
    closeRedisConnections();
  }
}

export { EventBus, STREAMS, RETAINED_STREAMS, CONSUMER_GROUPS };
