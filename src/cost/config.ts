/**
 * src/cost/config.ts — the env-config reader cluster for the **Subscription
 * Usage Tracker** (issue #1896).
 *
 * Extracted out of `usage-tracker.ts` (the 1,564-line JSONL-scan / OAuth-cache
 * / snapshot-assembly module) so the env-reader boilerplate lives apart from
 * the domain scan logic it configures. This module is a PURE LEAF: it reads
 * `process.env`, parses, and falls back — no IO, no Redis, no module state, and
 * it imports NOTHING from `usage-tracker.ts` or `eligibility.ts` (the import
 * graph stays acyclic). `usage-tracker.ts` imports the readers it consumes
 * internally from here; `eligibility.ts` imports `getWeeklyPaceCeiling` from
 * here for its Pacing-Curve verdict. Everything outside `src/cost/` keeps
 * importing via `src/cost/index.ts`, which re-exports every symbol below at the
 * same name — no external import line changes.
 *
 * Each reader's parse/fallback/fail-loud semantics are moved VERBATIM from
 * `usage-tracker.ts` (and, for `getWeeklyPaceCeiling`, from `eligibility.ts`):
 * unset/empty → default; non-empty-but-bad → `console.error` + default; the
 * quota/weight family is all-or-nothing (0 unless explicitly set positive). The
 * env-var meanings are documented at length in the `usage-tracker.ts` header.
 */

/**
 * Default OAuth-meter cache TTL (issue #1090): how long a successful OAuth
 * meter read is reused before the next external GET is attempted. DECOUPLED
 * from the 60s transcript-scan cache (`CACHE_TTL_MS` in `usage-tracker.ts`) so
 * the OAuth read cadence is NOT pinned to the scan cadence. At 5 minutes the
 * service makes ≤12 OAuth GETs/hour, comfortably under the endpoint's
 * rolling-window rate limit (it 429s at ~tens/hour), instead of the ~60/hr the
 * snapshot-coupled read produced. Overridable via `HYDRA_OAUTH_USAGE_TTL_MS`.
 */
export const DEFAULT_OAUTH_USAGE_TTL_MS = 300_000;

/**
 * Default OAuth-meter max-stale grace (issue #2574): how long PAST the TTL a
 * last-good OAuth value may still be SERVED on a failed read before the headline
 * falls through to the transcript estimate. DECOUPLED from the TTL — the TTL
 * governs GET *cadence* (how often a fresh read is attempted), this governs how
 * long an already-fetched real value is TRUSTED through a meter outage. They are
 * different levers and must not be coupled: the 2026-06-30 incident
 * (`OAuth last-good value is too stale (age 601371ms …)`) was a sustained 429
 * burst that ran past the old `TTL+maxStale = 5min+5min = 10min` servable cliff,
 * flipping ceiling enforcement onto the fail-OPEN transcript estimate (#1124).
 * A stale-but-REAL utilization is strictly better than the estimate for the
 * spend ceiling (utilization moves slowly relative to the 5h/7d windows), so the
 * grace defaults to 30 minutes — riding through a multi-minute 429 burst
 * (servable window TTL+maxStale = ~35min) while still eventually falling to the
 * estimate during a genuine multi-hour outage. Overridable via
 * `HYDRA_OAUTH_USAGE_MAX_STALE_MS`. Raising the TTL would NOT fix the incident:
 * it only delays the next GET attempt, it does not extend how long a last-good
 * is trusted.
 */
export const DEFAULT_OAUTH_USAGE_MAX_STALE_MS = 1_800_000;

/**
 * Default OAuth-meter backoff BASE delay (issue #2619): after the first failed
 * external GET (a 429 or a transient network/timeout error) the read cadence
 * backs off — the NEXT external GET is suppressed until `now + base` even though
 * the TTL has expired, instead of the pre-#2619 behaviour of re-GETting on EVERY
 * post-TTL scan (~1–2 GETs/min against a rate-limited endpoint). Each further
 * consecutive failure DOUBLES the delay (`base * 2^(failures-1)`) up to
 * {@link DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS}. At 30s the first backoff already
 * collapses the ~90–100 failed-reads/hour steady state to a bounded exponential
 * curve. A SUCCESSFUL read resets the counter to zero — the healthy cadence is
 * the unchanged fixed TTL. Overridable via `HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS`.
 */
