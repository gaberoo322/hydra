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
 * Import direction is strictly one-way and DOWNWARD: this leaf imports ONLY the
 * lower primitive types (`TokenBreakdown`, `ModelFamily` from `token-math.ts`;
 * `DispatchKind` from `transcript-scan.ts`) — never from the I/O coordinator or
 * the snapshot-assembly fold that consume it. Before this move, both pure leaves
 * had to `import type { UsageSnapshot } from "./usage-tracker.ts"` (a backwards
 * edge from a pure leaf onto the I/O coordinator); now they import from HERE,
 * so a new pure consumer of the snapshot type (a test scorer, a future cost-cap
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
// `DispatchKind` is the dispatch-partition key (`./transcript-scan.ts`, issue
// #2403). Importing type-only from these DOWNWARD leaves keeps this the module's
// type-vocabulary root — it imports nothing from the I/O coordinator or the folds.
import type { TokenBreakdown, ModelFamily } from "./token-math.ts";
import type { DispatchKind } from "./transcript-scan.ts";

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
   * If we continued at the last-24h rate for a full 7 days, what % of
   * weekly quota would that be? 0 when uncalibrated.
   */
  projectedWeeklyPercent: number;
  /**
   * "over" when projectedWeeklyPercent > 100 (shed non-essential classes
   * in the autopilot integration that follows this PR). "on" at 80-100%
   * (informational; no action). "under" otherwise, including all
   * uncalibrated runs.
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
