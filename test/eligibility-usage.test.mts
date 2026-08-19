/**
 * Unit tests for `getEligibilityUsage()` (`src/cost/eligibility-usage.ts`) — the
 * meter-only usage input behind the autopilot admission verdict.
 *
 * PRIMARY ACCEPTANCE CRITERION (issue #4165): the spend governor must FAIL
 * CLOSED when it cannot measure. Before this fix a meter that could not be read
 * degraded to `usageSource: "estimate"` with ZEROED percentages and a
 * `meterUnavailable` flag gated behind a consecutive-failure count, so a
 * rate-limited meter produced `percentLast7d: 0` with `allow: true` while real
 * weekly usage was ~92% — past the 90% weekly stop. The verdict flipped from
 * allow to block purely because the meter came back, with consumption unchanged
 * between the two reads: admission was tracking METER AVAILABILITY, not spend.
 *
 * The three states this suite pins, straight off the issue's AC5:
 *   1. live read            → verdict follows the usage
 *   2. read fails, recent last-good exists → use it, MARKED STALE, still gating
 *   3. read fails, no usable reading       → explicit unknown + fail closed
 *
 * SUPERSEDES the #3821 fail-open cases this block used to hold. #3821 required
 * 3 consecutive failures before `meterUnavailable` could be set, so that a
 * post-deploy blip against a cold cache would not halt the autopilot. That is
 * the behaviour #4165 removes: the backoff ladder RESUMES from Redis across a
 * restart while the in-memory last-good does NOT, so "cold cache, fewer than 3
 * failures" is reachable mid-outage — and it was the exact state that admitted
 * the 2026-08-19 run. The blip protection #3821 wanted now comes from the
 * last-good window (case 2), which rides out a 429 burst on a REAL number
 * instead of on an unmeasured `false`.
 *
 * The suite drives `getEligibilityUsage` with an injected `readUsage`/`now`,
 * exercising the real `readOAuthCached` cache/backoff state machine underneath
 * (not a stub), so the fallback ordering is pinned end-to-end.
 *
 * Suite lifecycle (CLAUDE.md authoring rules): a NEW top-level describe with
 * its own beforeEach/afterEach; env knobs pinned per-case; the shared
 * `oauth-read-cache.ts` module state reset per-case via `clearOAuthCache()`
 * so no episode leaks across cases (mirrors
 * `test/oauth-sustained-failure-alarm.test.mts`).
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { getEligibilityUsage } = await import("../src/cost/eligibility-usage.ts");
const { clearOAuthCache } = await import("../src/cost/oauth-read-cache.ts");
const { projectEligibility, overlayMeterUnavailableEligibility } = await import(
  "../src/cost/eligibility.ts"
);
const { projectResetWindow } = await import("../src/cost/token-math.ts");
import type { OAuthUsageResult } from "../src/cost/oauth-usage.ts";

const TTL_MS = 60_000;
// 1ms of HEADLINE stale headroom — effectively none, so `readOAuthCached`
// stops serving its own stale value almost immediately and the ADMISSION-level
// last-good fallback (#4165) is what these cases exercise. NOT `0`: the env
// reader rejects a non-positive value as invalid and falls back to the 30-minute
// default, which would silently keep the headline path in play instead.
const MAX_STALE_MS = 1;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 900_000;
const STEP_MS = 30 * 60_000; // > the backoff ceiling, so every call re-probes
/** Admission-level last-good ceiling for these cases: 60 min (the default). */
const LAST_GOOD_MAX_AGE_MS = 60 * 60_000;

const ENV_KEYS = [
  "HYDRA_OAUTH_USAGE_TTL_MS",
  "HYDRA_OAUTH_USAGE_MAX_STALE_MS",
  "HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS",
  "HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS",
  "HYDRA_ELIGIBILITY_LAST_GOOD_MAX_AGE_MS",
] as const;

