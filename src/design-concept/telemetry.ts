/**
 * Design-concept Phase B telemetry (issue #465, sub of #437).
 *
 * Reads the Phase B counters/histograms/diagnostics populated by B-1
 * (#466), B-3 (#464), and the hydra-grill SKILL.md, then computes the
 * rolling 7-day promotion-readiness view consumed by:
 *
 *   - `GET /api/design-concepts/telemetry`           (this PR; api/design-concepts.ts)
 *   - `scripts/autopilot/dc-telemetry-snapshot.sh`   (this PR; daily snapshot)
 *   - `dashboard/src/components/DesignConceptTelemetry.jsx` (this PR; UI)
 *
 * Phase B is observation-only: nothing in this module flips Phase B
 * behavior into Phase C. The `promotion_eligibility.ready` flag is a
 * signal for the operator to file a Phase C epic — there is no
 * auto-promotion code path.
 *
 * Pure-function design. Every Redis read is performed via callbacks
 * passed in by the API route handler (or the test fixture), so this
 * file has zero IO and the rollup logic is unit-testable against an
 * in-memory `Map`-backed reader.
 *
 * Redis schema (all keys are PHASE B; #466 / #464 own the writes):
 *
 *   Counters (one per day, 14d TTL):
 *     hydra:dc:counter:{name}:{YYYY-MM-DD}        — STRING (integer)
 *
 *   Histograms (FIFO, last 100 samples, 30d TTL):
 *     hydra:dc:histogram:qaTrace_length_samples   — LIST
 *     hydra:dc:histogram:glossaryGaps_size_samples — LIST
 *
 *   Diagnostics (monotonic over the rolling window, 30d TTL):
 *     hydra:dc:gate_fail_reasons                  — HASH (reason → count)
 *     hydra:dc:operator_override_reasons          — HASH (reason → count)
 *
 *   Baselines (one-shot at B-1 merge time):
 *     hydra:dc:baseline:dev_pr_latency_ms         — STRING (integer ms)
 *
 *   Daily snapshots (written by dc-telemetry-snapshot.sh, 30d TTL):
 *     hydra:dc:daily_snapshot:{YYYY-MM-DD}        — HASH (criterion → status)
 *
 *   Exempt log (B-3 owns the writes; this module only reads LLEN):
 *     hydra:dc:exempt_log                         — LIST
 *
 *   Dev-PR latency samples (cycle records emit; B-1 wires the write):
 *     hydra:dc:histogram:dev_pr_latency_ms_samples — LIST
 */

// ---------------------------------------------------------------------------
// Thresholds
//
// All six thresholds + the min-sample gate are constants here for two
// reasons:
//   1. Easy to tune without touching the API or the dashboard.
//   2. Test fixtures can override via the `Thresholds` argument to
//      `computeTelemetry()` — no global mutation.
// ---------------------------------------------------------------------------

export type ThresholdDirection =
  | "above_is_green" // value >= threshold → green
  | "below_is_green"; // value <= threshold → green

export type Threshold = {
  threshold: number;
  direction: ThresholdDirection;
};

export type Thresholds = {
  artifact_rate: Threshold;
  gate_pass_rate: Threshold;
  handoff_rate_per_day: Threshold;
  median_qa_trace: Threshold;
  dev_pr_latency_ratio: Threshold;
  exempt_rate: Threshold;
  min_sample: Threshold;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  artifact_rate: { threshold: 0.8, direction: "above_is_green" },
  gate_pass_rate: { threshold: 0.7, direction: "above_is_green" },
  handoff_rate_per_day: { threshold: 1.0, direction: "below_is_green" },
  median_qa_trace: { threshold: 8, direction: "above_is_green" },
  dev_pr_latency_ratio: { threshold: 1.2, direction: "below_is_green" },
  exempt_rate: { threshold: 0.2, direction: "below_is_green" },
  min_sample: { threshold: 20, direction: "above_is_green" },
};

/** Yellow margin — within 10% of the threshold but not meeting it. */
export const YELLOW_MARGIN_PCT = 0.1;

/** Rolling window length, in days. */
export const WINDOW_DAYS = 7;

/** Consecutive all-green daily snapshots required for promotion-ready. */
export const CONSECUTIVE_GREEN_DAYS_REQUIRED = 3;

// ---------------------------------------------------------------------------
// Status + criterion types
// ---------------------------------------------------------------------------

