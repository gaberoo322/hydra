/**
 * src/cost/oauth-read-cache.ts — the **OAuth backoff/cache seam** of the **Cost**
 * Module's Subscription Usage Tracker (issue #2923).
 *
 * Extracted VERBATIM out of `transcript-scan.ts` (which had grown to 1047 lines,
 * 42% of it this OAuth concern) so the OAuth-credential caching + backoff-on-
 * rate-limit machinery lives in one focused leaf named after the concept, not
 * buried inside the JSONL-transcript-scan seam whose module name describes a
 * different concern. Same extraction axis the pure-math leaf `token-math.ts`
 * (#1909), the snapshot-assembly fold `snapshot-assembly.ts` (#2279), and the
 * env-reader leaf `config.ts` (#1896) each split along.
 *
 * This leaf owns the OAuth cached meter read (issue #1090) end to end:
 *   1. The module-level `oauthCache` last-good singleton — a SUCCESSFUL read
 *      only, served through transient 429s so the headline stays on ground truth.
 *   2. The exponential-backoff gate (issue #2619) that stops a sustained 429 from
 *      hammering the rate-limited endpoint every scan.
 *   3. The single-flight guard (issue #2666) that collapses concurrent post-TTL
 *      GETs into one shared read.
 *   4. The Redis backoff-persistence side-channel (issue #2840) that RESUMES the
 *      backoff ladder across a `systemctl restart` instead of resetting it.
 *
 * The transcript-scan concern (`transcript-scan.ts`) coordinates this seam via
 * `makeReadOAuth()`, which wires the persistence adapter and returns the cached-
 * or bypass-read closure `transcriptScan()` awaits. Import direction is one-way:
 * this leaf imports FROM `./config.ts`, `./oauth-usage.ts`, and
 * `../redis/oauth-backoff.ts`; `transcript-scan.ts` and `usage-tracker.ts` import
 * the OAuth-cache primitives FROM here — no cycle. The behaviour is byte-for-byte
 * unchanged from the pre-#2923 `transcript-scan.ts`.
 */

import { isOAuthUsageOk } from "./oauth-usage.ts";
import type { OAuthUsageResult, OAuthUsageData } from "./oauth-usage.ts";
import {
  getOAuthUsageTtlMs,
  getOAuthUsageMaxStaleMs,
  getOAuthUsageBackoffBaseMs,
  getOAuthUsageBackoffMaxMs,
} from "./config.ts";
import {
  readOAuthBackoff,
  writeOAuthBackoff,
  clearOAuthBackoff,
} from "../redis/oauth-backoff.ts";
import type { PersistedOAuthBackoff } from "../redis/oauth-backoff.ts";

// ---------------------------------------------------------------------------
// OAuth cached meter read (issue #1090)
// ---------------------------------------------------------------------------

/**
 * Last SUCCESSFUL OAuth meter read, cached independently of the snapshot cache
 * (issue #1090). `storedAt` is the epoch-ms of the successful GET. This is the
 * "last-good" value served while the meter is rate-limited (429) or otherwise
 * transiently failing, so the headline stays on ground truth rather than
 * flipping to the transcript estimate the moment the endpoint hiccups. Only a
 * SUCCESSFUL read is cached here — a failure never overwrites the last-good.
 */
interface OAuthCacheEntry {
  data: OAuthUsageData;
  storedAt: number;
}

let oauthCache: OAuthCacheEntry | null = null;

/**
 * Exponential-backoff state for the OAuth meter GET (issue #2619). Before this,
 * every post-TTL scan UNCONDITIONALLY re-attempted the external GET, so a
 * sustained 429 produced ~1–2 GETs/min (~90–100 failed reads/hour) that kept
 * hammering an already rate-limited endpoint. Now a failed GET records the
 * failure count and a `nextAttemptMs` gate; while `now < nextAttemptMs` the
 * external GET is SKIPPED (the last-good stale value is served if still within
 * TTL+maxStale, else the estimate) — so the re-probe cadence backs off
 * exponentially (`base * 2^(failures-1)`, capped) instead of firing per-scan.
 * A SUCCESSFUL read resets this to the zero-value, restoring the healthy fixed
 * TTL cadence immediately. `null` means "no active backoff" (healthy or never
 * failed). Only a SUCCESSFUL read clears it; failures grow it. Nulled by
 * {@link clearOAuthCache} for test isolation.
 */
