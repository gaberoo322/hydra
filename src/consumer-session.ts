// ---------------------------------------------------------------------------
// ConsumerSession — the open/stop/recover lifecycle of a single stream
// consumer, extracted from EventBus (issue #2592).
//
// EventBus owns the raw Redis *stream* (x*) seam and the Event Bus alphabet
// (CONTEXT.md L186 / ADR-0017 Category B). A running consumer is a distinct
// concern: it has an open → recover-orphans → long-poll → stop lifecycle that
// is separate from the transport it runs on. Before this extraction that
// lifecycle lived as the `EventBus.consume()` coordinator, the `_consuming`
// boolean, `stopConsuming()`, and the `_handleFailure` DLQ delegator — so the
// only way to observe "start a consumer and watch its recovery" was to build a
// full EventBus (`Object.create(EventBus.prototype)` class-surgery in tests).
//
// #2455 already lifted the stream-consume MECHANICS (runAutoclaimRecovery,
// runLongPollLoop, promoteToDlqIfExhausted, getDeliveryCount, parseStreamFields)
// into module-level free functions taking a raw Redis client. What remained
// coupled inside EventBus was only the thin COORDINATOR that wires those free
// functions into a lifecycle. This module lifts exactly that coordinator.
//
// ConsumerSession opens NO Redis connection of its own — it receives the
// transport (a subscriber for the autoclaim/long-poll reads + ack, a publisher
// for the secondary XPENDING delivery-count read, and a DLQ-publish callback)
// as an injected dependency. EventBus stays the sole raw-stream owner and keeps
// a delegating `consume()`/`stopConsuming()` so all three production callers
// (notification-consumer, slot-events-bridge, recommendation-consumer) stay
// zero-diff — the extraction is source-compatible.
// ---------------------------------------------------------------------------

import type Redis from "ioredis";

import {
  reapStaleConsumers,
  runAutoclaimRecovery,
  runLongPollLoop,
  promoteToDlqIfExhausted,
  parseStreamFields,
  type ConsumedEvent,
} from "./event-bus.ts";

/** The handler a producer registers for each consumed event. */
export type ConsumerSessionHandler = (
  event: ConsumedEvent,
) => void | Promise<void>;

/** Options for the long-poll consume loop (mirrors the former ConsumeOptions). */
export interface ConsumerSessionOptions {
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

/**
 * How a failed message is forwarded onto the DLQ stream once it has exhausted
 * its delivery attempts. The transport (EventBus) wires its own enveloped
 * `publish(STREAMS.DLQ, …)` so this session holds no knowledge of the DLQ
 * stream key or the envelope shape — it only knows "forward the exhausted
 * entry".
 */
export type ConsumerSessionDlqPublisher = (entry: {
  originalStream: string;
  originalGroup: string;
  originalEvent: ConsumedEvent;
  error: string;
  deliveryCount: number;
}) => Promise<unknown>;

/**
 * The transport a `ConsumerSession` runs on — injected, never opened by the
 * session (EventBus stays the sole raw-stream owner, CONTEXT.md L186 /
 * ADR-0017 Category B).
 *
 *   - `subscriber` — the Redis connection the autoclaim recovery + long-poll
 *     loop read and ack through (the bus's `subscriber`).
 *   - `publisher` — the Redis connection the DLQ-promotion policy makes its
 *     secondary XPENDING delivery-count read through (the bus's `publisher`).
 *   - `publishDlq` — forwards an exhausted entry onto the DLQ stream; the
 *     transport wires its own enveloped publish so the session does not reach
 *     for the DLQ stream key.
 *   - `parseFields` — folds a flat Redis field list into a `ConsumedEvent`.
 *     Injectable (defaults to the module-level `parseStreamFields`) so the
 *     transport can pass its own delegator and tests can stub it.
 */
export interface ConsumerTransport {
  subscriber: Redis;
  publisher: Redis;
  publishDlq: ConsumerSessionDlqPublisher;
  parseFields?: (fields: string[]) => ConsumedEvent;
}

/**
 * A single stream consumer's open/stop/recover lifecycle. Construct with the
 * transport it runs on, then `start()` to open the consumer (optional
 * reapStale sweep → XAUTOCLAIM orphan recovery → long-poll loop) and `stop()`
 * to flip the active flag so the loop exits after its current BLOCK.
 *
 * The private `_consuming` flag is the shared mutable state the long-poll
 * loop reads through its `isActive` callback and `stop()` flips — the exact
 * lifecycle state the extraction makes independently observable. Exposed
 * read-only via `isConsuming()` for assertions.
 */
export class ConsumerSession {
  private readonly transport: ConsumerTransport;
  private _consuming = false;

