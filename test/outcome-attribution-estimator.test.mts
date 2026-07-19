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
    nonZeroObservationCount: number;
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
    assert.equal(m.sigma0Source, "empty-windows", "empty windows fed σ0");
    assert.ok(Math.abs(m.sigma0! - 0.8165) < 0.01, `σ0 ~0.816, got ${m.sigma0}`);
    assert.equal(m.emptyWindowCount, 6);

    const big = effectOf(m, "big");
    const tiny = effectOf(m, "tiny");
    // big's |β| (~10) far exceeds k·σ0 (~1.6) → NOT below noise floor.
    assert.equal(big.belowNoiseFloor, false, `big β=${big.beta} should beat floor`);
    // tiny's |β| is within k·σ0 → below noise floor.
    assert.equal(tiny.belowNoiseFloor, true, `tiny β=${tiny.beta} should be below floor`);
  });

  test("no empty windows → σ0 falls back to residual variance (issue #3488)", () => {
    // A cleanly-linear metric (Δ = 5·a, no noise) with ≥ NOISE_FLOOR_K non-zero
    // observations per class so the minimum-observation guard does NOT fire —
    // isolating the residual-fallback behavior. Pre-#3488 σ0 was null here and
    // belowNoiseFloor could never fire; now σ0 comes from the residuals.
    const rows = [
      obs("edge", 5, { a: 1 }),
      obs("edge", 10, { a: 2 }),
      obs("edge", 15, { a: 3 }),
    ];
    const m = onlyMetric(rows, { lambda: 0.01, noiseFloorK: 2 });
    assert.equal(m.emptyWindowCount, 0, "no empty windows");
    // σ0 is now non-null via the residual fallback, tagged as such.
    assert.ok(m.sigma0 !== null, "σ0 derived from residual variance, not null");
    assert.equal(m.sigma0Source, "residual");
    // The fit is near-perfect, so residuals (hence σ0) are tiny; a's β (~5) far
    // exceeds k·σ0 → the noise-floor comparison does NOT flag it. And a has 3
    // non-zero observations (≥ k=2) so the min-observation guard is silent too.
    const a = effectOf(m, "a");
    assert.equal(a.nonZeroObservationCount, 3);
    assert.equal(
      a.belowNoiseFloor,
      false,
      "well-observed strong effect is above the residual floor",
    );
  });
});

describe("attribution estimator — noise floor at high merge cadence (issue #3488)", () => {
  test("N=1 class is forced belowNoiseFloor by the minimum-observation guard, even with a huge β", () => {
    // The dev_orch N=1 case from #3487: a class observed in a SINGLE window, with
    // a large fitted β. Its effect is under-determined and must NOT surface as
    // signal. There are no empty windows (high merge cadence), so pre-#3488 σ0
    // stayed null and belowNoiseFloor could never fire; the minimum-observation
    // guard now flags it regardless of σ0 or β magnitude.
    // `common` drives a clean strong signal Δ ≈ 6·common; `rare` appears in
    // exactly ONE window with a modest extra bump. Residuals stay small so
    // `common`'s large β clears the floor — isolating the min-observation guard
    // as the ONLY reason `rare` is flagged.
    const rows: AttributionObservation[] = [
      obs("edge", 6, { common: 1 }),
      obs("edge", 12, { common: 2 }),
      obs("edge", 18, { common: 3 }),
      obs("edge", 24, { common: 4 }),
      obs("edge", 33, { common: 5, rare: 1 }), // 6·5 + 3·1 = 33
    ];
    const m = onlyMetric(rows, { lambda: 0.05, noiseFloorK: 2 });
    assert.equal(m.emptyWindowCount, 0, "no empty windows (high cadence)");

    const rare = effectOf(m, "rare");
    assert.equal(rare.nonZeroObservationCount, 1, "rare seen in exactly 1 window");
    assert.equal(
      rare.belowNoiseFloor,
      true,
      "N=1 class flagged below noise floor by the min-observation guard",
    );

    // A well-observed class with a genuinely strong effect is NOT flagged — the
    // guard must not over-fire and blanket-suppress real signal.
    const common = effectOf(m, "common");
    assert.ok(
      common.nonZeroObservationCount >= 2,
      "common is well-observed (≥ k windows)",
    );
    assert.equal(
      common.belowNoiseFloor,
      false,
      "well-observed strong effect stays above the floor",
    );
  });

  test("residual fallback lets a small well-observed effect be flagged below-floor at high cadence", () => {
    // No empty windows, but a class whose β is small relative to the residual
    // noise. Pre-#3488 this could NEVER be flagged (σ0 null). Now the residual
    // fallback supplies σ0 and the noise-floor comparison fires. The class has
    // ≥ NOISE_FLOOR_K non-zero observations so the min-observation guard is NOT
    // what does the flagging here — the noise-floor comparison is.
    const rows: AttributionObservation[] = [
      // Metric is essentially pure noise around ~0 with a tiny `weak` signal, so
      // residual std-dev is large and |β_weak| lands within k·σ0.
      obs("edge", 5, { weak: 1 }),
      obs("edge", -4, { weak: 2 }),
      obs("edge", 6, { weak: 3 }),
      obs("edge", -5, { weak: 4 }),
      obs("edge", 4, { weak: 5 }),
      obs("edge", -6, { weak: 6 }),
    ];
    const m = onlyMetric(rows, { lambda: 0.1, noiseFloorK: 2 });
    assert.equal(m.emptyWindowCount, 0);
    assert.ok(m.sigma0 !== null, "residual fallback supplies σ0");
    assert.equal(m.sigma0Source, "residual");

    const weak = effectOf(m, "weak");
    assert.ok(
      weak.nonZeroObservationCount >= 2,
      "weak is well-observed, so the min-observation guard is not the cause",
    );
    // |β_weak| is small vs the large residual noise → below floor via the
    // noise-floor comparison, which is only possible thanks to the fallback.
    assert.ok(
      Math.abs(weak.beta) <= 2 * m.sigma0!,
      `|β_weak|=${weak.beta} within k·σ0=${2 * m.sigma0!}`,
    );
    assert.equal(
      weak.belowNoiseFloor,
      true,
      "small effect flagged below the residual-derived floor",
    );
  });

  test("empty input still yields no metrics (σ0Source path is a clean no-op)", () => {
    assert.deepEqual(estimateMarginalEffects([]), { metrics: [] });
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
