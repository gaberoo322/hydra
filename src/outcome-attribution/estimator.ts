/**
 * Outcome-attribution marginal-effect estimator (issue #2630, epic #2628).
 *
 * The **deep, policy-carrying** module of the attribution spine's estimation
 * slice. Given the RAW observation rows the recorder (#2629) appended to the
 * append-only ledger, it fits — PER LEADING METRIC — a ridge-regularized linear
 * model
 *
 *     Δ_w = β0 + Σ_c β_c · count_{c,w}
 *
 * where `Δ_w` is the window's raw signed outcome delta, `count_{c,w}` is producer
 * class `c`'s merge count in window `w`, and `β_c` is that class's **marginal
 * effect** — the credit the spine assigns to it. This REPLACES the biased
 * write-time heuristic credit split the epic rejects (systematic producer
 * co-occurrence makes a write-time split assign shared credit arbitrarily; a
 * regression over many raw rows disentangles it).
 *
 * Invariants (see the design concept for issue-2630 and the QA trace):
 *
 *   - **PURE / zero-I/O.** Deterministic function of the `AttributionObservation[]`
 *     input only — no Redis, fs, clock, or re-snapshot. Consuming the recorder's
 *     already-computed signed `delta` + `classCounts` verbatim (never
 *     re-deriving them) is what keeps the estimator a pure fit. (AC5.)
 *
 *   - **NEVER throws on a singular/collinear design.** `λ > 0` adds a positive
 *     ridge term to every regressed diagonal entry, so `XᵀX + λI` is invertible
 *     even when two producer columns are perfectly collinear: a collinear pair
 *     yields FINITE estimates (the shared effect split between them), never a
 *     singular-matrix throw. (AC2.)
 *
 *   - **Null-vs-zero discipline.** A weakly-identified class — near-constant
 *     count column (low variance) OR collinear with another column — is FLAGGED
 *     identifiability-suspect, it is NEVER silently reported as `β = 0`. A read
 *     of the coefficient must be able to tell "no effect" apart from "cannot
 *     tell". (AC4.) TWO distinct flags are required: column-variance alone
 *     catches always-on/near-constant columns but MISSES perfect collinearity
 *     (two duplicate columns both have HIGH variance yet neither β is
 *     individually identifiable), so a separate pairwise-collinearity flag is
 *     mandatory.
 *
 *   - **σ0 from empty windows only.** The exogenous-drift floor `σ0` is the
 *     standard deviation of the deltas over the EMPTY (zero-merge,
 *     `classCounts = {}`) windows — the null-model rows the recorder emits.
 *     `|β_c| ≤ k · σ0` sets the below-noise-floor marker: the effect is within
 *     exogenous drift and indistinguishable from noise. (AC3.)
 *
 *   - **Intercept β0 is NOT regularized.** The ridge diagonal carries `0` on the
 *     intercept term. β0 is anchored by the empty/null-model windows and
 *     represents exogenous drift; shrinking it toward zero would bias the
 *     always-on-producer identifiability the epic depends on.
 *
 *   - **Per-metric independence.** Exactly one ridge fit per distinct metric
 *     name; no cross-metric coefficient leakage.
 *
 *   - **Sign-neutral.** Consumes the recorder's raw SIGNED delta as-is — no
 *     direction/favorability normalization (that is the #2631 view's concern).
 *
 *   - **No new runtime dependency.** ≤ 16 classes → a tiny hand-rolled
 *     Gaussian-elimination solve; stays on the ADR-0005 allowlist. `λ` and `k`
 *     are named, env-overridable tunables — not magic literals.
 *
 * This module performs NO I/O and never throws; a degenerate fit (no rows, no
 * live metric) simply yields an empty / all-flagged result.
 */

import type { AttributionObservation } from "../redis/attribution-ledger.ts";
import { solveRidge, populationStd } from "../metrics/math.ts";

// ---------------------------------------------------------------------------
// Tunables (ADR-0005 — named, env-overridable, not magic literals).
// ---------------------------------------------------------------------------

/**
 * Ridge penalty λ. Added to every REGRESSED diagonal entry of the normal
 * equations (never to the intercept) so `XᵀX + λI` is positive-definite and the
 * solve is well-posed even under perfect collinearity. Small: enough to
 * guarantee invertibility without materially shrinking well-identified effects.
 * Env-overridable.
 */
const RIDGE_LAMBDA = numFromEnv("HYDRA_ATTRIBUTION_RIDGE_LAMBDA", 0.1);

/**
 * Below-noise-floor multiplier k. A class effect with `|β_c| ≤ k · σ0` is marked
 * below-noise-floor — within `k` standard deviations of the empty-window
 * exogenous drift, so indistinguishable from noise. Env-overridable.
 */
const NOISE_FLOOR_K = numFromEnv("HYDRA_ATTRIBUTION_NOISE_FLOOR_K", 2);

