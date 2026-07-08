/**
 * Subscription Usage Tracker — reads Claude Code's JSONL session transcripts
 * to compute rolling-window token consumption.
 *
 * Same data source the `/usage` slash command uses inside the CLI; we read
 * it ourselves so the orchestrator can pace autopilot dispatches against
 * the weekly subscription quota. The Claude Code harness has no
 * programmatic usage-introspection surface (no `claude --usage`, no
 * documented state file, no SDK call), so the transcripts on disk are
 * the only available signal. Hydra already depends on the
 * `~/.claude/projects/<project>/*.jsonl` layout for the watchdog and the
 * lesson-capture hook, so reading them here adds no new fragility.
 *
 * Scope today: pure reader + calibration. No Redis writes. No event bus.
 * No dispatch decisions — the scheduler/autopilot integration that
 * actually consumes `emergencyStop` / `pacingState` lands in a follow-up
 * PR. PR A ships the Module + `/api/usage` so the operator can sanity-
 * check the numbers against `/usage` and calibrate the env vars before
 * any behaviour changes.
 *
 * Calibration env:
 *   - HYDRA_USAGE_WEEKLY_QUOTA_TOKENS  — operator's eyeballed weekly cap
 *   - HYDRA_USAGE_5H_QUOTA_TOKENS      — operator's eyeballed 5-hour cap
 * When either is unset/zero, `calibrated` is false, percentages are 0,
 * pacingState stays "under", and emergencyStop stays false. Raw token
 * counts are always reported.
 *
 * Weekly Reset Anchor env (issue #856, ADR-0021):
 *   - HYDRA_USAGE_WEEKLY_RESET_ANCHOR  — an ISO-8601 instant marking ONE
 *     observed weekly-limit reset, operator-seeded from the interactive
 *     `/usage` view. Projected forward in 7-day multiples relative to `now`
 *     to derive the current fixed window's reset boundary, against which
 *     `tokensSinceReset` / `percentSinceReset` are summed. This is a
 *     FIXED-window metric (resets every 7d at the Anchor), DISTINCT from the
 *     rolling `tokensLast7d` trailing sum. The effective anchor auto-corrects
 *     ON READ: if a real rate-limit reset timestamp is observed in a
 *     transcript and is more recent than the env projection's current-window
 *     boundary, that observed reset becomes the effective boundary. When the
 *     env var is unset/unparseable, the since-reset fields are neutral
 *     (null/0) and nothing throws — mirroring the uncalibrated quota behaviour.
 *     The Module stays a PURE read-side projection: nothing is persisted.
 *
 * Quota-weight env (issue #691):
 *   - HYDRA_QUOTA_WEIGHT_OPUS    — per-token multiplier for the opus family
 *     (the frontier bucket: claude-opus* AND claude-fable* model strings)
 *   - HYDRA_QUOTA_WEIGHT_SONNET  — per-token multiplier for the sonnet family
 *   - HYDRA_QUOTA_WEIGHT_HAIKU   — per-token multiplier for the haiku family
 * These convert raw per-family token counts into a comparable
 * **Quota Weight** burn unit (`opus*w_opus + sonnet*w_sonnet +
 * haiku*w_haiku`; see CONTEXT.md). All-or-nothing, mirroring the existing
 * percentage gate: `quotaWeightLast5h`/`quotaWeightLast7d` are exactly 0
 * unless ALL THREE weights are set to positive values. `byModel` is always
 * populated regardless. Deliberately NOT a dollar figure — under the Claude
 * Code subscription the orchestrator pays no per-call charge.
 *
 * Cache-read weight env (issue #873):
 *   - HYDRA_USAGE_CACHE_READ_WEIGHT — per-TOKEN-TYPE multiplier applied to
 *     `cacheRead` tokens when computing the quota-burn PERCENTAGES
 *     (`percentLast7d`, `percentSinceReset`, `projectedWeeklyPercent`). This is
 *     a SECOND, orthogonal weighting axis (Axis A: per-token-type) layered
 *     beneath the per-model-family **Quota Weight** (Axis B). Anthropic's real
 *     subscription meter bills a cache read at ~0.1x base input, so summing
 *     `cacheRead` at full weight reads ~6-7x hot on a cache-heavy week and
 *     makes the weekly-quota calibration drift with the cache mix (non-
 *     stationary). The weighted unit is `input + output + cacheCreation +
 *     w_cache*cacheRead`; the two axes COMPOSE as
 *     `Σ_family familyWeight(f) * weightedTokens(family[f], w_cache)` — the
 *     cache weight reshapes the token-type mix INSIDE each family, the family
 *     weight scales OUTSIDE, so they never double-count (when all family
 *     weights are 1.0 this reduces exactly to the single-axis cache-weighted
 *     total). Default is 1.0 (identity): unset/empty/<=0/non-finite leaves the
 *     percentages byte-for-byte unchanged, so this PR is behaviour-neutral on
 *     deploy and the principled production value (~0.1) is set in host config,
 *     mirroring the all-or-nothing calibration discipline of the other quota
 *     env vars. Raw `TokenBreakdown.total` is UNTOUCHED — only the burn
 *     percentage NUMERATORS switch to the weighted unit; the honest on-disk
 *     count is still reported verbatim. `cacheHitRatio` (a diagnostic, not a
 *     burn figure) is also untouched.
 *
 * Drift-detection env (issue #873):
 *   - HYDRA_USAGE_DRIFT_REFERENCE_PERCENT — an operator-seeded reference
 *     `percentSinceReset` reading (e.g. captured from the interactive `/usage`
 *     view). When set to a positive number AND the quota is calibrated, the
 *     scan emits ONE fail-loud `console.warn` per scan if the tracker's
 *     `percentSinceReset` diverges from the reference by more than a factor
 *     (HYDRA_USAGE_DRIFT_FACTOR, default 2x) in either direction. Unset =>
 *     inert (no false alarms), mirroring the uncalibrated-returns-neutral
 *     discipline. Read-time detection only — nothing is persisted, no self-
 *     recalibration (that would violate the pure read-side projection
 *     contract, ADR-0021).
 *
 * OAuth-read cadence env (issue #1090):
 *   - HYDRA_OAUTH_USAGE_TTL_MS — how long a SUCCESSFUL OAuth meter read is
 *     reused before the next external GET (default 300_000 = 5min). DECOUPLED
 *     from the 60s transcript-scan cache so the OAuth read cadence is ≤12 GETs/hr
 *     (under the endpoint's rolling rate limit) instead of pinned to the ~60/hr
 *     scan cadence. `?force=1` busts the snapshot scan but NOT this cache.
 *   - HYDRA_OAUTH_USAGE_MAX_STALE_MS — how long PAST the TTL a last-good value
 *     may still be served (as STALE oauth) on a failed read before the headline
 *     falls through to the transcript estimate (default 1_800_000 = 30min,
 *     issue #2574 — DECOUPLED from the TTL, which it formerly defaulted to; the
 *     TTL is the GET-cadence lever, this is the trust-window lever). A
 *     transient 429 keeps `usageSource:"oauth"` on the last-good value (with
 *     `oauthStale=true` + `oauthAgeMs`) rather than flipping to the estimate;
 *     only when no recent-enough OAuth value exists at all does it fall to the
 *     estimate (never silently 0). Only a SUCCESSFUL read overwrites the cache.
 */

