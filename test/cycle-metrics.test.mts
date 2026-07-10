/**
 * Per-cycle token join into the metrics trend (issue #2930).
 *
 * tokens-per-merged-PR is the sanctioned cost-per-merge fitness metric under the
 * token plane (ADR-0016 / Quota-Weighted Burn) — cost in TOKENS, never dollars
 * (costUsd is retired, #1651/#704). Per-cycle token totals are recorded to a
 * SEPARATE Redis key (`hydra:metrics:tokens:by-cycle:<id>`, via
 * recordSubagentTokens) that the cycle-metrics trend never joined, so the
 * declared-but-unwritten `tokenCost` field always read undefined/null.
 *
 * These tests pin the read-time join `getMetricsTrend` now performs through the
 * `getCycleTokensRaw` accessor (Redis seam preserved): a cycle with a recorded
 * token key exposes a numeric `tokenCost`; a cycle without one reads `null`
 * (truthful unattributed sentinel — NEVER a fabricated 0). They also pin the
 * pure `parseCycleTokenTotal` parse and the `projectTokensPerMergedPR`
 * arithmetic.
 *
 * Own top-level describe blocks with their own before/after lifecycle so they
 * never piggyback on a sibling suite's shared-Redis teardown (CLAUDE.md
 * authoring rule).
 */

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";

process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379/1";

const { recordCycleMetrics } = await import("../src/metrics/record.ts");
const { getMetricsTrend, parseCycleTokenTotal } = await import(
  "../src/metrics/trend.ts"
);
const { projectTokensPerMergedPR, projectAggregateStats } = await import(
  "../src/metrics/aggregate.ts"
);
const { tokensByCycleKey } = await import("../src/redis/cost.ts");

