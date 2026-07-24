/**
 * Regression tests for the per-class yield scoreboard + shadow-mode dampener
 * (`src/autopilot/class-stats.ts`, issue #2943).
 *
 * Coverage maps to the design-concept invariants for issue-2943:
 *   - Class-appropriate yield: dev classes scored on merge-rate + tokens/merge;
 *     producer classes scored on the spine β (NEVER raw merge-rate); qa/health
 *     etc. `not-scored`.
 *   - Min-sample floor: a class below ~8 in-window dispatches reports
 *     `insufficient-sample` and its dampener multiplier is forced to 1.0
 *     (null-vs-zero discipline).
 *   - Identifiability: a suspect/below-floor/absent producer β is NEVER read as
 *     a verdict — such a class stays `insufficient-sample` even above the floor.
 *   - Dampener is SOFT (≤2x, never zero) + TIME-BOXED (a re-probe deadline).
 *   - The composer degrades to an all-insufficient-sample board on a Redis-read
 *     failure (never throws).
 *
 * PURE-core tests need no Redis (the composer degradation test injects a fake
 * seam). Own top-level describe with its own lifecycle (CLAUDE.md).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  computeClassScoreboard,
  shadowDampener,
  classRole,
  CLASS_STATS_MIN_SAMPLE,
  CLASS_STATS_WINDOW_MS,
  DAMPENER_MAX_MULTIPLIER,
  DAMPENER_MIN_MULTIPLIER,
  DEV_WEAK_MERGE_RATE,
  DEV_EXPENSIVE_WEIGHTED_QUOTA_PER_MERGE,
  type ClassStat,
} from "../src/autopilot/class-stats-math.ts";
import {
  buildClassScoreboard,
  type ClassScoreboardDeps,
} from "../src/autopilot/class-stats.ts";
import type { DispatchOutcomeRecord } from "../src/redis/dispatch-outcomes.ts";
import type { AttributionEstimate } from "../src/outcome-attribution/estimator.ts";
import type { UsageSnapshot } from "../src/cost/index.ts";
import { weightedQuotaBurn } from "../src/cost/index.ts";
import { emptyByModel, EMPTY_BREAKDOWN } from "../src/cost/token-breakdown.ts";
import type { ModelFamily, TokenBreakdown } from "../src/cost/token-math.ts";
import type { WeightedQuotaInputs } from "../src/autopilot/class-stats-math.ts";
import { DISPATCH_CLASSES } from "../src/taxonomy/classes.ts";

const NOW = 1_800_000_000_000;

/**
 * A minimal fake usage snapshot carrying only the `bySkillByModel` cross-tab the
 * composer reads for the Weighted-Quota Cost Axis (issue #3548). Cast through
 * `unknown` because the composer touches ONLY `bySkillByModel` — the other ~40
 * snapshot fields are irrelevant to this seam and never read.
 */
function fakeUsage(
  bySkillByModel: Record<string, Record<ModelFamily, TokenBreakdown>> = {},
): UsageSnapshot {
  return { bySkillByModel } as unknown as UsageSnapshot;
}

/** A per-family breakdown with `total` tokens routed through `input` (cacheRead 0). */
function familyBreakdown(family: ModelFamily, total: number): Record<ModelFamily, TokenBreakdown> {
  const acc = emptyByModel();
  acc[family] = { ...EMPTY_BREAKDOWN, input: total, total };
  return acc;
}

function rec(over: Partial<DispatchOutcomeRecord> = {}): DispatchOutcomeRecord {
  return {
    cycleId: "worktree-agent-277e4476-t4-dev_orch",
    runIdPrefix: "277e4476",
    turn: 4,
    className: "dev_orch",
    skill: "hydra-dev",
    outcome: "completed",
    tokens: 50_000,
    durationMs: 60_000,
    escalationAttempt: null,
    escalatedModel: null,
    recordedAt: NOW - 3600_000,
    ...over,
  };
}

/** N records for a class, `merged` of them merged (each merge = mergeTokens). */
function batch(
  className: string,
  n: number,
  merged: number,
  mergeTokens = 50_000,
): DispatchOutcomeRecord[] {
  const out: DispatchOutcomeRecord[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      rec({
        className,
        outcome: i < merged ? "merged" : "failed",
        tokens: i < merged ? mergeTokens : 30_000,
        recordedAt: NOW - (i + 1) * 60_000,
      }),
    );
  }
  return out;
}

const EMPTY_ESTIMATE: AttributionEstimate = { metrics: [] };

function find(scoreboard: { classes: ClassStat[] }, name: string): ClassStat {
  const s = scoreboard.classes.find((c) => c.className === name);
  assert.ok(s, `scoreboard must include a row for ${name}`);
  return s;
}

