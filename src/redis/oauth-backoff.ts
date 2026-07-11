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
const OAUTH_BACKOFF_KEY = "hydra:metrics:oauth-usage:backoff";

/**
 * TTL for the persisted backoff state — 24h. Long enough to survive any normal
 * restart / deploy / cooldown gap (the whole point of the seam), but bounded so
 * a value that was never cleared by a recovery success (the process died during
 * the outage and a fresh one starts a day later) self-expires rather than
 * resuming a stale ladder against an endpoint that has long since recovered.
 */
const OAUTH_BACKOFF_TTL_SECONDS = 24 * 60 * 60;

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

// ---------------------------------------------------------------------------
// GitHub-API rate-limit backoff gate (issue #3137)
// ---------------------------------------------------------------------------
//
// PROBLEM this closes: the orchestrator's `gh` calls (dispatch/reconciliation
// cycles) periodically take a GitHub `rate_limit_error` (primary or secondary
// limit). The `gh` CLI abstracts away the raw HTTP response headers, so the
// exact `x-ratelimit-reset` instant is NOT readable — but the structured
// rate-limit failure IS classifiable (`gh-rate-limited`, see
// `src/github/exec.ts::isRateLimitStderr`). Without a gate, a rate-limited call
// is naively retried on the next cycle against a still-limited endpoint,
// worsening the limit. This gate is the `gh`-API sibling of the OAuth-meter
// ladder above: an exponential backoff, persisted so it survives a restart, so
// callers can SKIP a `gh` call while the gate is armed instead of hammering the
// limited endpoint.
//
// Same contract as the OAuth gate: FAILS OPEN (Redis outage → no gate, the
// pre-#3137 behaviour), NEVER throws, and the persisted `nextAttemptMs` is
// clamped on hydrate against the current MAX ceiling so a stale/hostile write
// can never park `gh` calls longer than a freshly-armed max backoff.

/** Redis key for the persisted GitHub-API rate-limit backoff gate (issue #3137). */
const GH_RATE_LIMIT_BACKOFF_KEY = "hydra:metrics:github-api:rate-limit-backoff";

/**
 * Exponential ladder for the `gh`-API gate. The base (30s) and ceiling (~15min)
 * mirror the OAuth-meter ladder — a GitHub primary-limit window resets hourly,
 * so a ~15min ceiling re-probes several times per window without hammering.
 */
const GH_BACKOFF_BASE_MS = 30_000; // first failure → 30s
const GH_BACKOFF_MAX_MS = 15 * 60_000; // ceiling → ~15min

/** TTL for the persisted gh-API gate. Same 24h self-expiry rationale as OAuth. */
const GH_RATE_LIMIT_BACKOFF_TTL_SECONDS = 24 * 60 * 60;

/**
 * The persisted gh-API rate-limit gate. Same shape as {@link PersistedOAuthBackoff}:
 *   - `failures` — consecutive `gh-rate-limited` failures since the last success (>= 1).
 *   - `nextAttemptMs` — epoch-ms before which no gated `gh` call is attempted.
 */
export interface PersistedGhRateLimitBackoff {
  failures: number;
  nextAttemptMs: number;
}

/**
 * Pure exponential-backoff ladder for the `gh`-API gate (issue #3137). Given the
 * consecutive-failure count and `now`, return the next `{ failures, nextAttemptMs }`.
 * Delay is `min(base * 2^(failures-1), max)`; `failures` is clamped >= 1 so the
 * first observed failure arms the base delay. Deterministic and side-effect free
 * so it is unit-testable without Redis.
 */
export function nextGhRateLimitBackoff(
  failures: number,
  now: number,
): PersistedGhRateLimitBackoff {
  const n = Math.max(1, Math.floor(Number.isFinite(failures) ? failures : 1));
  // Guard the shift against overflow — cap the exponent so 2^exp stays finite.
  const exp = Math.min(n - 1, 20);
  const delay = Math.min(GH_BACKOFF_BASE_MS * 2 ** exp, GH_BACKOFF_MAX_MS);
  return { failures: n, nextAttemptMs: now + delay };
}

/** Validate a parsed value as a well-formed {@link PersistedGhRateLimitBackoff}. */
function isValidGhBackoff(value: unknown): value is PersistedGhRateLimitBackoff {
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
 * Read the persisted gh-API rate-limit gate, clamping a stale/hostile
 * `nextAttemptMs` down to `now + GH_BACKOFF_MAX_MS` so it can never park `gh`
 * calls longer than a freshly-armed max backoff. Returns `null` when none is
 * stored / corrupt / Redis is unreachable. NEVER throws (fails open).
 */
export async function readGhRateLimitBackoff(
  now: number = Date.now(),
): Promise<PersistedGhRateLimitBackoff | null> {
  let raw: string | null;
  try {
    const r = getRedisConnection();
    raw = await r.get(GH_RATE_LIMIT_BACKOFF_KEY);
  } catch (err: any) {
    console.error(
      `[gh-rate-limit-backoff] read failed (degrading to no persisted state): ${err?.message || err}`,
    );
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    console.error(
      `[gh-rate-limit-backoff] stored value is not valid JSON (ignoring): ${err?.message || err}`,
    );
    return null;
  }
  if (!isValidGhBackoff(parsed)) {
    console.error(
      `[gh-rate-limit-backoff] stored value is malformed (ignoring): ${raw.slice(0, 120)}`,
    );
    return null;
  }
  // Clamp a value further out than a freshly-armed max backoff (persistence
  // extends NO staleness ceiling — mirrors the OAuth gate's hydrate clamp).
  const ceiling = now + GH_BACKOFF_MAX_MS;
  if (parsed.nextAttemptMs > ceiling) {
    return { failures: parsed.failures, nextAttemptMs: ceiling };
  }
  return parsed;
}

/**
 * Persist the gh-API rate-limit gate, stamping the 24h TTL. Best-effort — NEVER
 * throws: a Redis outage means the ladder won't survive the next restart (the
 * pre-#3137 behaviour), strictly better than failing the `gh` call.
 */
export async function writeGhRateLimitBackoff(
  state: PersistedGhRateLimitBackoff,
): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.set(
      GH_RATE_LIMIT_BACKOFF_KEY,
      JSON.stringify(state),
      "EX",
      GH_RATE_LIMIT_BACKOFF_TTL_SECONDS,
    );
  } catch (err: any) {
    console.error(
      `[gh-rate-limit-backoff] write failed (ladder will reset on next restart): ${err?.message || err}`,
    );
  }
}

