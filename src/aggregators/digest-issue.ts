/**
 * Dated-digest-issue parsing seam (issue #2130).
 *
 * Owns one concern: **parsing the dated `Operator decision queue YYYY-MM-DD`
 * issue body** for the operator-attention item references inside it. These
 * primitives are pure (no `gh`, no Redis, no clock beyond the `Date` they're
 * handed) and serve two parallel-peer aggregators:
 *
 *   - `decision-queue.ts` — builds the dashboard decision queue.
 *   - `review-pickup.ts`  — builds the `/hydra-review` operator pickup set.
 *
 * Before #2130 these lived inside `decision-queue.ts` and `review-pickup.ts`
 * imported them across a sibling boundary, implying the dashboard aggregator
 * *owned* the dated-digest format. It doesn't — the format is a third thing
 * both aggregators consume. This seam is that third thing's single home: a
 * change to the dated-title format (e.g. adding a time component) or the
 * `#N` extraction strategy is one edit here, not a hunt through two
 * aggregators. The seam IS the test surface for digest-body parsing
 * (`test/aggregator-decision-queue.test.mts`).
 *
 * The `getDecisionQueue` / `mergeDecisionItems` / `mergePickupItems`
 * orchestration logic stays in its respective aggregator — only the
 * digest-format primitives moved.
 */

import type { IssueRow } from "../github/issues.ts";

/**
 * The raw, pre-merge shape a digest/labeled row maps to. Both aggregators
 * narrow this down to their own item type (`DecisionItem` / `PickupItem`)
 * after merge; the seam emits the wide shape so neither aggregator's merge
 * step loses a field it might need.
 */
export interface RawDigestInput {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
}

// ---------------------------------------------------------------------------
// Dated-title format
// ---------------------------------------------------------------------------

/**
 * The canonical `Operator decision queue YYYY-MM-DD` title for a given date,
 * computed in UTC. This is the single source of truth for the dated-digest
 * title format — both aggregators search for it and the test asserts it.
 */
export function datedTitle(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `Operator decision queue ${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Issue-ref extraction
// ---------------------------------------------------------------------------

/**
 * Pull every `#N` reference out of a markdown body, deduped, in order of
 * first appearance. Skips inline code spans (anything inside backticks) so
 * URLs or commit hashes in code don't poison the queue.
 */
export function extractIssueRefs(body: string): number[] {
  if (!body) return [];
  // Strip backtick code spans first — `#1234` inside `code` is not a ref.
  const stripped = body.replace(/`[^`]*`/g, "");
  const seen = new Set<number>();
  const out: number[] = [];
  const re = /(?<![\w/])#(\d+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

/**
 * From the seam's {@link IssueRow} rows of a digest-title search, find the
 * exact-title match, then extract every `#N` reference from its body. For
 * each referenced number, return a raw digest input. The url/createdAt/labels
 * are inherited from the digest issue itself so a caller has something to
 * render even if the referenced sub-issue lookup later fails (sub-issues are
 * fetched separately by the labeled-issue sources).
 */
export function digestRefsFromRows(
  rows: readonly IssueRow[],
  expectedTitle: string,
): RawDigestInput[] {
  for (const row of rows) {
    if (row.title !== expectedTitle) continue;
    const refs = extractIssueRefs(row.body);
    return refs.map((number) => ({
      number,
      title: `Referenced from ${expectedTitle} (#${number})`,
      url: `https://github.com/gaberoo322/hydra/issues/${number}`,
      createdAt: row.createdAt || new Date(0).toISOString(),
      labels: [...row.labels],
    }));
  }
  return [];
}

/**
 * Map the seam's {@link IssueRow} rows of a labeled query to the raw
 * digest-input shape. The seam already synthesizes title/url fallbacks and
 * drops invalid rows; here we only re-home `createdAt` to the epoch sentinel
 * when the seam returned `""`.
 */
export function labeledItemsFromRows(rows: readonly IssueRow[]): RawDigestInput[] {
  return rows.map((row) => ({
    number: row.number,
    title: row.title,
    url: row.url,
    createdAt: row.createdAt || new Date(0).toISOString(),
    labels: [...row.labels],
  }));
}
