import type Redis from "ioredis";

/**
 * Event-bus consumer-group lifecycle, extracted out of `EventBus` (this issue;
 * mirrors the `WsBroadcastRegistry` extraction in issue #1965).
 *
 * `EventBus` owns the Redis *stream* alphabet (the hot publish/consume transport
 * path). Consumer-group lifecycle is a structurally separate, operational
 * concern: it runs exactly once each on process startup (`ensureConsumerGroup`
 * via `init()`) and graceful shutdown (`delConsumer` on SIGTERM), plus a
 * best-effort zombie sweep (`reapStaleConsumers`) at startup. None of it runs in
 * the hot consume loop, none of it depends on the bus's stream-topology
 * constants, and each function takes a raw `Redis` client so it is testable
 * without instantiating a full bus.
 *
 * These are the raw XGROUP / XINFO verbs the bus seam owns (ADR-0017 Category B:
 * the Event Bus is the sanctioned raw-connection owner). `EventBus` retains
 * one-line delegator methods that forward to these functions, so every existing
 * caller (`src/index.ts`, the slot-events bridge, the recs consumer, and the
 * tests) stays zero-diff while the implementation boundary sharpens.
 */

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
