/**
 * src/cost/types.ts — the pure TYPE-vocabulary leaf of the **Cost** Module's
 * Subscription Usage Tracker.
 *
 * Owns the assembled-snapshot shape ({@link UsageSnapshot}) and its per-skill
 * week-over-week entry ({@link SkillWoWEntry}) — the Cost-domain types the pure
 * leaves (`snapshot-assembly.ts`, `eligibility.ts`) and the I/O coordinator
 * (`usage-tracker.ts`) all build on top of. Relocated here out of the I/O
 * coordinator (`usage-tracker.ts`) and out of `snapshot-assembly.ts` (issue
 * #3071) so the type that describes the module's public output lives at the
 * module boundary — the same place `BacklogItem` lives in `src/backlog/types.ts`.
 *
 * ADR-0042 Decision 5 (issue #4781) widened this leaf into the module's WHOLE
 * shared vocabulary: the boundary types that used to live in higher-layer files
 * and were imported upwards by lower ones moved here, verbatim — the OAuth meter
 * shapes ({@link OAuthUsageData}, {@link OAuthUsageResult},
 * {@link OAuthUsageErrorCode}) out of `oauth-usage.ts`, {@link CachedOAuthRead}
 * out of `oauth-read-cache.ts`, {@link ScanResult} out of `transcript-scan.ts`,
 * and {@link EligibilityUsageInput} out of `eligibility-usage.ts`. Each old path
 * keeps a re-export under the old name (the #3513 precedent), so no importer
 * changes; the point is that the FOUR upward edges those imports formed
 * (`types → transcript-scan`, `eligibility → eligibility-usage`,
 * `snapshot-assembly → oauth-usage`, `snapshot-assembly → transcript-scan`) are
 * gone without blessing any of them — vocabulary moves DOWN, never an exception
 * list.
 *
 * Import direction is strictly one-way and DOWNWARD: this leaf imports ONLY
 * same/lower-layer primitive types (`TokenBreakdown`, `ModelFamily` from
 * `token-math.ts`; `DispatchKind` from `token-breakdown.ts` — its defining file,
 * reached directly since #4781 instead of through the `transcript-scan.ts`
 * re-export that formed the first upward edge; `HydraErrorCode` from
 * `../errors.ts`, type-only) — never from the I/O coordinator or the folds that
 * consume it. Before the #3071 move, both pure leaves had to
 * `import type { UsageSnapshot } from "./usage-tracker.ts"` (a backwards edge
 * from a pure leaf onto the I/O coordinator); now they import from HERE, so a
 * new pure consumer of the snapshot type (a test scorer, a future cost-cap
 * comparator) no longer drags the transcript-scan / OAuth-read I/O chain into
 * its import closure.
 *
 * Pure: all `import type` (fully compile-erased); zero runtime edges, zero I/O,
 * zero Redis. `usage-tracker.ts` imports `UsageSnapshot` FROM here (downward, as
 * its sole consumer of the type it assembles); `cost/index.ts` re-exports it
 * from here so every existing `from "../cost/index.ts"` import site is unchanged.
 */

// Pure primitive types from the lower leaves. `TokenBreakdown` / `ModelFamily`
// are the per-family token math vocabulary (`./token-math.ts`, issue #1909);
// `DispatchKind` is the dispatch-partition key (`./token-breakdown.ts`, issue
// #2403 — the defining leaf, not the `transcript-scan.ts` re-export; #4781).
// `HydraErrorCode` is the repo-wide result-object code union (`../errors.ts`)
// that `OAuthUsageErrorCode` Extracts its slice from — type-only, so no runtime
// edge leaves src/cost/. Importing type-only from these DOWNWARD leaves keeps
// this the module's type-vocabulary root — it imports nothing from the I/O
// coordinator or the folds.
import type { TokenBreakdown, ModelFamily } from "./token-math.ts";
import type { DispatchKind } from "./token-breakdown.ts";
import type { HydraErrorCode } from "../errors.ts";

/** A single skill's week-over-week trend entry (issue #2404). */
export interface SkillWoWEntry {
  /** This week's RAW total tokens for the skill (sum over model families). */
  current: number;
  /**
   * The SAME skill's RAW total in the immediately-prior stored Weekly Usage
   * Snapshot, or `null` when no prior snapshot exists OR the skill is absent
   * from it (a "new this week" skill).
   */
  prior: number | null;
  /**
   * Percentage change `(current - prior) / prior * 100`, or `null` when it
   * cannot be meaningfully computed: no prior snapshot, the skill is new this
   * week, or the prior total was 0 (avoids divide-by-zero / Infinity).
   */
  deltaPct: number | null;
}

