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
 */

import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { getSubagentDispatch } from "../redis/dispatches.ts";
import {
  projectsRoot,
  listTranscriptFiles,
  sessionIdFromPath as transcriptSessionIdFromPath,
} from "../transcript-store.ts";
import { readOAuthUsage, isOAuthUsageOk } from "./oauth-usage.ts";
import type { OAuthUsageResult } from "./oauth-usage.ts";

/**
 * Bucket key for sessions that have no `hydra:dispatches:subagent:{sessionId}`
 * registry entry (legacy transcripts, or an operator-launched session whose
 * prompt carried no hydra-dispatch sentinel). Tokens are still counted — they
 * bucket here — so `bySkillByModel` stays reconcilable to `byModel` and to the
 * per-skill counters in `src/redis/cost.ts`; nothing is dropped. (issue #693)
 */
export const UNATTRIBUTED_SKILL = "unattributed";

/**
 * Resolves a transcript's `sessionId` to the dispatching skill, or null when
 * the session has no registry entry. The default reads the subagent-dispatch
 * registry (`getSubagentDispatch`, a pure READ — the tracker keeps its
 * no-Redis-WRITE posture). Injectable so tests can pin the cross-tab without
 * standing up Redis. (issue #693)
 */
export type SkillResolver = (sessionId: string) => Promise<string | null>;

const defaultSkillResolver: SkillResolver = async (sessionId) => {
  try {
    const dispatch = await getSubagentDispatch(sessionId);
    return dispatch?.skill ?? null;
  } catch (err: any) {
    // A Redis hiccup must not take down the read-only usage scan; bucket the
    // session under `unattributed` (null) and keep totals closed. Logged so a
    // persistent registry outage is visible rather than silently swallowed.
    console.error(
      `[usage-tracker] skill resolution failed for session ${sessionId}: ${err?.message || err}`,
    );
    return null;
  }
};

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const WINDOW_5H_MS = 5 * MS_PER_HOUR;
const WINDOW_24H_MS = MS_PER_DAY;
const WINDOW_7D_MS = 7 * MS_PER_DAY;
const CACHE_TTL_MS = 60_000;

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

/**
 * Model families recognised by the per-model rollup. `unknown` is the
 * catch-all for any model string that doesn't match a known prefix
 * (synthetic messages, future model names, GPT carry-overs). Its
 * Quota-Weight contribution uses an implicit weight of 1.0 — there is
 * deliberately no `HYDRA_QUOTA_WEIGHT_UNKNOWN` env var because the
 * CONTEXT.md Quota-Weight formula is opus/sonnet/haiku only; an unknown
 * bucket above zero signals the family table needs a new prefix, which the
 * once-per-scan `console.warn` surfaces.
 */
export type ModelFamily = "opus" | "sonnet" | "haiku" | "unknown";

