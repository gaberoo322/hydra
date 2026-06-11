/**
 * Regression tests for the cost-surrogate module (issue #394, #704).
 *
 * After PR-3 (issue #383, ADR-0006) deleted `codex-runner.ts`, the only
 * writer that fed `costMicrodollars` per cycle and the cost-cap reader was
 * gone. This module keeps the operator's token signal alive — per-day /
 * per-skill / per-cycle token totals from autopilot subagents.
 *
 * PR-2 (#704) stripped the dollar-conversion machinery (`tokensToUsd`,
 * `getTokenUsdRate`, `getCycleSubagentCostUsd`, and the `costUsd` /
 * `ratePerMillion` / `source` / `legacyRecordSpendUsd` fields plus the legacy
 * `hydra:scheduler:daily-spend` blob read). `HYDRA_TOKEN_USD_RATE` was
 * structurally $0 and no live dollar cap existed; the survivor is a pure token
 * counter. The dollar-tests and source/legacy-blob tests were removed with it.
 *
 * Required behaviors locked here:
 *
 *   1. `recordSubagentTokens` increments per-day total + per-skill hash
 *      + per-cycle hash atomically; subsequent reads see the rolling sum.
 *   2. `getDailyTokenCounter` returns the per-day total + per-skill breakdown
 *      (tokens + percentage), sorted by tokens desc.
 *
 * Requires Redis on localhost:6379. Uses DB 1 (test DB) — never touches DB 0.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const {
  recordSubagentTokens,
  getDailyTokenCounter,
  todayDateString,
  tokensAutopilotDailyKey,
  tokensBySkillDailyKey,
  tokensByCycleKey,
} = await import("../src/cost/surrogate.ts");

// `src/cost/cap.ts` (the per-cycle codex circuit breaker) and the dollar-
// conversion machinery (#704) were both retired. Only the token-counter
// behavior tests remain.

let testRedis: any;

async function cleanKeys() {
  const patterns = [
    "hydra:metrics:tokens:autopilot:daily:*",
    "hydra:metrics:tokens:by-skill:daily:*",
    "hydra:metrics:tokens:by-cycle:*",
    "hydra:cycle:*",
    "hydra:cycle:*:costs",
    "hydra:metrics:*",
    "hydra:anchors:*",
    "hydra:reflections:*",
  ];
  for (const pat of patterns) {
    const keys = await testRedis.keys(pat);
    if (keys.length > 0) await testRedis.del(...keys);
  }
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

describe("recordSubagentTokens + read path", () => {
  test("increments daily-total + per-skill + per-cycle keys atomically", async () => {
    const date = "2026-05-16";
    const cycleId = "cycle-test-1";

    const r1 = await recordSubagentTokens("hydra-dev", 12000, { date, cycleId });
    assert.equal(r1.tokens, 12000);
    assert.equal(r1.dailyTotal, 12000);
    assert.equal(r1.skillTotal, 12000);
    assert.equal(r1.cycleTotal, 12000);

    // Second call same skill — daily + per-skill sum, per-cycle accumulates.
    const r2 = await recordSubagentTokens("hydra-dev", 3000, { date, cycleId });
    assert.equal(r2.dailyTotal, 15000);
    assert.equal(r2.skillTotal, 15000);
    assert.equal(r2.cycleTotal, 15000);

    // Different skill, same day — separate skill bucket, same daily total.
    const r3 = await recordSubagentTokens("hydra-qa", 5000, { date });
    assert.equal(r3.dailyTotal, 20000);
    assert.equal(r3.skillTotal, 5000);
    assert.equal(r3.cycleTotal, null);

    // Verify Redis state matches.
    const dailyRaw = await testRedis.get(tokensAutopilotDailyKey(date));
    assert.equal(dailyRaw, "20000");
    const byHash = await testRedis.hgetall(tokensBySkillDailyKey(date));
    assert.equal(byHash["hydra-dev"], "15000");
    assert.equal(byHash["hydra-qa"], "5000");
    const cycleRaw = await testRedis.hget(tokensByCycleKey(cycleId), "tokens");
    assert.equal(cycleRaw, "15000");
  });

  test("zero/negative tokens are a no-op write but return current totals", async () => {
    const date = "2026-05-16";
    await recordSubagentTokens("hydra-dev", 1000, { date });
    const r = await recordSubagentTokens("hydra-dev", 0, { date });
    assert.equal(r.tokens, 0);
    assert.equal(r.dailyTotal, 1000); // not incremented
    assert.equal(r.skillTotal, 1000);

    const rNeg = await recordSubagentTokens("hydra-dev", -50, { date });
    assert.equal(rNeg.tokens, 0);
    assert.equal(rNeg.dailyTotal, 1000);
  });

  test("missing/blank skill is bucketed as 'unknown'", async () => {
    const date = "2026-05-16";
    await recordSubagentTokens("", 500, { date });
    await recordSubagentTokens("  ", 700, { date });
    const byHash = await testRedis.hgetall(tokensBySkillDailyKey(date));
    assert.equal(byHash["unknown"], "1200");
  });

  test("key TTL is set so day buckets age out after 30 days", async () => {
    const date = todayDateString();
    await recordSubagentTokens("hydra-dev", 1000, { date });
    const ttl = await testRedis.ttl(tokensAutopilotDailyKey(date));
    // 30 days = 2,592,000 seconds. Allow a wide margin for any test latency.
    assert.ok(ttl > 0 && ttl <= 30 * 24 * 3600, `TTL was ${ttl}`);
  });
});

describe("getDailyTokenCounter", () => {
  test("returns zero tokens + empty breakdown when no writers fired", async () => {
    const snap = await getDailyTokenCounter("2026-05-16");
    assert.equal(snap.date, "2026-05-16");
    assert.equal(snap.tokens, 0);
    assert.deepEqual(snap.bySkill, []);
  });

  test("aggregates the per-day total and per-skill breakdown", async () => {
    const date = "2026-05-16";
    await recordSubagentTokens("hydra-dev", 500_000, { date });
    await recordSubagentTokens("hydra-qa", 100_000, { date });

    const snap = await getDailyTokenCounter(date);
    assert.equal(snap.tokens, 600_000);

    // bySkill sorted by tokens desc, with correct percentages.
    assert.equal(snap.bySkill.length, 2);
    assert.equal(snap.bySkill[0].skill, "hydra-dev");
    assert.equal(snap.bySkill[0].tokens, 500_000);
    assert.equal(snap.bySkill[0].pct, 83.33);
    assert.equal(snap.bySkill[1].skill, "hydra-qa");
    assert.equal(snap.bySkill[1].tokens, 100_000);
    assert.equal(snap.bySkill[1].pct, 16.67);
  });
});