import type { OAuthUsageResult } from "./oauth-usage.ts";
// Pure math leaf (issue #1909): the model-family classifier, JSONL-line parser,
// quota-weight / cache-hit formulas, and weekly-reset / session-limit time math
// live in `./token-math.ts`. Only the `TokenBreakdown` / `ModelFamily` TYPES are
// still needed here (for the `UsageSnapshot` interface below) — the value
// consumers (`cacheHitRatio` &c.) moved with `assembleSnapshot` to the
// `./snapshot-assembly.ts` leaf (issue #2988). `index.ts` re-exports the leaf's
// public surface so it is unchanged.
import type {
  TokenBreakdown,
  ModelFamily,
} from "./token-math.ts";
// Pure snapshot-slice leaf (issue #2279, #2988): the snapshot-assembly fold
// helpers (weighted burns, estimate percents, Quota-Weight totals, pacing state,
// OAuth headline rebase, since-reset fixed-window math, calibration-drift
// detection) AND the `assembleSnapshot` coordinator that composes them now BOTH
// live in `./snapshot-assembly.ts`. `getUsage()` below imports only
// `assembleSnapshot` (the fold helpers are module-internal to that leaf, NOT
// re-exported through `index.ts`). One-way import: this module imports FROM
// snapshot-assembly.ts; snapshot-assembly.ts imports no VALUE back from here
// (it imports the `UsageSnapshot` TYPE only, runtime-erased — no cycle).
import { assembleSnapshot } from "./snapshot-assembly.ts";
import type { SkillWoWEntry } from "./snapshot-assembly.ts";
// Weekly Usage Snapshot seam (issue #2404): the typed Redis accessor for the
// persisted per-ISO-week per-skill rollup. The ONLY Redis touch on the read
// path is the prior-week READ here in `getUsage()` (the I/O coordinator) —
// fetched BEFORE the pure `assembleSnapshot()` and INJECTED as an argument, so
// the assembler stays Redis-free (ADR-0021). The WRITE lives in the weekly
// Housekeeping chore, never here. Injectable so tests pin the prior week
// without standing up Redis.
import { readPriorWeekUsageSnapshot } from "../redis/usage-snapshots.ts";
import type { WeeklyUsageSnapshot } from "../redis/usage-snapshots.ts";
// Env-config readers + their DEFAULT_* constants live in the pure leaf
// `./config.ts` (issue #1896). They are consumed by the `assembleSnapshot`
// coordinator, which moved to `./snapshot-assembly.ts` (issue #2988) — so this
// coordinator no longer imports them directly. `index.ts` re-exports them so the
// public surface is unchanged.
// TranscriptScan seam (issue #1971): the JSONL transcript walk + the
// independent-TTL OAuth cached meter read. `usage-tracker.ts` is now the pure
// coordinator/assembler over the `ScanResult` this module returns. The
// `ScanResult` boundary type stays INTERNAL — never re-exported from index.ts.
import {
  transcriptScan,
  makeReadOAuth,
  projectsRoot,
  readOAuthUsage,
  deriveSkill,
  INTERACTIVE_SKILL,
  UNATTRIBUTED_SKILL,
  sessionIdFromPath as transcriptScanSessionIdFromPath,
} from "./transcript-scan.ts";
import type { SkillResolver, DispatchKind } from "./transcript-scan.ts";
// The OAuth backoff/cache seam moved to its own focused leaf (issue #2923);
// `clearUsageCache()` reaches its reset through the seam's `clearOAuthCache()`.
import { clearOAuthCache } from "./oauth-read-cache.ts";