/**
 * Variance floor for the low-identifiability (near-constant column) flag. A
 * class whose count column has (population) variance `≤` this is treated as
 * always-on / near-constant and flagged weakly-identified. Env-overridable.
 */
const LOW_VARIANCE_EPS = numFromEnv(
  "HYDRA_ATTRIBUTION_LOW_VARIANCE_EPS",
  1e-9,
);

/**
 * Pearson-correlation magnitude at/above which two class columns are treated as
 * collinear (their shared effect is split arbitrarily by the ridge). Both
 * columns of such a pair are flagged. Env-overridable.
 */
const COLLINEARITY_THRESHOLD = numFromEnv(
  "HYDRA_ATTRIBUTION_COLLINEARITY_THRESHOLD",
  0.999,
);

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * The estimated marginal effect of one producer class on one metric, plus the
 * identifiability flags a reader MUST consult before trusting `beta`.
 */
interface ClassEffect {
  /** Producer class name (a column of the design matrix). */
  producerClass: string;
  /** Estimated marginal effect β_c (raw, signed, direction-neutral). */
  beta: number;
  /**
   * `true` when the class column is near-constant (variance `≤ LOW_VARIANCE_EPS`)
   * — an always-on / never-seen producer. Its β is weakly determined by the data
   * and must NOT be read as "no effect".
   */
  lowVariance: boolean;
  /**
   * `true` when the class column is (near-)perfectly collinear with another
   * class column. The ridge splits their shared effect arbitrarily, so neither
   * β is individually identifiable — a variance check alone would MISS this
   * because both columns can have high variance.
   */
  collinear: boolean;
  /**
   * Names of the other class columns this one is collinear with (for the #2631
   * view to surface the ambiguous cluster). Empty when `collinear` is `false`.
   */
  collinearWith: string[];
  /**
   * `true` when `|β| ≤ NOISE_FLOOR_K · σ0` — the effect is within exogenous
   * drift and indistinguishable from noise. Distinct from the identifiability
   * flags: a below-noise-floor effect is well-determined but small.
   */
  belowNoiseFloor: boolean;
  /**
   * Convenience roll-up: `true` when EITHER identifiability flag is set. A `true`
   * value means "β cannot be trusted as this class's individual effect", which
   * is categorically different from `belowNoiseFloor` ("effect measured, small").
   */
  identifiabilitySuspect: boolean;
}

/** The ridge fit for one leading metric. */
export interface MetricEstimate {
  /** Leading-outcome metric name. */
  metric: string;
  /** Unregularized intercept β0 — the exogenous-drift anchor. */
  intercept: number;
  /** One entry per producer class observed for this metric. */
  effects: ClassEffect[];
  /**
   * Exogenous-drift floor: std-dev of the deltas over the EMPTY (zero-merge)
   * windows for this metric. `null` when the metric had no empty windows (then
   * no below-noise-floor marker can be set — every `belowNoiseFloor` is `false`).
   */
  sigma0: number | null;
  /** Total observation rows fitted for this metric (incl. empty windows). */
  observationCount: number;
  /** Count of empty (zero-merge) windows that fed σ0 and anchored β0. */
  emptyWindowCount: number;
}

