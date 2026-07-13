/**
 * Regression tests for the outcome-attribution impact-ranking lens
 * (issue #3283, epic #2628 — the reverse-loop feedback path):
 * `src/outcome-attribution/impact-ranking.ts`.
 *
 * The lens is PURE / zero-I/O — a fold over the shipped ridge estimator — so
 * these tests build `AttributionObservation[]` fixtures directly and assert the
 * ranking, with no Redis and no HTTP.
 *
 * What this guards (from issue #3283 success criteria):
 *   - `getTopImpactProducerClasses()` is exported as the public reverse-loop lens.
 *   - Producer classes are ranked by FAVORABLE outcome-impact PER unit of build
 *     cost (mean-tier proxy), descending.
 *   - A metric's `direction` orients raw signed β into a favorable effect
 *     ("down" flips the sign; a lower-is-better metric that DROPPED is a win).
 *   - Every ranked row carries identifiability + noise-floor posture (never a
 *     bare estimate); suspect/below-floor rows are surfaced WITH flags unless
 *     `onlyConfident` drops them explicitly.
 *   - `topN` caps the ranking; a dark/empty ledger → rows:[] , metricCount:0.
 *   - The lens does zero I/O and does not mutate its input (structural).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { AttributionObservation } from "../src/redis/attribution-ledger.ts";
import { getTopImpactProducerClasses } from "../src/outcome-attribution/impact-ranking.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function obs(
  metric: string,
  delta: number,
  classCounts: Record<string, number>,
  tier: number | null = 3,
): AttributionObservation {
  return {
    metric,
    delta,
    classCounts,
    scopeTouched: "orch",
    tier,
    recordedAt: 0,
  };
}

/**
 * Build a per-metric fixture where class `hi` drives a big delta and class `lo`
 * drives a small one, plus empty windows so σ0/β0 are anchored. Deterministic
 * λ/k pinned so the fit is reproducible.
 */
function twoClassRows(metric: string, dir: 1 | -1): AttributionObservation[] {
  // hi has a large marginal effect, lo a small one. Empty windows anchor drift.
  const rows: AttributionObservation[] = [];
  for (let i = 1; i <= 6; i++) {
    rows.push(obs(metric, dir * 10 * i, { hi: i, lo: 0 }, 3));
    rows.push(obs(metric, dir * 1 * i, { hi: 0, lo: i }, 1));
  }
  // Empty (zero-merge) windows — the null-model rows.
  for (let i = 0; i < 4; i++) rows.push(obs(metric, 0, {}, null));
  return rows;
}

const PIN = { lambda: 0.001, noiseFloorK: 2 } as const;