export interface UsageSnapshot {
  tokensLast5h: TokenBreakdown;
  tokensLast7d: TokenBreakdown;
  /** Raw token total over the last 24h. Drives `projectedWeeklyPercent`. */
  tokensLast24h: number;
  /**
   * Raw 7d token total spent on a NON-Anthropic provider's quota (issue #3769)
   * — today `glm-*` on z.ai for the GLM dev-drainer worker lane (ADR-0032).
   *
   * Reported ALONGSIDE the Anthropic fields, never folded into them: every
   * other field on this snapshot is an Anthropic-subscription quantity, and
   * `percentLast7d` (which gates `weeklyEmergencyStop` and the Pacing Curve)
   * must not move because a different provider did work. Treating these tokens
   * as Anthropic spend inverts the drainer lane's purpose — see
   * `isForeignProviderModel` for the measured case.
   *
   * This is the number the ADR-0032 beachhead report (#3690) plots against the
   * Anthropic `percentLast7d` delta: GLM spend UP while Anthropic spend DOWN is
   * the lane working.
   */
  tokensForeignLast7d: number;
  /**
   * % of 5h quota consumed. SOURCE PRECEDENCE (issue #1083): the authoritative
   * OAuth `/api/oauth/usage` five_hour utilization when the meter read
   * succeeds; otherwise the transcript+calibration estimate (0 when
   * uncalibrated). NEVER silently 0 on a failed meter read — a failed read
   * degrades to the estimate so `emergencyStop` (>=90%) stays conservative
   * rather than unblocking dispatch during an OAuth outage. Which source backs
   * the value is reported in {@link usageSource}.
   */
  percentLast5h: number;
  /**
   * % of weekly quota consumed. SOURCE PRECEDENCE (issue #1083): the
   * authoritative OAuth `/api/oauth/usage` seven_day utilization when the meter
   * read succeeds; otherwise the transcript+calibration estimate (0 when
   * uncalibrated). See {@link percentLast5h} for the never-silently-0 invariant
   * and {@link usageSource}. Distinct from `percentSinceReset`, which is Hydra's
   * env-anchored fixed-window projection and is left UNCHANGED by this seam.
   */
  percentLast7d: number;
  /**
   * Which source backs the headline `percentLast5h`/`percentLast7d` (issue
   * #1083): `"oauth"` when the authoritative OAuth meter read succeeded,
   * `"estimate"` when it fell back to the transcript+calibration estimate (the
   * meter read failed, the token expired, or no credentials were found).
   * Additive observability field — no gating reads it; it lets the dashboard /
   * operator see whether the number is ground truth or a fallback guess.
   */
  usageSource: "oauth" | "estimate";
  /**
   * The `oauth-usage-*` failure code when {@link usageSource} is `"estimate"`
   * because the OAuth read failed, or `null` when a FRESH meter read succeeded.
   * When a STALE last-good value backs the headline (issue #1090), this is the
   * sentinel `"oauth-usage-stale"` (and {@link oauthStale} is true). Additive
   * observability — surfaces WHY the fallback / staleness happened (e.g.
   * `oauth-usage-token-expired` => operator should re-login). (issue #1083, #1090)
   */
  oauthError: string | null;
  /**
   * True when the OAuth-backed headline is a STALE last-good value served
   * because a fresh meter read failed (e.g. a transient 429) but a recent-enough
   * cached value existed (issue #1090). `usageSource` is still `"oauth"` in this
   * case — the headline stays on ground truth rather than flipping to the
   * estimate. False on a fresh read AND on the estimate fallback. Additive.
   */
  oauthStale: boolean;
  /**
   * Age in ms of the OAuth value backing the headline (issue #1090): `0` for a
   * fresh read, the cached value's age when served fresh-from-cache OR served
   * stale, and `null` on the estimate fallback (no OAuth value backs the
   * headline). Additive observability — lets the dashboard show "OAuth meter:
   * Ns old" / "stale". (issue #1090)
   */
  oauthAgeMs: number | null;
  /**
   * ISO-8601 of the real 5-hour window reset boundary from the OAuth meter, or
   * `null` when the meter read failed OR the meter reported no boundary.
   * Additive — distinct from the env-anchored `weeklyResetAnchor`; this is the
   * server's authoritative boundary. NOT yet wired into the ADR-0021 Pace Gate
   * (deliberately deferred — see issue #1083). (issue #1083)
   */
  oauthFiveHourResetsAt: string | null;
  /**
   * ISO-8601 of the real 7-day window reset boundary from the OAuth meter, or
   * `null` when the meter read failed OR reported no boundary. Additive; see
   * {@link oauthFiveHourResetsAt}. (issue #1083)
   */
  oauthSevenDayResetsAt: string | null;
  /**
   * Fraction of the weekly window already elapsed at `generatedAt`:
   * `(now - windowStart) / 7d`, clamped to [0, 1]. Window-start precedence:
   * the OAuth meter's `sevenDayResetsAt - 7d` first (the issue-#4121
   * formula), the Weekly Reset Anchor boundary (`weeklyResetAnchor`) second
   * — so an Anchor-seeded tracker keeps a window reference even on the
   * estimate-fallback path. `null` when neither boundary is known. Shipped
   * with {@link paceRatio} so a `% consumed` headline can be read against
   * where the window actually stands (issue #4121: 67% consumed at 70%
   * elapsed is UNDER linear pace, but pre-#4121 read as "over" because
   * pacingState extrapolated a single busy day across seven).
   */
  windowElapsedFraction: number | null;
  /**
   * `percentLast7d / (100 * windowElapsedFraction)` — consumption relative to
   * LINEAR weekly pace: `< 1` under pace, `> 1` over pace, `1.0` exactly on
   * it. `null` when {@link windowElapsedFraction} is null or clamped to 0 (no
   * window position to ratio against). (issue #4121)
   */
  paceRatio: number | null;
  /**
   * If we continued at the last-24h rate for a full 7 days, what % of
   * weekly quota would that be? 0 when uncalibrated. FORWARD-LOOKING BURST
   * PROJECTION, deliberately NOT a pace verdict (issue #4121): one hotter-
   * than-average day projects past 100% regardless of how much of the week
   * remains. Read it NEXT TO `percentLast7d` + `windowElapsedFraction`
   * (or {@link paceRatio}), never alone.
   */
  projectedWeeklyPercent: number;
  /**
   * Position relative to LINEAR weekly pace (issue #4121): with a window
   * position ({@link windowElapsedFraction} > 0) the linear target is
   * `100 * windowElapsedFraction` % of quota and `percentLast7d` is compared
   * against it within ±2pp — "over" above the band (consumed faster than the
   * window's linear rate; the `projectEligibility` pacing shed and the
   * overnight summary's red status key off this), "on" inside it, "under"
   * below it (67% at 70% elapsed reads "under"). With NO window position
   * (no OAuth boundary and no Anchor) it falls back to the pre-#4121
   * `projectedWeeklyPercent` thresholds (> 100 "over", 80–100 "on"),
   * preserving the status quo for un-Anchor'd accounts. Uncalibrated runs
   * are always "under", unchanged. CHANGED in #4121 — previously ALWAYS keyed
   * off the projection thresholds, which read a single busy day as "over"
   * with most of the weekly budget unspent.
   */
  pacingState: "under" | "on" | "over";
  /**
   * True only when calibrated AND percentLast5h >= 90. Wired to
   * `projectEligibility` (allow=false), so it skips the autopilot tick
   * entirely — every dispatch class is blocked while it holds.
   */
  emergencyStop: boolean;
  /**
   * Weekly analogue of {@link emergencyStop}: true only when calibrated AND
   * `percentSinceReset >= 90` — i.e. ≥90% of the weekly quota has been burned
   * since the current **Weekly Reset Anchor** boundary. Gates `allow=false`
   * in `projectEligibility` exactly like `emergencyStop`, blocking ALL
   * dispatch classes (not just the sheddable ones) until the weekly window
   * resets. Uses the reset-aligned `percentSinceReset` (NOT the rolling
   * `percentLast7d`) because that is what "90% of the weekly limit" means
   * against the interactive `/usage` view. Stays false whenever the Weekly
   * Reset Anchor is unset (percentSinceReset is then 0) or the quota is
   * uncalibrated — mirroring the all-or-nothing calibration discipline.
   */
  weeklyEmergencyStop: boolean;
  /** True only when both quota env vars are set to positive values. */
  calibrated: boolean;
  /**
   * Per-model-family token breakdown over the 7d window. ALWAYS populated
   * with all four family keys (opus/sonnet/haiku/unknown), zero-valued when
   * a family produced no tokens — independent of calibration. (issue #691)
   */
  byModel: Record<ModelFamily, TokenBreakdown>;
  /**
   * Per-skill × per-model-family token breakdown over the 7d window. The outer
   * key is the dispatching skill derived IN-TRANSCRIPT from the session's first
   * user message (issue #2402): the `hydra-dispatch` sentinel `skill=` wins,
   * else a leading `/command-name` slash marker, else the residual bucket
   * `skill = "interactive"` (see {@link INTERACTIVE_SKILL}); the inner key is
   * the model family. Attribution reads NO Redis and no longer depends on the
   * subagent-dispatch registry or the SessionStart hook (issue #2401) — it is
   * recomputed every scan from on-disk transcripts, so it backfills any
   * transcript carrying a sentinel/marker with no migration.
   *
   * Reconciliation invariant: for each family `f`,
   * `Σ_skill bySkillByModel[skill][f].total === byModel[f].total`. Only skills
   * that produced tokens in the window appear; each present skill carries all
   * four family keys (zero-valued where the skill produced none). Pure
   * read-side projection — NO new Redis writes. (issue #693, #2402)
   */
  bySkillByModel: Record<string, Record<ModelFamily, TokenBreakdown>>;
  /**
   * Per-skill × per-model-family token breakdown over the 24h window — a mirror
   * of {@link bySkillByModel} gated on the 24h cutoff (issue #3752). The
   * comprehensive cost-by-class rollup (`src/cost/cost-by-class.ts`) re-
   * projects this through `skillToCostClass` so the rolling cost-by-class arm's
   * per-class tokens sum to THIS snapshot's {@link tokensLast24h} — the headline
   * coverage invariant: the per-class `fraction` becomes a share of real burn,
   * not a share of the (partial) dispatch-observed surrogate.
   *
   * Reconciliation invariant: `Σ_skill Σ_family bySkillByModel24h[skill][f].total
   * === tokensLast24h`. Only skills that produced tokens in the 24h window
   * appear; each present skill carries all four family keys (zero-valued where
   * the skill produced none). Accumulated during the SAME transcript walk as the
   * 7d cross-tab — no additional filesystem scan. Pure read-side projection.
   * (issue #3752)
   */
  bySkillByModel24h: Record<string, Record<ModelFamily, TokenBreakdown>>;
  /**
   * Per-skill WEEK-OVER-WEEK trend (issue #2404). For each skill present in
   * `bySkillByModel`, `{current, prior, deltaPct}` of its RAW total tokens this
   * week vs the SAME skill in the immediately-prior stored **Weekly Usage
   * Snapshot** (`src/redis/usage-snapshots.ts`). `prior`/`deltaPct` are `null`
   * for a skill that is "new this week" (absent from the prior snapshot), when
   * no prior snapshot exists yet (the first week, or after the 30-day TTL aged
   * it out), or when Redis was unreachable. RAW token counts only — no
   * quota-weight, no USD — matching the `bySkillByModel` read-only posture.
   *
   * PURE read-side projection: the prior-week totals are fetched by
   * `getUsage()` via the typed accessor and INJECTED into the otherwise
   * Redis-free `assembleSnapshot()` (ADR-0021). The persisted snapshot itself
   * is written by the weekly Housekeeping chore, never on this read path.
   */
  bySkillWoW: Record<string, SkillWoWEntry>;
  /**
   * Per-DISPATCH-KIND × per-model-family token breakdown over the 7d window
   * (issue #2403). A SECOND partition over the SAME per-file tokens as
   * {@link bySkillByModel}, keyed by how the session was dispatched:
   *   - `autopilot-dispatched` — the `hydra-dispatch` sentinel matched (a
   *     background Agent-tool dispatch; runId present iff the sentinel matched).
   *   - `operator-invoked` — a `<command-name>` / leading-`/` slash marker (the
   *     operator typed or ran a slash command).
   *   - `interactive` — neither matched (a plain interactive session); the SAME
   *     residual `bySkillByModel` buckets under `INTERACTIVE_SKILL`.
   * ALWAYS carries all three kind keys (zero-valued where a kind produced no
   * tokens). Reconciliation invariant: for each family `f`,
   * `Σ_kind byDispatchKind[kind][f].total === byModel[f].total`. RAW token
   * counts only — no quota-weight, no USD. Pure read-side projection, never
   * persisted. (issue #2403)
   */
  byDispatchKind: Record<DispatchKind, Record<ModelFamily, TokenBreakdown>>;
  /**
   * **Attribution coverage %** (issue #2403): `(total - interactive) / total *
   * 100` over the {@link byDispatchKind} cross-tab — the inverse of the
   * `interactive`-residual token share over the 7d window. In `[0, 100]`; 0 when
   * no tokens were recorded OR every token is interactive (the metric #2402
   * drives up by shrinking the residual). RAW token counts only, never
   * persisted. (issue #2403)
   */
  attributedPercent: number;
  /**
   * Quota-Weight burn over the 5h window: `Σ family.total * weight(family)`
   * (opus/sonnet/haiku from env, unknown implicit 1.0). Exactly 0 unless ALL
   * THREE HYDRA_QUOTA_WEIGHT_* env vars are set to positive values, mirroring
   * the all-or-nothing percentage gate. (issue #691)
   */
  quotaWeightLast5h: number;
  /** Quota-Weight burn over the 7d window; same gate as `quotaWeightLast5h`. */
  quotaWeightLast7d: number;
  /** True only when all three HYDRA_QUOTA_WEIGHT_* env vars are positive. */
  quotaWeightCalibrated: boolean;
  weeklyQuotaTokens: number;
  fiveHourQuotaTokens: number;
  filesScanned: number;
  filesSkippedByMtime: number;
  linesParsed: number;
  linesWithUsage: number;
  parseErrors: number;
  /**
   * Count of `filesScanned` files served from the per-file parse memo instead
   * of a fresh read + JSON.parse (issue #3805) — the direct evidence that the
   * cold-scan cost regression the memo fixes is actually being avoided.
   * `filesServedFromMemo <= filesScanned`; 0 on every scan's first-ever cold
   * pass over a given file (nothing to replay yet).
   */
  filesServedFromMemo: number;
  /** ISO timestamp anchor used to compute the rolling windows. */
  generatedAt: string;
  /**
   * Cache-hit ratio over the 5h window, in the closed interval [0, 1].
   * Formula: cacheRead / (cacheRead + cacheCreation + input). Output
   * tokens are excluded (not cache-eligible); cacheCreation is in the
   * denominator on purpose so the ratio honestly accounts for the cost
   * of warming the cache. Returns 0 when the denominator is 0 (no
   * division by zero) — the same uncalibrated-returns-0 discipline the
   * rest of the tracker follows. Higher is better; a falling ratio means
   * the next window's tokens get more expensive.
   */
  cacheHitRatioLast5h: number;
  /** Cache-hit ratio over the 7d window. Same formula/invariants as `cacheHitRatioLast5h`. */
  cacheHitRatioLast7d: number;
  /**
   * Fixed-window token breakdown summed since the current **Weekly Reset
   * Anchor** boundary (the most recent `anchor + 7d*k <= now`, auto-corrected
   * to a more recent observed reset when one is seen in a transcript). Same
   * shape as `tokensLast7d` but a CALENDAR-window sum, not a trailing one —
   * it drops to ~0 right after each weekly reset. All-zero when the Anchor
   * env var is unset/unparseable. (issue #856, ADR-0021)
   */
  tokensSinceReset: TokenBreakdown;
  /**
   * % of the weekly quota consumed since the current Weekly Reset Anchor
   * boundary (`tokensSinceReset.total / weeklyQuota * 100`). 0 when the
   * Anchor is unset OR the weekly quota is uncalibrated. Distinct from the
   * rolling `percentLast7d`. (issue #856)
   */
  percentSinceReset: number;
  /**
   * ISO-8601 string of the EFFECTIVE current-window reset boundary the
   * since-reset metric is summed from, or `null` when the Anchor env var is
   * unset/unparseable. The effective boundary is the env projection's
   * `currentMs`, overridden by a more recent observed rate-limit reset when
   * one is present in the transcripts. (issue #856)
   */
  weeklyResetAnchor: string | null;
}

