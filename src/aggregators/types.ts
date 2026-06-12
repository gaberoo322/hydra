/**
 * Shared types for Dashboard v2 aggregators (issue #616 onwards).
 *
 * Kept separate from `overnight-summary.ts` so the slice-2 aggregators
 * (decision-queue, stuck-items, recent-merges, target-backlog-findings,
 * lessons-overnight) can reuse the same discriminated-string vocabulary
 * without circular imports.
 */

export type HeadroomLevel = "green" | "yellow" | "red" | "unknown";

// ---------------------------------------------------------------------------
// Slice-2 vocabulary (issue #617)
// ---------------------------------------------------------------------------

/**
 * Where a `DecisionItem` originated. The decision-queue aggregator unifies
 * three distinct sources into one list; the `source` discriminator lets the
 * dashboard render a small badge so the operator can see at a glance
 * whether an item came from the overnight decision-queue digest issue,
 * the persistent `ready-for-human` label, or the `needs-info` waiting
 * lane.
 */
export type DecisionItemSource =
  | "operator-decision-queue"
  | "ready-for-human"
  | "needs-info";

// ---------------------------------------------------------------------------
// Slice-5 vocabulary (issue #620)
// ---------------------------------------------------------------------------

/**
 * Outcome of an autopilot run, as recorded on the `hydra:autopilot:run:*`
 * hash. Closed set so the dashboard can render a coloured chip without
 * re-bucketing. `unknown` covers historical rows pre-dating outcome stamping.
 */
export type AutopilotRunOutcome =
  | "success"
  | "failure"
  | "aborted"
  | "in-progress"
  | "unknown";

/**
 * Which metric an anomaly was detected on. The anomaly-detector aggregator
 * uses a z-score against the rolling baseline for each series; the metric
 * is the discriminator the dashboard uses to badge each item.
 */
export type AnomalyMetric =
  | "cost-per-hour"
  | "abandonment-rate"
  | "dispatch-class-failure-rate";

/**
 * Direction of an anomaly relative to the baseline. `high` = the latest
 * sample is far ABOVE the mean (e.g. cost-per-hour spiked), `low` = far
 * BELOW (e.g. abandonment-rate suddenly collapsed). Both are anomalies
 * but the dashboard renders them differently.
 */
export type AnomalyDirection = "high" | "low";
