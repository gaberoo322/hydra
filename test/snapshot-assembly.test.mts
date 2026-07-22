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
import { assembleSnapshot, weightedQuotaBurn } from "../src/cost/snapshot-assembly.ts";
// The same fold re-exported on the public barrel (issue #3548): assert the two
// paths reference the identical function so consumers (the Class Yield
// Scoreboard) and `assembleSnapshot` share ONE weighting definition.
import { weightedQuotaBurn as weightedQuotaBurnBarrel } from "../src/cost/index.ts";
import {
  EMPTY_BREAKDOWN,
  emptyByModel,
  DISPATCH_KINDS,
} from "../src/cost/transcript-scan.ts";
import type { ScanResult } from "../src/cost/transcript-scan.ts";
import type { ModelFamily, TokenBreakdown } from "../src/cost/token-math.ts";

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
    byDispatchKind: emptyDispatchKinds(),
    tokens24h: opus24h,
    // Failed OAuth read → estimate fallback. `lastKnownOAuth: null` keeps the
    // #2832 divergence detector inert (cold cache).
    oauth: {
      result: { ok: false, code: "oauth-usage-no-credentials" },
      stale: false,
      ageMs: null,
      lastKnownOAuth: null,
    },
    mostRecentObservedResetMs: null,
    sinceResetEntries: [],
    filesScanned: 3,
    filesSkippedByMtime: 1,
    linesParsed: 42,
    linesWithUsage: 40,
    parseErrors: 0,
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
