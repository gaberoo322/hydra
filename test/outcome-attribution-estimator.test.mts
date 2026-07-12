/**
 * Regression tests for the outcome-attribution ridge marginal-effect estimator
 * (issue #2630, epic #2628): `src/outcome-attribution/estimator.ts`.
 *
 * The estimator is PURE / zero-I/O, so these tests need no Redis — they build
 * `AttributionObservation[]` fixtures directly and assert the fit.
 *
 * Acceptance criteria this guards (from issue #2630):
 *   AC1 — Ridge-LS recovers known β_c on a synthetic fixture with injected
 *         co-occurrence, within tolerance.
 *   AC2 — A perfectly collinear class pair yields FINITE estimates (no
 *         singular-matrix throw) and is FLAGGED unidentifiable, not falsely
 *         split — and column-variance alone MISSES it (regression on the
 *         variance-only rejected alternative).
 *   AC3 — σ0 is computed from empty-window deltas and effects with |β_c| ≤ k·σ0
 *         are marked below-noise-floor.
 *   AC4 — An always-on (near-constant-count) class is flagged low-identifiability
 *         rather than reported as zero effect.
 *   AC5 — The estimator performs zero I/O (pure function of the array). Asserted
 *         structurally: same input → same output, no argument mutation.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { AttributionObservation } from "../src/redis/attribution-ledger.ts";
import {
  estimateMarginalEffects,
  computeSigmaZero,
  computeIdentifiabilityFlags,
} from "../src/outcome-attribution/estimator.ts";
import {
  solveRidge,
  gaussianSolve,
  populationStd,
} from "../src/metrics/math.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function obs(
  metric: string,
  delta: number,
  classCounts: Record<string, number>,
): AttributionObservation {
  return {
    metric,
    delta,
    classCounts,
    scopeTouched: "orch",
    tier: 3,
    recordedAt: 0,
  };
}

/** The single fitted metric, asserting exactly one metric was produced. */
function onlyMetric(rows: AttributionObservation[], opts = {}) {
  const est = estimateMarginalEffects(rows, opts);
  assert.equal(est.metrics.length, 1, "expected exactly one metric fit");
  return est.metrics[0];
}

function effectOf(metric: { effects: { producerClass: string }[] }, cls: string) {
  const e = metric.effects.find((x) => x.producerClass === cls);
  assert.ok(e, `expected an effect for class ${cls}`);
  return e as (typeof metric.effects)[number] & {
    beta: number;
    lowVariance: boolean;
    collinear: boolean;
    collinearWith: string[];
    belowNoiseFloor: boolean;
    identifiabilitySuspect: boolean;
  };
}

describe("attribution estimator — ridge recovery (AC1)", () => {
  test("recovers known β_c with injected co-occurrence, within tolerance", () => {
    // True model: Δ = 1 + 2·A - 1·B, A and B co-occur (correlated but not
    // collinear) — the case a write-time heuristic split would bias.
    const design: Array<[a: number, b: number]> = [
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 1],
      [1, 2],
      [4, 3],
      [2, 0],
      [0, 3],
      [5, 2],
      [3, 4],
    ];
    const rows = design.map(([a, b]) =>
      obs("edge", 1 + 2 * a - 1 * b, { classA: a, classB: b }),
    );

    const m = onlyMetric(rows, { lambda: 0.05 });
    assert.ok(Math.abs(m.intercept - 1) < 0.3, `intercept ~1, got ${m.intercept}`);
    const a = effectOf(m, "classA");
    const b = effectOf(m, "classB");
    assert.ok(Math.abs(a.beta - 2) < 0.2, `βA ~2, got ${a.beta}`);
    assert.ok(Math.abs(b.beta - -1) < 0.2, `βB ~-1, got ${b.beta}`);
    // Well-identified, non-degenerate columns are not flagged.
    assert.equal(a.identifiabilitySuspect, false);
    assert.equal(b.identifiabilitySuspect, false);
  });
});

