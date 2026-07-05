/**
 * Seam regression tests for `src/autopilot/run-health.ts` (issue #1378).
 *
 * The #890 autopilot-health heuristics were extracted out of the
 * `aggregators/autopilot-health.ts` I/O fan-out into this pure analysis seam.
 * This file imports DIRECTLY from `run-health.ts` — NOT through the aggregator
 * — to prove the heuristics are evaluable without instantiating the
 * aggregator's `deps` bag (no Redis, no clock, no subprocess). The exhaustive
 * per-heuristic behaviour matrix lives in `test/autopilot-health.test.mts`,
 * which still exercises the same functions through the aggregator's
 * re-export; this file pins the extraction boundary itself.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  detectStalledDispatch,
  detectUnproductiveLoops,
  detectIdleStreak,
  detectIssuePrChurn,
  oldestRunStartEpochS,
  rankSignals,
  DEFAULT_HEALTH_THRESHOLDS,
  type AutopilotHealthThresholds,
  type LiveRunView,
  type RunDigest,
} from "../src/autopilot/run-health.ts";
import { StuckSignalSchema } from "../src/schemas/now-page.ts";

const T = DEFAULT_HEALTH_THRESHOLDS;

describe("run-health seam (issue #1378) — pure heuristics, no aggregator deps", () => {
  test("DEFAULT_HEALTH_THRESHOLDS is the documented threshold set", () => {
    const expected: AutopilotHealthThresholds = {
      stalledDispatchAgeS: 900,
      unproductiveMinDispatches: 3,
      unproductiveCriticalFailRatio: 0.75,
      idleStreakMin: 3,
      idleStreakCritical: 5,
      churnMinRecurrences: 3,
      churnCriticalRecurrences: 5,
      mergeWindowLookbackS: 14_400,
    };
    assert.deepEqual(T, expected);
  });

  test("detectStalledDispatch fires on a stale running run with an open dispatch", () => {
    const live: LiveRunView = {
      run_id: "ap-1",
      status: "running",
      age_s: T.stalledDispatchAgeS + 60,
      turns: [{ turn_n: 5, actions: [{ type: "dispatch", outcome: null }] }],
    };
    // osHbAgeS stale too so the #1091 cross-check doesn't suppress.
    const sig = detectStalledDispatch(live, T, T.stalledDispatchAgeS + 60);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].type, "stalled-dispatch");
    assert.equal(StuckSignalSchema.safeParse(sig[0]).success, true);
  });

  test("detectUnproductiveLoops fires when dispatches accrue with zero merges", () => {
    const history: RunDigest[] = [
      { dispatches: 2, merged_count: 0, failed_count: 1 },
      { dispatches: 2, merged_count: 0, failed_count: 2 },
    ];
    const sig = detectUnproductiveLoops(history, T, /* realMergesInWindow */ 0);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].type, "unproductive-loop");
  });

  test("detectUnproductiveLoops suppresses when real master merges landed", () => {
    const history: RunDigest[] = [
      { dispatches: 4, merged_count: 0, failed_count: 0 },
    ];
    const sig = detectUnproductiveLoops(history, T, /* realMergesInWindow */ 3);
    assert.deepEqual(sig, []);
  });

  test("detectIdleStreak counts the leading idle streak", () => {
    const history: RunDigest[] = [
      { term_reason: "idle", dispatches: 0 },
      { term_reason: "idle", dispatches: 0 },
      { term_reason: "idle", dispatches: 0 },
    ];
    const sig = detectIdleStreak(history, T);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].type, "idle-streak");
    assert.equal(sig[0].evidence.streak, 3);
  });

  test("detectIdleStreak: a productive run (dispatches>0) breaks the streak even when term_reason is idle", () => {
    // term_reason "idle" is the normal clean idle-drain exit, NOT a
    // productivity measure — a run that dispatched work is not idle (#2864).
    const history: RunDigest[] = [
      { term_reason: "idle", dispatches: 2 },
      { term_reason: "idle", dispatches: 0 },
      { term_reason: "idle", dispatches: 0 },
    ];
    const sig = detectIdleStreak(history, T);
    assert.deepEqual(sig, []);
  });

  test("detectIdleStreak: only leading dispatches===0 runs count; a productive run cuts the streak at 1", () => {
    const history: RunDigest[] = [
      { term_reason: "idle", dispatches: 0 },
      { term_reason: "idle", dispatches: 2 },
      { dispatches: 0 },
    ];
    // Lower idleStreakMin to 1 so the sub-threshold streak is observable —
    // proving the count stops at the first productive (dispatches>0) run
    // rather than crediting the trailing dispatches===0 run.
    const sig = detectIdleStreak(history, { ...T, idleStreakMin: 1 });
    assert.equal(sig.length, 1);
    assert.equal(sig[0].evidence.streak, 1);
  });

  test("detectIssuePrChurn flags a recurring unresolved ref", () => {
    // issue_ref is read defensively (extractRefs) and not a declared RunDigest
    // field, so the fixture casts through unknown — same pattern as
    // test/autopilot-health.test.mts.
    const history = [
      { issue_ref: "issue-42", merged_count: 0 },
      { issue_ref: "issue-42", merged_count: 0 },
      { issue_ref: "issue-42", merged_count: 0 },
    ] as unknown as RunDigest[];
    const sig = detectIssuePrChurn(history, T);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].type, "issue-pr-churn");
    assert.equal(sig[0].evidence.ref, "issue-42");
  });

  test("oldestRunStartEpochS returns the smallest positive started_epoch", () => {
    const history: RunDigest[] = [
      { started_epoch: 1700000200 },
      { started_epoch: 1700000100 },
      { started_epoch: 0 }, // ignored
    ];
    assert.equal(oldestRunStartEpochS(history), 1700000100);
    assert.equal(oldestRunStartEpochS([]), null);
  });

  test("rankSignals orders critical → warn → info, then by type", () => {
    const ranked = rankSignals([
      { type: "idle-streak", severity: "warn", summary: "", evidence: {} },
      { type: "stalled-dispatch", severity: "critical", summary: "", evidence: {} },
      { type: "issue-pr-churn", severity: "warn", summary: "", evidence: {} },
    ]);
    assert.deepEqual(
      ranked.map((s) => s.type),
      ["stalled-dispatch", "idle-streak", "issue-pr-churn"],
    );
  });
});