interface OAuthBackoffState {
  /** Consecutive failed-GET count since the last success (>= 1 while active). */
  failures: number;
  /** Epoch-ms before which no external GET is attempted (the backoff gate). */
  nextAttemptMs: number;
}

let oauthBackoff: OAuthBackoffState | null = null;

/**
 * Backoff-state persistence side-channel (issue #2840). The exponential-backoff
 * gate above is process-in-memory only, so every `systemctl restart` (deploy,
 * crash-recovery, cooldown) wiped it — a sustained 429 wave that had backed off
 * to the ceiling was RESET to consecutive-failure #1 on the next boot, which
 * immediately re-GET the still-rate-limited endpoint and re-armed from 30s (the
 * recurrence #2840 reports despite the #2669 single-flight fix). This adapter
 * HYDRATES the in-memory gate from Redis on the first cached-path read after a
 * process start and MIRRORS every change (arm/advance/clear) back, so a restart
 * RESUMES the ladder. It is a pure side-channel: the cadence decision stays
 * driven by the in-memory `oauthBackoff`; this only seeds it at boot and writes
 * through.
 *
 * ONLY the PURE PRODUCTION cached path persists (invariant 5): the deterministic
 * `bypassOAuthCache` / injected-reader test path is untouched by persistence. So
 * the default adapter is a NO-OP; `getUsage`/`makeReadOAuth` install the real
 * {@link ../redis/oauth-backoff.ts} seam only when no reader/root is injected.
 * Tests that want to assert persistence explicitly inject a fake store via
 * {@link setOAuthBackoffPersistence}.
 */
export interface OAuthBackoffPersistence {
  read: () => Promise<PersistedOAuthBackoff | null>;
  write: (state: PersistedOAuthBackoff) => Promise<void>;
  clear: () => Promise<void>;
}

/** The live {@link ../redis/oauth-backoff.ts} seam — installed on the pure production path. */
const REDIS_OAUTH_BACKOFF_PERSISTENCE: OAuthBackoffPersistence = {
  read: readOAuthBackoff,
  write: writeOAuthBackoff,
  clear: clearOAuthBackoff,
};

/**
 * The no-op persistence adapter — the DEFAULT. Keeps the injected-reader /
 * fixture-root test path Redis-free (invariant 5): hydrate reads nothing, writes
 * and clears are no-ops. The pre-existing #1090/#1124/#2832 tests drive the
 * `useOAuthCache:true` cached path with an injected reader and MUST NOT touch
 * Redis; this default guarantees that unless a test opts in.
 */
const NOOP_OAUTH_BACKOFF_PERSISTENCE: OAuthBackoffPersistence = {
  read: async () => null,
  write: async () => {},
  clear: async () => {},
};

let oauthBackoffPersistence: OAuthBackoffPersistence = NOOP_OAUTH_BACKOFF_PERSISTENCE;

/**
 * True once the in-memory gate has been seeded from the persistence side-channel
 * for THIS process (issue #2840). Hydrate runs at most once per process (reset
 * by {@link clearOAuthCache} for test isolation); after that the in-memory gate
 * is authoritative and every mutation writes through. A hydrate FAILURE still
 * flips this true (fail-open: we tried once, degrade to in-memory-only), so a
 * Redis outage costs exactly one best-effort read, never a per-scan retry.
 */
let oauthBackoffHydrated = false;

/**
 * Install the backoff-persistence side-channel (issue #2840). Called by
 * `getUsage()` with {@link REDIS_OAUTH_BACKOFF_PERSISTENCE} ONLY on the pure
 * production path, so the injected-reader / fixture-root test path stays on the
 * default no-op adapter (invariant 5). Tests may inject a fake store to assert
 * hydrate-on-start / write-on-change without a live Redis; passing nothing
 * restores the no-op default. Always resets the per-process hydrate flag so the
 * next cached-path read re-seeds from the (possibly newly-installed) store —
 * mirroring a fresh process boot.
 */
export function setOAuthBackoffPersistence(store?: OAuthBackoffPersistence): void {
  installOAuthBackoffPersistence(store ?? NOOP_OAUTH_BACKOFF_PERSISTENCE);
}

/**
 * Install a persistence adapter, re-arming the per-process hydrate ONLY when the
 * adapter reference actually changes (issue #2840). `getUsage()` calls this every
 * scan with the same production-seam reference, so hydrate stays a genuine
 * once-per-process seed rather than re-firing every 60s — while a test swapping
 * in a fresh fake store (a distinct reference) correctly re-hydrates.
 */
