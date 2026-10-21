/**
 * The Redis DB this `npm test` run OWNS (issue #5062).
 *
 * scripts/test/redis-db-launch.mjs exports the run's isolated DB index as
 * HYDRA_REDIS_DB. Tests that need a non-zero DB must use that value, never a
 * literal from the launcher's pool: a concurrent run owns every other index
 * and FLUSHDBs it mid-assertion. One shared parse (watchdog tests + shim) so
 * the rule cannot drift between call sites.
 */

/** The owned DB index as a string, or null when the launcher assigned none. */
export function ownedRedisDb(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.HYDRA_REDIS_DB ?? "";
  // The launcher already validated pool membership when it exported this; only
  // reject what is not a usable non-zero index (db 0 is never an owned DB).
  return /^[1-9]\d*$/.test(raw) ? raw : null;
}

/**
 * Skip option for tests that need an owned DB. Skips (with a reason) only when
 * no owned DB is legitimately expected: a bare `node --test` or a remote
 * REDIS_URL. On a full-suite local-launcher run (HYDRA_FULL_SUITE=1) a missing
 * owned DB is a launcher regression, so this returns false and the test body
 * must `assert.ok(owned)` so the coverage loss fails loudly instead of skipping.
 */
export function ownedDbSkip(owned: string | null, env: NodeJS.ProcessEnv = process.env): string | false {
  if (owned !== null) return false;
  const url = env.REDIS_URL ?? "";
  const local = url === "" || /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
  if (env.HYDRA_FULL_SUITE === "1" && local) return false;
  return "launcher assigned no owned HYDRA_REDIS_DB (remote REDIS_URL or bare node --test)";
}

/** The run's owned DB and its skip decision, resolved together for every call site. */
export interface OwnedDbContext {
  /** The owned DB index ({@link ownedRedisDb}), or null when the launcher assigned none. */
  db: string | null;
  /** The {@link ownedDbSkip} verdict: a skip reason, or false (run, and fail loudly if `db` is null). */
  skip: string | false;
}

/**
 * {@link ownedRedisDb} + {@link ownedDbSkip} in one call: the watchdog #4183
 * describes and the shim battery share it. This is the canonical owned-DB rule
 * those call sites reference:
 * - `db` is the run-OWNED DB the launcher exported as HYDRA_REDIS_DB (via
 *   redisChildEnv). Never substitute a literal from the launcher's pool: a
 *   concurrent run owns every other index and FLUSHDBs it (issue #5062).
 * - `db === null` means no owned DB. A remote REDIS_URL or a bare `node --test`
 *   skips with `skip`'s reason; a full-suite local run gets `skip === false` and
 *   must fail loudly. Cleanup DELs against the owned DB are skipped, never
 *   redirected to db 0.
 */
export function ownedDbContext(env: NodeJS.ProcessEnv = process.env): OwnedDbContext {
  const db = ownedRedisDb(env);
  return { db, skip: ownedDbSkip(db, env) };
}
