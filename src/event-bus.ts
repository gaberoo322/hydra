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


// ---------------------------------------------------------------------------
// Consumer-group lifecycle — folded in from event-bus-lifecycle.ts (#2340).
//
// `EventBus` owns the Redis *stream* alphabet. Consumer-group lifecycle
// (XGROUP/XINFO setup, teardown, zombie reaping) was previously extracted into
// a sibling module (event-bus-lifecycle.ts) but is a single-production-caller
// seam — `event-bus.ts` was the only production consumer. Folding it back
// keeps "how does the bus set up its consumer groups?" answerable in one file.
// The function signatures and their "takes raw Redis client" testability are
// preserved so tests can exercise them without a full bus instance.
// ---------------------------------------------------------------------------

/**
 * The XINFO-CONSUMERS row shape after a flat field/value list is folded into an
 * object. Only `name`/`idle` matter to the reaper; the rest are passed through.
 */
interface ParsedConsumerInfo {
  name?: unknown;
  idle?: unknown;
  [field: string]: unknown;
}

/** Folds a flat `[k0, v0, k1, v1, ...]` Redis field list into an object. */
type FieldParser = (fields: string[]) => ParsedConsumerInfo;

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
 * Reap STALE (zombie) consumers from a consumer group via XINFO CONSUMERS +
 * DELCONSUMER (issue #1221). Each new process picks a fresh consumer name
 * (`<role>-${pid}`), so an ungraceful death (SIGKILL/crash) leaves the old name
 * registered forever; XAUTOCLAIM then re-scans a backlog that grows by one
 * zombie per restart, spamming reclaim loops. This sweep removes the dead names
 * so XAUTOCLAIM sees ~1 consumer, not hundreds.
 *
 * A consumer is reapable ONLY when BOTH hold:
 *   - `idle > idleMs` (default 5min) — far above the 5s blockMs poll. A live
 *     consumer blocked in XREADGROUP resets its idle clock to ~0 every 5s, so it
 *     can never cross a 5-min floor. This is the safeguard against reaping a
 *     live consumer mid-work; DO NOT lower it toward blockMs.
 *   - `name !== ourConsumerName` — never reap the consumer we just created (its
 *     idle clock can briefly read high before the first XREADGROUP).
 *
 * DELCONSUMER DROPS (does not transfer) the consumer's pending entries, so this
 * is only safe to call on groups that tolerate PEL loss — the `$`-anchored
 * slot-events groups (now-pixel-bridge, recs-engine) carrying advisory/animation
 * events. NEVER call it on the at-least-once notifications / DLQ groups, whose
 * PELs must survive a restart.
 *
 * Best-effort and never throws (fail-loud convention): a reaping failure must
 * not block consumer startup. Returns the names actually reaped (for
 * tests / logging).
 *
 * @param redis            - Redis client (the bus publisher).
 * @param parseFields      - Folds a flat XINFO row into `{ name, idle, ... }`
 *                           (the bus passes its own `_parseFields`).
 * @param stream           - Stream key.
 * @param group            - Consumer group name.
 * @param ourConsumerName  - This instance's consumer name (never reaped).
 * @param idleMs           - Idle floor in ms (default 300_000 = 5min).
 * @returns Names of the consumers that were reaped.
 */
export async function reapStaleConsumers(
  redis: Redis,
  parseFields: FieldParser,
  stream: string,
  group: string,
  ourConsumerName: string,
  idleMs: number = 300_000,
): Promise<string[]> {
  const reaped: string[] = [];
  try {
    // XINFO CONSUMERS reply: one array per consumer, a flat field/value list
    // including `name` (string) and `idle` (ms since last interaction).
    const consumers = (await redis.xinfo(
      "CONSUMERS", stream, group,
    )) as unknown[];
    if (!Array.isArray(consumers)) return reaped;

    for (const entry of consumers) {
      const info = parseFields(entry as string[]);
      const name = typeof info.name === "string" ? info.name : null;
      const idle = Number(info.idle);
      if (!name || !Number.isFinite(idle)) continue;
      if (name === ourConsumerName) continue; // never reap ourselves
      if (idle <= idleMs) continue; // live (or recently active) — leave it

      try {
        await redis.xgroup("DELCONSUMER", stream, group, name);
        reaped.push(name);
        console.log(
          `[EventBus] Reaped stale consumer ${name} on ${stream}/${group} (idle ${idle}ms)`,
        );
      } catch (err: any) {
        console.error(
          `[EventBus] DELCONSUMER ${name} on ${stream}/${group} failed:`,
          err?.message || err,
        );
      }
    }
  } catch (err: any) {
    console.error(
      `[EventBus] reapStaleConsumers failed on ${stream}/${group}:`,
      err?.message || err,
    );
  }
  return reaped;
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

/**
 * A parsed inbound event handed to a `consume()` handler. `parseStreamFields`
 * folds the flat Redis field list back into an object and JSON-parses the
 * `payload` field when present, so handlers see a structured `payload`.
 * Exported (#2455) so callers of the extracted stream-consume free functions
 * can type their synthetic event inputs.
 */
export interface ConsumedEvent {
  type?: string;
  source?: string;
  payload?: unknown;
  [field: string]: unknown;
}

type EventHandler = (event: ConsumedEvent) => void | Promise<void>;

/**
 * One raw stream entry as Redis returns it: `[msgId, [k0, v0, k1, v1, ...]]`.
 * The flat field list is what `parseStreamFields` folds back into an object.
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

// ---------------------------------------------------------------------------
// Stream-consume protocol — the XAUTOCLAIM recovery pass, the XREADGROUP
// long-poll loop, the DLQ-promotion policy, and the inbound field parser as
// injectable, module-level functions (issue #2455).
//
// These were previously folded inside the `EventBus.consume()` /
// `_handleFailure()` / `_parseFields()` class-body methods, where the
// stream-consume mechanics were threaded through class instance state
// (`_consuming`, `publisher`, `subscriber`) and could not be tested without a
// full bus instance. Lifting them to free functions that each take a raw Redis
// client (plus an explicit config / callback surface) follows the pattern the
// module's existing free functions already establish (`ensureConsumerGroup`,
// `reapStaleConsumers`, `initConsumerGroups`, `delConsumer`) and the pure
// assessment functions in `health/diagnostics.ts` — the protocol is now
// directly assertable with synthetic `RawStreamEntry[]` inputs and a stub
// client. `EventBus` becomes a thin coordinator that wires these into its own
// connections; its public method signatures are unchanged.
// ---------------------------------------------------------------------------

/**
 * Fold a flat Redis `[k0, v0, k1, v1, ...]` field list into a `ConsumedEvent`,
 * JSON-parsing the `payload` field when present (handlers see a structured
 * `payload`). Pure — no Redis, no side effects. A non-JSON `payload` is kept
 * as the raw string. (Issue #2455: lifted from `EventBus._parseFields`.)
 */
export function parseStreamFields(fields: string[]): ConsumedEvent {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  if (typeof obj.payload === "string") {
    try { obj.payload = JSON.parse(obj.payload); } catch { /* intentional: payload may not be JSON, keep as raw string */ }
  }
  return obj;
}

/** Delivery-count threshold after which a repeatedly-failing message is DLQ'd. */
const DLQ_PROMOTION_THRESHOLD = 3;

/**
 * The DLQ-promotion predicate (issue #2455): is a message that has now failed
 * `deliveryCount` times eligible for the dead-letter queue? Pure and directly
 * assertable — the "3 attempts → DLQ" invariant no longer requires a running
 * consumer loop to test. Extracted from the inline `deliveryCount >= 3` check
 * inside `_handleFailure`.
 */
export function shouldPromoteToDlq(deliveryCount: number): boolean {
  return deliveryCount >= DLQ_PROMOTION_THRESHOLD;
}

/**
 * A message's delivery count as recorded in the group's PEL — the 4th element
 * of an XPENDING summary row `[msgId, consumer, idleMs, deliveryCount]`. Reads
 * the secondary XPENDING query `_handleFailure` makes; returns 0 when the
 * message has no PEL entry. Best-effort caller decides on the count.
 *
 * @param redis  - Redis client (the bus publisher).
 * @param stream - Stream key.
 * @param group  - Consumer group name.
 * @param msgId  - The failed message ID.
 */
export async function getDeliveryCount(
  redis: Redis,
  stream: string,
  group: string,
  msgId: string,
): Promise<number> {
  const info = (await redis.xpending(
    stream, group, msgId, msgId, 1,
  )) as [string, string, number, number][];
  return info?.[0]?.[3] || 0;
}

/** How a failed message is forwarded onto the DLQ stream once exhausted. */
type DlqPublisher = (entry: {
  originalStream: string;
  originalGroup: string;
  originalEvent: ConsumedEvent;
  error: string;
  deliveryCount: number;
}) => Promise<unknown>;

/**
 * The DLQ-promotion policy (issue #2455): on a handler failure, query the
 * message's delivery count and, once it crosses the threshold, forward the
 * message onto the DLQ stream and ACK it off the source group. Below the
 * threshold the message is left in the PEL for a later redelivery. Concentrates
 * the "secondary XPENDING → threshold decision → DLQ publish → xack" path that
 * was spread across `_handleFailure` and inline class state.
 *
 * The DLQ publish is injected as `publishDlq` so the policy does not reach for
 * the bus's enveloped `publish()` — the caller (the `EventBus` coordinator)
 * wires its own DLQ writer, keeping this function testable with a stub.
 *
 * @param redis       - Redis client (the bus publisher).
 * @param stream      - Source stream key.
 * @param group       - Source consumer group.
 * @param msgId       - The failed message ID.
 * @param event       - The parsed event whose handler threw.
 * @param err         - The handler error.
 * @param publishDlq  - Forwards the exhausted entry onto the DLQ stream.
 * @returns Whether the message was promoted to the DLQ (and ACKed).
 */
export async function promoteToDlqIfExhausted(
  redis: Redis,
  stream: string,
  group: string,
  msgId: string,
  event: ConsumedEvent,
  err: Error,
  publishDlq: DlqPublisher,
): Promise<boolean> {
  console.error(`[EventBus] Handler failed for ${event.type}:`, err.message);

  const deliveryCount = await getDeliveryCount(redis, stream, group, msgId);
  if (!shouldPromoteToDlq(deliveryCount)) return false;

  await publishDlq({
    originalStream: stream,
    originalGroup: group,
    originalEvent: event,
    error: err.message,
    deliveryCount,
  });
  await redis.xack(stream, group, msgId);
  console.error(`[EventBus] Moved ${event.type} to DLQ after ${deliveryCount} attempts`);
  return true;
}

/** What `runAutoclaimRecovery` / `runLongPollLoop` do with each parsed event. */
interface ConsumeDeps {
  /** The handler the producer registered. */
  handler: EventHandler;
  /** ACK a successfully-processed message off the group's PEL. */
  ack: (msgId: string) => Promise<unknown>;
  /** Apply the DLQ-promotion policy to a handler failure. */
  onFailure: (msgId: string, event: ConsumedEvent, err: Error) => Promise<void>;
}

/** XAUTOCLAIM minimum idle: only reclaim messages idle longer than this (ms). */
const AUTOCLAIM_MIN_IDLE_MS = 60_000;

/**
 * The XAUTOCLAIM orphan-recovery pass (issue #2455): reclaim messages pending
 * on dead consumers and run each through the handler, ACKing on success and
 * deferring to the DLQ policy on failure. XREADGROUP with ">" only delivers
 * NEW messages, so without this pass a message orphaned by a crashed consumer
 * (its PEL entry) is never redelivered. Deleted messages surface with an empty
 * field list (`fields.length === 0`) and are short-circuited — the gap the
 * issue calls out as previously untested.
 *
 * Best-effort and never throws (fail-loud convention): a reclaim failure must
 * not block the long-poll loop that follows. Takes a raw Redis client so it is
 * testable with a stub XAUTOCLAIM reply, no full bus instance required.
 *
 * @param redis    - Redis client (the bus subscriber).
 * @param stream   - Stream key.
 * @param group    - Consumer group name.
 * @param consumer - This instance's consumer name.
 * @param deps     - handler / ack / onFailure wiring.
 */
export async function runAutoclaimRecovery(
  redis: Redis,
  stream: string,
  group: string,
  consumer: string,
  deps: ConsumeDeps,
): Promise<void> {
  try {
    let startId = "0-0";
    while (true) {
      // ioredis types XAUTOCLAIM's reply loosely; narrow at this seam to the
      // documented shape: [nextStartId, [[msgId, fields], ...], deletedIds].
      const result = (await redis.xautoclaim(
        stream, group, consumer, AUTOCLAIM_MIN_IDLE_MS, startId, "COUNT", 10
      )) as [string, RawStreamEntry[], ...unknown[]];
      const [nextId, claimed] = result;
      if (claimed.length === 0) break;

      for (const [msgId, fields] of claimed) {
        if (!fields || fields.length === 0) continue; // deleted message
        const event = parseStreamFields(fields);
        try {
          console.log(`[EventBus] Reclaimed orphan ${event.type} on ${stream}/${group} (msg ${msgId})`);
          await deps.handler(event);
          await deps.ack(msgId);
        } catch (err: any) {
          await deps.onFailure(msgId, event, err);
        }
      }
      if (nextId === "0-0") break;
      startId = nextId;
    }
  } catch (err: any) {
    console.error(`[EventBus] XAUTOCLAIM failed on ${stream}/${group}:`, err.message);
  }
}

/**
 * The XREADGROUP long-poll loop (issue #2455): block on new messages for the
 * group, run each through the handler, ACK on success and defer to the DLQ
 * policy on failure — looping while `isActive()` returns true. The active flag
 * is read through a callback (the bus reads its own `_consuming` instance flag)
 * so the loop owns no class state; `stopConsuming()` flips the flag and the
 * loop exits after its current BLOCK.
 *
 * Takes a raw Redis client so the loop is testable with a stub XREADGROUP reply
 * and a controllable `isActive` predicate, no full bus instance required.
 *
 * @param redis    - Redis client (the bus subscriber).
 * @param stream   - Stream key.
 * @param group    - Consumer group name.
 * @param consumer - This instance's consumer name.
 * @param opts     - { count, blockMs } poll tuning.
 * @param isActive - Read each iteration; the loop exits when it returns false.
 * @param deps     - handler / ack / onFailure wiring.
 */
export async function runLongPollLoop(
  redis: Redis,
  stream: string,
  group: string,
  consumer: string,
  opts: { count: number; blockMs: number },
  isActive: () => boolean,
  deps: ConsumeDeps,
): Promise<void> {
  const { count, blockMs } = opts;
  while (isActive()) {
    try {
      // XREADGROUP reply: [[streamName, [[msgId, fields], ...]], ...] | null.
      const result = (await redis.xreadgroup(
        "GROUP", group, consumer,
        "COUNT", count,
        "BLOCK", blockMs,
        "STREAMS", stream, ">"
      )) as [string, RawStreamEntry[]][] | null;
      if (!result) continue;

      for (const [msgId, fields] of result[0][1]) {
        const event = parseStreamFields(fields);
        try {
          await deps.handler(event);
          await deps.ack(msgId);
        } catch (err: any) {
          await deps.onFailure(msgId, event, err);
        }
      }
    } catch (err: any) {
      if (isActive()) {
        console.error(`[EventBus] consume error on ${stream}/${group}:`, err.message);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
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
    const { count = 1, blockMs = 5000, reapStale = false } = opts;

    // Before reclaiming, sweep ZOMBIE consumers (issue #1221). Opt-in via
    // `reapStale` and gated to the PEL-loss-tolerant slot-events groups. This
    // must run BEFORE XAUTOCLAIM so reclamation scans ~1 consumer (this one),
    // not the hundreds an ungraceful-restart history would otherwise leave.
    if (reapStale) {
      await this.reapStaleConsumers(stream, group, consumer);
    }

    // Wire the extracted stream-consume protocol (issue #2455) onto this
    // instance's connections: orphan recovery and the long-poll loop both run
    // through the same handler/ack/onFailure deps, so a message reclaimed from
    // a dead consumer and a freshly-delivered one follow the identical
    // success-ACK / failure-DLQ path.
    const deps: ConsumeDeps = {
      handler,
      ack: (msgId) => this.subscriber.xack(stream, group, msgId),
      onFailure: (msgId, event, err) => this._handleFailure(stream, group, msgId, event, err),
    };

    // First, reclaim pending messages from dead consumers via XAUTOCLAIM.
    // XREADGROUP with ">" only returns NEW messages, missing those orphaned by
    // old consumers (e.g., after a restart).
    await runAutoclaimRecovery(this.subscriber, stream, group, consumer, deps);

    // Then long-poll for new messages until stopConsuming() flips the flag.
    this._consuming = true;
    await runLongPollLoop(
      this.subscriber,
      stream,
      group,
      consumer,
      { count, blockMs },
      () => this._consuming,
      deps,
    );
  }

  stopConsuming(): void {
    this._consuming = false;
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
   * Apply the DLQ-promotion policy to a handler failure. Kept on the class so
   * the consume path stays zero-diff; wires the bus's enveloped `publish()` as
   * the DLQ writer. See `promoteToDlqIfExhausted` (module-level) for the
   * "secondary XPENDING → 3-attempt threshold → DLQ publish → xack" contract.
   */
  async _handleFailure(
    stream: string,
    group: string,
    msgId: string,
    event: ConsumedEvent,
    err: Error,
  ): Promise<void> {
    await promoteToDlqIfExhausted(
      this.publisher,
      stream,
      group,
      msgId,
      event,
      err,
      (entry) => this.publish(STREAMS.DLQ, {
        type: NOTIFICATION_EVENT_TYPES.DLQ_ENTRY,
        source: "event-bus",
        payload: entry,
      }),
    );
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
    this._consuming = false;
    closeRedisConnections();
  }
}

export { EventBus, STREAMS, RETAINED_STREAMS, CONSUMER_GROUPS };
