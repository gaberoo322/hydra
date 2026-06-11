import { randomUUID } from "node:crypto";

import type Redis from "ioredis";
import type { WebSocket } from "ws";

import { getRedisConnection, getRedisSubscriber, closeRedisConnections } from "./redis/connection.ts";

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

// ---------------------------------------------------------------------------
// Notification event vocabulary — the typed `type` discriminator (issue #1182).
//
// `NOTIFICATION_EVENT_TYPES` is the SINGLE SOURCE OF TRUTH for every event
// type that flows on the `NOTIFICATIONS` (and internal `DLQ`) stream. It is a
// frozen `const` map — mirroring `STREAMS` above — so:
//
//   - `NotificationEventType` (below) is the closed union of its values.
//   - Every formatter that switches on the event type
//     (`notify.ts` formatMessage, `index.ts` formatAlertMessage + ALERT_TYPES,
//     `digest.ts` critical list) references these named members instead of raw
//     string literals. A typo on a member name is then a compile error, and
//     adding a new event type is a one-line edit here that surfaces every
//     affected formatter as a non-exhaustive switch / missing arm.
//
// The on-wire string values are UNCHANGED — this is a type-safety pass over the
// existing vocabulary, not a behaviour change.
// ---------------------------------------------------------------------------
const NOTIFICATION_EVENT_TYPES = {
  // --- Cycle lifecycle ---
  CYCLE_START: "cycle:start",
  CYCLE_COMPLETED: "cycle:completed",
  CYCLE_STALLED: "cycle:stalled",
  CYCLE_FAILED: "cycle:failed",
  CYCLE_AUTO_KILLED: "cycle:auto_killed",
  CYCLE_STALE_PRIORITIES: "cycle:stale_priorities",
  CYCLE_ROLLBACK: "cycle:rollback",
  CYCLE_ROLLBACK_FAILED: "cycle:rollback_failed",
  CYCLE_ROLLED_BACK: "cycle:rolled_back",
  CYCLE_OPERATOR_BLOCKED: "cycle:operator_blocked",

  // --- Task events ---
  TASK_REJECTED: "task:rejected",
  TASK_VERIFICATION_FAILED: "task:verification_failed",
  TASK_DRIFT_DETECTED: "task:drift_detected",
  TASK_MERGE_FAILED: "task:merge_failed",
  TASK_SHELVED: "task:shelved",

  // --- Scheduler ---
  SCHEDULER_STOPPED: "scheduler:stopped",
  SCHEDULER_BACKLOG_EMPTY: "scheduler:backlog_empty",
  SCHEDULER_PAUSED_REPETITION: "scheduler:paused_repetition",
  SCHEDULER_ERROR: "scheduler:error",

  // --- Research / Architect ---
  RESEARCH_COMPLETED: "research:completed",
  ARCHITECT_REVIEW_COMPLETED: "architect:review_completed",

  // --- Deploy ---
  DEPLOY_COMPLETED: "deploy:completed",
  DEPLOY_FAILED: "deploy:failed",

  // --- DLQ / consumer health ---
  DLQ_ALERT: "dlq:alert",
  DLQ_ENTRY: "dlq:entry",
  CONSUMER_DEAD: "consumer:dead",

  // --- Operator review pickup (issue #745) ---
  REVIEW_PICKUP_READY: "review:pickup_ready",

  // --- Learning-system pattern alerts ---
  PATTERN_LOW_MERGE_RATE: "pattern:low_merge_rate",
  PATTERN_CONSECUTIVE_FAILURES: "pattern:consecutive_failures",
  PATTERN_RECURRING_REGRESSIONS: "pattern:recurring_regressions",
  PATTERN_ANCHOR_STUCK: "pattern:anchor_stuck",
  PATTERN_TEST_DECLINE: "pattern:test_decline",
  PATTERN_HIGH_ABANDONMENT: "pattern:high_abandonment",
} as const;

/**
 * The closed union of every notification event type the bus vocabulary owns.
 * Derived from `NOTIFICATION_EVENT_TYPES` so the map is the only place a value
 * is declared.
 */