  constructor(transport: ConsumerTransport) {
    this.transport = transport;
  }

  /** Whether the long-poll loop is currently active. */
  isConsuming(): boolean {
    return this._consuming;
  }

  /**
   * Open the consumer and run it until `stop()` is called. Ordering is
   * preserved exactly from the former `EventBus.consume()` coordinator:
   *   1. optional reapStale sweep (gated to PEL-loss-tolerant groups),
   *   2. XAUTOCLAIM orphan recovery (reclaim messages from dead consumers),
   *   3. set `_consuming = true`,
   *   4. XREADGROUP long-poll loop gated on `isActive` (`() => _consuming`).
   *
   * Orphan recovery and the long-poll loop run through the SAME
   * handler/ack/onFailure deps, so a reclaimed orphan and a fresh delivery
   * follow the identical success-ACK / failure-DLQ path.
   *
   * @param stream   - Stream name.
   * @param group    - Consumer group name.
   * @param consumer - Consumer name (unique per instance).
   * @param handler  - async (event) => void.
   * @param opts     - { count, blockMs, reapStale }.
   */
  async start(
    stream: string,
    group: string,
    consumer: string,
    handler: ConsumerSessionHandler,
    opts: ConsumerSessionOptions = {},
  ): Promise<void> {
    const { count = 1, blockMs = 5000, reapStale = false } = opts;
    const parseFields = this.transport.parseFields ?? parseStreamFields;

    // Before reclaiming, sweep ZOMBIE consumers (issue #1221). Opt-in via
    // `reapStale` and gated to the PEL-loss-tolerant slot-events groups. This
    // must run BEFORE XAUTOCLAIM so reclamation scans ~1 consumer (this one),
    // not the hundreds an ungraceful-restart history would otherwise leave.
    if (reapStale) {
      await reapStaleConsumers(this.transport.publisher, parseFields, stream, group, consumer);
    }

    // Wire the extracted stream-consume protocol (issue #2455) onto the
    // injected transport: orphan recovery and the long-poll loop both run
    // through the same handler/ack/onFailure deps.
    const deps = {
      handler,
      ack: (msgId: string) => this.transport.subscriber.xack(stream, group, msgId),
      onFailure: (msgId: string, event: ConsumedEvent, err: Error) =>
        this._handleFailure(stream, group, msgId, event, err),
    };

    // First, reclaim pending messages from dead consumers via XAUTOCLAIM.
    // XREADGROUP with ">" only returns NEW messages, missing those orphaned by
    // old consumers (e.g., after a restart).
    await runAutoclaimRecovery(this.transport.subscriber, stream, group, consumer, deps);

    // Then long-poll for new messages until stop() flips the flag.
    this._consuming = true;
    await runLongPollLoop(
      this.transport.subscriber,
      stream,
      group,
      consumer,
      { count, blockMs },
      () => this._consuming,
      deps,
    );
  }

  /** Flip the active flag; the long-poll loop exits after its current BLOCK. */
  stop(): void {
    this._consuming = false;
  }

  /**
   * Apply the DLQ-promotion policy to a handler failure. Wires the transport's
   * injected `publishDlq` as the DLQ writer. See `promoteToDlqIfExhausted`
   * (event-bus.ts) for the "secondary XPENDING → 3-attempt threshold → DLQ
   * publish → xack" contract.
   */
  private async _handleFailure(
    stream: string,
    group: string,
    msgId: string,
    event: ConsumedEvent,
    err: Error,
  ): Promise<void> {
    await promoteToDlqIfExhausted(
      this.transport.publisher,
      stream,
      group,
      msgId,
      event,
      err,
      this.transport.publishDlq,
    );
  }
}
