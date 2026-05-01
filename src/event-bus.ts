import Redis from "ioredis";
import { randomUUID } from "node:crypto";

import { redisKeys } from "./redis-keys.ts";

// Stream topology — V2 control loop
const STREAMS = {
  CYCLE: redisKeys.streamCycle(),        // cycle start events (used by cycle.mjs)
  TASKS: redisKeys.streamTasks(),        // task events (used by legacy pipeline if HYDRA_LEGACY_PIPELINE=1)
  META: redisKeys.streamMeta(),
  PROPOSALS: redisKeys.streamProposals(),
  NOTIFICATIONS: redisKeys.streamNotifications(),
  DLQ: redisKeys.streamDlq(),
};

// Consumer groups — only streams with active consumers
const CONSUMER_GROUPS = {
  [STREAMS.META]: ["meta"],
  [STREAMS.PROPOSALS]: ["orchestrator"],
  [STREAMS.NOTIFICATIONS]: ["telegram"],
  [STREAMS.DLQ]: ["dlq-processor"],
};

class EventBus {
  publisher: any;
  subscriber: any;
  redisUrl: string;
  _wsClients: Set<any>;
  _consuming: boolean;
  constructor(redisUrl = process.env.REDIS_URL || "redis://localhost:6379") {
    this.publisher = new Redis(redisUrl);
    this.subscriber = new Redis(redisUrl);
    this.redisUrl = redisUrl;
    this._wsClients = new Set();
  }

  /**
   * Register a WebSocket client for event broadcasting.
   * @param {WebSocket} ws - The WebSocket connection
   */
  addWsClient(ws) {
    this._wsClients.add(ws);
    ws.on("close", () => this._wsClients.delete(ws));
    ws.on("error", () => this._wsClients.delete(ws));
  }

  /**
   * Broadcast an event to all connected WebSocket clients.
   * Clients can subscribe to specific streams via { type: "subscribe", streams: [...] }.
   */
  _broadcastToClients(stream, event) {
    if (this._wsClients.size === 0) return;
    const message = JSON.stringify({ stream, ...event });
    for (const ws of this._wsClients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(message);
      }
    }
  }

  async init() {
    for (const [stream, groups] of Object.entries(CONSUMER_GROUPS)) {
      for (const group of groups) {
        try {
          await this.publisher.xgroup("CREATE", stream, group, "0", "MKSTREAM");
        } catch (err: any) {
          // BUSYGROUP = group already exists, which is fine
          if (!err.message.includes("BUSYGROUP")) throw err;
        }
      }
    }
    return this;
  }

  /**
   * Publish an event to a stream.
   * @param {string} stream - One of STREAMS.*
   * @param {object} event  - Must have { type, source, payload }
   * @returns {string} The Redis message ID
   */
  async publish(stream, event) {
    const envelope = {
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
      ...Object.entries(envelope).flat()
    );

    // Broadcast to connected WebSocket clients
    this._broadcastToClients(stream, { ...envelope, payload: event.payload || {} });

    return msgId;
  }

  /**
   * Claim and process messages from a stream's consumer group.
   * @param {string} stream    - Stream name
   * @param {string} group     - Consumer group name
   * @param {string} consumer  - Consumer name (unique per instance)
   * @param {function} handler - async (event) => void
   * @param {object} opts      - { count, blockMs }
   */
  async consume(stream, group, consumer, handler,  opts: Record<string, any> = {}) {
    const { count = 1, blockMs = 5000 } = opts;

    // First, reclaim pending messages from dead consumers via XAUTOCLAIM.
    // XREADGROUP with "0" only returns messages owned by THIS consumer,
    // missing messages orphaned by old consumers (e.g., after a restart).
    const MIN_IDLE_MS = 60_000; // claim messages idle > 1 minute
    try {
      let startId = "0-0";
      while (true) {
        const result = await this.subscriber.xautoclaim(
          stream, group, consumer, MIN_IDLE_MS, startId, "COUNT", 10
        );
        // result: [nextStartId, [[msgId, fields], ...], deletedIds]
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
        const result = await this.subscriber.xreadgroup(
          "GROUP", group, consumer,
          "COUNT", count,
          "BLOCK", blockMs,
          "STREAMS", stream, ">"
        );
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

  stopConsuming() {
    this._consuming = false;
  }

  async _handleFailure(stream, group, msgId, event, err) {
    console.error(`[EventBus] Handler failed for ${event.type}:`, err.message);

    // Check retry count via XPENDING
    const info = await this.publisher.xpending(stream, group, msgId, msgId, 1);
    const deliveryCount = info?.[0]?.[3] || 0;

    if (deliveryCount >= 3) {
      // Move to DLQ after 3 attempts
      await this.publish(STREAMS.DLQ, {
        type: "dlq:entry",
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

  _parseFields(fields) {
    const obj: Record<string, any> = {};
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    if (obj.payload) {
      try { obj.payload = JSON.parse(obj.payload); } catch {}
    }
    return obj;
  }

  /**
   * Read recent events from a stream (for status/history APIs).
   */
  async readRecent(stream, count = 10) {
    const raw = await this.publisher.xrevrange(stream, "+", "-", "COUNT", count);
    return raw.map(([id, fields]) => ({ id, ...this._parseFields(fields) }));
  }

  async getStreamInfo(stream) {
    try {
      const info = await this.publisher.xinfo("STREAM", stream);
      const parsed: Record<string, any> = {};
      for (let i = 0; i < info.length; i += 2) {
        parsed[info[i]] = info[i + 1];
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async close() {
    this._consuming = false;
    this.publisher.disconnect();
    this.subscriber.disconnect();
  }
}

export { EventBus, STREAMS, CONSUMER_GROUPS };