/**
 * Clear the persisted gh-API rate-limit gate — called when a `gh` call SUCCEEDS
 * after prior rate-limit failures, so a restart right after recovery does not
 * resume a now-obsolete gate. Best-effort — NEVER throws.
 */
export async function clearGhRateLimitBackoff(): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.del(GH_RATE_LIMIT_BACKOFF_KEY);
  } catch (err: any) {
    console.error(
      `[gh-rate-limit-backoff] clear failed (stale gate self-expires at TTL): ${err?.message || err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Hour-bucketed gh-rate-limited observability counter (issue #3137, artifact Q6)
// ---------------------------------------------------------------------------
//
// The backoff gate above answers "should I skip the NEXT gh call?" but is a
// consecutive-failure count that RESETS to 0 on the first success — it cannot
// answer "how many gh calls were rate-limited this hour?" or trend the pressure
// across restarts. The artifact's Q6 positively scoped an hour-bucketed counter
// mirroring `src/redis/ov-search-metrics.ts`: one small Redis hash per UTC hour,
// HINCRBY on each rate-limited event, a rolling TTL, and a never-throw write
// contract (a metrics write must never break the `gh` call it observes). This is
// the historical/observability counterpart to the (resettable) gate.

/** Redis key prefix for the per-UTC-hour gh-rate-limited counter buckets. */
const GH_RATE_LIMIT_COUNTER_PREFIX = "hydra:metrics:github-api:rate-limited:window-1h";

/**
 * 7 days, matching the ov-search-metrics window TTL. A rolling read of the last
 * N hours never needs more, and each bucket is a tiny one-field hash.
 */
const GH_RATE_LIMIT_COUNTER_TTL_SECONDS = 7 * 24 * 60 * 60;

/** UTC YYYY-MM-DDTHH for a Date — the hour-bucket key suffix (mirrors ov-search-metrics). */
export function utcHourKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}`;
}

/** Full Redis hash key for a given UTC-hour bucket. */
function ghRateLimitCounterKey(hour: string): string {
  return `${GH_RATE_LIMIT_COUNTER_PREFIX}:${hour}`;
}

/** Per-hour bucket for the gh-rate-limited counter window read. */
interface GhRateLimitedHourBucket {
  hour: string;
  count: number;
}

/** Rolling-window rollup of the gh-rate-limited counter. */
export interface GhRateLimitedWindow {
  windowHours: number;
  total: number;
  buckets: GhRateLimitedHourBucket[];
}

/**
 * Increment the current UTC-hour gh-rate-limited counter (HINCRBY) and stamp the
 * rolling TTL. Called once per `gh-rate-limited` classification. Returns the hour
 * key written (for logging/tests).
 *
 * Best-effort — NEVER throws: an observability write must not break the `gh`
 * call it observes (same never-throw contract as the backoff gate and the
 * ov-search-metrics flush it mirrors).
 */
export async function recordGhRateLimited(now: Date = new Date()): Promise<string> {
  const hour = utcHourKey(now);
  try {
    const r = getRedisConnection();
    const key = ghRateLimitCounterKey(hour);
    const pipe = r.pipeline();
    pipe.hincrby(key, "count", 1);
    pipe.expire(key, GH_RATE_LIMIT_COUNTER_TTL_SECONDS);
    await pipe.exec();
  } catch (err: any) {
    console.error(
      `[gh-rate-limit-counter] increment failed (counter under-counts this hour): ${err?.message || err}`,
    );
  }
  return hour;
}

/**
 * Read the last `hours` UTC-hour gh-rate-limited buckets ending at `now`,
 * newest-first, with the rolled-up total. Missing hours read as zero. Pipelined
 * into a single round-trip. NEVER throws — a read failure degrades to an
 * all-zero window (the observability surface renders empty, not broken).
 */
export async function getGhRateLimitedWindow(
  hours = 24,
  now: Date = new Date(),
): Promise<GhRateLimitedWindow> {
  const n = Math.max(1, Math.floor(hours));
  const hourKeys: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    hourKeys.push(utcHourKey(d));
  }

  let results: unknown[] | null = null;
  try {
    const r = getRedisConnection();
    const pipe = r.pipeline();
    for (const hour of hourKeys) pipe.hget(ghRateLimitCounterKey(hour), "count");
    results = await pipe.exec();
  } catch (err: any) {
    console.error(
      `[gh-rate-limit-counter] window read failed (degrading to zero window): ${err?.message || err}`,
    );
    results = null;
  }

  let total = 0;
  const buckets: GhRateLimitedHourBucket[] = [];
  for (let i = 0; i < hourKeys.length; i++) {
    const res = Array.isArray(results) ? results[i] : null;
    const raw = Array.isArray(res) && res[0] == null ? res[1] : null;
    const c = typeof raw === "string" && Number.isFinite(Number(raw)) ? Number(raw) : 0;
    total += c;
    buckets.push({ hour: hourKeys[i], count: c });
  }
  return { windowHours: n, total, buckets };
}
