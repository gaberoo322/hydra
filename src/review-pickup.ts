/**
 * /hydra-review pickup-set aggregator (issue #745).
 *
 * The `/hydra-review` skill drains a specific, three-bucket pickup set (see
 * `docs/operator-playbooks/hydra-review.md`):
 *
 *   1. Today's (and yesterday's) `Operator decision queue YYYY-MM-DD` issue —
 *      overnight autopilot's hand-off digest. Each `#N` reference in the body
 *      becomes a pickup item.
 *   2. Issues currently labeled `ready-for-human` — the persistent operator
 *      attention queue.
 *   3. **Stale-blocked** issues — `blocked`-labeled issues whose body cites no
 *      OPEN blocker (`blocked by #N` / `depends on #N` where #N is closed or
 *      absent). These are the ones the operator needs to re-decide.
 *
 * This is deliberately NOT the dashboard-v2 `getDecisionQueue()` aggregator:
 * that one unifies buckets 1+2 with `needs-info` (bucket 3 there), whereas the
 * `/hydra-review` pickup set's third bucket is *stale-blocked*. The phone-notify
 * hook (issue #745) must mirror what the operator will actually see when they
 * run `/hydra-review`, so it reads THIS aggregator, not `getDecisionQueue()`.
 *
 * # Design contract
 *
 * - **Pure aggregator.** Every external touchpoint is in `deps`; defaults wire
 *   the real impls. Sub-source failure is isolated via `Promise.allSettled`.
 * - **Never throws.** A failed sub-fetch contributes `[]`; the remaining
 *   sources still ship. Callers (the housekeeping notify hook) treat a fully
 *   failed fetch as "empty" and do not fire — better a missed alert than a
 *   spurious one or a crashed housekeeping tick.
 * - **GitHub-only.** All three sources are GitHub issues queried via `gh`.
 */

import {
  extractIssueRefs,
  digestRefsFromRows,
  labeledItemsFromRows,
  datedTitle,
} from "./aggregators/decision-queue.ts";
import {
  listIssuesByLabelOrEmpty,
  listIssuesBySearch,
  listIssuesBySearchOrEmpty,
  isIssueReadFailure,
  type IssueRow,
} from "./github/issues.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Which of the three /hydra-review buckets surfaced an item. */
export type PickupSource =
  | "operator-decision-queue"
  | "ready-for-human"
  | "stale-blocked";

export interface PickupItem {
  number: number;
  title: string;
  url: string;
  /** First bucket that surfaced this item (digest wins, then ready-for-human, then stale-blocked). */
  source: PickupSource;
  /** Every bucket that surfaced it (dedup keeps the first; this lists all). */
  sources: PickupSource[];
}