// ---------------------------------------------------------------------------
// Relocated shared vocabulary (ADR-0042 Decision 5, issue #4781)
// ---------------------------------------------------------------------------
// The boundary types below each used to live in a higher-layer file, which
// forced lower-layer files to import UPWARD to reach them. They moved here
// VERBATIM (same shape, same doc-comment) so every edge in `src/cost/` points
// down; each former owner re-exports its type at the old name so no importer
// changes. This leaf stays TYPES-ONLY — the pure OAuth meter HELPERS that
// consume this vocabulary live in the L1 leaf `./oauth-meter-shape.ts`.

/** The subset of `HydraErrorCode` the OAuth Usage Adapter can return. */
export type OAuthUsageErrorCode = Extract<HydraErrorCode, `oauth-usage-${string}`>;

/**
 * One rolling-utilization window from the OAuth meter. `utilization` is a
 * direct 0–100 percent (NOT a fraction). `resetsAt` is the real window
 * boundary as an ISO-8601 string, or `null` when the meter reported a
 * non-string / unparseable / absent boundary.
 */
export interface OAuthUsageWindow {
  utilization: number;
  resetsAt: string | null;
}

/**
 * The account's paid-overage ("extra usage") facility, as reported by the
 * meter's `extra_usage` object.
 *
 * Subscription quota is prepaid; **extra usage bills real money OUTSIDE the
 * subscription** once a window is exhausted. It is an account-level setting,
 * not a Hydra one, so it silently follows a `/login` to a different account the
 * same way the meter itself does — which is exactly why a gate keyed off
 * {@link armed} must live in code rather than in a per-account env constant.
 */
