import { test, describe, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";

// The relocation subject (issue #2988): `assembleSnapshot` moved OUT of the
// `usage-tracker.ts` I/O coordinator into the pure `snapshot-assembly.ts` leaf,
// completing the IO/pure split issue #2279 began. This suite is the leverage the
// move unlocks — it exercises the assembly DIRECTLY over a synthetic `ScanResult`
// with a pinned clock and NO I/O (no transcript walk, no OAuth GET, no Redis
// prior-week read), proving the assembler earns its own seam. Before the move it
// could only be reached through `getUsage()`, which requires a fixture directory
// + a mocked OAuth reader.
import {
  assembleSnapshot,
  weightedQuotaBurn,
  deriveAttributedPercent,
  derivePacingState,
  deriveWindowPace,
  rebaseOnOAuth,
  deriveSinceReset,
  detectCalibrationDrift,
  detectEstimateOAuthDivergence,
  deriveWeightedBurns,
  deriveEstimatePercents,
  deriveQuotaWeightTotals,
  deriveBySkillWoW,
} from "../src/cost/snapshot-assembly.ts";
// The same fold re-exported on the public barrel (issue #3548): assert the two
// paths reference the identical function so consumers (the Class Yield
// Scoreboard) and `assembleSnapshot` share ONE weighting definition.
import { weightedQuotaBurn as weightedQuotaBurnBarrel } from "../src/cost/index.ts";
import {
  EMPTY_BREAKDOWN,
  emptyByModel,
  DISPATCH_KINDS,
  emptyByDispatchKind,
} from "../src/cost/transcript-scan.ts";
import type { ScanResult, CachedOAuthRead as ScanResultOAuth } from "../src/cost/transcript-scan.ts";
import type { ModelFamily, TokenBreakdown } from "../src/cost/token-math.ts";
// Shared fixture `breakdown` (partial-field builder) is aliased: this file
// already defines a local `breakdown(total)` helper with a different shape.
import { captureLoggerLines, breakdown as fixtureBreakdown } from "./_helpers/cost-fixtures.mts";

// A pinned anchor — the assembler reads time ONLY off this argument (no
// Date.now()), so the emitted `generatedAt` is deterministic.
const NOW = new Date("2026-07-07T12:00:00.000Z");

function breakdown(total: number): TokenBreakdown {
  // The weighted-burn numerator folds over the SUB-fields (`input + output +
  // cacheCreation + w*cacheRead`), NOT `.total` — so route the whole amount
  // through `input` and mirror it into `.total` (the raw pass-through fields +
  // the WoW per-skill sums read `.total`). With cacheRead 0 the cache-hit ratio
  // is 0, which the assertions account for. This keeps the burn numerator equal
  // to `total` under the default cache-read weight 1.0 + uncalibrated quota
  // weights (identity), so the estimate percent is `total / quota * 100`.
  return { ...EMPTY_BREAKDOWN, input: total, total };
}

function familyOnly(family: ModelFamily, total: number): Record<ModelFamily, TokenBreakdown> {
  const acc = emptyByModel();
  acc[family] = breakdown(total);
  return acc;
}

function emptyDispatchKinds(): ScanResult["byDispatchKind"] {
  const out = {} as ScanResult["byDispatchKind"];
  for (const kind of DISPATCH_KINDS) out[kind] = emptyByModel();
  return out;
}

/**
 * A minimal synthetic {@link ScanResult} on the ESTIMATE-fallback path: the
 * OAuth read failed, so the headline degrades to the transcript+calibration
 * estimate and NEVER silently reads 0 (the #1083/#1124 invariant). All tokens
 * land under the `opus` family so the totals are easy to reason about.
 */
function makeScan(overrides: Partial<ScanResult> = {}): ScanResult {
  const opus5h = 100;
  const opus7d = 700;
  const opus24h = 100;
  return {
    acc5h: breakdown(opus5h),
    acc7d: breakdown(opus7d),
    byModel5h: familyOnly("opus", opus5h),
    byModel7d: familyOnly("opus", opus7d),
    byModel24h: familyOnly("opus", opus24h),
    bySkillByModel: { "hydra-dev": familyOnly("opus", opus7d) },
    bySkillByModel24h: { "hydra-dev": familyOnly("opus", opus24h) },
    byDispatchKind: emptyDispatchKinds(),
    tokens24h: opus24h,
    // Foreign-provider (non-Anthropic-quota) 7d spend, issue #3769. Zero here:
    // this fixture models an Anthropic-only scan, and the assembly must not
    // fold this field into any Anthropic total regardless of its value.
    foreign7d: breakdown(0),
    // Failed OAuth read → estimate fallback. `lastKnownOAuth: null` keeps the
    // #2832 divergence detector inert (cold cache).
    oauth: {
      result: { ok: false, code: "oauth-usage-no-credentials" },
      stale: false,
      ageMs: null,
      lastKnownOAuth: null,
      consecutiveFailures: 1,
    },
    mostRecentObservedResetMs: null,
    sinceResetEntries: [],
    filesScanned: 3,
    filesSkippedByMtime: 1,
    linesParsed: 42,
    linesWithUsage: 40,
    parseErrors: 0,
    filesServedFromMemo: 0,
    ...overrides,
  };
}

const QUOTA_ENV_KEYS = [
  "HYDRA_USAGE_WEEKLY_QUOTA_TOKENS",
  "HYDRA_USAGE_5H_QUOTA_TOKENS",
  "HYDRA_USAGE_WEEKLY_RESET_ANCHOR",
  "HYDRA_USAGE_CACHE_READ_WEIGHT",
  "HYDRA_USAGE_DRIFT_REFERENCE_PERCENT",
  "HYDRA_USAGE_DRIFT_FACTOR",
  "HYDRA_QUOTA_WEIGHT_OPUS",
  "HYDRA_QUOTA_WEIGHT_SONNET",
  "HYDRA_QUOTA_WEIGHT_HAIKU",
] as const;

describe("assembleSnapshot (direct, no-IO)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot + clear the calibration env so each case starts from the
    // uncalibrated default and sets only what it needs (per-case isolation).
    for (const k of QUOTA_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of QUOTA_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("uncalibrated: percents are 0, diagnostics + raw totals pass through, no hard stop", () => {
    const snap = assembleSnapshot(makeScan(), NOW);

    // Uncalibrated (no quota env) => every percentage is 0, nothing calibrated.
    assert.equal(snap.calibrated, false);
    assert.equal(snap.percentLast5h, 0);
    assert.equal(snap.percentLast7d, 0);
    assert.equal(snap.projectedWeeklyPercent, 0);
    assert.equal(snap.pacingState, "under");

    // Estimate fallback (failed OAuth): source is the estimate, error surfaced,
    // and the hard stops NEVER fire on the estimate path (#1124 fail-open).
    assert.equal(snap.usageSource, "estimate");
    assert.equal(snap.oauthError, "oauth-usage-no-credentials");
    assert.equal(snap.oauthStale, false);
    assert.equal(snap.emergencyStop, false);
    assert.equal(snap.weeklyEmergencyStop, false);

    // Raw window totals + diagnostics are verbatim pass-throughs off the scan.
    assert.equal(snap.tokensLast5h.total, 100);
    assert.equal(snap.tokensLast7d.total, 700);
    assert.equal(snap.tokensLast24h, 100);
    assert.equal(snap.filesScanned, 3);
    assert.equal(snap.filesSkippedByMtime, 1);
    assert.equal(snap.linesParsed, 42);
    assert.equal(snap.linesWithUsage, 40);
    assert.equal(snap.parseErrors, 0);

    // Time is read ONLY off the `now` argument — deterministic, no Date.now().
    assert.equal(snap.generatedAt, NOW.toISOString());

    // byModel is the 7d per-family accumulator; opus carries the 700 total.
    assert.equal(snap.byModel.opus.total, 700);

    // Reconciliation: Σ_skill bySkillByModel[skill].opus.total === byModel.opus.total.
    const skillOpus = Object.values(snap.bySkillByModel).reduce(
      (sum, fam) => sum + fam.opus.total,
      0,
    );
    assert.equal(skillOpus, snap.byModel.opus.total);

    // bySkillByModel24h (issue #3752) is surfaced verbatim from the scan and
    // reconciles against tokensLast24h: Σ_skill Σ_family .total === tokens24h.
    // The fixture puts all 24h tokens under hydra-dev/opus (opus24h=100).
    const skill24hTotal = Object.values(snap.bySkillByModel24h).reduce(
      (sum, fam) => sum + fam.opus.total,
      0,
    );
    assert.equal(skill24hTotal, snap.tokensLast24h);
    assert.equal(snap.bySkillByModel24h["hydra-dev"].opus.total, 100);

    // No Weekly Reset Anchor env => since-reset window is neutral.
    assert.equal(snap.weeklyResetAnchor, null);
    assert.equal(snap.percentSinceReset, 0);
    assert.equal(snap.tokensSinceReset.total, 0);
  });

  test("calibrated quota env drives the estimate percentages off the weighted burn", () => {
    // 5h quota 1000, weekly quota 7000; opus 100 (5h) / 700 (7d) raw totals with
    // default cache-read weight 1.0 and no quota-weight calibration => the burn
    // numerator reduces to the raw .total. Estimate percents = total / quota * 100.
    process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "1000";
    process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "7000";

    const snap = assembleSnapshot(makeScan(), NOW);

    assert.equal(snap.calibrated, true);
    // Still the estimate source (OAuth failed) — the estimate is now non-zero.
    assert.equal(snap.usageSource, "estimate");
    assert.equal(snap.percentLast5h, (100 / 1000) * 100); // 10
    assert.equal(snap.percentLast7d, (700 / 7000) * 100); // 10

    // Hard stops STILL do not fire on the estimate path even when calibrated
    // (#1124): the estimate is a fail-open guess, only a real OAuth meter stops.
    assert.equal(snap.emergencyStop, false);
    assert.equal(snap.weeklyEmergencyStop, false);

    assert.equal(snap.weeklyQuotaTokens, 7000);
    assert.equal(snap.fiveHourQuotaTokens, 1000);
  });

  test("prior-week per-skill totals drive the week-over-week delta; null => 'new'", () => {
    // Current: hydra-dev opus 700 this week. Prior week: hydra-dev 350.
    const withPrior = assembleSnapshot(makeScan(), NOW, { "hydra-dev": 350 });
    const wow = withPrior.bySkillWoW["hydra-dev"];
    assert.ok(wow, "hydra-dev present in bySkillWoW");
    assert.equal(wow.current, 700);
    assert.equal(wow.prior, 350);
    assert.equal(wow.deltaPct, 100); // doubled week over week

    // No prior week => the skill is "new" (prior/deltaPct null).
    const noPrior = assembleSnapshot(makeScan(), NOW, null);
    const wowNew = noPrior.bySkillWoW["hydra-dev"];
    assert.ok(wowNew);
    assert.equal(wowNew.current, 700);
    assert.equal(wowNew.prior, null);
    assert.equal(wowNew.deltaPct, null);
  });
});

// ---------------------------------------------------------------------------
// weightedQuotaBurn — the now-exported two-axis fold (issue #873, #3548)
// ---------------------------------------------------------------------------
describe("weightedQuotaBurn (exported fold — issue #3548)", () => {
  function famBreakdown(family: ModelFamily, over: Partial<TokenBreakdown>): Record<ModelFamily, TokenBreakdown> {
    const acc = emptyByModel();
    acc[family] = { ...EMPTY_BREAKDOWN, ...over };
    return acc;
  }

  test("the snapshot-assembly export and the cost/index barrel export are the SAME fn", () => {
    // One weighting definition, two consumers — assert reference identity.
    assert.equal(weightedQuotaBurn, weightedQuotaBurnBarrel);
  });

  test("identity weights + cacheReadWeight 1.0 reduce to the raw cache-weighted sum", () => {
    const byModel = famBreakdown("opus", { input: 100, cacheRead: 900, total: 1000 });
    // input 100 + 1.0×cacheRead 900 = 1000, opus weight 1.
    assert.equal(weightedQuotaBurn(byModel, 1.0, { opus: 1, sonnet: 1, haiku: 1 }), 1000);
  });

  test("cacheReadWeight (Axis A) discounts cacheRead tokens inside a family", () => {
    const byModel = famBreakdown("opus", { input: 100, cacheRead: 900, total: 1000 });
    // input 100 + 0.1×cacheRead 900 = 190.
    assert.equal(weightedQuotaBurn(byModel, 0.1, { opus: 1, sonnet: 1, haiku: 1 }), 190);
  });

  test("per-family burn weight (Axis B) scales the family total; axes compose", () => {
    const byModel = famBreakdown("opus", { input: 100, cacheRead: 900, total: 1000 });
    // opus weight 5 × (100 + 0.1×900) = 5 × 190 = 950.
    assert.equal(weightedQuotaBurn(byModel, 0.1, { opus: 5, sonnet: 1, haiku: 1 }), 950);
  });

  test("an all-zero breakdown folds to 0 (a genuine computed zero)", () => {
    assert.equal(weightedQuotaBurn(emptyByModel(), 1.0, { opus: 1, sonnet: 1, haiku: 1 }), 0);
  });
});

// ---------------------------------------------------------------------------
// Pure snapshot-assembly helper suites moved from test/usage-tracker.test.mts
// (issue #4788, ADR-0042 Decision 8).
// ---------------------------------------------------------------------------

describe("deriveAttributedPercent — coverage % pure fold (issue #2403)", () => {
  const b = (total: number) => ({ ...EMPTY, input: total, total });
  const EMPTY = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  const row = (opus: number) => ({
    opus: b(opus),
    sonnet: { ...EMPTY },
    haiku: { ...EMPTY },
    unknown: { ...EMPTY },
  });

  test("0 when total is 0 (no division by zero)", () => {
    assert.equal(deriveAttributedPercent(emptyByDispatchKind()), 0);
  });

  test("0 when every token is interactive (the pre-#2402 all-residual world)", () => {
    const k = emptyByDispatchKind();
    k.interactive = row(500);
    assert.equal(deriveAttributedPercent(k), 0);
  });

  test("100 when no interactive tokens", () => {
    const k = emptyByDispatchKind();
    k["autopilot-dispatched"] = row(300);
    k["operator-invoked"] = row(100);
    assert.equal(deriveAttributedPercent(k), 100);
  });

  test("(total - interactive)/total * 100 on a mixed split", () => {
    const k = emptyByDispatchKind();
    k["autopilot-dispatched"] = row(60);
    k["operator-invoked"] = row(20);
    k.interactive = row(20);
    // (100 - 20) / 100 * 100 = 80
    assert.equal(deriveAttributedPercent(k), 80);
  });
});

// AC3: the pure estimate-vs-OAuth divergence detector (issue #2832). Fires a
// single logger.warn when the fail-open transcript estimate has drifted far
// from the last-known real meter value DURING an OAuth outage.
describe("detectEstimateOAuthDivergence — pure detector (issue #2832 AC3)", () => {
  let cap: ReturnType<typeof captureLoggerLines>;
  beforeEach(() => {
    cap = captureLoggerLines();
  });
  afterEach(() => {
    cap.restore();
  });

  function divergenceWarnings(): string[] {
    return cap.lines().filter((w) => w.includes("estimate/OAuth divergence"));
  }

  test("inert while the headline is on OAuth (never fires with a live/stale meter)", () => {
    detectEstimateOAuthDivergence({
      usageSource: "oauth",
      estimatePercentLast7d: 95,
      lastKnownOAuthPercent: 10, // wildly divergent, but usageSource is oauth
      divergenceFactor: 1.5,
    });
    assert.equal(divergenceWarnings().length, 0);
  });

  test("inert when no last-known OAuth value exists (null baseline — #1083 silent-0 trap)", () => {
    detectEstimateOAuthDivergence({
      usageSource: "estimate",
      estimatePercentLast7d: 95,
      lastKnownOAuthPercent: null,
      divergenceFactor: 1.5,
    });
    assert.equal(divergenceWarnings().length, 0);
  });

  test("inert when the last-known OAuth baseline is 0 (undefined ratio)", () => {
    detectEstimateOAuthDivergence({
      usageSource: "estimate",
      estimatePercentLast7d: 40,
      lastKnownOAuthPercent: 0,
      divergenceFactor: 1.5,
    });
    assert.equal(divergenceWarnings().length, 0);
  });

  test("fires ONCE when the estimate is > factor ABOVE the last-known OAuth value", () => {
    // estimate 60% vs last-known 20% = 3x > 1.5x -> warn.
    detectEstimateOAuthDivergence({
      usageSource: "estimate",
      estimatePercentLast7d: 60,
      lastKnownOAuthPercent: 20,
      divergenceFactor: 1.5,
    });
    assert.equal(divergenceWarnings().length, 1);
  });

  test("fires when the estimate is > factor BELOW the last-known OAuth value", () => {
    // estimate 10% vs last-known 40% = 0.25x < 1/1.5 -> warn.
    detectEstimateOAuthDivergence({
      usageSource: "estimate",
      estimatePercentLast7d: 10,
      lastKnownOAuthPercent: 40,
      divergenceFactor: 1.5,
    });
    assert.equal(divergenceWarnings().length, 1);
  });

  test("does NOT fire when the estimate is within the factor band of the OAuth value", () => {
    // estimate 25% vs last-known 20% = 1.25x, inside 1.5x -> no warn.
    detectEstimateOAuthDivergence({
      usageSource: "estimate",
      estimatePercentLast7d: 25,
      lastKnownOAuthPercent: 20,
      divergenceFactor: 1.5,
    });
    assert.equal(divergenceWarnings().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Issue #2188: the four pure snapshot-assembly helpers extracted out of
// assembleSnapshot. Each takes already-computed scalars/sub-accumulators and
// returns its slice — testable without a ScanResult fixture or the full build.
// ---------------------------------------------------------------------------

describe("derivePacingState (pure fold, issues #2188 + #4121)", () => {
  test("uncalibrated is always 'under', regardless of inputs", () => {
    assert.equal(derivePacingState(false, 95, 0.7, 200), "under");
    assert.equal(derivePacingState(false, 0, null, 0), "under");
  });

  test("no window position (null or 0 fraction) falls back to the legacy projection thresholds", () => {
    // INV-4: preserve the pre-#4121 derivation when no window reference exists.
    assert.equal(derivePacingState(true, 67, null, 200), "over");
    assert.equal(derivePacingState(true, 67, null, 90), "on"); // 80–100 band
    assert.equal(derivePacingState(true, 67, null, 79), "under");
    assert.equal(derivePacingState(true, 67, 0, 200), "over"); // fraction 0 = unusable
  });

  test("window position: 67% consumed at 70% elapsed (3pp under target) is 'under'", () => {
    assert.equal(derivePacingState(true, 67, 0.7, 200), "under"); // the 2026-08-17 reading
  });

  test("window position: 'over' above the +2pp band, 'on' inside it (inclusive edges)", () => {
    // Target 50 at fraction 0.5: band [48, 52].
    assert.equal(derivePacingState(true, 52.01, 0.5, 0), "over");
    assert.equal(derivePacingState(true, 52, 0.5, 0), "on");
    assert.equal(derivePacingState(true, 50, 0.5, 0), "on");
    assert.equal(derivePacingState(true, 48, 0.5, 0), "on");
    assert.equal(derivePacingState(true, 47.99, 0.5, 0), "under");
    // The projection is IGNORED whenever a window position exists.
    assert.equal(derivePacingState(true, 80, 0.4, 0), "over"); // 80 vs target 40
  });
});

describe("deriveWindowPace (pure fold, issue #4121)", () => {
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-05-25T12:00:00Z");

  test("no boundary at all → both fields null (estimate path, Anchor unset)", () => {
    const r = deriveWindowPace({
      nowMs: NOW,
      sevenDayResetsAt: null,
      weeklyResetAnchor: null,
      percentLast7d: 67,
    });
    assert.equal(r.windowElapsedFraction, null);
    assert.equal(r.paceRatio, null);
  });

  test("unparseable ISO at both levels → both null, no throw", () => {
    const r = deriveWindowPace({
      nowMs: NOW,
      sevenDayResetsAt: "not-a-date",
      weeklyResetAnchor: "also-not-a-date",
      percentLast7d: 67,
    });
    assert.equal(r.windowElapsedFraction, null);
    assert.equal(r.paceRatio, null);
  });

  test("unparseable sevenDayResetsAt falls through to a parseable Anchor", () => {
    const anchor = new Date(NOW - Math.round(0.7 * 7 * DAY)).toISOString();
    const r = deriveWindowPace({
      nowMs: NOW,
      sevenDayResetsAt: "not-a-date",
      weeklyResetAnchor: anchor,
      percentLast7d: 28.57,
    });
    assert.ok(r.windowElapsedFraction !== null && Math.abs(r.windowElapsedFraction - 0.7) < 1e-9);
    assert.ok(r.paceRatio !== null && Math.abs(r.paceRatio - 28.57 / 70) < 1e-9);
  });

  test("OAuth boundary takes precedence over the Anchor when both are present", () => {
    const resetsAt = new Date(NOW + Math.round(0.3 * 7 * DAY)).toISOString();
    const anchor = new Date(NOW - Math.round(0.4 * 7 * DAY)).toISOString(); // would be 0.4
    const r = deriveWindowPace({
      nowMs: NOW,
      sevenDayResetsAt: resetsAt,
      weeklyResetAnchor: anchor,
      percentLast7d: 67,
    });
    assert.ok(r.windowElapsedFraction !== null && Math.abs(r.windowElapsedFraction - 0.7) < 1e-9);
  });

  test("Anchor-only: fraction from the Anchor boundary (0.7 elapsed)", () => {
    const anchor = new Date(NOW - Math.round(0.7 * 7 * DAY)).toISOString();
    const r = deriveWindowPace({
      nowMs: NOW,
      sevenDayResetsAt: null,
      weeklyResetAnchor: anchor,
      percentLast7d: 67,
    });
    assert.ok(r.windowElapsedFraction !== null && Math.abs(r.windowElapsedFraction - 0.7) < 1e-9);
    assert.ok(r.paceRatio !== null && Math.abs(r.paceRatio - 67 / 70) < 1e-9);
  });

  test("OAuth boundary 70% elapsed: fraction 0.7, paceRatio = percentLast7d / 70", () => {
    // resetsAt 0.3*7d in the future ⇒ window started 0.7*7d ago (the observed
    // 2026-08-17 reading: 67% consumed at ~70% elapsed).
    const resetsAt = new Date(NOW + Math.round(0.3 * 7 * DAY)).toISOString();
    const r = deriveWindowPace({
      nowMs: NOW,
      sevenDayResetsAt: resetsAt,
      weeklyResetAnchor: null,
      percentLast7d: 67,
    });
    assert.ok(r.windowElapsedFraction !== null && Math.abs(r.windowElapsedFraction - 0.7) < 1e-9);
    assert.ok(r.paceRatio !== null && Math.abs(r.paceRatio - 67 / 70) < 1e-9);
  });

  test("window not yet started (boundary > 7d out) → fraction clamps to 0, paceRatio null", () => {
    const resetsAt = new Date(NOW + 8 * DAY).toISOString();
    const r = deriveWindowPace({
      nowMs: NOW,
      sevenDayResetsAt: resetsAt,
      weeklyResetAnchor: null,
      percentLast7d: 67,
    });
    assert.equal(r.windowElapsedFraction, 0);
    assert.equal(r.paceRatio, null);
  });

  test("boundary already past (stale) → fraction clamps to 1, paceRatio = percent/100", () => {
    const resetsAt = new Date(NOW - DAY).toISOString();
    const r = deriveWindowPace({
      nowMs: NOW,
      sevenDayResetsAt: resetsAt,
      weeklyResetAnchor: null,
      percentLast7d: 80,
    });
    assert.equal(r.windowElapsedFraction, 1);
    assert.ok(r.paceRatio !== null && Math.abs(r.paceRatio - 0.8) < 1e-9);
  });
});

describe("rebaseOnOAuth (pure headline-rebase helper, issue #2188)", () => {
  const freshOk = (fiveHourPct: number, sevenDayPct: number): ScanResultOAuth => ({
    result: {
      ok: true,
      data: {
        fiveHour: { utilization: fiveHourPct, resetsAt: "2026-06-19T12:00:00.000Z" },
        sevenDay: { utilization: sevenDayPct, resetsAt: "2026-06-25T12:00:00.000Z" },
      },
    },
    stale: false,
    ageMs: 0,
    lastKnownOAuth: {
      fiveHour: { utilization: fiveHourPct, resetsAt: "2026-06-19T12:00:00.000Z" },
      sevenDay: { utilization: sevenDayPct, resetsAt: "2026-06-25T12:00:00.000Z" },
    },
    consecutiveFailures: 0,
  });

  test("a FRESH OAuth read rebases the headline onto real utilization", () => {
    const r = rebaseOnOAuth(freshOk(42, 71), 5, 6);
    assert.equal(r.percentLast5h, 42);
    assert.equal(r.percentLast7d, 71);
    assert.equal(r.usageSource, "oauth");
    assert.equal(r.oauthError, null);
    assert.equal(r.oauthStale, false);
    assert.equal(r.oauthAgeMs, 0);
    assert.equal(r.oauthFiveHourResetsAt, "2026-06-19T12:00:00.000Z");
    assert.equal(r.oauthSevenDayResetsAt, "2026-06-25T12:00:00.000Z");
  });

  test("a STALE last-good (#1090) stays usageSource:'oauth' but flags stale", () => {
    const stale: ScanResultOAuth = {
      result: {
        ok: true,
        data: {
          fiveHour: { utilization: 30, resetsAt: null },
          sevenDay: { utilization: 55, resetsAt: null },
        },
      },
      stale: true,
      ageMs: 123_456,
      lastKnownOAuth: {
        fiveHour: { utilization: 30, resetsAt: null },
        sevenDay: { utilization: 55, resetsAt: null },
      },
      consecutiveFailures: 1,
    };
    const r = rebaseOnOAuth(stale, 9, 9);
    assert.equal(r.usageSource, "oauth"); // stale-but-real still backs the headline
    assert.equal(r.percentLast5h, 30);
    assert.equal(r.percentLast7d, 55);
    assert.equal(r.oauthError, "oauth-usage-stale");
    assert.equal(r.oauthStale, true);
    assert.equal(r.oauthAgeMs, 123_456);
  });

  test("a FAILED read NEVER reads 0 — falls back to the estimate (#1083 never-silently-0)", () => {
    const failed: ScanResultOAuth = {
      result: { ok: false, code: "oauth-usage-token-expired" },
      stale: false,
      ageMs: null,
      lastKnownOAuth: null,
      consecutiveFailures: 1,
    };
    const r = rebaseOnOAuth(failed, 17, 23);
    assert.equal(r.usageSource, "estimate");
    assert.equal(r.percentLast5h, 17); // the estimate stands, NOT 0
    assert.equal(r.percentLast7d, 23);
    assert.equal(r.oauthError, "oauth-usage-token-expired");
    assert.equal(r.oauthStale, false);
    assert.equal(r.oauthAgeMs, null);
    assert.equal(r.oauthFiveHourResetsAt, null);
    assert.equal(r.oauthSevenDayResetsAt, null);
  });

  test("does not mutate its inputs (pure)", () => {
    const oauth = freshOk(10, 20);
    const frozen = JSON.stringify(oauth);
    rebaseOnOAuth(oauth, 1, 2);
    assert.equal(JSON.stringify(oauth), frozen);
  });
});

describe("deriveSinceReset (pure fixed-window helper, issue #2188)", () => {
  const NOW = Date.UTC(2026, 5, 19, 12, 0, 0); // 2026-06-19T12:00Z
  const baseInput = {
    mostRecentObservedResetMs: null as number | null,
    nowMs: NOW,
    sinceResetEntries: [] as { tsMs: number; tokens: TokenBreakdown; family: ModelFamily }[],
    cacheReadWeight: 1,
    burnWeights: { opus: 1, sonnet: 1, haiku: 1 },
    calibrated: true,
    weeklyQuota: 1000,
  };

  test("Anchor unset (null) returns the neutral all-zero slice", () => {
    const r = deriveSinceReset({ ...baseInput, anchorEnvMs: null });
    assert.equal(r.percentSinceReset, 0);
    assert.equal(r.weeklyResetAnchor, null);
    assert.equal(r.tokensSinceReset.total, 0);
  });

  // Anchor 10 days before now: k = floor(10/7) = 1, so the projected current
  // boundary is anchor + 7d = 3 days before now (NOT 7 — the 7d*k floor lands
  // on the most recent boundary at-or-before now, which is why a 14d anchor
  // would put the boundary exactly on now).
  const ANCHOR_10D = NOW - 10 * 86_400_000;
  const BOUNDARY_3D = ANCHOR_10D + 7 * 86_400_000; // NOW - 3d

  test("sums only entries at/after the projected current-window boundary", () => {
    // Tokens carried as `input` so the weighted burn numerator (which folds over
    // the token-TYPE fields, not the raw `.total`) is non-zero with all weights
    // at identity 1.0 — `percentSinceReset` then reduces to total/quota*100.
    const r = deriveSinceReset({
      ...baseInput,
      anchorEnvMs: ANCHOR_10D,
      sinceResetEntries: [
        { tsMs: BOUNDARY_3D - 1000, tokens: fixtureBreakdown({ input: 100 }), family: "opus" }, // before boundary => excluded
        { tsMs: BOUNDARY_3D + 1000, tokens: fixtureBreakdown({ input: 200 }), family: "opus" }, // after boundary => included
        { tsMs: NOW - 1000, tokens: fixtureBreakdown({ input: 300 }), family: "sonnet" }, // included
      ],
    });
    assert.equal(r.tokensSinceReset.total, 500); // 200 + 300
    assert.equal(r.percentSinceReset, 50); // weighted burn 500 / 1000 * 100 (identity weights)
    assert.equal(r.weeklyResetAnchor, new Date(BOUNDARY_3D).toISOString());
  });

  test("an observed reset more recent than the env boundary (and <= now) auto-corrects the boundary", () => {
    const observed = NOW - 2 * 86_400_000; // newer than BOUNDARY_3D (NOW-3d), before now
    const r = deriveSinceReset({
      ...baseInput,
      anchorEnvMs: ANCHOR_10D,
      mostRecentObservedResetMs: observed,
      sinceResetEntries: [
        { tsMs: BOUNDARY_3D + 1000, tokens: fixtureBreakdown({ total: 999 }), family: "opus" }, // before observed => now excluded
        { tsMs: observed + 1000, tokens: fixtureBreakdown({ total: 400 }), family: "opus" }, // after observed => included
      ],
    });
    assert.equal(r.weeklyResetAnchor, new Date(observed).toISOString());
    assert.equal(r.tokensSinceReset.total, 400);
  });

  test("an observed reset in the FUTURE (> now) is ignored — env boundary stands", () => {
    const r = deriveSinceReset({
      ...baseInput,
      anchorEnvMs: ANCHOR_10D,
      mostRecentObservedResetMs: NOW + 86_400_000, // in the future => ignored
    });
    assert.equal(r.weeklyResetAnchor, new Date(BOUNDARY_3D).toISOString());
  });

  test("uncalibrated => percentSinceReset 0 but raw tokensSinceReset still summed", () => {
    const r = deriveSinceReset({
      ...baseInput,
      calibrated: false,
      anchorEnvMs: ANCHOR_10D,
      sinceResetEntries: [
        { tsMs: BOUNDARY_3D + 1000, tokens: fixtureBreakdown({ total: 250 }), family: "opus" },
      ],
    });
    assert.equal(r.percentSinceReset, 0);
    assert.equal(r.tokensSinceReset.total, 250); // honest raw count regardless of calibration
  });
});

describe("detectCalibrationDrift (pure fail-loud detector, issue #2188)", () => {
  // ADR-0027: the detector now logs through the pino seam (process.stderr), so
  // capture the serialized JSON lines and collect the `msg` of each calibration-
  // drift record — the `detectCalibrationDrift` fn is pure and emits at most this
  // one warn, so filtering on the stable message keeps the exactly-once asserts.
  function withWarnCapture(fn: () => void): string[] {
    const cap = captureLoggerLines();
    try {
      fn();
    } finally {
      cap.restore();
    }
    return cap.lines().filter((w) => w.includes("calibration drift"));
  }

  const base = {
    driftFactor: 2,
    calibrated: true,
    anchorEnvMs: 1_700_000_000_000,
    cacheReadWeight: 1,
    weeklyQuota: 1000,
  };

  test("inert when the reference is unset (null) — no warn", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, driftReference: null, percentSinceReset: 999 }),
    );
    assert.equal(warns.length, 0);
  });

  test("inert when uncalibrated — no warn even on wild divergence", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, calibrated: false, driftReference: 10, percentSinceReset: 999 }),
    );
    assert.equal(warns.length, 0);
  });

  test("inert when the Anchor is unset (null) — no warn", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, anchorEnvMs: null, driftReference: 10, percentSinceReset: 999 }),
    );
    assert.equal(warns.length, 0);
  });

  test("warns exactly once when percentSinceReset is more than driftFactor ABOVE reference", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, driftReference: 10, percentSinceReset: 21 }), // > 10*2
    );
    assert.equal(warns.length, 1);
    assert.match(warns[0], /calibration drift/);
  });

  test("warns exactly once when percentSinceReset is more than driftFactor BELOW reference", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, driftReference: 10, percentSinceReset: 4 }), // < 10/2
    );
    assert.equal(warns.length, 1);
  });

  test("silent inside the band (no divergence beyond driftFactor)", () => {
    const warns = withWarnCapture(() =>
      detectCalibrationDrift({ ...base, driftReference: 10, percentSinceReset: 15 }), // within [5, 20]
    );
    assert.equal(warns.length, 0);
  });
});