function installOAuthBackoffPersistence(store: OAuthBackoffPersistence): void {
  if (store === oauthBackoffPersistence) return;
  oauthBackoffPersistence = store;
  oauthBackoffHydrated = false;
}

/**
 * Wire the backoff-persistence adapter for one scan (issue #2840, extracted #2923).
 * `makeReadOAuth` (the transcript-scan coordinator) calls this every scan with
 * the boolean `getUsage` computed:
 *   - `persist === true`  (pure production path) → install the live Redis seam so
 *     the backoff ladder survives a restart.
 *   - `persist === false` (deterministic test path) → keep the no-op default,
 *     UNLESS a test explicitly injected a fake store (a non-Redis, non-no-op
 *     reference) which we must not clobber. This also prevents a pure-production
 *     `getUsage()` in one test from LEAKING the Redis seam into a later cached-path
 *     test that would then hydrate from real Redis (invariant 5).
 * Encapsulates the private `oauthBackoffPersistence` reference so callers never
 * reach into module state — the `REDIS_OAUTH_BACKOFF_PERSISTENCE`-vs-current
 * comparison stays here where the state lives.
 */
export function wireOAuthBackoffPersistence(persist: boolean): void {
  if (persist) {
    installOAuthBackoffPersistence(REDIS_OAUTH_BACKOFF_PERSISTENCE);
  } else if (oauthBackoffPersistence === REDIS_OAUTH_BACKOFF_PERSISTENCE) {
    installOAuthBackoffPersistence(NOOP_OAUTH_BACKOFF_PERSISTENCE);
  }
}

/**
 * Hydrate the in-memory backoff gate from the persistence side-channel, ONCE per
 * process (issue #2840). No-op after the first call (or after a `clearOAuthCache`
 * reset). Fails OPEN: any read error degrades to no persisted state (the
 * pre-#2840 fresh-start behaviour) and still marks hydrated so we never retry
 * per-scan. Clamps a persisted `nextAttemptMs` to the CURRENT backoff MAX
 * ceiling (`nowMs + maxMs`) so a stale/hostile stored value can never park the
 * meter longer than a freshly-armed max-backoff would — persistence resumes the
 * ladder, it never EXTENDS the staleness ceiling. Only seeds when the in-memory
 * gate is still null (never overwrites an already-armed live gate) AND the
 * persisted gate is still in the future (a resumed gate whose window already
 * elapsed is dropped so the next scan re-probes immediately).
 */
async function hydrateOAuthBackoff(nowMs: number): Promise<void> {
  if (oauthBackoffHydrated) return;
  oauthBackoffHydrated = true; // fail-open: one attempt, then in-memory-only
  let persisted: PersistedOAuthBackoff | null;
  try {
    persisted = await oauthBackoffPersistence.read();
  } catch (err: any) {
    // Defence-in-depth: the seam already never throws, but a test double might.
    console.error(`[usage-tracker] OAuth backoff hydrate failed (in-memory-only): ${err?.message || err}`);
    return;
  }
  if (persisted === null) return;
  if (oauthBackoff !== null) return; // a live gate already armed this process — don't clobber it
  const maxMs = getOAuthUsageBackoffMaxMs();
  // Clamp the resumed gate so persistence can never extend the staleness ceiling
  // past a freshly-armed max backoff.
  const clampedNext = Math.min(persisted.nextAttemptMs, nowMs + maxMs);
  if (clampedNext <= nowMs) {
    // The persisted window has already elapsed — the next scan should re-probe
    // now, not resume a spent gate. Drop it (and clear the stale key).
    void oauthBackoffPersistence.clear();
    return;
  }
  oauthBackoff = { failures: persisted.failures, nextAttemptMs: clampedNext };
  console.error(
    `[usage-tracker] OAuth backoff resumed from persistence: failure #${persisted.failures}, ` +
      `next GET in ${clampedNext - nowMs}ms (restart did not reset the ladder — issue #2840)`,
  );
}

/**
 * Single-flight guard for the OAuth meter GET (issue #2666). Before this, two
 * scans arriving in the same instant past TTL expiry EACH fired their own GET
 * (journalctl 2026-07-02 shows every 429 as a same-second duplicate pair) —
 * burning two rate-limit bucket slots per TTL expiry and double-arming the
 * backoff (instantly advancing it to consecutive-failure #2). Now the first
 * post-TTL caller launches the read and stores its promise here; concurrent
 * callers AWAIT AND SHARE that in-flight outcome instead of launching a second
 * GET. Semantically safe: both scans would have received the same meter value
 * anyway, and ageMs skew is bounded by the GET duration (≤5s timeout). Applies
 * ONLY to the production cached path (`readOAuthCached`) — the
 * `bypassOAuthCache` test path keeps the #1083 deterministic fresh-each-call
 * contract. Nulled by {@link clearOAuthCache} for test isolation.
 */
