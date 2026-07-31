/**
 * src/cost/eligibility-usage.ts — the METER-ONLY usage input for the autopilot
 * admission verdict (`GET /api/usage/eligibility`).
 *
 * WHY THIS EXISTS (2026-07-30 outage). The eligibility route used to `await
 * getUsage()`, the full Subscription-Usage snapshot. That snapshot's headline
 * percentages already came from the authoritative Anthropic OAuth meter (issue
 * #1083) — but producing it ALSO ran the transcript scan, which reads and
 * JSON-parses every `~/.claude/projects/**\/*.jsonl` file whose mtime falls
 * inside the rolling 7-day window. That corpus grew to 42,837 in-window files /
 * 1.70 GB, so a cold `/api/usage/eligibility` stopped responding inside the Pace
 * Gate's 10s probe budget (measured: >90s, zero bytes). The gate fail-safes on
 * an unreadable endpoint, so it silently stopped launching the autopilot — 104
 * consecutive skips over three days, with `/api/health` still green.
 *
 * That coupling was also a POSITIVE FEEDBACK LOOP, which is why it degrades
 * rather than merely being slow: every autopilot dispatch writes more
 * transcripts, which enlarges the 7-day window, which slows the very endpoint
 * that decides whether the autopilot may launch. Running more work made the
 * starter slower. It cannot self-recover, because the corpus only grows.
 *
 * THE FIX: the admission verdict asks the meter and nothing else. Every field
 * {@link projectEligibility} reads is available from the OAuth meter plus
 * config — see {@link EligibilityUsageInput} — so this path never opens a
 * transcript. The transcript scan remains the source of the per-model /
 * per-skill / per-dispatch-kind cross-tabs on `GET /api/usage`, which no
 * admission decision consumes and no Anthropic endpoint can supply.
 *
 * ACCURACY, not just speed: `percentSinceReset` here is the meter's own 7-day
 * utilization rather than the previous local `tokensSinceReset ÷
 * HYDRA_USAGE_WEEKLY_QUOTA_TOKENS` division. That divisor is a hand-calibrated
 * constant which has been wrong by 31x (issue #3751) and silently inerted the
 * whole Pacing Curve; its 5-hour sibling is still ~2.4x off. Anthropic's number
 * needs no calibration and cannot drift.
 *
 * FAIL-OPEN IS PRESERVED, DELIBERATELY. {@link deriveHardStop} gates on
 * `usageSource === "oauth"` (issue #1124): when the meter is unavailable the
 * hard stop does NOT engage. Rebuilding that invariant here would be a silent
 * policy change, so this module reproduces it exactly — a meter outage yields
 * `usageSource: "estimate"` with zeroed percentages, which reads as "no
 * evidence to stop on", never as "0% used, run freely" (the percentages are
 * only ever consumed through the `usageSource === "oauth"` guard). The
 * observability gap that fail-open leaves — a brake that is off while nobody is
 * told — is real and is tracked separately; it is NOT this module's to invent.
 */

import { readOAuthCached } from "./oauth-read-cache.ts";
import { readOAuthUsage, isOAuthUsageOk } from "./oauth-usage.ts";
import type { OAuthUsageResult } from "./oauth-usage.ts";
import { deriveHardStop } from "./eligibility.ts";
import { getWeeklyResetAnchorMs } from "./config.ts";
import { logger } from "../logger.ts";

/**
 * The exact structural slice of the usage snapshot that the admission verdict
 * reads. Deliberately NOT `UsageSnapshot`: naming the real dependency is what
 * proves the transcript scan is not one, and it lets a meter-only value satisfy
 * the same projection a full snapshot does.
 *
 * `UsageSnapshot` satisfies this shape structurally, so every existing caller of
 * {@link projectEligibility} keeps working unchanged.
 */
export interface EligibilityUsageInput {
  percentLast5h: number;
  percentLast7d: number;
  percentSinceReset: number;
  usageSource: "oauth" | "estimate";
  emergencyStop: boolean;
  weeklyEmergencyStop: boolean;
  pacingState: "under" | "on" | "over";
  calibrated: boolean;
  weeklyResetAnchor: string | null;
  generatedAt: string;
}

/** Outcome of a meter-only eligibility read. Never throws. */
export interface EligibilityUsageResult {
  input: EligibilityUsageInput;
  /** True when the served meter value is a last-good one (a fresh read failed). */
  stale: boolean;
  /** Age of the served meter value in ms, or null when none was served. */
  ageMs: number | null;
  /**
   * True when no meter value was available at all, so the verdict is running
   * fail-open per #1124. The route surfaces this; nothing gates on it.
   */
  meterUnavailable: boolean;
}

