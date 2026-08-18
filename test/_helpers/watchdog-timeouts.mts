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
  status?: number | null;
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

/**
 * Signal names by number, for decoding a `128 + N` shell exit status.
 *
 * Only the ones a watchdog child plausibly dies from — enough to turn a bare
 * number into a name without pulling in a table nobody reads.
 */
const SIGNAL_BY_NUMBER: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  9: "SIGKILL",
  13: "SIGPIPE",
  15: "SIGTERM",
};

/**
 * Render a shell exit status so a failure message explains itself (issue #4135).
 *
 * A watchdog case that fails with `141 !== 0` and an empty stderr is nearly
 * uninformative: 141 is `128 + 13`, i.e. some command in the block died of
 * SIGPIPE, but nothing on the screen says so. Chasing exactly that number
 * through a #4135 investigation is what motivated this helper — the next
 * person should read the cause off the assertion rather than rediscover the
 * `128 + N` convention.
 */
export function describeExitStatus(status: number | null | undefined): string {
  if (status === null || status === undefined) return "no exit status (child did not run to completion)";
  if (status > 128 && status < 128 + 32) {
    const n = status - 128;
    const name = SIGNAL_BY_NUMBER[n] ?? `signal ${n}`;
    return `${status} (= 128 + ${n}, i.e. killed by ${name} — an ENVIRONMENT/plumbing death, not an assertion about watchdog behaviour)`;
  }
  return String(status);
}

/**
 * Throw unless `spawnSync` actually ran the child to a clean exit (issue #4135).
 *
 * WHY THIS EXISTS, AND WHY IT IS STRICTER THAN {@link throwIfTimedOut}.
 * `throwIfTimedOut` protects the calls whose RESULT a test then asserts on —
 * there, a dead child surfaces as `status ?? -1` and at least fails loudly.
 * The dangerous calls are the opposite kind: the `docker exec … redis-cli`
 * helpers that SEED state and return `void`. When one of those dies —
 * timeout, `EAGAIN` on fork under load, a busy container, any non-zero
 * `redis-cli` exit — nothing is thrown and nothing is written. The next
 * assertion then reads state that was never seeded and fails as though the
 * watchdog's BEHAVIOUR had changed.
 *
 * That is the mechanism behind #4135: `watchdog-launch-flow`'s INV-5 seeds a
 * tick with an absent `latency_ms` and asserts the latency streak clears. If
 * that one seeding `HSET` is silently dropped, the previous over-budget tick
 * is still in place, the streak legitimately does NOT clear, and the run goes
 * red with "absent latency_ms must clear the latency streak" — on a loaded CI
 * runner only, never on a quiet laptop. Same tree, different outcome.
 *
 * So: never let a seeding spawn fail quietly. A test may fail because the
 * behaviour is wrong, or it may fail because the box could not run `docker`,
 * but it must never confuse the two.
 */
export function assertSpawnOk(r: SpawnLike, timeoutMs: number, what: string): void {
  throwIfTimedOut(r, timeoutMs, what);
  const tail = `stdout=${r.stdout ?? ""} stderr=${r.stderr ?? ""}`;
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(
      `${what} could not be spawned (${code}: ${r.error.message}); this is an ENVIRONMENT ` +
        `failure, not a watchdog behaviour change — the state it was to seed was never ` +
        `written. ${tail}`,
    );
  }
  if (r.signal) {
    throw new Error(
      `${what} was killed by ${r.signal}; the state it was to seed was never written, so any ` +
        `assertion after this point would be measuring an unseeded fixture. ${tail}`,
    );
  }
  if (r.status !== 0) {
    throw new Error(
      `${what} exited ${r.status}; the Redis command did not succeed, so the state it was to ` +
        `seed was never written. ${tail}`,
    );
  }
}
