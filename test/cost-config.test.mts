/**
 * Unit tests for the `src/cost/config.ts` env-reader leaf — every suite whose
 * SUBJECT is a reader defined in that module lives here, not in
 * test/usage-tracker.test.mts.
 *
 * Two clusters:
 *
 * 1. Ranked-report burn-weight config readers (issue #3825). These readers
 *    (`getBurnWeight*` / `getBurnFamily*` + their `*Weights` composers) live in
 *    their OWN `HYDRA_USAGE_BURN_WEIGHT_*` / `HYDRA_USAGE_BURN_FAMILY_*`
 *    namespace, DISTINCT from the identity-by-default live-fold readers, and
 *    default to LIST-PRICE ratios so the report's calibration never leaks into
 *    the live gate. This cluster pins:
 *
 *      - the list-price DEFAULTS (category: input 1 / output 5 / cacheRead 0.1 /
 *        cacheCreation 1.25; family: opus 5 / sonnet 3 / haiku 1, calibrated
 *        from per-MTok input price)
 *      - env-var override per reader
 *      - the fail-loud fallback for a non-positive / non-finite value
 *      - the two composers delegate to the per-axis readers
 *
 * 2. The live-fold env-reader suites (issue #4786) — quota env parsing,
 *    `getWeeklyPaceCeiling`, `getGlmAbAssignmentFraction`,
 *    `getFiveHourThrottleT1`/`T2`, `getWeeklyResetAnchorMs`, the cache-read
 *    weight env, the drift env, and the estimate/OAuth divergence env — moved
 *    VERBATIM (as top-level describes with their own hooks) out of
 *    test/usage-tracker.test.mts so they sit beside the leaf they exercise.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getBurnWeightInput,
  getBurnWeightOutput,
  getBurnWeightCacheRead,
  getBurnWeightCacheCreation,
  getBurnCategoryWeights,
  getBurnFamilyWeightOpus,
  getBurnFamilyWeightSonnet,
  getBurnFamilyWeightHaiku,
  getBurnFamilyWeights,
  DEFAULT_BURN_WEIGHT_INPUT,
  DEFAULT_BURN_WEIGHT_OUTPUT,
  DEFAULT_BURN_WEIGHT_CACHE_READ,
  DEFAULT_BURN_WEIGHT_CACHE_CREATION,
  DEFAULT_BURN_FAMILY_OPUS,
  DEFAULT_BURN_FAMILY_SONNET,
  DEFAULT_BURN_FAMILY_HAIKU,
  // Live-fold env readers exercised by the suites moved from
  // test/usage-tracker.test.mts (issue #4786):
  getWeeklyQuotaTokens,
  getFiveHourQuotaTokens,
  getWeeklyPaceCeiling,
  DEFAULT_WEEKLY_PACE_CEILING,
  getGlmAbAssignmentFraction,
  DEFAULT_GLM_AB_ASSIGNMENT_FRACTION,
  getFiveHourThrottleT1,
  getFiveHourThrottleT2,
  DEFAULT_FIVE_HOUR_THROTTLE_T1,
  DEFAULT_FIVE_HOUR_THROTTLE_T2,
  getWeeklyResetAnchorMs,
  getCacheReadWeight,
  DEFAULT_CACHE_READ_WEIGHT,
  getDriftReferencePercent,
  getDriftFactor,
  DEFAULT_DRIFT_FACTOR,
  getOAuthEstimateDivergenceFactor,
  DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR,
} from "../src/cost/config.ts";
// The moved suites keep the env-snapshot hook discipline they had in
// test/usage-tracker.test.mts — one shared fixture, same as #4784/#4785 moves.
import { withEnvSnapshot } from "./_helpers/cost-fixtures.mts";

const BURN_ENV_KEYS = [
  "HYDRA_USAGE_BURN_WEIGHT_INPUT",
  "HYDRA_USAGE_BURN_WEIGHT_OUTPUT",
  "HYDRA_USAGE_BURN_WEIGHT_CACHE_READ",
  "HYDRA_USAGE_BURN_WEIGHT_CACHE_CREATION",
  "HYDRA_USAGE_BURN_FAMILY_OPUS",
  "HYDRA_USAGE_BURN_FAMILY_SONNET",
  "HYDRA_USAGE_BURN_FAMILY_HAIKU",
];

function snapshot() {
  const prev: Record<string, string | undefined> = {};
  for (const k of BURN_ENV_KEYS) prev[k] = process.env[k];
  return () => {
    for (const k of BURN_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
}

describe("ranked-report burn-weight config readers (issue #3825)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshot();
    for (const k of BURN_ENV_KEYS) delete process.env[k];
  });
  afterEach(() => restore());

  test("category readers default to the list-price ratios", () => {
    assert.equal(getBurnWeightInput(), DEFAULT_BURN_WEIGHT_INPUT);
    assert.equal(getBurnWeightOutput(), DEFAULT_BURN_WEIGHT_OUTPUT);
    assert.equal(getBurnWeightCacheRead(), DEFAULT_BURN_WEIGHT_CACHE_READ);
    assert.equal(getBurnWeightCacheCreation(), DEFAULT_BURN_WEIGHT_CACHE_CREATION);
    // The literal list-price ratios the issue names, pinned against the defaults:
    assert.equal(DEFAULT_BURN_WEIGHT_INPUT, 1.0);
    assert.equal(DEFAULT_BURN_WEIGHT_OUTPUT, 5.0);
    assert.equal(DEFAULT_BURN_WEIGHT_CACHE_READ, 0.1);
    assert.equal(DEFAULT_BURN_WEIGHT_CACHE_CREATION, 1.25);
  });

  test("family readers default to per-MTok-input-price calibration (opus 5 / sonnet 3 / haiku 1)", () => {
    assert.equal(getBurnFamilyWeightOpus(), DEFAULT_BURN_FAMILY_OPUS);
    assert.equal(getBurnFamilyWeightSonnet(), DEFAULT_BURN_FAMILY_SONNET);
    assert.equal(getBurnFamilyWeightHaiku(), DEFAULT_BURN_FAMILY_HAIKU);
    assert.equal(DEFAULT_BURN_FAMILY_OPUS, 5);
    assert.equal(DEFAULT_BURN_FAMILY_SONNET, 3);
    assert.equal(DEFAULT_BURN_FAMILY_HAIKU, 1);
  });

  test("each category reader honours its env var override", () => {
    process.env.HYDRA_USAGE_BURN_WEIGHT_INPUT = "2.7";
    process.env.HYDRA_USAGE_BURN_WEIGHT_OUTPUT = "6";
    process.env.HYDRA_USAGE_BURN_WEIGHT_CACHE_READ = "0.25";
    process.env.HYDRA_USAGE_BURN_WEIGHT_CACHE_CREATION = "2";
    assert.equal(getBurnWeightInput(), 2.7);
    assert.equal(getBurnWeightOutput(), 6);
    assert.equal(getBurnWeightCacheRead(), 0.25);
    assert.equal(getBurnWeightCacheCreation(), 2);
  });

  test("non-positive / non-finite values fall back to the default (fail-loud)", () => {
    // Each invalid shape is logged + falls back rather than silently dropping a
    // category. `0`, `-1`, and `abc` all return the default.
    for (const bad of ["0", "-1", "abc", "NaN", "Infinity"]) {
      process.env.HYDRA_USAGE_BURN_WEIGHT_INPUT = bad;
      assert.equal(getBurnWeightInput(), DEFAULT_BURN_WEIGHT_INPUT, `input fallback for ${bad}`);
    }
    process.env.HYDRA_USAGE_BURN_FAMILY_OPUS = "-5";
    assert.equal(getBurnFamilyWeightOpus(), DEFAULT_BURN_FAMILY_OPUS);
  });

  test("getBurnCategoryWeights composes the four category readers", () => {
    process.env.HYDRA_USAGE_BURN_WEIGHT_OUTPUT = "9";
    const w = getBurnCategoryWeights();
    assert.equal(w.input, DEFAULT_BURN_WEIGHT_INPUT);
    assert.equal(w.output, 9); // overridden
    assert.equal(w.cacheRead, DEFAULT_BURN_WEIGHT_CACHE_READ);
    assert.equal(w.cacheCreation, DEFAULT_BURN_WEIGHT_CACHE_CREATION);
  });

  test("getBurnFamilyWeights composes the three family readers", () => {
    process.env.HYDRA_USAGE_BURN_FAMILY_OPUS = "8";
    const w = getBurnFamilyWeights();
    assert.equal(w.opus, 8); // overridden
    assert.equal(w.sonnet, DEFAULT_BURN_FAMILY_SONNET);
    assert.equal(w.haiku, DEFAULT_BURN_FAMILY_HAIKU);
  });
});

// ---------------------------------------------------------------------------
// Live-fold env-reader suites — moved VERBATIM from test/usage-tracker.test.mts
// (issue #4786), in their original order, each with its own hooks.
// ---------------------------------------------------------------------------

describe("quota env parsing", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withEnvSnapshot();
  });
  afterEach(() => restore());

  test("returns 0 when unset", () => {
    delete process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS;
    delete process.env.HYDRA_USAGE_5H_QUOTA_TOKENS;
    assert.equal(getWeeklyQuotaTokens(), 0);
    assert.equal(getFiveHourQuotaTokens(), 0);
  });

  test("returns 0 on non-finite or non-positive values", () => {
    process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "abc";
    process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "-5";
    assert.equal(getWeeklyQuotaTokens(), 0);
    assert.equal(getFiveHourQuotaTokens(), 0);
  });

  test("returns positive parsed value when set", () => {
    process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS = "1000000";
    process.env.HYDRA_USAGE_5H_QUOTA_TOKENS = "50000";
    assert.equal(getWeeklyQuotaTokens(), 1_000_000);
    assert.equal(getFiveHourQuotaTokens(), 50_000);
  });
});

// -------------------------------------------------------------------------
// Pacing Ceiling env helper (issue #857, ADR-0021)
// -------------------------------------------------------------------------
describe("getWeeklyPaceCeiling", () => {
  const restore = withEnvSnapshot();
  afterEach(() => restore());

  test("unset → default", () => {
    delete process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING;
    assert.equal(getWeeklyPaceCeiling(), DEFAULT_WEEKLY_PACE_CEILING);
  });

  test("empty → default", () => {
    process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "";
    assert.equal(getWeeklyPaceCeiling(), DEFAULT_WEEKLY_PACE_CEILING);
  });

  test("valid fraction in (0,1] is used", () => {
    process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "0.8";
    assert.equal(getWeeklyPaceCeiling(), 0.8);
  });

  test("1.0 boundary is allowed", () => {
    process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "1";
    assert.equal(getWeeklyPaceCeiling(), 1);
  });

  test("above 1.0 clamps to 1.0", () => {
    process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "1.5";
    assert.equal(getWeeklyPaceCeiling(), 1);
  });

  test("zero/negative → default", () => {
    process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "0";
    assert.equal(getWeeklyPaceCeiling(), DEFAULT_WEEKLY_PACE_CEILING);
    process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "-0.3";
    assert.equal(getWeeklyPaceCeiling(), DEFAULT_WEEKLY_PACE_CEILING);
  });

  test("non-numeric → default", () => {
    process.env.HYDRA_USAGE_WEEKLY_PACE_CEILING = "abc";
    assert.equal(getWeeklyPaceCeiling(), DEFAULT_WEEKLY_PACE_CEILING);
  });
});

// -------------------------------------------------------------------------
// GLM A/B ramp fraction env helper (issue #4125, ADR-0032 slice beta)
// -------------------------------------------------------------------------
describe("getGlmAbAssignmentFraction", () => {
  const restore = withEnvSnapshot();
  afterEach(() => restore());

  test("unset → default (0.5)", () => {
    delete process.env.HYDRA_GLM_AB_ASSIGNMENT_FRACTION;
    assert.equal(getGlmAbAssignmentFraction(), DEFAULT_GLM_AB_ASSIGNMENT_FRACTION);
  });

  test("empty → default", () => {
    process.env.HYDRA_GLM_AB_ASSIGNMENT_FRACTION = "";
    assert.equal(getGlmAbAssignmentFraction(), DEFAULT_GLM_AB_ASSIGNMENT_FRACTION);
  });

  test("valid fraction in [0,1] is used", () => {
    process.env.HYDRA_GLM_AB_ASSIGNMENT_FRACTION = "0.25";
    assert.equal(getGlmAbAssignmentFraction(), 0.25);
  });

  test("0 boundary is allowed (ramp fully off — never control)", () => {
    process.env.HYDRA_GLM_AB_ASSIGNMENT_FRACTION = "0";
    assert.equal(getGlmAbAssignmentFraction(), 0);
  });

  test("1 boundary is allowed (never treatment)", () => {
    process.env.HYDRA_GLM_AB_ASSIGNMENT_FRACTION = "1";
    assert.equal(getGlmAbAssignmentFraction(), 1);
  });

  test("above 1 → default (not clamped — out of range is a config error)", () => {
    process.env.HYDRA_GLM_AB_ASSIGNMENT_FRACTION = "1.5";
    assert.equal(getGlmAbAssignmentFraction(), DEFAULT_GLM_AB_ASSIGNMENT_FRACTION);
  });

  test("negative → default", () => {
    process.env.HYDRA_GLM_AB_ASSIGNMENT_FRACTION = "-0.3";
    assert.equal(getGlmAbAssignmentFraction(), DEFAULT_GLM_AB_ASSIGNMENT_FRACTION);
  });

  test("non-numeric → default", () => {
    process.env.HYDRA_GLM_AB_ASSIGNMENT_FRACTION = "abc";
    assert.equal(getGlmAbAssignmentFraction(), DEFAULT_GLM_AB_ASSIGNMENT_FRACTION);
  });
});

// -------------------------------------------------------------------------
// 5h-throttle threshold env-readers (relocated to cost/config.ts in #2550).
// These are the env-read seam the fiveHourThrottleShed fold no longer owns:
// parse a fraction in (0,1); unset/empty/invalid → default + fail-loud.
// -------------------------------------------------------------------------
describe("getFiveHourThrottleT1 / getFiveHourThrottleT2", () => {
  const restore = withEnvSnapshot();
  afterEach(() => restore());

  test("unset → default", () => {
    delete process.env.HYDRA_USAGE_5H_THROTTLE_T1;
    delete process.env.HYDRA_USAGE_5H_THROTTLE_T2;
    assert.equal(getFiveHourThrottleT1(), DEFAULT_FIVE_HOUR_THROTTLE_T1);
    assert.equal(getFiveHourThrottleT2(), DEFAULT_FIVE_HOUR_THROTTLE_T2);
  });

  test("empty → default", () => {
    process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "";
    process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "";
    assert.equal(getFiveHourThrottleT1(), DEFAULT_FIVE_HOUR_THROTTLE_T1);
    assert.equal(getFiveHourThrottleT2(), DEFAULT_FIVE_HOUR_THROTTLE_T2);
  });

  test("valid fraction in (0,1) is used", () => {
    process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "0.4";
    process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "0.5";
    assert.equal(getFiveHourThrottleT1(), 0.4);
    assert.equal(getFiveHourThrottleT2(), 0.5);
  });

  test("non-finite / non-numeric → default (fail-loud, no throw)", () => {
    process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "not-a-number";
    process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "NaN";
    assert.equal(getFiveHourThrottleT1(), DEFAULT_FIVE_HOUR_THROTTLE_T1);
    assert.equal(getFiveHourThrottleT2(), DEFAULT_FIVE_HOUR_THROTTLE_T2);
  });

  test("≤0 → default", () => {
    process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "0";
    process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "-0.2";
    assert.equal(getFiveHourThrottleT1(), DEFAULT_FIVE_HOUR_THROTTLE_T1);
    assert.equal(getFiveHourThrottleT2(), DEFAULT_FIVE_HOUR_THROTTLE_T2);
  });

  test("≥1 → default (must be a strict fraction below 1)", () => {
    process.env.HYDRA_USAGE_5H_THROTTLE_T1 = "1";
    process.env.HYDRA_USAGE_5H_THROTTLE_T2 = "1.5";
    assert.equal(getFiveHourThrottleT1(), DEFAULT_FIVE_HOUR_THROTTLE_T1);
    assert.equal(getFiveHourThrottleT2(), DEFAULT_FIVE_HOUR_THROTTLE_T2);
  });
});

// -------------------------------------------------------------------------
// Weekly Reset Anchor + since-reset fixed window (issue #856, ADR-0021)
// -------------------------------------------------------------------------
describe("getWeeklyResetAnchorMs", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withEnvSnapshot();
  });
  afterEach(() => restore());

  test("unset → null", () => {
    delete process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
    assert.equal(getWeeklyResetAnchorMs(), null);
  });

  test("empty string → null", () => {
    process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "";
    assert.equal(getWeeklyResetAnchorMs(), null);
  });

  test("valid ISO → epoch-ms", () => {
    process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "2026-06-01T00:00:00Z";
    assert.equal(getWeeklyResetAnchorMs(), Date.parse("2026-06-01T00:00:00Z"));
  });

  test("garbage (set but unparseable) → null, does not throw", () => {
    process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR = "not-a-date";
    assert.equal(getWeeklyResetAnchorMs(), null);
  });
});

// -------------------------------------------------------------------------
// Cache-read weight + drift detection (issue #873)
// -------------------------------------------------------------------------
describe("cache-read weight env parsing", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withEnvSnapshot();
  });
  afterEach(() => restore());

  test("defaults to 1.0 (identity) when unset", () => {
    delete process.env.HYDRA_USAGE_CACHE_READ_WEIGHT;
    assert.equal(getCacheReadWeight(), DEFAULT_CACHE_READ_WEIGHT);
    assert.equal(getCacheReadWeight(), 1.0);
  });

  test("defaults to 1.0 on non-finite or non-positive values", () => {
    process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "abc";
    assert.equal(getCacheReadWeight(), 1.0);
    process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "0";
    assert.equal(getCacheReadWeight(), 1.0);
    process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "-0.5";
    assert.equal(getCacheReadWeight(), 1.0);
  });

  test("returns the parsed positive fractional weight when set", () => {
    process.env.HYDRA_USAGE_CACHE_READ_WEIGHT = "0.1";
    assert.equal(getCacheReadWeight(), 0.1);
  });
});

describe("drift env parsing", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withEnvSnapshot();
  });
  afterEach(() => restore());

  test("reference is null (inert) when unset", () => {
    delete process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT;
    assert.equal(getDriftReferencePercent(), null);
  });

  test("reference is null on non-positive / non-finite", () => {
    process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT = "0";
    assert.equal(getDriftReferencePercent(), null);
    process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT = "nope";
    assert.equal(getDriftReferencePercent(), null);
  });

  test("reference is the parsed positive percent when set", () => {
    process.env.HYDRA_USAGE_DRIFT_REFERENCE_PERCENT = "5";
    assert.equal(getDriftReferencePercent(), 5);
  });

  test("factor defaults to 2 when unset or <= 1", () => {
    delete process.env.HYDRA_USAGE_DRIFT_FACTOR;
    assert.equal(getDriftFactor(), DEFAULT_DRIFT_FACTOR);
    process.env.HYDRA_USAGE_DRIFT_FACTOR = "1";
    assert.equal(getDriftFactor(), DEFAULT_DRIFT_FACTOR);
    process.env.HYDRA_USAGE_DRIFT_FACTOR = "0.5";
    assert.equal(getDriftFactor(), DEFAULT_DRIFT_FACTOR);
  });

  test("factor is the parsed value when > 1", () => {
    process.env.HYDRA_USAGE_DRIFT_FACTOR = "3";
    assert.equal(getDriftFactor(), 3);
  });
});

describe("estimate/OAuth divergence env parsing (issue #2832 AC3)", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = withEnvSnapshot();
  });
  afterEach(() => restore());

  test("factor defaults to 1.5 when unset", () => {
    delete process.env.HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR;
    assert.equal(getOAuthEstimateDivergenceFactor(), DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR);
    assert.equal(DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR, 1.5);
  });

  test("factor falls back to default on <= 1 / non-finite", () => {
    process.env.HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR = "1";
    assert.equal(getOAuthEstimateDivergenceFactor(), DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR);
    process.env.HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR = "0.5";
    assert.equal(getOAuthEstimateDivergenceFactor(), DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR);
    process.env.HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR = "nope";
    assert.equal(getOAuthEstimateDivergenceFactor(), DEFAULT_OAUTH_ESTIMATE_DIVERGENCE_FACTOR);
  });

  test("factor is the parsed value when > 1", () => {
    process.env.HYDRA_OAUTH_ESTIMATE_DIVERGENCE_FACTOR = "2.5";
    assert.equal(getOAuthEstimateDivergenceFactor(), 2.5);
  });
});
