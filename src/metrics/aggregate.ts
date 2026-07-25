/**
 * Cycle-metrics trend-rollup coordinators consumed by /metrics, /summary, and
 * planner-facing accomplishments — rolling merge-rate, aggregate stats,
 * cumulative accomplishments, anchor distribution, fix:feature ratio.
 *
 * All seven zero-I/O pure projections (`computeRollingMergeRateFromTrend`,
 * `computeEmptyRateFromTrend`, `projectTokensPerMergedPR`, `projectAggregateStats`,
 * `projectCostByOutcome`, `projectCumulativeAccomplishments`,
 * `projectAnchorDistribution`, plus the `CycleOutcome` / `CostByOutcomeResult` /
 * `CYCLE_OUTCOME_ORDER` cost-by-outcome surface and the `AnchorDistributionResult`
 * shape) were relocated to the `./stats-projection.ts` pure leaf (issue #3212) so
 * the arithmetic is testable without a Redis fixture and a caller that needs only
 * the projection (e.g. `scheduler/rolling-rates.ts`, `api/metrics.ts`) imports the
 * leaf without this module's `getMetricsTrend` dependency. This module keeps ONLY
 * the async Redis-touching wrappers that fetch the trend and delegate to those
 * pure functions. It does NOT re-export the pure symbols (no back-compat shim,
 * issue #3212 invariant 2) — callers of a pure projection import it from
 * `./stats-projection.ts` directly.
 *
 * Per-class cost attribution (the `CostClass` / `skillToCostClass` /
 * `projectCostByClass` / `getCostByClass` surface) was relocated to the Cost
 * module at `src/cost/cost-attribution.ts` (issue #2219) so the Cost domain's
 * knowledge concentrates under `src/cost/`; import those symbols from
 * `../cost/index.ts`.
 */

import { getMetricsTrend } from "./trend.ts";
import {
  projectAggregateStats,
  projectCostByOutcome,
  projectCumulativeAccomplishments,
} from "./stats-projection.ts";
import {
  inferAnchorTypeFromCycleId,
  classifyNoAttributionShape,
  type NoAttributionShape,
} from "../autopilot/anchor-type.ts";

/**
 * Get the token cost broken down by cycle outcome over a recent trend window.
 *
 * Thin wrapper: fetch the trend (the `count` knob), then delegate the split to
 * the pure `projectCostByOutcome`. No new Redis write path — a derived read over
 * the `tokenCost` + outcome fields the trend already joins (issue #3024).
 */
export async function getCostByOutcome(count = 200) {
  const trend = await getMetricsTrend(count);
  return projectCostByOutcome(trend);
}

/**
 * Compute aggregate stats from metrics trend.
 *
 * Thin wrapper: fetch the rolling trend window from Redis (the `count` knob),
 * then delegate the arithmetic to the pure `projectAggregateStats`.
 */
export async function getAggregateStats(count = 20) {
  const trend = await getMetricsTrend(count);
  return projectAggregateStats(trend);
}

/**
 * Get a cumulative summary of what's been accomplished across recent cycles.
 * Used by the planner to avoid re-proposing completed work.
 *
 * Thin wrapper: fetch the trend (the `count` knob), then delegate to the pure
 * `projectCumulativeAccomplishments`.
 */
export async function getCumulativeAccomplishments(count = 15) {
  const trend = await getMetricsTrend(count);
  return projectCumulativeAccomplishments(trend);
}

/**
 * The two-way classification of an `unclassified`-sentinel cycle (issue #3602).
 *
 *   - `fixable` — the STORED anchorType is the sentinel, but a SECOND decode
 *     source (the cycle's `worktreeBranch` head ref) DOES decode to a real lane
 *     via the same never-guess {@link inferAnchorTypeFromCycleId} parser. This is
 *     the #3602 "Shape B" gap: a bare-UUID cycleId reap first-wrote `unclassified`
 *     (no branch known at reap), then a decodable branch arrived on a later
 *     enrichment write. The #3604 write-path heal upgrades these in place once it
 *     deploys, so a `fixable` residue is a genuine classifier/attribution gap a
 *     forward fix can (and does) close.
 *   - `no-attribution` — NEITHER the cycleId NOR the `worktreeBranch` carries any
 *     decodable class token (#3602 "Shapes A/C": a bare UUID with a
 *     descriptive/longhash branch, `autopilot-<hash>-t{N}`, a bare
 *     `worktree-agent-<longhash>`). These are structurally undecodable BY DESIGN
 *     under the #2822 never-guess invariant — there is no lane to recover without
 *     guessing. This is inherent harness-cycle noise, not a fixable classifier
 *     gap; a producer-side "emit anchorType at reap" change is the only honest
 *     fix and is out of scope of #3602.
 */