// Small fixture helpers for the scalar-math suites below (issue #2247): a flat
// breakdown and a per-family accumulator with one family pre-filled.
function bd(over: Partial<TokenBreakdown> = {}): TokenBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, ...over };
}
function byModelWith(over: Partial<Record<ModelFamily, TokenBreakdown>> = {}): Record<ModelFamily, TokenBreakdown> {
  return { opus: bd(), sonnet: bd(), haiku: bd(), unknown: bd(), ...over };
}

describe("deriveWeightedBurns (pure burn-numerator triple, issue #2247)", () => {
  const IDENTITY = { opus: 1, sonnet: 1, haiku: 1 };

  test("identity weights (w_cache=1, all families 1.0) reduce to raw .total sums", () => {
    // weightedTokens at w_cache=1 == input+output+cacheCreation+cacheRead == .total.
    const m5 = byModelWith({ opus: bd({ total: 100, input: 100 }) });
    const m7 = byModelWith({ sonnet: bd({ total: 250, output: 250 }) });
    const m24 = byModelWith({ haiku: bd({ total: 40, input: 40 }) });
    const r = deriveWeightedBurns(m5, m7, m24, 1, IDENTITY);
    assert.equal(r.weightedBurn5h, 100);
    assert.equal(r.weightedBurn7d, 250);
    assert.equal(r.weightedBurn24h, 40);
  });

  test("per-family Quota Weight (Axis B) scales OUTSIDE each family", () => {
    const m = byModelWith({
      opus: bd({ total: 10, input: 10 }),
      sonnet: bd({ total: 10, input: 10 }),
      haiku: bd({ total: 10, input: 10 }),
    });
    const r = deriveWeightedBurns(m, m, m, 1, { opus: 5, sonnet: 2, haiku: 1 });
    // 10*5 + 10*2 + 10*1 + unknown(0)*1 = 80 for every window.
    assert.equal(r.weightedBurn5h, 80);
    assert.equal(r.weightedBurn7d, 80);
    assert.equal(r.weightedBurn24h, 80);
  });

  test("cache-read weight (Axis A) reshapes the mix INSIDE the family", () => {
    // 100 input + 100 cacheRead; at w_cache=0.1 the burn is 100 + 0.1*100 = 110.
    const m = byModelWith({ opus: bd({ input: 100, cacheRead: 100, total: 200 }) });
    const r = deriveWeightedBurns(m, m, m, 0.1, IDENTITY);
    assert.equal(r.weightedBurn5h, 110);
  });

  test("composes both axes (familyWeight * weightedTokens) without double-counting", () => {
    // opus: input 100 + cacheRead 100 -> weightedTokens(0.1)=110; *w_opus=5 => 550.
    const m = byModelWith({ opus: bd({ input: 100, cacheRead: 100, total: 200 }) });
    const r = deriveWeightedBurns(m, m, m, 0.1, { opus: 5, sonnet: 2, haiku: 3 });
    assert.equal(r.weightedBurn7d, 550);
  });
});