export interface PickupSetDeps {
  /** Wall-clock anchor — defaults to `new Date()`. Drives the YYYY-MM-DD digest title. */
  now?: Date;
  /** GitHub repo handle (`owner/name`). Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
  /**
   * Override the GitHub Issue/PR Read seam readers (issue #908/#915). Tests
   * inject these to avoid spawning `gh`; production uses the real seam readers,
   * which return the canonical {@link IssueRow} shape (no local argv/parser).
   */
  listIssuesBySearchOrEmpty?: typeof listIssuesBySearchOrEmpty;
  listIssuesByLabelOrEmpty?: typeof listIssuesByLabelOrEmpty;
  /**
   * The open-blocker lookup uses the *discriminated* (failure-aware) reader, not
   * the *OrEmpty variant: on a lookup FAILURE we must conservatively treat every
   * referenced blocker as still-open (so a transient gh outage yields FEWER
   * stale-blocked items, never a false notification). The OrEmpty wrapper would
   * collapse failure into `[]`, which flips that safety direction.
   */
  listIssuesBySearch?: typeof listIssuesBySearch;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Fetch and unify the /hydra-review pickup set across all three buckets.
 *
 * Sub-sources run under `Promise.allSettled` so one slow/failing call can't
 * blank the whole list. After fetch, items are deduped by issue number and
 * sorted by ascending number (stable, deterministic — the notify payload only
 * needs *a* first item, not a strict age order, and number-order avoids a
 * second createdAt fetch on the stale-blocked path).
 */
export async function getReviewPickupSet(
  deps: PickupSetDeps = {},
): Promise<PickupItem[]> {
  const listBySearch = deps.listIssuesBySearchOrEmpty ?? listIssuesBySearchOrEmpty;
  const listByLabel = deps.listIssuesByLabelOrEmpty ?? listIssuesByLabelOrEmpty;

  const [digestResult, readyResult, blockedResult] = await Promise.allSettled([
    fetchOperatorDigestItems(listBySearch, deps),
    fetchReadyForHumanItems(listByLabel, deps),
    fetchStaleBlockedItems(listBySearch, listByLabel, deps),
  ]);

  const digest = settledOrEmpty(digestResult, "review-pickup/digest");
  const ready = settledOrEmpty(readyResult, "review-pickup/ready-for-human");
  const blocked = settledOrEmpty(blockedResult, "review-pickup/stale-blocked");

  return mergePickupItems({
    "operator-decision-queue": digest,
    "ready-for-human": ready,
    "stale-blocked": blocked,
  });
}

function settledOrEmpty<T>(
  result: PromiseSettledResult<T[]>,
  label: string,
): T[] {
  if (result.status === "fulfilled") return result.value;
  console.error(
    `[review-pickup] sub-source failed (${label}): ${result.reason?.message || result.reason}`,
  );
  return [];
}

// ---------------------------------------------------------------------------
// Pure helper: merge + dedupe + sort (exported for tests)
// ---------------------------------------------------------------------------

interface RawPickupInput {
  number: number;
  title: string;
  url: string;
}

/**
 * Pure merge — dedupes by issue number, preserving the bucket priority order
 * (digest first so it wins as the primary `source`), and returns the combined
 * list sorted by ascending issue number.
 */
export function mergePickupItems(
  bySource: Partial<Record<PickupSource, RawPickupInput[]>>,
): PickupItem[] {
  const byNumber = new Map<number, PickupItem>();
  const order: PickupSource[] = [
    "operator-decision-queue",
    "ready-for-human",
    "stale-blocked",
  ];
  for (const source of order) {
    for (const item of bySource[source] ?? []) {
      const existing = byNumber.get(item.number);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        continue;
      }
      byNumber.set(item.number, {
        number: item.number,
        title: item.title,
        url: item.url,
        source,
        sources: [source],
      });
    }
  }
  return Array.from(byNumber.values()).sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------------
// Sub-source: dated operator-decision-queue digest issue (buckets reused from
// decision-queue.ts to keep one parser for the digest body).
// ---------------------------------------------------------------------------

async function fetchOperatorDigestItems(
  listBySearch: typeof listIssuesBySearchOrEmpty,
  deps: PickupSetDeps,
): Promise<RawPickupInput[]> {
  const now = deps.now ?? new Date();
  // The morning hand-off writes a YYYY-MM-DD-suffixed issue; the operator may
  // still be working yesterday's queue when this runs, so check both.
  const candidates = [datedTitle(now), datedTitle(addDays(now, -1))];

  const items: RawPickupInput[] = [];
  for (const title of candidates) {
    // The seam reader degrades to [] on failure (logged) — a sub-failure
    // doesn't abort the other digest candidate or the other buckets.
    const rows = await listBySearch(`in:title "${title}"`, "review-pickup/digest", {
      state: "open",
      limit: 5,
      repo: deps.githubRepo,
    });
    // digestRefsFromRows returns the digest-issue-derived rows; we map them
    // down to the lean pickup shape (number/title/url).
    for (const row of digestRefsFromRows(rows, title)) {
      items.push({ number: row.number, title: row.title, url: row.url });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Sub-source: ready-for-human labeled issues
// ---------------------------------------------------------------------------

async function fetchReadyForHumanItems(
  listByLabel: typeof listIssuesByLabelOrEmpty,
  deps: PickupSetDeps,
): Promise<RawPickupInput[]> {
  const rows = await listByLabel("ready-for-human", "review-pickup/ready-for-human", {
    state: "open",
    repo: deps.githubRepo,
  });
  return labeledItemsFromRows(rows).map((r) => ({
    number: r.number,
    title: r.title,
    url: r.url,
  }));
}

// ---------------------------------------------------------------------------
// Sub-source: stale-blocked issues
// ---------------------------------------------------------------------------

/**
 * Fetch `blocked`-labeled open issues and keep only the STALE ones — those
 * whose body cites no still-open blocker. An issue is stale-blocked when:
 *
 *   - its body references no `blocked by #N` / `depends on #N` / bare `#N`, OR
 *   - every referenced issue is CLOSED (or doesn't resolve to an open issue).
 *
 * Blocker open/closed state is resolved with a single batched `gh issue list`
 * over the union of referenced numbers (one extra round-trip, not one per
 * issue). If that lookup fails we conservatively treat all referenced blockers
 * as still-open, which means a failed lookup yields FEWER stale-blocked items
 * (never a false notification).
 */
async function fetchStaleBlockedItems(
  listBySearch: typeof listIssuesBySearchOrEmpty,
  listByLabel: typeof listIssuesByLabelOrEmpty,
  deps: PickupSetDeps,
): Promise<RawPickupInput[]> {
  const rows = await listByLabel("blocked", "review-pickup/stale-blocked", {
    state: "open",
    repo: deps.githubRepo,
  });

  const blocked = blockedIssuesFromRows(rows);
  if (blocked.length === 0) return [];

  // Collect the union of referenced blocker numbers across all blocked issues.
  const referenced = new Set<number>();
  for (const b of blocked) {
    for (const n of b.blockerRefs) referenced.add(n);
  }

  let openBlockers = new Set<number>();
  if (referenced.size > 0) {
    openBlockers = await fetchOpenIssueNumbers(deps, [...referenced]);
  }

  return classifyStaleBlocked(blocked, openBlockers);
}

interface BlockedIssue {
  number: number;
  title: string;
  url: string;
  /** Issue numbers this issue claims to be blocked by / depend on. */
  blockerRefs: number[];
}

/**
 * Pure helper — exported for tests. Map the seam's {@link IssueRow} rows for the
 * `blocked` label to each issue's claimed blocker references. The seam already
 * synthesizes title/url fallbacks and drops invalid rows; here we only extract
 * the `#N` blocker refs from each body.
 */
export function blockedIssuesFromRows(rows: readonly IssueRow[]): BlockedIssue[] {
  return rows.map((row) => ({
    number: row.number,
    title: row.title,
    url: row.url,
    // Reuse the digest ref extractor — same `#N` semantics, code-span-safe.
    blockerRefs: extractIssueRefs(row.body).filter((n) => n !== row.number),
  }));
}

/**
 * Pure classifier — exported for tests. An issue is stale-blocked when it has
 * NO blocker refs at all, OR none of its refs is in the open-blocker set.
 */
export function classifyStaleBlocked(
  blocked: BlockedIssue[],
  openBlockers: Set<number>,
): RawPickupInput[] {
  const stale: RawPickupInput[] = [];
  for (const b of blocked) {
    const hasOpenBlocker = b.blockerRefs.some((n) => openBlockers.has(n));
    if (!hasOpenBlocker) {
      stale.push({ number: b.number, title: b.title, url: b.url });
    }
  }
  return stale;
}

/**
 * Resolve which of the given issue numbers are currently OPEN. Batches into a
 * single `--state open --search "<n1> <n2> ..."` query through the seam's
 * *discriminated* reader.
 *
 * On a lookup FAILURE we conservatively return the full requested set (treat
 * every referenced blocker as still-open) so a transient gh outage yields FEWER
 * stale-blocked items, never a false notification.
 */
async function fetchOpenIssueNumbers(
  deps: PickupSetDeps,
  numbers: number[],
): Promise<Set<number>> {
  if (numbers.length === 0) return new Set();
  const search = numbers.map((n) => `${n}`).join(" ");
  const read = deps.listIssuesBySearch ?? listIssuesBySearch;
  const res = await read(search, { state: "open", repo: deps.githubRepo });
  if (isIssueReadFailure(res)) {
    console.error(`[review-pickup] open-blocker lookup failed (${res.code})`);
    // Conservative: treat all referenced blockers as open (no false alert).
    return new Set(numbers);
  }
  return openNumbersFromRows(res.rows, numbers);
}

/**
 * Pure helper — exported for tests. From the seam's {@link IssueRow} rows of an
 * open-state number search, return the subset of `requested` numbers reported
 * open. Intersecting with `requested` guards against the search matching
 * unrelated issues that merely mention the number.
 */
export function openNumbersFromRows(
  rows: readonly IssueRow[],
  requested: number[],
): Set<number> {
  const requestedSet = new Set(requested);
  const open = new Set<number>();
  for (const row of rows) {
    if (requestedSet.has(row.number)) open.add(row.number);
  }
  return open;
}

// ---------------------------------------------------------------------------
// Small date helper (mirrors decision-queue.ts)
// ---------------------------------------------------------------------------

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}