export interface OAuthExtraUsage {
  /**
   * True when overage CAN bill: the facility is enabled AND the user has not
   * switched it off. This is a CAPABILITY flag, not evidence of spend — see
   * {@link usedCredits} for that.
   */
  armed: boolean;
  /**
   * The meter's raw `used_credits` counter, or `null` when absent/non-numeric.
   *
   * DELIBERATELY UNINTERPRETED. The meter reports `used_credits`,
   * `monthly_limit`, `currency` and `decimal_places` whose units do not
   * self-consistently reconcile with the sibling `utilization` field (observed
   * 2026-08-14: used_credits=51547, monthly_limit=1000, decimal_places=2,
   * utilization=100.0 — 51547 reads as $515.47 against $1000, i.e. 51.5%, not
   * 100%). Treat this as an opaque MONOTONIC COUNTER: a change means overage
   * was billed. Never render it as a currency amount, and never divide it by
   * the limit.
   */
  usedCredits: number | null;
}

/**
 * The parsed, gating-relevant slice of the OAuth meter. Two rolling windows —
 * the 5-hour (drives the 5h `emergencyStop`) and the 7-day (the weekly
 * headline) — plus the account's paid-overage facility. The opus/sonnet
 * sub-windows the endpoint also returns are not part of this contract.
 *
 * `extraUsage` is OPTIONAL so the many `OAuthUsageData` literals already in the
 * test suite keep type-checking; an absent value reads as "no overage
 * facility", never as "armed".
 */