let oauthInFlight: Promise<CachedOAuthRead> | null = null;

/**
 * Null the module-level OAuth last-good cache AND the backoff state (issue
 * #2619) AND the single-flight in-flight promise (issue #2666).
 * `clearUsageCache()` in `usage-tracker.ts` calls this so its single
 * reset entry point continues to null the snapshot cache, the oauthCache, and
 * the backoff clock, even though the latter two now live here (issue #1971,
 * #2923).
 * Test isolation depends on this. (issue #1090, #2619, #2666)
 */
export function clearOAuthCache(): void {
  oauthCache = null;
  oauthBackoff = null;
  oauthInFlight = null;
  // Re-arm the per-process hydrate so the next cached-path read re-seeds the
  // gate from the persistence side-channel (issue #2840). Test isolation relies
  // on this: each test that drives the cached path re-hydrates from its own
  // injected store rather than inheriting a prior test's seeded gate.
  oauthBackoffHydrated = false;
}

/**
 * Compute the exponential-backoff delay for the Nth consecutive failure (issue
 * #2619): `base * 2^(failures-1)`, clamped to `maxMs`. Pure so the curve is
 * unit-testable. `failures` is >= 1 (the count AFTER incrementing for the
 * current failure). Exported for direct unit test.
 */
export function oauthBackoffDelayMs(failures: number, baseMs: number, maxMs: number): number {
  // 2^(failures-1), guarded so a huge failure count can't overflow into Infinity
  // before the min-clamp (a healthy system never gets near this, but fail-safe).
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  const delay = baseMs * 2 ** exponent;
  return Math.min(delay, maxMs);
}

/**
 * The OAuth read fed into one scan, after the independent-TTL + last-good cache
 * layer (issue #1090). Distinct from the raw {@link OAuthUsageResult}: it also
 * tells the scan whether the value it carries is a STALE last-good (`stale`)
 * and how old it is (`ageMs`), so the snapshot can surface those observability
 * fields. `result.ok === true` covers BOTH a fresh read AND a served-stale
 * last-good — in either case the headline rebases onto OAuth ground truth; only
 * `result.ok === false` falls through to the transcript estimate.
 */
export interface CachedOAuthRead {
  result: OAuthUsageResult;
  /** True when `result` is a last-good value served because a fresh read failed. */
  stale: boolean;
  /** Age in ms of the served OAuth value, or `null` when none was served (failure). */
  ageMs: number | null;
  /**
   * The LAST-KNOWN successful OAuth meter value at the time of this read (issue
   * #2832 AC3), or `null` when the module has never seen a successful read (cold
   * cache) OR the injected bypass path is in use. Populated on EVERY cached-path
   * branch — fresh, served-stale, backoff-suppressed, and estimate-fallback —
   * INCLUDING the too-stale case where the cache is about to be evicted from the
   * HEADLINE (the value is captured BEFORE eviction). Distinct from what backs
   * the headline: on the estimate-fallback path `result.ok === false` (the
   * headline is the estimate) yet `lastKnownOAuth` can still carry the last real
   * meter reading, which is exactly the baseline the AC3 divergence detector
   * compares the fail-open estimate against. Carries the whole
   * {@link OAuthUsageData} (both windows) so the detector can compare against the
   * 7d utilization. A pure observability channel — nothing gates on it.
   */
  lastKnownOAuth: OAuthUsageData | null;
}