// `INTERACTIVE_SKILL` (and its back-compat alias `UNATTRIBUTED_SKILL`),
// `SkillResolver`, and `sessionIdFromPath` live in the TranscriptScan seam
// (issue #1971, #2402). Re-exported here at the SAME names so the `index.ts`
// barrel and existing `from "./usage-tracker.ts"` imports keep resolving
// unchanged.
export { INTERACTIVE_SKILL, UNATTRIBUTED_SKILL };
export type { SkillResolver };

// Production attribution resolver (issue #2402). Pure, Redis-free: derives the
// dispatching skill from the transcript's FIRST user message text — the
// `hydra-dispatch` sentinel (#692) wins, else a `/command-name` slash marker,
// else the `interactive` residual. Replaces the former registry-read resolver
// (`getSubagentDispatch`) that the structurally-dead SessionStart hook (issue
// #2401) left empty, which bucketed 100% of tokens under `unattributed`. The
// tracker now reads NO Redis for attribution — only on-disk transcripts.
const defaultSkillResolver: SkillResolver = (firstUserText) => deriveSkill(firstUserText);

const CACHE_TTL_MS = 60_000;

// `TokenBreakdown`, `ModelFamily`, `ParsedUsageLine`, and `ResetWindow` live in
// the pure leaf `./token-math.ts` (issue #1909). `TokenBreakdown` and
// `ModelFamily` are imported above for internal use; consumers import all four
// directly from `./token-math.ts`.

