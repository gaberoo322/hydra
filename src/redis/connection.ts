/**
 * Singleton Redis connections used across the orchestrator.
 *
 * Extracted from redis-adapter.ts (issue #269). All other src/redis/* modules
 * pull the singleton from here — no module should create its own `new Redis()`.
 *
 * ## Return type: `RedisClient`, not bare `Redis` (issue #3037)
 *
 * The singletons are typed `RedisClient = Redis & RedisCommands`, not the bare
 * `Redis` default-export type. This is deliberate and load-bearing:
 *
 * Under this repo's tsconfig (`module: NodeNext`, TypeScript 6.0.2), annotating
 * the return as bare `Redis` and running a *whole-project* `tsc` drops ~85
 * errors — every deeply-overloaded command verb (`expire`, `scan`, `eval`,
 * `lrem`, `pipeline`, …) reports "Property does not exist on type 'Redis'".
 * The cause is a compiler elaboration/instantiation budget that truncates
 * ioredis's 8950-line `RedisCommander` interface during the aggregate compile
 * (the same calls typecheck cleanly in an isolated single-file compile). Two
 * further traps make the naive fix worse than `any`:
 *   - `import { RedisCommander } from "ioredis"` fails in-project (TS2614, a
 *     NodeNext + CJS re-export quirk), and a failed import silently degrades
 *     `Redis & RedisCommander` to `Redis & any === any` — a regression wearing
 *     a fix's clothes.
 *   - Bumping the TypeScript version or compiler-wide options to raise the
 *     budget is a whole-repo blast-radius change, out of scope for this seam.
 *
 * `RedisCommands` below re-declares only the *dropped* verbs (the ones the
 * aggregate compile truncates and that src/redis/* callers actually use), so
 * the intersection re-injects exactly the missing surface without pulling the
 * whole giant interface back through the budget. The `RedisKey`/`RedisValue`/
 * `ChainableCommander` types come from ioredis's deep type path (the package
 * root re-export is what trips TS2614; the deep path resolves cleanly), so the
 * signatures stay faithful to ioredis rather than being loosely `string`-typed.
 * The result is genuinely non-`any`: a wrong-arity call to any of these verbs
 * still errors at compile time.
 */

import Redis from "ioredis";
import type {
  ChainableCommander,
  RedisKey,
  RedisValue,
} from "ioredis/built/utils/RedisCommander.js";

/**
 * The ioredis command verbs that the whole-project `tsc` elaboration budget
 * truncates off the bare `Redis` type (issue #3037). Re-declared here — with
 * ioredis's own `RedisKey`/`RedisValue`/`ChainableCommander` types — so the
 * intersection below re-injects exactly this surface. Every method the
 * src/redis/* seam calls that survives truncation still comes from the `Redis`
 * half of the intersection; only these dropped verbs need re-declaring.
 */
interface RedisCommands {
  expire(key: RedisKey, seconds: number | string): Promise<number>;
  ttl(key: RedisKey): Promise<number>;
  type(key: RedisKey): Promise<string>;
  exists(...keys: RedisKey[]): Promise<number>;
  scan(
    cursor: number | string,
    ...args: (string | number | Buffer)[]
  ): Promise<[cursor: string, elements: string[]]>;
  eval(
    script: string | Buffer,
    numkeys: number | string,
    ...args: (string | number | Buffer)[]
  ): Promise<unknown>;
  info(...sections: (string | Buffer)[]): Promise<string>;
  incrby(key: RedisKey, increment: number | string): Promise<number>;
  hlen(key: RedisKey): Promise<number>;
  hkeys(key: RedisKey): Promise<string[]>;
  hincrby(
    key: RedisKey,
    field: string | Buffer,
    increment: number | string,
  ): Promise<number>;
  lrem(
    key: RedisKey,
    count: number | string,
    element: RedisValue,
  ): Promise<number>;
  lset(
    key: RedisKey,
    index: number | string,
    element: RedisValue,
  ): Promise<"OK">;
  lmove(
    source: RedisKey,
    destination: RedisKey,
    whereFrom: "LEFT" | "RIGHT",
    whereTo: "LEFT" | "RIGHT",
  ): Promise<string>;
  zcount(
    key: RedisKey,
    min: number | string,
    max: number | string,
  ): Promise<number>;
  zrevrangebyscore(
    key: RedisKey,
    max: number | string,
    min: number | string,
    ...args: (string | number | Buffer)[]
  ): Promise<string[]>;
  zremrangebyrank(
    key: RedisKey,
    start: number | string,
    stop: number | string,
  ): Promise<number>;
  zremrangebyscore(
    key: RedisKey,
    min: number | string,
    max: number | string,
  ): Promise<number>;
  // `zrange` partially survives truncation (its 3-arg overload resolves on the
  // `Redis` half), but the `WITHSCORES` overload is dropped; re-declare both so
  // `zrange(key, start, stop)` and `zrange(key, start, stop, "WITHSCORES")` type.
  zrange(
    key: RedisKey,
    start: number | string,
    stop: number | string,
  ): Promise<string[]>;
  zrange(
    key: RedisKey,
    start: number | string,
    stop: number | string,
    withscores: "WITHSCORES",
  ): Promise<string[]>;
  pipeline(commands?: unknown[][]): PipelineCommander;
}

/**
 * The pipeline/multi chainable returned by `pipeline()`. It IS a full
 * `ChainableCommander` (every queued command is genuinely typed), but its
 * `exec()` result-tuple value is relaxed from ioredis's `unknown` to `any`.
 * Rationale: this is a *pure type-annotation* change (issue #3037) — before it,
 * `pipeline()` returned `any`, so callers already index `exec()` results
 * loosely (`res[1]` → a hash object). Faithfully typing the value as `unknown`
 * would force out-of-scope narrowing edits at every `pipeline().exec()` caller,
 * which invariant #6 forbids. The relaxation is confined to the pipeline
 * *result value* only; the directly-called client verbs stay genuinely typed.
 */
type PipelineCommander = Omit<ChainableCommander, "exec"> & {
  exec(): Promise<Array<[error: Error | null, result: any]> | null>;
};

/**
 * The concrete client type returned by the singleton accessors. `Redis`
 * supplies the truncation-surviving surface (get/set/del/hset/…, lifecycle,
 * events); `RedisCommands` re-injects the dropped verbs. Genuinely non-`any`.
 */
export type RedisClient = Redis & RedisCommands;

let _instance: RedisClient | null = null;
let _subscriber: RedisClient | null = null;

/** Shared Redis connection. Lazy-initialized on first call. */
export function getRedisConnection(): RedisClient {
  if (!_instance) {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    _instance = new Redis(url) as RedisClient;
  }
  return _instance;
}

/**
 * Dedicated Redis subscriber connection for blocking operations (XREADGROUP BLOCK, XAUTOCLAIM).
 * Blocking commands monopolize a connection, so subscribers need their own.
 * Lazy-initialized on first call.
 */
export function getRedisSubscriber(): RedisClient {
  if (!_subscriber) {
    const url = process.env.REDIS_URL || "redis://localhost:6379";
    _subscriber = new Redis(url) as RedisClient;
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