describe("deriveEstimatePercents (pure estimate %, issue #2247)", () => {
  const burns = { weightedBurn5h: 50, weightedBurn7d: 200, weightedBurn24h: 100 };

  test("uncalibrated short-circuits all three to 0", () => {
    const r = deriveEstimatePercents(burns, 1000, 500, false);
    assert.equal(r.estimatePercentLast5h, 0);
    assert.equal(r.estimatePercentLast7d, 0);
    assert.equal(r.projectedWeeklyPercent, 0);
  });

  test("calibrated: 5h and 7d divide by their quotas; projection extends 24h * 7", () => {
    const r = deriveEstimatePercents(burns, 1000, 500, true);
    assert.equal(r.estimatePercentLast5h, (50 / 500) * 100); // 10
    assert.equal(r.estimatePercentLast7d, (200 / 1000) * 100); // 20
    assert.equal(r.projectedWeeklyPercent, ((100 * 7) / 1000) * 100); // 70
  });

  test("projectedWeeklyPercent crosses 100 when the 24h rate would overrun the week", () => {
    // 24h burn 200 -> *7 = 1400 over a 1000 quota -> 140%.
    const r = deriveEstimatePercents(
      { weightedBurn5h: 0, weightedBurn7d: 0, weightedBurn24h: 200 },
      1000,
      500,
      true,
    );
    assert.ok(r.projectedWeeklyPercent > 100);
    assert.equal(r.projectedWeeklyPercent, 140);
    // and that feeds derivePacingState 'over' via the no-window-reference
    // legacy fallback (issue #4121 INV-4)
    assert.equal(derivePacingState(true, 0, null, r.projectedWeeklyPercent), "over");
  });
});