export type UnclassifiedClassification = "fixable" | "no-attribution";

/**
 * A single still-unclassified cycle's attribution metadata (issue #3403).
 *
 * Exposed by {@link getUnclassifiedAnchors} so the residue that survives the
 * classifier (`src/autopilot/anchor-type.ts` — after skill-name, slot, and
 * unambiguous-prefix inference) is ATTRIBUTABLE rather than an opaque bucket
 * count. The discovery playbook's >10%-unclassified architectural-review trigger
 * needs the offending cycleIds to root-cause the gap; before this the /metrics
 * distribution only reported HOW MANY were unclassified, never WHICH.
 */
export interface UnclassifiedAnchorRecord {
  /** The cycleId that could not be decoded to a lane. */
  cycleId: string;
  /** The merged-PR number, when the record was a merge-status enrichment. */
  prNumber?: string;
  /** The anchor reference (issue ref), when the writer forwarded one. */
  anchorReference?: string;
  /** The human task title, when the writer forwarded one. */
  taskTitle?: string;
  /**
   * The #3602 two-way split: `fixable` (a second decode source recovers a lane)
   * vs `no-attribution` (structurally undecodable, inherent harness noise). See
   * {@link UnclassifiedClassification}.
   */
  classification: UnclassifiedClassification;
  /**
   * For a `no-attribution` cycle only (issue #3623): the stable kebab-case token
   * naming WHY it is structurally undecodable (`harness-branch`, `bare-uuid`,
   * `autopilot-turn`, `descriptive-branch`, `unknown-shape`). Absent on a
   * `fixable` row — a fixable cycle HAS a recoverable lane, so "why undecodable"
   * does not apply. This makes the `no-attribution` residue self-documenting: the
   * operator sees the reason inline instead of re-deriving it per cycleId by hand.
   */
  shape?: NoAttributionShape;
}

/**
 * The unclassified-anchor instrumentation projection (issue #3403).
 *
 * Surfaces the metadata of every cycle in the recent window whose anchorType is
 * the `unclassified` sentinel — the root-cause capture the #3403 proposed
 * solution (#3) calls for. Emitting the cycleId + prNumber makes each a
 * "documented exception" the operator can map back to its PR, satisfying the
 * #3403 success criterion that every unclassified cycle map to a named type OR a
 * documented exception.
 *
 * Issue #3602 — the two-way SUB-BUCKET split. The single `unclassified` bucket
 * conflated two structurally different populations, so the discovery playbook's
 * >10%-unclassified architectural-review trigger fired on inherent harness noise
 * that no classifier change can fix:
 *
 *   - `fixable` — the STORED anchorType is the sentinel, but the cycle's
 *     `worktreeBranch` head ref DOES decode to a real lane via the same
 *     never-guess {@link inferAnchorTypeFromCycleId} parser (the #3602 Shape-B
 *     first-write timing gap the #3604 write-path heal closes). NOTE: the read
 *     path (`getMetricsTrend`) already re-runs the parser over the CYCLEID for
 *     sentinel rows, so a row still sentinel here has an undecodable cycleId; the
 *     `worktreeBranch` is the residual second source that distinguishes a fixable
 *     gap from inherent noise.
 *   - `no-attribution` — neither the cycleId nor the `worktreeBranch` carries a
 *     decodable class token (#3602 Shapes A/C). Structurally undecodable under the
 *     #2822 never-guess invariant — inherent harness-cycle noise, not a fixable
 *     classifier gap.
 *
 * `fixableRate` (the % of the window that is `fixable`) is what the architectural
 * trigger should key on, so undecodable-by-design residue can no longer trip it.
 * `rate` (the total sentinel %) is preserved verbatim for back-compat.
 *
 * Thin wrapper: fetch the trend (the `count` knob), then filter/shape the
 * sentinel rows — mirrors the other `getX` aggregators in this module.
 */
