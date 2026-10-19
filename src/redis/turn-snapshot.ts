/**
 * Turn Snapshot Redis seam (ADR-0043 slice 5B, issue #4933).
 *
 * The typed accessors for the Redis reads the per-turn Turn Snapshot CLI
 * (scripts/autopilot/turn-snapshot.ts) makes that no other domain module
 * already owns — the three anchor-queue lengths and the architecture-pass
 * stamp — plus the CLI-process lifecycle around the shared connection. The
 * scout reads/write reuse src/redis/scout.ts and src/redis/cost.ts.
 *
 * Lifecycle: the CLI is a one-shot process, so {@link quietTurnSnapshotRedisErrors}
 * attaches an error listener (ioredis otherwise prints "Unhandled error event"
 * to stderr on every failed reconnect while Redis is down — the strangled bash
 * kept its stderr clean with `2>/dev/null`), and {@link closeTurnSnapshotRedis}
 * disconnects so the process can exit. Bounding each call is the caller's job
 * (src/autopilot/turn-snapshot/redis-port.ts).
 */

import { closeRedisConnections, getRedisConnection } from "./connection.ts";
import { redisKeys } from "./keys.ts";
import { getString, listLen } from "./kv.ts";

/** The anchor queues the Turn Snapshot reports a depth for. */
export type AnchorQueueName = "work-queue" | "reframe-queue" | "prior-failures";

const ANCHOR_QUEUE_KEYS: Record<AnchorQueueName, () => string> = {
  "work-queue": redisKeys.anchorWorkQueue,
  "reframe-queue": redisKeys.anchorReframeQueue,
  "prior-failures": redisKeys.anchorPriorFailures,
};

/** `LLEN` of one anchor queue (0 when the key is absent). */
export async function getAnchorQueueLength(queue: AnchorQueueName): Promise<number> {
  return listLen(ANCHOR_QUEUE_KEYS[queue]());
}

/** The last architecture_orch pass stamp, or null when unset. */
export async function getArchitectureLastRun(): Promise<string | null> {
  return getString(redisKeys.architectureLastRun());
}

let quieted = false;

/**
 * Route the shared connection's `error` events to `onError` instead of
 * ioredis's default stderr print. Idempotent. Only the one-shot CLI calls this.
 */
export function quietTurnSnapshotRedisErrors(onError: (err: Error) => void): void {
  if (quieted) return;
  quieted = true;
  getRedisConnection().on("error", onError);
}

/** Disconnect the shared connections so the one-shot CLI can exit. */
export function closeTurnSnapshotRedis(): void {
  closeRedisConnections();
  quieted = false;
}