export const DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS = 30_000;

/**
 * Default OAuth-meter backoff CEILING (issue #2619): the exponential backoff
 * delay is clamped here so a prolonged outage settles at a fixed slow re-probe
 * cadence rather than growing unboundedly. At 15 minutes the meter re-probes at
 * most ~4 times/hour during a sustained 429 wave (vs the pre-#2619 ~60/hr), and
 * a recovered endpoint is still noticed within one ceiling interval. Sits above
 * the 5-min TTL so backoff genuinely SLOWS the cadence below the TTL floor
 * during an outage. Overridable via `HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS`.
 */
export const DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS = 900_000;

/**
 * Default per-token-type cache-read weight (issue #873): 1.0 = identity =
 * the pre-#873 full-weight behaviour. Keeping the default at identity makes an
 * unset `HYDRA_USAGE_CACHE_READ_WEIGHT` a pure no-op so the change is purely
 * calibration-gated (the principled ~0.1 production value lives in host config,
 * not a hardcoded constant fit to one week).
 */
export const DEFAULT_CACHE_READ_WEIGHT = 1.0;

/**
 * Default factor by which the tracker's `percentSinceReset` may diverge from
 * the operator-seeded reference reading before the once-per-scan drift warning
 * fires (issue #873). 2x in either direction — a coarse "calibration has
 * clearly rotted" signal, not a precise alarm.
 */
export const DEFAULT_DRIFT_FACTOR = 2;

/**
 * Default **Pacing Ceiling** (issue #857, ADR-0021): the sub-100% fraction of
 * the weekly quota the **Pacing Curve** climbs to by the next **Weekly Reset
 * Anchor**. The ~8% gap below 1.0 is the **Operator Reserve** (CONTEXT.md).
 *
 * Lives here as the `DEFAULT_*` constant of its sole reader
 * {@link getWeeklyPaceCeiling} (issue #1896): keeping it in `eligibility.ts`
 * while the reader moved here would force `config.ts` to import it back, which
 * would break this module's pure-leaf (acyclic) invariant. The pacing-curve
 * math that consumes the *ceiling fraction* (`projectPacingCurve`,
 * `PACE_STATE_TOLERANCE_PERCENT`) stays in `eligibility.ts` — only this reader
 * and its fallback constant moved.
 */
export const DEFAULT_WEEKLY_PACE_CEILING = 0.92;

export function getWeeklyQuotaTokens(): number {
  return parseQuotaEnv(process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS);
}

export function getFiveHourQuotaTokens(): number {
  return parseQuotaEnv(process.env.HYDRA_USAGE_5H_QUOTA_TOKENS);
}

function parseQuotaEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

/**
 * The OAuth-meter cache TTL in ms (issue #1090), from `HYDRA_OAUTH_USAGE_TTL_MS`,
 * falling back to {@link DEFAULT_OAUTH_USAGE_TTL_MS}. While a cached successful
 * read is younger than this, no external GET is made (the value is served as
 * fresh `usageSource:"oauth"`). A non-empty-but-invalid value (non-finite or
 * <= 0) is logged (fail-loud) and falls back to the default, mirroring the
 * other env readers. Pure + env-only so the cache math stays unit-testable.
 */
