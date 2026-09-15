/**
 * src/cost/class-cost-efficiency.ts — the per-class cost efficiency read, i.e.
 * the QA-cost-dominance audit view (issue #2971, split out of the former
 * bundled cost-attribution module by issue #4347).
 *
 * The discover finding #2971 flagged QA as the single largest daily token
 * consumer (~38% of daily tokens) and asked whether validation scope is
 * appropriately scoped. But the issue itself notes the raw share is NOT a
 * finding: comprehensive QA is appropriate, and QA runs proportionally to dev
 * output, so a high QA *share* is expected, not wasteful. The falsifiable,
 * actionable number is QA tokens **per merged PR** — the unit-economics of
 * validation — which reframes "QA is 38% of spend" (alarming) as "QA costs N
 * tokens per merged PR" (comparable across windows, a real efficiency signal).
 *
 * This is a PURE DERIVED read (design-concept 4d98ab3d, invariant 6:
 * evidence-backed against recorded data). It composes two already-recorded
 * feeds — the per-class token rollup (`projectCostByClass`, from the per-skill
 * surrogate) and a merged-PR count (injected from the cycle-metrics merged
 * feed, exactly as `getCostPerMergedPr` does) — with NO new token-recording
 * writer, NO USD/dollar surface, NO gating (invariants 1–5). The per-class
 * buckets still sum to the daily total; this read is additive.
 *
 * Imports only the by-class rollup leaf + the snapshot type (issue #4347 INV-5:
 * the ONE intra-split edge is this file -> `./cost-by-class.ts`; the rollup
 * imports nothing back).
 *
 * Public symbols are re-exported from `src/cost/index.ts` — the single public
 * Interface of the Cost module; callers import from `../cost/index.ts`.
 */

// The per-class rollup this derived read composes (issue #4347 split): the
// efficiency fold re-derives over the rollup's `byClass` totals, one-way.
import { COST_CLASS_ORDER, getRollingCostByClass } from "./cost-by-class.ts";
import type { CostClass, CostByClassResult } from "./cost-by-class.ts";
import type { UsageSnapshot } from "./types.ts";

/** One class's efficiency line in the audit read. */
interface ClassCostEfficiencyEntry {
  /** Total tokens attributed to this class over the window. */
  tokens: number;
  /** Fraction of the window's total tokens (0..1, 2dp) — the raw "share". */
  fraction: number;
  /**
   * Derived unit-economics: `tokens / mergedPrCount`, rounded to the nearest
   * integer token. `null` when `mergedPrCount` is 0 (undefined, not a
   * misleading 0/Infinity) — consumers render `null` as "—". This is the
   * falsifiable efficiency number the audit turns on: a class's raw share is
   * expected to track its output, so the per-merge cost is what tells an
   * over-scoped class apart from a merely busy one.
   */
  tokensPerMergedPr: number | null;
}

export interface ClassCostEfficiencyResult {
  /** YYYY-MM-DD (UTC) the underlying per-class breakdown was computed for. */
  date: string;
  /** Total subagent tokens across all classes for the window. */
  totalTokens: number;
  /** Count of merged PRs over the window the per-merge ratios are derived from. */
  mergedPrCount: number;
  /**
   * Per-class efficiency keyed by CostClass; every class present (zeros
   * included, in `COST_CLASS_ORDER`), so the audit can compare QA against every
   * sibling class on the SAME per-merge basis rather than in isolation.
   */
  byClass: Record<CostClass, ClassCostEfficiencyEntry>;
  /**
   * The QA class's entry, surfaced at the top level so the #2971 audit read is
   * a one-hop lookup (`.qa.tokensPerMergedPr`) rather than a byClass dig. QA is
   * the finding's subject; every other class is available under `byClass` for
   * the comparative baseline the audit needs.
   */
  qa: ClassCostEfficiencyEntry;
  /** Human-readable window label (mirrors the source `CostByClassResult.window`). */
  window: string;
}

/**
 * Pure projection: fold an already-computed per-class token breakdown
 * (`CostByClassResult`) plus a merged-PR count into per-class efficiency lines
 * (tokens, share, tokens-per-merged-PR).
 *
 * Exported separately from the Redis-reading `getClassCostEfficiency` so the
 * unit-economics math is testable on fixtures without a live Redis or metrics
 * feed (ADR-0014 pure-core seam). Introduces NO new writer — it re-derives over
 * the `byClass` totals `projectCostByClass` already produced and a merged count
 * the caller injects from the cycle-metrics feed (issue #2971 invariant 6).
 */
export function projectClassCostEfficiency(
  costByClass: CostByClassResult,
  mergedPrCount: number,
): ClassCostEfficiencyResult {
  const merged =
    Number.isFinite(mergedPrCount) && mergedPrCount > 0 ? Math.floor(mergedPrCount) : 0;

  const byClass = {} as Record<CostClass, ClassCostEfficiencyEntry>;
  for (const cls of COST_CLASS_ORDER) {
    const src = costByClass.byClass[cls];
    const tokens = Number.isFinite(src?.tokens) && src.tokens > 0 ? Math.floor(src.tokens) : 0;
    byClass[cls] = {
      tokens,
      fraction: Number.isFinite(src?.fraction) ? src.fraction : 0,
      tokensPerMergedPr: merged > 0 ? Math.round(tokens / merged) : null,
    };
  }

  return {
    date: costByClass.date,
    totalTokens:
      Number.isFinite(costByClass.totalTokens) && costByClass.totalTokens > 0
        ? Math.floor(costByClass.totalTokens)
        : 0,
    mergedPrCount: merged,
    byClass,
    qa: byClass.qa,
    window: costByClass.window,
  };
}

/**
 * Read the per-class cost-efficiency breakdown over the default rolling ~24h
 * UTC window (the operator-facing "today" view — issue #2427 window semantics),
 * with the tokens-per-merged-PR ratio derived from an injected merged-PR count.
 *
 * Composes `getRollingCostByClass` (the per-class token rollup) with the pure
 * `projectClassCostEfficiency` fold. The merged count is INJECTED (not read
 * here) so the Cost module stays free of a `src/metrics/` import — the API
 * route (`src/api/metrics.ts`) owns the composition of the two feeds, exactly
 * as `getCostPerMergedPr` does (issue #2971: derived read, single public
 * Interface, no cross-import).
 */
export async function getClassCostEfficiency(
  mergedPrCount: number,
  now: Date = new Date(),
  opts: { snapshot?: UsageSnapshot } = {},
): Promise<ClassCostEfficiencyResult> {
  const costByClass = await getRollingCostByClass(now, opts);
  return projectClassCostEfficiency(costByClass, mergedPrCount);
}
