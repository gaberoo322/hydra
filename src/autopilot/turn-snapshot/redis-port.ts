/**
 * turn-snapshot/redis-port.ts — `TurnSnapshotRedis`, the narrow typed port the
 * Redis-backed Turn Snapshot collectors read (and, for the scout spend mirror,
 * write) through (ADR-0043 slice 5B, #4933).
 *
 * One method per Redis operation the strangled bash made through
 * `docker exec hydra-redis-1 redis-cli …`: the three anchor-queue `LLEN`s, the
 * scout calendar-walk and architecture-pass `GET`s, the scout token `HGET`, and
 * the `SET hydra:scout:spend:<DATE> <tokens> EX 604800` mirror (kept — a
 * behaviour-preserving move, ADR-0040 D6 / ADR-0043 D4). Tests hand the
 * collectors a fake; production routes every call through the typed accessors
 * in src/redis/ (never a raw client).
 *
 * FAIL-OPEN, BOUNDED: each call resolves to a `Classified` — `ok: false` on a
 * Redis error, an unreachable Redis, or a call slower than the timeout — which
 * the collectors render as the bash's fallback (`0` / an empty value). A down
 * Redis therefore costs at most one timeout per turn, never a hang, and
 * {@link TurnSnapshotRedis.close} disconnects so the CLI exits.
 */

import type { Classified } from "./collector.ts";
import { getSkillTokensRaw } from "../../redis/cost.ts";
import { getScoutLastCalendarWalk, setScoutSpendDaily } from "../../redis/scout.ts";
import {
  closeTurnSnapshotRedis,
  getAnchorQueueLength,
  getArchitectureLastRun,
  quietTurnSnapshotRedisErrors,
  type AnchorQueueName,
} from "../../redis/turn-snapshot.ts";

export type { AnchorQueueName } from "../../redis/turn-snapshot.ts";

/** The skill whose daily token spend the scout cost-cap mirrors (issue #532). */
export const SCOUT_SKILL = "hydra-tool-scout";

export interface TurnSnapshotRedis {
  anchorQueueLength(queue: AnchorQueueName): Promise<Classified<number>>;
  scoutLastCalendarWalk(): Promise<Classified<string | null>>;
  architectureLastRun(): Promise<Classified<string | null>>;
  /** `HGET hydra:metrics:tokens:by-skill:daily:<isoDate> hydra-tool-scout`. */
  scoutTokens(isoDate: string): Promise<Classified<string | null>>;
  /** `SET hydra:scout:spend:<isoDate> <value> EX <ttlSeconds>`. */
  mirrorScoutSpend(isoDate: string, value: string, ttlSeconds: number): Promise<Classified<true>>;
  /** Release the connection (a no-op when no call was made). */
  close(): void;
}

/** The raw operations under the production port (injectable so the bounding is testable without Redis). */
export interface TurnSnapshotRedisOps {
  anchorQueueLength(queue: AnchorQueueName): Promise<number>;
  scoutLastCalendarWalk(): Promise<string | null>;
  architectureLastRun(): Promise<string | null>;
  scoutTokens(isoDate: string): Promise<string | null>;
  mirrorScoutSpend(isoDate: string, value: string, ttlSeconds: number): Promise<void>;
  open(): void;
  close(): void;
}

/** The production ops: the src/redis typed accessors over the shared connection. */
export const accessorOps: TurnSnapshotRedisOps = {
  anchorQueueLength: getAnchorQueueLength,
  scoutLastCalendarWalk: getScoutLastCalendarWalk,
  architectureLastRun: getArchitectureLastRun,
  scoutTokens: (isoDate) => getSkillTokensRaw(isoDate, SCOUT_SKILL),
  mirrorScoutSpend: setScoutSpendDaily,
  open: () =>
    quietTurnSnapshotRedisErrors(() => {
      /* intentional: connection errors surface as each call's ok:false (rendered as the bash fallback); the bash kept stderr clean with 2>/dev/null */
    }),
  close: closeTurnSnapshotRedis,
};

/**
 * Per-call bound. A healthy local Redis answers in well under a millisecond;
 * a stopped one would otherwise hold each command in ioredis's offline queue
 * through its whole reconnect ladder (~10s+).
 */
export const TURN_SNAPSHOT_REDIS_TIMEOUT_MS = 3_000;

export interface TurnSnapshotRedisOptions {
  ops?: TurnSnapshotRedisOps;
  timeoutMs?: number;
}

export function createTurnSnapshotRedis(opts: TurnSnapshotRedisOptions = {}): TurnSnapshotRedis {
  const ops = opts.ops ?? accessorOps;
  const timeoutMs = opts.timeoutMs ?? TURN_SNAPSHOT_REDIS_TIMEOUT_MS;
  let opened = false;

  async function bounded<T>(call: () => Promise<T>): Promise<Classified<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!opened) {
        opened = true;
        ops.open();
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      return { ok: true, value: await Promise.race([call(), timeout]) };
    } catch (err) {
      /* intentional: a failed/slow Redis read is the typed ok:false arm — the collector renders today's fallback line */
      return { ok: false, reason: `redis: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    anchorQueueLength: (queue) => bounded(() => ops.anchorQueueLength(queue)),
    scoutLastCalendarWalk: () => bounded(() => ops.scoutLastCalendarWalk()),
    architectureLastRun: () => bounded(() => ops.architectureLastRun()),
    scoutTokens: (isoDate) => bounded(() => ops.scoutTokens(isoDate)),
    mirrorScoutSpend: (isoDate, value, ttlSeconds) =>
      bounded(async () => {
        await ops.mirrorScoutSpend(isoDate, value, ttlSeconds);
        return true as const;
      }),
    close() {
      if (opened) ops.close();
      opened = false;
    },
  };
}