describe("outcome-attribution impact-ranking lens (#3283)", () => {
  test("ranks producer classes by favorable impact per cost, descending", () => {
    const rows = twoClassRows("test_count", 1);
    const ranking = getTopImpactProducerClasses(rows, {
      metricDirections: { test_count: "up" },
      estimatorOpts: PIN,
    });

    assert.equal(ranking.metricCount, 1, "one metric folded");
    const classes = ranking.rows.map((r) => r.producerClass);
    assert.deepEqual(
      classes,
      ["hi", "lo"],
      "hi (big favorable delta) ranks above lo",
    );
    // Both rows carry the full posture (never a bare estimate).
    for (const r of ranking.rows) {
      assert.equal(typeof r.impactPerCost, "number");
      assert.equal(typeof r.favorableImpact, "number");
      assert.equal(typeof r.identifiabilitySuspect, "boolean");
      assert.equal(typeof r.belowNoiseFloor, "boolean");
      assert.ok(r.contributions.length >= 1, "carries per-metric breakdown");
    }
    // The favorable impact for an "up" metric preserves the positive sign.
    const hi = ranking.rows.find((r) => r.producerClass === "hi")!;
    assert.ok(hi.favorableImpact > 0, "hi favorable impact is positive");
    assert.equal(hi.meanTier, 3, "hi contributed only at tier 3");
  });

  test('a "down" metric flips the sign — a drop is a favorable win', () => {
    // Same magnitudes but the metric is lower-is-better and the deltas are
    // NEGATIVE (the metric dropped, which is GOOD). With direction "down" the
    // favorable effect must come out POSITIVE.
    const rows = twoClassRows("brier", -1);
    const ranking = getTopImpactProducerClasses(rows, {
      metricDirections: { brier: "down" },
      estimatorOpts: PIN,
    });
    const hi = ranking.rows.find((r) => r.producerClass === "hi")!;
    assert.ok(
      hi.favorableImpact > 0,
      "a lower-is-better metric that dropped yields positive favorable impact",
    );
    const c = hi.contributions[0];
    assert.ok(c.directed, "contribution marked directed");
    assert.ok(c.beta < 0, "raw signed beta preserved (negative)");
    assert.ok(c.favorable > 0, "favorable orientation flips the sign");
  });

  test("cost proxy: a shallow-tier class out-ranks a deep-tier class at equal impact", () => {
    // Two classes with the SAME favorable delta magnitude but different tiers.
    const rows: AttributionObservation[] = [];
    for (let i = 1; i <= 6; i++) {
      rows.push(obs("m", 5 * i, { shallow: i, deep: 0 }, 1)); // T1 — cheap
      rows.push(obs("m", 5 * i, { shallow: 0, deep: i }, 4)); // T4 — expensive
    }
    for (let i = 0; i < 4; i++) rows.push(obs("m", 0, {}, null));

    const ranking = getTopImpactProducerClasses(rows, {
      metricDirections: { m: "up" },
      estimatorOpts: PIN,
    });
    const shallow = ranking.rows.find((r) => r.producerClass === "shallow")!;
    const deep = ranking.rows.find((r) => r.producerClass === "deep")!;
    assert.equal(shallow.meanTier, 1);
    assert.equal(deep.meanTier, 4);
    assert.ok(
      shallow.impactPerCost > deep.impactPerCost,
      "cheaper (shallow-tier) class ranks higher per cost at equal impact",
    );
    assert.equal(
      ranking.rows[0].producerClass,
      "shallow",
      "shallow leads the ranking",
    );
  });

  test("onlyConfident drops suspect/below-floor rows explicitly; default keeps them", () => {
    // A collinear pair (hi2 duplicates hi) is identifiability-suspect. Default
    // must SURFACE it with the flag; onlyConfident must drop it.
    const rows: AttributionObservation[] = [];
    for (let i = 1; i <= 6; i++) {
      rows.push(obs("m", 10 * i, { hi: i, hi2: i }, 3)); // perfectly collinear
    }
    for (let i = 0; i < 4; i++) rows.push(obs("m", 0, {}, null));

    const withFlags = getTopImpactProducerClasses(rows, {
      metricDirections: { m: "up" },
      estimatorOpts: PIN,
    });
    const anySuspect = withFlags.rows.some((r) => r.identifiabilitySuspect);
    assert.ok(anySuspect, "collinear pair surfaced as identifiability-suspect");

    const confident = getTopImpactProducerClasses(rows, {
      metricDirections: { m: "up" },
      estimatorOpts: PIN,
      onlyConfident: true,
    });
    assert.ok(
      confident.rows.every(
        (r) => !r.identifiabilitySuspect && !r.belowNoiseFloor,
      ),
      "onlyConfident yields no suspect/below-floor rows",
    );
  });

  test("topN caps the ranking after sorting", () => {
    const rows = twoClassRows("m", 1);
    const capped = getTopImpactProducerClasses(rows, {
      metricDirections: { m: "up" },
      estimatorOpts: PIN,
      topN: 1,
    });
    assert.equal(capped.rows.length, 1, "topN=1 returns one row");
    assert.equal(capped.rows[0].producerClass, "hi", "the single row is the top one");
  });

  test("dark/empty ledger → rows:[] , metricCount:0", () => {
    const empty = getTopImpactProducerClasses([], {});
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.metricCount, 0);

    // Only empty windows (no non-zero class columns) → no ranked classes.
    const onlyEmpty = getTopImpactProducerClasses(
      [obs("m", 0, {}, null), obs("m", 0, {}, null)],
      { estimatorOpts: PIN },
    );
    assert.deepEqual(onlyEmpty.rows, []);
    assert.equal(onlyEmpty.metricCount, 1, "the metric was seen (empty windows)");
  });

  test("no direction supplied → raw signed β, contribution marked not-directed", () => {
    const rows = twoClassRows("m", 1);
    const ranking = getTopImpactProducerClasses(rows, { estimatorOpts: PIN });
    const hi = ranking.rows.find((r) => r.producerClass === "hi")!;
    const c = hi.contributions[0];
    assert.equal(c.directed, false, "no direction ⇒ not directed");
    assert.equal(c.favorable, c.beta, "favorable == raw signed beta");
  });

  test("PURE — same input → same output, no argument mutation", () => {
    const rows = twoClassRows("m", 1);
    const snapshot = JSON.stringify(rows);
    const a = getTopImpactProducerClasses(rows, {
      metricDirections: { m: "up" },
      estimatorOpts: PIN,
    });
    const b = getTopImpactProducerClasses(rows, {
      metricDirections: { m: "up" },
      estimatorOpts: PIN,
    });
    assert.deepEqual(a, b, "deterministic: same input → same output");
    assert.equal(JSON.stringify(rows), snapshot, "input not mutated");
  });

  test("folds impact across multiple metrics into one per-class score", () => {
    // A class that helps on TWO metrics accumulates both favorable effects.
    const rows: AttributionObservation[] = [];
    for (let i = 1; i <= 6; i++) {
      rows.push(obs("m1", 10 * i, { multi: i }, 2));
      rows.push(obs("m2", 8 * i, { multi: i }, 2));
    }
    for (let i = 0; i < 4; i++) {
      rows.push(obs("m1", 0, {}, null));
      rows.push(obs("m2", 0, {}, null));
    }
    const ranking = getTopImpactProducerClasses(rows, {
      metricDirections: { m1: "up", m2: "up" },
      estimatorOpts: PIN,
    });
    assert.equal(ranking.metricCount, 2, "two metrics folded");
    const multi = ranking.rows.find((r) => r.producerClass === "multi")!;
    assert.equal(
      multi.contributions.length,
      2,
      "class contribution recorded once per metric",
    );
    const metrics = multi.contributions.map((c) => c.metric).sort();
    assert.deepEqual(metrics, ["m1", "m2"]);
  });
});