/** The full estimation over the ledger: one entry per distinct metric. */
export interface AttributionEstimate {
  /** One ridge fit per distinct metric, in first-seen order. */
  metrics: MetricEstimate[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Fit the ridge marginal-effect model over the raw ledger observations, one fit
 * per distinct metric. PURE — no I/O, never throws.
 *
 * @param observations Raw rows from the append-only ledger (#2629). Consumed
 *   as-is: `delta` and `classCounts` are used verbatim, never re-derived.
 * @param opts Optional tunable overrides (default to the env-backed module
 *   constants) — supplied by tests to pin λ/k deterministically.
 */
export function estimateMarginalEffects(
  observations: AttributionObservation[],
  opts: {
    lambda?: number;
    noiseFloorK?: number;
    lowVarianceEps?: number;
    collinearityThreshold?: number;
  } = {},
): AttributionEstimate {
  const lambda = opts.lambda ?? RIDGE_LAMBDA;
  const noiseFloorK = opts.noiseFloorK ?? NOISE_FLOOR_K;
  const lowVarianceEps = opts.lowVarianceEps ?? LOW_VARIANCE_EPS;
  const collinearityThreshold =
    opts.collinearityThreshold ?? COLLINEARITY_THRESHOLD;

  // Group rows by metric, preserving first-seen order (per-metric independence).
  const byMetric = new Map<string, AttributionObservation[]>();
  for (const obs of observations) {
    const bucket = byMetric.get(obs.metric);
    if (bucket) bucket.push(obs);
    else byMetric.set(obs.metric, [obs]);
  }

  const metrics: MetricEstimate[] = [];
  for (const [metric, rows] of byMetric) {
    metrics.push(
      fitMetric(metric, rows, {
        lambda,
        noiseFloorK,
        lowVarianceEps,
        collinearityThreshold,
      }),
    );
  }
  return { metrics };
}

// ---------------------------------------------------------------------------
// Per-metric fit
// ---------------------------------------------------------------------------

function fitMetric(
  metric: string,
  rows: AttributionObservation[],
  cfg: {
    lambda: number;
    noiseFloorK: number;
    lowVarianceEps: number;
    collinearityThreshold: number;
  },
): MetricEstimate {
  // Stable, first-seen column order over every class name that ever appears with
  // a non-zero count. A class that only ever appears with count 0 carries no
  // signal and is dropped from the design (it would be an all-zero column).
  const classOrder: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const [cls, count] of Object.entries(r.classCounts)) {
      if (count !== 0 && !seen.has(cls)) {
        seen.add(cls);
        classOrder.push(cls);
      }
    }
  }

  // σ0 + β0 anchor: the empty (zero-merge) windows.
  const emptyDeltas: number[] = [];
  for (const r of rows) {
    if (isEmptyWindow(r.classCounts)) emptyDeltas.push(r.delta);
  }
  const sigma0 = emptyDeltas.length > 0 ? populationStd(emptyDeltas) : null;

  // Design matrix X (with a leading intercept column of 1s) and target y.
  //   column 0     = intercept (always 1)
  //   column 1..P  = classOrder[0..P-1] counts
  const P = classOrder.length;
  const X: number[][] = rows.map((r) => {
    const row = new Array<number>(P + 1);
    row[0] = 1;
    for (let j = 0; j < P; j++) {
      row[j + 1] = r.classCounts[classOrder[j]] ?? 0;
    }
    return row;
  });
  const y = rows.map((r) => r.delta);

  // Ridge normal equations: (XᵀX + λ·D) β = Xᵀy, with D = diag(0,1,1,…,1) — the
  // intercept term (index 0) is NOT regularized.
  const beta = solveRidge(X, y, cfg.lambda);

  // Identifiability: per-column variance (low-variance flag) + pairwise
  // collinearity over the CLASS columns (indices 1..P of X).
  const columnVariance = new Array<number>(P);
  for (let j = 0; j < P; j++) {
    columnVariance[j] = populationStd(X.map((row) => row[j + 1])) ** 2;
  }
  const collinearGroups = detectCollinearity(
    X,
    classOrder,
    cfg.collinearityThreshold,
  );

  const effects: ClassEffect[] = classOrder.map((producerClass, j) => {
    const b = beta[j + 1]; // +1: skip intercept
    const lowVariance = columnVariance[j] <= cfg.lowVarianceEps;
    const collinearWith = collinearGroups.get(producerClass) ?? [];
    const collinear = collinearWith.length > 0;
    const belowNoiseFloor =
      sigma0 !== null && Math.abs(b) <= cfg.noiseFloorK * sigma0;
    return {
      producerClass,
      beta: b,
      lowVariance,
      collinear,
      collinearWith,
      belowNoiseFloor,
      identifiabilitySuspect: lowVariance || collinear,
    };
  });

  return {
    metric,
    intercept: beta[0],
    effects,
    sigma0,
    observationCount: rows.length,
    emptyWindowCount: emptyDeltas.length,
  };
}

function isEmptyWindow(classCounts: Record<string, number>): boolean {
  for (const v of Object.values(classCounts)) {
    if (v !== 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

/**
 * Pearson correlation between two equal-length columns. Returns 0 when either
 * column is constant (undefined correlation → treated as not-collinear here; a
 * constant column is caught by the separate low-variance flag instead).
 */
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/**
 * Detect (near-)perfectly collinear CLASS column pairs. Returns a map from a
 * class name to the OTHER class names it is collinear with. A pair `(i, j)` is
 * collinear when `|pearson(col_i, col_j)| ≥ threshold`. This is the flag that
 * column-variance alone MISSES: two duplicate high-variance columns correlate at
 * 1.0 yet each has high variance.
 */
function detectCollinearity(
  X: number[][],
  classOrder: string[],
  threshold: number,
): Map<string, string[]> {
  const P = classOrder.length;
  const cols: number[][] = [];
  for (let j = 0; j < P; j++) {
    cols.push(X.map((row) => row[j + 1])); // +1: skip intercept column
  }
  const out = new Map<string, string[]>();
  for (let i = 0; i < P; i++) {
    for (let j = i + 1; j < P; j++) {
      if (Math.abs(pearson(cols[i], cols[j])) >= threshold) {
        addTo(out, classOrder[i], classOrder[j]);
        addTo(out, classOrder[j], classOrder[i]);
      }
    }
  }
  return out;
}

function addTo(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}
