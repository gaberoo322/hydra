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

import { getCycleMetrics, setCycleMetrics } from "../redis/cycle-metrics.ts";

/** TTL for cycle metrics Redis keys: 7 days in seconds (matches redis/cycle-tracking.ts). */
const CYCLE_KEY_TTL = 7 * 24 * 60 * 60; // 604800

/**
 * Duration fields that are MONOTONIC across the double-write a single cycleId
 * receives (issue #2364). A cycle is written twice: the reap-time `completed`
 * write (which computes a wall-clock span from the slot's `started_epoch`) and
 * the post-merge `merged`/auto-merge follow-up write (which the model fires with
 * its own duration). Because `recordCycleMetrics` is an additive HSET, the later
 * write blindly overwrites the earlier — so a follow-up that carries `0` (the
 * truthful "unknown" sentinel when no start stamp was available, or a qa_orch
 * relay cycle whose reap never wrote a duration) would CLOBBER a real non-zero
 * span the first write recorded, and a non-zero follow-up could never UPGRADE a
 * 0 first write through the dedup/enrichment path. Both directions surfaced as
 * `totalDurationMs=0` on merged cycles despite the instrumentation path working
 * end-to-end. Treating these fields as monotonic-max — never let a 0 overwrite a
 * stored non-zero, and let any non-zero upgrade a stored 0/absent — makes the
 * recorded span order-independent: whichever write ever carries a real duration
 * wins, regardless of which writer lands first. 0 stays the truthful sentinel
 * only when NO write ever supplied a real span.
 */
const MONOTONIC_DURATION_FIELDS = [
  "totalDurationMs",
  "groundingDurationMs",
  "verificationDurationMs",
  "planningDurationMs",
  "executionDurationMs",
  // Issue #3338: the three cycle-COORDINATION spans (distinct altitude from the
  // per-dispatch phase spans above). They partition a cycle's wall-clock into
  // the autopilot orchestration phases so a slow cycle can be attributed to
  // dispatch decision-making vs executor work vs merge-wait:
  //   - decisionLatencyMs   — cycle-start → anchor-select (planning → seed)
  //   - executionLatencyMs  — anchor-select → merge-ready (dispatch → result)
  //   - mergeLatencyMs      — merge-ready → cycle-complete (poll → final commit)
  // Declared MONOTONIC for the SAME reason as the phase spans: a cycleId's
  // double-write (reap `completed` + post-merge follow-up) is order-independent,
  // so a later 0-carrying enrichment write can neither clobber a stored non-zero
  // span nor block a real span from upgrading a stored 0/absent.
  "decisionLatencyMs",
  "executionLatencyMs",
  "mergeLatencyMs",
] as const;

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
  // Issue #3338: cycle-coordination spans (see MONOTONIC_DURATION_FIELDS). NUMERIC
  // so trend.ts (which derives its parse list from THIS tuple) reads them back as
  // numbers and the record aggregators surface per-span bottleneck attribution.
  "decisionLatencyMs",
  "executionLatencyMs",
  "mergeLatencyMs",
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
type NumericFieldName = (typeof NUMERIC_FIELD_NAMES)[number];

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
  /** Provenance: "claude" | "work-queue" | … — defaults to "claude" if absent (issue #3070; "codex" is a retired provider, ADR-0006). */
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

  // Issue #2364: enforce monotonic-max on duration fields so the second write a
  // cycleId receives (the post-merge follow-up) can neither clobber a real span
  // recorded by the first write with a 0 nor be blocked from upgrading a 0 first
  // write with a real span. Only read the existing hash when this write actually
  // carries a duration field — the common single-field-enrichment / first-write
  // path skips the extra Redis round-trip entirely.
  const writesDuration = MONOTONIC_DURATION_FIELDS.some((f) => f in flat);
  if (writesDuration) {
    const existing = await getCycleMetrics(cycleId);
    for (const field of MONOTONIC_DURATION_FIELDS) {
      if (!(field in flat)) continue;
      const incoming = Number(flat[field]);
      const stored = Number(existing?.[field]);
      const storedValid = Number.isFinite(stored) && stored > 0;
      const incomingValid = Number.isFinite(incoming) && incoming > 0;
      // Keep the larger meaningful value. A non-positive / non-finite incoming
      // never overwrites a stored positive span; an incoming positive upgrades a
      // stored 0/absent. When both are positive the max wins (the longer of two
      // measured spans is the safest non-regressing choice).
      if (storedValid && (!incomingValid || stored >= incoming)) {
        flat[field] = String(stored);
      }
    }
  }

  flat.cycleId = cycleId;
  flat.recordedAt = new Date().toISOString();
  // Issue #3070: the dispatch source defaults to "claude" — NEVER "codex". Codex
  // was removed with ADR-0006 (the in-process codex control loop is gone), so no
  // cycle can legitimately originate from codex anymore. The prior stale "codex"
  // default silently mis-attributed every source-less write to a dead provider:
  // the dedup/enrichment writes in cycle-close.ts (`recordCycleMetrics(cycleId,
  // { tasksMerged })` / `{ filesChanged, prNumber }`) carry no `source`, and when
  // one of those lands as the FIRST HSET for a cycleId (e.g. a qa_orch relay
  // cycle reap never wrote a first record for) it minted a bogus `source:"codex"`
  // row. Those codex-sourced rows were exactly the ones carrying the
  // "unclassified"/"unknown" anchorType buckets in /api/metrics (issue #3070's
  // 30% gap). Defaulting to "claude" agrees with recordCycle's own first-write
  // default (cycle-close.ts:437) so the two writers can never disagree on
  // provenance, and no future write can be attributed to the retired provider.
  if (!flat.source) flat.source = "claude";

  await setCycleMetrics(cycleId, flat, CYCLE_KEY_TTL);

  // Issue #3391 (retiring the #3252 mirror): reap now keys ITS cycle-record on
  // the synthesised worktreeBranch — the SAME id the merge-watch enrichment adds
  // prNumber/filesChanged to — so the test counts and the merge fields land on
  // one indexed record per dispatch. There is no longer an un-joinable branch
  // twin to mirror onto, so the cross-key `enrichCycleMetrics` copy this module
  // used to run (and its phantom-partial-index hazard) is gone. `worktreeBranch`
  // survives as a metadata field (== cycleId in the pipeline case).

  console.log(`[Metrics] Recorded cycle ${cycleId}: ${metrics.tasksMerged || 0} merged, ${metrics.tasksFailed || 0} failed, regression=${metrics.regressionIntroduced || false}`);
}
