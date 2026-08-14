/**
 * Shared spawn-timeout budgets for the `scripts/hydra-watchdog.sh` test suites.
 *
 * WHY THIS MODULE EXISTS (issues #4044, #4072). Watchdog suites `spawnSync` the
 * script — or `source` a function extracted from it — and each one used to pick
 * its own ceiling. Those ceilings were sized against a developer laptop, not
 * against a CI runner executing ~7000 tests with four jobs sharing one box, so
 * they expired on load and reddened the REQUIRED `test` gate on unrelated PRs.
 * Because `test` gates `deploy`, every such flake also silently parked prod
 * behind master (measured 2026-08-14: 3 failures in 10 master runs).
 *
 * #4044 fixed the three files that existed when it was filed. Two more with the
 * same defect were written WHILE IT WAS OPEN (`watchdog-launch-flow`,
 * `watchdog-pending-work`), so the pattern reintroduced itself within hours: a
 * one-time sweep over a static file list cannot cover files being authored
 * concurrently with it. Hence one shared constant plus a ratchet
 * (`test/watchdog-spawn-timeout-ratchet.test.mts`) rather than another sweep.
 *
 * THESE BOUND A HANG, NOT A SLOW RUN. A correct watchdog tick finishes in
 * seconds; the ceiling exists only so a wedged child fails the suite instead of
 * hanging it forever. Raising it therefore costs nothing on a healthy run and
 * removes a whole class of false red — the asymmetry is the entire argument for
 * generous values here.
 */

/**
 * Ceiling for spawning `hydra-watchdog.sh` itself, or sourcing a block
 * extracted from it.
 *
 * The script's worst case is ~55s (9 `curl` calls at up to `--max-time 10`,
 * plus a `sleep 5`) — see #4044. The 15-20s ceilings left only a couple of
 * seconds of margin locally and none at all under CI contention.
 */
export const WATCHDOG_SPAWN_TIMEOUT_MS = 120_000;

/**
 * Ceiling for a `docker exec … redis-cli` round-trip used to seed or read state
 * around a watchdog case.
 *
 * Lower than {@link WATCHDOG_SPAWN_TIMEOUT_MS} because it is one container
 * round-trip rather than a full tick, but far above the 4s/8s budgets it
 * replaces: those are tight for a container exec on a loaded runner, and #4072
 * called them out for the same reason as the script ceilings.
 */
export const WATCHDOG_REDIS_TIMEOUT_MS = 30_000;

/**
 * The ratchet floor. No `spawnSync` in a watchdog-spawning test file may use a
 * numeric `timeout:` below this — enforced by
 * `test/watchdog-spawn-timeout-ratchet.test.mts`.
 *
 * Equal to the smaller of the two budgets above, so both constants satisfy it
 * by construction and the guard has exactly one number to check.
 */
export const MIN_WATCHDOG_TEST_TIMEOUT_MS = WATCHDOG_REDIS_TIMEOUT_MS;

/** The minimal `spawnSync` result shape these helpers inspect. */
interface SpawnLike {
  error?: Error;
  signal?: NodeJS.Signals | null;
  stdout?: string | null;
  stderr?: string | null;
}

/**
 * Throw a diagnostic error when `spawnSync` killed the child on timeout.
 *
 * On timeout `spawnSync` sets `status` to `null` (not a real exit code) and
 * `error.code` to `"ETIMEDOUT"`. Callers that coerce `status ?? -1` then assert
 * `-1 === 0`, which reads as a watchdog BEHAVIOUR regression — #4044 records
 * that exact message sending a prior investigation hunting a bug that did not
 * exist. Surfacing the timeout explicitly is therefore as load-bearing as the
 * ceiling itself: it distinguishes "the box was slow" from "the script is
 * wrong".
 */
export function throwIfTimedOut(r: SpawnLike, timeoutMs: number, what: string): void {
  if ((r.error as NodeJS.ErrnoException | undefined)?.code !== "ETIMEDOUT") return;
  throw new Error(
    `${what} exceeded ${timeoutMs}ms timeout (killed with ${r.signal ?? "unknown signal"}); ` +
      `this is a TIMEOUT, not an assertion failure — the box was slow or the child wedged, ` +
      `NOT evidence of a watchdog behaviour change. stdout=${r.stdout ?? ""} stderr=${r.stderr ?? ""}`,
  );
}
