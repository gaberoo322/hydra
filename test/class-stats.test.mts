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
  buildClassScoreboard,
  classRole,
  CLASS_STATS_MIN_SAMPLE,
  CLASS_STATS_WINDOW_MS,
  DAMPENER_MAX_MULTIPLIER,
  DAMPENER_MIN_MULTIPLIER,
  DEV_WEAK_MERGE_RATE,
  type ClassStat,
  type ClassScoreboardDeps,
} from "../src/autopilot/class-stats.ts";
import type { DispatchOutcomeRecord } from "../src/redis/dispatch-outcomes.ts";
import type { AttributionEstimate } from "../src/outcome-attribution/estimator.ts";

const NOW = 1_800_000_000_000;

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
    };
    const sb = await buildClassScoreboard({ now: NOW, deps });
    const dev = find(sb, "dev_orch");
    assert.equal(dev.dispatches, 10);
    assert.equal(dev.mergedCount, 7);
    assert.equal(dev.verdict, "healthy");
  });
});
