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
import {
  foldFirstPassQaYield,
  foldParentExceptions,
  foldParkRate,
  loadBuilderHealthBaselines,
  summarizeBaselineRows,
  filterMirrorRuns,
  ledgerToRunTurns,
  baselineRowFor,
  mergeBaselineRow,
  computeParentExceptionRate,
  type LifecycleHealthDeps,
} from "../src/aggregators/lifecycle-health.ts";
import { parseTurnRows } from "../src/autopilot/turn-row.ts";
import { capEventRecord, type LifecycleJournalEntry } from "../src/redis/lifecycle-journal.ts";
import { percentileInterpolated as percentile } from "../src/metrics/math.ts";
import {
  classifyAutonomy,
  type GhPrView,
} from "../src/aggregators/autonomy-classifier.ts";
import { utcDateKey } from "../src/redis/scope-violations.ts";
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

/**
 * Capture the pino structured-log lines (module singleton → process.stderr,
 * ADR-0027) emitted while `fn` runs, so a test can assert the shared
 * settled-fold's fail-loud `label` fields — the same seam
 * `aggregator-settle.test.mts` pins. Async because the scorecard read is.
 */
async function withCapturedStderr(
  fn: () => Promise<unknown>,
): Promise<Array<Record<string, any>>> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as any).write = (chunk: any) => {
    buf += String(chunk);
    return true;
  };
  try {
    await fn();
    return buf
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, any>);
  } finally {
    (process.stderr as any).write = originalWrite;
  }
}

const NO_FILE = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

/** Stubs for the three ADR-0047 D9 readers: no Redis, no gh, no baselines file. */
function lifecycleStubs(over: LifecycleHealthDeps = {}): LifecycleHealthDeps {
  return {
    readFile: async () => {
      throw NO_FILE;
    },
    readRunTurns: async () => [],
    readQaVerdictComments: async () => ({ ok: true, comments: [] }),
    readCapEvents: async () => ({ ok: true, events: [] }),
    readMode: async () => "shadow",
    ...over,
  };
}

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
        floorStatus: "met",
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
    lifecycleHealth: lifecycleStubs(),
    ...overrides,
  };
}