const MODEL_FAMILIES: readonly ModelFamily[] = ["opus", "sonnet", "haiku", "unknown"];

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
   * because the OAuth read failed, or `null` when the meter read succeeded
   * (`usageSource === "oauth"`). Additive observability — surfaces WHY the
   * fallback happened (e.g. `oauth-usage-token-expired` => operator should
   * re-login). (issue #1083)
   */
  oauthError: string | null;
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
   * key is the dispatching skill resolved from the subagent-dispatch registry
   * (`getSubagentDispatch`); the inner key is the model family. Sessions with
   * no registry entry bucket under `skill = "unattributed"` (see
   * {@link UNATTRIBUTED_SKILL}) so totals stay reconcilable to `byModel`.
   *
   * Reconciliation invariant: for each family `f`,
   * `Σ_skill bySkillByModel[skill][f].total === byModel[f].total`. Only skills
   * that produced tokens in the window appear; each present skill carries all
   * four family keys (zero-valued where the skill produced none). Pure
   * read-side projection — NO new Redis writes. (issue #693)
   */
  bySkillByModel: Record<string, Record<ModelFamily, TokenBreakdown>>;
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

const EMPTY_BREAKDOWN: TokenBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

interface CacheEntry {
  snapshot: UsageSnapshot;
  storedAt: number;
}

let cache: CacheEntry | null = null;

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
 * Default **Pacing Ceiling** (issue #857, ADR-0021): the sub-100% fraction of
 * the weekly quota the **Pacing Curve** climbs to by the next **Weekly Reset
 * Anchor**. The ~8% gap below 1.0 is the **Operator Reserve** (CONTEXT.md).
 */
export const DEFAULT_WEEKLY_PACE_CEILING = 0.92;

/**
 * Hard-stop threshold (in % of quota) shared by the 5-hour `emergencyStop` and
 * the weekly `weeklyEmergencyStop`. At or above this percentage the
 * corresponding window is considered exhausted enough to block ALL autopilot
 * dispatch (via `projectEligibility` → allow=false), leaving the ~10% headroom
 * as **Operator Reserve** for whatever the operator dispatches by hand. Both
 * windows share the one constant so the two caps stay symmetric.
 */
export const EMERGENCY_STOP_PERCENT = 90;

/**
 * Tolerance band (in percentage points of weekly quota) around the **Pacing
 * Curve** target within which the burn is judged "on" the curve rather than
 * ahead/behind. ±2pp is small relative to the 0→92 ramp over a week, so it
 * suppresses paceState flicker right at the line without materially shifting
 * the ahead/behind verdict. (issue #857)
 */
export const PACE_STATE_TOLERANCE_PERCENT = 2;

/**
 * Position of total burn relative to the **Pacing Curve** target for this
 * instant in the week (issue #857, ADR-0021):
 *   - "behind" — sinceReset% < target% − tolerance (room to run; Pace Gate launches)
 *   - "on"     — within ±tolerance of target%, OR neutral (anchor unset/uncalibrated)
 *   - "ahead"  — sinceReset% > target% + tolerance (Pace Gate pauses, in #858)
 *
 * Neutral maps to "on": when the Anchor is unset or the quota is uncalibrated
 * there is no curve to be ahead/behind of, and "on" is the do-nothing verdict
 * the future Pace Gate (#858) treats as "no pacing reason to launch or pause"
 * — mirroring how `pacingState` defaults to the inert "under" when uncalibrated.
 * This field is ADDITIVE and does NOT yet gate dispatch (that is #858).
 */
export type PaceState = "behind" | "on" | "ahead";

/**
 * The operator-tunable **Pacing Ceiling** as a fraction in (0, 1], read from
 * `HYDRA_USAGE_WEEKLY_PACE_CEILING`. Unset/empty/unparseable/out-of-range
 * falls back to {@link DEFAULT_WEEKLY_PACE_CEILING} (a non-empty-but-bad value
 * is logged, fail-loud, since it signals a mis-configured env var). Values
 * above 1.0 are clamped to 1.0; values <= 0 fall back to the default. Pure +
 * env-only so the curve math stays unit-testable. (issue #857)
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

export interface ResetWindow {
  /**
   * Epoch-ms of the most recent anchor + 7d*k that is <= now — the start of
   * the current fixed weekly window.
   */
  currentMs: number;
  /** Epoch-ms of the next reset boundary (currentMs + 7d). */
  nextMs: number;
}

/**
 * Project a single seeded **Weekly Reset Anchor** forward (and backward) in
 * 7-day multiples to find the fixed window containing `nowMs`.
 *
 * Returns the most recent boundary `anchorMs + 7d*k <= nowMs` (`currentMs`)
 * and the next one (`nextMs = currentMs + 7d`). Works for anchors in the
 * past OR the future (`k` may be negative). Pure + total: no I/O, no env
 * reads, deterministic in its two args — so it's the unit-testable core of
 * the Anchor math.
 */
export function projectResetWindow(anchorMs: number, nowMs: number): ResetWindow {
  const k = Math.floor((nowMs - anchorMs) / WINDOW_7D_MS);
  const currentMs = anchorMs + k * WINDOW_7D_MS;
  return { currentMs, nextMs: currentMs + WINDOW_7D_MS };
}

/**
 * Default per-token-type cache-read weight (issue #873): 1.0 = identity =
 * the pre-#873 full-weight behaviour. Keeping the default at identity makes an
 * unset `HYDRA_USAGE_CACHE_READ_WEIGHT` a pure no-op so the change is purely
 * calibration-gated (the principled ~0.1 production value lives in host config,
 * not a hardcoded constant fit to one week).
 */
export const DEFAULT_CACHE_READ_WEIGHT = 1.0;

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
 * Default factor by which the tracker's `percentSinceReset` may diverge from
 * the operator-seeded reference reading before the once-per-scan drift warning
 * fires (issue #873). 2x in either direction — a coarse "calibration has
 * clearly rotted" signal, not a precise alarm.
 */
export const DEFAULT_DRIFT_FACTOR = 2;

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
 * Classify a model string into a Quota-Weight family by prefix.
 *
 * Pure prefix matcher: `claude-opus*` → opus, `claude-sonnet*` → sonnet,
 * `claude-haiku*` → haiku, anything else → unknown. This is intentionally a
 * NEW classifier and NOT `modelToTier` from `attribution.ts` — that function
 * returns legacy tier labels (frontier/codex/mini) keyed on GPT model names
 * and would bucket every real `claude-opus-4-7` string into `unknown`. The
 * no-duplication intent is honoured by keeping this the ONE canonical family
 * classifier. (issue #691)
 */
export function modelToFamily(model: string | null | undefined): ModelFamily {
  const l = String(model ?? "").toLowerCase();
  if (l.startsWith("claude-opus")) return "opus";
  if (l.startsWith("claude-sonnet")) return "sonnet";
  if (l.startsWith("claude-haiku")) return "haiku";
  return "unknown";
}

/** Quota-Weight for a family. opus/sonnet/haiku from env; unknown is 1.0. */
function familyWeight(
  family: ModelFamily,
  weights: { opus: number; sonnet: number; haiku: number },
): number {
  switch (family) {
    case "opus":
      return weights.opus;
    case "sonnet":
      return weights.sonnet;
    case "haiku":
      return weights.haiku;
    case "unknown":
      // Implicit 1.0 — no HYDRA_QUOTA_WEIGHT_UNKNOWN env var exists; the
      // formula is three-family. Drift here is surfaced by the
      // once-per-scan console.warn, not absorbed by a tunable.
      return 1;
  }
}

/**
 * The per-token-type weighted token count for one accumulator (issue #873):
 * `input + output + cacheCreation + w_cache*cacheRead`. This is the quota-burn
 * UNIT — it down-weights cache reads to match Anthropic's real meter (cache
 * reads bill at ~0.1x base input) while counting input/output/cacheCreation at
 * full weight. `w_cache = 1.0` (the default) reduces this exactly to `b.total`,
 * so the change is behaviour-neutral until the operator calibrates the env var.
 * Pure + total — the unit-testable core of the weighted-burn math.
 */
export function weightedTokens(b: TokenBreakdown, wCache: number): number {
  return b.input + b.output + b.cacheCreation + wCache * b.cacheRead;
}

/**
 * The composed two-axis quota-burn numerator over a per-family accumulator
 * (issue #873). Axis A (per-token-type cache weight) reshapes the token mix
 * INSIDE each family via {@link weightedTokens}; Axis B (per-model-family
 * **Quota Weight**) scales OUTSIDE via {@link familyWeight}:
 *
 *   `Σ_family familyWeight(f) * weightedTokens(family[f], w_cache)`
 *
 * The two axes are orthogonal, so they never double-count. When all family
 * weights are 1.0 (the dormant `quotaWeightCalibrated === false` prod state)
 * this reduces EXACTLY to the single-axis cache-weighted total
 * (`Σ_family weightedTokens(family[f], w_cache)`), which in turn reduces to the
 * raw `Σ_family family[f].total` when `w_cache === 1.0`. Passing the
 * identity-weights object `{opus:1,sonnet:1,haiku:1}` (what the caller does
 * when quota weights are uncalibrated) keeps the percentage path honest
 * regardless of the #691 calibration state.
 */
function weightedQuotaBurn(
  byModel: Record<ModelFamily, TokenBreakdown>,
  wCache: number,
  weights: { opus: number; sonnet: number; haiku: number },
): number {
  return MODEL_FAMILIES.reduce(
    (sum, f) => sum + familyWeight(f, weights) * weightedTokens(byModel[f], wCache),
    0,
  );
}

function emptyByModel(): Record<ModelFamily, TokenBreakdown> {
  return {
    opus: { ...EMPTY_BREAKDOWN },
    sonnet: { ...EMPTY_BREAKDOWN },
    haiku: { ...EMPTY_BREAKDOWN },
    unknown: { ...EMPTY_BREAKDOWN },
  };
}

export function clearUsageCache(): void {
  cache = null;
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
   * Resolves a transcript's `sessionId` to its dispatching skill for the
   * `bySkillByModel` cross-tab. Defaults to the subagent-dispatch registry
   * read. Injected by tests to pin attribution without Redis. (issue #693)
   */
  resolveSkill?: SkillResolver;
  /**
   * Reads the authoritative OAuth subscription-usage meter (issue #1083).
   * Defaults to {@link readOAuthUsage}, which reads the credentials file fresh
   * and GETs the OAuth endpoint. Injected by tests to pin the meter result
   * without a live endpoint or a real credentials file. Piggybacks on the 60s
   * snapshot cache — ONE meter read per cache refresh, not per caller.
   */
  readUsage?: () => Promise<OAuthUsageResult>;
} = {}): Promise<UsageSnapshot> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const overrideRoot = opts.projectsRoot !== undefined;
  const overrideResolver = opts.resolveSkill !== undefined;
  const overrideMeter = opts.readUsage !== undefined;
  if (!opts.force && !overrideRoot && !overrideResolver && !overrideMeter && cache) {
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
  const snapshot = await scanUsage(root, now, resolveSkill, readUsage);

  if (!overrideRoot && !overrideResolver && !overrideMeter) {
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
 * Re-exported from the **Transcript Store** Seam (`src/transcript-store.ts`,
 * issue #951) — the single owner of the `<sessionId>.jsonl` filename grammar —
 * kept on this surface for existing callers (`src/cost/index.ts`, tests).
 */
export const sessionIdFromPath = transcriptSessionIdFromPath;

async function scanUsage(
  root: string,
  now: Date,
  resolveSkill: SkillResolver,
  readUsage: () => Promise<OAuthUsageResult>,
): Promise<UsageSnapshot> {
  const nowMs = now.getTime();
  const cutoff7d = nowMs - WINDOW_7D_MS;
  const cutoff24h = nowMs - WINDOW_24H_MS;
  const cutoff5h = nowMs - WINDOW_5H_MS;

  // Authoritative OAuth meter read (issue #1083). Fired CONCURRENTLY with the
  // transcript file scan below so the ~one-per-cache-window external GET adds no
  // serial latency to the scan. Resolved after the estimate is computed; on
  // success it REBASES the headline percents + 5h emergencyStop onto ground
  // truth, on failure the estimate stands (never silently 0). Never throws —
  // readOAuthUsage returns a discriminated result.
  const oauthPromise = readUsage();

  const weeklyQuota = getWeeklyQuotaTokens();
  const fiveHourQuota = getFiveHourQuotaTokens();
  const calibrated = weeklyQuota > 0 && fiveHourQuota > 0;

  const weights = {
    opus: getQuotaWeightOpus(),
    sonnet: getQuotaWeightSonnet(),
    haiku: getQuotaWeightHaiku(),
  };
  const quotaWeightCalibrated = weights.opus > 0 && weights.sonnet > 0 && weights.haiku > 0;

  const acc5h: TokenBreakdown = { ...EMPTY_BREAKDOWN };
  const acc7d: TokenBreakdown = { ...EMPTY_BREAKDOWN };
  // Per-family 5h/7d accumulators. `byModel` (the snapshot field) reports the
  // 7d window; the 5h split is internal, used only for the 5h Quota Weight.
  const byModel5h = emptyByModel();
  const byModel7d = emptyByModel();
  // Per-family 24h accumulator. The scalar `tokens24h` (raw .total) is kept for
  // the unchanged `tokensLast24h` snapshot field; this per-family split feeds
  // the WEIGHTED `projectedWeeklyPercent` numerator so the projection composes
  // both weighting axes exactly like the 7d path. (issue #873)
  const byModel24h = emptyByModel();
  // Per-skill × per-family 7d accumulator (the `bySkillByModel` snapshot
  // field). Skills are added lazily as transcripts resolve to them.
  const bySkillByModel: Record<string, Record<ModelFamily, TokenBreakdown>> = {};
  let tokens24h = 0;

  // Weekly Reset Anchor (issue #856). The since-reset boundary can be moved
  // FORWARD by an observed rate-limit reset, which we only learn mid-scan — so
  // buffer the in-7d-window (tsMs, tokens) entries and sum them once the
  // effective boundary is known. The set buffered is exactly the lines already
  // iterated for the rolling 7d window, bounded by the 7d cutoff. Only buffered
  // when the env Anchor is set, so the unset case adds zero overhead/memory.
  const anchorEnvMs = getWeeklyResetAnchorMs();
  const sinceResetEntries: { tsMs: number; tokens: TokenBreakdown; family: ModelFamily }[] = [];
  let mostRecentObservedResetMs: number | null = null;

  // Dedup unknown-model warnings to AT MOST one per scan (never per-line).
  const unknownModelsSeen = new Set<string>();
  // Memoise sessionId → skill within a scan so a session with many transcript
  // shards resolves once, not once-per-shard. (Distinct files usually carry
  // distinct sessionIds, but a resumed session can append a new shard.)
  const skillCache = new Map<string, string | null>();

  let filesScanned = 0;
  let filesSkippedByMtime = 0;
  let linesParsed = 0;
  let linesWithUsage = 0;
  let parseErrors = 0;

  const files = await listTranscriptFiles(root);
  for (const file of files) {
    let st: Stats;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    // mtime is the last append; if the file hasn't been touched in 7
    // days, none of its lines can fall inside the window.
    if (st.mtimeMs < cutoff7d) {
      filesSkippedByMtime++;
      continue;
    }
    filesScanned++;

    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch (err: any) {
      console.error(`[usage-tracker] read failed for ${file}: ${err?.message || err}`);
      continue;
    }

    // Accumulate this file's in-window 7d tokens per family locally, then fold
    // into the global per-family AND per-skill tables once the file is parsed.
    // Resolving the skill per FILE (not per line) keeps attribution O(files).
    const fileByFamily7d = emptyByModel();
    let fileHadInWindow7d = false;

    const lines = content.split("\n");
    for (const line of lines) {
      // Fast reject: most lines are JSON objects; skip blanks instantly.
      if (!line || line[0] !== "{") continue;
      linesParsed++;

      // Observed rate-limit reset (issue #856). A reset notice has no usage
      // block (so parseUsageLine would "skip" it), so probe it FIRST and only
      // when an env Anchor exists — that's the only mode that consumes the
      // observed reset. Track the most recent one; the effective boundary is
      // resolved post-scan.
      if (anchorEnvMs !== null) {
        const observed = parseObservedResetMs(line);
        if (observed !== null && (mostRecentObservedResetMs === null || observed > mostRecentObservedResetMs)) {
          mostRecentObservedResetMs = observed;
        }
      }

      const parsed = parseUsageLine(line);
      if (parsed === null) {
        parseErrors++;
        continue;
      }
      if (parsed === "skip") continue;
      linesWithUsage++;

      const tsMs = parsed.tsMs;
      if (tsMs < cutoff7d) continue;

      const family = modelToFamily(parsed.model);
      if (family === "unknown" && !unknownModelsSeen.has(parsed.model)) {
        unknownModelsSeen.add(parsed.model);
      }

      fileHadInWindow7d = true;
      addBreakdown(acc7d, parsed.tokens);
      addBreakdown(byModel7d[family], parsed.tokens);
      addBreakdown(fileByFamily7d[family], parsed.tokens);
      if (tsMs >= cutoff24h) {
        tokens24h += parsed.tokens.total;
        addBreakdown(byModel24h[family], parsed.tokens);
      }
      if (tsMs >= cutoff5h) {
        addBreakdown(acc5h, parsed.tokens);
        addBreakdown(byModel5h[family], parsed.tokens);
      }
      // Buffer for the fixed since-reset window (issue #856). Only when an env
      // Anchor is set — keeps the unset path zero-overhead.
      if (anchorEnvMs !== null) {
        sinceResetEntries.push({ tsMs, tokens: parsed.tokens, family });
      }
    }

    // Bucket this file's 7d tokens into the per-skill cross-tab. Skip files
    // with no in-window tokens so we don't conjure empty skill rows. Exactly
    // one skill resolution per contributing file (memoised by sessionId).
    if (fileHadInWindow7d) {
      const sessionId = sessionIdFromPath(file);
      let skill = skillCache.get(sessionId);
      if (skill === undefined) {
        skill = await resolveSkill(sessionId);
        skillCache.set(sessionId, skill);
      }
      const bucket = skill ?? UNATTRIBUTED_SKILL;
      const row = (bySkillByModel[bucket] ??= emptyByModel());
      for (const f of MODEL_FAMILIES) addBreakdown(row[f], fileByFamily7d[f]);
    }
  }

  if (unknownModelsSeen.size > 0) {
    // Once per scan, not per line. An above-zero unknown bucket means the
    // family prefix table (modelToFamily) needs a new entry.
    console.warn(
      `[usage-tracker] ${unknownModelsSeen.size} unrecognised model string(s) bucketed to 'unknown' (implicit quota-weight 1.0): ${[
        ...unknownModelsSeen,
      ]
        .map((m) => (m === "" ? "<missing>" : m))
        .join(", ")}`,
    );
  }

  // Quota-burn numerator weighting (issue #873). The burn PERCENTAGES are
  // computed on the WEIGHTED unit `input + output + cacheCreation +
  // w_cache*cacheRead`, composed with the per-model-family Quota Weight. When
  // quota weights are uncalibrated (the default) the family multipliers are all
  // 1.0 (identity) so the result reduces to the single-axis cache-weighted
  // total; with `w_cache = 1.0` (the default) it reduces further to the raw
  // .total — i.e. byte-for-byte the pre-#873 behaviour. Raw `.total` fields are
  // untouched; only these numerators change.
  const cacheReadWeight = getCacheReadWeight();
  const burnWeights = quotaWeightCalibrated ? weights : { opus: 1, sonnet: 1, haiku: 1 };
  const weightedBurn5h = weightedQuotaBurn(byModel5h, cacheReadWeight, burnWeights);
  const weightedBurn7d = weightedQuotaBurn(byModel7d, cacheReadWeight, burnWeights);
  const weightedBurn24h = weightedQuotaBurn(byModel24h, cacheReadWeight, burnWeights);

  // Transcript+calibration ESTIMATE (the historical headline + fallback path).
  const estimatePercentLast5h = calibrated ? (weightedBurn5h / fiveHourQuota) * 100 : 0;
  const estimatePercentLast7d = calibrated ? (weightedBurn7d / weeklyQuota) * 100 : 0;
  const projectedWeeklyPercent = calibrated ? ((weightedBurn24h * 7) / weeklyQuota) * 100 : 0;

  // `pacingState` keys off the transcript-derived 24h projection (NOT the OAuth
  // headline) — it is part of the ADR-0021 projection family this seam leaves
  // intact. Unchanged.
  let pacingState: "under" | "on" | "over" = "under";
  if (calibrated) {
    if (projectedWeeklyPercent > 100) pacingState = "over";
    else if (projectedWeeklyPercent >= 80) pacingState = "on";
  }

  // OAuth rebase (issue #1083). When the authoritative meter read succeeds, the
  // headline `percentLast5h`/`percentLast7d` and the 5h `emergencyStop` are
  // rebased onto the real utilization — the meter IS the ground-truth 5h/7d
  // utilization, strictly better than a calibration guess. HARD INVARIANT: on
  // ANY failed/expired/garbage read the estimate stands; the headline NEVER
  // silently reads 0 (which would unblock dispatch during an outage), so
  // emergencyStop stays conservative. The ADR-0021 since-reset / Pace-Gate
  // machinery (percentSinceReset, weeklyEmergencyStop, projectPacingCurve) is
  // byte-for-byte untouched — only the rolling headline + 5h emergencyStop move.
  const oauth = await oauthPromise;
  let percentLast5h: number;
  let percentLast7d: number;
  let usageSource: "oauth" | "estimate";
  let oauthError: string | null;
  let oauthFiveHourResetsAt: string | null = null;
  let oauthSevenDayResetsAt: string | null = null;
  // `isOAuthUsageOk` is the type guard the seam exports for narrowing under the
  // orchestrator's `strict:false` tsconfig (a bare `if (oauth.ok)` does not
  // narrow a discriminated union without strictNullChecks — same reason
  // ov-request ships isOvOk/isOvFailure).
  if (isOAuthUsageOk(oauth)) {
    percentLast5h = oauth.data.fiveHour.utilization;
    percentLast7d = oauth.data.sevenDay.utilization;
    usageSource = "oauth";
    oauthError = null;
    oauthFiveHourResetsAt = oauth.data.fiveHour.resetsAt;
    oauthSevenDayResetsAt = oauth.data.sevenDay.resetsAt;
  } else {
    // Graceful degradation: fall back to the transcript+calibration estimate.
    // Logged (fail-loud) so a persistent OAuth outage is visible, but the gate
    // stays conservative on the estimate rather than reading 0.
    console.error(
      `[usage-tracker] OAuth usage meter unavailable (${oauth.code}); falling back to transcript estimate for percentLast5h/percentLast7d`,
    );
    percentLast5h = estimatePercentLast5h;
    percentLast7d = estimatePercentLast7d;
    usageSource = "estimate";
    oauthError = oauth.code;
  }

  // emergencyStop rides whichever headline is authoritative. On the OAuth path
  // the meter is a real 0–100 utilization so the calibration gate does not
  // apply; on the estimate path the historical `calibrated && >=90` gate holds
  // (an uncalibrated estimate is 0, so it stays false — unchanged behaviour).
  const emergencyStop =
    usageSource === "oauth"
      ? percentLast5h >= EMERGENCY_STOP_PERCENT
      : calibrated && percentLast5h >= EMERGENCY_STOP_PERCENT;

  const weightedTotal = (acc: Record<ModelFamily, TokenBreakdown>): number =>
    MODEL_FAMILIES.reduce((sum, f) => sum + acc[f].total * familyWeight(f, weights), 0);
  const quotaWeightLast5h = quotaWeightCalibrated ? weightedTotal(byModel5h) : 0;
  const quotaWeightLast7d = quotaWeightCalibrated ? weightedTotal(byModel7d) : 0;

  // Weekly Reset Anchor / since-reset fixed window (issue #856, ADR-0021).
  // Pure read-side projection: the effective boundary is derived ON READ from
  // the env projection, overridden by a more recent observed reset. Nothing
  // is persisted. Neutral (null/0/all-zero) when the env Anchor is unset.
  let tokensSinceReset: TokenBreakdown = { ...EMPTY_BREAKDOWN };
  let percentSinceReset = 0;
  let weeklyResetAnchor: string | null = null;
  if (anchorEnvMs !== null) {
    const envWindow = projectResetWindow(anchorEnvMs, nowMs);
    let effectiveBoundaryMs = envWindow.currentMs;
    // Auto-correct: an observed reset that is more recent than the env
    // projection (but not in the future relative to now) is the real boundary.
    if (
      mostRecentObservedResetMs !== null &&
      mostRecentObservedResetMs > effectiveBoundaryMs &&
      mostRecentObservedResetMs <= nowMs
    ) {
      console.warn(
        `[usage-tracker] Weekly Reset Anchor auto-corrected: observed reset ` +
          `${new Date(mostRecentObservedResetMs).toISOString()} overrides env projection ` +
          `${new Date(effectiveBoundaryMs).toISOString()} (env anchor ` +
          `${new Date(anchorEnvMs).toISOString()})`,
      );
      effectiveBoundaryMs = mostRecentObservedResetMs;
    }
    // Accumulate the since-reset window both as a flat breakdown (the unchanged
    // `tokensSinceReset` snapshot field, honest raw counts) AND per-family (for
    // the WEIGHTED `percentSinceReset` numerator, which composes both weighting
    // axes exactly like `percentLast7d`). (issue #873)
    const byModelSinceReset = emptyByModel();
    for (const e of sinceResetEntries) {
      if (e.tsMs >= effectiveBoundaryMs) {
        addBreakdown(tokensSinceReset, e.tokens);
        addBreakdown(byModelSinceReset[e.family], e.tokens);
      }
    }
    const weightedBurnSinceReset = weightedQuotaBurn(byModelSinceReset, cacheReadWeight, burnWeights);
    percentSinceReset = calibrated ? (weightedBurnSinceReset / weeklyQuota) * 100 : 0;
    weeklyResetAnchor = new Date(effectiveBoundaryMs).toISOString();
  }

  // Drift detector (issue #873). Fail-loud, ONCE per scan: when an operator has
  // seeded a reference `percentSinceReset` reading AND the quota is calibrated,
  // warn if the tracker's `percentSinceReset` has diverged from the reference
  // by more than `driftFactor` in either direction — a coarse "calibration has
  // rotted" signal so it is visible, not silent. Read-time detection only:
  // nothing is persisted and nothing self-recalibrates (the tracker stays a
  // pure read-side projection). Inert when the reference env var is unset.
  const driftReference = getDriftReferencePercent();
  if (driftReference !== null && calibrated && anchorEnvMs !== null) {
    const driftFactor = getDriftFactor();
    const tooHigh = percentSinceReset > driftReference * driftFactor;
    const tooLow = percentSinceReset < driftReference / driftFactor;
    if (tooHigh || tooLow) {
      console.warn(
        `[usage-tracker] calibration drift: percentSinceReset ` +
          `${percentSinceReset.toFixed(2)}% diverges from reference ` +
          `${driftReference.toFixed(2)}% by more than ${driftFactor}x ` +
          `(cacheReadWeight=${cacheReadWeight}, weeklyQuota=${weeklyQuota}); ` +
          `re-derive HYDRA_USAGE_WEEKLY_QUOTA_TOKENS / HYDRA_USAGE_CACHE_READ_WEIGHT ` +
          `against a fresh /usage reading`,
      );
    }
  }

  // Weekly hard-stop (the reset-aligned analogue of the 5h `emergencyStop`).
  // Computed here, AFTER `percentSinceReset` is finalised against the
  // effective Weekly Reset Anchor boundary. Stays false when the Anchor is
  // unset (percentSinceReset === 0) or the quota is uncalibrated.
  const weeklyEmergencyStop = calibrated && percentSinceReset >= EMERGENCY_STOP_PERCENT;

  return {
    tokensLast5h: acc5h,
    tokensLast7d: acc7d,
    tokensLast24h: tokens24h,
    percentLast5h,
    percentLast7d,
    usageSource,
    oauthError,
    oauthFiveHourResetsAt,
    oauthSevenDayResetsAt,
    projectedWeeklyPercent,
    pacingState,
    emergencyStop,
    weeklyEmergencyStop,
    calibrated,
    byModel: byModel7d,
    bySkillByModel,
    quotaWeightLast5h,
    quotaWeightLast7d,
    quotaWeightCalibrated,
    weeklyQuotaTokens: weeklyQuota,
    fiveHourQuotaTokens: fiveHourQuota,
    filesScanned,
    filesSkippedByMtime,
    linesParsed,
    linesWithUsage,
    parseErrors,
    generatedAt: now.toISOString(),
    cacheHitRatioLast5h: cacheHitRatio(acc5h),
    cacheHitRatioLast7d: cacheHitRatio(acc7d),
    tokensSinceReset,
    percentSinceReset,
    weeklyResetAnchor,
  };
}

export interface ParsedUsageLine {
  tsMs: number;
  tokens: TokenBreakdown;
  /**
   * Raw `message.model` string verbatim (or "" when absent). The scan loop
   * runs it through `modelToFamily()` to bucket `byModel`; surfacing the raw
   * string keeps the parser pure and lets tests pin classification
   * independently. (issue #691)
   */
  model: string;
}

/**
 * Parse one JSONL line. Three outcomes:
 *   - `null`     — malformed JSON; caller counts as parseError.
 *   - `"skip"`   — valid JSON but no usage block, no timestamp, or zero
 *                  tokens. The common case: most lines are user messages,
 *                  snapshots, tool results, etc.
 *   - object     — contributes to the rolling windows.
 *
 * Exported so tests can pin the parsing rules without round-tripping
 * through the filesystem.
 */
export function parseUsageLine(line: string): ParsedUsageLine | "skip" | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const ts = obj?.timestamp;
  if (typeof ts !== "string") return "skip";
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs)) return "skip";

  const usage = obj?.message?.usage;
  if (!usage || typeof usage !== "object") return "skip";

  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
  const total = input + output + cacheRead + cacheCreation;
  if (total === 0) return "skip";

  const model = typeof obj?.message?.model === "string" ? obj.message.model : "";

  return {
    tsMs,
    tokens: { input, output, cacheRead, cacheCreation, total },
    model,
  };
}

/**
 * Extract an observed weekly/rate-limit RESET instant (epoch-ms) from one
 * JSONL line, or `null` when the line carries no reset signal.
 *
 * Claude Code has no documented schema for this, so we probe the field names
 * an Anthropic rate-limit payload realistically surfaces, in priority order:
 *
 *   1. `obj.message.usage.resets_at` / `reset_at` — usage block reset hint.
 *   2. `obj.message.rate_limit.resets_at` / a `rate_limit_*` error block.
 *   3. A top-level `obj.resetsAt` / `obj.reset_at` / `obj.usageLimitResetTime`
 *      that some harness builds attach to a limit-notice line.
 *
 * Each candidate is accepted only if it parses to a finite instant (ISO-8601
 * string OR epoch-seconds/ms number). This is intentionally permissive on
 * shape and strict on parse: an unrecognised line is simply `null`, never a
 * throw, so the scan never breaks on transcript-format drift. Exported so the
 * auto-correct rule is unit-testable without the filesystem. (issue #856)
 */
export function parseObservedResetMs(line: string): number | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const candidates: unknown[] = [
    obj?.message?.usage?.resets_at,
    obj?.message?.usage?.reset_at,
    obj?.message?.rate_limit?.resets_at,
    obj?.message?.rate_limit?.reset_at,
    obj?.message?.error?.rate_limit?.resets_at,
    obj?.rate_limit?.resets_at,
    obj?.resetsAt,
    obj?.reset_at,
    obj?.usageLimitResetTime,
  ];
  for (const c of candidates) {
    const ms = coerceInstantMs(c);
    if (ms !== null) return ms;
  }
  return null;
}

/**
 * Coerce a candidate reset value to epoch-ms. Accepts an ISO-8601 string or a
 * numeric epoch (seconds if < 1e12, else milliseconds). Returns null on
 * anything non-finite or non-positive. Pure helper for {@link parseObservedResetMs}.
 */
function coerceInstantMs(value: unknown): number | null {
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Heuristic: a 2026 epoch in seconds is ~1.7e9; in ms it is ~1.7e12.
    return value < 1e12 ? value * 1000 : value;
  }
  return null;
}

/**
 * Cache-hit ratio for one accumulated window.
 *
 * `cacheRead / (cacheRead + cacheCreation + input)` — output tokens are
 * NOT cache-eligible so they never enter the denominator; cacheCreation
 * IS in the denominator so cache-warming cost is counted honestly.
 * Returns 0 when the denominator is 0 (zero-total guard — no NaN, no
 * division by zero). The result is always in the closed interval [0, 1].
 *
 * Exported so tests can pin the formula without round-tripping through
 * the filesystem.
 */
export function cacheHitRatio(b: TokenBreakdown): number {
  const denominator = b.cacheRead + b.cacheCreation + b.input;
  if (denominator === 0) return 0;
  return b.cacheRead / denominator;
}

function addBreakdown(target: TokenBreakdown, src: TokenBreakdown): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheRead += src.cacheRead;
  target.cacheCreation += src.cacheCreation;
  target.total += src.total;
}

/**
 * Autopilot classes the orchestrator sheds when the **Subscription Usage
 * Tracker** projects we'll exceed the weekly quota at the current rate.
 *
 * Keep `dev_*`, `qa_*`, `research_*`, `design_concept_*`, and `health` —
 * those are the value-bearing and safety-critical paths. Drop the
 * board-hygiene + discovery + scout classes when pacing is over because
 * they're high-volume signal-driven dispatches that don't directly move
 * Target Outcomes. This list is policy, not measurement; if you change
 * it, also update the autopilot playbook table that documents class
 * eligibility.
 */
export const PACING_SHEDDABLE_CLASSES: readonly string[] = Object.freeze([
  "sweep_orch",
  "sweep_target",
  "discover_orch",
  "discover_target",
  "scout_orch",
]);

export interface UsageEligibility {
  /**
   * False when the tracker reports `emergencyStop` (5h consumption at
   * or above 90% of calibrated quota). The autopilot turn MUST NOT
   * dispatch anything when `allow` is false — every dispatch class is
   * blocked, not just sheddable ones, because we're about to hit the
   * Anthropic 5h session cap and want to leave headroom for whatever
   * the operator dispatches manually.
   */
  allow: boolean;
  /**
   * Classes the autopilot turn must skip. Empty unless pacingState is
   * "over", in which case it carries `PACING_SHEDDABLE_CLASSES`. Has no
   * meaning when `allow` is false (every class is blocked).
   */
  shed: readonly string[];
  reasons: {
    emergencyStop: boolean;
    /**
     * True when the weekly hard-stop is the reason `allow` is false: ≥90% of
     * the weekly quota burned since the current Weekly Reset Anchor boundary
     * (`UsageSnapshot.weeklyEmergencyStop`). Independent of `emergencyStop`;
     * either one forces `allow=false` and blocks every dispatch class.
     */
    weeklyEmergencyStop: boolean;
    pacingShed: boolean;
    calibrated: boolean;
    /**
     * Operator-only **Autopilot pause** flag (issue #988). When true, the
     * autopilot is paused: the launcher (pace-gate.sh) skips spawning a run
     * and the brain (decide.py) drains (no new dispatches). It forces
     * `allow=false` like `emergencyStop`, but is an INDEPENDENT, durable,
     * operator-held flag — not a quota signal. Defaults to `false`; the value
     * is overlaid at the route/collector seam (NOT inside the pure
     * `projectEligibility`) by {@link overlayPauseEligibility}.
     */
    paused: boolean;
  };
  /**
   * Position of total burn relative to the **Pacing Curve** for this instant
   * in the week (issue #857, ADR-0021). ADDITIVE — does NOT yet affect `allow`
   * or `shed`; the Pace Gate that acts on it lands in #858. "on" when the
   * Anchor is unset or the quota is uncalibrated (no curve to compare against).
   */
  paceState: PaceState;
  /**
   * The **Pacing Curve** target: the % of weekly quota burn that *should* have
   * accumulated by `usage.generatedAt` — a linear ramp from 0 at the current
   * Weekly Reset Anchor boundary to `ceiling*100` at the next boundary. 0
   * (neutral) when the Anchor is unset. (issue #857)
   */
  targetPercent: number;
  /**
   * Actual % of weekly quota consumed since the current Weekly Reset Anchor
   * boundary — `usage.percentSinceReset`, surfaced here so a caller comparing
   * it against `targetPercent` needn't reach back into the snapshot. (issue #857)
   */
  sinceResetPercent: number;
  /**
   * ISO-8601 of the effective current-window Weekly Reset Anchor boundary
   * (`usage.weeklyResetAnchor`), or `null` when the Anchor env var is
   * unset/unparseable. (issue #857)
   */
  anchor: string | null;
  usage: UsageSnapshot;
}

/**
 * Compute the **Pacing Curve** target percent and the burn's position relative
 * to it, derived purely from the snapshot (no `Date.now()` — `now` comes from
 * `snapshot.generatedAt`, keeping this a pure function of the snapshot).
 *
 * The curve is a linear ramp from 0 at the current Weekly Reset Anchor boundary
 * to `ceiling*100` at the next boundary (7 days later):
 *   `fraction   = clamp01((now - currentMs) / WINDOW_7D_MS)`
 *   `targetPct  = ceiling * 100 * fraction`
 * where `currentMs` is parsed from `snapshot.weeklyResetAnchor`.
 *
 * When the Anchor is unset (`weeklyResetAnchor === null`) — or its ISO is
 * unparseable — there is no curve: `targetPercent` is 0 and `paceState` is the
 * neutral "on". Otherwise paceState compares `percentSinceReset` to the target
 * within ±{@link PACE_STATE_TOLERANCE_PERCENT} percentage points. (issue #857)
 */
function projectPacingCurve(
  snapshot: UsageSnapshot,
  ceiling: number,
): { paceState: PaceState; targetPercent: number; sinceResetPercent: number } {
  const sinceResetPercent = snapshot.percentSinceReset;
  const anchorIso = snapshot.weeklyResetAnchor;

  if (anchorIso === null) {
    // No Weekly Reset Anchor → no curve to be ahead/behind of. Neutral.
    return { paceState: "on", targetPercent: 0, sinceResetPercent };
  }
  const currentMs = Date.parse(anchorIso);
  const nowMs = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(currentMs) || !Number.isFinite(nowMs)) {
    // Defensive: a malformed timestamp on a snapshot we own. Stay neutral
    // rather than projecting a NaN curve. Logged so the bad value is visible.
    console.error(
      `[usage-tracker] projectPacingCurve got an unparseable timestamp ` +
        `(weeklyResetAnchor=${JSON.stringify(anchorIso)}, generatedAt=${JSON.stringify(
          snapshot.generatedAt,
        )}); treating Pacing Curve as neutral`,
    );
    return { paceState: "on", targetPercent: 0, sinceResetPercent };
  }

  const fraction = Math.min(1, Math.max(0, (nowMs - currentMs) / WINDOW_7D_MS));
  const targetPercent = ceiling * 100 * fraction;

  let paceState: PaceState = "on";
  if (sinceResetPercent > targetPercent + PACE_STATE_TOLERANCE_PERCENT) {
    paceState = "ahead";
  } else if (sinceResetPercent < targetPercent - PACE_STATE_TOLERANCE_PERCENT) {
    paceState = "behind";
  }
  return { paceState, targetPercent, sinceResetPercent };
}

