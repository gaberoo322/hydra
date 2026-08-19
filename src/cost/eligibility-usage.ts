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
 * THE ANCHOR FOLLOWS THE ACCOUNT, for the same reason. The Weekly Reset Anchor
 * is derived from the meter's own `seven_day.resets_at`, with the
 * `HYDRA_USAGE_WEEKLY_RESET_ANCHOR` env seed demoted to a meter-dark fallback.
 * That env var is one global constant while the reset boundary is per-account
 * (different weekdays across accounts), so a `/login` to a different account
 * used to leave the Pacing Curve phased to the previous account's week — a
 * silent mis-pace in both directions (starving the Pace Gate, or pacing it too
 * hot). The meter already auto-follows the credentials file by design; now the
 * anchor does too. See {@link getEligibilityUsage} for the measured incident.
 *
 * THE GOVERNOR FAILS CLOSED, NOT OPEN (issue #4165, 2026-08-19). A blind meter
 * used to degrade to `usageSource: "estimate"` with ZEROED percentages and a
 * `meterUnavailable` flag gated behind a sustained-failure count — so a
 * rate-limited meter produced `percentLast7d: 0` and `allow: true` while real
 * weekly usage was ~92%, past the 90% weekly stop. Measured: the verdict flipped
 * from allow to block purely because the meter came back, with consumption
 * unchanged between the two reads. Admission was tracking METER AVAILABILITY,
 * not spend.
 *
 * The zeros were defended on the grounds that every consumer reads them behind
 * the `usageSource === "oauth"` guard. That was never fully true (`paceState`
 * had to be patched for exactly this in #3751), and it is the wrong shape
 * regardless: a spend governor must not synthesise a number it did not measure.
 * So the outage shape now reports `null` — an explicit unknown that cannot be
 * read as "0% used" by any consumer, guarded or not.
 *
 * The order of preference on a failed read is therefore:
 *   1. a LAST-GOOD reading inside {@link getEligibilityLastGoodMaxAgeMs} — used
 *      as real `usageSource: "oauth"` input, marked stale with its age, so the
 *      hard stops keep engaging off a real number;
 *   2. otherwise, explicit unknown (`null` percentages) with
 *      `meterUnavailable: true`, which forces `allow: false`.
 *
 * DO NOT COPY THE `design-concept-reconcile-check` PRECEDENT HERE. That gate
 * fails OPEN on a transport miss on purpose (#3650): a merge gate that fails
 * closed on an infra blip wedges the whole merge queue for zero safety gain.
 * The reasoning inverts for a spend governor — failing open spends real money
 * during exactly the windows where usage is high enough to be rate-limiting the
 * meter. The two must not share a default.
 *
 * The cost of failing closed is a SKIP, not a halt: `pace-gate.sh` re-consults
 * this endpoint every tick and admission resumes on the first successful read,
 * and step 1 above absorbs ordinary 429 bursts without blocking at all.
 */

import { readOAuthCached } from "./oauth-read-cache.ts";
import { readOAuthUsage, isOAuthUsageOk } from "./oauth-usage.ts";
import type { OAuthUsageResult, OAuthUsageData } from "./oauth-usage.ts";
import { deriveHardStop } from "./eligibility.ts";
import { getWeeklyResetAnchorMs, getEligibilityLastGoodMaxAgeMs } from "./config.ts";
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

/** Outcome of a meter-only eligibility read. Never throws. */
export interface EligibilityUsageResult {
  input: EligibilityUsageInput;
  /** True when the served meter value is a last-good one (a fresh read failed). */
  stale: boolean;
  /** Age of the served meter value in ms, or null when none was served. */
  ageMs: number | null;
  /**
   * True when the verdict has NO usable measurement of quota — no fresh meter
   * read AND no last-good reading inside
   * {@link getEligibilityLastGoodMaxAgeMs}. `overlayMeterUnavailableEligibility`
   * turns it into `allow: false` for the whole autopilot: this field is NOT a
   * passive observability flag, it gates.
   *
   * Issue #4165 removed the sustained-failure threshold that used to gate this.
   * Requiring 3 consecutive failures meant one or two failed reads against a
   * cold cache (every process restart starts cold, and the backoff ladder
   * RESUMES from Redis across a restart while the in-memory last-good does not)
   * produced zeroed percentages with `meterUnavailable: false` — the exact
   * shape that admitted a run at ~92% real weekly usage on 2026-08-19. The
   * transient-blip protection that threshold was reaching for now lives where
   * it belongs: in the last-good fallback above, which rides out a 429 burst on
   * a REAL number instead of on an unmeasured `false`.
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
  // `projectResetWindow(seedMs, nowMs).currentMs` — projected in 7-day multiples
  // per CONTEXT.md ("projected forward in 7-day multiples"), NOT a raw seed
  // instant. The snapshot path already rolls the anchor via `deriveSinceReset`
  // (snapshot-assembly.ts); this path used the raw seed, so a stale anchor (e.g.
  // 8 weeks old) clamped `projectPacingCurve`'s `fraction =
  // clamp01((now-anchor)/7d)` to 1.000, pinning `targetPercent` at the full
  // Pacing Ceiling and making `paceState === "ahead"` unreachable — the Pacing
  // Curve ran inert.
  //
  // The env value is the FALLBACK seed only (see the meter-derived anchor
  // below): it is a single hand-maintained global constant, so it is correct for
  // at most one Claude account at a time.
  const envAnchor =
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
      "[eligibility-usage] cached OAuth read threw; admission verdict blocks (no measurement)",
    );
    // A throw here is a programming/IO fault in the cache seam itself. There is
    // no reading and no age to reason about, so the governor has nothing to
    // gate on: block.
    return unavailable(generatedAt, envAnchor);
  }

  if (!isOAuthUsageOk(cached.result)) {
    // The fresh read failed. Prefer a REAL last-good reading over refusing
    // outright (issue #4165 AC4) — `readOAuthCached` keeps the last successful
    // meter value alive past the headline's too-stale eviction precisely so this
    // path has something to gate on. Weekly utilization only rises within a
    // window, so a recent last-good is a lower bound on current spend: it can
    // still prove a stop, which is what the 2026-08-19 incident needed.
    const lastGood = cached.lastKnownOAuth ?? null;
    const lastGoodAgeMs = cached.lastKnownOAuthAgeMs ?? null;
    const maxAgeMs = getEligibilityLastGoodMaxAgeMs();
    if (lastGood !== null && lastGoodAgeMs !== null && lastGoodAgeMs <= maxAgeMs) {
      logger.warn(
        {
          code: cached.result.code,
          lastGoodAgeMs,
          maxAgeMs,
          consecutiveFailures: cached.consecutiveFailures,
          percentLast7d: lastGood.sevenDay.utilization,
        },
        "[eligibility-usage] OAuth meter read failed; gating on the STALE last-good reading (#4165)",
      );
      return {
        input: buildMeterInput(lastGood, generatedAt, envAnchor, nowMs),
        stale: true,
        ageMs: lastGoodAgeMs,
        meterUnavailable: false,
      };
    }
    // No fresh read and no usable last-good: the governor is blind. FAIL CLOSED
    // (issue #4165 AC3). Deliberately NOT gated on a consecutive-failure count —
    // "we have failed fewer than 3 times" is not evidence of headroom, and the
    // blip protection it was standing in for is the last-good branch above.
    logger.error(
      {
        code: cached.result.code,
        lastGoodAgeMs,
        maxAgeMs,
        consecutiveFailures: cached.consecutiveFailures,
      },
      lastGood === null
        ? "[eligibility-usage] OAuth meter unreadable and no last-good reading exists; admission BLOCKS (#4165)"
        : "[eligibility-usage] OAuth meter unreadable and the last-good reading is past the admission staleness ceiling; admission BLOCKS (#4165)",
    );
    return unavailable(generatedAt, envAnchor);
  }

  return {
    input: buildMeterInput(cached.result.data, generatedAt, envAnchor, nowMs),
    stale: cached.stale,
    ageMs: cached.ageMs,
    meterUnavailable: false,
  };
}

/**
 * Build the admission-verdict input from ONE OAuth meter reading.
 *
 * Shared by the FRESH-read path and the stale-last-good fallback (issue #4165)
 * so the two cannot drift: a served last-good must be projected through exactly
 * the same anchor derivation, hard-stop derivation and paid-overage gate as a
 * live read, or "we fell back to last-good" would quietly also mean "we stopped
 * enforcing some of the stops". `nowMs` (not the reading's own timestamp) drives
 * the reset-window projection, because the question is which weekly window we
 * are in NOW.
 */
function buildMeterInput(
  data: OAuthUsageData,
  generatedAt: string,
  envAnchor: string | null,
  nowMs: number,
): EligibilityUsageInput {
  const percentLast5h = data.fiveHour.utilization;
  const percentLast7d = data.sevenDay.utilization;

  // ACCOUNT-FOLLOWING ANCHOR. The Weekly Reset Anchor is derived from
  // the meter's OWN `seven_day.resets_at` whenever the meter supplies one, and
  // falls back to the env seed only when it does not.
  //
  // WHY: `HYDRA_USAGE_WEEKLY_RESET_ANCHOR` is a single global constant, but the
  // weekly reset boundary is PER ACCOUNT and not even the same weekday across
  // accounts (observed: one account resets Wed 17:00Z, another Sat 09:59:59Z).
  // `readAccessToken()` in oauth-usage.ts deliberately re-reads the credentials
  // file on every call so the meter auto-follows a `/login` to a different
  // account — but the anchor did not follow, so after a switch the Pacing Curve
  // was phased to the WRONG account's week with no alarm. Measured 2026-08-14 on
  // a personal->work switch: elapsed read 29% instead of 90%, so targetPercent
  // was 26.8% against 38% actual, `paceState` pinned to "ahead", and the Pace
  // Gate skipped EVERY tick. The fake target would not have crossed actual until
  // after the real reset, so the whole remaining ~60% of the week would have
  // expired unused. The failure is silent in both directions: the opposite phase
  // error inflates the target and paces the burn too HOT.
  //
  // The meter already carries the true boundary and `parseOAuthUsageBody` already
  // parses it into `sevenDay.resetsAt` — it was simply discarded here. The stale
  // comment this replaces claimed "the meter-only path has no observed-reset
  // signal to auto-correct with"; that was true of the TRANSCRIPT scan (which
  // this path deliberately never opens), not of the meter.
  //
  // `resets_at` is the window END; the anchor is the window START. Rather than
  // subtract 7d by hand, feed it through the same `projectResetWindow` used for
  // the env seed: `currentMs` floors ANY reset instant — future (the normal
  // case, one window ahead) or past (a stale/clamped value) — to the start of
  // the window containing `nowMs`. One code path, both semantics, no new
  // constant.
  const meterResetMs = Date.parse(data.sevenDay.resetsAt ?? "");
  const weeklyResetAnchor = Number.isFinite(meterResetMs)
    ? new Date(projectResetWindow(meterResetMs, nowMs).currentMs).toISOString()
    : envAnchor;

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

  // Paid-overage gate. `armed` is a CAPABILITY, not a spend reading: it says
  // that when this account exhausts a window the overflow bills real money
  // outside the subscription. Because it is read from the meter — which
  // re-reads the credentials file on every call — the gate follows a `/login`
  // to a different account with no per-account configuration, which is the
  // whole point (the operator's rule is "never extra usage, on ANY account").
  // A meter that omits `extra_usage` yields armed:false from `parseExtraUsage`:
  // no facility means nothing can bill.
  const extraUsageArmed = data.extraUsage?.armed === true;
  if (extraUsageArmed) {
    logger.warn(
      { usedCredits: data.extraUsage?.usedCredits ?? null },
      "[eligibility-usage] paid overage (extra usage) is ARMED on the logged-in account; " +
        "blocking ALL autopilot dispatch until it is disabled in the Claude console " +
        "(Hydra cannot switch it off through the API)",
    );
  }

  return {
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
    extraUsageArmed,
  };
}

/**
 * The EXPLICIT-UNKNOWN input served when quota cannot be measured at all — no
 * fresh meter read and no last-good reading inside the admission staleness
 * ceiling (issue #4165).
 *
 * The percentages are `null`, not `0`. Zeros were the whole defect: they read as
 * "0% used, run freely" to anything that did not happen to be behind the
 * `usageSource === "oauth"` guard, and on 2026-08-19 that produced
 * `percentLast7d: 0` with `allow: true` against ~92% real weekly usage.
 * `null` cannot be misread that way by any consumer.
 *
 * `meterUnavailable` is always `true` here — it is no longer a caller-supplied
 * verdict. There is exactly one condition that reaches this function (no usable
 * measurement) and exactly one correct response to it for a spend governor:
 * block. `overlayMeterUnavailableEligibility` turns it into `allow: false`.
 */
function unavailable(
  generatedAt: string,
  weeklyResetAnchor: string | null,
): EligibilityUsageResult {
  return {
    input: {
      // Explicitly UNKNOWN, not zero. See the function docstring.
      percentLast5h: null,
      percentLast7d: null,
      percentSinceReset: null,
      usageSource: "estimate",
      // The stops derived from the (absent) percentages stay false — there is no
      // reading to derive them from. They are not what blocks here;
      // `meterUnavailable` is, and it blocks unconditionally.
      emergencyStop: false,
      weeklyEmergencyStop: false,
      pacingState: "under",
      calibrated: false,
      weeklyResetAnchor,
      generatedAt,
      // No meter value means no evidence either way about paid overage. It does
      // not need to be inferred: `meterUnavailable` already forces allow=false,
      // so there is no window in which the autopilot dispatches on an
      // unverified account.
      extraUsageArmed: false,
    },
    stale: false,
    ageMs: null,
    meterUnavailable: true,
  };
}
