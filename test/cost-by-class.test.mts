/**
 * Regression tests for per-class cost attribution (issue #1439).
 *
 * The orchestrator already records per-skill / per-cycle subagent token spend
 * via the cost surrogate (`recordSubagentTokens`). #1439 adds a pure
 * projection that folds the per-skill daily breakdown into the autopilot
 * dispatch classes (research / dev-orch / dev-target / qa / cleanup / retro /
 * other) so operators can answer "what fraction of today's spend does research
 * vs dev vs QA consume?".
 *
 * Locked behaviors:
 *   1. `skillToCostClass` maps every known skill to its class; the long tail
 *      and unknown/empty inputs fall to `other` (never `unknown`), so the
 *      bucket sum always equals the daily total.
 *   2. `projectCostByClass` is a pure fold: sums tokens per class, computes
 *      each class's fraction of the total (0..1, 2dp), every class present
 *      (zeros included), skills sorted desc.
 *   3. `getCostByClass` composes the live per-skill surrogate with the fold.
 *
 * The pure-function suite needs no Redis. The `getCostByClass` integration
 * suite requires Redis on localhost:6379 and uses DB 1 (test DB) — never DB 0.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import type { UsageSnapshot } from "../src/cost/types.ts";
import type { ModelFamily, TokenBreakdown } from "../src/cost/token-math.ts";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  skillToCostClass,
  projectCostByClass,
  projectCostByClassFromTranscript,
  getCostByClass,
  getRollingCostByClass,
  COST_CLASS_ORDER,
  projectCostPerMergedPr,
  sumTokensOverWindow,
  getCostPerMergedPr,
  DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS,
  projectClassCostEfficiency,
  getClassCostEfficiency,
} = await import("../src/cost/index.ts");

const { recordSubagentTokens, dateStringDaysAgo } = await import(
  "../src/cost/surrogate.ts"
);
const { tokensAutopilotDailyKey, tokensBySkillDailyKey } = await import("../src/redis/cost.ts");

// ---------------------------------------------------------------------------
// Pure: skillToCostClass
// ---------------------------------------------------------------------------

describe("skillToCostClass", () => {
  test("maps known skills to their dispatch class", () => {
    assert.equal(skillToCostClass("hydra-dev"), "dev-orch");
    assert.equal(skillToCostClass("hydra-target-build"), "dev-target");
    assert.equal(skillToCostClass("hydra-qa"), "qa");
    assert.equal(skillToCostClass("hydra-target-qa"), "qa");
    assert.equal(skillToCostClass("hydra-retro"), "retro");
    assert.equal(skillToCostClass("hydra-target-retro"), "retro");
    assert.equal(skillToCostClass("hydra-cleanup"), "cleanup");
    assert.equal(skillToCostClass("hydra-research"), "research");
    assert.equal(skillToCostClass("hydra-issue-research"), "research");
    assert.equal(skillToCostClass("hydra-target-research"), "research");
    assert.equal(skillToCostClass("hydra-discover"), "research");
    assert.equal(skillToCostClass("hydra-tool-scout"), "research");
  });

  test("target-build does NOT collapse into dev-orch", () => {
    // Regression guard: the specific `hydra-target-build` check must precede
    // the generic `hydra-dev` check.
    assert.notEqual(skillToCostClass("hydra-target-build"), "dev-orch");
    assert.equal(skillToCostClass("hydra-target-build"), "dev-target");
  });

  test("is case-insensitive and trims whitespace", () => {
    assert.equal(skillToCostClass("  HYDRA-DEV  "), "dev-orch");
    assert.equal(skillToCostClass("Hydra-QA"), "qa");
  });

  test("unknown / housekeeping / empty skills fall to `other`, never `unknown`", () => {
    assert.equal(skillToCostClass("hydra-sweep"), "other");
    assert.equal(skillToCostClass("hydra-digest"), "other");
    assert.equal(skillToCostClass("hydra-doctor"), "other");
    assert.equal(skillToCostClass("totally-made-up"), "other");
    assert.equal(skillToCostClass(""), "other");
    assert.equal(skillToCostClass(undefined), "other");
    assert.equal(skillToCostClass(null), "other");
  });

  test("the 'interactive' residual skill maps to its OWN class, not `other` (INV-3)", () => {
    // Host activity the autopilot did not dispatch (operator sessions, other
    // projects) resolves to the `interactive` skill in-transcript; it must land
    // in a NAMED class so it is visible, never folded into `other` (the residual
    // for a recorded-but-untaxonomised hydra skill) and never dropped.
    assert.equal(skillToCostClass("interactive"), "interactive");
    assert.notEqual(skillToCostClass("interactive"), "other");
  });
});

// ---------------------------------------------------------------------------
// Pure: projectCostByClass
// ---------------------------------------------------------------------------

describe("projectCostByClass", () => {
  test("folds per-skill tokens into per-class totals + fractions", () => {
    const result = projectCostByClass(
      [
        { skill: "hydra-research", tokens: 4500 },
        { skill: "hydra-dev", tokens: 3000 },
        { skill: "hydra-qa", tokens: 1500 },
        { skill: "hydra-cleanup", tokens: 500 },
        { skill: "hydra-retro", tokens: 500 },
      ],
      "2026-06-09",
    );

    assert.equal(result.date, "2026-06-09");
    assert.equal(result.totalTokens, 10000);
    assert.equal(result.byClass.research.tokens, 4500);
    assert.equal(result.byClass.research.fraction, 0.45);
    assert.equal(result.byClass["dev-orch"].tokens, 3000);
    assert.equal(result.byClass["dev-orch"].fraction, 0.3);
    assert.equal(result.byClass.qa.fraction, 0.15);
    assert.equal(result.byClass.cleanup.fraction, 0.05);
    assert.equal(result.byClass.retro.fraction, 0.05);
    // Untouched classes are present with zeros.
    assert.equal(result.byClass["dev-target"].tokens, 0);
    assert.equal(result.byClass["dev-target"].fraction, 0);
    assert.equal(result.byClass.other.tokens, 0);
    // Surrogate arm (INV-2/INV-4/INV-8): model-blind source + zeroed model
    // fields. projectCostByClass stays a pure fold over (skill, tokens).
    assert.equal(result.source, "dispatch-surrogate");
    assert.equal(result.byClass.research.byModel.opus, 0);
    assert.equal(result.byClass.research.quotaWeight, 0);
  });

  test("multiple skills in the same class roll up + sort desc", () => {
    const result = projectCostByClass(
      [
        { skill: "hydra-research", tokens: 1000 },
        { skill: "hydra-issue-research", tokens: 3000 },
        { skill: "hydra-discover", tokens: 1000 },
      ],
      "2026-06-09",
    );
    assert.equal(result.byClass.research.tokens, 5000);
    assert.equal(result.byClass.research.fraction, 1);
    assert.deepEqual(
      result.byClass.research.skills.map((s) => s.skill),
      ["hydra-issue-research", "hydra-research", "hydra-discover"],
    );
  });

  test("unknown skills land in `other`, keeping bucket sum == total", () => {
    const result = projectCostByClass(
      [
        { skill: "hydra-dev", tokens: 6000 },
        { skill: "hydra-sweep", tokens: 4000 },
      ],
      "2026-06-09",
    );
    assert.equal(result.byClass.other.tokens, 4000);
    const bucketSum = COST_CLASS_ORDER.reduce((s, c) => s + result.byClass[c].tokens, 0);
    assert.equal(bucketSum, result.totalTokens);
    assert.equal(bucketSum, 10000);
  });

  test("empty / zero / negative inputs => all-zero breakdown, no NaN fractions", () => {
    const empty = projectCostByClass([], "2026-06-09");
    assert.equal(empty.totalTokens, 0);
    for (const c of COST_CLASS_ORDER) {
      assert.equal(empty.byClass[c].tokens, 0);
      assert.equal(empty.byClass[c].fraction, 0);
    }

    const dirty = projectCostByClass(
      [
        { skill: "hydra-dev", tokens: 0 },
        { skill: "hydra-qa", tokens: -100 },
        { skill: "hydra-research", tokens: 200 },
      ],
      "2026-06-09",
    );
    assert.equal(dirty.totalTokens, 200);
    assert.equal(dirty.byClass.research.tokens, 200);
    assert.equal(dirty.byClass.research.fraction, 1);
    assert.equal(dirty.byClass["dev-orch"].tokens, 0);
    assert.equal(dirty.byClass.qa.tokens, 0);
  });

  test("fractions across all classes sum to ~1 for a populated window", () => {
    const result = projectCostByClass(
      [
        { skill: "hydra-research", tokens: 3333 },
        { skill: "hydra-dev", tokens: 3333 },
        { skill: "hydra-qa", tokens: 3334 },
      ],
      "2026-06-09",
    );
    const fracSum = COST_CLASS_ORDER.reduce((s, c) => s + result.byClass[c].fraction, 0);
    // Each per-class fraction is rounded to 2dp independently, so the sum can
    // drift by up to ~0.005 per nonzero class (here 3 classes => ~0.015).
    assert.ok(Math.abs(fracSum - 1) <= 0.02, `fraction sum ${fracSum} should ~= 1`);
  });
});

// ---------------------------------------------------------------------------
// Integration: getCostByClass over the live surrogate (Redis DB 1)
// ---------------------------------------------------------------------------

describe("getCostByClass (Redis-backed)", () => {
  let testRedis: any;
  const DATE = "2026-06-09";

  async function cleanKeys() {
    const keys = await testRedis.keys("hydra:metrics:tokens:*");
    if (keys.length > 0) await testRedis.del(...keys);
  }

  before(async () => {
    testRedis = new Redis(process.env.REDIS_URL);
  });
  beforeEach(async () => {
    await cleanKeys();
  });
  after(async () => {
    await cleanKeys();
    await testRedis.quit();
  });

  test("reads the live per-skill daily breakdown and folds it by class", async () => {
    await recordSubagentTokens("hydra-research", 4500, { date: DATE });
    await recordSubagentTokens("hydra-dev", 3000, { date: DATE });
    await recordSubagentTokens("hydra-qa", 1500, { date: DATE });
    await recordSubagentTokens("hydra-sweep", 1000, { date: DATE }); // -> other

    const result = await getCostByClass(DATE);
    assert.equal(result.date, DATE);
    assert.equal(result.totalTokens, 10000);
    assert.equal(result.byClass.research.tokens, 4500);
    assert.equal(result.byClass.research.fraction, 0.45);
    assert.equal(result.byClass["dev-orch"].tokens, 3000);
    assert.equal(result.byClass.qa.tokens, 1500);
    assert.equal(result.byClass.other.tokens, 1000);

    // Sanity: the Redis keys actually exist (we read the right surrogate).
    const dailyRaw = await testRedis.get(tokensAutopilotDailyKey(DATE));
    assert.equal(dailyRaw, "10000");
    const byHash = await testRedis.hgetall(tokensBySkillDailyKey(DATE));
    assert.equal(byHash["hydra-research"], "4500");

    // Historical arm (INV-2): sourced ONLY from the dispatch-observed counter,
    // model-blind (INV-4 zeros), so it is never mistaken for the comprehensive
    // transcript-24h arm.
    assert.equal(result.source, "dispatch-surrogate");
    assert.equal(result.byClass.research.byModel.opus, 0);
    assert.equal(result.byClass.research.quotaWeight, 0);
  });

  test("empty day => zeroed breakdown (no throw)", async () => {
    const result = await getCostByClass("2026-01-01");
    assert.equal(result.totalTokens, 0);
    for (const c of COST_CLASS_ORDER) {
      assert.equal(result.byClass[c].tokens, 0);
      assert.equal(result.byClass[c].fraction, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure: projectCostByClass window labelling (issue #2427)
// ---------------------------------------------------------------------------

describe("projectCostByClass window field", () => {
  test("defaults the window label to the date when none is supplied", () => {
    const result = projectCostByClass([{ skill: "hydra-dev", tokens: 100 }], "2026-06-09");
    assert.equal(result.window, "2026-06-09");
  });

  test("uses an explicit window label when supplied (rolling read)", () => {
    const result = projectCostByClass(
      [{ skill: "hydra-dev", tokens: 100 }],
      "2026-06-25",
      "last 24h (UTC) · 2026-06-24 + 2026-06-25",
    );
    assert.equal(result.window, "last 24h (UTC) · 2026-06-24 + 2026-06-25");
  });
});

// ---------------------------------------------------------------------------
// Comprehensive arm — projectCostByClassFromTranscript (pure, issue #3752).
//
// The rolling cost-by-class read was RE-SOURCED from the dispatch-observed
// surrogate (which sees only ~13% of real burn — autopilot-reaped subagents) to
// the transcript-scan snapshot's bySkillByModel24h cross-tab, so the per-class
// tokens sum to the snapshot's tokensLast24h and `fraction` becomes a true share
// of REAL burn. The "interactive" residual skill lands in its OWN named class so
// operator sessions are visible, not folded into `other`. These are PURE-fold
// tests over hand-built cross-tabs — no Redis, no filesystem. (issue #3752)
// ---------------------------------------------------------------------------

const ZERO_BREAKDOWN: TokenBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

/** A per-skill × per-family row carrying all four families, `total` set on one. */
function skillRow(family: ModelFamily, total: number): Record<ModelFamily, TokenBreakdown> {
  const row: Record<ModelFamily, TokenBreakdown> = {
    opus: { ...ZERO_BREAKDOWN },
    sonnet: { ...ZERO_BREAKDOWN },
    haiku: { ...ZERO_BREAKDOWN },
    unknown: { ...ZERO_BREAKDOWN },
  };
  row[family] = { ...ZERO_BREAKDOWN, total };
  return row;
}