describe("class-stats — class role classification (issue #2943)", () => {
  test("dev_orch / dev_target are dev role", () => {
    assert.equal(classRole("dev_orch"), "dev");
    assert.equal(classRole("dev_target"), "dev");
  });

  test("research / discover / scout / retro / cleanup are producer role", () => {
    for (const c of [
      "research_orch",
      "research_target",
      "discover_orch",
      "discover_target",
      "scout_orch",
      "retro_orch",
      "cleanup_orch",
    ]) {
      assert.equal(classRole(c), "producer", `${c} should be producer`);
    }
  });

  test("qa / health / sweep / design-concept are other role (not-scored)", () => {
    for (const c of ["qa_orch", "qa_target", "health", "sweep_orch", "design_concept_orch"]) {
      assert.equal(classRole(c), "other", `${c} should be other`);
    }
  });

  test("unknown class → other", () => {
    assert.equal(classRole("nonexistent_class"), "other");
  });
});

describe("class-stats — dev-class yield (merge-rate + tokens/merge)", () => {
  test("healthy dev class above the floor scores merge-rate + tokens/merge", () => {
    // 10 dispatches, 6 merged @ 60k tokens each.
    const records = batch("dev_orch", 10, 6, 60_000);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.role, "dev");
    assert.equal(dev.dispatches, 10);
    assert.equal(dev.mergedCount, 6);
    assert.equal(dev.mergeRate, 0.6);
    assert.equal(dev.tokensPerMerge, 60_000);
    assert.equal(dev.verdict, "healthy");
    // dev classes never carry a producer β.
    assert.equal(dev.beta, null);
    assert.equal(dev.betaSuspect, null);
  });

  test("dev class with merge-rate at/below the weak threshold is underperforming", () => {
    // 12 dispatches, 1 merged → rate ~0.083 <= DEV_WEAK_MERGE_RATE (0.1).
    const records = batch("dev_orch", 12, 1);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const dev = find(sb, "dev_orch");
    assert.ok(dev.mergeRate! <= DEV_WEAK_MERGE_RATE);
    assert.equal(dev.verdict, "underperforming");
  });

  test("dev class with zero merges has tokensPerMerge null (undefined, not 0)", () => {
    const records = batch("dev_orch", 10, 0);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.mergedCount, 0);
    assert.equal(dev.tokensPerMerge, null);
    assert.equal(dev.verdict, "underperforming");
  });
});

describe("class-stats — min-sample floor (null-vs-zero)", () => {
  test("dev class below the floor → insufficient-sample, no rate verdict", () => {
    const records = batch("dev_orch", CLASS_STATS_MIN_SAMPLE - 1, 0);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.verdict, "insufficient-sample");
    assert.equal(dev.mergeRate, null, "no rate verdict below the floor");
  });

  test("a class with zero in-window dispatches is insufficient-sample", () => {
    const sb = computeClassScoreboard([], EMPTY_ESTIMATE, { now: NOW });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.dispatches, 0);
    assert.equal(dev.verdict, "insufficient-sample");
  });

  test("records outside the window do not count toward the floor", () => {
    // 10 records, all just OUTSIDE the 7d window.
    const old = batch("dev_orch", 10, 10).map((r) => ({
      ...r,
      recordedAt: NOW - CLASS_STATS_WINDOW_MS - 1000,
    }));
    const sb = computeClassScoreboard(old, EMPTY_ESTIMATE, { now: NOW });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.dispatches, 0);
    assert.equal(dev.verdict, "insufficient-sample");
  });
});

