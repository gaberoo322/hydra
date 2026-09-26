/**
 * Shared `#N`-ref extraction + by-source merge seam for the two GitHub-issue
 * aggregators (issue #2130; scope narrowed by #4621/ADR-0034 §8.1).
 *
 * Originally this seam also owned the dated `Operator decision queue
 * YYYY-MM-DD` issue-body parser. That digest was `/hydra-autopilot`'s
 * unattended-mode hand-off surface; ADR-0034 §8.1 retired it in favor of
 * `hydra-grill` posting its gate-fail handoff directly on the anchor issue
 * (a `## hydra-grill handoff` comment + the `ready-for-human` label) — so
 * there is no dated issue left to parse, and the dated-title / digest-ref
 * primitives were deleted with it (`datedTitle`, `digestRefsFromRows`,
 * `addDays`).
 *
 * What remains is the two aggregators' actual shared concern:
 *
 *   - `extractIssueRefs`   — pull `#N` references out of a markdown body
 *     (still used by `review-pickup.ts`'s stale-blocked classifier,
 *     `blockedIssuesFromRows`, to find an issue's claimed blockers).
 *   - `labeledItemsFromRows` — map the GitHub Issue Read seam's `IssueRow`
 *     rows to the wide `RawDigestInput` shape both aggregators merge on.
 *   - `mergeBySource`      — the dedup/merge skeleton both aggregators use
 *     to unify their (now two, not three) label-fed sources into one list.
 *
 * The `getDecisionQueue` / `mergeDecisionItems` / `mergePickupItems`
 * orchestration logic stays in its respective aggregator — only these
 * shared primitives live here.
 */

import type { IssueRow } from "../github/issues.ts";

/**
 * The raw, pre-merge shape a labeled row maps to. Both aggregators narrow
 * this down to their own item type (`DecisionItem` / `PickupItem`) after
 * merge; the seam emits the wide shape so neither aggregator's merge step
 * loses a field it might need.
 */
export interface RawDigestInput {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
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

// ---------------------------------------------------------------------------
// Multi-source merge/dedup contract (issue #2639)
// ---------------------------------------------------------------------------

/**
 * One deduped row emitted by {@link mergeBySource}. The seam owns the dedup
 * *skeleton* (keying, ordering, first-write-wins, sources accumulation) but NOT
 * the caller's domain projection or sort — those differ between aggregators
 * (`DecisionItem` carries createdAt+labels and sorts createdAt-then-number;
 * `PickupItem` is lean and sorts number-only), so each caller maps this
 * intermediate onto its own item type and applies its own sort.
 *
 * @typeParam S - the caller's source-label union (e.g. `DecisionItemSource`).
 */
export interface MergedBySource<S extends string> {
  /** The full raw input row that first surfaced this issue number. */
  row: RawDigestInput;
  /** The FIRST source (in `order`-array priority) that surfaced this item. */
  source: S;
  /** Every source that surfaced this item, deduped, in `order`-array order. */
  sources: S[];
}

/**
 * The shared multi-source merge/dedup skeleton for the two GitHub-issue
 * aggregators (decision-queue.ts, review-pickup.ts). Both aggregators unify
 * several issue sources into one deduped list keyed by issue number; the ONLY
 * differences between them (output field set, whether labels union on a
 * duplicate, and the final sort key) are caller policy, kept at the call site.
 *
 * The algorithm, owned here:
 *   - Iterate the sources in the fixed `order` array — NOT input-record order —
 *     so the primary `.source` of a deduped item is the first source in `order`
 *     that surfaced it (first-write-wins by order priority).
 *   - Key by `row.number`; the first row wins its own `.row`. A later duplicate
 *     appends its source to `.sources` (deduped) and invokes `onDuplicate`, if
 *     provided, so the caller can fold caller-specific state (e.g. a label union
 *     onto the already-kept row).
 *   - `.sources[]` lists every source that surfaced the item, in `order` order.
 *
 * The retained `.row.labels` array is cloned on first write so an `onDuplicate`
 * label-union mutates the seam's copy, never the caller's input array.
 *
 * @param bySource   - map of source label → the raw rows that source produced.
 * @param order      - the fixed source-priority order (drives first-write-wins).
 * @param onDuplicate- optional fold invoked when a later source re-surfaces an
 *                     already-kept item; receives the kept intermediate and the
 *                     incoming raw row. Decision-queue passes a label-union;
 *                     review-pickup omits it (PickupItem has no labels field).
 * @returns the deduped intermediates in first-seen (i.e. `order`-driven) order;
 *          the caller projects and sorts.
 */
export function mergeBySource<S extends string>(
  bySource: Partial<Record<S, RawDigestInput[]>>,
  order: readonly S[],
  onDuplicate?: (existing: MergedBySource<S>, incoming: RawDigestInput) => void,
): MergedBySource<S>[] {
  const byNumber = new Map<number, MergedBySource<S>>();
  for (const source of order) {
    for (const item of bySource[source] ?? []) {
      const existing = byNumber.get(item.number);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        onDuplicate?.(existing, item);
        continue;
      }
      byNumber.set(item.number, {
        // Clone labels so a caller's onDuplicate union never mutates the input.
        row: { ...item, labels: [...item.labels] },
        source,
        sources: [source],
      });
    }
  }
  return [...byNumber.values()];
}
