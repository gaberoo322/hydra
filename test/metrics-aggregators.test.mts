/**
 * Regression tests for the metrics aggregators extracted from the inline
 * `src/api/metrics.ts` routes (issue #2126).
 *
 * Before #2126, the `anchorType`-bucketing logic behind
 * `GET /metrics/anchor-distribution` lived inline in the route body, so it
 * could only be exercised by standing up the Express router and stubbing Redis.
 * (The `GET /metrics/grounding-duration` percentile/bucket projection and the
 * `GET /summary` cumulative-accomplishments projection were deleted with those
 * retired routes — ADR-0024 §3, issue #4638.)
 * They are now pure functions in `src/metrics/` that take an already-fetched
 * trend array and return the same on-wire shape — unit-testable on synthetic
 * fixtures, the same discipline as the other metrics aggregators
 * (`projectCostByClass`).
 *
 * Locked behaviors (the design-concept invariants for #2126):
 *   - On-wire shapes are byte-for-byte unchanged.
 *   - The hard-coded priority-name fallbacks move verbatim.
 *   - Pure: no Redis, no Express — synthetic trend arrays only, no fixture.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  projectAggregateStats,
  projectAnchorDistribution,
} from "../src/metrics/stats-projection.ts";

// ---------------------------------------------------------------------------
// projectAnchorDistribution (anchor-distribution route extraction)
// ---------------------------------------------------------------------------

describe("projectAnchorDistribution", () => {
  test("buckets cycles by anchorType into the live priority lanes", () => {
    const trend = [
      { anchorType: "kanban" },
      { anchorType: "kanban" },
      { anchorType: "failing-test" },
      { anchorType: "research" }, // folds into work-queue
      { anchorType: "health" }, // folds into codebase-health
      { anchorType: "doc" }, // folds into priorities-doc
    ];

    const result = projectAnchorDistribution(trend);

    assert.equal(result.windowCycles, 6);

    const byPriority = Object.fromEntries(
      result.distribution.map((d) => [d.priority, d.served]),
    );
    assert.equal(byPriority["kanban"], 2);
    assert.equal(byPriority["failing-test"], 1);
    assert.equal(byPriority["work-queue"], 1); // from "research"
    assert.equal(byPriority["codebase-health"], 1); // from "health"
    assert.equal(byPriority["priorities-doc"], 1); // from "doc"
  });

  test("preserves the distribution lane order and null gauge fields", () => {
    const result = projectAnchorDistribution([]);
    assert.deepEqual(
      result.distribution.map((d) => d.priority),
      ["kanban", "failing-test", "work-queue", "codebase-health", "priorities-doc"],
    );
    for (const entry of result.distribution) {
      assert.equal(entry.served, 0);
      assert.equal(entry.candidatesAvailable, null);
      assert.equal(entry.suppressedReason, null);
    }
    assert.equal(result.windowCycles, 0);
    assert.deepEqual(result.servedByAnchorType, {});
  });

  test("work-queue fallback prefers work-queue, then research, then user-request", () => {
    // Explicit work-queue wins over the research/user-request fallbacks.
    const explicit = projectAnchorDistribution([
      { anchorType: "work-queue" },
      { anchorType: "research" },
      { anchorType: "user-request" },
    ]);
    const wq = explicit.distribution.find((d) => d.priority === "work-queue")!;
    // The `||` chain short-circuits on the first non-zero — work-queue=1.
    assert.equal(wq.served, 1);

    // With no explicit work-queue, research is used.
    const viaResearch = projectAnchorDistribution([
      { anchorType: "research" },
      { anchorType: "user-request" },
    ]);
    assert.equal(
      viaResearch.distribution.find((d) => d.priority === "work-queue")!.served,
      1,
    );

    // With neither work-queue nor research, user-request is used.
    const viaUserRequest = projectAnchorDistribution([
      { anchorType: "user-request" },
      { anchorType: "user-request" },
    ]);
    assert.equal(
      viaUserRequest.distribution.find((d) => d.priority === "work-queue")!.served,
      2,
    );
  });

  test("missing / blank anchorType buckets under `unknown`", () => {
    const result = projectAnchorDistribution([
      {},
      { anchorType: "" },
      { anchorType: "   " },
      { anchorType: null },
    ]);
    assert.equal(result.servedByAnchorType["unknown"], 4);
    // None of the live lanes match `unknown`, so all served counts stay 0.
    for (const entry of result.distribution) {
      assert.equal(entry.served, 0);
    }
    assert.equal(result.windowCycles, 4);
  });

  test("servedByAnchorType is the raw per-type count map", () => {
    const result = projectAnchorDistribution([
      { anchorType: "kanban" },
      { anchorType: "kanban" },
      { anchorType: "failing-test" },
    ]);
    assert.deepEqual(result.servedByAnchorType, {
      kanban: 2,
      "failing-test": 1,
    });
  });
});

// ---------------------------------------------------------------------------
// projectAggregateStats (getAggregateStats arithmetic extraction, issue #2143)
// ---------------------------------------------------------------------------

describe("projectAggregateStats", () => {
  test("empty trend => { cycles: 0 } guard (no divide-by-zero)", () => {
    assert.deepEqual(projectAggregateStats([]), { cycles: 0 });
  });

  test("computes merged/failed/abandoned/regression/no-op rates as percentages", () => {
    const trend = [
      { tasksMerged: 1, status: "merged", regressionIntroduced: false, noOpMerges: 0 },
      { tasksMerged: 1, status: "merged", regressionIntroduced: true, noOpMerges: 1 },
      { tasksFailed: 1, regressionIntroduced: false, noOpMerges: 0 },
      { tasksAbandoned: 1, regressionIntroduced: false, noOpMerges: 0 },
    ];

    const result = projectAggregateStats(trend) as Record<string, any>;

    assert.equal(result.cycles, 4);
    assert.equal(result.mergedRate, 50); // 2/4
    assert.equal(result.failedRate, 25); // 1/4
    assert.equal(result.abandonedRate, 25); // 1/4
    assert.equal(result.regressionRate, 25); // 1/4
    assert.equal(result.noOpMerges, 1); // count of cycles with noOpMerges > 0
    assert.equal(result.noOpMergeRate, 25); // 1/4
    // verifiedCompletionRate is 100 when any cycle merged.
    assert.equal(result.verifiedCompletionRate, 100);
    // Static fields preserved byte-for-byte.
    assert.equal(result.falseCompletionRate, 0);
    assert.equal(result.anchoredRate, 100);
  });

  test("single-entry trend => rates are 0 or 100, never NaN", () => {
    const merged = projectAggregateStats([{ tasksMerged: 1, status: "merged" }]) as Record<string, any>;
    assert.equal(merged.cycles, 1);
    assert.equal(merged.mergedRate, 100);
    assert.equal(merged.failedRate, 0);
    assert.equal(merged.regressionRate, 0);
    assert.equal(merged.noOpMergeRate, 0);
    assert.equal(merged.verifiedCompletionRate, 100);

    const failed = projectAggregateStats([{ tasksFailed: 1 }]) as Record<string, any>;
    assert.equal(failed.mergedRate, 0);
    assert.equal(failed.failedRate, 100);
    // No merge => verifiedCompletionRate is 0.
    assert.equal(failed.verifiedCompletionRate, 0);
  });

  test("retryRate counts prior-failure anchors; anchorDistribution buckets all", () => {
    const trend = [
      { anchorType: "prior-failure", tasksMerged: 1, status: "merged" },
      { anchorType: "kanban", tasksMerged: 1, status: "merged" },
      { anchorType: "kanban" },
      {}, // missing anchorType -> "unknown"
    ];
    const result = projectAggregateStats(trend) as Record<string, any>;
    assert.equal(result.retryRate, 25); // 1/4 prior-failure
    assert.deepEqual(result.anchorDistribution, {
      "prior-failure": 1,
      kanban: 2,
      unknown: 1,
    });
  });

  test("averages durations over only the positive (truthy) samples", () => {
    const trend = [
      { totalDurationMs: 2000, verificationDurationMs: 1000, groundingDurationMs: 500, filesChanged: 3 },
      { totalDurationMs: 4000, verificationDurationMs: 0, groundingDurationMs: 0, filesChanged: 2 },
    ];
    const result = projectAggregateStats(trend) as Record<string, any>;
    // avgDuration over [2000, 4000] = 3000; human is rounded seconds.
    assert.equal(result.avgDurationMs, 3000);
    assert.equal(result.avgDurationHuman, "3s");
    // verification/grounding average only the truthy sample (the 0s are filtered).
    assert.equal(result.avgVerificationMs, 1000);
    assert.equal(result.avgGroundingMs, 500);
    // filesChanged summed across the window.
    assert.equal(result.totalFilesChanged, 5);
  });

  test("zero positive durations => averages are 0, not NaN", () => {
    const result = projectAggregateStats([
      { totalDurationMs: 0, verificationDurationMs: 0, groundingDurationMs: 0 },
    ]) as Record<string, any>;
    assert.equal(result.avgDurationMs, 0);
    assert.equal(result.avgDurationHuman, "0s");
    assert.equal(result.avgVerificationMs, 0);
    assert.equal(result.avgGroundingMs, 0);
    assert.equal(result.totalFilesChanged, 0);
  });
});