describe("class-stats — producer-class yield (spine β, identifiability)", () => {
  function estimateFor(className: string, beta: number, flags: {
    identifiabilitySuspect?: boolean;
    belowNoiseFloor?: boolean;
  } = {}): AttributionEstimate {
    return {
      metrics: [
        {
          metric: "forecast_brier",
          intercept: 0,
          sigma0: 0.01,
          // emptyWindowCount 5 > 0, so σ0 came from the empty-window std-dev.
          sigma0Source: "empty-windows",
          observationCount: 20,
          emptyWindowCount: 5,
          effects: [
            {
              producerClass: className,
              beta,
              lowVariance: false,
              collinear: false,
              collinearWith: [],
              belowNoiseFloor: flags.belowNoiseFloor ?? false,
              // observationCount 20 − emptyWindowCount 5 = 15 non-empty windows,
              // comfortably above NOISE_FLOOR_K (2) so the minimum-observation
              // guard never forces belowNoiseFloor here — the flag stays driven
              // solely by the flags.belowNoiseFloor param the helper receives.
              nonZeroObservationCount: 15,
              identifiabilitySuspect: flags.identifiabilitySuspect ?? false,
            },
          ],
        },
      ],
    };
  }

  test("producer class with a clean positive β above the floor is healthy", () => {
    const records = batch("research_orch", 10, 0); // producers never merge
    const est = estimateFor("research_orch", 1.5);
    const sb = computeClassScoreboard(records, est, { now: NOW });
    const p = find(sb, "research_orch");
    assert.equal(p.role, "producer");
    assert.equal(p.beta, 1.5);
    assert.equal(p.betaSuspect, false);
    assert.equal(p.verdict, "healthy");
    // producer classes are NEVER scored on raw merge-rate.
    assert.equal(p.mergeRate, null);
    assert.equal(p.mergedCount, null);
  });

  test("producer class with a non-positive β is underperforming", () => {
    const records = batch("research_orch", 10, 0);
    const est = estimateFor("research_orch", -0.5);
    const sb = computeClassScoreboard(records, est, { now: NOW });
    const p = find(sb, "research_orch");
    assert.equal(p.verdict, "underperforming");
  });

  test("a suspect β is NEVER read as a verdict (invariant 8) — stays insufficient-sample", () => {
    const records = batch("research_orch", 20, 0); // well above the floor
    const est = estimateFor("research_orch", 5.0, { identifiabilitySuspect: true });
    const sb = computeClassScoreboard(records, est, { now: NOW });
    const p = find(sb, "research_orch");
    assert.equal(p.betaSuspect, true);
    assert.equal(
      p.verdict,
      "insufficient-sample",
      "a suspect β must not produce a healthy/underperforming verdict",
    );
  });

  test("a below-noise-floor β is treated as suspect (cannot tell)", () => {
    const records = batch("research_orch", 20, 0);
    const est = estimateFor("research_orch", 0.001, { belowNoiseFloor: true });
    const sb = computeClassScoreboard(records, est, { now: NOW });
    const p = find(sb, "research_orch");
    assert.equal(p.betaSuspect, true);
    assert.equal(p.verdict, "insufficient-sample");
  });

  test("a producer class with NO β column at all → suspect, insufficient-sample", () => {
    const records = batch("discover_orch", 20, 0);
    // Estimate mentions a DIFFERENT class only.
    const est = estimateFor("dev_orch", 2.0);
    const sb = computeClassScoreboard(records, est, { now: NOW });
    const p = find(sb, "discover_orch");
    assert.equal(p.beta, null);
    assert.equal(p.betaSuspect, true);
    assert.equal(p.verdict, "insufficient-sample");
  });
});

describe("class-stats — not-scored classes", () => {
  test("qa_orch above the floor is not-scored (no yield metric)", () => {
    const records = batch("qa_orch", 15, 0);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const qa = find(sb, "qa_orch");
    assert.equal(qa.role, "other");
    assert.equal(qa.verdict, "not-scored");
    assert.equal(qa.mergeRate, null);
    assert.equal(qa.beta, null);
  });
});

describe("class-stats — shadow dampener (soft, never-zero, time-boxed)", () => {
  test("underperforming class → max multiplier (2x), never zero, with a re-probe deadline", () => {
    const records = batch("dev_orch", 12, 1); // underperforming
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const plan = shadowDampener(sb);
    const v = plan.verdicts.find((x) => x.className === "dev_orch");
    assert.ok(v);
    assert.equal(v!.multiplier, DAMPENER_MAX_MULTIPLIER);
    assert.ok(v!.multiplier > 0, "dampener is NEVER zero (soft suppression)");
    assert.ok(v!.multiplier <= DAMPENER_MAX_MULTIPLIER, "bounded ceiling");
    assert.ok(v!.reprobeAt !== null, "underperforming dampener is time-boxed");
    assert.equal(v!.reprobeAt, NOW + plan.reprobeHours * 3600 * 1000);
  });

  test("healthy / insufficient-sample / not-scored → multiplier 1.0, no re-probe", () => {
    const records = [
      ...batch("dev_orch", 10, 8), // healthy
      ...batch("qa_orch", 12, 0), // not-scored
    ];
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const plan = shadowDampener(sb);
    for (const name of ["dev_orch", "qa_orch", "research_orch"]) {
      const v = plan.verdicts.find((x) => x.className === name);
      assert.ok(v, `${name} present`);
      assert.equal(v!.multiplier, DAMPENER_MIN_MULTIPLIER, `${name} multiplier 1.0`);
      assert.equal(v!.reprobeAt, null, `${name} not time-boxed`);
    }
  });

  test("every multiplier is in [MIN, MAX] and never zero", () => {
    const records = [...batch("dev_orch", 12, 1), ...batch("dev_target", 10, 9)];
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const plan = shadowDampener(sb);
    for (const v of plan.verdicts) {
      assert.ok(v.multiplier >= DAMPENER_MIN_MULTIPLIER, `${v.className} >= min`);
      assert.ok(v.multiplier <= DAMPENER_MAX_MULTIPLIER, `${v.className} <= max`);
      assert.notEqual(v.multiplier, 0, `${v.className} never zero`);
    }
  });
});

