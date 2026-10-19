/**
 * Unit tests for the pure eligibility-projection fold (src/cost/eligibility.ts,
 * ADR-0042 L3): projectEligibility, overlaySessionBlockEligibility, and
 * deriveHardStop (incl. the HYDRA_USAGE_EMERGENCY_STOP_PERCENT env suite).
 * Moved verbatim out of test/usage-tracker.test.mts (issue #4787); the L5
 * coordinator's own test stays in test/eligibility-usage.test.mts.
 */
import { test, describe, afterEach, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  projectEligibility,
  projectEligibilityView,
  type EligibilityView,
  deriveHardStop,
  EMERGENCY_STOP_PERCENT,
  PACE_STATE_TOLERANCE_PERCENT,
  PACING_SHEDDABLE_CLASSES,
  fiveHourThrottleShed,
  FIVE_HOUR_THROTTLE_T1_CLASSES,
  FIVE_HOUR_THROTTLE_T2_CLASSES,
  overlayPauseEligibility,
  overlaySessionBlockEligibility,
  type UsageEligibility,
} from "../src/cost/eligibility.ts";
import {
  DEFAULT_FIVE_HOUR_THROTTLE_T1,
  DEFAULT_FIVE_HOUR_THROTTLE_T2,
} from "../src/cost/config.ts";
import type { UsageSnapshot } from "../src/cost/index.ts";
import { withEnvSnapshot } from "./_helpers/cost-fixtures.mts";

