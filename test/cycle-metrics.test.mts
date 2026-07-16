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
  "../src/metrics/stats-projection.ts"
);
const { tokensByCycleKey } = await import("../src/redis/cost.ts");
const { CycleRecordBodySchema } = await import("../src/autopilot/schemas.ts");

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

describe("projectTokensPerMergedPR outlier guard (issue #3201)", () => {  test("outlier guard: excludes records >10x median, protecting average from M-scale legacy records (issue #3201)", () => {
    // Real scenario: 14 clean records (~64-101k tokens) + 3 legacy M-scale records.
    // Median of attributed set ≈ ~84k → threshold ≈ 840k → 42M/63M/12M all exceed it.
    const clean = [
      { tasksMerged: 1, tokenCost: 101287 },
      { tasksMerged: 1, tokenCost: 84289 },
      { tasksMerged: 1, tokenCost: 72463 },
      { tasksMerged: 1, tokenCost: 65000 },
      { tasksMerged: 1, tokenCost: 60000 },
    ];
    const outliers = [
      { tasksMerged: 1, tokenCost: 42_000_000 }, // legacy-iso-task
      { tasksMerged: 1, tokenCost: 63_120_000 }, // betting-build-1591
      { tasksMerged: 1, tokenCost: 12_880_000 }, // task-B
    ];
    const trend = [...clean, ...outliers];
    const result = projectTokensPerMergedPR(trend);
    // Clean average ≈ (101287+84289+72463+65000+60000)/5 = 76608
    // With 3 outliers the naïve average would be ~(76608*5 + 118000000) / 8 = ~14.8M
    assert.ok(result !== null);
    assert.ok(result! < 200_000, `tokensPerMergedPR ${result} should be under 200k (outliers excluded)`);
    assert.ok(result! > 50_000, `tokensPerMergedPR ${result} should be over 50k (realistic clean average)`);
  });

  test("outlier guard: single M-scale record in a 1-record trend falls back to full set (no null)", () => {
    // When every record is an outlier, return all of them rather than null.
    const trend = [{ tasksMerged: 1, tokenCost: 50_000_000 }];
    assert.strictEqual(projectTokensPerMergedPR(trend), 50_000_000);
  });

  test("outlier guard: does not drop legitimate high-cost cycles that are within 10x of median", () => {
    // If median is 100k and one cycle costs 900k (9× median), it must stay in.
    const trend = [
      { tasksMerged: 1, tokenCost: 100_000 },
      { tasksMerged: 1, tokenCost: 100_000 },
      { tasksMerged: 1, tokenCost: 900_000 }, // 9× median, within threshold
    ];
    // Should include all three: (100000 + 100000 + 900000) / 3 = 366667
    assert.strictEqual(projectTokensPerMergedPR(trend), 366667);
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

/**
 * Cycle-coordination span instrumentation (issue #3338).
 *
 * Three cycle-COORDINATION spans — decisionLatencyMs (cycle-start → anchor-select),
 * executionLatencyMs (anchor-select → merge-ready), mergeLatencyMs (merge-ready →
 * cycle-complete) — partition a cycle's wall-clock into the autopilot orchestration
 * phases, so a slow cycle can be attributed to dispatch decision-making vs executor
 * work vs merge-wait. They are plumbed through the same schema-before-writer groove
 * as the #3269 per-dispatch phase spans: recorded as NUMERIC + MONOTONIC fields on
 * the cycle-metrics hash, parsed back by getMetricsTrend, and forwarded through
 * CycleRecordBodySchema → recordCycle.
 *
 * These tests pin: (1) the spans round-trip through the metrics hash and surface as
 * numbers in the trend; (2) they are MONOTONIC — a later 0-carrying write can neither
 * clobber a stored non-zero span nor block a real span from upgrading a stored 0;
 * (3) an absent span stays absent (never a fabricated 0 on the hash); (4) the schema
 * accepts both number and string forms and strips absent fields.
 *
 * Own top-level describe with its own before/after lifecycle so it never piggybacks
 * on a sibling suite's shared-Redis teardown (CLAUDE.md authoring rule).
 */
describe("cycle-coordination span instrumentation (issue #3338)", () => {
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

  test("the three coordination spans round-trip through the metrics hash", async () => {
    const cycleId = "cycle-3338-round-trip";
    await recordCycleMetrics(cycleId, {
      tasksMerged: 1,
      decisionLatencyMs: 1200,
      executionLatencyMs: 45000,
      mergeLatencyMs: 8000,
    });
    const stored = await getCycleMetrics(cycleId);
    assert.strictEqual(stored.decisionLatencyMs, "1200");
    assert.strictEqual(stored.executionLatencyMs, "45000");
    assert.strictEqual(stored.mergeLatencyMs, "8000");
  });

  test("the coordination spans surface as NUMBERS in the metrics trend", async () => {
    const cycleId = "cycle-3338-trend-numeric";
    await recordCycleMetrics(cycleId, {
      tasksMerged: 1,
      decisionLatencyMs: 1200,
      executionLatencyMs: 45000,
      mergeLatencyMs: 8000,
    });
    const trend = await getMetricsTrend(1);
    assert.equal(trend.length, 1, "expected the one recorded cycle");
    assert.strictEqual(trend[0].decisionLatencyMs, 1200);
    assert.strictEqual(trend[0].executionLatencyMs, 45000);
    assert.strictEqual(trend[0].mergeLatencyMs, 8000);
  });

  test("a coordination span is MONOTONIC-max: a 0-carrying follow-up never clobbers a stored non-zero span", async () => {
    const cycleId = "cycle-3338-monotonic-no-clobber";
    // First write records a real merge-wait span (the reap `completed` write).
    await recordCycleMetrics(cycleId, { mergeLatencyMs: 8000 });
    // The post-merge follow-up write carries 0 (no start stamp available) — it
    // must NOT clobber the real span, mirroring the #2364/#3269 monotonic guard.
    await recordCycleMetrics(cycleId, { mergeLatencyMs: 0, tasksMerged: 1 });
    const stored = await getCycleMetrics(cycleId);
    assert.strictEqual(
      stored.mergeLatencyMs,
      "8000",
      "a 0 follow-up must never clobber a stored non-zero coordination span",
    );
  });

  test("a coordination span is MONOTONIC-max: a real span UPGRADES a stored 0/absent", async () => {
    const cycleId = "cycle-3338-monotonic-upgrade";
    // First write lands 0 (the truthful "unknown" sentinel for this write).
    await recordCycleMetrics(cycleId, { decisionLatencyMs: 0 });
    // A later write carries the real span — it must upgrade the stored 0.
    await recordCycleMetrics(cycleId, { decisionLatencyMs: 1500, tasksMerged: 1 });
    const stored = await getCycleMetrics(cycleId);
    assert.strictEqual(
      stored.decisionLatencyMs,
      "1500",
      "a real coordination span must upgrade a stored 0/absent",
    );
  });

  test("an absent coordination span stays absent on the hash (never a fabricated 0)", async () => {
    const cycleId = "cycle-3338-absent";
    await recordCycleMetrics(cycleId, { tasksMerged: 1 });
    const stored = await getCycleMetrics(cycleId);
    assert.ok(
      !("decisionLatencyMs" in stored),
      "an unmeasured coordination span must stay absent, not persist as 0",
    );
    assert.ok(!("executionLatencyMs" in stored));
    assert.ok(!("mergeLatencyMs" in stored));
  });

  test("CycleRecordBodySchema accepts the coordination spans in number AND string form", () => {
    const numeric = CycleRecordBodySchema.safeParse({
      cycleId: "cycle-3338-schema-num",
      decisionLatencyMs: 1200,
      executionLatencyMs: 45000,
      mergeLatencyMs: 8000,
    });
    assert.ok(numeric.success, "numeric spans must pass the schema");

    const stringForm = CycleRecordBodySchema.safeParse({
      cycleId: "cycle-3338-schema-str",
      decisionLatencyMs: "1200",
      executionLatencyMs: "45000",
      mergeLatencyMs: "8000",
    });
    assert.ok(stringForm.success, "string-form spans (loose-payload) must pass the schema");
  });

  test("a genuinely-measured 0-span cycle records 0 (distinct from absent)", async () => {
    const cycleId = "cycle-3338-real-zero";
    // A cycle whose merge landed instantly records a truthful 0 merge-wait.
    await recordCycleMetrics(cycleId, { mergeLatencyMs: 0, tasksMerged: 1 });
    const stored = await getCycleMetrics(cycleId);
    assert.strictEqual(
      stored.mergeLatencyMs,
      "0",
      "a genuinely-measured 0-span records 0 — distinct from the absent sentinel",
    );
  });
});