describe("getBuilderHealthScorecard — composition", () => {
  test("composes every metric from stubbed sources", async () => {
    const card = await getBuilderHealthScorecard(happyDeps());

    assert.equal(card.selfImprovementShare?.share, 0.4);
    assert.equal(card.selfImprovementShare?.floorStatus, "met");
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

  test("unmeasured floor passes through: floorStatus unmeasured, floorMet null, every field kept (#4298)", async () => {
    // The issue's evidence payload: 99 merges, window 0 — the vacuous green.
    const card = await getBuilderHealthScorecard(
      happyDeps({
        getCapacitySnapshot: async () =>
          ({
            orchestrator: { share: 0, count: 0, window: 0, floor: 0.25 },
            target: { share: 0, count: 0 },
            idle: { count: 7 },
            floorStatus: "unmeasured",
            floorMet: null,
            recent: [],
          }) as any,
      }),
    );
    // The tri-state is passed through, not re-derived here.
    assert.equal(card.selfImprovementShare?.floorStatus, "unmeasured");
    assert.equal(card.selfImprovementShare?.floorMet, null);
    // INV-6 additive contract: every pre-existing field survives.
    assert.equal(card.selfImprovementShare?.share, 0);
    assert.equal(card.selfImprovementShare?.floor, 0.25);
    assert.equal(card.selfImprovementShare?.orchestratorCount, 0);
    assert.equal(card.selfImprovementShare?.window, 0);
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
      tasksMerged: 1, status: "merged",
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

  // Inner sub-reads of computeLearningThroughput degrade via the shared
  // settled-fold (issue #4403): the outer settledOrNull(learningResult, …)
  // fan-out only sees a rejection if the metric ITSELF throws, so these pin
  // the two inner sites where each sub-read degrades independently. Nested
  // inside this describe on purpose — keeps the file's top-level count at 6
  // (suite-count baseline) and shares no Redis lifecycle.
  test("learning-throughput readers throw => zero slots, never null", async () => {
    const card = await getBuilderHealthScorecard(
      happyDeps({
        getLessonsTrend: async () => {
          throw new Error("redis down");
        },
        getDesignConceptProductionCountForDate: async () => {
          throw new Error("redis down");
        },
      }),
    );
    // Not null — the whole metric degrades to its zero-slot object because
    // each inner sub-read folds to its own fallback.
    assert.deepEqual(card.learningThroughput, {
      promotionRate: [],
      metaFrictionOpened: 0,
      designConceptsProducedToday: 0,
      windowDays: 7,
    });
  });

  test("learning-throughput degrade logs each site label via the structured-logger seam", async () => {
    const calls = await withCapturedStderr(() =>
      getBuilderHealthScorecard(
        happyDeps({
          getLessonsTrend: async () => {
            throw new Error("lt down");
          },
          getDesignConceptProductionCountForDate: async () => {
            throw new Error("dc down");
          },
        }),
      ),
    );
    const labels = calls.map((c) => c.label);
    assert.ok(
      labels.includes("builder-health/lessons-trend"),
      `expected builder-health/lessons-trend in ${JSON.stringify(labels)}`,
    );
    assert.ok(
      labels.includes("builder-health/design-concept-count"),
      `expected builder-health/design-concept-count in ${JSON.stringify(labels)}`,
    );
  });
});

// The `formatBuilderHealthLines` digest-section cases were retired with
// src/digest-format.ts in issue #5047: the Morning Brief renders its own
// one-line builder-health glance (test/operator-channel-brief.test.mts).

// ---------------------------------------------------------------------------
// computeStagnationPanel — pure per-realm projection (ADR-0028, #3288)
// ---------------------------------------------------------------------------

describe("computeStagnationPanel — pure per-realm projection", () => {
  // Helper: build a newest-first trend of N cycles with per-cycle overrides.
  function trend(n: number, per: (i: number) => Partial<TrendRow>): TrendRow[] {
    // Oldest-first, then reverse to newest-first (as getMetricsTrend returns).
    const rows: TrendRow[] = [];
    for (let i = 0; i < n; i++) {
      rows.push({ tasksAttempted: 1, tasksMerged: 1, status: "merged", ...per(i) });
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
      i < 20 ? { tasksMerged: 1, status: "merged" } : { tasksMerged: 0 },
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
      tasksMerged: 1, status: "merged",
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
      tasksMerged: 1, status: "merged",
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

// ---------------------------------------------------------------------------
// ADR-0047 Decision 9 fields (#5324): parentExceptionRate, firstPassQaYield,
// parkRatePerArm
// ---------------------------------------------------------------------------

const turnRow = (turn: number, events: Array<{ cause: string; turn: number; ts_epoch: number }> = []) =>
  JSON.stringify({
    turn_n: turn,
    ...(events.length > 0
      ? { parent_exceptions: events.map((e) => ({ ...e, source: "parent", detail: "" })) }
      : {}),
  });

describe("lifecycle fields — parentExceptionRate", () => {
  test("exception turns key on the event's own turn, events dedupe across the turn_n/turn_n-1 mirror, byCause counts events", () => {
    const dup = { cause: "script-error", turn: 2, ts_epoch: 100 };
    const f = foldParentExceptions([
      {
        runId: "r1",
        startedEpoch: 1,
        turns: parseTurnRows([
          turnRow(1),
          turnRow(2, [dup, { cause: "notes-steer", turn: 2, ts_epoch: 101 }]),
          // turn 3 mirrors the turn-2 event again (turn_n-1) plus its own
          turnRow(3, [dup, { cause: "defect-filed", turn: 3, ts_epoch: 150 }]),
          turnRow(4),
        ]),
      },
    ]);
    assert.equal(f.turns, 4);
    assert.equal(f.exceptionTurns, 2);
    assert.deepEqual(f.byCause, { "script-error": 1, "notes-steer": 1, "defect-filed": 1 });
  });

  test("a turn aborted before its heartbeat (no posted row) still counts: its mirrored event adds the turn to BOTH numerator and denominator (INV-2)", () => {
    const f = foldParentExceptions([
      {
        runId: "r1",
        startedEpoch: 1,
        // turn 1 aborted (invariant-reject) before Phase 5 posted its row; turn 2's row mirrors the turn-1 event (turn_n-1)
        turns: parseTurnRows([turnRow(2, [{ cause: "script-error", turn: 1, ts_epoch: 90 }, { cause: "notes-steer", turn: 2, ts_epoch: 100 }])]),
      },
    ]);
    assert.equal(f.turns, 2, "the row-less aborted turn joins the denominator");
    assert.equal(f.exceptionTurns, 2, "the aborted turn's exception is counted, not dropped");
    assert.ok(f.exceptionTurns <= f.turns);
    assert.deepEqual(f.byCause, { "script-error": 1, "notes-steer": 1 });
  });

  test("live Redis rows and the Run Ledger replay of the same run fold identically (INV-4)", () => {
    const events = [
      { cause: "invariant-reject", turn: 2, ts_epoch: 200 },
      { cause: "notes-steer", turn: 4, ts_epoch: 400 },
    ];
    // Redis: turn 2 aborted before heartbeat (no row); turn 3 mirrors it as turn_n-1.
    const redisRun = {
      runId: "r-parity",
      startedEpoch: 7,
      turns: parseTurnRows([
        turnRow(1, []),
        turnRow(3, [events[0]]),
        turnRow(4, [events[0], events[1]].filter((e) => e.turn >= 3)),
        turnRow(5, [events[1]]),
      ]),
    };
    const ledgerRun = ledgerToRunTurns({
      run_id: "r-parity",
      started_epoch: 7,
      turn: 5,
      parent_exceptions: events.map((e) => ({ ...e, source: "parent", detail: "" })),
    });
    assert.ok(ledgerRun);
    const live = foldParentExceptions([redisRun]);
    const replay = foldParentExceptions([ledgerRun]);
    assert.deepEqual(live, replay);
    assert.deepEqual(live, { turns: 5, exceptionTurns: 2, byCause: { "invariant-reject": 1, "notes-steer": 1 } });
    assert.deepEqual(baselineRowFor(redisRun), baselineRowFor(ledgerRun));
  });

  test("mergeBaselineRow keeps the larger-turns row on a re-seen run, and takes a fuller or first row", () => {
    const row = (turns: number) => ({ started_epoch: 1, turns, exceptionTurns: 0, byCause: {} });
    assert.equal(mergeBaselineRow(row(10), row(4)).turns, 10, "shrunk replay must not overwrite");
    assert.equal(mergeBaselineRow(row(4), row(10)).turns, 10);
    assert.equal(mergeBaselineRow(undefined, row(3)).turns, 3);
  });

  test("turns=0 => rate null; a malformed turn row is skipped, not counted", async () => {
    const card = await getBuilderHealthScorecard(happyDeps());
    assert.equal(card.parentExceptionRate?.rate, null);
    assert.equal(card.parentExceptionRate?.turns, 0);
    const f = foldParentExceptions([{ runId: "r", startedEpoch: 1, turns: parseTurnRows(["{not json", turnRow(1)]) }]);
    assert.equal(f.turns, 1);
  });

  test("scorecard computes rate = exceptionTurns / turns and echoes the recorded baseline verbatim", async () => {
    const baseline = {
      value: 0.5,
      source: "replay",
      method: "m",
      coveredFrom: "2026-11-05",
      coveredTo: "2026-11-05",
      computedAt: "2026-11-05T00:00:00Z",
    };
    const card = await getBuilderHealthScorecard(
      happyDeps({
        lifecycleHealth: lifecycleStubs({
          readFile: async () => JSON.stringify({ parentExceptionRate: { baseline } }),
          readRunTurns: async () => [
            { runId: "r1", startedEpoch: 5, turns: parseTurnRows([turnRow(1, [{ cause: "script-error", turn: 1, ts_epoch: 9 }]), turnRow(2), turnRow(3), turnRow(4)]) },
          ],
        }),
      }),
    );
    assert.equal(card.parentExceptionRate?.rate, 0.25);
    assert.deepEqual(card.parentExceptionRate?.baseline, baseline);
  });

  test("a throwing run reader degrades ONLY this field to null", async () => {
    const card = await getBuilderHealthScorecard(
      happyDeps({
        lifecycleHealth: lifecycleStubs({
          readRunTurns: async () => {
            throw new Error("redis down");
          },
        }),
      }),
    );
    assert.equal(card.parentExceptionRate, null);
    assert.notEqual(card.firstPassQaYield, null);
    assert.notEqual(card.parkRatePerArm, null);
  });
});

describe("lifecycle fields — firstPassQaYield", () => {
  const trailer = (verdict: string, pr: number, round: number) =>
    `review\n\nQA-Verdict: ${verdict} pr=${pr} round=${round} sha=abcdef123456 blockers=0 max_severity=none`;
  const start = Date.parse("2026-05-23T12:00:00Z");

  test("population is PRs whose earliest in-window trailer is round 1; PASS-pending-CI passes, FAIL-pending-CI does not", () => {
    const r = foldFirstPassQaYield(
      [
        { body: trailer("PASS", 1, 1), created_at: "2026-05-25T00:00:00Z" },
        { body: trailer("PASS-pending-CI", 2, 1), created_at: "2026-05-25T00:00:00Z" },
        { body: trailer("FAIL-pending-CI", 3, 1), created_at: "2026-05-25T00:00:00Z" },
        { body: trailer("FAIL", 4, 1), created_at: "2026-05-25T00:00:00Z" },
        { body: trailer("PASS", 4, 2), created_at: "2026-05-26T00:00:00Z" },
        // PR 5: earliest in-window trailer is round 2 => out of population
        { body: trailer("PASS", 5, 2), created_at: "2026-05-26T00:00:00Z" },
        // PR 6: round 1 predates the window => its round 2 is the earliest in-window
        { body: trailer("FAIL", 6, 1), created_at: "2026-05-01T00:00:00Z" },
        { body: trailer("PASS", 6, 2), created_at: "2026-05-27T00:00:00Z" },
        // unlabeled chatter never counts
        { body: "LGTM, no trailer", created_at: "2026-05-25T00:00:00Z" },
      ],
      start,
    );
    assert.deepEqual(r, { population: 4, firstPass: 2 });
  });

  test("empty population => yield null; a comment-read failure degrades to null, never 0", async () => {
    const empty = await getBuilderHealthScorecard(happyDeps());
    assert.equal(empty.firstPassQaYield?.yield, null);
    const failed = await getBuilderHealthScorecard(
      happyDeps({
        lifecycleHealth: lifecycleStubs({
          readQaVerdictComments: async () => ({ ok: false, code: "gh-rate-limited" }),
        }),
      }),
    );
    assert.equal(failed.firstPassQaYield, null);
  });

  test("scorecard yield = firstPass / population", async () => {
    const card = await getBuilderHealthScorecard(
      happyDeps({
        lifecycleHealth: lifecycleStubs({
          readQaVerdictComments: async () => ({
            ok: true,
            comments: [
              { body: trailer("PASS", 1, 1), created_at: "2026-05-29T00:00:00Z" },
              { body: trailer("FAIL", 2, 1), created_at: "2026-05-29T00:00:00Z" },
            ],
          }),
        }),
      }),
    );
    assert.equal(card.firstPassQaYield?.yield, 0.5);
    assert.equal(card.firstPassQaYield?.population, 2);
  });
});

describe("lifecycle fields — parkRatePerArm", () => {
  const ev = (kind: "park" | "would-park" | "claim", arm?: string) => ({
    kind,
    issue: 1,
    ts: 1,
    ...(arm ? { arm } : {}),
    actor: "cli",
  });

  test("zero-fills every cap arm; rate = parks / claims; wouldPark reported alongside", () => {
    const f = foldParkRate([ev("claim"), ev("claim"), ev("claim"), ev("claim"), ev("park", "qa-stall"), ev("would-park", "qa-stall"), ev("would-park", "total-claims")]);
    assert.equal(f.claimsOpened, 4);
    assert.equal(Object.keys(f.arms).length, 7);
    assert.deepEqual(f.arms["qa-stall"], { parks: 1, wouldPark: 1, rate: 0.25 });
    assert.deepEqual(f.arms["total-claims"], { parks: 0, wouldPark: 1, rate: 0 });
    assert.deepEqual(f.arms["stale-requeue"], { parks: 0, wouldPark: 0, rate: 0 });
  });

  test("claimsOpened=0 => rate null (dark) but counts still shown; mode is carried", async () => {
    const card = await getBuilderHealthScorecard(
      happyDeps({
        lifecycleHealth: lifecycleStubs({ readCapEvents: async () => ({ ok: true, events: [ev("would-park", "qa-stall")] }) }),
      }),
    );
    assert.equal(card.parkRatePerArm?.mode, "shadow");
    assert.equal(card.parkRatePerArm?.arms["qa-stall"].rate, null);
    assert.equal(card.parkRatePerArm?.arms["qa-stall"].wouldPark, 1);
  });

  test("an index read failure degrades this field to null", async () => {
    const card = await getBuilderHealthScorecard(
      happyDeps({ lifecycleHealth: lifecycleStubs({ readCapEvents: async () => ({ ok: false, error: "x" }) }) }),
    );
    assert.equal(card.parkRatePerArm, null);
  });

  test("capEventRecord mirrors a real cap park, a shadow refusal and a claim-opened; ignores everything else", () => {
    const base: LifecycleJournalEntry = {
      v: 1, ts: 10, kind: "transition", from: "in-progress", to: "parked", source: "cli", actor: "a",
      evidence: { pr: "42" }, reason: "cap:qa-stall", rationale: null, result: "parked:qa-stall", written: true,
    };
    assert.deepEqual(capEventRecord(7, base), { kind: "park", issue: 7, ts: 10, arm: "qa-stall", pr: 42, actor: "a" });
    assert.deepEqual(
      capEventRecord(7, { ...base, kind: "refused", written: false, result: "shadow-would-park:qa-stall" }),
      { kind: "would-park", issue: 7, ts: 10, arm: "qa-stall", pr: 42, actor: "a" },
    );
    assert.deepEqual(capEventRecord(7, { ...base, kind: "claim-opened", to: null, reason: null, result: "ok" }), {
      kind: "claim", issue: 7, ts: 10, actor: "a",
    });
    assert.equal(capEventRecord(7, { ...base, reason: "other", result: "ok" }), null);
  });
});

describe("lifecycle fields — baselines are read-only inputs", () => {
  test("a missing or unparseable baselines file yields null baselines, never a throw", async () => {
    const missing = await loadBuilderHealthBaselines({ readFile: async () => { throw NO_FILE; } });
    assert.deepEqual(missing, { parentExceptionRate: null, firstPassQaYield: null, parkRatePerArm: null });
    const bad = await loadBuilderHealthBaselines({ readFile: async () => "{nope" });
    assert.deepEqual(bad, missing);
  });

  test("summarizeBaselineRows recomputes over rows within 30d of the newest and reports the covered span", () => {
    const day = 86400;
    const t0 = Date.parse("2026-11-05T00:00:00Z") / 1000;
    const s = summarizeBaselineRows(
      {
        old: { started_epoch: t0 - 40 * day, turns: 100, exceptionTurns: 100, byCause: {} },
        a: { started_epoch: t0 - 2 * day, turns: 10, exceptionTurns: 1, byCause: {} },
        b: { started_epoch: t0, turns: 10, exceptionTurns: 0, byCause: {} },
      },
      "2026-11-05T01:00:00Z",
    );
    assert.equal(s.runs, 2);
    assert.equal(s.value, 0.05);
    assert.equal(s.coveredFrom, "2026-11-03");
    assert.equal(s.coveredTo, "2026-11-05");
  });
});

describe("committed builder-health baselines are provenanced (#5324)", () => {
  // Vacuous = a recorded value with no provenance (zero turns/runs). A genuine 0 over real turns is healthy.
  const isProvenanced = (b: any): boolean =>
    b.value === null ? true : b.turns > 0 && b.runs > 0 && b.computedAt !== null && b.value === b.exceptionTurns / b.turns;

  test("a recorded parentExceptionRate baseline carries provenance (null placeholder allowed)", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = JSON.parse(readFileSync(new URL("../config/orchestrator/builder-health-baselines.json", import.meta.url), "utf8"));
    assert.ok(isProvenanced(doc.parentExceptionRate.baseline));
  });

  test("guard shapes: genuine 0 over real turns passes; fabricated 0 and zero-turn values fail; null passes", () => {
    assert.equal(isProvenanced({ value: 0, turns: 40, runs: 3, exceptionTurns: 0, computedAt: "2026-11-06T00:00:00Z" }), true);
    assert.equal(isProvenanced({ value: 0, turns: 0, runs: 0, exceptionTurns: 0, computedAt: "2026-11-06T00:00:00Z" }), false);
    assert.equal(isProvenanced({ value: 0, turns: 40, runs: 3, exceptionTurns: 0, computedAt: null }), false);
    assert.equal(isProvenanced({ value: null, computedAt: null }), true);
  });
});

describe("mirror-presence filter on the parentExceptionRate runs", () => {
  const turn = (n: number, pe?: unknown[]) => JSON.stringify({ turn_n: n, ...(pe !== undefined ? { parent_exceptions: pe } : {}) });

  test("filterMirrorRuns drops runs whose turns never carried the field; a clean run with [] stays", () => {
    const pre = { runId: "pre", startedEpoch: 1, turns: parseTurnRows([turn(1), turn(2)]) };
    const clean = { runId: "clean", startedEpoch: 2, turns: parseTurnRows([turn(1, []), turn(2, [])]) };
    const dirty = { runId: "dirty", startedEpoch: 3, turns: parseTurnRows([turn(1), turn(2, [{ cause: "x", turn: 2, ts_epoch: 1 }])]) };
    assert.deepEqual(filterMirrorRuns([pre, clean, dirty]).map((r) => r.runId), ["clean", "dirty"]);
  });

  test("default reader excludes pre-mirror runs; mirror-era runs (clean or not) still count", async () => {
    const { addAutopilotRunToIndex, addAutopilotRunTurn } = await import("../src/redis/autopilot-runs.ts");
    const tag = `mirror-${process.pid}-${Date.now()}`;
    const nowSec = Math.floor(Date.now() / 1000);
    await addAutopilotRunToIndex(`${tag}-old`, nowSec - 3600, 300);
    await addAutopilotRunToIndex(`${tag}-new`, nowSec - 1800, 300);
    for (let t = 1; t <= 3; t++) {
      await addAutopilotRunTurn(`${tag}-old`, t, turn(t), 300);
      await addAutopilotRunTurn(`${tag}-new`, t, turn(t, []), 300);
    }
    const metric = await computeParentExceptionRate(2, {});
    // Per-run Redis DB isolation: only the two seeded runs exist.
    assert.equal(metric.runs, 1, "pre-mirror run excluded");
    assert.equal(metric.turns, 3, "only the mirror-era run's turns counted");
    assert.equal(metric.rate, 0);
  });

  test("ledger replay marks every turn mirror-era, so a clean live run is recorded, not dropped", () => {
    const run = ledgerToRunTurns({ run_id: "live", started_epoch: 5, turn: 3 });
    assert.ok(run);
    assert.equal(filterMirrorRuns([run]).length, 1);
    assert.equal(baselineRowFor(run).turns, 3);
  });
});