// `MODEL_FAMILIES` (the canonical ordered family list) + `familyWeight` (the
// per-family Quota-Weight selector) moved DOWN into the pure leaf
// `./token-math.ts` (issue #2279) so both this coordinator and the extracted
// `./snapshot-assembly.ts` leaf import them one-way without a back-import cycle.
// The snapshot-assembly folds that consumed them moved to that leaf too.

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

// `EMPTY_BREAKDOWN` + `emptyByModel` + `addBreakdown` now live in the
// TranscriptScan seam (issue #1971) and are imported at the top of this file —
// the assembler below shares them with the scan.

interface CacheEntry {
  snapshot: UsageSnapshot;
  storedAt: number;
}

let cache: CacheEntry | null = null;

// The OAuth last-good cache (`oauthCache` + `OAuthCacheEntry`) moved to the
// TranscriptScan seam with `readOAuthCached` (issue #1090, #1971); the snapshot
// cache above stays here. `clearUsageCache()` below nulls BOTH via the seam's
// exported `clearOAuthCache()`.

// The hard-stop threshold constant `EMERGENCY_STOP_PERCENT` and the two-line
// `deriveHardStop` predicate it parameterises moved to `./eligibility.ts`
// (issue #2041) so the threshold POLICY lives with the dispatch-gating fold and
// is independently unit-testable. Both are now consumed by the `assembleSnapshot`
// coordinator in `./snapshot-assembly.ts` (issue #2988), not by this file
// directly; `EMERGENCY_STOP_PERCENT` is also consumed from `./eligibility.ts` by
// its other callers (and `test/usage-tracker.test.mts`).

// `familyWeight`, `MODEL_FAMILIES`, `weightedQuotaBurn`, the seven pure
// snapshot-assembly slice helpers (`deriveWeightedBurns`, `deriveEstimatePercents`,
// `deriveQuotaWeightTotals`, `derivePacingState`, `rebaseOnOAuth`, `deriveSinceReset`,
// `detectCalibrationDrift`) + their slice interfaces, AND the `assembleSnapshot`
// coordinator that composes them, moved to the pure leaves `./token-math.ts` (the
// shared primitives, issue #1909/#2279) and `./snapshot-assembly.ts` (the folds +
// coordinator, issue #2279 finished by #2988). `getUsage()` below imports only
// `assembleSnapshot` from that leaf; the folds stay exported-for-direct-unit-test
// on `snapshot-assembly.ts`, NOT on the `index.ts` public barrel.

export function clearUsageCache(): void {
  cache = null;
  // The OAuth last-good cache lives in the TranscriptScan seam now (issue
  // #1971); clearing it through the seam's reset fn keeps this the single reset
  // entry point that nulls BOTH caches (the #1090 invariant 17 test sites rely on).
  clearOAuthCache();
}

/**
 * Returns a snapshot of token consumption over the 5h, 24h, and 7d
 * rolling windows by scanning Claude Code's JSONL transcripts.
 *
 * Memoized for 60s in-process. The autopilot tick, the dashboard
 * refresh, and the `/api/scheduler/status` endpoint may each call
 * `getUsage()` within the same breath; the cache bounds the cost.
 * Pass `force: true` to bypass; pass `projectsRoot` to point at a
 * fixture directory (bypasses cache automatically).
 */