/**
 * Decouple the OAuth-read cadence from the 60s transcript-scan cadence and
 * serve a last-good value through transient meter failures (issue #1090).
 *
 * Lifecycle of the module-level `oauthCache` (a SUCCESSFUL read only):
 *   - cache fresh (age < TTL)        → serve cached, NO external GET (fresh oauth)
 *   - cache stale-but-servable       → attempt GET; on success refresh + serve fresh;
 *       (TTL ≤ age < TTL + maxStale)    on FAILURE serve the cached value as STALE oauth
 *   - cache absent OR too stale       → attempt GET; on failure pass the failure
 *       (age ≥ TTL + maxStale)          through (caller falls to the estimate)
 *
 * Only a SUCCESSFUL read overwrites the cache — a 429/timeout never evicts the
 * last-good. Pure of `Date.now()` (caller passes `nowMs`); the module cache is
 * the only side effect, mirroring the snapshot `cache`.
 *
 * Exponential backoff (issue #2619): once the TTL has expired, the external GET
 * is NO LONGER attempted on every scan. A failed GET arms the module-level
 * {@link oauthBackoff} gate; while `nowMs` is inside that gate the GET is
 * SKIPPED entirely (the last-good stale value is served if still trustworthy,
 * else the caller falls to the estimate), so a rate-limited endpoint is
 * re-probed on an exponential-backoff cadence (`base * 2^(failures-1)`, capped)
 * rather than being hammered ~1–2×/min. A SUCCESSFUL read clears the gate,
 * restoring the healthy fixed-TTL cadence immediately.
 *
 * Single-flight (issue #2666): concurrent post-TTL callers no longer each fire
 * a GET — the first launches {@link attemptOAuthRead} and parks its promise in
 * {@link oauthInFlight}; the rest await and share that outcome. Retry-After
 * honor (issue #2666): a rate-limited (429) failure whose parsed `retryAfterMs`
 * exceeds the exponential delay LENGTHENS the backoff gate to the server hint —
 * the hint can never shorten the exponential curve.
 */
export async function readOAuthCached(
  readUsage: () => Promise<OAuthUsageResult>,
  nowMs: number,
): Promise<CachedOAuthRead> {
  const ttlMs = getOAuthUsageTtlMs();

  // Seed the in-memory backoff gate from the persistence side-channel on the
  // first cached-path read of this process (issue #2840). No-op after the first
  // call; fails open to in-memory-only on any error. Done BEFORE the backoff-gate
  // check below so a restart mid-outage RESUMES the ladder (does not reset it).
  await hydrateOAuthBackoff(nowMs);

  // Fresh cache hit: serve without an external GET. This is the cadence
  // decoupling — within the TTL the snapshot scan reuses the cached OAuth value
  // instead of GETting on every 60s refresh.
  if (oauthCache !== null && nowMs - oauthCache.storedAt < ttlMs) {
    return {
      result: { ok: true, data: oauthCache.data },
      stale: false,
      ageMs: nowMs - oauthCache.storedAt,
      lastKnownOAuth: oauthCache.data,
    };
  }

  // Backoff gate (issue #2619): the TTL has expired, but a recent failure has
  // us in an exponential-backoff window — SKIP the external GET rather than
  // hammer the rate-limited endpoint. Serve the last-good stale value if it is
  // still within TTL+maxStale; otherwise the synthetic failure below falls the
  // caller through to the estimate. This is the fix for the ~90–100 failed
  // reads/hour steady state: no GET is spent while backing off.
  if (oauthBackoff !== null && nowMs < oauthBackoff.nextAttemptMs) {
    // Capture the last-known real meter value for the AC3 divergence detector
    // (issue #2832) BEFORE any headline decision — it is the baseline the
    // fail-open estimate is compared against, independent of whether it is
    // fresh-enough to still back the headline.
    const lastKnownOAuth = oauthCache !== null ? oauthCache.data : null;
    if (oauthCache !== null) {
      const ageMs = nowMs - oauthCache.storedAt;
      if (ageMs < ttlMs + getOAuthUsageMaxStaleMs()) {
        return { result: { ok: true, data: oauthCache.data }, stale: true, ageMs, lastKnownOAuth };
      }
    }
    // No trustworthy last-good to serve as the HEADLINE: report the
    // backoff-suppressed state as a failure so the caller falls to the estimate
    // (never a silent 0). No GET was made — the whole point of the gate. The
    // last-known value (if any) still rides out on `lastKnownOAuth` for the
    // divergence detector even though it no longer backs the headline.
    return {
      result: { ok: false, code: "oauth-usage-non-2xx" },
      stale: false,
      ageMs: null,
      lastKnownOAuth,
    };
  }

  // Single-flight guard (issue #2666): a GET is already in flight — await and
  // share its outcome instead of launching a duplicate. This kills the
  // same-second duplicate 429 pairs (two bucket slots burned + backoff
  // double-armed) observed in journalctl 2026-07-02.
  if (oauthInFlight !== null) {
    return oauthInFlight;
  }

  const attempt = attemptOAuthRead(readUsage, nowMs, ttlMs);
  oauthInFlight = attempt;
  try {
    return await attempt;
  } finally {
    oauthInFlight = null;
  }
}