describe("per-cycle token join into the trend (issue #2930)", () => {
  let redis: any;

  async function cleanKeys() {
    const keys = await redis.keys("hydra:metrics:*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.del("hydra:metrics:index");
  }

  // Seed the per-cycle token key exactly as recordSubagentTokens persists it:
  // a hash at `hydra:metrics:tokens:by-cycle:<id>` with a numeric `tokens`
  // field (read through the tokensByCycleKey seam accessor).
  async function seedTokenKey(cycleId: string, tokens: string) {
    await redis.hset(tokensByCycleKey(cycleId), "tokens", tokens);
  }

  beforeEach(async () => {
    if (!redis) redis = new Redis(process.env.REDIS_URL);
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  test("a cycle WITH a recorded token key exposes a numeric tokenCost", async () => {
    const cycleId = "cycle-2930-has-tokens";
    await recordCycleMetrics(cycleId, { tasksMerged: 1 });
    await seedTokenKey(cycleId, "4200");

    const trend = await getMetricsTrend(1);
    assert.equal(trend.length, 1, "expected the one recorded cycle");
    assert.strictEqual(
      trend[0].tokenCost,
      4200,
      "tokenCost must be joined from the per-cycle token key as a number",
    );
  });

  test("a cycle WITHOUT a token key reads tokenCost null, not 0", async () => {
    const cycleId = "cycle-2930-no-tokens";
    await recordCycleMetrics(cycleId, { tasksMerged: 1 });
    // Intentionally seed NO token key.

    const trend = await getMetricsTrend(1);
    assert.strictEqual(
      trend[0].tokenCost,
      null,
      "an unrecorded per-cycle token total must be the null unattributed sentinel, never a fabricated 0",
    );
  });

  test("a stored per-cycle total of literally 0 passes through as 0 (a real recorded zero)", async () => {
    const cycleId = "cycle-2930-zero-tokens";
    await recordCycleMetrics(cycleId, { tasksMerged: 1 });
    await seedTokenKey(cycleId, "0");

    const trend = await getMetricsTrend(1);
    assert.strictEqual(
      trend[0].tokenCost,
      0,
      "a genuinely recorded 0-token cycle stays 0 — distinct from the null-absent sentinel",
    );
  });

  test("no USD field is introduced by the join", async () => {
    const cycleId = "cycle-2930-no-usd";
    await recordCycleMetrics(cycleId, { tasksMerged: 1 });
    await seedTokenKey(cycleId, "500");

    const trend = await getMetricsTrend(1);
    assert.ok(
      !("costUsd" in trend[0]),
      "the join must not reintroduce a costUsd column (ADR-0016 / #1651 / #704)",
    );
  });
});

describe("parseCycleTokenTotal pure parse (issue #2930)", () => {
  test("parses a numeric string to a number", () => {
    assert.strictEqual(parseCycleTokenTotal("4200"), 4200);
    assert.strictEqual(parseCycleTokenTotal("  4200  "), 4200);
    assert.strictEqual(parseCycleTokenTotal("0"), 0);
  });

  test("returns null for absent / empty / non-numeric / non-string input", () => {
    assert.strictEqual(parseCycleTokenTotal(null), null);
    assert.strictEqual(parseCycleTokenTotal(undefined), null);
    assert.strictEqual(parseCycleTokenTotal(""), null);
    assert.strictEqual(parseCycleTokenTotal("   "), null);
    assert.strictEqual(parseCycleTokenTotal("abc"), null);
    assert.strictEqual(parseCycleTokenTotal(4200 as unknown), null);
  });
});

describe("projectTokensPerMergedPR pure arithmetic (issue #2930)", () => {
  test("averages tokenCost over merged cycles that carry a token record", () => {
    const trend = [
      { tasksMerged: 1, tokenCost: 1000 },
      { tasksMerged: 2, tokenCost: 3000 },
    ];
    // (1000 + 3000) / 2 = 2000
    assert.strictEqual(projectTokensPerMergedPR(trend), 2000);
  });

  test("excludes merged cycles whose tokenCost is null (unattributed), never counts them as 0", () => {
    const trend = [
      { tasksMerged: 1, tokenCost: 1000 },
      { tasksMerged: 1, tokenCost: null }, // unattributed — excluded entirely
    ];
    // Only the attributed cycle contributes: 1000 / 1 = 1000 (NOT 500).
    assert.strictEqual(projectTokensPerMergedPR(trend), 1000);
  });

  test("excludes non-merged cycles even when they carry a token record", () => {
    const trend = [
      { tasksMerged: 0, tokenCost: 9999 }, // not merged — excluded
      { tasksMerged: 1, tokenCost: 800 },
    ];
    assert.strictEqual(projectTokensPerMergedPR(trend), 800);
  });

  test("returns null (not 0) when no merged cycle carries a token record", () => {
    const trend = [
      { tasksMerged: 1, tokenCost: null },
      { tasksMerged: 0, tokenCost: 500 },
    ];
    assert.strictEqual(
      projectTokensPerMergedPR(trend),
      null,
      "unattributed must stay distinct from 0 tokens-per-merge",
    );
  });

  test("returns null on an empty trend", () => {
    assert.strictEqual(projectTokensPerMergedPR([]), null);
  });

  test("projectAggregateStats surfaces tokensPerMergedPR from the trend", () => {
    const stats = projectAggregateStats([
      { tasksMerged: 1, tokenCost: 2000 },
      { tasksMerged: 1, tokenCost: 4000 },
    ]);
    assert.strictEqual((stats as any).tokensPerMergedPR, 3000);
  });
});

/**
 * Default dispatch source (issue #3070).
 *
 * `recordCycleMetrics` defaults a source-less write to "claude", NEVER "codex".
 * Codex was removed with ADR-0006, so the old "codex" default silently
 * mis-attributed every source-less write (the dedup/enrichment path in
 * cycle-close.ts, and any direct recordCycleMetrics caller) to a dead provider —
 * and those codex-sourced rows were the ones carrying the "unclassified"/"unknown"
 * anchorType buckets in /api/metrics. This suite pins the "claude" default so the
 * retired provider can never re-appear in a fresh write.
 *
 * Own top-level describe with its own before/after lifecycle so it never
 * piggybacks on a sibling suite's shared-Redis teardown (CLAUDE.md authoring rule).
 */
describe("default dispatch source is 'claude', never 'codex' (issue #3070)", () => {
  let redis: any;
  let getCycleMetrics: (cycleId: string) => Promise<Record<string, string>>;

  async function cleanKeys() {
    const keys = await redis.keys("hydra:metrics:*");
    if (keys.length > 0) await redis.del(...keys);
    await redis.del("hydra:metrics:index");
  }

  beforeEach(async () => {
    if (!redis) redis = new Redis(process.env.REDIS_URL);
    if (!getCycleMetrics) {
      ({ getCycleMetrics } = await import("../src/redis/cycle-metrics.ts"));
    }
    await cleanKeys();
  });

  after(async () => {
    await cleanKeys();
    if (redis) redis.disconnect();
  });

  test("a source-less write defaults to 'claude'", async () => {
    const cycleId = "cycle-3070-no-source";
    await recordCycleMetrics(cycleId, { tasksMerged: 1, anchorType: "work-queue" });
    const stored = await getCycleMetrics(cycleId);
    assert.strictEqual(stored.source, "claude");
  });

  test("the enrichment-shaped write (no source, no anchorType) still defaults to 'claude', never 'codex'", async () => {
    // Mirrors cycle-close.ts's dedup/enrichment path: recordCycleMetrics is
    // called with only counters/filesChanged and no source. When this lands as
    // the first HSET for a cycleId, the prior code minted source:"codex".
    const cycleId = "cycle-3070-enrichment-first-write";
    await recordCycleMetrics(cycleId, { tasksMerged: 1 });
    const stored = await getCycleMetrics(cycleId);
    assert.strictEqual(stored.source, "claude");
    assert.notStrictEqual(stored.source, "codex");
  });

  test("an explicit source is preserved (the default only fills an ABSENT source)", async () => {
    const cycleId = "cycle-3070-explicit-source";
    await recordCycleMetrics(cycleId, { tasksMerged: 1, source: "work-queue" });
    const stored = await getCycleMetrics(cycleId);
    assert.strictEqual(stored.source, "work-queue");
  });
});