export async function getUnclassifiedAnchors(count = 50): Promise<{
  windowCycles: number;
  unclassified: UnclassifiedAnchorRecord[];
  rate: number;
  fixable: number;
  noAttribution: number;
  fixableRate: number;
  /**
   * Issue #3623: the `no-attribution` count broken down by the structural SHAPE
   * that makes each cycle undecodable, keyed by the {@link NoAttributionShape}
   * token. Sums to `noAttribution`. This is the "document the undecodable shape"
   * root-cause capture the issue calls for — an operator (or the discover class)
   * can read WHY the residue is dark (e.g. `{ "harness-branch": 5, "bare-uuid":
   * 6, "autopilot-turn": 2, "descriptive-branch": 1 }`) without fetching each
   * cycleId/branch and re-deriving the shape by hand.
   */
  noAttributionShapes: Record<string, number>;
}> {
  const trend = await getMetricsTrend(count);
  const unclassified: UnclassifiedAnchorRecord[] = [];
  let fixable = 0;
  let noAttribution = 0;
  const noAttributionShapes: Record<string, number> = {};
  for (const m of trend) {
    if ((m.anchorType && String(m.anchorType).trim()) !== "unclassified") continue;
    // #3602 split: the read path already tried the cycleId, so fixability hinges
    // on whether the STORED worktreeBranch (a second decode source) decodes via
    // the SAME never-guess parser. A decodable branch → `fixable` (Shape B, the
    // #3604 heal closes it); no decodable branch → `no-attribution` (Shapes A/C,
    // structurally undecodable — inherent harness noise, never a guess).
    const branch =
      m.worktreeBranch !== undefined &&
      m.worktreeBranch !== null &&
      String(m.worktreeBranch).trim().length > 0
        ? String(m.worktreeBranch).trim()
        : undefined;
    const classification: UnclassifiedClassification =
      branch !== undefined && inferAnchorTypeFromCycleId(branch) !== undefined
        ? "fixable"
        : "no-attribution";
    const cycleId = String(m.cycleId);
    // Issue #3623: name the structural shape of a no-attribution cycle so the
    // residue is self-documenting. Never guesses a lane (#2822) — it only labels
    // WHY the cycle carries no decodable class token.
    const shape =
      classification === "no-attribution"
        ? classifyNoAttributionShape(cycleId, branch)
        : undefined;
    if (classification === "fixable") fixable++;
    else {
      noAttribution++;
      if (shape !== undefined) {
        noAttributionShapes[shape] = (noAttributionShapes[shape] ?? 0) + 1;
      }
    }
    const record: UnclassifiedAnchorRecord = {
      cycleId,
      classification,
    };
    if (shape !== undefined) record.shape = shape;
    if (m.prNumber !== undefined && m.prNumber !== null && String(m.prNumber).length > 0) {
      record.prNumber = String(m.prNumber);
    }
    if (m.anchorReference) record.anchorReference = String(m.anchorReference);
    if (m.taskTitle) record.taskTitle = String(m.taskTitle);
    unclassified.push(record);
  }
  const windowCycles = trend.length;
  const pct = (n: number) =>
    windowCycles > 0 ? +((n / windowCycles) * 100).toFixed(1) : 0;
  return {
    windowCycles,
    unclassified,
    rate: pct(unclassified.length),
    fixable,
    noAttribution,
    // #3602: the architectural-review trigger keys on THIS, not `rate`, so
    // structurally-undecodable harness noise (`no-attribution`) can no longer
    // trip the >10% gate.
    fixableRate: pct(fixable),
    // #3623: the no-attribution count split by structural shape (sums to
    // `noAttribution`) so the dark residue is self-documenting.
    noAttributionShapes,
  };
}

/**
 * Compute fix:feature ratio from recent cycles.
 * Fixes = prior-failure or failing-test anchors. Features = everything else that merged.
 */
export async function getFixFeatureRatio(count = 20) {
  const trend = await getMetricsTrend(count);
  let fixes = 0, features = 0;
  for (const m of trend) {
    if (m.tasksMerged > 0) {
      if (m.anchorType === "prior-failure" || m.anchorType === "failing-test") {
        fixes++;
      } else {
        features++;
      }
    }
  }
  return { fixes, features, ratio: features > 0 ? +(fixes / features).toFixed(1) : 0, total: trend.length };
}