export type Status = "green" | "yellow" | "red";

export type CriterionView = {
  value: number;
  threshold: number;
  status: Status;
};

export type CriterionName =
  | "artifact_rate"
  | "gate_pass_rate"
  | "handoff_rate_per_day"
  | "median_qa_trace"
  | "dev_pr_latency_ratio"
  | "exempt_rate";

export type TelemetryView = {
  window_days: number;
  criteria: Record<CriterionName, CriterionView>;
  min_sample: CriterionView;
  diagnostics: {
    gate_fail_reasons: Record<string, number>;
    operator_override_reasons: Record<string, number>;
  };
  promotion_eligibility: {
    ready: boolean;
    consecutive_green_days: number;
    blocking_criteria: string[];
    estimated_ready_date: string | null;
  };
};

// ---------------------------------------------------------------------------
// Pure helpers — status, dates, median
// ---------------------------------------------------------------------------

/**
 * Classify a value against a threshold as green / yellow / red.
 *
 * - "above_is_green": value >= threshold → green; within 10% below → yellow; else red.
 * - "below_is_green": value <= threshold → green; within 10% above → yellow; else red.
 */
export function computeStatus(
  value: number,
  threshold: number,
  direction: ThresholdDirection,
  yellowMargin: number = YELLOW_MARGIN_PCT,
): Status {
  if (!Number.isFinite(value)) return "red";
  if (direction === "above_is_green") {
    if (value >= threshold) return "green";
    if (threshold === 0) return "red";
    const shortfall = (threshold - value) / threshold;
    return shortfall <= yellowMargin ? "yellow" : "red";
  }
  // below_is_green
  if (value <= threshold) return "green";
  if (threshold === 0) {
    // A "must be zero" threshold has no yellow band — any non-zero is red.
    return "red";
  }
  const excess = (value - threshold) / threshold;
  return excess <= yellowMargin ? "yellow" : "red";
}

/** UTC YYYY-MM-DD for a Date. Pure. */
export function ymd(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Last `n` calendar days, newest-first, as YYYY-MM-DD strings.
 * Today is the first element. `n=7` returns today + the prior 6 days.
 */
export function rollingDays(now: Date, n: number = WINDOW_DAYS): string[] {
  const out: string[] = [];
  // Work in UTC to avoid DST jitter on the rolling window.
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = 0; i < n; i += 1) {
    out.push(ymd(new Date(t - i * 86_400_000)));
  }
  return out;
}

/**
 * Median of a numeric array. Returns 0 on empty input — the caller is
 * expected to gate on `min_sample` separately.
 */