/**
 * Pure projection from a snapshot to an autopilot-facing eligibility
 * verdict. Surfaces three independent facts:
 *   - `allow` (the hard-stop signal)
 *   - `shed` (the soft-throttle list)
 *   - `reasons` (so callers can log *why* without re-deriving)
 *
 * Uncalibrated snapshots always return `{ allow: true, shed: [] }` —
 * the tracker stays out of the way until the operator's env-var
 * calibration confirms it's reading real ground truth.
 */
export function projectEligibility(snapshot: UsageSnapshot): UsageEligibility {
  // EITHER hard-stop (5h OR weekly) blocks every dispatch class. Both ride the
  // same allow=false drain path the operator pause uses.
  const allow = !snapshot.emergencyStop && !snapshot.weeklyEmergencyStop;
  const pacingShed = snapshot.pacingState === "over";
  const shed = pacingShed ? PACING_SHEDDABLE_CLASSES : [];
  // Pacing Curve verdict (issue #857). ADDITIVE — does NOT touch allow/shed;
  // the Pace Gate that acts on paceState lands in #858. Reads the ceiling from
  // env here so callers (incl. the HTTP route) get the live verdict.
  const { paceState, targetPercent, sinceResetPercent } = projectPacingCurve(
    snapshot,
    getWeeklyPaceCeiling(),
  );
  return {
    allow,
    shed,
    reasons: {
      emergencyStop: snapshot.emergencyStop,
      weeklyEmergencyStop: snapshot.weeklyEmergencyStop,
      pacingShed,
      calibrated: snapshot.calibrated,
      // Default not-paused. The pause flag is a Redis read that does NOT
      // belong inside this pure projection — it is overlaid at the
      // route/collector seam via overlayPauseEligibility().
      paused: false,
    },
    paceState,
    targetPercent,
    sinceResetPercent,
    anchor: snapshot.weeklyResetAnchor,
    usage: snapshot,
  };
}