export async function getUsage(opts: {
  now?: Date;
  force?: boolean;
  projectsRoot?: string;
  /**
   * Resolves a transcript's first user message text to its dispatching skill
   * for the `bySkillByModel` cross-tab (issue #2402). Defaults to the pure
   * in-transcript {@link deriveSkill} (sentinel → slash marker → `interactive`).
   * Injected by tests to pin attribution by passing fixture text. Reads no
   * Redis. (issue #693, #2402)
   */
  resolveSkill?: SkillResolver;
  /**
   * Reads the authoritative OAuth subscription-usage meter (issue #1083).
   * Defaults to {@link readOAuthUsage}, which reads the credentials file fresh
   * and GETs the OAuth endpoint. Injected by tests to pin the meter result
   * without a live endpoint or a real credentials file.
   *
   * Cadence (issue #1090): on the PRODUCTION path the meter read goes through
   * the independent-TTL `oauthCache` (default 5min, `HYDRA_OAUTH_USAGE_TTL_MS`)
   * — DECOUPLED from the 60s snapshot cache, so `?force=1` busts the snapshot
   * scan but NOT the OAuth read, and the read cadence is ≤12/hr not ~60/hr.
   * When `readUsage` is injected (tests) OR a fixture `projectsRoot` is supplied,
   * the OAuth cache is BYPASSED so each call exercises the injected reader
   * deterministically — UNLESS {@link useOAuthCache} is set true.
   */
  readUsage?: () => Promise<OAuthUsageResult>;
  /**
   * Opt the injected/fixture path INTO the module-level OAuth cache (issue
   * #1090) so a test can drive the independent-TTL + last-good behaviour with a
   * pinned `readUsage` + fixture `projectsRoot`. Defaults to undefined =>
   * bypass (the #1083 fresh-each-call contract). Production never sets this; it
   * uses the cache because no reader/root is injected.
   */
  useOAuthCache?: boolean;
  /**
   * Reads the immediately-prior ISO-week's **Weekly Usage Snapshot** for the
   * per-skill week-over-week trend (issue #2404). Defaults to
   * {@link readPriorWeekUsageSnapshot}, which reads Redis via the typed
   * accessor. Injected by tests to pin the prior week without a live Redis (or
   * to assert the no-prior-week path). Fetched HERE in the I/O coordinator and
   * injected into the pure `assembleSnapshot()`, preserving its no-IO contract.
   * A read error degrades to a null prior week (WoW becomes all-"new") — it
   * never fails the snapshot.
   */
  readPriorWeek?: (at: Date) => Promise<WeeklyUsageSnapshot | null>;
} = {}): Promise<UsageSnapshot> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const overrideRoot = opts.projectsRoot !== undefined;
  const overrideResolver = opts.resolveSkill !== undefined;
  const overrideMeter = opts.readUsage !== undefined;
  const overridePriorWeek = opts.readPriorWeek !== undefined;
  if (
    !opts.force &&
    !overrideRoot &&
    !overrideResolver &&
    !overrideMeter &&
    !overridePriorWeek &&
    cache
  ) {
    if (nowMs - cache.storedAt < CACHE_TTL_MS) {
      return cache.snapshot;
    }
  }

  const root = opts.projectsRoot ?? projectsRoot();
  const resolveSkill = opts.resolveSkill ?? defaultSkillResolver;
  // Meter-read default (issue #1083): production uses the live OAuth meter.
  // When a fixture `projectsRoot` is supplied (test mode) WITHOUT an explicit
  // `readUsage`, default to an estimate-forcing stub so transcript-fixture tests
  // exercise the estimate path deterministically and never touch the network or
  // a real credentials file. An explicit `readUsage` always wins.
  const readUsage =
    opts.readUsage ??
    (overrideRoot
      ? async (): Promise<OAuthUsageResult> => ({ ok: false, code: "oauth-usage-no-credentials" })
      : readOAuthUsage);

  // OAuth-read cadence layer (issue #1090, seam'd in #1971). On the pure
  // production path (no injected reader, no fixture root) the read goes through
  // the seam's independent-TTL `oauthCache` so it is decoupled from the snapshot
  // scan and serves a last-good value through transient 429s. When tests inject
  // a reader or point at a fixture root, bypass the module cache so each call
  // exercises the injected reader deterministically (preserving the #1083 test
  // contract) — unless `useOAuthCache` is explicitly set, which the #1090 tests
  // use to drive the cache with a pinned reader.
  const bypassOAuthCache = (overrideMeter || overrideRoot) && opts.useOAuthCache !== true;
  // Backoff-state persistence (issue #2840): install the live Redis side-channel
  // ONLY on the pure production path (no injected reader, no fixture root), so the
  // ladder survives a restart. The deterministic test path (an injected reader or
  // fixture root) stays on the no-op persistence default (invariant 5) unless a
  // test explicitly injects a fake store via `setOAuthBackoffPersistence`.
  const persistBackoff = !overrideMeter && !overrideRoot;
  const readOAuth = makeReadOAuth({ readUsage, nowMs, bypassOAuthCache, persistBackoff });

  // Coordinate the two halves (issue #1971): the TranscriptScan seam owns the
  // JSONL walk + OAuth read and returns the raw accumulation; the pure
  // assembler below turns that into the final UsageSnapshot. No behavioural
  // delta from the former single `scanUsage()` — the boundary is the ScanResult.
  const scan = await transcriptScan(root, now, resolveSkill, readOAuth);

  // Prior-week read for the week-over-week per-skill trend (issue #2404). This
  // is the SINGLE Redis touch on the read path; it is performed HERE in the I/O
  // coordinator and injected into the pure `assembleSnapshot()` so the assembler
  // stays Redis-free (ADR-0021). A read error degrades to a null prior week
  // (WoW becomes all-"new") — fail-loud but never fail the snapshot.
  const readPriorWeek = opts.readPriorWeek ?? readPriorWeekUsageSnapshot;
  let priorWeek: WeeklyUsageSnapshot | null = null;
  try {
    priorWeek = await readPriorWeek(now);
  } catch (err: any) {
    console.error(
      `[usage-tracker] prior-week snapshot read failed (week-over-week trend degrades to 'new'): ${err?.message || err}`,
    );
  }

  const snapshot = assembleSnapshot(scan, now, priorWeek?.bySkill ?? null);

  if (!overrideRoot && !overrideResolver && !overrideMeter && !overridePriorWeek) {
    cache = { snapshot, storedAt: nowMs };
  }
  return snapshot;
}

