/**
 * Singleton Redis connections used across the orchestrator.
 *
 * Extracted from redis-adapter.ts (issue #269). All other src/redis/* modules
 * pull the singleton from here — no module should create its own `new Redis()`.
 */

import Redis from "ioredis";
import { redisKeys } from "../redis-keys.ts";

let _instance: any = null;
let _subscriber: any = null;

/** Shared Redis connection. Lazy-initialized on first call. */
export function getRedisConnection(): any {
  if (!_instance) {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    _instance = new Redis(url);
  }
  return _instance;
}

/**
 * Dedicated Redis subscriber connection for blocking operations (XREADGROUP BLOCK, XAUTOCLAIM).
 * Blocking commands monopolize a connection, so subscribers need their own.
 * Lazy-initialized on first call.
 */
export function getRedisSubscriber(): any {
  if (!_subscriber) {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    _subscriber = new Redis(url);
  }
  return _subscriber;
}

/**
 * Close all Redis connections managed by the adapter.
 * Call during graceful shutdown.
 */
export function closeRedisConnections(): void {
  if (_instance) {
    _instance.disconnect();
    _instance = null;
  }
  if (_subscriber) {
    _subscriber.disconnect();
    _subscriber = null;
  }
}

// ---------------------------------------------------------------------------
// Workspace lock (lives here because it predates the lock-domain split and is
// tightly coupled to connection lifecycle)
// ---------------------------------------------------------------------------

/**
 * Acquire the workspace lock (NX + 60s TTL).
 * Returns true if lock was acquired, false if already held.
 */
export async function acquireWorkspaceLock(pid: number): Promise<boolean> {
  const r = getRedisConnection();
  const result = await r.set(redisKeys.workspaceLock(), `${pid}`, "NX", "EX", 60);
  return result === "OK";
}

/** Release the workspace lock. */
export async function releaseWorkspaceLock(): Promise<void> {
  const r = getRedisConnection();
  await r.del(redisKeys.workspaceLock());
}