describe("projectCostByClassFromTranscript (pure, issue #3752 comprehensive arm)", () => {
  test("per-class tokens sum to totalTokens AND totalTokens === tokensLast24h (INV-1)", () => {
    // A reconciling cross-tab: Σ all skills = 1000 = tokensLast24h.
    const result = projectCostByClassFromTranscript({
      bySkillByModel24h: {
        "hydra-dev": skillRow("opus", 300),
        "hydra-qa": skillRow("sonnet", 500),
        "hydra-research": skillRow("haiku", 200),
      },
      tokensLast24h: 1000,
      date: "2026-08-05",
      window: "last 24h (transcript)",
      weights: { opus: 5, sonnet: 1, haiku: 0.2 },
      quotaWeightCalibrated: true,
    });
    const bucketSum = COST_CLASS_ORDER.reduce((s, c) => s + result.byClass[c].tokens, 0);
    assert.equal(bucketSum, result.totalTokens, "bucket sum === totalTokens");
    assert.equal(result.totalTokens, 1000, "totalTokens === tokensLast24h (reconciling fixture)");
    assert.equal(result.byClass["dev-orch"].tokens, 300);
    assert.equal(result.byClass.qa.tokens, 500);
    assert.equal(result.byClass.research.tokens, 200);
  });

  test("the 'interactive' residual skill lands in its OWN named class, never 'other' (INV-3)", () => {
    const result = projectCostByClassFromTranscript({
      bySkillByModel24h: {
        interactive: skillRow("opus", 940), // host activity the autopilot never reaped
        "hydra-dev": skillRow("opus", 60),
      },
      tokensLast24h: 1000,
      date: "2026-08-05",
      window: "last 24h (transcript)",
      weights: { opus: 5, sonnet: 1, haiku: 0.2 },
      quotaWeightCalibrated: true,
    });
    assert.equal(result.byClass.interactive.tokens, 940);
    // 'other' stays reserved for a recorded-but-untaxonomised hydra skill — it is
    // NOT the dumping ground for undispatched host activity.
    assert.equal(result.byClass.other.tokens, 0);
    assert.equal(result.totalTokens, 1000);
  });

  test("carries the 'transcript-24h' source discriminator (INV-2)", () => {
    const result = projectCostByClassFromTranscript({
      bySkillByModel24h: { "hydra-dev": skillRow("opus", 10) },
      tokensLast24h: 10,
      date: "2026-08-05",
      window: "last 24h (transcript)",
      weights: { opus: 5, sonnet: 1, haiku: 0.2 },
      quotaWeightCalibrated: true,
    });
    assert.equal(result.source, "transcript-24h");
  });

  test("every entry carries a per-model breakdown + quotaWeight (INV-4)", () => {
    const result = projectCostByClassFromTranscript({
      bySkillByModel24h: { "hydra-dev": skillRow("opus", 300) },
      tokensLast24h: 300,
      date: "2026-08-05",
      window: "last 24h (transcript)",
      weights: { opus: 5, sonnet: 1, haiku: 0.2 },
      quotaWeightCalibrated: true,
    });
    const dev = result.byClass["dev-orch"];
    assert.equal(dev.byModel.opus, 300);
    assert.equal(dev.byModel.sonnet, 0);
    assert.equal(dev.byModel.haiku, 0);
    // Quota-Weight = Σ byModel[f] * familyWeight(f) = 300 * 5 (opus weight) = 1500.
    assert.equal(dev.quotaWeight, 1500);
    // A zero-token class still carries the full byModel shape + quotaWeight 0.
    assert.equal(result.byClass.qa.byModel.opus, 0);
    assert.equal(result.byClass.qa.quotaWeight, 0);
  });

  test("quotaWeight is 0 when uncalibrated, but byModel is still populated (INV-4/INV-7)", () => {
    const result = projectCostByClassFromTranscript({
      bySkillByModel24h: { "hydra-dev": skillRow("opus", 300) },
      tokensLast24h: 300,
      date: "2026-08-05",
      window: "last 24h (transcript)",
      weights: { opus: 1, sonnet: 1, haiku: 1 },
      quotaWeightCalibrated: false,
    });
    assert.equal(result.byClass["dev-orch"].quotaWeight, 0);
    // byModel is populated regardless of the calibration gate.
    assert.equal(result.byClass["dev-orch"].byModel.opus, 300);
  });

  test("empty cross-tab => zeroed breakdown, totalTokens 0, no NaN (INV-1 empty case)", () => {
    const result = projectCostByClassFromTranscript({
      bySkillByModel24h: {},
      tokensLast24h: 0,
      date: "2026-08-05",
      window: "last 24h (transcript)",
      weights: { opus: 5, sonnet: 1, haiku: 0.2 },
      quotaWeightCalibrated: true,
    });
    assert.equal(result.totalTokens, 0);
    for (const c of COST_CLASS_ORDER) {
      assert.equal(result.byClass[c].tokens, 0);
      assert.equal(result.byClass[c].fraction, 0);
      assert.equal(result.byClass[c].quotaWeight, 0);
    }
  });

  test("a Haiku-heavy class does NOT outrank an Opus-heavy class on quotaWeight (the inversion INV-4 prevents)", () => {
    // Raw tokens: cleanup (Haiku) 1000 > dev-orch (Opus) 100. But Quota-Weight
    // with opus=5, haiku=0.2: dev-orch = 500, cleanup = 200 — dev-orch burns MORE
    // quota despite fewer raw tokens, the false 'quota hog' read INV-4 prevents.
    const result = projectCostByClassFromTranscript({
      bySkillByModel24h: {
        "hydra-dev": skillRow("opus", 100),
        "hydra-cleanup": skillRow("haiku", 1000),
      },
      tokensLast24h: 1100,
      date: "2026-08-05",
      window: "last 24h (transcript)",
      weights: { opus: 5, sonnet: 1, haiku: 0.2 },
      quotaWeightCalibrated: true,
    });
    assert.ok(
      result.byClass["dev-orch"].quotaWeight > result.byClass.cleanup.quotaWeight,
      "Opus-heavy class must outrank Haiku-heavy class on quota burn",
    );
    // ...while on RAW tokens the ordering inverts (the trap INV-4 closes):
    assert.ok(result.byClass.cleanup.tokens > result.byClass["dev-orch"].tokens);
  });
});