export interface OAuthUsageData {
  fiveHour: OAuthUsageWindow;
  sevenDay: OAuthUsageWindow;
  extraUsage?: OAuthExtraUsage;
}

/**
 * The discriminated result the OAuth Usage Adapter (`./oauth-usage.ts`)
 * returns. `ok:true` carries the parsed {@link OAuthUsageData}; `ok:false`
 * carries a machine-readable `oauth-usage-*` code. Callers discriminate on
 * `code`, NEVER on prose. CRITICAL: a failure result must make the caller FALL
 * BACK to the transcript estimate — it must never be read as "0% utilization"
 * (which would wrongly unblock dispatch during an OAuth outage; issue #1083
 * gate-safe invariant).
 *
 * `retryAfterMs` (issue #2666) is ADDITIVE and only ever populated on the
 * `oauth-usage-rate-limited` (429) failure: the server's parsed `Retry-After`
 * hint in ms, clamped to the maxStale ceiling. The cadence layer may use it
 * only to LENGTHEN its exponential backoff, never to shorten it.
 */
export type OAuthUsageResult =
  | { ok: true; data: OAuthUsageData }
  | { ok: false; code: OAuthUsageErrorCode; retryAfterMs?: number };

/**
 * The OAuth read fed into one scan, after the independent-TTL + last-good cache
 * layer (`./oauth-read-cache.ts`, issue #1090). Distinct from the raw
 * {@link OAuthUsageResult}: it also tells the scan whether the value it carries
 * is a STALE last-good (`stale`) and how old it is (`ageMs`), so the snapshot
 * can surface those observability fields. `result.ok === true` covers BOTH a
 * fresh read AND a served-stale last-good — in either case the headline rebases
 * onto OAuth ground truth; only `result.ok === false` falls through to the
 * transcript estimate.
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
   * INCLUDING the too-stale case where the cache is about to be evicted from
   * the HEADLINE (issue #4165 keeps this value in a separate eviction-surviving
   * singleton, so it stays populated after the cliff rather than going null one
   * read later). Distinct from what backs
   * the headline: on the estimate-fallback path `result.ok === false` (the
   * headline is the estimate) yet `lastKnownOAuth` can still carry the last real
   * meter reading, which is exactly the baseline the AC3 divergence detector
   * compares the fail-open estimate against. Carries the whole
   * {@link OAuthUsageData} (both windows) so the detector can compare against the
   * 7d utilization. A pure observability channel — nothing gates on it.
   */
  lastKnownOAuth: OAuthUsageData | null;
  /**
   * Age in ms of {@link lastKnownOAuth} at the moment this result was produced,
   * or `null` when no last-known value exists (issue #4165).
   *
   * Distinct from {@link ageMs}, which is the age of the value backing the
   * HEADLINE and is `null` on every failure branch. This one survives the
   * too-stale eviction, so a caller can answer "how old is the newest real
   * reading we have?" even while the headline has fallen through to the
   * estimate. The admission verdict uses it to decide whether a stale-but-known
   * reading is still fit to gate spend on.
   *
   * OPTIONAL so the pre-existing {@link CachedOAuthRead} literals (the
   * `bypassOAuthCache` path and test fixtures) keep compiling; absent reads as
   * `null`.
   */
  lastKnownOAuthAgeMs?: number | null;
  /**
   * The current consecutive-failed-GET count backing the backoff ladder, or
   * `0` when the meter is healthy (no active backoff — either it has never
   * failed, or the most recent read succeeded and cleared the ladder). Mirrors
   * `oauthBackoff?.failures ?? 0` at the moment this result is produced,
   * including on the backoff-suppressed synthetic-failure branch (no GET made,
   * but the count carries forward from the last real attempt). Issue #3821:
   * this is what lets a caller (`eligibility-usage.ts`) distinguish "one
   * transient blip" from "a genuinely sustained outage" instead of treating
   * every `result.ok === false` as equally severe.
   */
  consecutiveFailures: number;
}