describe("projectEligibility", () => {
  function snapshotWith(overrides: Partial<UsageSnapshot>): UsageSnapshot {
    const empty = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
    const base: UsageSnapshot = {
      tokensLast5h: empty,
      tokensLast7d: empty,
      tokensLast24h: 0,
      tokensForeignLast7d: 0,
      percentLast5h: 0,
      percentLast7d: 0,
      usageSource: "estimate",
      oauthError: null,
      oauthStale: false,
      oauthAgeMs: null,
      oauthFiveHourResetsAt: null,
      oauthSevenDayResetsAt: null,
      windowElapsedFraction: null,
      paceRatio: null,
      projectedWeeklyPercent: 0,
      pacingState: "under",
      emergencyStop: false,
      weeklyEmergencyStop: false,
      calibrated: false,
      byModel: {
        opus: { ...empty },
        sonnet: { ...empty },
        haiku: { ...empty },
        unknown: { ...empty },
      },
      bySkillByModel: {},
      bySkillByModel24h: {},
      bySkillWoW: {},
      byDispatchKind: {
        "autopilot-dispatched": {
          opus: { ...empty },
          sonnet: { ...empty },
          haiku: { ...empty },
          unknown: { ...empty },
        },
        "operator-invoked": {
          opus: { ...empty },
          sonnet: { ...empty },
          haiku: { ...empty },
          unknown: { ...empty },
        },
        interactive: {
          opus: { ...empty },
          sonnet: { ...empty },
          haiku: { ...empty },
          unknown: { ...empty },
        },
      },
      attributedPercent: 0,
      quotaWeightLast5h: 0,
      quotaWeightLast7d: 0,
      quotaWeightCalibrated: false,
      weeklyQuotaTokens: 0,
      fiveHourQuotaTokens: 0,
      filesScanned: 0,
      filesSkippedByMtime: 0,
      linesParsed: 0,
      linesWithUsage: 0,
      parseErrors: 0,
      filesServedFromMemo: 0,
      generatedAt: "2026-05-26T00:00:00.000Z",
      cacheHitRatioLast5h: 0,
      cacheHitRatioLast7d: 0,
      tokensSinceReset: { ...empty },
      percentSinceReset: 0,
      weeklyResetAnchor: null,
    };
    return { ...base, ...overrides };
  }

  test("uncalibrated: allow=true, shed=[], pacing/emergency false", () => {
    const v = projectEligibility(snapshotWith({ calibrated: false }));
    assert.equal(v.allow, true);
    assert.deepEqual([...v.shed], []);
    assert.equal(v.reasons.emergencyStop, false);
    assert.equal(v.reasons.pacingShed, false);
    assert.equal(v.reasons.calibrated, false);
  });

  test("calibrated + under: allow=true, shed=[]", () => {
    const v = projectEligibility(
      snapshotWith({ calibrated: true, pacingState: "under", emergencyStop: false })
    );
    assert.equal(v.allow, true);
    assert.deepEqual([...v.shed], []);
    assert.equal(v.reasons.pacingShed, false);
  });

  test("calibrated + on (80–100%): allow=true, shed=[] — 'on' is informational only", () => {
    const v = projectEligibility(
      snapshotWith({ calibrated: true, pacingState: "on", emergencyStop: false })
    );
    assert.equal(v.allow, true);
    assert.deepEqual([...v.shed], []);
    assert.equal(v.reasons.pacingShed, false);
  });

  test("calibrated + over: allow=true, shed includes all sheddable classes", () => {
    const v = projectEligibility(
      snapshotWith({ calibrated: true, pacingState: "over", emergencyStop: false })
    );
    assert.equal(v.allow, true);
    // Sheddable list should match the exported constant exactly.
    assert.deepEqual([...v.shed], [...PACING_SHEDDABLE_CLASSES]);
    assert.equal(v.reasons.pacingShed, true);
    // Sanity: dev_* and qa_* are never shed.
    assert.equal(v.shed.includes("dev_orch"), false);
    assert.equal(v.shed.includes("dev_target"), false);
    assert.equal(v.shed.includes("qa_orch"), false);
    assert.equal(v.shed.includes("health"), false);
  });

  test("calibrated + emergencyStop: allow=false (regardless of pacing)", () => {
    const v = projectEligibility(
      snapshotWith({ calibrated: true, pacingState: "under", emergencyStop: true })
    );
    assert.equal(v.allow, false);
    assert.equal(v.reasons.emergencyStop, true);
  });

  test("calibrated + emergencyStop + over: allow=false AND shed populated (emergency takes precedence semantically)", () => {
    const v = projectEligibility(
      snapshotWith({ calibrated: true, pacingState: "over", emergencyStop: true })
    );
    assert.equal(v.allow, false);
    // shed is still populated — callers MUST honor `allow` first; if
    // they did go ahead, the shed list remains the right second filter.
    assert.deepEqual([...v.shed], [...PACING_SHEDDABLE_CLASSES]);
  });

  test("calibrated + weeklyEmergencyStop: allow=false (weekly hard-stop blocks every class)", () => {
    const v = projectEligibility(
      snapshotWith({
        calibrated: true,
        pacingState: "under",
        emergencyStop: false,
        weeklyEmergencyStop: true,
      })
    );
    assert.equal(v.allow, false);
    assert.equal(v.reasons.weeklyEmergencyStop, true);
    assert.equal(v.reasons.emergencyStop, false);
  });

  test("weeklyEmergencyStop is independent of the 5h emergencyStop", () => {
    // 5h fine, weekly exhausted → still blocked.
    assert.equal(
      projectEligibility(
        snapshotWith({ calibrated: true, emergencyStop: false, weeklyEmergencyStop: true })
      ).allow,
      false
    );
    // weekly fine, 5h exhausted → still blocked.
    assert.equal(
      projectEligibility(
        snapshotWith({ calibrated: true, emergencyStop: true, weeklyEmergencyStop: false })
      ).allow,
      false
    );
    // both fine → allowed.
    assert.equal(
      projectEligibility(
        snapshotWith({ calibrated: true, emergencyStop: false, weeklyEmergencyStop: false })
      ).allow,
      true
    );
  });

  // -----------------------------------------------------------------------
  // Graduated 5h-utilization throttle (issue #1087, builds on #1085).
  // Pure function of the OAuth `percentLast5h` + the T1/T2 env thresholds.
  // Defaults: T1=0.60, T2=0.75. Inert on the transcript `estimate`.
  // -----------------------------------------------------------------------
  describe("graduated 5h throttle", () => {
    const restore = withEnvSnapshot();
    beforeEach(() => {
      delete process.env.HYDRA_USAGE_5H_THROTTLE_T1;
      delete process.env.HYDRA_USAGE_5H_THROTTLE_T2;
    });
    afterEach(() => restore());

    function oauthSnap(percentLast5h: number): UsageSnapshot {
      return snapshotWith({
        calibrated: true,
        usageSource: "oauth",
        percentLast5h,
        // keep pacing/emergency inert so we isolate the 5h throttle
        pacingState: "under",
        emergencyStop: false,
        weeklyEmergencyStop: false,
      });
    }

    const T1 = new Set(FIVE_HOUR_THROTTLE_T1_CLASSES);
    const T1T2 = new Set([
      ...FIVE_HOUR_THROTTLE_T1_CLASSES,
      ...FIVE_HOUR_THROTTLE_T2_CLASSES,
    ]);
    // The default thresholds, passed explicitly into the now-pure fold
    // (issue #2550): fiveHourThrottleShed no longer reads process.env — the
    // caller supplies the parsed fractions. Tests exercise pinned tiers by
    // passing them directly, NO process.env mutation needed.
    const D1 = DEFAULT_FIVE_HOUR_THROTTLE_T1;
    const D2 = DEFAULT_FIVE_HOUR_THROTTLE_T2;

    test("defaults are 0.60 / 0.75", () => {
      assert.equal(DEFAULT_FIVE_HOUR_THROTTLE_T1, 0.6);
      assert.equal(DEFAULT_FIVE_HOUR_THROTTLE_T2, 0.75);
    });

    test("below T1 (59%): no shed", () => {
      assert.deepEqual([...fiveHourThrottleShed(oauthSnap(59), D1, D2)], []);
      const v = projectEligibility(oauthSnap(59));
      assert.deepEqual([...v.shed], []);
      assert.equal(v.reasons.fiveHourThrottleShed, false);
      assert.equal(v.allow, true);
    });

    test("exactly at T1 (60%): T1 set sheds (boundary is inclusive)", () => {
      assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(60), D1, D2)), T1);
      const v = projectEligibility(oauthSnap(60));
      assert.deepEqual(new Set(v.shed), T1);
      assert.equal(v.reasons.fiveHourThrottleShed, true);
      // dev_orch / qa_* / dev_target NOT shed at T1.
      assert.equal(v.shed.includes("dev_orch"), false);
      assert.equal(v.shed.includes("dev_target"), false);
      assert.equal(v.shed.includes("qa_orch"), false);
      assert.equal(v.shed.includes("qa_target"), false);
    });

    test("between T1 and T2 (70%): only the T1 set", () => {
      assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(70), D1, D2)), T1);
    });

    test("exactly at T2 (75%): T1 ∪ T2; dev_orch shed but qa_* + dev_target kept", () => {
      const shed = new Set(fiveHourThrottleShed(oauthSnap(75), D1, D2));
      assert.deepEqual(shed, T1T2);
      assert.equal(shed.has("dev_orch"), true);
      assert.equal(shed.has("design_concept_orch"), true);
      assert.equal(shed.has("qa_orch"), false);
      assert.equal(shed.has("qa_target"), false);
      assert.equal(shed.has("dev_target"), false);
    });

    test("above T2 (89%, below 90% emergency): T1 ∪ T2, still allow=true", () => {
      const v = projectEligibility(oauthSnap(89));
      assert.deepEqual(new Set(v.shed), T1T2);
      assert.equal(v.reasons.fiveHourThrottleShed, true);
      assert.equal(v.allow, true);
    });

    test("usageSource=estimate: inert even above T2", () => {
      const snap = snapshotWith({
        calibrated: true,
        usageSource: "estimate",
        percentLast5h: 88,
        pacingState: "under",
      });
      assert.deepEqual([...fiveHourThrottleShed(snap, D1, D2)], []);
      const v = projectEligibility(snap);
      assert.deepEqual([...v.shed], []);
      assert.equal(v.reasons.fiveHourThrottleShed, false);
    });

    test("custom T1/T2 thresholds honoured (pure fold over passed args)", () => {
      // Pass custom thresholds directly — no process.env mutation (#2550).
      // 45% crosses the custom T1 (0.40) but not the custom T2 (0.50).
      assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(45), 0.4, 0.5)), T1);
      // 55% crosses both.
      assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(55), 0.4, 0.5)), T1T2);
      // 35% below custom T1 → no shed.
      assert.deepEqual([...fiveHourThrottleShed(oauthSnap(35), 0.4, 0.5)], []);
    });

    test("env override threads through projectEligibility's getters", () => {
      // projectEligibility reads HYDRA_USAGE_5H_THROTTLE_T1/_T2 via the Cost
      // env-reader leaf (cost/config.ts) and passes the parsed fractions into
      // the fold — the full env-read→fold path stays behavior-preserving.
      process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "0.40";
      process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "0.50";
      // 45% crosses the custom T1 but not the custom T2 → T1 only.
      assert.deepEqual(new Set(projectEligibility(oauthSnap(45)).shed), T1);
      // 55% crosses both.
      assert.deepEqual(new Set(projectEligibility(oauthSnap(55)).shed), T1T2);
      // 35% below custom T1 → no shed.
      assert.deepEqual([...projectEligibility(oauthSnap(35)).shed], []);
    });

    test("mis-set T2 < T1: T2 cut never inverts below T1 (pure fold)", () => {
      // T1=0.70, T2=0.50 passed directly; T2 clamped up to max(70,50)=70.
      // At 65% → no shed.
      assert.deepEqual([...fiveHourThrottleShed(oauthSnap(65), 0.7, 0.5)], []);
      // At 72% → both tiers fire together (T2 boundary == T1 boundary).
      assert.deepEqual(new Set(fiveHourThrottleShed(oauthSnap(72), 0.7, 0.5)), T1T2);
    });

    test("composes with pacing shed (union, de-duped)", () => {
      // pacingState 'over' + 5h above T1 → union of both lists, no dupes.
      const snap = snapshotWith({
        calibrated: true,
        usageSource: "oauth",
        percentLast5h: 65,
        pacingState: "over",
        emergencyStop: false,
      });
      const v = projectEligibility(snap);
      const expected = new Set([
        ...PACING_SHEDDABLE_CLASSES,
        ...FIVE_HOUR_THROTTLE_T1_CLASSES,
      ]);
      assert.deepEqual(new Set(v.shed), expected);
      // No duplicate entries (discover_orch is in BOTH lists).
      assert.equal(v.shed.length, new Set(v.shed).size);
      assert.equal(v.reasons.pacingShed, true);
      assert.equal(v.reasons.fiveHourThrottleShed, true);
    });

    test("emergencyStop (>=90%) supersedes: allow=false", () => {
      const snap = snapshotWith({
        calibrated: true,
        usageSource: "oauth",
        percentLast5h: 95,
        emergencyStop: true,
      });
      const v = projectEligibility(snap);
      assert.equal(v.allow, false);
    });
  });

  // -----------------------------------------------------------------------
  // Pacing Curve verdict (issue #857, ADR-0021). ADDITIVE fields on the
  // eligibility projection: paceState / targetPercent / sinceResetPercent /
  // anchor. `now` is derived from snapshot.generatedAt so the projection
  // stays a pure function of the snapshot.
  // -----------------------------------------------------------------------
  describe("Pacing Curve", () => {
    const restore = withEnvSnapshot();
    // Use the default ceiling (0.92) unless a test overrides it.
    beforeEach(() => {
      delete process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING;
    });
    afterEach(() => restore());

    const DAY = 86_400_000;
    const isoOf = (ms: number) => new Date(ms).toISOString();
    const anchorMs = Date.parse("2026-05-25T00:00:00.000Z");

    // Build a snapshot with an Anchor boundary and a `now` (generatedAt)
    // some fraction into the 7-day window, plus a percentSinceReset.
    // `usageSource: "oauth"` is REQUIRED (issue #3751, INV-4): the Pacing Curve
    // verdict is only computed for the authoritative OAuth source — a non-oauth
    // source is the neutral "on" — so the ahead/behind/on assertions below must
    // drive the oauth path. (`snapshotWith` defaults to "estimate".)
    function curveSnap(opts: {
      nowMs: number;
      sinceResetPercent: number;
      anchorIso?: string | null;
    }): UsageSnapshot {
      return snapshotWith({
        calibrated: true,
        usageSource: "oauth",
        generatedAt: isoOf(opts.nowMs),
        weeklyResetAnchor: opts.anchorIso === undefined ? isoOf(anchorMs) : opts.anchorIso,
        percentSinceReset: opts.sinceResetPercent,
      });
    }

    test("target ≈ 0 at window start (now == anchor)", () => {
      const v = projectEligibility(curveSnap({ nowMs: anchorMs, sinceResetPercent: 0 }));
      assert.equal(v.targetPercent, 0);
      // 0 vs 0 within tolerance → on.
      assert.equal(v.paceState, "on");
      assert.equal(v.anchor, isoOf(anchorMs));
      assert.equal(v.sinceResetPercent, 0);
    });

    test("target ≈ ceiling*100/2 at window midpoint (3.5 days in)", () => {
      const nowMs = anchorMs + 3.5 * DAY;
      const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 0 }));
      // ceiling default 0.92 → midpoint target = 46.
      assert.equal(v.targetPercent, 0.92 * 100 * 0.5);
      assert.equal(v.targetPercent, 46);
    });

    test("target ≈ ceiling*100 at window end (7 days in)", () => {
      const nowMs = anchorMs + 7 * DAY;
      const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 0 }));
      assert.equal(v.targetPercent, 92);
    });

    test("target clamps to ceiling*100 past the window end (fraction clamps to 1)", () => {
      const nowMs = anchorMs + 10 * DAY;
      const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 0 }));
      assert.equal(v.targetPercent, 92);
    });

    test("target clamps to 0 before the window start (fraction clamps to 0)", () => {
      // generatedAt earlier than the anchor boundary → fraction floors at 0.
      const nowMs = anchorMs - 2 * DAY;
      const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 0 }));
      assert.equal(v.targetPercent, 0);
    });

    test("custom ceiling flows into the target", () => {
      process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "0.5";
      const nowMs = anchorMs + 7 * DAY;
      const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 0 }));
      assert.equal(v.targetPercent, 50);
    });

    test("paceState=behind when sinceReset well below target", () => {
      const nowMs = anchorMs + 3.5 * DAY; // target 46
      const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 20 }));
      assert.equal(v.paceState, "behind");
    });

    test("paceState=ahead when sinceReset well above target", () => {
      const nowMs = anchorMs + 3.5 * DAY; // target 46
      const v = projectEligibility(curveSnap({ nowMs, sinceResetPercent: 80 }));
      assert.equal(v.paceState, "ahead");
    });

    test("paceState=on when sinceReset within ±tolerance of target", () => {
      const nowMs = anchorMs + 3.5 * DAY; // target 46
      // 46 + 1pp and 46 - 1pp both inside ±2pp.
      assert.equal(
        projectEligibility(curveSnap({ nowMs, sinceResetPercent: 47 })).paceState,
        "on",
      );
      assert.equal(
        projectEligibility(curveSnap({ nowMs, sinceResetPercent: 45 })).paceState,
        "on",
      );
    });

    test("tolerance edges: strictly-beyond flips, exactly-at-edge stays on", () => {
      const nowMs = anchorMs + 3.5 * DAY; // target 46
      const tol = PACE_STATE_TOLERANCE_PERCENT;
      // Exactly target+tol → NOT > target+tol → still "on".
      assert.equal(
        projectEligibility(curveSnap({ nowMs, sinceResetPercent: 46 + tol })).paceState,
        "on",
      );
      // Exactly target-tol → NOT < target-tol → still "on".
      assert.equal(
        projectEligibility(curveSnap({ nowMs, sinceResetPercent: 46 - tol })).paceState,
        "on",
      );
      // Just past the upper edge → ahead.
      assert.equal(
        projectEligibility(curveSnap({ nowMs, sinceResetPercent: 46 + tol + 0.01 })).paceState,
        "ahead",
      );
      // Just past the lower edge → behind.
      assert.equal(
        projectEligibility(curveSnap({ nowMs, sinceResetPercent: 46 - tol - 0.01 })).paceState,
        "behind",
      );
    });

    test("anchor unset → neutral: paceState 'on', targetPercent 0, anchor null", () => {
      const v = projectEligibility(
        curveSnap({ nowMs: anchorMs + 3.5 * DAY, sinceResetPercent: 50, anchorIso: null }),
      );
      assert.equal(v.paceState, "on");
      assert.equal(v.targetPercent, 0);
      assert.equal(v.anchor, null);
      // sinceResetPercent is still surfaced verbatim even when neutral.
      assert.equal(v.sinceResetPercent, 50);
    });

    test("uncalibrated snapshot with no anchor → neutral curve, allow unchanged", () => {
      const v = projectEligibility(snapshotWith({ calibrated: false }));
      assert.equal(v.paceState, "on");
      assert.equal(v.targetPercent, 0);
      assert.equal(v.anchor, null);
      // Existing allow/shed semantics untouched.
      assert.equal(v.allow, true);
      assert.deepEqual([...v.shed], []);
    });

    test("Pacing Curve does NOT change allow/shed (additive only)", () => {
      // Ahead of the curve must NOT block dispatch — that is #858's job.
      const v = projectEligibility(
        curveSnap({ nowMs: anchorMs + 1 * DAY, sinceResetPercent: 90 }),
      );
      assert.equal(v.paceState, "ahead");
      assert.equal(v.allow, true);
      assert.deepEqual([...v.shed], []);
    });

    test("INV-4 (#3751): non-oauth source is neutral 'on' even with a set anchor + zeros", () => {
      // The admission outage path serves percentSinceReset: 0 with a SET
      // (rolled) anchor. Before the INV-4 guard, 0 < target − tol produced a
      // false "behind" — which, with allow=true, launched the Pace Gate on
      // absent evidence. The guard makes a non-oauth source neutral "on";
      // targetPercent (time-based) is still reported.
      const nowMs = anchorMs + 3.5 * DAY; // target 46
      const v = projectEligibility(
        snapshotWith({
          calibrated: true,
          usageSource: "estimate",
          generatedAt: isoOf(nowMs),
          weeklyResetAnchor: isoOf(anchorMs),
          percentSinceReset: 0,
        }),
      );
      assert.equal(v.paceState, "on");
      assert.equal(v.targetPercent, 46);
      assert.equal(v.sinceResetPercent, 0);
    });
  });

  describe("projectEligibilityView — the narrowed pacing slice (issue #3108)", () => {
    test("projects exactly the seven pacing-dashboard fields", () => {
      const snapshot = snapshotWith({
        calibrated: true,
        percentLast5h: 42,
        percentSinceReset: 30,
        weeklyResetAnchor: null,
      });
      const view: EligibilityView = projectEligibilityView(snapshot);
      // Exactly the seven-field slice — no extra keys leak from UsageEligibility.
      assert.deepEqual(Object.keys(view).sort(), [
        "anchor",
        "calibrated",
        "emergencyStop",
        "paceState",
        "percentLast5h",
        "sinceResetPercent",
        "targetPercent",
      ]);
    });

    test("mirrors the projectEligibility source fields byte-for-byte", () => {
      // The view MUST be the same narrowing both pacing surfaces used to inline,
      // so it stays interchangeable with the old per-site defaultReadEligibility.
      const snapshot = snapshotWith({
        calibrated: true,
        usageSource: "oauth",
        percentLast5h: 95,
        emergencyStop: true,
        percentSinceReset: 55,
        weeklyResetAnchor: null,
      });
      const full = projectEligibility(snapshot);
      const view = projectEligibilityView(snapshot);
      assert.deepEqual(view, {
        paceState: full.paceState,
        targetPercent: full.targetPercent,
        sinceResetPercent: full.sinceResetPercent,
        anchor: full.anchor,
        emergencyStop: full.reasons.emergencyStop,
        calibrated: full.reasons.calibrated,
        percentLast5h: full.usage.percentLast5h,
      });
    });

    test("emergencyStop reads the 5h hard-stop reason, not the raw snapshot flag", () => {
      // The view surfaces reasons.emergencyStop (projectEligibility's derived
      // hard-stop), which on an oauth 95% snapshot is true.
      const view = projectEligibilityView(
        snapshotWith({ usageSource: "oauth", percentLast5h: 95, emergencyStop: true }),
      );
      assert.equal(view.emergencyStop, true);
      assert.equal(view.percentLast5h, 95);
    });
  });
});

