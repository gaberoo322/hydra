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
  COST_CLASS_ORDER,
} = await import("../src/metrics/aggregate.ts");

const { recordSubagentTokens } = await import("../src/cost/surrogate.ts");
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
