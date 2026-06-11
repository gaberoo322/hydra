/**
 * Shared Redis test-isolation backstop (issue #1231; per-run convention #1676).
 *
 * The full `npm test` suite runs with `--test-concurrency=1` (serial *files*,
 * node v22), so the primary isolation guarantee is already in place: each
 * test file runs start-to-finish before the next begins, and every Redis-
 * touching file pins `REDIS_URL` to a NON-ZERO logical DB so production DB-0
 * is never touched.
 *
 * Per-RUN isolation (issue #1676): `npm test` routes through the launcher
 * scripts/test/redis-db-launch.mjs, which sets REDIS_URL once per run to a
 * stable per-worktree DB index inside 2..15 (and FLUSHDBs it at run start).
 * Every test file defers to that env value via the
 * `process.env.REDIS_URL = process.env.REDIS_URL ?? "...1"` pin, so two
 * worktrees running `npm test` concurrently land in different logical DBs
 * and can no longer wipe each other's fixtures mid-test. The DB-1 literal in
 * the pins (and in TEST_REDIS_URL below) is only the fallback for direct
 * single-file `node --test --test-force-exit <file>` invocations that bypass
 * the launcher.
 *
 * The residual hazard this helper guards against is a file that only cleans
 * its keyspace in `after()` (or cleans specific keys per-test) rather than
 * establishing a *clean* keyspace in `beforeEach`. Under serial ordering a
 * prior file's leftover `hydra:*` keys cannot be wiped mid-run, but a file
 * that assumes an empty keyspace at the top of each test can still read a
 * stale fixture left by an earlier test *within the same file* (or by a prior
 * file that crashed before its `after()` ran). This helper wraps the canonical
 * "select a non-zero DB, then `keys(hydra:*) + del` in `beforeEach`" pattern so
 * such files get a deterministically clean keyspace without each re-deriving
 * it.
 *
 * Deliberately NOT the primary fix: the design-concept for #1231 rejected
 * per-file unique DB allocation (only 16 logical DBs exist; ~28 DB-1 files)
 * and a speculative key-prefix namespace (ADR-0014 simplicity). This is an
 * opt-in backstop for the `after()`-cleaning minority, nothing more.
 *
 * No new runtime dependency (ADR-0005): node stdlib + the already-approved
 * `ioredis`, driven entirely through the test's own `REDIS_URL` seam.
 */

import { beforeEach, after } from "node:test";
import Redis from "ioredis";

/**
 * The strict ioredis `Redis` static type in this tsconfig does not expose the
 * full dynamic command surface (`exists`, spread-arg `del`, etc.), so the rest
 * of the Redis-touching test suite types its client as `any` (e.g.
 * test/holdback.test.mts, test/agent-stream-correlation.test.mts). We mirror
 * that convention with a single named alias so the intent is explicit rather
 * than a bare `any` scattered through the file.
 */
type RedisClient = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Defers to the env value — under `npm test` that is the per-run DB index the
 * launcher (scripts/test/redis-db-launch.mjs, #1676) derived for this
 * worktree. A non-zero DB index is the invariant that keeps production DB-0
 * untouched; the DB-1 literal is only the fallback for direct single-file
 * `node --test` invocations that bypass the launcher.
 */
export const TEST_REDIS_URL =
  process.env.REDIS_URL ?? "redis://localhost:6379/1";

/**
 * A test-owned ioredis client + a guard flag describing whether Redis is
 * reachable. Tests that want to skip cleanly when Redis is down can read
 * `up` inside a `t.skip(...)` guard, mirroring the suite's existing pattern.
 */
export interface RedisDbHandle {
  /** The ioredis client, or null if construction failed. */
  readonly client: RedisClient | null;
  /** True once a `ping()` succeeded — false means Redis is unreachable. */
  readonly up: boolean;
}

/**
 * Refuse to point a test at production DB-0. Every test file MUST pin a
 * non-zero DB (under `npm test` the per-run launcher provides one in 2..15);
 * this is the last line of defence for the "DB-0 is never touched by any
 * test" invariant (#1231, extended per-run by #1676).
 */
function assertNonZeroDb(url: string): void {
  // redis://host:port/<db> — the path segment after the last `/` is the DB.
  const dbSegment = url.split("/").pop() ?? "";
  if (dbSegment === "0" || dbSegment === "") {
    throw new Error(
      `[test/_helpers/redis-db] refusing to run against ${url}: tests must ` +
        `pin a non-zero Redis DB so production DB-0 is never touched (#1231).`,
    );
  }
}

/**
 * Install a `beforeEach` hook that wipes all `hydra:*` keys on a non-zero DB,
 * giving every test in the calling file a clean keyspace, plus an `after`
 * hook that closes the connection. Returns a handle the caller can consult to
 * skip cleanly when Redis is unreachable.
 *
 * Usage (inside a `describe`, at the top):
 *
 *     const db = useCleanRedisDb();
 *     test("...", (t) => {
 *       if (!db.up) return t.skip("Redis unavailable");
 *       // ... keyspace is guaranteed clean here ...
 *     });
 *
 * @param keyPattern glob of keys to clear in `beforeEach` (default `hydra:*`).
 *                   Narrow it if a file shares a DB-1 keyspace with fixtures it
 *                   must NOT delete.
 */
export function useCleanRedisDb(keyPattern = "hydra:*"): RedisDbHandle {
  assertNonZeroDb(TEST_REDIS_URL);

  // Mutable backing fields; the returned handle exposes them read-only.
  const state: { client: RedisClient | null; up: boolean } = {
    client: null,
    up: false,
  };

  beforeEach(async () => {
    if (!state.client) {
      try {
        // Single-string-arg overload (`new Redis(url)`) — matches the rest of
        // the suite and dodges the TS2345 the (url, options) form triggers
        // under the #750 ratchet.
        state.client = new Redis(TEST_REDIS_URL);
        await state.client.ping();
        state.up = true;
      } catch {
        // Redis unreachable — degrade to skip-friendly. Callers read `up`.
        state.up = false;
        return;
      }
    }
    if (!state.up || !state.client) return;
    // Wipe the file's keyspace so each test starts clean. Serial-files means
    // this cannot race another file; it only clears THIS file's leftovers.
    const keys = await state.client.keys(keyPattern);
    if (keys.length > 0) await state.client.del(...keys);
  });

  after(async () => {
    if (state.client) {
      try {
        await state.client.quit();
      } catch {
        /* intentional: best-effort close on teardown */
      }
      state.client = null;
    }
  });

  return {
    get client() {
      return state.client;
    },
    get up() {
      return state.up;
    },
  };
}
