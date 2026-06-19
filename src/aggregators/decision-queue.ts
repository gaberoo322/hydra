/**
 * Decision-queue aggregator (issue #617, PRD #615).
 *
 * Unifies three operator-decision sources into one age-sorted list:
 *
 *   1. The dated `Operator decision queue YYYY-MM-DD` issue body — overnight
 *      autopilot's hand-off digest. Each line in the body that mentions
 *      `#N` becomes a queue item.
 *   2. Issues currently labeled `ready-for-human` — persistent operator
 *      attention queue from the triage skill.
 *   3. Issues currently labeled `needs-info` — items waiting on a
 *      clarifying answer.
 *
 * Dedupes by issue number (an issue can appear in both the digest body and
 * a label; we keep the first source we see and preserve all sources in a
 * companion field so the dashboard can render multiple badges). Sorts by
 * `createdAt` ascending so the oldest item is first.
 *
 * # Design contract
 *
 * - **Pure aggregator.** Same shape as overnight-summary.ts: every external
 *   touchpoint is in `deps`, defaults wire up the real impls, sub-source
 *   failure is isolated via `Promise.allSettled`.
 * - **Never throws.** A failed sub-fetch returns `[]` for that source; the
 *   remaining sources still ship.
 * - **GitHub-only.** No Redis dependency — all three sources are GitHub
 *   issues queried via `gh issue list`.
 */

import {
  listIssuesByLabelOrEmpty,
  listIssuesBySearchOrEmpty,
} from "../github/issues.ts";

import type { DecisionItemSource } from "./types.ts";
import { settledOrEmpty } from "./settle.ts";
import {
  datedTitle,
  digestRefsFromRows,
  labeledItemsFromRows,
  type RawDigestInput,
} from "./digest-issue.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DecisionItem {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
  /** Where this item was first surfaced — see `DecisionItemSource`. */
  source: DecisionItemSource;
  /** All sources that surfaced this item (dedup keeps the first; this lists every match). */
  sources: DecisionItemSource[];
}

export interface DecisionQueueDeps {
  /** Wall-clock anchor — defaults to `new Date()`. Used to compute the YYYY-MM-DD digest title. */
  now?: Date;
  /** GitHub repo handle (`owner/name`). Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
  /**
   * Override the GitHub Issue/PR Read seam readers (issue #908/#915). Tests
   * inject these to avoid spawning `gh`; production uses the real seam readers.
   * The aggregator consumes the seam's typed {@link IssueRow} — no local argv
   * or parser.
   */
  listIssuesBySearchOrEmpty?: typeof listIssuesBySearchOrEmpty;
  listIssuesByLabelOrEmpty?: typeof listIssuesByLabelOrEmpty;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Fetch and unify the operator decision queue.
 *
 * The three sub-sources run under `Promise.allSettled` so a single slow /
 * failing call can't blank the whole list. After fetch, items are deduped
 * by number and sorted oldest-first.
 */
export async function getDecisionQueue(
  deps: DecisionQueueDeps = {},
): Promise<DecisionItem[]> {
  const listBySearch = deps.listIssuesBySearchOrEmpty ?? listIssuesBySearchOrEmpty;
  const listByLabel = deps.listIssuesByLabelOrEmpty ?? listIssuesByLabelOrEmpty;

  const [digestResult, readyResult, infoResult] = await Promise.allSettled([
    fetchOperatorDigestItems(listBySearch, deps),
    fetchLabeledItems("ready-for-human", listByLabel, deps),
    fetchLabeledItems("needs-info", listByLabel, deps),
  ]);

  const digest = settledOrEmpty(digestResult, "decision-queue/digest");
  const ready = settledOrEmpty(readyResult, "decision-queue/ready-for-human");
  const info = settledOrEmpty(infoResult, "decision-queue/needs-info");

  return mergeDecisionItems({
    "operator-decision-queue": digest,
    "ready-for-human": ready,
    "needs-info": info,
  });
}

// ---------------------------------------------------------------------------
// Pure helper: merge + dedupe + sort
// ---------------------------------------------------------------------------

/**
 * The pre-merge row shape, owned by the digest-issue seam. Aliased locally so
 * the merge/fetch code reads in decision-queue terms.
 */
type RawDecisionInput = RawDigestInput;

/**
 * Pure merge function — exported for tests. Takes a record keyed by source
 * with the raw items each source produced, dedupes by issue number while
 * preserving the order sources appear in the input record, and returns the
 * combined list sorted oldest-first.
 *
 * The `source` field on the output is the FIRST source that listed the
 * item; the `sources` array collects every source that did. This lets the
 * dashboard render a primary badge plus optional secondary badges without
 * the aggregator picking a winner arbitrarily.
 */
export function mergeDecisionItems(
  bySource: Partial<Record<DecisionItemSource, RawDecisionInput[]>>,
): DecisionItem[] {
  const byNumber = new Map<number, DecisionItem>();
  // Iterate sources in a stable order — digest first so it wins as the
  // primary source when the same issue is also labeled.
  const order: DecisionItemSource[] = [
    "operator-decision-queue",
    "ready-for-human",
    "needs-info",
  ];
  for (const source of order) {
    const items = bySource[source] ?? [];
    for (const item of items) {
      const existing = byNumber.get(item.number);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        // Merge labels too so we don't lose any taxonomy.
        for (const label of item.labels) {
          if (!existing.labels.includes(label)) existing.labels.push(label);
        }
        continue;
      }
      byNumber.set(item.number, {
        number: item.number,
        title: item.title,
        url: item.url,
        createdAt: item.createdAt,
        labels: [...item.labels],
        source,
        sources: [source],
      });
    }
  }