export function getOAuthUsageTtlMs(): number {
  const raw = process.env.HYDRA_OAUTH_USAGE_TTL_MS;
  if (raw === undefined || raw === "") return DEFAULT_OAUTH_USAGE_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[usage-tracker] HYDRA_OAUTH_USAGE_TTL_MS is set but not a positive finite ` +
        `number (${JSON.stringify(raw)}); falling back to default ${DEFAULT_OAUTH_USAGE_TTL_MS}`,
    );
    return DEFAULT_OAUTH_USAGE_TTL_MS;
  }
  return parsed;
}

/**
 * How long PAST the TTL a stale last-good OAuth value may still be served on a
 * failed read before the headline falls through to the transcript estimate
 * (issue #1090), from `HYDRA_OAUTH_USAGE_MAX_STALE_MS`, defaulting to
 * {@link DEFAULT_OAUTH_USAGE_MAX_STALE_MS} (30min, issue #2574). So the
 * lifecycle of one successful read is:
 *   - age < TTL                  → served fresh, no GET attempted (oauth)
 *   - TTL ≤ age < TTL+maxStale    → GET attempted; on failure served STALE (oauth+stale)
 *   - age ≥ TTL + maxStale        → too stale; falls through to the estimate
 * This realises AC2 ("a 429 keeps usageSource:oauth using last-good while a
 * recent value exists") AND AC3 ("after the OAuth TTL+maxStale with no
 * successful read, falls to estimate"). The default is DECOUPLED from the TTL
 * (issue #2574): it previously fell back to `getOAuthUsageTtlMs()`, which made
 * the too-stale cliff `TTL+TTL = 10min` and flipped ceiling enforcement onto the
 * fail-open estimate after a >10min 429 burst (the 2026-06-30 incident). The TTL
 * is the GET-cadence lever; this is the trust-window lever — they are tuned
 * independently. A non-empty-but-invalid value is logged (fail-loud) and falls
 * back to the default. Pure + env-only.
 */
export function getOAuthUsageMaxStaleMs(): number {
  const raw = process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS;
  if (raw === undefined || raw === "") return DEFAULT_OAUTH_USAGE_MAX_STALE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[usage-tracker] HYDRA_OAUTH_USAGE_MAX_STALE_MS is set but not a positive ` +
        `finite number (${JSON.stringify(raw)}); falling back to default ${DEFAULT_OAUTH_USAGE_MAX_STALE_MS}`,
    );
    return DEFAULT_OAUTH_USAGE_MAX_STALE_MS;
  }
  return parsed;
}

/**
 * The OAuth-meter backoff BASE delay in ms (issue #2619), from
 * `HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS`, falling back to
 * {@link DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS}. After a failed external GET the
 * next GET is suppressed until `now + base * 2^(consecutiveFailures-1)` (capped
 * by {@link getOAuthUsageBackoffMaxMs}), so a rate-limited endpoint is re-probed
 * on an exponential-backoff cadence rather than on every post-TTL scan. A
 * non-empty-but-invalid value (non-finite or <= 0) is logged (fail-loud) and
 * falls back to the default. Pure + env-only so the backoff math stays
 * unit-testable.
 */
export function getOAuthUsageBackoffBaseMs(): number {
  const raw = process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS;
  if (raw === undefined || raw === "") return DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[usage-tracker] HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS is set but not a positive ` +
        `finite number (${JSON.stringify(raw)}); falling back to default ${DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS}`,
    );
    return DEFAULT_OAUTH_USAGE_BACKOFF_BASE_MS;
  }
  return parsed;
}

/**
 * The OAuth-meter backoff CEILING in ms (issue #2619), from
 * `HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS`, falling back to
 * {@link DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS}. The exponential backoff delay is
 * clamped to this, so a prolonged outage settles at a fixed slow re-probe
 * cadence. A non-empty-but-invalid value (non-finite or <= 0) is logged
 * (fail-loud) and falls back to the default. Pure + env-only.
 */
export function getOAuthUsageBackoffMaxMs(): number {
  const raw = process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS;
  if (raw === undefined || raw === "") return DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[usage-tracker] HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS is set but not a positive ` +
        `finite number (${JSON.stringify(raw)}); falling back to default ${DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS}`,
    );
    return DEFAULT_OAUTH_USAGE_BACKOFF_MAX_MS;
  }
  return parsed;
}

