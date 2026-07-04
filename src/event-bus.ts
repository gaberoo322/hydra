import { randomUUID } from "node:crypto";

import type Redis from "ioredis";
import type { WebSocket } from "ws";

import { getRedisConnection, getRedisSubscriber, closeRedisConnections } from "./redis/connection.ts";
import { makeWsBroadcastRegistry, type WsBroadcastRegistry } from "./ws-broadcast-registry.ts";
// The notification event vocabulary lives in its own zero-Redis-side-effect Seam
// (issue #1985) so pure formatters can derive their event interfaces without
// pulling the Redis connection into scope. event-bus.ts imports the symbols BACK:
// `NOTIFICATION_EVENT_TYPES` is a runtime value (the DLQ_ENTRY type below), and
// `NotificationEventType` is the type `EventInput.type` widens from.
import { NOTIFICATION_EVENT_TYPES } from "./event-bus-vocabulary.ts";
import type { NotificationEventType } from "./event-bus-vocabulary.ts";
// The consumer open/stop/recover lifecycle (the former `consume()` coordinator,
// `_consuming` flag, `stopConsuming()`, and the `_handleFailure` DLQ delegator)
// was extracted into its own Seam (issue #2592). EventBus keeps a delegating
// `consume()`/`stopConsuming()` that forwards to a `ConsumerSession` running on
// this bus's connections, so all three production callers stay zero-diff and
// the bus remains the sole raw-stream (x*) owner (CONTEXT.md L186 / ADR-0017).
import { ConsumerSession, type ConsumerSessionOptions } from "./consumer-session.ts";
// The stream-consume mechanics (the XAUTOCLAIM recovery pass, the XREADGROUP
// long-poll loop, the DLQ-promotion policy, the inbound field parser) and the
// `reapStaleConsumers` zombie sweep were relocated into the leaf module
// `event-bus-mechanics.ts` (issue #2759) to break the bidirectional import
// cycle: `event-bus.ts` imports `ConsumerSession`, and `consumer-session.ts`
// imported these mechanics BACK from `event-bus.ts`. Both files now import DOWN
// from `event-bus-mechanics.ts`, so the graph is acyclic. `event-bus.ts`
// re-exports the symbols below so external callers/tests that already import
// them FROM `event-bus.ts` stay zero-diff.
import {
  reapStaleConsumers,
  parseStreamFields,
  shouldPromoteToDlq,
  getDeliveryCount,
  promoteToDlqIfExhausted,
  runAutoclaimRecovery,
  runLongPollLoop,
  type ConsumedEvent,
  type RawStreamEntry,
} from "./event-bus-mechanics.ts";


// ---------------------------------------------------------------------------
// Consumer-group lifecycle — folded in from event-bus-lifecycle.ts (#2340).
//
// `EventBus` owns the Redis *stream* alphabet. Consumer-group lifecycle
// (XGROUP/XINFO setup, teardown, zombie reaping) was previously extracted into
// a sibling module (event-bus-lifecycle.ts) but is a single-production-caller
// seam — `event-bus.ts` was the only production consumer. Folding it back
// keeps "how does the bus set up its consumer groups?" answerable in one file.
// The function signatures and their "takes raw Redis client" testability are
// preserved so tests can exercise them without a full bus instance. The
// `reapStaleConsumers` zombie sweep now lives in `event-bus-mechanics.ts`
// (issue #2759, imported above) alongside the stream-consume protocol, since
// `consumer-session.ts` drives it at consumer startup.
// ---------------------------------------------------------------------------

/**
 * Idempotently create a consumer group on a stream (with MKSTREAM so the stream
 * is created if it does not yet exist). Swallows ONLY the BUSYGROUP error (group
 * already exists) — every other error is rethrown.
 *
 * `startId` controls where a freshly-created group begins reading:
 *   - "0"  → from the start of the stream (replay backlog; init() default).
 *   - "$"  → only new messages after creation (skip backlog).
 * Callers that need skip-backlog semantics (slot-events-bridge) MUST pass "$"
 * explicitly so the behaviour is not silently flipped.
 *
 * @param redis   - Redis client (the bus publisher).
 * @param stream  - Stream key.
 * @param group   - Consumer group name.
 * @param startId - Group start position ("0" default | "$").
 */