type NotificationEventType =
  (typeof NOTIFICATION_EVENT_TYPES)[keyof typeof NOTIFICATION_EVENT_TYPES];

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
  _wsClients: Set<WebSocket>;
  _consuming: boolean;
  constructor() {
    this.publisher = getRedisConnection();
    this.subscriber = getRedisSubscriber();
    this._wsClients = new Set();
    this._consuming = false;
  }

  /**
   * Register a WebSocket client for event broadcasting.
   */
  addWsClient(ws: WebSocket): void {
    this._wsClients.add(ws);
    ws.on("close", () => this._wsClients.delete(ws));
    ws.on("error", () => this._wsClients.delete(ws));
  }

  /**
   * Broadcast an event to all connected WebSocket clients.
   * Clients can subscribe to specific streams via { type: "subscribe", streams: [...] }.
   *
   * `event` is any object — it is JSON-serialised verbatim under the stream
   * frame, so callers (e.g. the slot-events bridge) may pass a concrete
   * envelope interface without an index signature.
   */
  _broadcastToClients(stream: string, event: object): void {
    if (this._wsClients.size === 0) return;
    const message = JSON.stringify({ stream, ...event });
    for (const ws of this._wsClients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(message);
      }
    }
  }

  async init(): Promise<this> {
    for (const [stream, groups] of Object.entries(CONSUMER_GROUPS)) {
      for (const group of groups) {
        await this.ensureConsumerGroup(stream, group, "0");
      }
    }
    return this;
  }

  /**
   * Idempotently create a consumer group on a stream (with MKSTREAM so the
   * stream is created if it does not yet exist). Swallows ONLY the BUSYGROUP
   * error (group already exists) — every other error is rethrown.
   *
   * `startId` controls where a freshly-created group begins reading:
   *   - "0"  → from the start of the stream (replay backlog; init() default).
   *   - "$"  → only new messages after creation (skip backlog).
   * Callers that need skip-backlog semantics (slot-events-bridge) MUST pass
   * "$" explicitly so the behaviour is not silently flipped.
   *
   * @param stream  - Stream key.
   * @param group   - Consumer group name.
   * @param startId - Group start position ("0" default | "$").
   */
  async ensureConsumerGroup(stream: string, group: string, startId: string = "0"): Promise<void> {
    try {
      await this.publisher.xgroup("CREATE", stream, group, startId, "MKSTREAM");
    } catch (err: any) {
      // BUSYGROUP = group already exists, which is fine.
      if (!err?.message?.includes("BUSYGROUP")) throw err;
    }
  }

  /**
   * Reap STALE (zombie) consumers from a consumer group via XINFO CONSUMERS +
   * DELCONSUMER (issue #1221). Each new process picks a fresh consumer name
   * (`<role>-${pid}`), so an ungraceful death (SIGKILL/crash) leaves the old
   * name registered forever; XAUTOCLAIM then re-scans a backlog that grows by
   * one zombie per restart, spamming reclaim loops. This sweep removes the
   * dead names so XAUTOCLAIM sees ~1 consumer, not hundreds.
   *
   * A consumer is reapable ONLY when BOTH hold:
   *   - `idle > idleMs` (default 5min) — far above the 5s blockMs poll. A live
   *     consumer blocked in XREADGROUP resets its idle clock to ~0 every 5s,
   *     so it can never cross a 5-min floor. This is the safeguard against
   *     reaping a live consumer mid-work; DO NOT lower it toward blockMs.
   *   - `name !== ourConsumerName` — never reap the consumer we just created
   *     (its idle clock can briefly read high before the first XREADGROUP).
   *
   * DELCONSUMER DROPS (does not transfer) the consumer's pending entries, so
   * this is only safe to call on groups that tolerate PEL loss — the
   * `$`-anchored slot-events groups (now-pixel-bridge, recs-engine) carrying
   * advisory/animation events. NEVER call it on the at-least-once
   * notifications / DLQ groups, whose PELs must survive a restart.
   *
   * Best-effort and never throws (fail-loud convention): a reaping failure
   * must not block consumer startup. Returns the names actually reaped (for
   * tests / logging).
   *
   * @param stream           - Stream key.
   * @param group            - Consumer group name.
   * @param ourConsumerName  - This instance's consumer name (never reaped).
   * @param idleMs           - Idle floor in ms (default 300_000 = 5min).
   * @returns Names of the consumers that were reaped.
   */
  async reapStaleConsumers(
    stream: string,
    group: string,
    ourConsumerName: string,
    idleMs: number = 300_000,
  ): Promise<string[]> {
    const reaped: string[] = [];
    try {
      // XINFO CONSUMERS reply: one array per consumer, a flat field/value
      // list including `name` (string) and `idle` (ms since last interaction).
      const consumers = (await this.publisher.xinfo(
        "CONSUMERS", stream, group,
      )) as unknown[];
      if (!Array.isArray(consumers)) return reaped;

      for (const entry of consumers) {
        const info = this._parseFields(entry as string[]);
        const name = typeof info.name === "string" ? info.name : null;
        const idle = Number(info.idle);
        if (!name || !Number.isFinite(idle)) continue;
        if (name === ourConsumerName) continue; // never reap ourselves
        if (idle <= idleMs) continue; // live (or recently active) — leave it

        try {
          await this.publisher.xgroup("DELCONSUMER", stream, group, name);
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
   * Publish a RAW event to a stream — a flat field/value list with no JSON
   * envelope, trimmed with `MAXLEN ~ <maxlen>`. This is the second sanctioned
   * wire format (ADR-0017 Category B): it matches shell producers like
   * `on-subagent-stop.sh` that XADD an `event`-discriminated flat field map,
   * so a TypeScript producer can write the identical shape without the
   * envelope that `publish()` wraps around every event.
   *
   * Still calls `_broadcastToClients` so dashboard WS subscribers receive the
   * frame live, exactly as `publish()` does.
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
    this._broadcastToClients(stream, obj);

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
    this._broadcastToClients(stream, { ...envelope, payload: event.payload || {} });

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
   * Best-effort DELCONSUMER of a single named consumer (issue #1221). Used by
   * the SIGTERM shutdown path to unregister this instance's own consumer name
   * on a graceful exit, so it never becomes a zombie the next process must
   * reap. Never throws — a shutdown reap failure must not block exit, and the
   * stateless startup `reapStaleConsumers()` sweep is the SIGKILL-safe backstop
   * if this best-effort cleanup is skipped. Keeps the raw Redis verb inside the
   * bus seam (CONTEXT.md: the bus owns consumer-group lifecycle).
   *
   * @param stream   - Stream key.
   * @param group    - Consumer group name.
   * @param consumer - Consumer name to remove.
   */
  async delConsumer(stream: string, group: string, consumer: string): Promise<void> {
    try {
      await this.publisher.xgroup("DELCONSUMER", stream, group, consumer);
    } catch (err: any) {
      console.error(
        `[EventBus] DELCONSUMER ${consumer} on ${stream}/${group} (shutdown) failed:`,
        err?.message || err,
      );
    }
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
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    this._consuming = false;
    closeRedisConnections();
  }
}

export { EventBus, STREAMS, RETAINED_STREAMS, CONSUMER_GROUPS, NOTIFICATION_EVENT_TYPES };
export type {
  StreamKey,
  NotificationEventType,
  EventInput,
  EventEnvelope,
  ConsumedEvent,
  EventHandler,
  ConsumeOptions,
};