const FAIL: OAuthUsageResult = { ok: false, code: "oauth-usage-rate-limited" };
const OK_READ: OAuthUsageResult = {
  ok: true,
  data: {
    fiveHour: { utilization: 12, resetsAt: null },
    sevenDay: { utilization: 34, resetsAt: null },
  },
};
/** The 2026-08-19 shape: weekly burn already past the 90% weekly hard stop. */
const OK_READ_PAST_WEEKLY_STOP: OAuthUsageResult = {
  ok: true,
  data: {
    fiveHour: { utilization: 2, resetsAt: null },
    sevenDay: { utilization: 92, resetsAt: null },
  },
};

function fixedReader(r: OAuthUsageResult): () => Promise<OAuthUsageResult> {
  return async () => r;
}

describe("getEligibilityUsage fails CLOSED on a blind meter (issue #4165)", () => {
  let saved: Map<string, string | undefined>;

  beforeEach(() => {
    saved = new Map();
    for (const k of ENV_KEYS) saved.set(k, process.env[k]);
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = String(TTL_MS);
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = String(MAX_STALE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = String(BACKOFF_BASE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = String(BACKOFF_MAX_MS);
    process.env.HYDRA_ELIGIBILITY_LAST_GOOD_MAX_AGE_MS = String(LAST_GOOD_MAX_AGE_MS);
    clearOAuthCache();
  });

  afterEach(() => {
    clearOAuthCache();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // --- AC5 case 1: a live read gates on the usage it read ------------------

  test("AC5/1: a healthy meter reports meterUnavailable:false with real percentages", async () => {
    const r = await getEligibilityUsage({ readUsage: fixedReader(OK_READ), now: () => 0 });
    assert.equal(r.meterUnavailable, false);
    assert.equal(r.stale, false, "a fresh read is not stale");
    assert.equal(r.input.usageSource, "oauth");
    assert.equal(r.input.percentLast5h, 12);
    assert.equal(r.input.percentLast7d, 34);
    assert.equal(projectEligibility(r.input).allow, true, "34% weekly is well under the stop");
  });

  test("AC5/1: a live read PAST the weekly stop blocks, on the usage rather than on the meter", async () => {
    const r = await getEligibilityUsage({
      readUsage: fixedReader(OK_READ_PAST_WEEKLY_STOP),
      now: () => 0,
    });
    assert.equal(r.meterUnavailable, false);
    assert.equal(r.input.weeklyEmergencyStop, true);
    assert.equal(projectEligibility(r.input).allow, false);
  });

  // --- AC5 case 2: rate-limited WITH a recent last-good --------------------

  test("AC5/2: a failed read falls back to the recent last-good reading, MARKED STALE", async () => {
    const t0 = Date.parse("2026-08-19T15:46:00.000Z");
    await getEligibilityUsage({ readUsage: fixedReader(OK_READ), now: () => t0 });
    const r = await getEligibilityUsage({
      readUsage: fixedReader(FAIL),
      now: () => t0 + STEP_MS, // 30 min later — inside the 60-min ceiling
    });
    assert.equal(r.meterUnavailable, false, "a usable reading exists, so the governor is not blind");
    assert.equal(r.stale, true, "it must be reported as stale, not passed off as fresh");
    assert.equal(r.ageMs, STEP_MS, "the age of the served reading is surfaced (AC1/AC4)");
    assert.equal(r.input.usageSource, "oauth");
    assert.equal(r.input.percentLast5h, 12);
    assert.equal(r.input.percentLast7d, 34);
  });

  test("AC5/2: REGRESSION — a stale last-good past the weekly stop still BLOCKS", async () => {
    // The incident in one case: real weekly usage 92%, then the meter is
    // rate-limited. The stale reading must keep the weekly stop engaged.
    // Pre-fix this produced percentLast7d:0 / weeklyEmergencyStop:false / allow:true.
    const t0 = Date.parse("2026-08-19T15:46:00.000Z");
    await getEligibilityUsage({
      readUsage: fixedReader(OK_READ_PAST_WEEKLY_STOP),
      now: () => t0,
    });
    const r = await getEligibilityUsage({
      readUsage: fixedReader(FAIL),
      now: () => t0 + STEP_MS,
    });
    assert.equal(r.input.percentLast7d, 92, "must NOT degrade the reading to 0");
    assert.equal(r.input.weeklyEmergencyStop, true);
    const verdict = overlayMeterUnavailableEligibility(
      projectEligibility(r.input),
      r.meterUnavailable,
    );
    assert.equal(verdict.allow, false, "a governor holding a 92% reading must not admit");
  });

  // --- AC5 case 3: rate-limited with NO usable reading ---------------------

  test("AC5/3: a failed read against a cold cache reports UNKNOWN and blocks", async () => {
    const t0 = Date.parse("2026-08-19T15:53:00.000Z");
    const r = await getEligibilityUsage({ readUsage: fixedReader(FAIL), now: () => t0 });
    assert.equal(
      r.meterUnavailable,
      true,
      "no reading at all means the governor is blind; a spend governor that cannot measure " +
        "must not admit (this is the #3821 fail-open that #4165 removed)",
    );
    // AC1: explicit unknown, NEVER a fabricated zero.
    assert.equal(r.input.percentLast5h, null);
    assert.equal(r.input.percentLast7d, null);
    assert.equal(r.input.percentSinceReset, null);
    assert.equal(r.input.usageSource, "estimate");
    // AC3: the composed verdict blocks, with the reason attached.
    const verdict = overlayMeterUnavailableEligibility(
      projectEligibility(r.input),
      r.meterUnavailable,
    );
    assert.equal(verdict.allow, false);
    assert.equal(verdict.reasons.meterUnavailable, true);
  });

  test("AC5/3: a SECOND consecutive failed read stays blocked (no failure-count escape hatch)", async () => {
    const t0 = Date.parse("2026-08-19T15:53:00.000Z");
    await getEligibilityUsage({ readUsage: fixedReader(FAIL), now: () => t0 });
    const r2 = await getEligibilityUsage({ readUsage: fixedReader(FAIL), now: () => t0 + STEP_MS });
    assert.equal(
      r2.meterUnavailable,
      true,
      "'we have failed fewer than 3 times' is not evidence of headroom",
    );
  });

  test("AC5/3: a last-good reading PAST the staleness ceiling stops being usable and blocks", async () => {
    process.env.HYDRA_ELIGIBILITY_LAST_GOOD_MAX_AGE_MS = String(60_000); // 1 min
    const t0 = Date.parse("2026-08-19T15:46:00.000Z");
    await getEligibilityUsage({ readUsage: fixedReader(OK_READ), now: () => t0 });
    const r = await getEligibilityUsage({
      readUsage: fixedReader(FAIL),
      now: () => t0 + STEP_MS, // 30 min old against a 1-min ceiling
    });
    assert.equal(r.meterUnavailable, true, "too old to license a launch");
    assert.equal(r.input.percentLast7d, null, "and reported as unknown, not as the stale number");
  });

  test("a recovery read after a failure clears the ladder and returns to a live verdict", async () => {
    const t0 = Date.parse("2026-08-19T15:53:00.000Z");
    await getEligibilityUsage({ readUsage: fixedReader(FAIL), now: () => t0 });
    const recovered = await getEligibilityUsage({
      readUsage: fixedReader(OK_READ),
      now: () => t0 + STEP_MS,
    });
    assert.equal(recovered.meterUnavailable, false);
    assert.equal(recovered.stale, false);
    assert.equal(recovered.input.usageSource, "oauth");
  });

  test("a thrown reader (programming/IO fault) reports meterUnavailable immediately", async () => {
    const throwing = async (): Promise<OAuthUsageResult> => {
      throw new Error("boom");
    };
    const r = await getEligibilityUsage({ readUsage: throwing, now: () => 0 });
    assert.equal(
      r.meterUnavailable,
      true,
      "a throw from the cached reader leaves no reading and no age to reason about",
    );
    assert.equal(r.input.percentLast7d, null);
  });
});

/**
 * Regression suite for issue #3751: the admission path's Pacing Curve ran INERT
 * because `getEligibilityUsage` seeded `weeklyResetAnchor` from the RAW env instant
 * instead of rolling it forward to the current-window boundary. With a stale
 * anchor (e.g. 8 weeks old), `projectPacingCurve` clamped `fraction = clamp01((now
 * - anchor)/7d)` to 1.000, pinning `targetPercent` at the full Pacing Ceiling —
 * which made `paceState === "ahead"` mathematically unreachable (you can never be
 * ahead of a target already at the ceiling) and removed the Pacing Curve's whole
 * burn-sensitivity.
 *
 * These tests pin the END-TO-END meter-only admission path (getEligibilityUsage →
 * EligibilityUsageInput → projectEligibility), driving `readUsage`/`now` with the
 * env anchor set to a deliberately STALE instant so the rollover is exercised.
 * New top-level describe with its own beforeEach/afterEach (CLAUDE.md authoring
 * rules), so the stale-anchor env never leaks into the #3821 block above.
 */
describe("getEligibilityUsage Pacing Curve anchor rollover (issue #3751)", () => {
  const ANCHOR_ENV = "2026-05-25T00:00:00.000Z"; // deliberately stale seed
  const ANCHOR_MS = Date.parse(ANCHOR_ENV);
  const DAY = 86_400_000;
  const RESET_ANCHOR_KEY = "HYDRA_USAGE_WEEKLY_RESET_ANCHOR";
  // The Pacing-Curve arithmetic below (target ≈ 13 at 1 day, < 92 at 6 days) is
  // pinned to the 0.92 default ceiling; set it explicitly so a polluted env can't
  // move it under the assertions.
  const CEILING_KEY = "HYDRA_USAGE_WEEKLY_PACE_CEILING";
  let saved: Map<string, string | undefined>;

  // A successful meter read with caller-chosen utilizations. `resetsAt: null`
  // pins this whole suite to the ENV-SEED fallback path: the anchor is now
  // derived from the meter's `resets_at` when it supplies one, so a null here is
  // what keeps these #3751 rollover assertions exercising the env seed. The
  // meter-derived path has its own suite below.
  function okRead(opts: { fiveHour?: number; sevenDay?: number }): OAuthUsageResult {
    return {
      ok: true,
      data: {
        fiveHour: { utilization: opts.fiveHour ?? 0, resetsAt: null },
        sevenDay: { utilization: opts.sevenDay ?? 0, resetsAt: null },
      },
    };
  }

  beforeEach(() => {
    saved = new Map();
    for (const k of ENV_KEYS) saved.set(k, process.env[k]);
    saved.set(RESET_ANCHOR_KEY, process.env[RESET_ANCHOR_KEY]);
    saved.set(CEILING_KEY, process.env[CEILING_KEY]);
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = String(TTL_MS);
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = String(MAX_STALE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = String(BACKOFF_BASE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = String(BACKOFF_MAX_MS);
    process.env[RESET_ANCHOR_KEY] = ANCHOR_ENV;
    process.env[CEILING_KEY] = "0.92";
    clearOAuthCache();
  });

  afterEach(() => {
    clearOAuthCache();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("INV-1: weeklyResetAnchor is the rolled-forward boundary, NOT the raw stale env seed", async () => {
    // 26 days = 3 full 7-day windows + 5 days. The current-window boundary is
    // ANCHOR + 3*7d (= 21d in), NOT the raw ANCHOR seed itself.
    const nowMs = ANCHOR_MS + 26 * DAY;
    const r = await getEligibilityUsage({ readUsage: fixedReader(okRead({ sevenDay: 40 })), now: () => nowMs });
    const expectedRolled = new Date(projectResetWindow(ANCHOR_MS, nowMs).currentMs).toISOString();
    assert.equal(r.input.weeklyResetAnchor, expectedRolled);
    assert.notEqual(
      r.input.weeklyResetAnchor,
      new Date(ANCHOR_MS).toISOString(),
      "the raw stale env seed must NOT surface as the admission anchor — that is the bug",
    );
  });

  test("INV-2: targetPercent RAMPs with window position (not pinned at the ceiling)", async () => {
    // Same burn; two different positions in the window. targetPercent must
    // increase as `fraction` grows — the defining property of a ramp. Before the
    // fix a stale anchor pinned fraction at 1.000, collapsing both to 92.
    const early = await getEligibilityUsage({
      readUsage: fixedReader(okRead({ sevenDay: 10 })),
      now: () => ANCHOR_MS + 1 * DAY,
    });
    clearOAuthCache();
    const late = await getEligibilityUsage({
      readUsage: fixedReader(okRead({ sevenDay: 10 })),
      now: () => ANCHOR_MS + 6 * DAY,
    });
    const earlyTarget = projectEligibility(early.input).targetPercent;
    const lateTarget = projectEligibility(late.input).targetPercent;
    assert.ok(
      earlyTarget > 0 && lateTarget > earlyTarget,
      `targetPercent must ramp up across the window (early=${earlyTarget}, late=${lateTarget})`,
    );
    assert.ok(lateTarget < 92, "target stays below the 92% ceiling mid-window (not pinned at it)");
  });

  test("INV-3: paceState 'ahead' IS reachable below the 90% emergency-stop threshold", async () => {
    // 1 day in: fraction ≈ 1/7 → target ≈ 0.92*100*(1/7) ≈ 13.1. A burn of 20%
    // sits ABOVE target+2 (ahead) yet WELL BELOW the 90% stop. Before the fix
    // target was pinned at 92, so 20% read as 'behind' and 'ahead' was unreachable
    // for any sub-90 burn.
    const r = await getEligibilityUsage({
      readUsage: fixedReader(okRead({ fiveHour: 20, sevenDay: 20 })),
      now: () => ANCHOR_MS + 1 * DAY,
    });
    const v = projectEligibility(r.input);
    assert.equal(v.paceState, "ahead", "low burn early in the window must read as 'ahead'");
    assert.equal(v.reasons.weeklyEmergencyStop, false, "20% is far below the weekly stop");
    assert.equal(v.allow, true);
  });

  test("INV-4: a meter outage yields neutral paceState 'on', never a verdict off a synthesised number", async () => {
    // Mid-window (target ≈ 66) but no meter value. #3751 pinned that the outage
    // input must not read as 'behind' (the Pacing Curve would then chase the
    // meter during its own outage). #4165 strengthens the same invariant at the
    // source: the outage input no longer carries ZEROS to be misread — it
    // carries an explicit `null` — and the verdict now BLOCKS rather than
    // riding the #1124 fail-open.
    const nowMs = ANCHOR_MS + 26 * DAY;
    const r = await getEligibilityUsage({ readUsage: fixedReader(FAIL), now: () => nowMs });
    assert.equal(r.input.usageSource, "estimate");
    assert.equal(r.input.percentSinceReset, null, "explicit unknown, not a fabricated 0 (#4165)");
    assert.equal(r.meterUnavailable, true, "no reading at all — the spend governor fails closed");
    const v = projectEligibility(r.input);
    assert.equal(v.paceState, "on", "non-oauth source is neutral 'on', never a verdict off the unknown");
    assert.equal(v.sinceResetPercent, null, "the top-level mirror is the same explicit unknown");
    assert.equal(
      overlayMeterUnavailableEligibility(v, r.meterUnavailable).allow,
      false,
      "the composed verdict blocks — the #1124 fail-open was removed by #4165",
    );
  });

  test("AC1: percentSinceReset === percentLast7d (the meter's 7d utilization doubles as window position)", async () => {
    const r = await getEligibilityUsage({
      readUsage: fixedReader(okRead({ sevenDay: 42 })),
      now: () => ANCHOR_MS + 26 * DAY,
    });
    assert.equal(r.input.percentLast7d, 42);
    assert.equal(r.input.percentSinceReset, 42);
    assert.equal(r.input.percentSinceReset, r.input.percentLast7d);
  });
});

/**
 * Regression suite: the Weekly Reset Anchor must FOLLOW THE LOGGED-IN ACCOUNT.
 *
 * `HYDRA_USAGE_WEEKLY_RESET_ANCHOR` is a single hand-maintained global constant,
 * but the weekly reset boundary is PER ACCOUNT and not even the same weekday
 * across accounts. `readAccessToken()` (oauth-usage.ts) deliberately re-reads
 * the credentials file on every call so the METER auto-follows a `/login` to a
 * different account — but the ANCHOR did not follow, so after a switch the
 * Pacing Curve was silently phased to the previous account's week.
 *
 * MEASURED INCIDENT (2026-08-14, personal -> work switch), reproduced verbatim
 * by the `MEASURED` case below: env anchor on a Wed 17:00Z boundary while the
 * account's real boundary was Sat 09:59:59Z. Elapsed read 29% instead of 90%,
 * so targetPercent was 26.8% against 38% actual burn -> paceState "ahead" ->
 * the Pace Gate skipped EVERY tick. The fake target would not have crossed
 * actual until AFTER the real reset, so the entire remaining ~60% of the week
 * would have expired unused, with no alarm. The mis-phase is silent in both
 * directions — the opposite phase error inflates the target and paces too hot.
 *
 * The fix reads the boundary the meter already returns (`seven_day.resets_at`,
 * parsed into `sevenDay.resetsAt` and previously discarded). New top-level
 * describe with its own beforeEach/afterEach per CLAUDE.md authoring rules.
 */
describe("getEligibilityUsage anchor follows the account via meter resets_at", () => {
  const DAY = 86_400_000;
  const RESET_ANCHOR_KEY = "HYDRA_USAGE_WEEKLY_RESET_ANCHOR";
  const CEILING_KEY = "HYDRA_USAGE_WEEKLY_PACE_CEILING";
  // A Wednesday 17:00Z boundary — the WRONG account's phase for every case here.
  const WRONG_ENV_ANCHOR = "2026-06-03T17:00:00.000Z";
  let saved: Map<string, string | undefined>;

  function readWithReset(resetsAt: string | null, sevenDay: number): OAuthUsageResult {
    return {
      ok: true,
      data: {
        fiveHour: { utilization: 0, resetsAt: null },
        sevenDay: { utilization: sevenDay, resetsAt },
      },
    };
  }

  beforeEach(() => {
    saved = new Map();
    for (const k of ENV_KEYS) saved.set(k, process.env[k]);
    saved.set(RESET_ANCHOR_KEY, process.env[RESET_ANCHOR_KEY]);
    saved.set(CEILING_KEY, process.env[CEILING_KEY]);
    process.env.HYDRA_OAUTH_USAGE_TTL_MS = String(TTL_MS);
    process.env.HYDRA_OAUTH_USAGE_MAX_STALE_MS = String(MAX_STALE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_BASE_MS = String(BACKOFF_BASE_MS);
    process.env.HYDRA_OAUTH_USAGE_BACKOFF_MAX_MS = String(BACKOFF_MAX_MS);
    process.env[RESET_ANCHOR_KEY] = WRONG_ENV_ANCHOR;
    process.env[CEILING_KEY] = "0.92";
    clearOAuthCache();
  });

  afterEach(() => {
    clearOAuthCache();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("the meter's resets_at OVERRIDES the env seed and yields the window START", async () => {
    // resets_at is the window END (one window ahead of now); the anchor is the
    // window START, i.e. exactly 7d earlier.
    const nowMs = Date.parse("2026-08-14T18:00:00.000Z");
    const resetsAt = "2026-08-15T09:59:59.000Z";
    const r = await getEligibilityUsage({
      readUsage: fixedReader(readWithReset(resetsAt, 39)),
      now: () => nowMs,
    });
    assert.equal(r.input.weeklyResetAnchor, "2026-08-08T09:59:59.000Z");
    const envRolled = new Date(
      projectResetWindow(Date.parse(WRONG_ENV_ANCHOR), nowMs).currentMs,
    ).toISOString();
    assert.notEqual(
      r.input.weeklyResetAnchor,
      envRolled,
      "the stale per-account env seed must NOT win over the meter's own boundary",
    );
  });

  test("MEASURED (2026-08-14): the wrong-account anchor reads 'ahead'; the meter's reads 'behind'", async () => {
    const nowMs = Date.parse("2026-08-14T18:00:00.000Z");
    const BURN = 39;

    // (a) Meter supplies no boundary -> env fallback -> the incident's phase.
    const stale = await getEligibilityUsage({
      readUsage: fixedReader(readWithReset(null, BURN)),
      now: () => nowMs,
    });
    const staleVerdict = projectEligibility(stale.input);
    assert.equal(
      staleVerdict.paceState,
      "ahead",
      "the wrong-account env phase understates elapsed time, so real burn looks hot",
    );

    // (b) Same instant, same burn, meter supplies the real boundary.
    clearOAuthCache();
    const followed = await getEligibilityUsage({
      readUsage: fixedReader(readWithReset("2026-08-15T09:59:59.000Z", BURN)),
      now: () => nowMs,
    });
    const followedVerdict = projectEligibility(followed.input);
    assert.equal(
      followedVerdict.paceState,
      "behind",
      "6.3 days into a 7-day window at 39% burn is BEHIND the curve — the Pace Gate must launch",
    );
    assert.ok(
      followedVerdict.targetPercent > staleVerdict.targetPercent,
      `the true phase is later in the week, so its target must be higher ` +
        `(stale=${staleVerdict.targetPercent}, followed=${followedVerdict.targetPercent})`,
    );
    assert.equal(followedVerdict.allow, true);
  });

  test("a null resets_at falls back to the env seed (meter-dark compatibility)", async () => {
    const nowMs = Date.parse("2026-08-14T18:00:00.000Z");
    const r = await getEligibilityUsage({
      readUsage: fixedReader(readWithReset(null, 20)),
      now: () => nowMs,
    });
    const envRolled = new Date(
      projectResetWindow(Date.parse(WRONG_ENV_ANCHOR), nowMs).currentMs,
    ).toISOString();
    assert.equal(r.input.weeklyResetAnchor, envRolled);
  });

  test("an unparseable resets_at falls back to the env seed rather than NaN-ing the curve", async () => {
    const nowMs = Date.parse("2026-08-14T18:00:00.000Z");
    // `parseOAuthUsageBody` coerces garbage to null upstream, but the field is
    // typed `string | null`, so the guard here must hold independently.
    const r = await getEligibilityUsage({
      readUsage: fixedReader(readWithReset("not-a-date", 20)),
      now: () => nowMs,
    });
    const envRolled = new Date(
      projectResetWindow(Date.parse(WRONG_ENV_ANCHOR), nowMs).currentMs,
    ).toISOString();
    assert.equal(r.input.weeklyResetAnchor, envRolled);
    assert.equal(projectEligibility(r.input).paceState !== undefined, true);
  });

  test("a STALE (past) resets_at is floored to the CURRENT window, not left behind", async () => {
    // Robustness: projectResetWindow floors any reset instant — past or future —
    // into the window containing `now`, so a boundary several weeks old still
    // produces the current window's start rather than a >1.0 fraction.
    const nowMs = Date.parse("2026-08-14T18:00:00.000Z");
    const r = await getEligibilityUsage({
      readUsage: fixedReader(readWithReset("2026-07-11T09:59:59.000Z", 39)),
      now: () => nowMs,
    });
    const anchorMs = Date.parse(r.input.weeklyResetAnchor!);
    assert.ok(anchorMs <= nowMs, "the anchor must be at or before now (a window START)");
    assert.ok(
      nowMs - anchorMs < 7 * DAY,
      "the anchor must be inside the current 7-day window, not a stale multi-week-old instant",
    );
    // Same phase as the future-boundary case: both floor to the Saturday start.
    assert.equal(r.input.weeklyResetAnchor, "2026-08-08T09:59:59.000Z");
  });

  test("a meter outage still reports the env-seeded anchor", async () => {
    // Cold cache + a failed read = no usable reading at all, so this is the
    // fail-closed shape (#4165). The anchor is still reported: it is derived
    // from config + `now`, not from the meter, so an outage never blanks it.
    const nowMs = Date.parse("2026-08-14T18:00:00.000Z");
    const last = await getEligibilityUsage({
      readUsage: fixedReader(FAIL),
      now: () => nowMs,
    });
    assert.equal(last.meterUnavailable, true);
    const envRolled = new Date(
      projectResetWindow(Date.parse(WRONG_ENV_ANCHOR), nowMs).currentMs,
    ).toISOString();
    assert.equal(
      last.input.weeklyResetAnchor,
      envRolled,
      "with no meter value there is no boundary to follow — the env seed is the documented fallback",
    );
  });
});