describe("class-stats — composer degrades on Redis-read failure (never throws)", () => {
  test("a failed dispatch-record read yields an all-insufficient-sample board", async () => {
    const deps: ClassScoreboardDeps = {
      listRecords: async () => ({ ok: false, error: "redis down" }),
      loadObservations: async () => ({ ok: false, error: "redis down" }),
      loadUsage: async () => fakeUsage(),
    };
    const sb = await buildClassScoreboard({ now: NOW, deps });
    assert.ok(sb.classes.length > 0, "scoreboard still lists every class");
    for (const c of sb.classes) {
      assert.equal(c.verdict, "insufficient-sample", `${c.className} degrades to insufficient-sample`);
      assert.equal(c.dispatches, 0);
    }
  });

  test("composer folds injected records + observations into a scored board", async () => {
    const deps: ClassScoreboardDeps = {
      listRecords: async () => ({ ok: true, records: batch("dev_orch", 10, 7) }),
      loadObservations: async () => ({ ok: true, observations: [] }),
      loadUsage: async () => fakeUsage(),
    };
    const sb = await buildClassScoreboard({ now: NOW, deps });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.dispatches, 10);
    assert.equal(dev.mergedCount, 7);
    assert.equal(dev.verdict, "healthy");
  });
});

// ---------------------------------------------------------------------------
// Weighted-Quota Cost Axis (issue #3548) — the pure leaf
// ---------------------------------------------------------------------------

const IDENTITY_WEIGHTS = { opus: 1, sonnet: 1, haiku: 1 };

/** Look up the taxonomy skill a dispatch class dispatches (dev_orch → hydra-dev). */
function skillFor(className: string): string {
  const row = DISPATCH_CLASSES.find((r) => r.name === className);
  assert.ok(row, `taxonomy must carry a row for ${className}`);
  return row.skill;
}