/**
 * The raw accumulation produced by the JSONL walk + OAuth read
 * (`./transcript-scan.ts`) — the INTERNAL boundary between the I/O phase and
 * the pure snapshot-assembly phase (`./snapshot-assembly.ts`). NEVER added to
 * the public `src/cost/index.ts` surface (issue #1971). It carries everything
 * the pure assembler reads; the `now`/cutoffs and env weights are recomputed
 * caller-side.
 */
export interface ScanResult {
  /** Flat 5h / 7d window token totals (the `tokensLast5h` / `tokensLast7d` fields). */
  acc5h: TokenBreakdown;
  acc7d: TokenBreakdown;
  /** Per-family 5h / 7d / 24h accumulators feeding the weighted burn numerators. */
  byModel5h: Record<ModelFamily, TokenBreakdown>;
  byModel7d: Record<ModelFamily, TokenBreakdown>;
  byModel24h: Record<ModelFamily, TokenBreakdown>;
  /** Per-skill × per-family 7d cross-tab (the `bySkillByModel` snapshot field). */
  bySkillByModel: Record<string, Record<ModelFamily, TokenBreakdown>>;
  /**
   * Per-skill × per-family token breakdown over the 24h window — a mirror of
   * {@link bySkillByModel} gated on the SAME scan's 24h cutoff and accumulated
   * in lockstep (issue #3752). Reconciliation invariant: for each family `f`,
   * `Σ_skill bySkillByModel24h[skill][f].total === byModel24h[f].total`, and so
   * `Σ_skill Σ_family bySkillByModel24h[skill][f].total === tokens24h` by
   * construction — the per-class cost rollup re-projects this through
   * `skillToCostClass` so the comprehensive cost-by-class arm sums to the same
   * `tokensLast24h` the snapshot reports, closing the coverage gap the
   * dispatch-observed surrogate could not (host activity the autopilot never
   * reaped has no counter row but has a transcript line). Only skills that
   * produced tokens in the 24h window appear. Accumulated during the SAME walk
   * as the 7d path — no additional filesystem scan. (issue #3752)
   */
  bySkillByModel24h: Record<string, Record<ModelFamily, TokenBreakdown>>;
  /**
   * Per-dispatch-kind × per-family 7d cross-tab (the `byDispatchKind` snapshot
   * field, issue #2403). A SECOND partition over the SAME per-file tokens as
   * {@link bySkillByModel}, keyed by {@link DispatchKind} instead of skill. Always
   * carries all three kind keys (zero-valued where a kind produced none), so
   * `Σ_kind byDispatchKind[kind][f].total === byModel[f].total` per family.
   */
  byDispatchKind: Record<DispatchKind, Record<ModelFamily, TokenBreakdown>>;
  /** Raw .total over the 24h window (the unchanged `tokensLast24h` field). */
  tokens24h: number;
  /**
   * 7d tokens spent on a NON-Anthropic provider's quota (issue #3769) — today
   * `glm-*` on z.ai (ADR-0032). Deliberately EXCLUDED from every field above:
   * `acc5h`/`acc7d`, `byModel*`, `bySkillByModel`, `byDispatchKind`, and
   * `sinceResetEntries` are all Anthropic-meter quantities, and folding a
   * different provider's spend into them inverts the quota signal the drainer
   * lane exists to improve. Surfaced separately so the spend stays visible
   * rather than discarded.
   */
  foreign7d: TokenBreakdown;
  /** The OAuth read result (fresh / served-stale / failed), already resolved. */
  oauth: CachedOAuthRead;
  /** Most recent observed rate-limit reset seen in transcripts, or null. (#856) */
  mostRecentObservedResetMs: number | null;
  /** Buffered in-7d-window entries the since-reset math sums post-scan. (#856) */
  sinceResetEntries: { tsMs: number; tokens: TokenBreakdown; family: ModelFamily }[];
  // Diagnostic counters surfaced verbatim on the snapshot.
  filesScanned: number;
  filesSkippedByMtime: number;
  linesParsed: number;
  linesWithUsage: number;
  parseErrors: number;
  /**
   * Count of in-window files whose `(size, mtimeMs)` matched a persisted
   * parse-memo entry this scan, so their content was replayed from the memo
   * instead of being read + JSON-parsed off disk (issue #3805). A `filesScanned`
   * file is EITHER served from memo OR freshly parsed, never both — so
   * `filesServedFromMemo <= filesScanned`.
   */
  filesServedFromMemo: number;
}

