/**
 * Regression tests for `projectCostByOutcome` — the pure DERIVED read that
 * splits a metrics-trend window's token cost by cycle outcome (merged / empty /
 * failed), issue #3024.
 *
 * Design-concept c1644ee7 invariants pinned here:
 *   - Pure derived read: NO new writer. The projection reads only fields the
 *     trend already joins — `tokenCost` plus the outcome-determining
 *     `tasksMerged`/`tasksFailed`/`tasksAbandoned`/`tasksAttempted`.
 *   - Outcome trichotomy stays 1:1 with the live merge-rate / empty-rate gauges:
 *       merged := tasksMerged>0
 *       empty  := tasksAttempted>0 && merged==0 && failed==0 && abandoned==0
 *       failed := tasksFailed>0 || tasksAbandoned>0
 *   - Unattributed cycles (null/absent `tokenCost`) count toward a bucket's
 *     `cycles` but contribute 0 tokens and are excluded from the
 *     `tokensPerCycle` denominator — the truthful sentinel, never a fabricated 0
 *     (identical to projectTokensPerMergedPR).
 *   - Cost is TOKENS, never USD.
 *   - Pure: no Redis, no Express — synthetic trend arrays only.
 *
 * Authored as a NEW top-level `describe` with no shared-Redis lifecycle so it
 * cannot piggyback on a sibling suite's `after()` teardown (CLAUDE.md authoring
 * rule).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  projectCostByOutcome,
  CYCLE_OUTCOME_ORDER,
} from "../src/metrics/aggregate.ts";

describe("projectCostByOutcome", () => {
  test("empty trend => zeroed buckets, null tokensPerCycle, windowCycles 0", () => {
    const r = projectCostByOutcome([]);
    assert.equal(r.windowCycles, 0);
    for (const o of CYCLE_OUTCOME_ORDER) {
      assert.deepEqual(r.byOutcome[o], {
        cycles: 0,
        attributedTokens: 0,
        attributedCycles: 0,
        tokensPerCycle: null,
      });
    }
  });

  test("buckets merged / empty / failed by the exact gauge predicates", () => {
    const trend = [
      { tasksAttempted: 1, tasksMerged: 1, tokenCost: 100 }, // merged
      { tasksAttempted: 1, tasksMerged: 0, tasksFailed: 1, tokenCost: 200 }, // failed (tasksFailed)
      { tasksAttempted: 1, tasksMerged: 0, tasksFailed: 0, tasksAbandoned: 1, tokenCost: 300 }, // failed (abandoned)
      { tasksAttempted: 1, tasksMerged: 0, tasksFailed: 0, tasksAbandoned: 0, tokenCost: 50 }, // empty
    ];
    const r = projectCostByOutcome(trend);
    assert.equal(r.windowCycles, 4);
    assert.equal(r.byOutcome.merged.cycles, 1);
    assert.equal(r.byOutcome.failed.cycles, 2);
    assert.equal(r.byOutcome.empty.cycles, 1);
    assert.equal(r.byOutcome.merged.attributedTokens, 100);
    assert.equal(r.byOutcome.failed.attributedTokens, 500);
    assert.equal(r.byOutcome.empty.attributedTokens, 50);
  });

  test("merged wins over failed/empty when tasksMerged>0 even if other fields set", () => {
    // A cycle that both merged something AND failed something classifies as
    // merged — mirrors computeRollingMergeRateFromTrend counting it as merged.
    const trend = [
      { tasksAttempted: 2, tasksMerged: 1, tasksFailed: 1, tasksAbandoned: 1, tokenCost: 42 },
    ];
    const r = projectCostByOutcome(trend);
    assert.equal(r.byOutcome.merged.cycles, 1);
    assert.equal(r.byOutcome.failed.cycles, 0);
    assert.equal(r.byOutcome.empty.cycles, 0);
    assert.equal(r.byOutcome.merged.attributedTokens, 42);
  });

  test("tokensPerCycle averages over ONLY attributed cycles in the bucket", () => {
    const trend = [
      { tasksMerged: 1, tokenCost: 100 },
      { tasksMerged: 1, tokenCost: 300 },
      { tasksMerged: 1, tokenCost: 200 },
    ];
    const r = projectCostByOutcome(trend);
    assert.equal(r.byOutcome.merged.cycles, 3);
    assert.equal(r.byOutcome.merged.attributedCycles, 3);
    assert.equal(r.byOutcome.merged.attributedTokens, 600);
    assert.equal(r.byOutcome.merged.tokensPerCycle, 200); // 600/3
  });

  test("unattributed cycle (null/absent tokenCost) counts as a cycle but 0 tokens, excluded from average", () => {
    const trend = [
      { tasksMerged: 1, tokenCost: 100 },
      { tasksMerged: 1, tokenCost: null }, // unattributed
      { tasksMerged: 1 }, // absent tokenCost — also unattributed
    ];
    const r = projectCostByOutcome(trend);
    assert.equal(r.byOutcome.merged.cycles, 3);
    assert.equal(r.byOutcome.merged.attributedCycles, 1);
    assert.equal(r.byOutcome.merged.attributedTokens, 100);
    // Average is over the ONE attributed cycle, never diluted to 100/3.
    assert.equal(r.byOutcome.merged.tokensPerCycle, 100);
  });

  test("bucket with cycles but zero attributed tokens => tokensPerCycle null (never fabricated 0)", () => {
    const trend = [
      { tasksAttempted: 1, tasksMerged: 0, tasksFailed: 0, tasksAbandoned: 0 }, // empty, no tokenCost
    ];
    const r = projectCostByOutcome(trend);
    assert.equal(r.byOutcome.empty.cycles, 1);
    assert.equal(r.byOutcome.empty.attributedCycles, 0);
    assert.equal(r.byOutcome.empty.attributedTokens, 0);
    assert.equal(r.byOutcome.empty.tokensPerCycle, null);
  });

  test("non-finite tokenCost (NaN / Infinity / string) is treated as unattributed", () => {
    const trend = [
      { tasksMerged: 1, tokenCost: NaN },
      { tasksMerged: 1, tokenCost: Infinity },
      { tasksMerged: 1, tokenCost: "500" as any },
      { tasksMerged: 1, tokenCost: 400 },
    ];
    const r = projectCostByOutcome(trend);
    assert.equal(r.byOutcome.merged.cycles, 4);
    assert.equal(r.byOutcome.merged.attributedCycles, 1);
    assert.equal(r.byOutcome.merged.attributedTokens, 400);
    assert.equal(r.byOutcome.merged.tokensPerCycle, 400);
  });

  test("row with no terminal signal (attempted 0, merged 0) is attributed to NO bucket", () => {
    const trend = [
      { tasksAttempted: 0, tasksMerged: 0, tasksFailed: 0, tasksAbandoned: 0, tokenCost: 999 },
      { tasksMerged: 1, tokenCost: 10 },
    ];
    const r = projectCostByOutcome(trend);
    // Only the merged row counts; the no-signal row drops out entirely.
    assert.equal(r.windowCycles, 1);
    assert.equal(r.byOutcome.merged.cycles, 1);
    assert.equal(r.byOutcome.empty.cycles, 0);
    assert.equal(r.byOutcome.failed.cycles, 0);
    // Its 999 tokens do NOT leak into any bucket.
    assert.equal(
      r.byOutcome.merged.attributedTokens +
        r.byOutcome.empty.attributedTokens +
        r.byOutcome.failed.attributedTokens,
      10,
    );
  });

  test("null-safe on missing outcome fields (never throws)", () => {
    const trend = [{}, { tokenCost: 5 }, { tasksMerged: undefined, tokenCost: 7 }];
    const r = projectCostByOutcome(trend as any);
    // None have a terminal signal => no bucket, no throw.
    assert.equal(r.windowCycles, 0);
  });

  test("windowCycles equals the sum of the three buckets' cycle counts", () => {
    const trend = [
      { tasksMerged: 1, tokenCost: 1 },
      { tasksMerged: 1, tokenCost: 1 },
      { tasksAttempted: 1, tasksFailed: 1, tokenCost: 1 },
      { tasksAttempted: 1, tokenCost: 1 }, // empty
    ];
    const r = projectCostByOutcome(trend);
    const sum =
      r.byOutcome.merged.cycles + r.byOutcome.empty.cycles + r.byOutcome.failed.cycles;
    assert.equal(r.windowCycles, sum);
    assert.equal(r.windowCycles, 4);
  });
});