/**
 * The post-TTL, post-gate OAuth read attempt — the GET plus the
 * success/failure cache + backoff bookkeeping (lifted verbatim from
 * `readOAuthCached` for the issue #2666 single-flight wrapper; exactly one
 * invocation of this function is in flight process-wide on the production
 * cached path). Never throws — `readUsage` returns result objects.
 */
async function attemptOAuthRead(
  readUsage: () => Promise<OAuthUsageResult>,
  nowMs: number,
  ttlMs: number,
): Promise<CachedOAuthRead> {
  const result = await readUsage();
  if (isOAuthUsageOk(result)) {
    // Success — refresh the cache AND reset the backoff clock so the next reads
    // resume the healthy fixed-TTL cadence immediately (issue #2619 recovery).
    oauthCache = { data: result.data, storedAt: nowMs };
    if (oauthBackoff !== null) {
      console.error(
        `[usage-tracker] OAuth meter recovered after ${oauthBackoff.failures} ` +
          `consecutive failure(s); backoff cleared, resuming fixed-TTL cadence`,
      );
      oauthBackoff = null;
      // Clear the persisted gate too (issue #2840) so a restart right after
      // recovery does not resume a now-obsolete ladder. Fire-and-forget,
      // fail-open — the seam never throws and a stale key self-expires at TTL.
      void oauthBackoffPersistence.clear();
    }
    // A fresh success IS the last-known value.
    return { result, stale: false, ageMs: 0, lastKnownOAuth: result.data };
  }

  // Read failed. Arm/advance the exponential-backoff gate so subsequent scans
  // do NOT re-GET until the delay elapses (issue #2619). Each consecutive
  // failure doubles the delay up to the ceiling; a later success resets it.
  // Retry-After honor (issue #2666): a rate-limited (429) failure may carry the
  // server's parsed hint — it can only LENGTHEN the delay past the exponential
  // curve, never shorten it, so a lying `retry-after: 0` cannot restore
  // hammering. The hint is already clamped to the maxStale ceiling adapter-side.
  const failures = (oauthBackoff?.failures ?? 0) + 1;
  const exponentialMs = oauthBackoffDelayMs(
    failures,
    getOAuthUsageBackoffBaseMs(),
    getOAuthUsageBackoffMaxMs(),
  );
  const retryAfterMs = result.retryAfterMs;
  const delayMs = Math.max(retryAfterMs ?? 0, exponentialMs);
  oauthBackoff = { failures, nextAttemptMs: nowMs + delayMs };
  // Mirror the armed/advanced gate to the persistence side-channel (issue #2840)
  // so a restart while inside this window RESUMES the ladder instead of resetting
  // it to failure #1. Fire-and-forget, fail-open — the seam never throws.
  void oauthBackoffPersistence.write({ failures, nextAttemptMs: oauthBackoff.nextAttemptMs });
  console.error(
    `[usage-tracker] OAuth meter read failed (${result.code}); backing off ` +
      `${delayMs}ms before next GET (consecutive failure #${failures})` +
      (retryAfterMs !== undefined && retryAfterMs > exponentialMs
        ? ` — server Retry-After ${retryAfterMs}ms lengthened the ${exponentialMs}ms exponential delay`
        : ""),
  );

  // Capture the last-known real meter value for the AC3 divergence detector
  // (issue #2832) BEFORE any eviction below — it is the baseline the fail-open
  // estimate is compared against, so it must survive even the too-stale eviction
  // that drops the value from the HEADLINE.
  const lastKnownOAuth = oauthCache !== null ? oauthCache.data : null;

  // Serve the last-good value (now stale) instead of flipping to the estimate —
  // UNLESS it is older than TTL + maxStale, in which case it is too stale to
  // trust and we let the failure fall through to the estimate.
  if (oauthCache !== null) {
    const ageMs = nowMs - oauthCache.storedAt;
    if (ageMs < ttlMs + getOAuthUsageMaxStaleMs()) {
      return { result: { ok: true, data: oauthCache.data }, stale: true, ageMs, lastKnownOAuth };
    }
    // Too stale: evict so a future success starts a clean age clock, and fall
    // through to the failure (estimate). Logged so a sustained outage is visible.
    console.error(
      `[usage-tracker] OAuth last-good value is too stale (age ${ageMs}ms ≥ ` +
        `TTL+maxStale); falling through to the transcript estimate (last read: ${result.code})`,
    );
    oauthCache = null;
  }
  return { result, stale: false, ageMs: null, lastKnownOAuth };
}