/**
 * The operator-seeded **Weekly Reset Anchor** as epoch-ms, or `null` when
 * `HYDRA_USAGE_WEEKLY_RESET_ANCHOR` is unset/empty/unparseable. A bad value
 * is treated as unset (returns null) rather than throwing — the since-reset
 * fields stay neutral, mirroring the uncalibrated-quota discipline. A
 * non-empty-but-unparseable value is logged (fail-loud) since it signals a
 * mis-configured env var the operator should fix.
 */
export function getWeeklyResetAnchorMs(): number | null {
  const raw = process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
  if (raw === undefined || raw === "") return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    console.error(
      `[usage-tracker] HYDRA_USAGE_WEEKLY_RESET_ANCHOR is set but not a valid ISO-8601 instant (${JSON.stringify(
        raw,
      )}); treating Weekly Reset Anchor as unset`,
    );
    return null;
  }
  return parsed;
}

/**
 * The operator-tunable per-token-type cache-read weight `w_cache` from
 * `HYDRA_USAGE_CACHE_READ_WEIGHT`. Unset/empty falls back to
 * {@link DEFAULT_CACHE_READ_WEIGHT} (identity). A non-empty-but-bad value
 * (non-finite or <= 0) is logged (fail-loud) and also falls back to the
 * default, since it signals a mis-configured env var the operator should fix.
 * Pure + env-only so the weighted-unit math stays unit-testable. (issue #873)
 */
export function getCacheReadWeight(): number {
  const raw = process.env.HYDRA_USAGE_CACHE_READ_WEIGHT;
  if (raw === undefined || raw === "") return DEFAULT_CACHE_READ_WEIGHT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[usage-tracker] HYDRA_USAGE_CACHE_READ_WEIGHT is set but not a positive ` +
        `finite number (${JSON.stringify(raw)}); falling back to default ` +
        `${DEFAULT_CACHE_READ_WEIGHT}`,
    );
    return DEFAULT_CACHE_READ_WEIGHT;
  }
  return parsed;
}

/**
 * Operator-seeded reference `percentSinceReset` for drift detection, or `null`
 * when `HYDRA_USAGE_DRIFT_REFERENCE_PERCENT` is unset/empty/non-positive. A
 * non-empty-but-bad value is logged (fail-loud). Unset => drift detection is
 * inert (no false alarms). (issue #873)
 */
export function getDriftReferencePercent(): number | null {
  const raw = process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT;
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[usage-tracker] HYDRA_USAGE_DRIFT_REFERENCE_PERCENT is set but not a ` +
        `positive finite number (${JSON.stringify(raw)}); drift detection inert`,
    );
    return null;
  }
  return parsed;
}

/**
 * The drift-warning divergence factor from `HYDRA_USAGE_DRIFT_FACTOR`, falling
 * back to {@link DEFAULT_DRIFT_FACTOR}. Must be > 1 to be meaningful; a value
 * <= 1 (or non-finite) is logged and falls back to the default. (issue #873)
 */
export function getDriftFactor(): number {
  const raw = process.env.HYDRA_USAGE_DRIFT_FACTOR;
  if (raw === undefined || raw === "") return DEFAULT_DRIFT_FACTOR;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 1) {
    console.error(
      `[usage-tracker] HYDRA_USAGE_DRIFT_FACTOR is set but not a finite number ` +
        `> 1 (${JSON.stringify(raw)}); falling back to default ${DEFAULT_DRIFT_FACTOR}`,
    );
    return DEFAULT_DRIFT_FACTOR;
  }
  return parsed;
}

export function getQuotaWeightOpus(): number {
  return parseQuotaEnv(process.env.HYDRA_QUOTA_WEIGHT_OPUS);
}

export function getQuotaWeightSonnet(): number {
  return parseQuotaEnv(process.env.HYDRA_QUOTA_WEIGHT_SONNET);
}