describe("overlaySessionBlockEligibility (issue #1089)", () => {
  const base: UsageEligibility = {
    allow: true,
    shed: [],
    reasons: {
      emergencyStop: false,
      weeklyEmergencyStop: false,
      pacingShed: false,
      fiveHourThrottleShed: false,
      calibrated: true,
      extraUsageArmed: false,
      extraUsageBlocking: false,
      paused: false,
      sessionBlockedUntil: null,
      worklessUntil: null,
      postQuotaUntil: null,
      fableExhaustedUntil: null,
      meterUnavailable: false,
      meterStale: false,
      meterAgeMs: null,
    },
    paceState: "on",
    targetPercent: 0,
    sinceResetPercent: 0,
    anchor: null,
    usage: {} as UsageSnapshot,
  };
  const nowMs = Date.parse("2026-06-06T19:00:00.000Z");

  test("a future block forces allow=false and surfaces the ISO instant", () => {
    const blockedUntilMs = nowMs + 60 * 60 * 1000; // +1h
    const v = overlaySessionBlockEligibility(base, blockedUntilMs, nowMs);
    assert.equal(v.allow, false);
    assert.equal(v.reasons.sessionBlockedUntil, new Date(blockedUntilMs).toISOString());
  });

  test("a null block returns the input unchanged", () => {
    const v = overlaySessionBlockEligibility(base, null, nowMs);
    assert.equal(v, base);
  });

  test("a past block returns the input unchanged (self-clear)", () => {
    const v = overlaySessionBlockEligibility(base, nowMs - 1000, nowMs);
    assert.equal(v, base);
    assert.equal(v.allow, true);
  });

  test("composes after pause without dropping reasons.paused", () => {
    const paused = overlayPauseEligibility(base, true);
    const v = overlaySessionBlockEligibility(paused, nowMs + 1000, nowMs);
    assert.equal(v.allow, false);
    assert.equal(v.reasons.paused, true);
    assert.ok(v.reasons.sessionBlockedUntil !== null);
  });

  test("does not mutate the input object", () => {
    const snapshot = JSON.stringify(base);
    overlaySessionBlockEligibility(base, nowMs + 1000, nowMs);
    assert.equal(JSON.stringify(base), snapshot);
  });
});

