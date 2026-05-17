/**
 * Regression tests for the cost-surrogate module (issue #394).
 *
 * After PR-3 (issue #383, ADR-0006) deleted `codex-runner.ts`, the only
 * writer that fed `costMicrodollars` per cycle and the cost-cap reader
 * was gone. This surrogate is the bridge that keeps the operator's
 * spend signal alive — token totals from autopilot subagents, converted
 * to USD via an operator-configurable `HYDRA_TOKEN_USD_RATE`.
 *
 * Required behaviors locked here:
 *
 *   1. `tokensToUsd` is pure and returns 0 when the rate is 0 (the
 *      intentional safe default — operator must opt in to a rate).
 *   2. `recordSubagentTokens` increments per-day total + per-skill hash
 *      + per-cycle hash atomically; subsequent reads see the rolling sum.
 *   3. `getDailySpendSurrogate` returns the correct `source` label based
 *      on which writer(s) contributed data.
 *   4. `getCycleSubagentCostUsd` reads the per-cycle hash so the cost-cap
 *      can include surrogate spend.
 *   5. `checkCostCap` (in cost-cap.ts) sees the surrogate via the new
 *      `getCycleCostWithSurrogateUsd` helper — a tokens-only cycle trips
 *      the cap when the surrogate USD exceeds the threshold, even when
 *      no legacy codex `costMicrodollars` is recorded.
 *
 * Requires Redis on localhost:6379. Uses DB 1 (test DB) — never touches DB 0.
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";
// Ensure tests run with a deterministic default rate (env may be set from
// the operator's shell). Individual tests override as needed.
delete process.env.HYDRA_TOKEN_USD_RATE;

const {
  tokensToUsd,
  recordSubagentTokens,
  getDailySpendSurrogate,
  getCycleSubagentCostUsd,
  todayDateString,
  tokensAutopilotDailyKey,
  tokensBySkillDailyKey,
  tokensByCycleKey,
  getTokenUsdRate,
} = await import("../src/cost-surrogate.ts");

// Pre-imported here so the describe() block below stays sync (top-level
// `await` inside a non-async callback breaks the esbuild transform).
const { checkCostCap, getCycleCostWithSurrogateUsd } = await import("../src/cost-cap.ts");

let testRedis: any;

async function cleanKeys() {
  const patterns = [
    "hydra:metrics:tokens:autopilot:daily:*",
    "hydra:metrics:tokens:by-skill:daily:*",
    "hydra:metrics:tokens:by-cycle:*",
    "hydra:scheduler:daily-spend",
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
  testRedis = new Redis("redis://localhost:6379/1");
});

beforeEach(async () => {
  await cleanKeys();
  delete process.env.HYDRA_TOKEN_USD_RATE;
});

after(async () => {
  await cleanKeys();
  await testRedis.quit();
});

describe("tokensToUsd (pure)", () => {
  test("returns 0 when rate is 0 (the safe default)", () => {
    assert.equal(tokensToUsd(1_000_000, 0), 0);
    assert.equal(tokensToUsd(0, 0), 0);
  });

  test("converts tokens via per-million rate", () => {
    // $3 per million → 500_000 tokens = $1.50
    assert.equal(tokensToUsd(500_000, 3), 1.5);
    // $0.30 per million → 1.5M tokens ≈ $0.45 (float precision tolerated)
    assert.ok(Math.abs(tokensToUsd(1_500_000, 0.3) - 0.45) < 1e-9);
  });

  test("rejects non-finite/negative inputs by clamping to 0", () => {
    assert.equal(tokensToUsd(NaN, 5), 0);
    assert.equal(tokensToUsd(-100, 5), 0);
    assert.equal(tokensToUsd(100, -1), 0);
    assert.equal(tokensToUsd(100, NaN), 0);
  });

  test("re-reads HYDRA_TOKEN_USD_RATE from env on each call", () => {
    process.env.HYDRA_TOKEN_USD_RATE = "5";
    assert.equal(getTokenUsdRate(), 5);
    assert.equal(tokensToUsd(1_000_000), 5);
    process.env.HYDRA_TOKEN_USD_RATE = "10";
    assert.equal(tokensToUsd(1_000_000), 10);
    delete process.env.HYDRA_TOKEN_USD_RATE;
    assert.equal(tokensToUsd(1_000_000), 0);
  });

  test("invalid rate string falls back to 0 (no spurious cap trips)", () => {
    process.env.HYDRA_TOKEN_USD_RATE = "not-a-number";
    assert.equal(getTokenUsdRate(), 0);
    process.env.HYDRA_TOKEN_USD_RATE = "-5";
    assert.equal(getTokenUsdRate(), 0);
    delete process.env.HYDRA_TOKEN_USD_RATE;
  });
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

describe("getDailySpendSurrogate", () => {
  test("returns source=none with zero spend when no writers fired", async () => {
    const snap = await getDailySpendSurrogate("2026-05-16");
    assert.equal(snap.source, "none");
    assert.equal(snap.tokens, 0);
    assert.equal(snap.costUsd, 0);
    assert.deepEqual(snap.bySkill, []);
  });

  test("source=autopilot-surrogate when only the token writer fired", async () => {
    process.env.HYDRA_TOKEN_USD_RATE = "3";
    const date = "2026-05-16";
    await recordSubagentTokens("hydra-dev", 500_000, { date });
    await recordSubagentTokens("hydra-qa", 100_000, { date });

    const snap = await getDailySpendSurrogate(date);
    assert.equal(snap.source, "autopilot-surrogate");
    assert.equal(snap.tokens, 600_000);
    // 600k tokens × $3/M = $1.80
    assert.equal(snap.costUsd, 1.8);
    assert.equal(snap.ratePerMillion, 3);
    assert.equal(snap.legacyRecordSpendUsd, 0);

    // bySkill sorted by tokens desc, with correct percentages.
    assert.equal(snap.bySkill.length, 2);
    assert.equal(snap.bySkill[0].skill, "hydra-dev");
    assert.equal(snap.bySkill[0].tokens, 500_000);
    assert.equal(snap.bySkill[0].pct, 83.33);
    assert.equal(snap.bySkill[1].skill, "hydra-qa");
    assert.equal(snap.bySkill[1].tokens, 100_000);
  });

  test("source=codex-recorded when only legacy daily-spend has data", async () => {
    const date = "2026-05-16";
    await testRedis.set(
      "hydra:scheduler:daily-spend",
      JSON.stringify({ date, usd: 4.25, updatedAt: new Date().toISOString() }),
    );

    const snap = await getDailySpendSurrogate(date);
    assert.equal(snap.source, "codex-recorded");
    assert.equal(snap.legacyRecordSpendUsd, 4.25);
    assert.equal(snap.tokens, 0);
    assert.equal(snap.costUsd, 0);
  });

  test("source=mixed when both writers contributed", async () => {
    process.env.HYDRA_TOKEN_USD_RATE = "2";
    const date = "2026-05-16";
    await recordSubagentTokens("hydra-dev", 1_000_000, { date });
    await testRedis.set(
      "hydra:scheduler:daily-spend",
      JSON.stringify({ date, usd: 0.50, updatedAt: new Date().toISOString() }),
    );

    const snap = await getDailySpendSurrogate(date);
    assert.equal(snap.source, "mixed");
    assert.equal(snap.tokens, 1_000_000);
    assert.equal(snap.costUsd, 2);
    assert.equal(snap.legacyRecordSpendUsd, 0.5);
  });

  test("legacy blob from a different date is ignored", async () => {
    const date = "2026-05-16";
    await testRedis.set(
      "hydra:scheduler:daily-spend",
      JSON.stringify({ date: "2026-05-15", usd: 99.99 }),
    );
    const snap = await getDailySpendSurrogate(date);
    assert.equal(snap.legacyRecordSpendUsd, 0);
    assert.equal(snap.source, "none");
  });
});

describe("getCycleSubagentCostUsd", () => {
  test("returns 0 when no tokens recorded for the cycle", async () => {
    const r = await getCycleSubagentCostUsd("nonexistent-cycle");
    assert.equal(r.tokens, 0);
    assert.equal(r.costUsd, 0);
  });

  test("returns tokens × rate when cycle tokens recorded", async () => {
    process.env.HYDRA_TOKEN_USD_RATE = "4";
    const cycleId = "cycle-abc";
    await recordSubagentTokens("hydra-dev", 250_000, { cycleId });
    const r = await getCycleSubagentCostUsd(cycleId);
    assert.equal(r.tokens, 250_000);
    // 250k × $4/M = $1
    assert.equal(r.costUsd, 1);
    assert.equal(r.ratePerMillion, 4);
  });

  test("empty cycleId is a no-op safe", async () => {
    const r = await getCycleSubagentCostUsd("");
    assert.equal(r.tokens, 0);
    assert.equal(r.costUsd, 0);
  });
});

describe("cost-cap integration (issue #394 acceptance: cap reads surrogate)", () => {
  test("checkCostCap sees surrogate-only cycle spend", async () => {
    process.env.HYDRA_TOKEN_USD_RATE = "100"; // aggressive rate so tests are deterministic
    process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "5";

    const cycleId = "cycle-surrogate-trip";
    // 60k tokens × $100/M = $6 — over the $5 cap.
    await recordSubagentTokens("hydra-dev", 60_000, { cycleId });

    const status = await checkCostCap(cycleId);
    assert.equal(status.exceeded, true);
    assert.equal(status.source, "autopilot-surrogate");
    assert.ok(status.surrogateUsd! >= 5);
    assert.match(status.reason, /Cost cap exceeded/);

    delete process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
    delete process.env.HYDRA_TOKEN_USD_RATE;
  });

  test("checkCostCap stays under cap when no surrogate writer has fired", async () => {
    process.env.HYDRA_PER_CYCLE_COST_CAP_USD = "5";
    const status = await checkCostCap("cycle-empty");
    assert.equal(status.exceeded, false);
    assert.equal(status.source, "none");
    assert.equal(status.costUsd, 0);
    delete process.env.HYDRA_PER_CYCLE_COST_CAP_USD;
  });

  test("getCycleCostWithSurrogateUsd labels source correctly", async () => {
    process.env.HYDRA_TOKEN_USD_RATE = "10";
    const cycleId = "cycle-mixed";
    // Surrogate contribution
    await recordSubagentTokens("hydra-dev", 100_000, { cycleId });
    // Legacy codex contribution — write directly to the cycle-costs hash
    // that getCycleCostMicrodollars reads (key shape: hydra:cycle:<id>:costs).
    await testRedis.hset(`hydra:cycle:${cycleId}:costs`, "costMicrodollars", String(2_000_000)); // $2

    const combined = await getCycleCostWithSurrogateUsd(cycleId);
    // Surrogate: 100k × $10/M = $1. Legacy: $2. Total: $3.
    assert.equal(combined.legacyUsd, 2);
    assert.equal(combined.surrogateUsd, 1);
    assert.equal(combined.costUsd, 3);
    assert.equal(combined.source, "mixed");
    delete process.env.HYDRA_TOKEN_USD_RATE;
  });
});