describe("attribution estimator — collinearity (AC2)", () => {
  test("perfectly collinear pair: finite β, flagged, not thrown", () => {
    // classB is a perfect duplicate of classA. Plain OLS would throw / NaN;
    // ridge must return FINITE estimates and flag both as collinear.
    const counts = [1, 2, 3, 4, 5, 6];
    const rows = counts.map((c) =>
      obs("edge", 10 + 3 * c, { classA: c, classB: c }),
    );

    let m: ReturnType<typeof onlyMetric>;
    assert.doesNotThrow(() => {
      m = onlyMetric(rows, { lambda: 0.1 });
    });
    const a = effectOf(m!, "classA");
    const b = effectOf(m!, "classB");
    assert.ok(Number.isFinite(a.beta), "βA finite");
    assert.ok(Number.isFinite(b.beta), "βB finite");
    // Both flagged collinear, referencing each other; NOT falsely split as if
    // each independently determined.
    assert.equal(a.collinear, true, "classA flagged collinear");
    assert.equal(b.collinear, true, "classB flagged collinear");
    assert.deepEqual(a.collinearWith, ["classB"]);
    assert.deepEqual(b.collinearWith, ["classA"]);
    assert.equal(a.identifiabilitySuspect, true);
    assert.equal(b.identifiabilitySuspect, true);
  });

  test("variance-only would MISS collinearity — the duplicate columns have HIGH variance", () => {
    // Regression on the rejected variance-only alternative: both duplicate
    // columns have identical, high variance, so a low-variance check does NOT
    // fire — only the pairwise-collinearity flag catches them.
    const counts = [1, 2, 3, 4, 5, 6];
    const rows = counts.map((c) =>
      obs("edge", 10 + 3 * c, { classA: c, classB: c }),
    );
    const m = onlyMetric(rows, { lambda: 0.1 });
    const a = effectOf(m, "classA");
    const b = effectOf(m, "classB");
    assert.equal(a.lowVariance, false, "high-variance column not low-variance");
    assert.equal(b.lowVariance, false, "high-variance column not low-variance");
    // But collinearity DID fire — proving the two flags are distinct + needed.
    assert.equal(a.collinear, true);
    assert.equal(b.collinear, true);
  });
});

describe("attribution estimator — σ0 & below-noise-floor (AC3)", () => {
  test("σ0 from empty windows only; small effects marked below-noise-floor", () => {
    // Empty windows with spread deltas set σ0; a big-effect class beats the
    // floor, a tiny-effect class does not.
    const rows: AttributionObservation[] = [
      // Empty (zero-merge) windows → drive σ0. deltas: -1, 0, 1 → std ~0.816.
      obs("edge", -1, {}),
      obs("edge", 0, {}),
      obs("edge", 1, {}),
      obs("edge", -1, {}),
      obs("edge", 0, {}),
      obs("edge", 1, {}),
      // big co-occurs strongly with delta; tiny barely moves it.
      obs("edge", 20, { big: 2, tiny: 1 }),
      obs("edge", 40, { big: 4, tiny: 2 }),
      obs("edge", 10, { big: 1, tiny: 3 }),
      obs("edge", 30, { big: 3, tiny: 1 }),
    ];
    const m = onlyMetric(rows, { lambda: 0.05, noiseFloorK: 2 });

    assert.ok(m.sigma0 !== null, "σ0 computed");
    assert.ok(Math.abs(m.sigma0! - 0.8165) < 0.01, `σ0 ~0.816, got ${m.sigma0}`);
    assert.equal(m.emptyWindowCount, 6);

    const big = effectOf(m, "big");
    const tiny = effectOf(m, "tiny");
    // big's |β| (~10) far exceeds k·σ0 (~1.6) → NOT below noise floor.
    assert.equal(big.belowNoiseFloor, false, `big β=${big.beta} should beat floor`);
    // tiny's |β| is within k·σ0 → below noise floor.
    assert.equal(tiny.belowNoiseFloor, true, `tiny β=${tiny.beta} should be below floor`);
  });

  test("no empty windows → σ0 null and no below-noise-floor markers", () => {
    const rows = [
      obs("edge", 5, { a: 1 }),
      obs("edge", 10, { a: 2 }),
      obs("edge", 15, { a: 3 }),
    ];
    const m = onlyMetric(rows);
    assert.equal(m.sigma0, null);
    assert.equal(m.emptyWindowCount, 0);
    for (const e of m.effects) {
      assert.equal(e.belowNoiseFloor, false, "no floor without σ0");
    }
  });
});

describe("attribution estimator — always-on class (AC4)", () => {
  test("near-constant column flagged low-identifiability, not zero-effect", () => {
    // classAlways appears with the SAME count in every window (always-on).
    // classVar varies. classAlways's β is weakly identified — flag it, don't
    // silently emit 0.
    const rows: AttributionObservation[] = [
      obs("edge", 5, { classAlways: 1, classVar: 1 }),
      obs("edge", 8, { classAlways: 1, classVar: 2 }),
      obs("edge", 11, { classAlways: 1, classVar: 3 }),
      obs("edge", 14, { classAlways: 1, classVar: 4 }),
      obs("edge", 17, { classAlways: 1, classVar: 5 }),
    ];
    const m = onlyMetric(rows, { lambda: 0.05 });
    const always = effectOf(m, "classAlways");
    assert.equal(always.lowVariance, true, "constant column flagged low-variance");
    assert.equal(always.identifiabilitySuspect, true);
    // Crucially NOT reported as a bare zero effect — it carries a flag so a
    // reader can tell "cannot determine" from "no effect".
    // (β may be near zero numerically, but the flag makes intent explicit.)
    assert.equal(always.collinear, false, "not collinear, just constant");
  });
});

