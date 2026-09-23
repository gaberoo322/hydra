/**
 * Autopilot signal Redis ops — the last-fired read (issue #4635, ADR-0034
 * §9.2 / PR #4617).
 *
 * `hydra:autopilot:signal-last-fired` is the reboot-survivable hash of
 * per-class last-fired epochs. Its ONLY writer is reap_state.py
 * (`REDIS_SIGNAL_LAST_FIRED_KEY`), which HSETs it on reap from
 * state.json's `signal_last_fired` — so the hash lags a live dispatch
 * for the whole dispatch duration. Readers that need "as fresh as the
 * loop itself knows" take max(hash, the run's latest turn
 * signals_snapshot); that composition lives in
 * src/autopilot/class-state.ts (INV-5), not here — this Module owns
 * exactly the one HGETALL and its result-object contract.
 *
 * The key literal is INLINED here (the src/redis/autopilot.ts +
 * dispatches.ts precedent), deliberately not added to redis/keys.ts: the
 * key already has exactly one writer (reap_state.py, Python-side, its own
 * literal) and one reader (here), and test/class-state.test.mts pins the
 * two literals together textually so a drift in either file fails the
 * required `test` job (INV-4).
 */

import { getRedisConnection } from "./connection.ts";
import { logger } from "../logger.ts";

/**
 * The last-fired hash key. Pinned against reap_state.py's
 * `REDIS_SIGNAL_LAST_FIRED_KEY` by test/class-state.test.mts.
 */
export const AUTOPILOT_SIGNAL_LAST_FIRED_KEY = "hydra:autopilot:signal-last-fired";

/** getSignalLastFired result — Ok carries the parsed field map. */
export type GetSignalLastFiredResult =
  | { ok: true; lastFired: Record<string, number> }
  | { ok: false; error: string };

/**
 * One HGETALL over the last-fired hash; every field parsed as an integer
 * epoch-seconds. Non-integer or <=0 values are skipped with a logged
 * warning (a garbage field is one class's observability going stale, not
 * a reason to fail the whole read). NEVER throws — a Redis failure
 * returns `{ok:false, error}` and the caller degrades (the class-state
 * reader names 'last-fired' in header.degraded; a 0/absent stand-in
 * would violate ADR-0034 §5's trust contract).
 */
export async function getSignalLastFired(): Promise<GetSignalLastFiredResult> {
  try {
    const r = getRedisConnection();
    const raw: Record<string, string> = await r.hgetall(AUTOPILOT_SIGNAL_LAST_FIRED_KEY);
    const lastFired: Record<string, number> = {};
    for (const [cls, value] of Object.entries(raw)) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        logger.warn(
          { key: AUTOPILOT_SIGNAL_LAST_FIRED_KEY, cls, value },
          "[redis/autopilot-signals] skipping non-integer/non-positive last-fired field",
        );
        continue;
      }
      lastFired[cls] = parsed;
    }
    return { ok: true, lastFired };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}