export function median(samples: number[]): number {
  if (!samples || samples.length === 0) return 0;
  const sorted = samples
    .filter((n) => Number.isFinite(n))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Redis key shapes
// ---------------------------------------------------------------------------

export const counterKey = (name: string, day: string): string =>
  `hydra:dc:counter:${name}:${day}`;

export const HISTOGRAM_QA_TRACE = "hydra:dc:histogram:qaTrace_length_samples";
export const HISTOGRAM_GLOSSARY_GAPS = "hydra:dc:histogram:glossaryGaps_size_samples";
export const HISTOGRAM_DEV_PR_LATENCY = "hydra:dc:histogram:dev_pr_latency_ms_samples";

export const KEY_GATE_FAIL_REASONS = "hydra:dc:gate_fail_reasons";
export const KEY_OPERATOR_OVERRIDE_REASONS = "hydra:dc:operator_override_reasons";

export const KEY_BASELINE_DEV_PR_LATENCY = "hydra:dc:baseline:dev_pr_latency_ms";

export const KEY_EXEMPT_LOG = "hydra:dc:exempt_log";

export const dailySnapshotKey = (day: string): string =>
  `hydra:dc:daily_snapshot:${day}`;

// ---------------------------------------------------------------------------
// Reader contract — IO is injected so this module stays pure-functional.
// ---------------------------------------------------------------------------

export type TelemetryReader = {
  /** Read an integer counter. Missing key → 0. */
  readInt(key: string): Promise<number>;
  /** Read a list as numbers. Missing list → []. Non-numeric entries dropped. */
  readNumberList(key: string): Promise<number[]>;
  /** List length. Missing list → 0. */
  readListLen(key: string): Promise<number>;
  /** Hash → object. Missing hash → {}. */
  readHash(key: string): Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Rollup — pure computation given resolved values.
// ---------------------------------------------------------------------------

/** Inputs to the rollup, resolved by the IO layer. */
export type TelemetryInputs = {
  /** Sum over the rolling window. */
  dispatch_count: number;
  artifact_produced_count: number;
  artifact_approved_count: number;
  artifact_warn_count: number;
  handoff_filed_count: number;
  dev_with_artifact_count: number;
  dev_without_artifact_count: number;
  grill_timeout_count: number;
  grill_crash_count: number;

  /** Histogram samples (rolling 100 most recent — already trimmed at write time). */
  qa_trace_samples: number[];
  glossary_gaps_samples: number[];
  dev_pr_latency_ms_samples: number[];

  /** Baseline (one-shot). 0 → not yet captured. */
  baseline_dev_pr_latency_ms: number;

  /** Exempt-log length (entries within window — list-level filtering deferred). */
  exempt_log_len: number;

  /** Diagnostics. */
  gate_fail_reasons: Record<string, number>;
  operator_override_reasons: Record<string, number>;

  /** Daily snapshots for yesterday and the day before, used for consecutive-green. */
  prev_snapshot_yesterday: Record<string, string>; // criterion → status
  prev_snapshot_day_before: Record<string, string>;
};

/**
 * Compute the rolling 7-day telemetry view from resolved counter sums,
 * histogram samples, and the two prior daily snapshots. Pure function.
 */
export function computeTelemetry(
  inputs: TelemetryInputs,
  now: Date,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): TelemetryView {
  // Sample count — the gating "do we have enough data" number. Defined as
  // total dev_orch dispatches in the window (with-artifact + without-artifact),
  // not as artifact-produced count: dev throughput is what we ultimately
  // care about for the latency-ratio criterion and the exempt-rate
  // denominator.
  const dev_pr_count = inputs.dev_with_artifact_count + inputs.dev_without_artifact_count;

  // ---- Six criteria ----

  // 1. artifact_rate = artifact_produced / dispatch_count
  const artifact_rate =
    inputs.dispatch_count > 0
      ? inputs.artifact_produced_count / inputs.dispatch_count
      : 0;

  // 2. gate_pass_rate = artifact_approved / (artifact_approved + artifact_warn)
  const total_with_verdict =
    inputs.artifact_approved_count + inputs.artifact_warn_count;
  const gate_pass_rate =
    total_with_verdict > 0
      ? inputs.artifact_approved_count / total_with_verdict
      : 0;

  // 3. handoff_rate_per_day = handoff_filed / WINDOW_DAYS
  const handoff_rate_per_day = inputs.handoff_filed_count / WINDOW_DAYS;

  // 4. median_qa_trace from histogram samples
  const median_qa_trace = median(inputs.qa_trace_samples);

  // 5. dev_pr_latency_ratio = current_median / baseline
  const current_dev_pr_latency = median(inputs.dev_pr_latency_ms_samples);
  // If no baseline yet, ratio is 1.0 (neutral) so a missing baseline can't
  // by itself flip the criterion to red on day 1.
  const dev_pr_latency_ratio =
    inputs.baseline_dev_pr_latency_ms > 0
      ? current_dev_pr_latency / inputs.baseline_dev_pr_latency_ms
      : 1.0;

  // 6. exempt_rate = exempt_log_len / dev_pr_count
  const exempt_rate = dev_pr_count > 0 ? inputs.exempt_log_len / dev_pr_count : 0;

  const criteria: Record<CriterionName, CriterionView> = {
    artifact_rate: {
      value: round2(artifact_rate),
      threshold: thresholds.artifact_rate.threshold,
      status: computeStatus(
        artifact_rate,
        thresholds.artifact_rate.threshold,
        thresholds.artifact_rate.direction,
      ),
    },
    gate_pass_rate: {
      value: round2(gate_pass_rate),
      threshold: thresholds.gate_pass_rate.threshold,
      status: computeStatus(
        gate_pass_rate,
        thresholds.gate_pass_rate.threshold,
        thresholds.gate_pass_rate.direction,
      ),
    },
    handoff_rate_per_day: {
      value: round2(handoff_rate_per_day),
      threshold: thresholds.handoff_rate_per_day.threshold,
      status: computeStatus(
        handoff_rate_per_day,
        thresholds.handoff_rate_per_day.threshold,
        thresholds.handoff_rate_per_day.direction,
      ),
    },
    median_qa_trace: {
      value: median_qa_trace,
      threshold: thresholds.median_qa_trace.threshold,
      status: computeStatus(
        median_qa_trace,
        thresholds.median_qa_trace.threshold,
        thresholds.median_qa_trace.direction,
      ),
    },
    dev_pr_latency_ratio: {
      value: round2(dev_pr_latency_ratio),
      threshold: thresholds.dev_pr_latency_ratio.threshold,
      status: computeStatus(
        dev_pr_latency_ratio,
        thresholds.dev_pr_latency_ratio.threshold,
        thresholds.dev_pr_latency_ratio.direction,
      ),
    },
    exempt_rate: {
      value: round2(exempt_rate),
      threshold: thresholds.exempt_rate.threshold,
      status: computeStatus(
        exempt_rate,
        thresholds.exempt_rate.threshold,
        thresholds.exempt_rate.direction,
      ),
    },
  };

  // ---- Min-sample gate ----
  const min_sample: CriterionView = {
    value: dev_pr_count,
    threshold: thresholds.min_sample.threshold,
    status: computeStatus(
      dev_pr_count,
      thresholds.min_sample.threshold,
      thresholds.min_sample.direction,
    ),
  };

  // ---- Promotion eligibility ----
  const promotion_eligibility = computePromotionEligibility(
    criteria,
    min_sample,
    inputs.prev_snapshot_yesterday,
    inputs.prev_snapshot_day_before,
    now,
  );

  return {
    window_days: WINDOW_DAYS,
    criteria,
    min_sample,
    diagnostics: {
      gate_fail_reasons: inputs.gate_fail_reasons,
      operator_override_reasons: inputs.operator_override_reasons,
    },
    promotion_eligibility,
  };
}

/**
 * Promotion eligibility — `ready=true` iff all current criteria + min_sample
 * are green AND the two prior daily snapshots are also all-green
 * (3 consecutive green days, counting today).
 */
export function computePromotionEligibility(
  criteria: Record<CriterionName, CriterionView>,
  min_sample: CriterionView,
  prev_snapshot_yesterday: Record<string, string>,
  prev_snapshot_day_before: Record<string, string>,
  now: Date,
): TelemetryView["promotion_eligibility"] {
  const criteriaNames = Object.keys(criteria) as CriterionName[];

  const todayAllGreen =
    min_sample.status === "green" &&
    criteriaNames.every((n) => criteria[n].status === "green");

  const blocking_criteria: string[] = [];
  if (min_sample.status !== "green") blocking_criteria.push("min_sample");
  for (const n of criteriaNames) {
    if (criteria[n].status !== "green") blocking_criteria.push(n);
  }

  const yesterdayAllGreen = snapshotAllGreen(prev_snapshot_yesterday);
  const dayBeforeAllGreen = snapshotAllGreen(prev_snapshot_day_before);

  let consecutive_green_days = 0;
  if (todayAllGreen) {
    consecutive_green_days = 1;
    if (yesterdayAllGreen) {
      consecutive_green_days = 2;
      if (dayBeforeAllGreen) {
        consecutive_green_days = 3;
      }
    }
  }

  const ready =
    todayAllGreen && consecutive_green_days >= CONSECUTIVE_GREEN_DAYS_REQUIRED;

  let estimated_ready_date: string | null = null;
  if (todayAllGreen && !ready) {
    const daysToGo = CONSECUTIVE_GREEN_DAYS_REQUIRED - consecutive_green_days;
    const future = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) +
        daysToGo * 86_400_000,
    );
    estimated_ready_date = ymd(future);
  }

  return {
    ready,
    consecutive_green_days,
    blocking_criteria,
    estimated_ready_date,
  };
}

