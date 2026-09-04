/**
 * Metrics math primitives — the canonical home for percentile arithmetic.
 *
 * Before issue #2613 the `percentile` function was defined four times across
 * the metrics + aggregators families, each with subtly different signatures and
 * filter semantics. A single correctness fix (a NaN guard, a null-on-empty
 * invariant) had to be applied in four places, and the four implementations had
 * already diverged. This leaf concentrates the two genuinely distinct
 * statistics — nearest-rank and linear-interpolated — behind named, documented
 * contracts so each divergence is a deliberate, visible choice rather than an
 * accident of where the code happened to live.
 *
 * Pure module: no Redis, no Express, no module-level state. Independently
 * testable on synthetic numeric arrays.
 *
 * The z-score statistics (`meanStd`, `zScore`, `classifyZ`) were relocated here
 * verbatim from `src/aggregators/anomaly-detector.ts` (issue #2883), then
 * deleted in issue #4356 along with `anomaly-detector.ts` itself once the
 * `/explore/anomalies` backend route lost its last consumer — a repo-wide grep
 * confirmed zero remaining callers.
 *
 * The variants differ along three axes, each pinned by an existing caller/test:
 *   - `p` domain: nearest-rank-fraction takes p in 0..1; the others take p in
 *     0..100.
 *   - empty-input result: nearest-rank variants return `null`; the interpolated
 *     variant returns `0` (its callers surface a numeric latency, not a gauge).
 *   - NaN handling: `percentileNearestRankFraction` trusts its (already
 *     pre-filtered) input; `percentileNearestRank` and the interpolated variant
 *     filter non-finite values first.
 */

/**
 * Nearest-rank percentile where `p` is a FRACTION in 0..1 (e.g. 0.5, 0.95).
 * Nearest-rank index `floor((n-1) * p)`, clamped to the last index. Returns
 * `null` for an empty array. Does NOT filter non-finite inputs — callers pass
 * an already-filtered array (grounding-duration buckets drop non-positive
 * samples upstream).
 *
 * Contract extracted verbatim from the pre-#2613 `metrics/trend.ts` helper
 * (originally #341, extracted to a function in #2126).
 */
export function percentileNearestRankFraction(
  arr: number[],
  p: number,
): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

/**
 * Nearest-rank percentile where `p` is a PERCENT in 0..100 (e.g. 50, 95).
 * Filters non-finite values first (NaN/Infinity are dropped), then uses the
 * nearest-rank index `ceil((p/100) * n) - 1` (p clamped to 0..100). Returns
 * `null` when no finite values remain.
 *
 * Contract extracted verbatim from the pre-#2613 `metrics/quality-gates.ts`
 * helper (issue #212).
 */
export function percentileNearestRank(
  values: number[],
  p: number,
): number | null {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const clampedP = Math.max(0, Math.min(100, p));
  const rank = Math.max(1, Math.ceil((clampedP / 100) * sorted.length));
  return sorted[rank - 1];
}

/** Round `n` to `decimals` decimal places (no float noise). */
function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/**
 * Linear-interpolated percentile (`p` in 0..100) over an ALREADY-SORTED
 * ascending array. Rounds the result to `decimals` places. Returns `0` for an
 * empty array. This is the sharp-edged core: the caller owns the sort. Prefer
 * `percentileInterpolated` unless you already hold a sorted array (e.g. the
 * instrumentation ring snapshot sorts once and computes p50/p95/p99 together).
 *
 * Contract extracted verbatim from the pre-#2613 private `metrics/
 * instrumentation.ts` helper (issue #2353), which sorts once per label ring.
 */
export function percentileInterpolatedSorted(
  sorted: number[],
  p: number,
  decimals: number,
): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return roundTo(sorted[0], decimals);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return roundTo(sorted[lo], decimals);
  const frac = rank - lo;
  return roundTo(sorted[lo] + (sorted[hi] - sorted[lo]) * frac, decimals);
}

/**
 * Linear-interpolated percentile (`p` in 0..100) over an unsorted numeric
 * sample. Filters non-finite values, sorts ascending, then delegates to
 * `percentileInterpolatedSorted`. Returns `0` for empty/all-non-finite input.
 *
 * Contract extracted verbatim from the pre-#2613 `aggregators/autonomy-rate.ts`
 * helper (rounds to 1 decimal place by default — the PR-latency-minutes
 * resolution its caller reports).
 */
export function percentileInterpolated(
  values: number[],
  p: number,
  decimals = 1,
): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return percentileInterpolatedSorted(xs, p, decimals);
}

// ---------------------------------------------------------------------------
// Ridge-regression linear algebra — relocated verbatim from
// src/outcome-attribution/estimator.ts (issue #2917). Domain-neutral numeric
// primitives: they take and return plain number[][] / number[], carry no
// attribution-domain knowledge, and are hand-rolled (≤16 cols) to stay off the
// ADR-0005 runtime-dependency allowlist. Same relocation direction as the
// #2883 z-score move above.
// ---------------------------------------------------------------------------

/**
 * Solve the ridge normal equations `(XᵀX + λ·D) β = Xᵀy` where
 * `D = diag(0, 1, …, 1)` leaves the intercept (column 0) unregularized.
 *
 * With `λ > 0` the regressed diagonal is strictly positive, so the system is
 * non-singular even under perfectly collinear class columns — the solve returns
 * finite β, never throws. The intercept column is 1s (non-degenerate) so its
 * unregularized diagonal entry is `n > 0`.
 */
export function solveRidge(X: number[][], y: number[], lambda: number): number[] {
  const n = X.length;
  const m = n > 0 ? X[0].length : 0; // intercept + P class columns
  if (m === 0) return [];

  // A = XᵀX + λ·D ; b = Xᵀy
  const A: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  const b: number[] = new Array(m).fill(0);
  for (let i = 0; i < n; i++) {
    const row = X[i];
    const yi = y[i];
    for (let a = 0; a < m; a++) {
      b[a] += row[a] * yi;
      for (let c = 0; c < m; c++) {
        A[a][c] += row[a] * row[c];
      }
    }
  }
  // Regularize every column EXCEPT the intercept (index 0).
  for (let d = 1; d < m; d++) {
    A[d][d] += lambda;
  }

  return gaussianSolve(A, b);
}

/**
 * Solve `A x = b` for a small square system by Gaussian elimination with partial
 * pivoting. `A` is (with `λ > 0` on the class diagonal + a 1s intercept column)
 * non-singular; the pivot guard below is a numerical safety net that returns a
 * finite (0-filled) fallback rather than dividing by zero — the invariant is
 * "never throw".
 */
export function gaussianSolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  // Work on copies (purity: never mutate caller arrays).
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivot: swap in the row with the largest |value| in this column.
    let pivot = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best === 0) {
      /* intentional: a zero pivot means this column is fully degenerate even
         after ridge regularization (should not happen for λ>0, but never throw)
         — leave the corresponding unknown at 0 and continue. */
      continue;
    }
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    // Eliminate below.
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }

  // Back-substitution.
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row][n];
    for (let c = row + 1; c < n; c++) {
      sum -= M[row][c] * x[c];
    }
    const diag = M[row][row];
    x[row] = diag !== 0 ? sum / diag : 0;
  }
  return x;
}

/** Population standard deviation (÷N). Returns 0 for <2 samples. */
export function populationStd(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let ss = 0;
  for (const v of values) {
    const d = v - mean;
    ss += d * d;
  }
  return Math.sqrt(ss / n);
}