// Issue #2041: the hard-stop derivation moved out of usage-tracker.ts's
// snapshot-assembly function into the pure `deriveHardStop` predicate in
// eligibility.ts. These tests exercise the threshold POLICY with plain scalar
// literals — no ScanResult fixture, no OAuth mock, no quota-weight config, no
// weekly-reset-anchor math — which was the whole point of the extraction.
describe("deriveHardStop (pure threshold predicate, issue #2041)", () => {
  test("EMERGENCY_STOP_PERCENT is the single shared 90% threshold", () => {
    assert.equal(EMERGENCY_STOP_PERCENT, 90);
  });

  test("at 91% 5h OAuth usage the 5h stop is true (the issue's acceptance core)", () => {
    const { emergencyStop, weeklyEmergencyStop } = deriveHardStop({
      percentLast5h: 91,
      percentLast7d: 10,
      usageSource: "oauth",
    });
    assert.equal(emergencyStop, true);
    assert.equal(weeklyEmergencyStop, false);
  });

  test("exactly at the 90% threshold both windows stop (>= boundary, OAuth)", () => {
    const r = deriveHardStop({
      percentLast5h: EMERGENCY_STOP_PERCENT,
      percentLast7d: EMERGENCY_STOP_PERCENT,
      usageSource: "oauth",
    });
    assert.equal(r.emergencyStop, true);
    assert.equal(r.weeklyEmergencyStop, true);
  });

  test("just under 90% (89.9%) neither window stops", () => {
    const r = deriveHardStop({
      percentLast5h: 89.9,
      percentLast7d: 89.9,
      usageSource: "oauth",
    });
    assert.equal(r.emergencyStop, false);
    assert.equal(r.weeklyEmergencyStop, false);
  });

  test("the weekly window stops independently of the 5h window", () => {
    const r = deriveHardStop({
      percentLast5h: 10,
      percentLast7d: 95,
      usageSource: "oauth",
    });
    assert.equal(r.emergencyStop, false);
    assert.equal(r.weeklyEmergencyStop, true);
  });

  test("the estimate source NEVER triggers either stop, even at 100% (#1124 fail-open)", () => {
    const r = deriveHardStop({
      percentLast5h: 100,
      percentLast7d: 100,
      usageSource: "estimate",
    });
    assert.equal(r.emergencyStop, false);
    assert.equal(r.weeklyEmergencyStop, false);
  });

  test("is a pure fold — same scalars in, same booleans out, no side effects", () => {
    const input = {
      percentLast5h: 91,
      percentLast7d: 50,
      usageSource: "oauth" as const,
    };
    const frozen = JSON.stringify(input);
    const a = deriveHardStop(input);
    const b = deriveHardStop(input);
    assert.deepEqual(a, b);
    // input untouched
    assert.equal(JSON.stringify(input), frozen);
  });
});