/**
 * The exact structural slice of the usage snapshot that the admission verdict
 * (`./eligibility-usage.ts`) reads. Deliberately NOT `UsageSnapshot`: naming
 * the real dependency is what proves the transcript scan is not one, and it
 * lets a meter-only value satisfy the same projection a full snapshot does.
 *
 * `UsageSnapshot` satisfies this shape structurally, so every existing caller of
 * `projectEligibility` keeps working unchanged.
 */
export interface EligibilityUsageInput {
  /**
   * NULL means EXPLICITLY UNKNOWN — the meter could not be read and there is no
   * usable last-good reading (issue #4165). It does NOT mean zero, and no
   * consumer may coerce it to zero for a gating decision: the whole defect this
   * models is a governor that read blindness as headroom. `null` always travels
   * with `meterUnavailable`, which forces `allow: false`, so a gate that cannot
   * interpret the null simply never runs.
   *
   * The three percentages are `null` together or numeric together; there is no
   * partial-reading state.
   *
   * `UsageSnapshot` (whose fields are plain `number`) still satisfies this
   * interface structurally — `number` is assignable to `number | null` — so the
   * snapshot path is unaffected and never produces a null.
   */
  percentLast5h: number | null;
  percentLast7d: number | null;
  percentSinceReset: number | null;
  usageSource: "oauth" | "estimate";
  emergencyStop: boolean;
  weeklyEmergencyStop: boolean;
  pacingState: "under" | "on" | "over";
  calibrated: boolean;
  weeklyResetAnchor: string | null;
  generatedAt: string;
  /**
   * True when the logged-in account has paid overage ("extra usage") armed —
   * see `UsageEligibility.reasons.extraUsageArmed`, which this feeds.
   *
   * OPTIONAL on purpose. `UsageSnapshot` satisfies this interface structurally
   * (that is what proves the transcript scan is not a dependency of the
   * admission verdict), and it carries no such field — making this required
   * would break that structural fit at every `projectEligibility(snapshot)`
   * call. Absent reads as `false`, which is correct for the snapshot path
   * because that path gates nothing.
   */
  extraUsageArmed?: boolean;
}
