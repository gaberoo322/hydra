// ---------------------------------------------------------------------------
// Stream-consume mechanics — the XAUTOCLAIM recovery pass, the XREADGROUP
// long-poll loop, the DLQ-promotion policy, the inbound field parser, and the
// zombie-consumer reaper as injectable, module-level free functions.
//
// These were previously defined inline in `event-bus.ts` (lifted there from
// the `EventBus` class body in #2455 / #1221 / #2340), where `event-bus.ts`
// also imported `ConsumerSession` from `consumer-session.ts` and
// `consumer-session.ts` imported these mechanics BACK from `event-bus.ts` — a
// bidirectional import cycle. Relocating the six stream-consume mechanics
// (`runAutoclaimRecovery`, `runLongPollLoop`, `promoteToDlqIfExhausted`,
// `parseStreamFields`, `shouldPromoteToDlq`, `getDeliveryCount`) plus the
// `reapStaleConsumers` zombie sweep that the same coordinator drives at startup
// into this leaf module makes the import graph acyclic: both `event-bus.ts` and
// `consumer-session.ts` now import DOWN from here, and this module imports
// nothing back from either (issue #2759).
//
// Each function takes a raw Redis client (plus an explicit config / callback
// surface) so the protocol is directly assertable with synthetic
// `RawStreamEntry[]` inputs and a stub client, no full bus instance required —
// the same testability the #2455 extraction established, now with the cycle
// removed. `EventBus` stays a thin coordinator that wires these into its own
// connections; its public method signatures are unchanged, and it re-exports
// the symbols other modules/tests already import from `event-bus.ts`.
// ---------------------------------------------------------------------------

import type Redis from "ioredis";

/**
 * A parsed inbound event handed to a `consume()` handler. `parseStreamFields`
 * folds the flat Redis field list back into an object and JSON-parses the
 * `payload` field when present, so handlers see a structured `payload`.
 * Exported (#2455) so callers of the stream-consume free functions can type
 * their synthetic event inputs.
 */
export interface ConsumedEvent {
  type?: string;
  source?: string;
  payload?: unknown;
  [field: string]: unknown;
}

/**
 * One raw stream entry as Redis returns it: `[msgId, [k0, v0, k1, v1, ...]]`.
 * The flat field list is what `parseStreamFields` folds back into an object.
 */
export type RawStreamEntry = [string, string[]];

/** A handler invoked with each parsed inbound event. */
export type EventHandler = (event: ConsumedEvent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Zombie-consumer reaper — folded in from event-bus-lifecycle.ts (#2340).
// ---------------------------------------------------------------------------

/**
 * The XINFO-CONSUMERS row shape after a flat field/value list is folded into an
 * object. Only `name`/`idle` matter to the reaper; the rest are passed through.
 */
export interface ParsedConsumerInfo {
  name?: unknown;
  idle?: unknown;
  [field: string]: unknown;
}

/** Folds a flat `[k0, v0, k1, v1, ...]` Redis field list into an object. */
export type FieldParser = (fields: string[]) => ParsedConsumerInfo;

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