// ---------------------------------------------------------------------------
// getRollingCostByClass — composition: folds the memoized snapshot's 24h
// cross-tab. Tested with an INJECTED snapshot (opts.snapshot) so it needs no
// Redis and no filesystem walk (INV-6: production rides the 60s getUsage()
// cache). The pure fold above covers the math; this pins the WIRING — the
// source discriminator, the window label, and that snapshot.bySkillByModel24h
// + tokensLast24h are threaded into the fold. (issue #3752)
// ---------------------------------------------------------------------------

describe("getRollingCostByClass (transcript-sourced, issue #3752)", () => {
  // The fold reads only bySkillByModel24h / tokensLast24h / generatedAt off the
  // snapshot; cast a minimal object so the composition is exercised without
  // building a 38-field UsageSnapshot literal.
  function snapshotFor(
    bySkillByModel24h: Record<string, Record<ModelFamily, TokenBreakdown>>,
    tokensLast24h: number,
    generatedAt: string,
  ): UsageSnapshot {
    return { bySkillByModel24h, tokensLast24h, generatedAt } as unknown as UsageSnapshot;
  }

  test("folds the injected snapshot's 24h cross-tab with source 'transcript-24h'", async () => {
    const NOW = new Date("2026-08-05T12:00:00.000Z");
    const result = await getRollingCostByClass(NOW, {
      snapshot: snapshotFor(
        {
          "hydra-dev": skillRow("opus", 700),
          interactive: skillRow("opus", 300),
        },
        1000,
        NOW.toISOString(),
      ),
    });
    assert.equal(result.source, "transcript-24h");
    assert.equal(result.date, "2026-08-05");
    // Window label names the transcript source + the snapshot's generatedAt.
    assert.match(result.window, /24h/i);
    assert.ok(result.window.includes(NOW.toISOString()));
    // INV-1: per-class sum === tokensLast24h.
    const bucketSum = COST_CLASS_ORDER.reduce((s, c) => s + result.byClass[c].tokens, 0);
    assert.equal(bucketSum, 1000);
    assert.equal(result.totalTokens, 1000);
    // INV-3: operator interactive sessions are a named class, not dropped.
    assert.equal(result.byClass.interactive.tokens, 300);
  });

  test("empty snapshot => zeroed breakdown, no throw", async () => {
    const NOW = new Date("2026-08-05T12:00:00.000Z");
    const result = await getRollingCostByClass(NOW, {
      snapshot: snapshotFor({}, 0, NOW.toISOString()),
    });
    assert.equal(result.source, "transcript-24h");
    assert.equal(result.totalTokens, 0);
    for (const c of COST_CLASS_ORDER) {
      assert.equal(result.byClass[c].tokens, 0);
      assert.equal(result.byClass[c].fraction, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure: projectCostPerMergedPr — the derived ratio (issue #2807)
// ---------------------------------------------------------------------------

describe("projectCostPerMergedPr", () => {
  test("divides tokens by merged count and rounds to the nearest token", () => {
    const r = projectCostPerMergedPr(30000, 4, 30);
    assert.equal(r.totalTokens, 30000);
    assert.equal(r.mergedPrCount, 4);
    assert.equal(r.tokensPerMergedPr, 7500);
    assert.equal(r.windowDays, 30);
  });

  test("rounds a non-integer ratio to the nearest whole token", () => {
    // 10000 / 3 = 3333.33… -> 3333
    assert.equal(projectCostPerMergedPr(10000, 3, 7).tokensPerMergedPr, 3333);
    // 10000 / 6 = 1666.66… -> 1667
    assert.equal(projectCostPerMergedPr(10000, 6, 7).tokensPerMergedPr, 1667);
  });

  test("zero merged PRs => null ratio (never Infinity/NaN)", () => {
    const r = projectCostPerMergedPr(12345, 0, 30);
    assert.equal(r.tokensPerMergedPr, null);
    assert.equal(r.mergedPrCount, 0);
    assert.equal(r.totalTokens, 12345);
  });

  test("clamps negative / non-finite inputs to safe zeros", () => {
    const r = projectCostPerMergedPr(-5, -2, -10);
    assert.equal(r.totalTokens, 0);
    assert.equal(r.mergedPrCount, 0);
    assert.equal(r.windowDays, 0);
    assert.equal(r.tokensPerMergedPr, null);
  });

  test("floors fractional token/merged/day inputs", () => {
    const r = projectCostPerMergedPr(100.9, 2.9, 30.9);
    assert.equal(r.totalTokens, 100);
    assert.equal(r.mergedPrCount, 2);
    assert.equal(r.windowDays, 30);
    assert.equal(r.tokensPerMergedPr, 50);
  });

  test("defaults the window label from windowDays when none supplied", () => {
    assert.equal(projectCostPerMergedPr(100, 1, 30).window, "last 30d (UTC)");
  });

  test("uses an explicit window label when supplied", () => {
    const r = projectCostPerMergedPr(100, 1, 30, "last 30d (UTC) · a → b");
    assert.equal(r.window, "last 30d (UTC) · a → b");
  });
});

// ---------------------------------------------------------------------------
// Redis-backed: sumTokensOverWindow + getCostPerMergedPr (issue #2807)
// ---------------------------------------------------------------------------

describe("cost-per-merged-pr (Redis-backed, issue #2807)", () => {
  let testRedis: any;
  // A fixed `now` so the trailing-window date math is deterministic.
  const NOW = new Date("2026-06-15T12:00:00.000Z");

  async function cleanKeys() {
    const keys = await testRedis.keys("hydra:metrics:tokens:*");
    if (keys.length > 0) await testRedis.del(...keys);
  }

  before(async () => {
    testRedis = new Redis(process.env.REDIS_URL);
  });
  beforeEach(async () => {
    await cleanKeys();
  });
  after(async () => {
    await cleanKeys();
    await testRedis.quit();
  });

  test("sumTokensOverWindow folds the per-day surrogate buckets over the window", async () => {
    // today, yesterday, 2 days ago (all inside a 3-day window).
    await recordSubagentTokens("hydra-dev", 1000, { date: dateStringDaysAgo(0, NOW) });
    await recordSubagentTokens("hydra-qa", 500, { date: dateStringDaysAgo(1, NOW) });
    await recordSubagentTokens("hydra-research", 300, { date: dateStringDaysAgo(2, NOW) });
    // 3 days ago is OUTSIDE a 3-day window -> excluded.
    await recordSubagentTokens("hydra-cleanup", 999, { date: dateStringDaysAgo(3, NOW) });

    const r = await sumTokensOverWindow(3, NOW);
    assert.equal(r.totalTokens, 1800);
    assert.equal(r.dates[1], dateStringDaysAgo(0, NOW)); // newest = today
    assert.equal(r.dates[0], dateStringDaysAgo(2, NOW)); // oldest = 2 days ago
    assert.ok(/3d/.test(r.window), "window labels the 3-day span");
  });

  test("getCostPerMergedPr composes the summed tokens with the injected merged count", async () => {
    await recordSubagentTokens("hydra-dev", 6000, { date: dateStringDaysAgo(0, NOW) });
    await recordSubagentTokens("hydra-qa", 2000, { date: dateStringDaysAgo(1, NOW) });

    const r = await getCostPerMergedPr(4, 2, NOW);
    assert.equal(r.totalTokens, 8000);
    assert.equal(r.mergedPrCount, 4);
    assert.equal(r.tokensPerMergedPr, 2000);
    assert.equal(r.windowDays, 2);
  });

  test("zero merged PRs => null ratio even with recorded tokens", async () => {
    await recordSubagentTokens("hydra-dev", 5000, { date: dateStringDaysAgo(0, NOW) });
    const r = await getCostPerMergedPr(0, 1, NOW);
    assert.equal(r.totalTokens, 5000);
    assert.equal(r.tokensPerMergedPr, null);
  });

  test("default window days is the module default", () => {
    assert.equal(DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS, 30);
  });
});

// ---------------------------------------------------------------------------
// Pure: projectClassCostEfficiency (the QA-cost-dominance audit read, #2971)
// ---------------------------------------------------------------------------

describe("projectClassCostEfficiency", () => {
  // A hand-built CostByClassResult fixture (the shape projectCostByClass emits),
  // so the efficiency fold is testable without touching Redis or the surrogate.
  function fixtureCostByClass(): any {
    return projectCostByClass(
      [
        { skill: "hydra-qa", tokens: 13700000 },
        { skill: "hydra-research", tokens: 11500000 },
        { skill: "hydra-dev", tokens: 5000000 },
      ],
      "2026-07-07",
      "last 24h (UTC) · 2026-07-06 + 2026-07-07",
    );
  }

  test("derives tokens-per-merged-PR for QA (the falsifiable efficiency number)", () => {
    const r = projectClassCostEfficiency(fixtureCostByClass(), 47);
    // 13,700,000 QA tokens / 47 merges = 291,489 (rounded).
    assert.equal(r.qa.tokens, 13700000);
    assert.equal(r.qa.tokensPerMergedPr, Math.round(13700000 / 47));
    assert.equal(r.mergedPrCount, 47);
  });

  test("surfaces the QA entry both at top level and under byClass identically", () => {
    const r = projectClassCostEfficiency(fixtureCostByClass(), 47);
    assert.deepEqual(r.qa, r.byClass.qa);
  });

  test("computes the per-merge ratio for every class on the same basis", () => {
    const r = projectClassCostEfficiency(fixtureCostByClass(), 10);
    assert.equal(r.byClass.qa.tokensPerMergedPr, 1370000);
    assert.equal(r.byClass.research.tokensPerMergedPr, 1150000);
    assert.equal(r.byClass["dev-orch"].tokensPerMergedPr, 500000);
    // A class that ran zero tokens still appears (zero, not absent).
    assert.equal(r.byClass.retro.tokens, 0);
    assert.equal(r.byClass.retro.tokensPerMergedPr, 0);
  });

  test("every COST_CLASS_ORDER class is present (comparative baseline)", () => {
    const r = projectClassCostEfficiency(fixtureCostByClass(), 5);
    for (const cls of COST_CLASS_ORDER) {
      assert.ok(cls in r.byClass, `class ${cls} present`);
    }
  });

  test("zero merged PRs => null ratio (undefined, not a misleading 0/Infinity)", () => {
    const r = projectClassCostEfficiency(fixtureCostByClass(), 0);
    assert.equal(r.mergedPrCount, 0);
    assert.equal(r.qa.tokensPerMergedPr, null);
    for (const cls of COST_CLASS_ORDER) {
      assert.equal(r.byClass[cls].tokensPerMergedPr, null);
    }
  });

  test("non-finite / negative merged count clamps to 0 => null ratios", () => {
    for (const bad of [-3, NaN, Infinity]) {
      const r = projectClassCostEfficiency(fixtureCostByClass(), bad as number);
      assert.equal(r.mergedPrCount, 0);
      assert.equal(r.qa.tokensPerMergedPr, null);
    }
  });

  test("preserves the source share (fraction) and window label unchanged", () => {
    const src = fixtureCostByClass();
    const r = projectClassCostEfficiency(src, 47);
    assert.equal(r.window, src.window);
    assert.equal(r.totalTokens, src.totalTokens);
    // fraction carried through verbatim from the per-class rollup.
    assert.equal(r.qa.fraction, src.byClass.qa.fraction);
  });

  test("per-class token sum equals the total (no spend disappears — invariant 1)", () => {
    const r = projectClassCostEfficiency(fixtureCostByClass(), 47);
    const sum = COST_CLASS_ORDER.reduce(
      (acc: number, cls: any) => acc + r.byClass[cls].tokens,
      0,
    );
    assert.equal(sum, r.totalTokens);
  });
});

// ---------------------------------------------------------------------------
// getClassCostEfficiency — composition with an INJECTED snapshot (issue #2971
// over the #3752 transcript-sourced rollup). The rolling arm is no longer
// surrogate-sourced, so this is exercised with opts.snapshot (no Redis, no
// filesystem) — the same path getRollingCostByClass takes above. The pure
// projectClassCostEfficiency math is covered by the suite directly above; this
// pins the WIRING — that the injected merged count derives the per-class ratio
// off the transcript 24h rollup.
// ---------------------------------------------------------------------------

describe("getClassCostEfficiency (transcript-sourced, issue #2971 + #3752)", () => {
  const NOW = new Date("2026-06-15T12:00:00.000Z");

  function snapshotFor(
    bySkillByModel24h: Record<string, Record<ModelFamily, TokenBreakdown>>,
    tokensLast24h: number,
  ): UsageSnapshot {
    return {
      bySkillByModel24h,
      tokensLast24h,
      generatedAt: NOW.toISOString(),
    } as unknown as UsageSnapshot;
  }

  test("composes the transcript per-class rollup with the injected merged count", async () => {
    const r = await getClassCostEfficiency(5, NOW, {
      snapshot: snapshotFor(
        {
          "hydra-qa": skillRow("sonnet", 10000),
          "hydra-dev": skillRow("opus", 2000),
        },
        12000,
      ),
    });
    assert.equal(r.qa.tokens, 10000);
    assert.equal(r.qa.tokensPerMergedPr, 2000); // 10000 / 5
    assert.equal(r.byClass["dev-orch"].tokens, 2000);
    assert.equal(r.byClass["dev-orch"].tokensPerMergedPr, 400); // 2000 / 5
    assert.equal(r.mergedPrCount, 5);
    assert.equal(r.totalTokens, 12000);
  });

  test("zero merged PRs => null ratios even with recorded QA spend", async () => {
    const r = await getClassCostEfficiency(0, NOW, {
      snapshot: snapshotFor({ "hydra-qa": skillRow("sonnet", 8000) }, 8000),
    });
    assert.equal(r.qa.tokens, 8000);
    assert.equal(r.qa.tokensPerMergedPr, null);
  });
});