/**
 * Overlay the operator-only **Autopilot pause** flag (issue #988) onto an
 * eligibility projection, at the caller/route seam.
 *
 * `projectEligibility` is a PURE function of its snapshot (no IO, no
 * `Date.now()`) — exactly as the emergency-brake is read at the
 * collector/health seam and never folded into the projection. The pause flag
 * is a Redis read, so the read happens in the caller (the
 * `/api/usage/eligibility` route, `autopilot-idle`, `collect-state.sh` via the
 * route) and the boolean is overlaid here, preserving the documented purity
 * contract while satisfying AC#3/AC#7 ("eligibility surfaces paused").
 *
 * When `paused` is true this returns a new eligibility object with
 * `allow=false` and `reasons.paused=true`, so EVERY dispatch class is blocked
 * for the turn (the same hard-stop path `emergencyStop` rides) — the autopilot
 * drains. When `paused` is false the input is returned UNCHANGED (no spurious
 * mutation): pause never *enables* anything a quota stop disabled. Pure: no IO,
 * no mutation of the input object.
 */
export function overlayPauseEligibility(
  eligibility: UsageEligibility,
  paused: boolean,
): UsageEligibility {
  if (!paused) return eligibility;
  return {
    ...eligibility,
    allow: false,
    reasons: { ...eligibility.reasons, paused: true },
  };
}