describe("deriveQuotaWeightTotals (pure Quota-Weight totals, issue #2247)", () => {
  const weights = { opus: 5, sonnet: 2, haiku: 1 };

  test("uncalibrated (gate false) returns both totals as exactly 0", () => {
    const m = byModelWith({ opus: bd({ total: 1000 }) });
    const r = deriveQuotaWeightTotals(m, m, weights, false);
    assert.equal(r.quotaWeightLast5h, 0);
    assert.equal(r.quotaWeightLast7d, 0);
  });

  test("calibrated: sums raw .total per family scaled by familyWeight (no cache axis)", () => {
    const m5 = byModelWith({
      opus: bd({ total: 10 }),
      sonnet: bd({ total: 10 }),
      haiku: bd({ total: 10 }),
      unknown: bd({ total: 10 }), // unknown is implicit 1.0
    });
    const m7 = byModelWith({ opus: bd({ total: 100 }) });
    const r = deriveQuotaWeightTotals(m5, m7, weights, true);
    // 10*5 + 10*2 + 10*1 + 10*1(unknown implicit) = 90
    assert.equal(r.quotaWeightLast5h, 90);
    // 100*5 = 500
    assert.equal(r.quotaWeightLast7d, 500);
  });

  test("ignores the cache-read axis — uses .total verbatim, not a cache-weighted mix", () => {
    // A family with a heavy cacheRead share but the SAME .total as a plain one
    // produces the same Quota-Weight total (Axis A does not apply here).
    const heavy = byModelWith({ opus: bd({ cacheRead: 90, input: 10, total: 100 }) });
    const plain = byModelWith({ opus: bd({ input: 100, total: 100 }) });
    const rHeavy = deriveQuotaWeightTotals(heavy, heavy, weights, true);
    const rPlain = deriveQuotaWeightTotals(plain, plain, weights, true);
    assert.equal(rHeavy.quotaWeightLast5h, rPlain.quotaWeightLast5h);
    assert.equal(rHeavy.quotaWeightLast5h, 500); // 100 * 5
  });
});