export async function ensureConsumerGroup(
  redis: Redis,
  stream: string,
  group: string,
  startId: string = "0",
): Promise<void> {
  try {
    await redis.xgroup("CREATE", stream, group, startId, "MKSTREAM");
  } catch (err: any) {
    // BUSYGROUP = group already exists, which is fine.
    if (!err?.message?.includes("BUSYGROUP")) throw err;
  }
}

/**
 * Best-effort DELCONSUMER of a single named consumer (issue #1221). Used by the
 * SIGTERM shutdown path to unregister this instance's own consumer name on a
 * graceful exit, so it never becomes a zombie the next process must reap. Never
 * throws — a shutdown reap failure must not block exit, and the stateless
 * startup `reapStaleConsumers()` sweep is the SIGKILL-safe backstop if this
 * best-effort cleanup is skipped. Keeps the raw Redis verb inside the bus seam
 * (CONTEXT.md: the bus owns consumer-group lifecycle).
 *
 * @param redis    - Redis client (the bus publisher).
 * @param stream   - Stream key.
 * @param group    - Consumer group name.
 * @param consumer - Consumer name to remove.
 */
export async function delConsumer(
  redis: Redis,
  stream: string,
  group: string,
  consumer: string,
): Promise<void> {
  try {
    await redis.xgroup("DELCONSUMER", stream, group, consumer);
  } catch (err: any) {
    console.error(
      `[EventBus] DELCONSUMER ${consumer} on ${stream}/${group} (shutdown) failed:`,
      err?.message || err,
    );
  }
}

/**
 * Idempotently create every consumer group declared in `groups` (a
 * `{ stream: [group, ...] }` map). Called once at process startup by
 * `EventBus.init()`. Each group is created from "0" (replay backlog) — the
 * at-least-once notifications/DLQ groups want the backlog; the skip-backlog
 * "$"-anchored slot-events groups are created separately by their own bridges.
 *
 * @param redis  - Redis client (the bus publisher).
 * @param groups - `{ [streamKey]: groupName[] }` topology map.
 */
export async function initConsumerGroups(
  redis: Redis,
  groups: Record<string, string[]>,
): Promise<void> {
  for (const [stream, groupNames] of Object.entries(groups)) {
    for (const group of groupNames) {
      await ensureConsumerGroup(redis, stream, group, "0");
    }
  }
}

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

