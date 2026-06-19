/**
 * Regression tests for the metrics aggregators extracted from the two inline
 * `src/api/metrics.ts` routes (issue #2126).
 *
 * Before #2126, the `anchorType`-bucketing logic behind
 * `GET /metrics/anchor-distribution` and the percentile/bucket math behind
 * `GET /metrics/grounding-duration` lived inline in the route bodies, so they
 * could only be exercised by standing up the Express router and stubbing Redis.
 * They are now pure functions in `src/metrics/` that take an already-fetched
 * trend array and return the same on-wire shape — unit-testable on synthetic
 * fixtures, the same discipline as the other metrics aggregators
 * (`projectCostByClass`).
 *
 * Locked behaviors (the design-concept invariants for #2126):
 *   - On-wire shapes are byte-for-byte unchanged.
 *   - The hard-coded priority-name fallbacks move verbatim.
 *   - The percentile p50/p95 math is nearest-rank, clamped, null-on-empty.
 *   - Pure: no Redis, no Express — synthetic trend arrays only, no fixture.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { projectAnchorDistribution } from "../src/metrics/aggregate.ts";
import { percentile, projectGroundingDuration } from "../src/metrics/trend.ts";

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
// percentile (extracted pure helper)
// ---------------------------------------------------------------------------

describe("percentile", () => {
  test("returns null for an empty array", () => {
    assert.equal(percentile([], 0.5), null);
    assert.equal(percentile([], 0.95), null);
  });

  test("nearest-rank, clamped to the last index", () => {
    const arr = [10, 20, 30, 40, 50];
    // floor((5-1)*0.5) = 2 -> sorted[2] = 30
    assert.equal(percentile(arr, 0.5), 30);
    // floor((5-1)*0.95) = 3 -> sorted[3] = 40
    assert.equal(percentile(arr, 0.95), 40);
    // floor((5-1)*1) = 4 -> sorted[4] = 50 (clamp boundary)
    assert.equal(percentile(arr, 1), 50);
  });

  test("sorts before indexing (input order does not matter)", () => {
    assert.equal(percentile([50, 10, 40, 20, 30], 0.5), 30);
  });

  test("single-element array returns that element for any p", () => {
    assert.equal(percentile([42], 0.5), 42);
    assert.equal(percentile([42], 0.95), 42);
  });
});

// ---------------------------------------------------------------------------
// projectGroundingDuration (grounding-duration route extraction)
// ---------------------------------------------------------------------------

describe("projectGroundingDuration", () => {
  test("projects samples and buckets by groundingMode", () => {
    const trend = [
      {
        cycleId: "c1",
        groundingMode: "incremental",
        groundingDurationMs: 1000,
        verificationDurationMs: 2000,
        incrementalTestsSelected: 5,
      },
      {
        cycleId: "c2",
        groundingMode: "incremental",
        groundingDurationMs: 3000,
        verificationDurationMs: 4000,
        incrementalTestsSelected: 7,
      },
      {
        cycleId: "c3",
        groundingMode: "full",
        groundingDurationMs: 9000,
        verificationDurationMs: 10000,
      },
      {
        cycleId: "c4",
        groundingMode: "",
        groundingDurationMs: 500,
        verificationDurationMs: 600,
      },
    ];

    const result = projectGroundingDuration(trend);

    assert.equal(result.sampleSize, 4);
    assert.equal(result.recent.length, 4);

    // incremental bucket: 2 cycles
    assert.equal(result.buckets.incremental.cycles, 2);
    // grounding [1000, 3000] -> p50 idx floor(1*0.5)=0 -> 1000; p95 idx floor(1*0.95)=0 -> 1000
    assert.equal(result.buckets.incremental.grounding.p50, 1000);
    assert.equal(result.buckets.incremental.grounding.p95, 1000);
    assert.equal(result.buckets.incremental.grounding.mean, 2000);
    assert.equal(result.buckets.incremental.verification.mean, 3000);

    // full bucket: 1 cycle
    assert.equal(result.buckets.full.cycles, 1);
    assert.equal(result.buckets.full.grounding.p50, 9000);
    assert.equal(result.buckets.full.grounding.mean, 9000);

    // unlabelled bucket ("" mode): 1 cycle
    assert.equal(result.buckets.unlabelled.cycles, 1);
    assert.equal(result.buckets.unlabelled.grounding.mean, 500);
  });

  test("projects testsSelected from incrementalTestsSelected, null when absent", () => {
    const result = projectGroundingDuration([
      { cycleId: "a", groundingMode: "incremental", incrementalTestsSelected: 9 },
      { cycleId: "b", groundingMode: "full" },
    ]);
    const byId = Object.fromEntries(result.recent.map((s) => [s.cycleId, s.testsSelected]));
    assert.equal(byId["a"], 9);
    assert.equal(byId["b"], null);
  });

  test("coerces non-number / missing duration fields to 0 and mode to ''", () => {
    const result = projectGroundingDuration([
      { cycleId: "x" }, // all fields missing
      { cycleId: "y", groundingMode: 42, groundingDurationMs: "nope" },
    ]);
    // Both fall to the unlabelled ("") bucket.
    assert.equal(result.buckets.unlabelled.cycles, 2);
    // No positive durations -> stats are null (filtered out by `> 0`).
    assert.equal(result.buckets.unlabelled.grounding.p50, null);
    assert.equal(result.buckets.unlabelled.grounding.mean, null);
    for (const s of result.recent) {
      assert.equal(s.groundingMode, "");
      assert.equal(s.groundingDurationMs, 0);
      assert.equal(s.verificationDurationMs, 0);
    }
  });

  test("empty trend => zero sampleSize, empty recent, zeroed/null buckets", () => {
    const result = projectGroundingDuration([]);
    assert.equal(result.sampleSize, 0);
    assert.deepEqual(result.recent, []);
    for (const mode of ["incremental", "full", "unlabelled"] as const) {
      assert.equal(result.buckets[mode].cycles, 0);
      assert.equal(result.buckets[mode].grounding.p50, null);
      assert.equal(result.buckets[mode].grounding.p95, null);
      assert.equal(result.buckets[mode].grounding.mean, null);
      assert.equal(result.buckets[mode].verification.mean, null);
    }
  });

  test("recent is capped at the first 20 samples", () => {
    const trend = Array.from({ length: 25 }, (_, i) => ({
      cycleId: `c${i}`,
      groundingMode: "full",
      groundingDurationMs: i + 1,
      verificationDurationMs: i + 1,
    }));
    const result = projectGroundingDuration(trend);
    assert.equal(result.sampleSize, 25);
    assert.equal(result.recent.length, 20);
    assert.equal(result.recent[0].cycleId, "c0");
    assert.equal(result.recent[19].cycleId, "c19");
    // The full bucket still counts all 25 cycles.
    assert.equal(result.buckets.full.cycles, 25);
  });
});