/**
 * Derive a transcript's sessionId from its file path. The SessionStart capture
 * hook (issue #692) registers the dispatch under exactly the `<sessionId>.jsonl`
 * filename stem, so the basename is the join key into the dispatch registry.
 * Resolving once per file (not per line) keeps attribution O(files), honouring
 * the design invariant. (issue #693)
 *
 * Re-exported from the TranscriptScan seam (`./transcript-scan.ts`, issue
 * #1971), which itself re-exports it from the **Transcript Store** Seam
 * (`src/transcript-store.ts`, issue #951 — the single owner of the
 * `<sessionId>.jsonl` filename grammar). Kept on this surface for existing
 * callers (`src/cost/index.ts`, tests).
 */
export const sessionIdFromPath = transcriptScanSessionIdFromPath;

// `assembleSnapshot` — the pure snapshot-assembly coordinator that folds the
// helper slices into a `UsageSnapshot` — moved to the `./snapshot-assembly.ts`
// leaf (issue #2988), completing the IO/pure split issue #2279 began. The
// complete assembly story (the fold helpers AND their composition) now lives in
// that one leaf named for the concern; `getUsage()` above imports it and injects
// the prior-week per-skill totals it read from Redis, preserving the assembler's
// no-IO contract (ADR-0021). It is exported from `snapshot-assembly.ts` for
// direct unit test but NOT re-exported through the `index.ts` public barrel.

// `parseUsageLine`, `parseObservedResetMs` (+ its `coerceInstantMs` helper),
// `parseSessionLimitReset` (+ its `SESSION_LIMIT_RE` / `resolveWallClockInZone`
// helpers), and `cacheHitRatio` moved to `./token-math.ts` (issue #1909).
// `addBreakdown` + `emptyByModel` + `EMPTY_BREAKDOWN` moved to the TranscriptScan
// seam `./transcript-scan.ts` (issue #1971). All three are consumed by the
// `./snapshot-assembly.ts` leaf (issue #2279/#2988, which now owns `assembleSnapshot`),
// not directly by this coordinator.