// `ConsumedEvent` (the parsed inbound event shape), `EventHandler`, and
// `RawStreamEntry` (one raw stream entry as Redis returns it) now live in
// `event-bus-mechanics.ts` (issue #2759) and are imported at the top of this
// file (and re-exported below for zero-diff external consumers).
type EventHandler = (event: ConsumedEvent) => void | Promise<void>;

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
  /**
   * The consumer open/stop/recover lifecycle, extracted into its own Seam
   * (issue #2592). Lazily created on the first `consume()` so instances built
   * via `Object.create(EventBus.prototype)` (transport-only tests) never pay
   * for a session they don't run. The session receives THIS bus's connections
   * as its transport — the bus stays the sole raw-stream (x*) owner.
   */
  private _session: ConsumerSession | null = null;
  constructor() {
    this.publisher = getRedisConnection();
    this.subscriber = getRedisSubscriber();
    this.wsRegistry = makeWsBroadcastRegistry();
  }

  /**
   * Lazily construct (and memoise) the `ConsumerSession` this bus delegates
   * its consume lifecycle to. The session runs on the bus's own
   * subscriber/publisher connections and wires the bus's enveloped
   * `publish(STREAMS.DLQ, …)` as the DLQ writer, so no raw-stream ownership
   * leaks out of the bus (CONTEXT.md L186 / ADR-0017 Category B).
   */
  private getSession(): ConsumerSession {
    if (!this._session) {
      this._session = new ConsumerSession({
        subscriber: this.subscriber,
        publisher: this.publisher,
        publishDlq: (entry) =>
          this.publish(STREAMS.DLQ, {
            type: NOTIFICATION_EVENT_TYPES.DLQ_ENTRY,
            source: "event-bus",
            payload: entry,
          }),
        parseFields: (fields) => this._parseFields(fields),
      });
    }
    return this._session;
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
   * Create every declared consumer group at startup. Group setup is an
   * operational bootstrap concern, not part of the bus's hot stream-transport
   * path.
   */
  async init(): Promise<this> {
    await initConsumerGroups(this.publisher, CONSUMER_GROUPS);
    return this;
  }

  /**
   * Idempotently create a consumer group on a stream. Kept on the class so
   * callers (slot-events bridge, recs consumer) stay zero-diff. See
   * `ensureConsumerGroup` (module-level) for the BUSYGROUP / startId semantics.
   */
  async ensureConsumerGroup(stream: string, group: string, startId: string = "0"): Promise<void> {
    await ensureConsumerGroup(this.publisher, stream, group, startId);
  }

  /**
   * Reap STALE (zombie) consumers from a consumer group (issue #1221). Passes
   * the bus's own `_parseFields` to fold the XINFO rows. See
   * `reapStaleConsumers` (module-level) for the full reap-safety contract.
   */
  async reapStaleConsumers(
    stream: string,
    group: string,
    ourConsumerName: string,
    idleMs: number = 300_000,
  ): Promise<string[]> {
    return reapStaleConsumers(
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
    // The open/stop/recover lifecycle lives in `ConsumerSession` (issue #2592).
    // This delegator keeps the caller signature zero-diff: it forwards to the
    // session running on this bus's connections. The `ConsumeOptions` /
    // `ConsumerSessionOptions` shapes are identical (count/blockMs/reapStale).
    await this.getSession().start(stream, group, consumer, handler, opts as ConsumerSessionOptions);
  }

  stopConsuming(): void {
    // No session yet means nothing to stop — never force a lazy construction.
    this._session?.stop();
  }

  /**
   * Best-effort DELCONSUMER of a single named consumer on graceful shutdown
   * (issue #1221). Kept on the class so the SIGTERM path in `src/index.ts`
   * stays zero-diff. See `delConsumer` (module-level) for the never-throw /
   * SIGKILL-backstop contract.
   */
  async delConsumer(stream: string, group: string, consumer: string): Promise<void> {
    await delConsumer(this.publisher, stream, group, consumer);
  }

  /**
   * Fold a flat Redis field list into a `ConsumedEvent`. Kept on the class so
   * `readRecent`/`reapStaleConsumers` callers stay zero-diff. See
   * `parseStreamFields` (module-level) for the JSON-payload contract.
   */
  _parseFields(fields: string[]): ConsumedEvent {
    return parseStreamFields(fields);
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
    // Stop the consume loop before dropping the connections. `stopConsuming()`
    // is a no-op when no session was ever opened (transport-only usage).
    this.stopConsuming();
    closeRedisConnections();
  }
}

export { EventBus, STREAMS, RETAINED_STREAMS, CONSUMER_GROUPS };

// Re-export the stream-consume mechanics relocated to `event-bus-mechanics.ts`
// (issue #2759) so callers/tests that already import them FROM `event-bus.ts`
// (test/event-bus.test.mts, test/event-bus-lifecycle.test.mts) stay zero-diff.
export {
  reapStaleConsumers,
  parseStreamFields,
  shouldPromoteToDlq,
  getDeliveryCount,
  promoteToDlqIfExhausted,
  runAutoclaimRecovery,
  runLongPollLoop,
};
export type { ConsumedEvent };