describe("attribution estimator — purity & per-metric independence (AC5)", () => {
  test("pure: identical input → identical output, no argument mutation", () => {
    const rows = [
      obs("edge", 5, { a: 1 }),
      obs("edge", 9, { a: 2 }),
      obs("edge", 13, { a: 3 }),
    ];
    const snapshot = JSON.stringify(rows);
    const a = estimateMarginalEffects(rows);
    const b = estimateMarginalEffects(rows);
    assert.deepEqual(a, b, "deterministic");
    assert.equal(JSON.stringify(rows), snapshot, "input array not mutated");
  });

  test("one ridge fit per metric; no cross-metric coefficient leakage", () => {
    const rows: AttributionObservation[] = [
      obs("edge", 10, { a: 1 }),
      obs("edge", 20, { a: 2 }),
      obs("edge", 30, { a: 3 }),
      obs("brier", -1, { a: 1 }),
      obs("brier", -2, { a: 2 }),
      obs("brier", -3, { a: 3 }),
    ];
    const est = estimateMarginalEffects(rows, { lambda: 0.01 });
    assert.equal(est.metrics.length, 2);
    const edge = est.metrics.find((x) => x.metric === "edge")!;
    const brier = est.metrics.find((x) => x.metric === "brier")!;
    // edge slope ~ +10, brier slope ~ -1 — independent, no leakage.
    assert.ok(effectOf(edge, "a").beta > 5, "edge βa positive & large");
    assert.ok(effectOf(brier, "a").beta < 0, "brier βa negative");
  });

  test("empty input → no metrics, no throw", () => {
    assert.deepEqual(estimateMarginalEffects([]), { metrics: [] });
  });
});

describe("attribution estimator — solver primitives", () => {
  test("solveRidge does not regularize the intercept", () => {
    // y = 7 exactly, one all-1 intercept column + one zero-variance dummy? Keep
    // it simple: y constant → intercept should recover ~7 regardless of λ, since
    // the intercept diagonal is unregularized (n on the diagonal, no λ).
    const X = [
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
    ];
    const y = [7, 7, 7, 7];
    const beta = solveRidge(X, y, 5); // large λ on the slope only
    // Intercept unregularized → close to 7; slope shrunk toward 0 by big λ.
    assert.ok(Math.abs(beta[0] - 7) < 0.5, `intercept ~7, got ${beta[0]}`);
    assert.ok(Math.abs(beta[1]) < 0.5, `slope shrunk ~0, got ${beta[1]}`);
  });

  test("gaussianSolve solves a simple 2x2 and does not mutate inputs", () => {
    const A = [
      [2, 1],
      [1, 3],
    ];
    const b = [5, 10];
    const Acopy = A.map((r) => [...r]);
    const bcopy = [...b];
    const x = gaussianSolve(A, b);
    // 2x+y=5, x+3y=10 → x=1, y=3.
    assert.ok(Math.abs(x[0] - 1) < 1e-9);
    assert.ok(Math.abs(x[1] - 3) < 1e-9);
    assert.deepEqual(A, Acopy, "A not mutated");
    assert.deepEqual(b, bcopy, "b not mutated");
  });

  test("populationStd basics", () => {
    assert.equal(populationStd([]), 0);
    assert.equal(populationStd([5]), 0);
    assert.ok(Math.abs(populationStd([-1, 0, 1]) - 0.8164965809) < 1e-9);
  });
});

// ---------------------------------------------------------------------------
// Extracted lenses (issue #3242) — the two clusters `fitMetric` used to inline
// are now named exports; test them in isolation, imported DIRECTLY from
// estimator.ts (NOT re-exported through index.ts, which is out of scope).
// ---------------------------------------------------------------------------

