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

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  skillToCostClass,
  projectCostByClass,
  getCostByClass,
  getRollingCostByClass,
  yesterdayDateString,
  COST_CLASS_ORDER,
  projectCostPerMergedPr,
  sumTokensOverWindow,
  getCostPerMergedPr,
  DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS,
} = await import("../src/cost/index.ts");

const { recordSubagentTokens, todayDateString, dateStringDaysAgo } = await import(
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
// Integration: getRollingCostByClass — the false-0% near-UTC-midnight fix
// (issue #2427). New top-level suite with its own Redis lifecycle so it does
// not piggyback on a sibling suite's teardown (CLAUDE.md authoring rule).
// ---------------------------------------------------------------------------

describe("getRollingCostByClass (Redis-backed, issue #2427)", () => {
  let testRedis: any;
  // Pin `now` to a thin sliver just after UTC midnight — the exact condition
  // that produced the false "decide.py isn't dispatching" 0% alarm.
  const NOW = new Date("2026-06-25T02:45:00.000Z");
  const TODAY = todayDateString(NOW); // "2026-06-25"
  const YESTERDAY = yesterdayDateString(NOW); // "2026-06-24"

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

  test("yesterdayDateString / todayDateString span the rolling window", () => {
    assert.equal(TODAY, "2026-06-25");
    assert.equal(YESTERDAY, "2026-06-24");
  });

  test("a class that ran only YESTERDAY (UTC) is NOT a false 0% at 02:45 UTC", async () => {
    // Work happened on UTC-06-24 (the operator's local day); the sliver of
    // UTC-06-25 so far is empty. A single-day "today" read would show 0%.
    await recordSubagentTokens("hydra-dev", 1900, { date: YESTERDAY });
    await recordSubagentTokens("hydra-qa", 1000, { date: YESTERDAY });

    // Baseline: the single-UTC-day "today" read reproduces the false 0%.
    const todayOnly = await getCostByClass(TODAY);
    assert.equal(todayOnly.totalTokens, 0);
    assert.equal(todayOnly.byClass["dev-orch"].tokens, 0);
    assert.equal(todayOnly.byClass.qa.tokens, 0);

    // Fix: the rolling window folds yesterday's bucket in, so the classes that
    // demonstrably ran in the last 24h read non-zero.
    const rolling = await getRollingCostByClass(NOW);
    assert.equal(rolling.totalTokens, 2900);
    assert.equal(rolling.byClass["dev-orch"].tokens, 1900);
    assert.ok(rolling.byClass["dev-orch"].fraction > 0, "dev-orch must not read 0%");
    assert.equal(rolling.byClass.qa.tokens, 1000);
    assert.ok(rolling.byClass.qa.fraction > 0, "qa must not read 0%");
  });

  test("merges today + yesterday per-skill buckets into one breakdown", async () => {
    await recordSubagentTokens("hydra-dev", 1000, { date: YESTERDAY });
    await recordSubagentTokens("hydra-dev", 500, { date: TODAY });
    await recordSubagentTokens("hydra-research", 2000, { date: TODAY });

    const rolling = await getRollingCostByClass(NOW);
    assert.equal(rolling.totalTokens, 3500);
    // dev-orch tokens are summed across both UTC days.
    assert.equal(rolling.byClass["dev-orch"].tokens, 1500);
    assert.equal(rolling.byClass.research.tokens, 2000);
    // The folded skill entry sums the two days too (not two separate rows).
    const devEntry = rolling.byClass["dev-orch"].skills.find((s: any) => s.skill === "hydra-dev");
    assert.equal(devEntry?.tokens, 1500);
  });

  test("carries an honest rolling-window label spanning both UTC dates", async () => {
    await recordSubagentTokens("hydra-dev", 100, { date: TODAY });
    const rolling = await getRollingCostByClass(NOW);
    assert.equal(rolling.date, TODAY);
    assert.ok(rolling.window.includes(YESTERDAY), "window names yesterday");
    assert.ok(rolling.window.includes(TODAY), "window names today");
    assert.ok(/24h/i.test(rolling.window), "window labels the 24h span");
  });

  test("empty 24h window => zeroed breakdown (no throw)", async () => {
    const rolling = await getRollingCostByClass(NOW);
    assert.equal(rolling.totalTokens, 0);
    for (const c of COST_CLASS_ORDER) {
      assert.equal(rolling.byClass[c].tokens, 0);
      assert.equal(rolling.byClass[c].fraction, 0);
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