// Issue #4560: the hard-stop threshold became tunable. `EMERGENCY_STOP_PERCENT`
// stays the exported DEFAULT (pinned at 90 above); `deriveHardStop` compares
// against `getEmergencyStopPercent()`, which reads HYDRA_USAGE_EMERGENCY_STOP_PERCENT.
describe("deriveHardStop honors HYDRA_USAGE_EMERGENCY_STOP_PERCENT (issue #4560)", () => {
  const KEY = "HYDRA_USAGE_EMERGENCY_STOP_PERCENT";
  let savedValue: string | undefined;

  beforeEach(() => {
    savedValue = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (savedValue === undefined) delete process.env[KEY];
    else process.env[KEY] = savedValue;
  });

  test("unset => the shared 90 default, byte-for-byte the pre-#4560 behaviour", () => {
    const r = deriveHardStop({ percentLast5h: 90, percentLast7d: 89.9, usageSource: "oauth" });
    assert.equal(r.emergencyStop, true);
    assert.equal(r.weeklyEmergencyStop, false);
  });

  test("95 => 91% no longer stops, 95% does (both windows read the one knob)", () => {
    process.env[KEY] = "95";
    const under = deriveHardStop({ percentLast5h: 91, percentLast7d: 94.9, usageSource: "oauth" });
    assert.equal(under.emergencyStop, false);
    assert.equal(under.weeklyEmergencyStop, false);
    const at = deriveHardStop({ percentLast5h: 95, percentLast7d: 95, usageSource: "oauth" });
    assert.equal(at.emergencyStop, true);
    assert.equal(at.weeklyEmergencyStop, true);
  });

  test("the transcript estimate still never stops, whatever the threshold", () => {
    process.env[KEY] = "50";
    const r = deriveHardStop({ percentLast5h: 99, percentLast7d: 99, usageSource: "estimate" });
    assert.equal(r.emergencyStop, false);
    assert.equal(r.weeklyEmergencyStop, false);
  });

  test("FAIL-LOUD DEFAULT: garbage, 0, negative and >100 all fall back to 90", () => {
    for (const bad of ["ninety", "0", "-5", "101", "NaN", "Infinity"]) {
      process.env[KEY] = bad;
      const r = deriveHardStop({ percentLast5h: 90, percentLast7d: 89.9, usageSource: "oauth" });
      assert.equal(r.emergencyStop, true, `${bad}: 90 must still stop under the fallback`);
      assert.equal(r.weeklyEmergencyStop, false, `${bad}: 89.9 must still pass under the fallback`);
    }
  });
});