describe("computeSigmaZero — σ0 lens (issue #3242)", () => {
  test("std-dev over empty-window deltas; matches the inline AC3 value (0.8165)", () => {
    // Same empty windows as the AC3 fixture: deltas -1,0,1,-1,0,1 → std ~0.8165.
    // Non-empty rows carry counts and MUST be excluded from σ0.
    const rows: AttributionObservation[] = [
      obs("edge", -1, {}),
      obs("edge", 0, {}),
      obs("edge", 1, {}),
      obs("edge", -1, {}),
      obs("edge", 0, {}),
      obs("edge", 1, {}),
      obs("edge", 99, { big: 2 }),
      obs("edge", 42, { big: 4 }),
    ];
    const s = computeSigmaZero(rows);
    assert.ok(s !== null, "σ0 computed from the empty windows");
    assert.ok(Math.abs(s! - 0.8165) < 1e-3, `σ0 ~0.8165, got ${s}`);
  });

  test("treats an all-zero-count window as empty (not just literal {})", () => {
    // A window whose counts are all 0 IS an empty window — σ0 must include it.
    const rows: AttributionObservation[] = [
      obs("edge", 2, { a: 0, b: 0 }),
      obs("edge", 4, {}),
      obs("edge", 6, { a: 0 }),
    ];
    const s = computeSigmaZero(rows);
    // deltas 2,4,6 → mean 4, population std = sqrt(8/3) ≈ 1.63299.
    assert.ok(s !== null);
    assert.ok(Math.abs(s! - 1.6329931619) < 1e-6, `σ0 over all three, got ${s}`);
  });

  test("no empty windows → null", () => {
    const rows: AttributionObservation[] = [
      obs("edge", 5, { a: 1 }),
      obs("edge", 9, { a: 2 }),
    ];
    assert.equal(computeSigmaZero(rows), null);
  });

  test("empty row set → null", () => {
    assert.equal(computeSigmaZero([]), null);
  });

  test("does not mutate its input", () => {
    const rows: AttributionObservation[] = [obs("edge", 1, {}), obs("edge", -1, {})];
    const snap = JSON.stringify(rows);
    computeSigmaZero(rows);
    assert.equal(JSON.stringify(rows), snap, "input untouched");
  });
});

describe("computeIdentifiabilityFlags — identifiability lens (issue #3242)", () => {
  const cfg = { lowVarianceEps: 1e-9, collinearityThreshold: 0.999 };

  test("takes CLASS columns only (intercept excluded) and returns per-class records in order", () => {
    // Two independent, well-varying columns → neither flag fires; order preserved.
    const flags = computeIdentifiabilityFlags(
      [
        [1, 2, 3, 4],
        [4, 1, 3, 2],
      ],
      ["classA", "classB"],
      cfg,
    );
    assert.deepEqual(
      flags.map((f) => f.producerClass),
      ["classA", "classB"],
    );
    for (const f of flags) {
      assert.equal(f.lowVariance, false);
      assert.equal(f.collinear, false);
      assert.deepEqual(f.collinearWith, []);
    }
  });

  test("collinear pair mutually flagged (matches AC2), variance-only would MISS it", () => {
    // Duplicate columns: correlate at 1.0 yet each has HIGH variance.
    const col = [1, 2, 3, 4, 5, 6];
    const flags = computeIdentifiabilityFlags(
      [[...col], [...col]],
      ["classA", "classB"],
      cfg,
    );
    const a = flags.find((f) => f.producerClass === "classA")!;
    const b = flags.find((f) => f.producerClass === "classB")!;
    assert.equal(a.collinear, true);
    assert.equal(b.collinear, true);
    assert.deepEqual(a.collinearWith, ["classB"]);
    assert.deepEqual(b.collinearWith, ["classA"]);
    // High-variance columns → the low-variance flag does NOT fire (two distinct flags).
    assert.equal(a.lowVariance, false);
    assert.equal(b.lowVariance, false);
  });

  test("constant column flagged low-variance, not collinear (matches AC4)", () => {
    const flags = computeIdentifiabilityFlags(
      [
        [1, 1, 1, 1, 1], // always-on / constant
        [1, 2, 3, 4, 5], // varies
      ],
      ["classAlways", "classVar"],
      cfg,
    );
    const always = flags.find((f) => f.producerClass === "classAlways")!;
    const varying = flags.find((f) => f.producerClass === "classVar")!;
    assert.equal(always.lowVariance, true, "constant column low-variance");
    assert.equal(always.collinear, false, "constant column not collinear");
    assert.equal(varying.lowVariance, false);
  });

  test("empty class set → no flags", () => {
    assert.deepEqual(computeIdentifiabilityFlags([], [], cfg), []);
  });

  test("does not mutate its input columns", () => {
    const cols = [
      [1, 2, 3],
      [3, 2, 1],
    ];
    const snap = JSON.stringify(cols);
    computeIdentifiabilityFlags(cols, ["a", "b"], cfg);
    assert.equal(JSON.stringify(cols), snap, "columns untouched");
  });
});