  return Array.from(byNumber.values()).sort((a, b) => {
    const aMs = Date.parse(a.createdAt);
    const bMs = Date.parse(b.createdAt);
    if (Number.isFinite(aMs) && Number.isFinite(bMs)) return aMs - bMs;
    // Fall back to number ordering if a createdAt is missing/unparseable.
    return a.number - b.number;
  });
}

// ---------------------------------------------------------------------------
// Sub-source: dated operator-decision-queue digest issue
// ---------------------------------------------------------------------------

async function fetchOperatorDigestItems(
  listBySearch: typeof listIssuesBySearchOrEmpty,
  deps: DecisionQueueDeps,
): Promise<RawDecisionInput[]> {
  const now = deps.now ?? new Date();
  // Look for digest titles for "today" and "yesterday" — the morning hand-off
  // skill writes a YYYY-MM-DD-suffixed issue, and the operator may still be
  // working the previous day's queue when this runs.
  const candidates = [datedTitle(now), datedTitle(addDays(now, -1))];

  const items: RawDecisionInput[] = [];
  for (const title of candidates) {
    // The seam reader degrades to [] on failure (logged) — a sub-failure
    // doesn't abort; the labeled-issue sources can still produce a queue.
    const rows = await listBySearch(`in:title "${title}"`, "decision-queue/digest", {
      state: "open",
      limit: 5,
      repo: deps.githubRepo,
    });
    items.push(...digestRefsFromRows(rows, title));
  }
  return items;
}

// ---------------------------------------------------------------------------
// Sub-source: labeled-issue lists (ready-for-human, needs-info)
// ---------------------------------------------------------------------------

async function fetchLabeledItems(
  label: string,
  listByLabel: typeof listIssuesByLabelOrEmpty,
  deps: DecisionQueueDeps,
): Promise<RawDecisionInput[]> {
  const rows = await listByLabel(label, `decision-queue/${label}`, {
    state: "open",
    repo: deps.githubRepo,
  });
  return labeledItemsFromRows(rows);
}

// ---------------------------------------------------------------------------
// Small date helper — pure, local (the dated-title format itself lives in the
// digest-issue seam).
// ---------------------------------------------------------------------------

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}
