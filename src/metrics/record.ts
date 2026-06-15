/**
 * Cycle metrics — write path.
 *
 * `recordCycleMetrics(cycleId, metrics)` is the single write entry for the
 * cycle metrics hash. The USD cost fields that used to ride along here were
 * retired with the writer-less USD attribution plane (#1561 → #1651, per
 * ADR-0016): orchestrator spend truth is the token plane.
 *
 * Issue #1890: `CycleMetricsInput` names the fields this writer accepts, and
 * the numeric subset is exported as `NUMERIC_FIELD_NAMES` so the read side
 * (`metrics/trend.ts`) derives its `NUMERIC_FIELDS` parse list from ONE
 * declaration. A field rename here is now a compile error at the read site (or
 * vice versa) — closing the silent write-read drift gap that left e.g.
 * `reflectionMatchSource` reading `"none"` forever until #1136 Slice 2.
 *
 * The `deriveQualityGateCoverage` auto-derivation (issue #287) was removed in
 * #971: its mutation/JIT inputs lost their in-process writer when the codex
 * control loop was retired, leaving the metric write-dead (pinned at 0%).
 */

import { setCycleMetrics } from "../redis/cycle-metrics.ts";

/** TTL for cycle metrics Redis keys: 7 days in seconds (matches redis/cycle-tracking.ts). */
const CYCLE_KEY_TTL = 7 * 24 * 60 * 60; // 604800

/**
 * The numeric (int-shaped) fields of the cycle-metrics hash. This tuple is the
 * SINGLE source of truth for the write-read numeric contract: it types the
 * numeric keys of `CycleMetricsInput` below AND is re-exported to `trend.ts`,
 * which parses exactly these keys back from their Redis string form. Add a new
 * int metric here once and it surfaces on both sides.
 *
 * `as const` makes this a readonly tuple of string literals so the keys can be
 * lifted into `CycleMetricsInput`'s type via a mapped type.
 */
export const NUMERIC_FIELD_NAMES = [
  "tasksAttempted",
  "tasksVerified",
  "tasksMerged",
  "tasksFailed",
  "tasksAbandoned",
  "noOpMerges", // issue #222: silent-rot guardrail counter
  "driftPreFiltered", // issue #233: anchors rejected by pre-filter
  "driftPreFilteredCost", // issue #233: estimated planner $ saved
  "testsBefore",
  "testsAfter",
  "testsPassingBefore",
  "testsPassingAfter",
  "filesChanged",
  "totalDurationMs",
  "groundingDurationMs",
  "verificationDurationMs",
  "planningDurationMs",
  "executionDurationMs",
  "tokenCost",
  "jitTestsGenerated",
  "jitTestsKept",
  "jitTestsCaughtBug",
  "mutationKillRate",
  "mutationKilled",
  "mutationSurvived",
  // Quality gate trend (issue #212)
  "mutationsTested",
  "gateBlocked",
  "fixerUsed",
  "fixerResolved",
  "scopeFilterCleaned",
  "reflectionCount",
  "incrementalTestsSelected", // issue #341: tests the incremental selector ran
] as const;

/** Union of the numeric field name literals (`"tasksMerged" | "tasksFailed" | …`). */
export type NumericFieldName = (typeof NUMERIC_FIELD_NAMES)[number];

/** The numeric half of the metrics shape: every `NUMERIC_FIELD_NAMES` key, optional, `number`. */
type NumericMetrics = { [K in NumericFieldName]?: number };

/**
 * The non-numeric (categorical / string / boolean) fields the writer accepts.
 * These pass through to Redis as-is (booleans/objects stringified) and are not
 * in the `NUMERIC_FIELDS` parse list.
 */
interface CategoricalMetrics {
  /** `regressionIntroduced` is parsed back to boolean at read time in trend.ts. */
  regressionIntroduced?: boolean;
  /** Provenance: "claude" | "codex" | "work-queue" | … — defaults to "codex" if absent. */
  source?: string;
  /** Priority lane the anchor came from (kanban | failing-test | work-queue | …). */
  anchorType?: string;
  /** Stable anchor identifier (issue number, branch, queue key). */
  anchorReference?: string;
  /** Human-readable task title for the dashboard. */
  taskTitle?: string;
  /** Opened PR number, stored as a string. */
  prNumber?: string;
  /** Free-text reason when the cycle was abandoned (issue #195). */
  abandonReason?: string;
  /** Autopilot turn that produced this cycle. */
  autopilotTurnId?: string;
  /** Worktree branch the dispatch ran in. */
  worktreeBranch?: string;
  /** Comma-separated reflection bucket sources; `deriveReflectionMatchSource` reads this (#1136). */
  reflectionSources?: string;
  /** Grounding mode bucket: "incremental" | "full" | "" (issue #341). */
  groundingMode?: string;
  /** Reconciliation status of the dispatch's self-report vs. hard verification. */
  reconciliationStatus?: string;
  /** JIT-test decision label (read by quality-gates.ts). */
  jitDecision?: string;
}

/**
 * The shape `recordCycleMetrics` accepts. Numeric fields are derived from
 * `NUMERIC_FIELD_NAMES` (the same list the trend reader parses), so a field
 * rename on either side is a `tsc` error rather than a silent runtime zero.
 *
 * All fields are optional — callers (autopilot/runs.ts, api/metrics.ts) send
 * the subset they have. An index signature keeps the writer forward-compatible
 * with ad-hoc fields posted to `POST /metrics/record`, but the named fields
 * above give callers static autocomplete and catch misspellings.
 */
export type CycleMetricsInput = NumericMetrics &
  CategoricalMetrics & {
    /** Forward-compat escape hatch for ad-hoc fields (e.g. POST /metrics/record). */
    [key: string]: unknown;
  };

/**
 * Record a cycle's outcome metrics.
 */
export async function recordCycleMetrics(
  cycleId: string,
  metrics: CycleMetricsInput,
): Promise<void> {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(metrics)) {
    // Skip undefined so absent fields stay absent rather than being persisted
    // as the string "undefined".
    if (v === undefined) continue;
    flat[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  }
  flat.cycleId = cycleId;
  flat.recordedAt = new Date().toISOString();
  if (!flat.source) flat.source = "codex"; // default source for Codex orchestrator cycles

  await setCycleMetrics(cycleId, flat, CYCLE_KEY_TTL);

  console.log(`[Metrics] Recorded cycle ${cycleId}: ${metrics.tasksMerged || 0} merged, ${metrics.tasksFailed || 0} failed, regression=${metrics.regressionIntroduced || false}`);
}