describe("class-stats — weighted-quota cost axis: pure leaf (issue #3548)", () => {
  test("undefined when the composer injects NO usage inputs (additive back-compat)", () => {
    const records = batch("dev_orch", 10, 6, 60_000);
    // No `weightedQuota` opt at all → the field is left off every row.
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.weightedQuota, undefined, "field absent when no inputs injected");
  });

  test("computes the reused weightedQuotaBurn fold for a class above the floor", () => {
    const records = batch("dev_orch", 10, 6, 60_000);
    const byModel = familyBreakdown("opus", 500_000);
    const wq: WeightedQuotaInputs = {
      byClassBreakdown: { dev_orch: byModel },
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    const dev = find(sb, "dev_orch");
    // Reconciles EXACTLY to the shipped Cost fold — one weighting definition.
    assert.equal(dev.weightedQuota, weightedQuotaBurn(byModel, 1.0, IDENTITY_WEIGHTS));
    // With cacheRead 0 + identity weights this equals the raw total.
    assert.equal(dev.weightedQuota, 500_000);
  });

  test("null (not 0) below the min-sample floor — no-data is never a computed zero", () => {
    const records = batch("dev_orch", CLASS_STATS_MIN_SAMPLE - 1, 0);
    const wq: WeightedQuotaInputs = {
      // Even WITH a breakdown present, a below-floor class reports null.
      byClassBreakdown: { dev_orch: familyBreakdown("opus", 999_999) },
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.verdict, "insufficient-sample");
    assert.equal(dev.weightedQuota, null, "below-floor → null, never a fabricated 0");
  });

  test("null when the class cleared the floor but has NO breakdown (skill burned nothing)", () => {
    const records = batch("dev_orch", 10, 6);
    const wq: WeightedQuotaInputs = {
      byClassBreakdown: {}, // dev_orch absent → no in-window tokens for its skill
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.weightedQuota, null, "absent breakdown → null, never a fabricated 0");
  });

  test("a producer with a suspect β (cleared the dispatch floor) STILL carries a cost axis", () => {
    // The cost axis is independent of the YIELD verdict: a suspect-β producer
    // reports insufficient-sample yield but has genuine cost data.
    const records = batch("research_orch", 20, 0);
    const byModel = familyBreakdown("sonnet", 120_000);
    const wq: WeightedQuotaInputs = {
      byClassBreakdown: { research_orch: byModel },
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    const p = find(sb, "research_orch");
    assert.equal(p.verdict, "insufficient-sample", "yield axis unaffected");
    assert.equal(p.weightedQuota, 120_000, "cost axis computed independently of the yield verdict");
  });

  test("cacheRead weight + non-identity burn weights compose exactly like the Cost fold", () => {
    const records = batch("dev_orch", 10, 6);
    // A breakdown with cacheRead tokens so the cacheReadWeight axis bites.
    const byModel = emptyByModel();
    byModel.opus = { ...EMPTY_BREAKDOWN, input: 10_000, cacheRead: 90_000, total: 100_000 };
    const cacheReadWeight = 0.1;
    const burnWeights = { opus: 5, sonnet: 1, haiku: 1 };
    const wq: WeightedQuotaInputs = {
      byClassBreakdown: { dev_orch: byModel },
      cacheReadWeight,
      burnWeights,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    const dev = find(sb, "dev_orch");
    // opus family weight 5 × (input 10k + 0.1×cacheRead 90k) = 5 × 19k = 95k.
    assert.equal(dev.weightedQuota, weightedQuotaBurn(byModel, cacheReadWeight, burnWeights));
    assert.equal(dev.weightedQuota, 95_000);
  });
});

// ---------------------------------------------------------------------------
// Weighted-quota-per-merge for dev classes (issue #3549) — the pure leaf
// ---------------------------------------------------------------------------

describe("class-stats — weighted-quota-per-merge for dev classes (issue #3549)", () => {
  test("derives weightedQuotaPerMerge = weightedQuota / mergedCount for a dev class", () => {
    // 10 dispatches, 6 merged; skill burned 300k weighted quota in-window.
    const records = batch("dev_orch", 10, 6, 60_000);
    const byModel = familyBreakdown("opus", 300_000);
    const wq: WeightedQuotaInputs = {
      byClassBreakdown: { dev_orch: byModel },
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.mergedCount, 6);
    assert.equal(dev.weightedQuota, 300_000);
    // 300_000 / 6 = 50_000 — the true subscription cost per shipped PR.
    assert.equal(dev.weightedQuotaPerMerge, 50_000);
    // The output-based figure is PRESERVED and UNCHANGED (raw output tokens per
    // merge = 60k), never silently repurposed into the weighted figure.
    assert.equal(dev.tokensPerMerge, 60_000);
    assert.notEqual(dev.weightedQuotaPerMerge, dev.tokensPerMerge);
  });

  test("weightedQuotaPerMerge is null (not 0) when the dev class has zero merges", () => {
    const records = batch("dev_orch", 10, 0); // above the floor, but no merges
    const wq: WeightedQuotaInputs = {
      byClassBreakdown: { dev_orch: familyBreakdown("opus", 200_000) },
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.mergedCount, 0);
    assert.equal(dev.weightedQuota, 200_000, "the cost axis itself is still present");
    assert.equal(dev.weightedQuotaPerMerge, null, "no merges → null per-merge, never 0");
    assert.equal(dev.tokensPerMerge, null, "output-based per-merge is also null with no merges");
  });

  test("weightedQuotaPerMerge is null when weightedQuota is null (below floor / no breakdown)", () => {
    // Cleared the floor with merges, but the skill burned nothing (absent
    // breakdown) → weightedQuota null → per-merge null, never a fabricated 0.
    const records = batch("dev_orch", 10, 6);
    const wq: WeightedQuotaInputs = {
      byClassBreakdown: {}, // dev_orch absent
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.weightedQuota, null);
    assert.equal(dev.weightedQuotaPerMerge, null, "null weightedQuota → null per-merge");
  });

  test("weightedQuotaPerMerge is null below the min-sample floor (null-vs-zero)", () => {
    const records = batch("dev_orch", CLASS_STATS_MIN_SAMPLE - 1, 3);
    const wq: WeightedQuotaInputs = {
      byClassBreakdown: { dev_orch: familyBreakdown("opus", 999_999) },
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.verdict, "insufficient-sample");
    assert.equal(dev.weightedQuota, null, "below-floor weightedQuota is null");
    assert.equal(dev.weightedQuotaPerMerge, null, "below-floor per-merge is null, never 0");
  });

  test("weightedQuotaPerMerge is undefined when the composer injects NO usage inputs (back-compat)", () => {
    const records = batch("dev_orch", 10, 6);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.weightedQuota, undefined, "no inputs → weightedQuota absent");
    assert.equal(dev.weightedQuotaPerMerge, undefined, "no inputs → per-merge absent too");
  });

  test("non-dev classes never carry a weighted-quota-per-merge (only dev opens PRs)", () => {
    const records = [
      ...batch("dev_orch", 10, 6),
      ...batch("research_orch", 20, 0),
    ];
    const wq: WeightedQuotaInputs = {
      byClassBreakdown: {
        dev_orch: familyBreakdown("opus", 300_000),
        research_orch: familyBreakdown("sonnet", 400_000),
      },
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    // Producer role: has a cost axis but no per-merge (null, not undefined —
    // inputs WERE injected).
    const p = find(sb, "research_orch");
    assert.equal(p.role, "producer");
    assert.equal(p.weightedQuota, 400_000);
    assert.equal(p.weightedQuotaPerMerge, null, "producer never has a per-merge cost");
    // Other role (qa) with no dispatches: null when inputs injected.
    const qa = find(sb, "qa_orch");
    assert.equal(qa.role, "other");
    assert.equal(qa.weightedQuotaPerMerge, null);
  });
});

// ---------------------------------------------------------------------------
// Weighted-quota cost verdict for dev classes (issue #3550) — a healthy merge
// rate but an extreme weighted-quota-per-merge is reported `expensive`
// (SHADOW-ONLY: reporting changes, dispatch does not).
// ---------------------------------------------------------------------------

describe("class-stats — weighted-quota cost verdict (issue #3550)", () => {
  /** Weighted-quota inputs putting `total` weighted quota on `className`. */
  function wqFor(className: string, total: number): WeightedQuotaInputs {
    return {
      byClassBreakdown: { [className]: familyBreakdown("opus", total) },
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
  }

  test("healthy merge rate + extreme weighted-quota-per-merge → expensive (not healthy)", () => {
    // 10 dispatches, 8 merged → mergeRate 0.8, comfortably healthy. But each
    // merge cost far above the ceiling: total = 8 * (ceiling + slack).
    const perMerge = DEV_EXPENSIVE_WEIGHTED_QUOTA_PER_MERGE + 1_000_000;
    const records = batch("dev_orch", 10, 8);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, {
      now: NOW,
      weightedQuota: wqFor("dev_orch", perMerge * 8),
    });
    const dev = find(sb, "dev_orch");
    assert.ok(dev.mergeRate! > DEV_WEAK_MERGE_RATE, "merge rate is healthy");
    assert.equal(dev.weightedQuotaPerMerge, perMerge);
    assert.ok(
      dev.weightedQuotaPerMerge! > DEV_EXPENSIVE_WEIGHTED_QUOTA_PER_MERGE,
      "per-merge cost is above the expensive ceiling",
    );
    assert.equal(dev.verdict, "expensive", "cost-ineffective but productive → expensive");
  });

  test("healthy merge rate + per-merge cost at/below the ceiling stays healthy", () => {
    // Exactly the ceiling is NOT expensive (strict `>` boundary).
    const perMerge = DEV_EXPENSIVE_WEIGHTED_QUOTA_PER_MERGE;
    const records = batch("dev_orch", 10, 8);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, {
      now: NOW,
      weightedQuota: wqFor("dev_orch", perMerge * 8),
    });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.weightedQuotaPerMerge, perMerge);
    assert.equal(dev.verdict, "healthy", "at the ceiling is not yet expensive");
  });

  test("weak merge rate dominates: underperforming even with extreme per-merge cost", () => {
    // 12 dispatches, 1 merged → mergeRate ~0.083 <= DEV_WEAK_MERGE_RATE, AND that
    // single merge is wildly expensive. The merge-rate signal wins — a class that
    // barely ships is `underperforming`, not `expensive`.
    const records = batch("dev_orch", 12, 1);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, {
      now: NOW,
      weightedQuota: wqFor("dev_orch", DEV_EXPENSIVE_WEIGHTED_QUOTA_PER_MERGE * 100),
    });
    const dev = find(sb, "dev_orch");
    assert.ok(dev.mergeRate! <= DEV_WEAK_MERGE_RATE);
    assert.equal(dev.verdict, "underperforming", "weak merge rate is not overridden by cost");
  });

  test("no cost verdict below the min-sample floor (null-vs-zero, AC #3)", () => {
    // Below the floor even a monstrous per-merge cost yields insufficient-sample,
    // never expensive — "not enough data" is never read as a cost verdict.
    const records = batch("dev_orch", CLASS_STATS_MIN_SAMPLE - 1, 3);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, {
      now: NOW,
      weightedQuota: wqFor("dev_orch", DEV_EXPENSIVE_WEIGHTED_QUOTA_PER_MERGE * 100),
    });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.verdict, "insufficient-sample");
    assert.equal(dev.weightedQuota, null, "below floor → null weightedQuota");
    assert.equal(dev.weightedQuotaPerMerge, null, "below floor → null per-merge");
  });

  test("no cost verdict when weightedQuotaPerMerge is null (no breakdown injected)", () => {
    // Cleared the floor with a healthy merge rate, but the class has no per-family
    // breakdown → weightedQuotaPerMerge is null → stays healthy, never expensive.
    const records = batch("dev_orch", 10, 8);
    const wq: WeightedQuotaInputs = {
      byClassBreakdown: {}, // dev_orch absent
      cacheReadWeight: 1.0,
      burnWeights: IDENTITY_WEIGHTS,
    };
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW, weightedQuota: wq });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.weightedQuotaPerMerge, null);
    assert.equal(dev.verdict, "healthy", "null per-merge cost → no cost verdict");
  });

  test("no cost verdict when the composer injects no usage inputs (undefined per-merge)", () => {
    // No weightedQuota opt at all → weightedQuotaPerMerge undefined → healthy.
    const records = batch("dev_orch", 10, 8);
    const sb = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.weightedQuotaPerMerge, undefined);
    assert.equal(dev.verdict, "healthy", "no usage inputs → no cost verdict, stays healthy");
  });

  test("producer β verdict is never overridden by its (reported) weighted quota", () => {
    // A producer class carries a weightedQuota figure for reporting, but its
    // verdict is decided ONLY by β — an expensive producer is never re-verdicted.
    const beta = 0.5; // positive, identifiable → healthy on β
    const estimate: AttributionEstimate = {
      metrics: [
        {
          metric: "forecast_brier",
          intercept: 0,
          sigma0: 0.01,
          sigma0Source: "empty-windows",
          observationCount: 20,
          emptyWindowCount: 5,
          effects: [
            {
              producerClass: "research_orch",
              beta,
              lowVariance: false,
              collinear: false,
              collinearWith: [],
              belowNoiseFloor: false,
              nonZeroObservationCount: 15,
              identifiabilitySuspect: false,
            },
          ],
        },
      ],
    };
    const records = batch("research_orch", 20, 0);
    const sb = computeClassScoreboard(records, estimate, {
      now: NOW,
      // Enormous producer weighted quota — must NOT touch the β verdict.
      weightedQuota: wqFor("research_orch", DEV_EXPENSIVE_WEIGHTED_QUOTA_PER_MERGE * 100),
    });
    const p = find(sb, "research_orch");
    assert.equal(p.role, "producer");
    assert.equal(p.beta, beta, "β is reported and scored");
    assert.equal(p.verdict, "healthy", "producer scored on β, not weighted quota");
    assert.equal(p.weightedQuotaPerMerge, null, "producer has no per-merge figure");
    assert.ok(p.weightedQuota! > 0, "the weighted-quota figure is still reported alongside β");
  });
});