export function getQuotaWeightHaiku(): number {
  return parseQuotaEnv(process.env.HYDRA_QUOTA_WEIGHT_HAIKU);
}

/**
 * The operator-tunable **Pacing Ceiling** as a fraction in (0, 1], read from
 * `HYDRA_USAGE_WEEKLY_PACE_CEILING`. Unset/empty/unparseable/out-of-range
 * falls back to {@link DEFAULT_WEEKLY_PACE_CEILING} (a non-empty-but-bad value
 * is logged, fail-loud, since it signals a mis-configured env var). Values
 * above 1.0 are clamped to 1.0; values <= 0 fall back to the default. Pure +
 * env-only so the curve math stays unit-testable. (issue #857)
 *
 * Moved here from `eligibility.ts` (issue #1896) to consolidate all env-config
 * readers in one leaf: `eligibility.ts` now imports this value from `config.ts`
 * instead of defining it, while keeping the Pacing-Curve math that consumes the
 * fraction.
 */
export function getWeeklyPaceCeiling(): number {
  const raw = process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING;
  if (raw === undefined || raw === "") return DEFAULT_WEEKLY_PACE_CEILING;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `[usage-tracker] HYDRA_USAGE_WEEKLY_PACE_CEILING is set but not a finite number in (0, 1] (${JSON.stringify(
        raw,
      )}); falling back to default ${DEFAULT_WEEKLY_PACE_CEILING}`,
    );
    return DEFAULT_WEEKLY_PACE_CEILING;
  }
  return Math.min(parsed, 1);
}

/** Default Tier-1 5h-utilization throttle threshold (fraction of quota). */
export const DEFAULT_FIVE_HOUR_THROTTLE_T1 = 0.6;
/** Default Tier-2 5h-utilization throttle threshold (fraction of quota). */
export const DEFAULT_FIVE_HOUR_THROTTLE_T2 = 0.75;

/**
 * Read a 5h-throttle threshold env var as a fraction in (0, 1). Unset/empty →
 * `fallback`. Set-but-invalid (non-finite, ≤0, or ≥1) → `fallback` with a
 * fail-loud `console.error`, mirroring {@link getWeeklyPaceCeiling}'s discipline
 * (a mis-configured env var is visible, never silently honoured). (issue #1087)
 *
 * Relocated VERBATIM out of `eligibility.ts` into this pure env-reader leaf
 * (issue #2550): all Cost-family env parsing now lives here, alongside its
 * `getFiveHourThrottleT1` / `getFiveHourThrottleT2` callers, so the env-read
 * seam stays distinct from the `fiveHourThrottleShed` dispatch-gating policy
 * fold (which becomes a pure fold over already-parsed thresholds).
 */
function getFiveHourThrottleThreshold(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    console.error(
      `[usage-tracker] ${envVar} is set but not a finite fraction in (0, 1) (${JSON.stringify(
        raw,
      )}); falling back to default ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * The Tier-1 5h-utilization throttle threshold from
 * `HYDRA_USAGE_5H_THROTTLE_T1` (fraction in (0, 1)); falls back to
 * {@link DEFAULT_FIVE_HOUR_THROTTLE_T1}. (issue #1087, relocated #2550)
 */
export function getFiveHourThrottleT1(): number {
  return getFiveHourThrottleThreshold(
    "HYDRA_USAGE_5H_THROTTLE_T1",
    DEFAULT_FIVE_HOUR_THROTTLE_T1,
  );
}

/**
 * The Tier-2 5h-utilization throttle threshold from
 * `HYDRA_USAGE_5H_THROTTLE_T2` (fraction in (0, 1)); falls back to
 * {@link DEFAULT_FIVE_HOUR_THROTTLE_T2}. (issue #1087, relocated #2550)
 */
export function getFiveHourThrottleT2(): number {
  return getFiveHourThrottleThreshold(
    "HYDRA_USAGE_5H_THROTTLE_T2",
    DEFAULT_FIVE_HOUR_THROTTLE_T2,
  );
}
