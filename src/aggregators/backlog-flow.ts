/**
 * Backlog-flow aggregator (issue #620, PRD #615) — Explore page Flow tab.
 *
 * Per-class counts of issues `added`, `closed`, and `blocked` inside a
 * sliding window (default 7 days). "Class" here is the autopilot dispatch
 * taxonomy (`dev_orch`, `dev_target`, `qa`, `sweep_orch`, …) read from a
 * GitHub label — the same taxonomy used by `recent-merges.ts` for the Today
 * page. Issues without a known class label are bucketed under `unclassified`.
 *
 * # Data path
 *
 * 1. `gh issue list --search "created:>=YYYY-MM-DD"` → all opened-in-window.
 * 2. `gh issue list --state closed --search "closed:>=YYYY-MM-DD"` → all
 *    closed-in-window. The bucketing by label happens client-side.
 * 3. `gh issue list --state open --label blocked` → current blocked snapshot.
 *
 * Note: `blocked` is a point-in-time snapshot, not a per-window delta. That
 * matches what the operator wants on the Flow tab — "where is work
 * accumulating right now?". `added` and `closed` are window deltas.
 *
 * # Design contract
 *
 * - **Pure classifiers exported.** `classFromLabels`, `bucketByClass`, and
 *   `iso8601DateOnly` are pure functions tested directly.
 * - **Never throws.** Each `gh` call runs under `Promise.allSettled`; a
 *   sub-source failure leaves that column at 0 for every class.
 * - **Window clamped.** windowDays is clamped to [1, 30] — the upper bound
 *   matches the `gh issue list` search-date sanity and keeps the per-class
 *   table small enough to render without pagination.
 */

import {
  classFromLabels as seamClassFromLabels,
  listIssuesByLabelOrEmpty,
  listIssuesBySearchOrEmpty,
  type IssueRow,
} from "../github/issues.ts";
import { settledOrEmpty } from "./settle.ts";
import { windowStart as trendWindowStart, dayKey } from "./trend-series.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClassFlowRow {
  /** Autopilot class label, OR the literal "unclassified" bucket. */
  class: string;
  added: number;
  closed: number;
  blocked: number;
}

export interface BacklogFlow {
  byClass: ClassFlowRow[];
  /** Echo of the window so the dashboard can label "last Nd". */
  windowDays: number;
  /** Sum across all classes, so the dashboard can render a header total. */
  totals: { added: number; closed: number; blocked: number };
  generatedAt: string;
}

export interface BacklogFlowDeps {
  now?: Date;
  githubRepo?: string;
  /**
   * Override the GitHub Issue/PR Read seam readers (issue #908/#915). Tests
   * inject these to avoid spawning `gh`; production uses the real seam readers.
   * Only `labels` are read off each {@link IssueRow}; the seam over-fetches the
   * canonical field set (cheaper than N divergent `--json` lists).
   */
  listIssuesBySearchOrEmpty?: typeof listIssuesBySearchOrEmpty;
  listIssuesByLabelOrEmpty?: typeof listIssuesByLabelOrEmpty;
}

// The aggregator only reads each issue's `labels` for class bucketing.
type FlowIssue = Pick<IssueRow, "labels">;

const MAX_WINDOW_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 7;

// The autopilot dispatch-class taxonomy + the "unclassified" sentinel live in
// the GitHub Issue/PR Read seam (issue #908) — one authoritative copy, no more
// array-vs-Set drift with recent-merges.ts. `classFromLabels` below re-exports
// the seam's classifier so existing importers/tests are unaffected.

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getBacklogFlow(
  windowDays: number,
  deps: BacklogFlowDeps = {},
): Promise<BacklogFlow> {
  const now = deps.now ?? new Date();
  const days = clampWindowDays(windowDays);
  const windowStart = trendWindowStart(now, days);
  const sinceDate = iso8601DateOnly(windowStart);

  const listBySearch = deps.listIssuesBySearchOrEmpty ?? listIssuesBySearchOrEmpty;
  const listByLabel = deps.listIssuesByLabelOrEmpty ?? listIssuesByLabelOrEmpty;
  // Behaviour-preserving query knobs: the wide window can return many rows.
  const wide = { repo: deps.githubRepo, limit: 1000, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 };

  const [addedResult, closedResult, blockedResult] = await Promise.allSettled([
    listBySearch(`created:>=${sinceDate}`, "backlog-flow/added", { ...wide, state: "all" }),
    listBySearch(`closed:>=${sinceDate}`, "backlog-flow/closed", { ...wide, state: "closed" }),
    listByLabel("blocked", "backlog-flow/blocked", { ...wide, state: "open" }),
  ]);

  const added = settledOrEmpty(addedResult, "backlog-flow/added");
  const closed = settledOrEmpty(closedResult, "backlog-flow/closed");
  const blocked = settledOrEmpty(blockedResult, "backlog-flow/blocked");

  const byClass = bucketByClass(added, closed, blocked);

  const totals = byClass.reduce(
    (acc, row) => ({
      added: acc.added + row.added,
      closed: acc.closed + row.closed,
      blocked: acc.blocked + row.blocked,
    }),
    { added: 0, closed: 0, blocked: 0 },
  );

  return {
    byClass,
    windowDays: days,
    totals,
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

export function clampWindowDays(d: number): number {
  if (!Number.isFinite(d)) return DEFAULT_WINDOW_DAYS;
  const n = Math.floor(d);
  if (n < 1) return 1;
  if (n > MAX_WINDOW_DAYS) return MAX_WINDOW_DAYS;
  return n;
}

/**
 * Pure helper — exported for tests and the dashboard. Returns the first known
 * autopilot-class label on the issue, or "unclassified" if none match.
 * Case-sensitive. Delegates to the GitHub Issue/PR Read seam (issue #908) so
 * the taxonomy has exactly one home; re-exported here for backward
 * compatibility with existing importers.
 */
export const classFromLabels = seamClassFromLabels;

/**
 * Pure helper — exported for tests. Produces one row per class that appears
 * in ANY of the three buckets. Sorted by `added + closed + blocked`
 * descending so the busiest class lands at the top.
 */
export function bucketByClass(
  added: readonly FlowIssue[],
  closed: readonly FlowIssue[],
  blocked: readonly FlowIssue[],
): ClassFlowRow[] {
  const tally = new Map<string, ClassFlowRow>();
  const ensure = (cls: string): ClassFlowRow => {
    let row = tally.get(cls);
    if (!row) {
      row = { class: cls, added: 0, closed: 0, blocked: 0 };
      tally.set(cls, row);
    }
    return row;
  };
  for (const i of added) ensure(classFromLabels(i.labels)).added += 1;
  for (const i of closed) ensure(classFromLabels(i.labels)).closed += 1;
  for (const i of blocked) ensure(classFromLabels(i.labels)).blocked += 1;
  return [...tally.values()].sort((a, b) => {
    const aTotal = a.added + a.closed + a.blocked;
    const bTotal = b.added + b.closed + b.blocked;
    if (bTotal !== aTotal) return bTotal - aTotal;
    return a.class.localeCompare(b.class);
  });
}

/**
 * Pure helper — exported for tests. Strips an ISO timestamp down to
 * YYYY-MM-DD. Delegates to the shared trend-series day-key (issue #956) so
 * the date-only form can't drift from the day-bucket form.
 */
export function iso8601DateOnly(d: Date): string {
  return dayKey(d);
}
