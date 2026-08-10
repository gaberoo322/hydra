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

import { readOAuthCached, OAUTH_SUSTAINED_FAILURE_THRESHOLD } from "./oauth-read-cache.ts";
import { readOAuthUsage, isOAuthUsageOk } from "./oauth-usage.ts";
import type { OAuthUsageResult } from "./oauth-usage.ts";
import { deriveHardStop } from "./eligibility.ts";
import { getWeeklyResetAnchorMs } from "./config.ts";
// Pure leaf (issue #1909): `projectResetWindow` rolls the seeded Weekly Reset
// Anchor forward in 7-day multiples to the current-window boundary. Imported
// one-way FROM this pure math leaf (it pulls in no eligibility/scan machinery),
// mirroring the snapshot path's `deriveSinceReset` use of the same helper.
import { projectResetWindow } from "./token-math.ts";
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
   * True when the meter is SUSTAINED-unavailable, so the verdict is running
   * fail-open per #1124 AND `overlayMeterUnavailableEligibility` forces
   * `allow=false` for the whole autopilot (2026-07-30 operator decision, PR
   * #3804) — this field is NOT a passive observability flag, it gates.
   *
   * Set true only when the consecutive-failed-read count from
   * {@link readOAuthCached} reaches {@link OAUTH_SUSTAINED_FAILURE_THRESHOLD}
   * (3), OR when the cached reader itself throws (a programming/IO fault, not
   * a meter outage). A single failed read — including the very first read of a
   * freshly-restarted process, where `oauthCache` is `null` and there is no
   * last-good value to fall back on — does NOT set this (issue #3821): every
   * process restart (i.e. every deploy) starts cold, and one transient GET
   * blip against that cold cache used to halt the whole autopilot until the
   * next successful read landed.
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
  const anchorEnvMs = getWeeklyResetAnchorMs();
  // INV-1 (issue #3751, design-concept issue-3751): the admission path's Weekly
  // Reset Anchor MUST be the effective CURRENT-WINDOW boundary —
  // `projectResetWindow(anchorEnvMs, nowMs).currentMs` — projected forward in
  // 7-day multiples per CONTEXT.md ("projected forward in 7-day multiples"), NOT
  // the raw seed instant from the env var. The snapshot path already rolls the
  // anchor via `deriveSinceReset` (snapshot-assembly.ts); this path used the raw
  // seed, so a stale anchor (e.g. 8 weeks old) clamped `projectPacingCurve`'s
  // `fraction = clamp01((now-anchor)/7d)` to 1.000, pinning `targetPercent` at
  // the full Pacing Ceiling and making `paceState === "ahead"` unreachable — the
  // Pacing Curve ran inert. The meter-only path has no observed-reset signal to
  // auto-correct with (it opens no transcript), so it projects the env anchor
  // directly, identical to the snapshot path's `envWindow.currentMs`.
  const weeklyResetAnchor =
    anchorEnvMs === null
      ? null
      : new Date(projectResetWindow(anchorEnvMs, nowMs).currentMs).toISOString();

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
    // A throw here is a programming/IO fault in the cache seam itself, not an
    // ordinary meter-read failure — it never absorbed transient blips in the
    // first place, so there is no sustained-vs-transient distinction to make.
    // Report unavailable immediately.
    return unavailable(generatedAt, weeklyResetAnchor, true);
  }

  if (!isOAuthUsageOk(cached.result)) {
    // Require SUSTAINED failure before reporting the meter unavailable (issue
    // #3821): `cached.consecutiveFailures` is 0 or unset only when the meter
    // has never failed on this ladder; a fresh process with a cold cache (every
    // process restart, i.e. every deploy) sees its first-ever failed read at
    // `consecutiveFailures === 1`, which is well below the threshold, so
    // `meterUnavailable` correctly stays false and the autopilot keeps running.
    // The same threshold `oauth-read-cache.ts` already uses for its sustained-
    // failure alarm (issue #3601) — reused rather than inventing a second one.
    const sustained = cached.consecutiveFailures >= OAUTH_SUSTAINED_FAILURE_THRESHOLD;
    logger.warn(
      {
        code: cached.result.code,
        ageMs: cached.ageMs,
        consecutiveFailures: cached.consecutiveFailures,
        sustained,
      },
      sustained
        ? "[eligibility-usage] OAuth meter sustained-unavailable; admission verdict blocks (#3821/#3804)"
        : "[eligibility-usage] OAuth meter read failed (transient, below sustained-failure threshold); admission verdict unaffected (#3821)",
    );
    return unavailable(generatedAt, weeklyResetAnchor, sustained);
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
 *
 * `meterUnavailable` is a caller-supplied verdict, not hardcoded `true` (issue
 * #3821): this shape is also returned for a single transient failed read
 * against a cold cache, where the fail-open `usageSource: "estimate"` input is
 * still correct (there genuinely is no meter value to report) but the
 * `allow=false`-forcing `meterUnavailable` flag must stay `false` until the
 * failure is sustained. See {@link OAUTH_SUSTAINED_FAILURE_THRESHOLD}.
 */
function unavailable(
  generatedAt: string,
  weeklyResetAnchor: string | null,
  meterUnavailable: boolean,
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
    meterUnavailable,
  };
}
