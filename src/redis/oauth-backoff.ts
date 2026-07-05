/**
 * OAuth-meter backoff-state Redis seam (issue #2840).
 *
 * PROBLEM this closes: the exponential-backoff state for the OAuth usage meter
 * GET (issue #2619 — `{failures, nextAttemptMs}`) lived ONLY as a module-level
 * variable in `src/cost/transcript-scan.ts`. Every `systemctl restart` (deploy,
 * crash-recovery, cooldown) wiped it, so a sustained account-wide 429 wave that
 * had already backed off to the ~15min ceiling was RESET to consecutive-failure
 * #1 on the next boot — the tracker immediately re-GET the still-rate-limited
 * endpoint (no gate), took a fresh 429, and re-armed the ladder from 30s. PR
 * #2669's single-flight + Retry-After fix reduced the per-TTL burst but did NOT
 * make the ladder survive a restart, so 429s recurred within days. This seam
 * persists the gate so a restart RESUMES the ladder instead of resetting it.
 *
 * Contract (mirrors the design-concept invariants for #2840):
 *   - A pure hydrate-on-start / write-on-change SIDE-CHANNEL. The cadence
 *     decision in `transcript-scan.ts` stays driven by the in-memory state; this
 *     seam only seeds that state at boot and mirrors changes back to Redis.
 *   - FAILS OPEN. Every read/write is best-effort and NEVER throws — a Redis
 *     outage degrades EXACTLY to the pre-#2840 in-memory-only behaviour (the
 *     ladder resets on restart, as before), never to a broken meter read. The
 *     read-side Cost projection must not gain a hard Redis dependency.
 *   - Persistence extends NO staleness ceiling. The persisted `nextAttemptMs`
 *     is validated on hydrate against the CURRENT backoff MAX ceiling: a value
 *     further out than `now + maxMs` is clamped down (a stale/hostile write can
 *     never park the meter longer than a freshly-armed max-backoff would).
 *
 * Key shape follows the daily-token / weekly-snapshot convention in
 * `src/redis/cost.ts` (`hydra:metrics:*`). A single JSON value with a TTL so a
 * process that dies mid-outage and never returns lets the key self-expire rather
 * than parking a resumed-much-later ladder forever.
 */

import { getRedisConnection } from "./connection.ts";

/** Redis key for the persisted OAuth-meter backoff gate. */
export const OAUTH_BACKOFF_KEY = "hydra:metrics:oauth-usage:backoff";

/**
 * TTL for the persisted backoff state — 24h. Long enough to survive any normal
 * restart / deploy / cooldown gap (the whole point of the seam), but bounded so
 * a value that was never cleared by a recovery success (the process died during
 * the outage and a fresh one starts a day later) self-expires rather than
 * resuming a stale ladder against an endpoint that has long since recovered.
 */
export const OAUTH_BACKOFF_TTL_SECONDS = 24 * 60 * 60;

/**
 * The persisted backoff gate. Identical shape to the in-memory
 * `OAuthBackoffState` in `transcript-scan.ts`:
 *   - `failures` — consecutive failed-GET count since the last success (>= 1).
 *   - `nextAttemptMs` — epoch-ms before which no external GET is attempted.
 */
export interface PersistedOAuthBackoff {
  failures: number;
  nextAttemptMs: number;
}

/** Validate a parsed value as a well-formed {@link PersistedOAuthBackoff}. */
function isValidBackoff(value: unknown): value is PersistedOAuthBackoff {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.failures === "number" &&
    Number.isFinite(v.failures) &&
    v.failures >= 1 &&
    typeof v.nextAttemptMs === "number" &&
    Number.isFinite(v.nextAttemptMs)
  );
}

/**
 * Read the persisted OAuth backoff gate, or `null` when none is stored / the
 * stored value is corrupt / Redis is unreachable. NEVER throws — a read failure
 * degrades to `null`, which the caller treats as "no persisted state, start
 * fresh" (the pre-#2840 behaviour). Best-effort by the seam convention.
 */
export async function readOAuthBackoff(): Promise<PersistedOAuthBackoff | null> {
  let raw: string | null;
  try {
    const r = getRedisConnection();
    raw = await r.get(OAUTH_BACKOFF_KEY);
  } catch (err: any) {
    // Fail OPEN: a Redis outage must not break the meter read. Logged (repo
    // fail-loud convention) but degrades to "no persisted state".
    console.error(`[oauth-backoff] read failed (degrading to no persisted state): ${err?.message || err}`);
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    console.error(`[oauth-backoff] stored value is not valid JSON (ignoring): ${err?.message || err}`);
    return null;
  }
  if (!isValidBackoff(parsed)) {
    console.error(`[oauth-backoff] stored value is malformed (ignoring): ${raw.slice(0, 120)}`);
    return null;
  }
  return parsed;
}

/**
 * Persist the OAuth backoff gate, stamping the 24h TTL. Best-effort — NEVER
 * throws: a Redis outage means the ladder simply won't survive the next restart
 * (the pre-#2840 behaviour), which is strictly better than failing the scan.
 */
export async function writeOAuthBackoff(state: PersistedOAuthBackoff): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.set(OAUTH_BACKOFF_KEY, JSON.stringify(state), "EX", OAUTH_BACKOFF_TTL_SECONDS);
  } catch (err: any) {
    console.error(`[oauth-backoff] write failed (ladder will reset on next restart): ${err?.message || err}`);
  }
}

/**
 * Clear the persisted OAuth backoff gate — called when a SUCCESSFUL read resets
 * the in-memory ladder, so a restart right after recovery does not resume a
 * now-obsolete gate. Best-effort — NEVER throws.
 */
export async function clearOAuthBackoff(): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.del(OAUTH_BACKOFF_KEY);
  } catch (err: any) {
    console.error(`[oauth-backoff] clear failed (stale gate self-expires at TTL): ${err?.message || err}`);
  }
}