/**
 * Build the admission-verdict usage input from the Anthropic OAuth meter alone.
 *
 * Reads through {@link readOAuthCached}, so it inherits the independent 5-minute
 * TTL, single-flight de-duplication, the exponential backoff gate, and last-good
 * staleness serving already built for the meter (issues #1090 / #2619 / #2666 /
 * #2840). That matters: the meter is rate-limited in practice (76 `429`s and 32
 * non-2xx in one observed 24h window), so an uncached per-request GET would
 * trade a slow endpoint for a flaky one.
 *
 * Never throws — a meter failure degrades to the documented fail-open shape.
 */
export async function getEligibilityUsage(
  deps: {
    readUsage?: () => Promise<OAuthUsageResult>;
    now?: () => number;
  } = {},
): Promise<EligibilityUsageResult> {
  const nowMs = (deps.now ?? Date.now)();
  const generatedAt = new Date(nowMs).toISOString();
  const anchorMs = getWeeklyResetAnchorMs();
  const weeklyResetAnchor = anchorMs === null ? null : new Date(anchorMs).toISOString();

  let cached: Awaited<ReturnType<typeof readOAuthCached>>;
  try {
    cached = await readOAuthCached(deps.readUsage ?? readOAuthUsage, nowMs);
  } catch (err) {
    // The cached reader is already fail-safe internally; a throw here means a
    // programming/IO fault, not a meter outage. Degrade rather than 500 the
    // admission path — an unreadable endpoint is what stopped the autopilot in
    // the first place.
    logger.error(
      { err },
      "[eligibility-usage] cached OAuth read threw; degrading to fail-open input",
    );
    return unavailable(generatedAt, weeklyResetAnchor);
  }

  if (!isOAuthUsageOk(cached.result)) {
    logger.warn(
      { code: cached.result.code, ageMs: cached.ageMs },
      "[eligibility-usage] OAuth meter unavailable; admission verdict runs fail-open (#1124)",
    );
    return unavailable(generatedAt, weeklyResetAnchor);
  }

  const percentLast5h = cached.result.data.fiveHour.utilization;
  const percentLast7d = cached.result.data.sevenDay.utilization;

  // The meter's own 7-day utilization IS the position within the weekly window,
  // so it doubles as `percentSinceReset` for the Pacing Curve. This is the
  // accuracy win over the previous local `tokens ÷ configured-quota` division
  // (see the module docstring): no calibration constant, no drift.
  const percentSinceReset = percentLast7d;

  const { emergencyStop, weeklyEmergencyStop } = deriveHardStop({
    percentLast5h,
    percentLast7d,
    usageSource: "oauth",
  });

  return {
    input: {
      percentLast5h,
      percentLast7d,
      percentSinceReset,
      usageSource: "oauth",
      emergencyStop,
      weeklyEmergencyStop,
      // `pacingState` is the SNAPSHOT-level weekly-projection verdict, distinct
      // from the Pacing Curve's `paceState` that projectEligibility computes
      // from percentSinceReset. Only `=== "over"` sheds classes, and shedding on
      // an unprojected value would be a guess, so this path never sheds on it.
      pacingState: "under",
      // Calibration described the local quota CONSTANTS. A meter-sourced verdict
      // does not use them, so it is authoritative by construction.
      calibrated: true,
      weeklyResetAnchor,
      generatedAt,
    },
    stale: cached.stale,
    ageMs: cached.ageMs,
    meterUnavailable: false,
  };
}

/**
 * The fail-open input served when no meter value is available (#1124).
 *
 * Zeroed percentages are safe ONLY because every consumer reads them behind the
 * `usageSource === "oauth"` guard — `deriveHardStop` and `fiveHourThrottleShed`
 * both short-circuit on a non-oauth source, so these zeros can never be mistaken
 * for a measured "0% used".
 */
function unavailable(
  generatedAt: string,
  weeklyResetAnchor: string | null,
): EligibilityUsageResult {
  return {
    input: {
      percentLast5h: 0,
      percentLast7d: 0,
      percentSinceReset: 0,
      usageSource: "estimate",
      emergencyStop: false,
      weeklyEmergencyStop: false,
      pacingState: "under",
      calibrated: false,
      weeklyResetAnchor,
      generatedAt,
    },
    stale: false,
    ageMs: null,
    meterUnavailable: true,
  };
}