describe("deriveBySkillWoW (pure per-skill week-over-week trend, issue #2404)", () => {
  test("no prior snapshot → every skill is 'new' (prior/deltaPct null)", () => {
    const cur = {
      "hydra-dev": byModelWith({ opus: bd({ total: 100, input: 100 }) }),
      "hydra-qa": byModelWith({ sonnet: bd({ total: 40, output: 40 }) }),
    };
    const r = deriveBySkillWoW(cur, null);
    assert.equal(r["hydra-dev"].current, 100);
    assert.equal(r["hydra-dev"].prior, null);
    assert.equal(r["hydra-dev"].deltaPct, null);
    assert.equal(r["hydra-qa"].current, 40);
    assert.equal(r["hydra-qa"].prior, null);
    assert.equal(r["hydra-qa"].deltaPct, null);
  });

  test("computes signed deltaPct vs the prior week's per-skill total", () => {
    const cur = {
      "hydra-dev": byModelWith({ opus: bd({ total: 150, input: 150 }) }),
      "hydra-qa": byModelWith({ sonnet: bd({ total: 50, output: 50 }) }),
    };
    const prior = { "hydra-dev": 100, "hydra-qa": 100 };
    const r = deriveBySkillWoW(cur, prior);
    // +50% up
    assert.equal(r["hydra-dev"].prior, 100);
    assert.equal(r["hydra-dev"].deltaPct, 50);
    // -50% down
    assert.equal(r["hydra-qa"].prior, 100);
    assert.equal(r["hydra-qa"].deltaPct, -50);
  });

  test("a skill present this week but absent from prior is 'new' (deltaPct null)", () => {
    const cur = { "hydra-research": byModelWith({ opus: bd({ total: 10, input: 10 }) }) };
    const prior = { "hydra-dev": 100 };
    const r = deriveBySkillWoW(cur, prior);
    assert.equal(r["hydra-research"].current, 10);
    assert.equal(r["hydra-research"].prior, null);
    assert.equal(r["hydra-research"].deltaPct, null);
  });

  test("prior total of 0 yields deltaPct null (no divide-by-zero / Infinity)", () => {
    const cur = { "hydra-dev": byModelWith({ opus: bd({ total: 100, input: 100 }) }) };
    const prior = { "hydra-dev": 0 };
    const r = deriveBySkillWoW(cur, prior);
    assert.equal(r["hydra-dev"].prior, 0);
    assert.equal(r["hydra-dev"].deltaPct, null);
  });

  test("the trend is keyed off CURRENT-week skills — a dropped skill is absent", () => {
    const cur = { "hydra-dev": byModelWith({ opus: bd({ total: 100, input: 100 }) }) };
    const prior = { "hydra-dev": 100, "hydra-qa": 200 };
    const r = deriveBySkillWoW(cur, prior);
    assert.deepEqual(Object.keys(r), ["hydra-dev"]);
    assert.equal(r["hydra-qa"], undefined);
  });

  test("current total sums over ALL model families (raw .total)", () => {
    const cur = {
      "hydra-dev": byModelWith({
        opus: bd({ total: 100, input: 100 }),
        sonnet: bd({ total: 25, output: 25 }),
        haiku: bd({ total: 5, input: 5 }),
      }),
    };
    const r = deriveBySkillWoW(cur, null);
    assert.equal(r["hydra-dev"].current, 130);
  });
});
