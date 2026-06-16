import type { WebSocket } from "ws";

/**
 * WsBroadcastRegistry — the in-process WebSocket client registry, extracted
 * out of `EventBus` (issue #1965).
 *
 * `EventBus` owns the Redis *stream* alphabet (publish/consume/consumer-group
 * lifecycle); WS broadcast is a *transport* concern with a different lifetime
 * (a plain `Set<WebSocket>`, no Redis connection), different test doubles (a
 * recording stub, not a fake ioredis), and different failure modes (a dead
 * socket vs a Redis disconnect). This Module concentrates that concern in one
 * place whose name describes its job: it owns the live `Set<WebSocket>`, the
 * add-on-connect / remove-on-close lifecycle, and the per-client fan-out.
 *
 * `EventBus` composes one of these in its constructor and delegates its
 * broadcast path to it; the slot-events bridge and recommendation engine
 * target this named surface instead of reaching `eventBus._broadcastToClients`
 * (the former private-by-convention method).
 */
export interface WsBroadcastRegistry {
  /**
   * Register a WebSocket client for event broadcasting. Removes the client on
   * `close`/`error` so the live set never accumulates dead sockets.
   */
  add(ws: WebSocket): void;

  /**
   * Broadcast an event to all connected, OPEN WebSocket clients under a stream
   * frame. `event` is any object — it is JSON-serialised verbatim under the
   * stream key, so callers may pass a concrete envelope interface without an
   * index signature. A no-op when no clients are connected.
   */
  broadcast(stream: string, event: object): void;

  /** Number of currently-registered clients. */
  readonly size: number;
}

/**
 * Build a `WsBroadcastRegistry` backed by a fresh `Set<WebSocket>`.
 */
export function makeWsBroadcastRegistry(): WsBroadcastRegistry {
  const clients = new Set<WebSocket>();

  return {
    add(ws: WebSocket): void {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
    },

    broadcast(stream: string, event: object): void {
      if (clients.size === 0) return;
      const message = JSON.stringify({ stream, ...event });
      for (const ws of clients) {
        if (ws.readyState === 1) {
          // WebSocket.OPEN
          ws.send(message);
        }
      }
    },

    get size(): number {
      return clients.size;
    },
  };
}
