/**
 * Backlog-flow aggregator (issue #620, PRD #615) — Explore page Flow tab.
 *
 * Counts of issues `added`, `closed`, and `blocked` inside a sliding window
 * (default 7 days), bucketed by **provenance label** — *which filing pipeline
 * produced the issue* (`tool-scout`, `architecture-scan`, `cleanup-scan`,
 * `sentry`), the same vocabulary `recent-merges.ts` uses for the Today page.
 * The vocabulary is served by the Dispatch-Class Taxonomy Module
 * (`src/taxonomy/classes.ts`), derived from the classes.json
 * `provenanceLabel` column plus its residual list (#1672 — the prior
 * `dev_orch`/`qa`/… class-label alphabet matched zero real labels, so every
 * issue bucketed `unclassified`). Issues carrying no provenance label fall
 * to the `unclassified` residual bucket; none are dropped.
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
 * - **Pure helpers exported.** `bucketByClass` and `iso8601DateOnly` are pure
 *   functions tested directly (classification itself is the taxonomy
 *   Module's `provenanceFromLabels`).
 * - **Never throws.** Each `gh` call runs under `Promise.allSettled`; a
 *   sub-source failure leaves that column at 0 for every bucket.
 * - **Window clamped.** windowDays is clamped to [1, 30] — the upper bound
 *   matches the `gh issue list` search-date sanity and keeps the per-bucket
 *   table small enough to render without pagination.
 */

import {
  listIssuesByLabelOrEmpty,
  listIssuesBySearchOrEmpty,
  type IssueRow,
} from "../github/issues.ts";
import { provenanceFromLabels } from "../taxonomy/classes.ts";
import { settledOrEmpty } from "../settled-fold.ts";
import { windowStart as trendWindowStart, dayKey } from "./trend-series.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClassFlowRow {
  /**
   * Provenance label (`tool-scout` / `cleanup-scan` / …), OR the literal
   * "unclassified" residual bucket. Wire key stays `class` for dashboard
   * stability (FlowTab) — only the value vocabulary changed (#1672).
   */
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

// The provenance vocabulary + classifier live in the Dispatch-Class Taxonomy
// Module (`src/taxonomy/classes.ts`, #1672) — one authoritative copy derived
// from classes.json. Only the residual bucket NAME is local: it folds the
// classifier's null arm so the BacklogFlow wire shape keeps the literal
// "unclassified" the dashboard already renders.
const UNCLASSIFIED_BUCKET = "unclassified";

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
 * Pure helper — exported for tests. Produces one row per provenance bucket
 * that appears in ANY of the three columns (classification via the taxonomy
 * Module's `provenanceFromLabels`; the null arm folds to the "unclassified"
 * residual bucket). Sorted by `added + closed + blocked` descending so the
 * busiest bucket lands at the top.
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
  const bucketOf = (labels: readonly string[]): string =>
    provenanceFromLabels(labels) ?? UNCLASSIFIED_BUCKET;
  for (const i of added) ensure(bucketOf(i.labels)).added += 1;
  for (const i of closed) ensure(bucketOf(i.labels)).closed += 1;
  for (const i of blocked) ensure(bucketOf(i.labels)).blocked += 1;
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