/**
 * A daily snapshot is "all green" iff every field (excluding the
 * "writtenAt" metadata field) is the literal string "green".
 *
 * Returns false on empty/missing snapshots so a fresh deploy with no
 * snapshot history can't ratchet itself to consecutive_green_days = 3
 * after one good day.
 */
export function snapshotAllGreen(snapshot: Record<string, string>): boolean {
  if (!snapshot) return false;
  const entries = Object.entries(snapshot).filter(
    ([k]) => k !== "writtenAt" && k !== "_meta",
  );
  if (entries.length === 0) return false;
  return entries.every(([, status]) => status === "green");
}

// ---------------------------------------------------------------------------
// IO orchestration — reads via the injected reader, then calls computeTelemetry.
// ---------------------------------------------------------------------------

/**
 * Read every input from Redis (or the test fixture) and compute the view.
 * The reader contract is intentionally minimal so the API route and the
 * test suite can share this orchestration code.
 */
export async function readAndCompute(
  reader: TelemetryReader,
  now: Date,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Promise<TelemetryView> {
  const days = rollingDays(now, WINDOW_DAYS);

  // Sum each counter across the rolling window.
  const counterNames = [
    "dispatch_count",
    "artifact_produced_count",
    "artifact_approved_count",
    "artifact_warn_count",
    "handoff_filed_count",
    "dev_with_artifact_count",
    "dev_without_artifact_count",
    "grill_timeout_count",
    "grill_crash_count",
  ] as const;

  const counterSums: Record<(typeof counterNames)[number], number> = {
    dispatch_count: 0,
    artifact_produced_count: 0,
    artifact_approved_count: 0,
    artifact_warn_count: 0,
    handoff_filed_count: 0,
    dev_with_artifact_count: 0,
    dev_without_artifact_count: 0,
    grill_timeout_count: 0,
    grill_crash_count: 0,
  };

  for (const name of counterNames) {
    for (const day of days) {
      counterSums[name] += await reader.readInt(counterKey(name, day));
    }
  }

  // Histograms — the rolling-100 contract is enforced at write time; we
  // just read all current samples.
  const qa_trace_samples = await reader.readNumberList(HISTOGRAM_QA_TRACE);
  const glossary_gaps_samples = await reader.readNumberList(HISTOGRAM_GLOSSARY_GAPS);
  const dev_pr_latency_ms_samples = await reader.readNumberList(
    HISTOGRAM_DEV_PR_LATENCY,
  );

  // Diagnostics.
  const gate_fail_reasons_raw = await reader.readHash(KEY_GATE_FAIL_REASONS);
  const operator_override_reasons_raw = await reader.readHash(
    KEY_OPERATOR_OVERRIDE_REASONS,
  );

  const gate_fail_reasons = hashToCounts(gate_fail_reasons_raw);
  const operator_override_reasons = hashToCounts(operator_override_reasons_raw);

  // Baseline.
  const baseline_raw = await reader.readInt(KEY_BASELINE_DEV_PR_LATENCY);
  const baseline_dev_pr_latency_ms = baseline_raw;

  // Exempt log length.
  const exempt_log_len = await reader.readListLen(KEY_EXEMPT_LOG);

  // Prior daily snapshots — yesterday and day-before-yesterday.
  const yesterday = days[1] ?? "";
  const dayBefore = days[2] ?? "";
  const prev_snapshot_yesterday = yesterday
    ? await reader.readHash(dailySnapshotKey(yesterday))
    : {};
  const prev_snapshot_day_before = dayBefore
    ? await reader.readHash(dailySnapshotKey(dayBefore))
    : {};

  return computeTelemetry(
    {
      ...counterSums,
      qa_trace_samples,
      glossary_gaps_samples,
      dev_pr_latency_ms_samples,
      baseline_dev_pr_latency_ms,
      exempt_log_len,
      gate_fail_reasons,
      operator_override_reasons,
      prev_snapshot_yesterday,
      prev_snapshot_day_before,
    },
    now,
    thresholds,
  );
}

// ---------------------------------------------------------------------------
// Snapshot writer support
// ---------------------------------------------------------------------------

/**
 * Flatten a `TelemetryView` into the snapshot HASH shape:
 *
 *   { artifact_rate: "green", gate_pass_rate: "red", ..., min_sample: "green", writtenAt: "..." }
 *
 * The snapshot HASH is what the next day's rollup reads to compute
 * `consecutive_green_days`. Keeping just the status (not the value) makes
 * the consecutive-green check threshold-version-invariant — if we tune
 * `DEFAULT_THRESHOLDS` next week, yesterday's snapshot still answers the
 * right question.
 */
export function snapshotFromView(
  view: TelemetryView,
  now: Date,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(view.criteria)) {
    out[k] = v.status;
  }
  out.min_sample = view.min_sample.status;
  out.writtenAt = now.toISOString();
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function hashToCounts(raw: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}
