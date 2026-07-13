/**
 * Regression tests for the Builder-Health Scorecard (issue #732).
 *
 * Covers:
 *   - `classifyAutonomy` — the pure, load-bearing autonomy boolean (ADR-0005
 *     closed-escalation-list grounding).
 *   - `percentile` — the pure time-to-merge percentile helper.
 *   - `getBuilderHealthScorecard` — composition under Promise.allSettled with
 *     stubbed sub-sources; the never-throws / degrade-to-null contract.
 *   - `getScopeViolationsByDay` day-key math (`utcDateKey`).
 *   - `formatBuilderHealthLines` — the digest section's always-render + empty
 *     degradation contract.
 *
 * Every source is stubbed via `deps`, so no Redis and no `gh` are required.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getBuilderHealthScorecard,
  type BuilderHealthDeps,
} from "../src/aggregators/builder-health.ts";
import { percentileInterpolated as percentile } from "../src/metrics/math.ts";
import {
  classifyAutonomy,
  type GhPrView,
} from "../src/aggregators/autonomy-classifier.ts";
import { utcDateKey } from "../src/redis/scope-violations.ts";
import { formatBuilderHealthLines } from "../src/digest.ts";
import {
  computeStagnationPanel,
  type TrendRow,
} from "../src/aggregators/builder-health-stagnation-panel.ts";

// ---------------------------------------------------------------------------
// classifyAutonomy — pure helper
// ---------------------------------------------------------------------------

describe("classifyAutonomy — pure helper", () => {
  const botMerge: GhPrView = {
    number: 1,
    mergedAt: "2026-05-30T12:00:00Z",
    mergedBy: { login: "github-actions[bot]", is_bot: true },
    labels: [{ name: "enhancement" }],
    reviews: [],
    commits: [{ authors: [{ login: "hydra-qa", is_bot: true }] }],
  };

  test("bot-merged, no escalation label, no human review/commit => autonomous", () => {
    const r = classifyAutonomy(botMerge);
    assert.equal(r.autonomous, true);
    assert.equal(r.reason, "autonomous");
  });

  test("merged by a human => non-autonomous (merged-by-human)", () => {
    const r = classifyAutonomy({ ...botMerge, mergedBy: { login: "gabe", is_bot: false } });
    assert.equal(r.autonomous, false);
    assert.equal(r.reason, "merged-by-human");
  });

  test("operator-approved label => non-autonomous", () => {
    const r = classifyAutonomy({ ...botMerge, labels: [{ name: "operator-approved" }] });
    assert.equal(r.autonomous, false);
    assert.match(r.reason, /escalation-label:operator-approved/);
  });

  test("ready-for-human label => non-autonomous", () => {
    const r = classifyAutonomy({ ...botMerge, labels: [{ name: "ready-for-human" }] });
    assert.equal(r.autonomous, false);
    assert.match(r.reason, /escalation-label:ready-for-human/);
  });

  test("human-authored review => non-autonomous", () => {
    const r = classifyAutonomy({
      ...botMerge,
      reviews: [{ author: { login: "gabe", is_bot: false } }],
    });
    assert.equal(r.autonomous, false);
    assert.equal(r.reason, "human-review");
  });

  test("human-authored commit => non-autonomous", () => {
    const r = classifyAutonomy({
      ...botMerge,
      commits: [{ authors: [{ login: "gabe", is_bot: false }] }],
    });
    assert.equal(r.autonomous, false);
    assert.equal(r.reason, "human-commit");
  });

  test("a bot review (e.g. automated rebase) is NOT intervention", () => {
    const r = classifyAutonomy({
      ...botMerge,
      reviews: [{ author: { login: "hydra-bot[bot]", is_bot: true } }],
    });
    assert.equal(r.autonomous, true);
  });

  test("[bot]-suffixed login is treated as a bot even without is_bot flag", () => {
    const r = classifyAutonomy({
      ...botMerge,
      mergedBy: { login: "dependabot[bot]" },
    });
    assert.equal(r.autonomous, true);
  });
});

// ---------------------------------------------------------------------------
// percentile — pure helper
// ---------------------------------------------------------------------------

describe("percentile — pure helper", () => {
  test("empty input => 0", () => {
    assert.equal(percentile([], 50), 0);
  });

  test("single value => that value", () => {
    assert.equal(percentile([42], 90), 42);
  });

  test("median of an even set is interpolated", () => {
    // sorted [10,20,30,40], p50 rank = 1.5 => 20 + 0.5*(30-20) = 25
    assert.equal(percentile([40, 10, 30, 20], 50), 25);
  });

  test("p90 lands near the top", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // rank = 0.9*9 = 8.1 => 9 + 0.1*(10-9) = 9.1
    assert.equal(percentile(xs, 90), 9.1);
  });

  test("ignores non-finite samples", () => {
    assert.equal(percentile([10, NaN, 20, Infinity], 50), 15);
  });
});

// ---------------------------------------------------------------------------
// utcDateKey — pure helper
// ---------------------------------------------------------------------------

describe("utcDateKey — pure helper", () => {
  test("formats a Date as UTC YYYY-MM-DD", () => {
    assert.equal(utcDateKey(new Date("2026-05-30T23:59:59Z")), "2026-05-30");
    assert.equal(utcDateKey(new Date("2026-01-05T00:00:00Z")), "2026-01-05");
  });
});

// ---------------------------------------------------------------------------
// getBuilderHealthScorecard — composition + never-throws contract
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-30T12:00:00.000Z");

function happyDeps(overrides: Partial<BuilderHealthDeps> = {}): BuilderHealthDeps {
  return {
    now: NOW,
    prWindow: 50,
    windowDays: 7,
    getCapacitySnapshot: async () =>
      ({
        orchestrator: { share: 0.4, count: 4, window: 10, floor: 0.25 },
        target: { share: 0.6, count: 6 },
        idle: { count: 2 },
        floorMet: true,
        recent: [],
      }) as any,
    getAggregateStats: async () =>
      ({ cycles: 20, regressionRate: 5, noOpMergeRate: 10 }) as any,
    getMetricsTrend: async () =>
      [
        { completedAt: "2026-05-30T10:00:00Z", mutationKillRate: 80 },
        { completedAt: "2026-05-29T10:00:00Z", mutationKillRate: 75 },
      ] as any,
    getLessonsTrend: async () => ({
      promotionRate: [{ t: "2026-05-30T00:00:00.000Z", v: 2 }],
      metaFrictionOpened: 1,
    }),
    getScopeViolationsByDay: async () => [
      { date: "2026-05-30", count: 1 },
      { date: "2026-05-29", count: 0 },
    ],
    getDesignConceptProductionCountForDate: async () => 3,
    listPrLinksSince: async () => [
      { prNumber: "100", openedAtMs: String(NOW.getTime() - 30 * 60_000) },
      { prNumber: "101", openedAtMs: String(NOW.getTime() - 90 * 60_000) },
    ],
    fetchPrView: async (pr: number) =>
      pr === 100
        ? {
            number: 100,
            mergedAt: NOW.toISOString(),
            mergedBy: { login: "github-actions[bot]", is_bot: true },
            labels: [],
            reviews: [],
            commits: [],
          }
        : {
            number: 101,
            mergedAt: NOW.toISOString(),
            mergedBy: { login: "gabe", is_bot: false },
            labels: [],
            reviews: [],
            commits: [],
          },
    ...overrides,
  };
}

describe("getBuilderHealthScorecard — composition", () => {
  test("composes every metric from stubbed sources", async () => {
    const card = await getBuilderHealthScorecard(happyDeps());

    assert.equal(card.selfImprovementShare?.share, 0.4);
    assert.equal(card.selfImprovementShare?.floorMet, true);

    assert.equal(card.reworkRate?.regressionRate, 5);
    assert.equal(card.reworkRate?.noOpMergeRate, 10);

    // 2 merged PRs: #100 autonomous, #101 human-merged => rate 0.5
    assert.equal(card.autonomyRate?.total, 2);
    assert.equal(card.autonomyRate?.autonomous, 1);
    assert.equal(card.autonomyRate?.rate, 0.5);
    const human = card.autonomyRate?.breakdown.find((d) => d.prNumber === 101);
    assert.equal(human?.autonomous, false);
    assert.equal(human?.reason, "merged-by-human");

    // time-to-merge: latencies 30m and 90m => median 60, p90 84
    assert.equal(card.timeToMerge?.samples, 2);
    assert.equal(card.timeToMerge?.medianMinutes, 60);

    // mutation trend reversed to oldest-first
    assert.equal(card.mutationKillRateTrend?.series.length, 2);
    assert.equal(card.mutationKillRateTrend?.series[0].v, 75);

    assert.equal(card.scopeViolations?.total, 1);
    assert.equal(card.scopeViolations?.windowDays, 7);

    assert.equal(card.learningThroughput?.metaFrictionOpened, 1);
    assert.equal(card.learningThroughput?.designConceptsProducedToday, 3);
  });

  test("a throwing sub-source degrades to null, never throws", async () => {
    const card = await getBuilderHealthScorecard(
      happyDeps({
        getCapacitySnapshot: async () => {
          throw new Error("redis down");
        },
      }),
    );
    assert.equal(card.selfImprovementShare, null);
    // Other metrics still computed.
    assert.equal(card.autonomyRate?.total, 2);
  });

  test("unmerged PRs are excluded from the autonomy denominator", async () => {
    const card = await getBuilderHealthScorecard(
      happyDeps({
        listPrLinksSince: async () => [
          { prNumber: "200", openedAtMs: String(NOW.getTime() - 60_000) },
        ],
        fetchPrView: async () => ({
          number: 200,
          mergedAt: null, // open PR
          mergedBy: null,
          labels: [],
          reviews: [],
          commits: [],
        }),
      }),
    );
    assert.equal(card.autonomyRate?.total, 0);
    assert.equal(card.autonomyRate?.rate, 0);
  });

  test("an unavailable PR view counts as non-autonomous-unknown", async () => {
    const card = await getBuilderHealthScorecard(
      happyDeps({
        listPrLinksSince: async () => [
          { prNumber: "300", openedAtMs: String(NOW.getTime() - 60_000) },
        ],
        fetchPrView: async () => null,
      }),
    );
    const d = card.autonomyRate?.breakdown.find((x) => x.prNumber === 300);
    assert.equal(d?.autonomous, false);
    assert.equal(d?.reason, "pr-view-unavailable");
  });

  test("exposes a per-signal per-realm stagnation panel (orch populated, target dark)", async () => {
    // 14 cycles: enough to clear the default 10-cycle cold-start baseline.
    // All merged with regressions absent so cycleYield is flat-high (ok).
    const trend: TrendRow[] = Array.from({ length: 14 }, (_, i) => ({
      completedAt: `2026-05-${String(16 + i).padStart(2, "0")}T10:00:00Z`,
      tasksAttempted: 1,
      tasksMerged: 1,
      regressionIntroduced: false,
      mutationKillRate: 80,
      anchorType: "kanban",
    }));
    const card = await getBuilderHealthScorecard(
      happyDeps({ getMetricsTrend: async () => trend as any }),
    );
    const s = card.stagnation;
    assert.ok(s, "stagnation panel present");
    // Per-realm blocks exist for each trended signal; target is dark (null),
    // orch is populated (not blended) — ADR-0028 Decision 1/2.
    for (const sig of ["cycleYield", "reworkRate", "mutationKillRate"] as const) {
      assert.equal(s!.signals[sig].target, null, `${sig} target dark`);
      assert.ok(s!.signals[sig].orch, `${sig} orch populated`);
      assert.equal(s!.signals[sig].orch!.state, "ok", `${sig} healthy => ok`);
    }
    // No composite/blended index field on the panel.
    assert.equal((s as any).index, undefined);
    assert.equal((s as any).score, undefined);
    // Window context is exposed, not adjusted out.
    assert.equal(s!.windowContext.cycles, 14);
    assert.equal(s!.windowContext.mix.feature, 14);
  });

  test("stagnation degrades to null when the trend source throws", async () => {
    const card = await getBuilderHealthScorecard(
      happyDeps({
        getMetricsTrend: async () => {
          throw new Error("redis down");
        },
      }),
    );
    assert.equal(card.stagnation, null);
    // Other metrics still computed.
    assert.equal(card.autonomyRate?.total, 2);
  });
});

// ---------------------------------------------------------------------------
// formatBuilderHealthLines — digest section
// ---------------------------------------------------------------------------

describe("formatBuilderHealthLines — digest section", () => {
  test("null scorecard => always renders the header + 'no data' line", () => {
    const lines = formatBuilderHealthLines(null);
    assert.equal(lines[0], "*Builder health:*");
    assert.match(lines[1], /No builder-health data yet/);
  });

  test("empty-but-present scorecard => 'no data' degradation", () => {
    const lines = formatBuilderHealthLines({
      generatedAt: "2026-06-20T00:00:00.000Z",
      autonomyRate: { rate: 0, autonomous: 0, total: 0, window: 50, breakdown: [] },
      timeToMerge: { medianMinutes: null, p90Minutes: null, samples: 0, window: 50 },
      reworkRate: { regressionRate: 0, noOpMergeRate: 0, window: 0 },
      selfImprovementShare: { share: 0, floor: 0.25, floorMet: true, orchestratorCount: 0, window: 0 },
      mutationKillRateTrend: null,
      scopeViolations: { series: [], total: 0, windowDays: 7 },
      learningThroughput: { promotionRate: [], metaFrictionOpened: 0, designConceptsProducedToday: 0, windowDays: 7 },
      stagnation: null,
    });
    assert.match(lines.join("\n"), /No builder-health data yet/);
  });

  test("populated scorecard renders autonomy + share + rework lines", () => {
    const lines = formatBuilderHealthLines({
      generatedAt: "2026-06-20T00:00:00.000Z",
      autonomyRate: { rate: 0.5, autonomous: 1, total: 2, window: 50, breakdown: [] },
      timeToMerge: { medianMinutes: 60, p90Minutes: 84, samples: 2, window: 50 },
      reworkRate: { regressionRate: 5, noOpMergeRate: 10, window: 20 },
      selfImprovementShare: { share: 0.4, floor: 0.25, floorMet: true, orchestratorCount: 4, window: 10 },
      mutationKillRateTrend: null,
      scopeViolations: { series: [], total: 1, windowDays: 7 },
      learningThroughput: { promotionRate: [], metaFrictionOpened: 1, designConceptsProducedToday: 3, windowDays: 7 },
      stagnation: null,
    });
    const text = lines.join("\n");
    assert.match(text, /Autonomy: 50%/);
    assert.match(text, /Time-to-merge: median 1\.0h/);
    assert.match(text, /Self-improvement share: 40%/);
    assert.match(text, /Rework: 5% regressions/);
    assert.match(text, /Scope violations: 1 in last 7d/);
    assert.match(text, /Learning: 1 meta-friction/);
  });
});

// ---------------------------------------------------------------------------
// computeStagnationPanel — pure per-realm projection (ADR-0028, #3288)
// ---------------------------------------------------------------------------

describe("computeStagnationPanel — pure per-realm projection", () => {
  // Helper: build a newest-first trend of N cycles with per-cycle overrides.
  function trend(n: number, per: (i: number) => Partial<TrendRow>): TrendRow[] {
    // Oldest-first, then reverse to newest-first (as getMetricsTrend returns).
    const rows: TrendRow[] = [];
    for (let i = 0; i < n; i++) {
      rows.push({ tasksAttempted: 1, tasksMerged: 1, ...per(i) });
    }
    return rows.reverse();
  }

  test("cold-start: below minBaselineCycles => warming, target dark", () => {
    const rows = trend(4, () => ({ mutationKillRate: 80 }));
    const panel = computeStagnationPanel(rows, { minBaselineCycles: 10 });
    assert.equal(panel.signals.mutationKillRate.orch!.state, "warming");
    assert.equal(panel.signals.mutationKillRate.target, null);
    assert.equal(panel.windowContext.cycles, 4);
  });

  test("cycleYield breach: a sustained collapse from a high self-baseline fires", () => {
    // 20 cycles merged (yield 1), then 4 cycles that did NOT merge (yield 0).
    const rows = trend(24, (i) =>
      i < 20 ? { tasksMerged: 1 } : { tasksMerged: 0 },
    );
    const panel = computeStagnationPanel(rows, {
      sustain: 3,
      minBaselineCycles: 10,
      band: { cycleYield: 0.15 },
    });
    const y = panel.signals.cycleYield.orch!;
    assert.equal(y.state, "breach");
    assert.ok(y.sustainedCycles >= 3);
    assert.equal(y.current, 0);
  });

  test("reworkRate breach: a run of regression cycles above a clean baseline fires", () => {
    // 20 clean cycles (rework 0), then 4 regression cycles (rework 1).
    const rows = trend(24, (i) =>
      i < 20 ? { regressionIntroduced: false } : { regressionIntroduced: true },
    );
    const panel = computeStagnationPanel(rows, {
      sustain: 3,
      minBaselineCycles: 10,
      band: { reworkRate: 0.15 },
    });
    assert.equal(panel.signals.reworkRate.orch!.state, "breach");
  });

  test("healthy flat series => ok on every signal, no composite emitted", () => {
    const rows = trend(20, () => ({
      tasksMerged: 1,
      regressionIntroduced: false,
      mutationKillRate: 85,
    }));
    const panel = computeStagnationPanel(rows, { minBaselineCycles: 10 });
    assert.equal(panel.signals.cycleYield.orch!.state, "ok");
    assert.equal(panel.signals.reworkRate.orch!.state, "ok");
    assert.equal(panel.signals.mutationKillRate.orch!.state, "ok");
    // No blended index/score field (ADR-0028 Decision 1).
    assert.equal((panel as any).index, undefined);
    assert.equal((panel as any).score, undefined);
  });

  test("mutation-kill-rate: cycles with no mutation run are skipped, not zeroed", () => {
    // 20 kills at 80, then 4 cycles with NO mutationKillRate field. The absent
    // cycles must be skipped (not counted as a 0 that would false-breach the
    // down-direction detector).
    const rows = trend(24, (i) =>
      i < 20 ? { mutationKillRate: 80 } : {},
    );
    const panel = computeStagnationPanel(rows, {
      sustain: 3,
      minBaselineCycles: 10,
      band: { mutationKillRate: 15 },
    });
    // Series is effectively 20 flat readings of 80 => ok, never a fabricated
    // 0-driven breach.
    assert.equal(panel.signals.mutationKillRate.orch!.state, "ok");
    assert.equal(panel.signals.mutationKillRate.orch!.current, 80);
  });

  test("window context: cleanup-vs-feature mix + anchor-type distribution", () => {
    const rows = trend(6, (i) => ({
      tasksMerged: 1,
      anchorType: i < 2 ? "prior-failure" : i < 4 ? "failing-test" : "kanban",
    }));
    const panel = computeStagnationPanel(rows, { minBaselineCycles: 1 });
    assert.equal(panel.windowContext.mix.cleanup, 4); // 2 prior-failure + 2 failing-test
    assert.equal(panel.windowContext.mix.feature, 2); // 2 kanban
    assert.equal(panel.windowContext.anchorTypes["kanban"], 2);
  });

  test("never throws on garbage rows", () => {
    const panel = computeStagnationPanel(
      [{ tasksMerged: "x" }, null, undefined, { mutationKillRate: "NaN" }] as any,
      { minBaselineCycles: 1 },
    );
    // Degrades gracefully — no throw, target dark.
    assert.equal(panel.signals.cycleYield.target, null);
  });
});