// ---------------------------------------------------------------------------
// #3550 shadow invariant: introducing the `expensive` verdict must NOT change
// what the dampener actuates — the dampener plan is byte-identical to the
// baseline where the same class would have been plain `healthy` (#2943 invariant).
// ---------------------------------------------------------------------------

describe("class-stats — expensive verdict actuates nothing (#3550 byte-identical)", () => {
  test("an expensive class's dampener multiplier == the healthy baseline's (1.0)", () => {
    // Same dispatch/merge shape, differing ONLY in per-merge cost: one lands
    // `expensive`, the other `healthy`. Their shadow dampener verdicts must be
    // byte-identical (both 1.0, both reprobeAt null) — the cost verdict changes
    // reporting, not dispatch.
    const shape = () => batch("dev_orch", 10, 8);

    const expensiveSb = computeClassScoreboard(shape(), EMPTY_ESTIMATE, {
      now: NOW,
      weightedQuota: {
        byClassBreakdown: {
          dev_orch: familyBreakdown("opus", (DEV_EXPENSIVE_WEIGHTED_QUOTA_PER_MERGE + 1_000_000) * 8),
        },
        cacheReadWeight: 1.0,
        burnWeights: IDENTITY_WEIGHTS,
      },
    });
    const cheapSb = computeClassScoreboard(shape(), EMPTY_ESTIMATE, {
      now: NOW,
      weightedQuota: {
        byClassBreakdown: { dev_orch: familyBreakdown("opus", 8_000) }, // 1k/merge, cheap
        cacheReadWeight: 1.0,
        burnWeights: IDENTITY_WEIGHTS,
      },
    });

    assert.equal(find(expensiveSb, "dev_orch").verdict, "expensive");
    assert.equal(find(cheapSb, "dev_orch").verdict, "healthy");

    const expensivePlan = shadowDampener(expensiveSb);
    const cheapPlan = shadowDampener(cheapSb);
    const expensiveV = expensivePlan.verdicts.find((v) => v.className === "dev_orch")!;
    const cheapV = cheapPlan.verdicts.find((v) => v.className === "dev_orch")!;

    // The actuated fields (multiplier + reprobe) are byte-identical to healthy.
    assert.equal(expensiveV.multiplier, cheapV.multiplier);
    assert.equal(expensiveV.multiplier, DAMPENER_MIN_MULTIPLIER, "expensive → 1.0, never dampens");
    assert.equal(expensiveV.reprobeAt, cheapV.reprobeAt);
    assert.equal(expensiveV.reprobeAt, null, "expensive is not time-boxed (nothing to lift)");
    // The verdict LABEL differs (that is the whole reporting change), but the
    // dispatch-affecting multiplier does not.
    assert.notEqual(expensiveV.verdict, cheapV.verdict);
  });

  test("the whole dampener plan multipliers are unchanged vs a cost-blind baseline", () => {
    // Build a mixed board (dev expensive + dev underperforming + producer +
    // other), then a cost-blind baseline (no weightedQuota inputs, so no dev goes
    // `expensive`). Every class's multiplier must match between the two plans:
    // the only class whose VERDICT differs is the expensive dev, and its
    // multiplier is 1.0 in BOTH (healthy baseline vs expensive) — so multipliers
    // are byte-identical across the whole plan.
    const records = [
      ...batch("dev_orch", 10, 8), // healthy rate → expensive when costed
      ...batch("dev_target", 12, 1), // weak rate → underperforming (cost-independent)
      ...batch("research_orch", 20, 0),
    ];
    const withCost = computeClassScoreboard(records, EMPTY_ESTIMATE, {
      now: NOW,
      weightedQuota: {
        byClassBreakdown: {
          dev_orch: familyBreakdown("opus", (DEV_EXPENSIVE_WEIGHTED_QUOTA_PER_MERGE + 1_000_000) * 8),
        },
        cacheReadWeight: 1.0,
        burnWeights: IDENTITY_WEIGHTS,
      },
    });
    const costBlind = computeClassScoreboard(records, EMPTY_ESTIMATE, { now: NOW });

    // Confirm the expensive verdict actually appeared in the costed board.
    assert.equal(find(withCost, "dev_orch").verdict, "expensive");
    assert.equal(find(costBlind, "dev_orch").verdict, "healthy");

    const costedPlan = shadowDampener(withCost);
    const baselinePlan = shadowDampener(costBlind);
    const costedByName = new Map(costedPlan.verdicts.map((v) => [v.className, v.multiplier]));
    for (const bv of baselinePlan.verdicts) {
      assert.equal(
        costedByName.get(bv.className),
        bv.multiplier,
        `multiplier for ${bv.className} must be identical with/without cost inputs`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Weighted-Quota Cost Axis (issue #3548) — the composer (className→skill join)
// ---------------------------------------------------------------------------

describe("class-stats — weighted-quota cost axis: composer (issue #3548)", () => {
  test("maps className→skill via the taxonomy and attributes the skill's burn", async () => {
    const devSkill = skillFor("dev_orch");
    const deps: ClassScoreboardDeps = {
      listRecords: async () => ({ ok: true, records: batch("dev_orch", 10, 7) }),
      loadObservations: async () => ({ ok: true, observations: [] }),
      // The usage snapshot keys by SKILL; the composer must re-key by class name.
      loadUsage: async () => fakeUsage({ [devSkill]: familyBreakdown("opus", 300_000) }),
    };
    const sb = await buildClassScoreboard({ now: NOW, deps });
    const dev = find(sb, "dev_orch");
    // In the test env HYDRA_QUOTA_WEIGHT_* are unset (identity weights) and
    // HYDRA_USAGE_CACHE_READ_WEIGHT defaults to 1.0, so this reduces to the raw
    // total — the same numbers /api/usage would report (one calibration surface).
    assert.equal(dev.weightedQuota, 300_000);
  });

  test("a class whose skill produced no in-window tokens gets weightedQuota null", async () => {
    const deps: ClassScoreboardDeps = {
      listRecords: async () => ({ ok: true, records: batch("dev_orch", 10, 7) }),
      loadObservations: async () => ({ ok: true, observations: [] }),
      loadUsage: async () => fakeUsage({}), // no skill produced tokens
    };
    const sb = await buildClassScoreboard({ now: NOW, deps });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.weightedQuota, null);
  });

  test("a usage-read failure degrades weightedQuota to null on EVERY class, yield preserved", async () => {
    const deps: ClassScoreboardDeps = {
      listRecords: async () => ({ ok: true, records: batch("dev_orch", 10, 8) }),
      loadObservations: async () => ({ ok: true, observations: [] }),
      loadUsage: async () => {
        throw new Error("usage snapshot unavailable");
      },
    };
    const sb = await buildClassScoreboard({ now: NOW, deps });
    const dev = find(sb, "dev_orch");
    // Yield axis untouched by the cost-read failure.
    assert.equal(dev.verdict, "healthy");
    // Cost axis degrades to null on every class (never throws, never fabricates).
    for (const c of sb.classes) {
      assert.equal(c.weightedQuota, null, `${c.className} weightedQuota degrades to null`);
    }
  });
});
