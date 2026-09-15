/**
 * src/cost/usage-by-issue.ts — the dispatch -> issue cost-join read surface
 * (issue #4126, ADR-0032 epic #4123 slice gamma; split out of the former
 * bundled cost-attribution module by issue #4347).
 *
 * The prerequisite for the A/B primary endpoint (#4123): joins the per-dispatch
 * token figure recorded at reap time (`src/redis/cost.ts`'s
 * `DispatchCostJoinRecord`, written via `POST /api/usage/dispatch-cost`) back
 * to the anchor issue it worked on. `projectUsageByIssue` is the pure fold;
 * `getUsageByIssue` composes it with the Redis-seam reads.
 *
 * Imports only `../redis/cost.ts` (issue #4347 INV-5: dependency-narrow — the
 * cost join needs no other Cost-module sibling; `src/redis/cost.ts` imports
 * nothing back).
 *
 * Public symbols are re-exported from `src/cost/index.ts` — the single public
 * Interface of the Cost module; callers import from `../cost/index.ts`.
 */

import {
  listDispatchCostJoinIssues,
  getDispatchCostJoinForIssue,
  getUnattributedDispatchCostJoin,
} from "../redis/cost.ts";
import type { DispatchCostJoinRecord } from "../redis/cost.ts";

/** One issue's rolled-up dispatch-cost-join ledger. */
interface UsageByIssueEntry {
  issue: number;
  /** Sum of `dispatchTokensEstimate` across every recorded dispatch for this issue. */
  totalDispatchTokensEstimate: number;
  /** Number of recorded dispatches (any class) attributed to this issue. */
  dispatchCount: number;
  /** Per-class token subtotal, keyed by the raw dispatch-class name. */
  byClass: Record<string, number>;
  /** The raw records this entry was folded from, newest-first. */
  records: DispatchCostJoinRecord[];
}

/**
 * `GET /api/usage/by-issue`'s response shape. Always carries the residual —
 * issue #4126's acceptance criterion that an unattributable dispatch is
 * reported as an explicit residual, never dropped — and `attributedPercent`
 * alongside it, mirroring the existing `attributedPercent` convention
 * `UsageSnapshot` already established for skill-level attribution (~90%
 * there; this is the SAME honesty contract at issue granularity).
 */
export interface UsageByIssueResult {
  /** Every attributed issue's rollup (or just the one queried, if filtered),
   *  sorted by `totalDispatchTokensEstimate` descending. */
  byIssue: UsageByIssueEntry[];
  /** Sum of every attributed issue's `totalDispatchTokensEstimate`. */
  totalAttributedTokensEstimate: number;
  /** Sum of the unattributable residual ledger's `dispatchTokensEstimate`. */
  residualTokensEstimate: number;
  /** Count of unattributable records — never silently dropped (issue #4126). */
  residualDispatchCount: number;
  /** `100 * attributed / (attributed + residual)`, rounded to 2dp; 0 when
   *  both are 0 (nothing recorded yet). */
  attributedPercent: number;
  /** ISO8601 timestamp this view was assembled. */
  generatedAt: string;
}

/**
 * Pure fold: turn a per-issue set of raw ledger reads plus the global
 * unattributed residual into the {@link UsageByIssueResult} shape. Redis-free
 * (ADR-0014 pure-core seam) so the fold is unit-testable on fixtures without
 * a live Redis — mirrors the sibling `project*` folds' split from their
 * Redis-reading `get*` coordinators (`cost-by-class.ts`'s
 * `projectCostByClass`, `class-cost-efficiency.ts`'s
 * `projectClassCostEfficiency`; issue #4347 split).
 */
export function projectUsageByIssue(
  perIssue: Array<{ issue: number; records: DispatchCostJoinRecord[] }>,
  unattributed: DispatchCostJoinRecord[],
  now: () => string = () => new Date().toISOString(),
): UsageByIssueResult {
  const byIssue: UsageByIssueEntry[] = [];
  let totalAttributed = 0;

  for (const { issue, records } of perIssue) {
    const byClass: Record<string, number> = {};
    let issueTotal = 0;
    for (const rec of records) {
      const n =
        Number.isFinite(rec.dispatchTokensEstimate) && rec.dispatchTokensEstimate > 0
          ? rec.dispatchTokensEstimate
          : 0;
      byClass[rec.class] = (byClass[rec.class] || 0) + n;
      issueTotal += n;
    }
    byIssue.push({
      issue,
      totalDispatchTokensEstimate: issueTotal,
      dispatchCount: records.length,
      byClass,
      records,
    });
    totalAttributed += issueTotal;
  }
  byIssue.sort((a, b) => b.totalDispatchTokensEstimate - a.totalDispatchTokensEstimate);

  let residual = 0;
  for (const rec of unattributed) {
    residual +=
      Number.isFinite(rec.dispatchTokensEstimate) && rec.dispatchTokensEstimate > 0
        ? rec.dispatchTokensEstimate
        : 0;
  }

  const denom = totalAttributed + residual;
  const attributedPercent = denom > 0 ? Math.round((totalAttributed / denom) * 10000) / 100 : 0;

  return {
    byIssue,
    totalAttributedTokensEstimate: totalAttributed,
    residualTokensEstimate: residual,
    residualDispatchCount: unattributed.length,
    attributedPercent,
    generatedAt: now(),
  };
}

/**
 * Read the dispatch -> issue cost-join view (issue #4126). No `issueFilter`
 * reads every issue in the index; a supplied `issueFilter` narrows `byIssue`
 * to that one issue while the residual / `attributedPercent` figures still
 * fold over the WHOLE ledger (see the `UsageByIssueQuerySchema` consumer in
 * `src/api/usage.ts` for why: a GLM-arm issue's residual visibility must not
 * depend on which issue the caller happened to query).
 */
export async function getUsageByIssue(issueFilter?: number): Promise<UsageByIssueResult> {
  const unattributed = await getUnattributedDispatchCostJoin();
  if (issueFilter) {
    const records = await getDispatchCostJoinForIssue(issueFilter);
    return projectUsageByIssue([{ issue: issueFilter, records }], unattributed);
  }
  const issues = await listDispatchCostJoinIssues();
  const perIssue = await Promise.all(
    issues.map(async (issue) => ({ issue, records: await getDispatchCostJoinForIssue(issue) })),
  );
  return projectUsageByIssue(perIssue, unattributed);
}
