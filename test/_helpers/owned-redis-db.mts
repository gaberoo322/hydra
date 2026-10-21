/**
 * The Redis DB this `npm test` run OWNS (issue #5062).
 *
 * scripts/test/redis-db-launch.mjs exports the run's isolated DB index as
 * HYDRA_REDIS_DB. Tests that need a non-zero DB must use that value, never a
 * literal from the launcher's pool: a concurrent run owns every other index
 * and FLUSHDBs it mid-assertion. One shared parse so the membership check
 * (ALLOWED_DB_INDEXES) cannot drift between call sites (shared by watchdog tests + shim).
 */
import { ALLOWED_DB_INDEXES } from "../../scripts/test/redis-db-launch.mjs";

/** The owned DB index as a string, or null when the launcher assigned none. */
export function ownedRedisDb(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.HYDRA_REDIS_DB ?? "";
  if (!/^\d+$/.test(raw)) return null;
  return (ALLOWED_DB_INDEXES as number[]).includes(Number(raw)) ? raw : null;
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
