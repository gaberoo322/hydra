/**
 * Shared inter-issue blocker seam (issue #3059).
 *
 * Two responsibilities, extracted so BOTH the `/hydra-review` stale-blocked
 * aggregator (`src/review-pickup.ts`) and the autopilot board-state dispatch
 * filter (`src/api/autopilot-board.ts`) read from ONE place:
 *
 *   1. {@link extractStrictBlockerRefs} — a STRICT body parser that pulls the
 *      `#N` numbers an issue declares it is *blocked by* / *depends on*. Unlike
 *      the loose `extractIssueRefs` (which returns every `#N` mention), this
 *      only matches anchored `blocked by #N` / `blocks #N` / `depends on #N`
 *      conventions. A false positive here silently STARVES real work
 *      (a bare `#N` "see also" reference would wrongly gate dispatch), so the
 *      dispatch filter must use the strict form. Code-span-safe: `#N` inside a
 *      backtick span is ignored (same guard as `extractIssueRefs`).
 *
 *   2. {@link fetchOpenBlockerNumbers} — a single batched `gh issue list`
 *      open/closed resolver over the union of referenced numbers (one extra
 *      round-trip, not one per issue), hoisted verbatim from
 *      `review-pickup.ts`. Its FAIL-SAFE default is load-bearing and shared: on
 *      a lookup FAILURE it returns the full requested set (treat every
 *      referenced blocker as still-OPEN). For review-pickup that yields FEWER
 *      stale-blocked notifications; for the dispatch filter that WAITS a tick
 *      rather than dispatching onto an unmerged blocker. One resolver, one
 *      conservative behavior in both consumers.
 *
 * Pure/leaf: the only external touchpoint is the injected reader in
 * {@link OpenBlockerLookupDeps}; the parsing and set math are pure and
 * golden-fixture testable without a live `gh`.
 */

import {
  listIssuesBySearch,
  isIssueReadFailure,
  type IssueRow,
} from "./issues.ts";

// ---------------------------------------------------------------------------
// Strict blocker-ref parser
// ---------------------------------------------------------------------------

/**
 * The strict blocker conventions. Two anchored patterns only:
 *
 *   - `blocked by #N` / `blocked-by #N` / `blocks #N` / `blocked #N`
 *     (epic-close's `blockedBy` regex, reused verbatim — see
 *     `scripts/ci/epic-close.ts`).
 *   - `depends on #N` / `depends-on #N` / `depend on #N` / `dependent on #N`.
 *
 * A bare `#N` (a "see also", a "part of", an incidental mention) deliberately
 * does NOT match — it must not gate dispatch.
 */
const STRICT_BLOCKER_PATTERNS: RegExp[] = [
  // Reused verbatim from scripts/ci/epic-close.ts (parseEpicReferences).
  /\bblock(?:ed|s)?(?:[\s-]+by)?\s*:?\s*#(\d+)/gi,
  /\bdepend(?:s|ent)?(?:[\s-]+on)?\s*:?\s*#(\d+)/gi,
];

/**
 * Pull the STRICT blocker `#N` refs from a markdown body — the numbers this
 * issue declares it is blocked by / depends on, deduped, in order of first
 * appearance. Code-span-safe (a `#N` inside backticks is ignored, same guard as
 * `extractIssueRefs`). Returns `[]` for an empty/absent body.
 *
 * Pure — the golden-fixture unit under `test/`.
 */
export function extractStrictBlockerRefs(
  body: string | null | undefined,
): number[] {
  if (!body) return [];
  // Strip backtick code spans first — `#1234` inside `code` is not a ref.
  const stripped = body.replace(/`[^`]*`/g, "");

  const seen = new Set<number>();
  const out: number[] = [];
  for (const re of STRICT_BLOCKER_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const n = Number.parseInt(m[1], 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Batched open/closed resolver (hoisted from review-pickup.ts)
// ---------------------------------------------------------------------------

export interface OpenBlockerLookupDeps {
  /** GitHub repo handle (`owner/name`) override. Defaults to the seam default. */
  githubRepo?: string;
  /**
   * The open/closed lookup uses the *discriminated* (failure-aware) reader, not
   * an *OrEmpty variant: on a lookup FAILURE we must conservatively treat every
   * referenced blocker as still-open. Tests inject this to avoid spawning `gh`.
   */
  listIssuesBySearch?: typeof listIssuesBySearch;
}

/**
 * Resolve which of the given issue numbers are currently OPEN. Batches into a
 * single `--state open --search "<n1> <n2> ..."` query through the seam's
 * *discriminated* reader.
 *
 * FAIL-SAFE default (shared by both consumers): on a lookup FAILURE this
 * returns the full requested set (treat every referenced blocker as still-OPEN)
 * so a transient `gh` outage never flips the conservative direction — fewer
 * stale-blocked notifications for review-pickup, a waited tick for the dispatch
 * filter.
 */
export async function fetchOpenBlockerNumbers(
  numbers: number[],
  deps: OpenBlockerLookupDeps = {},
): Promise<Set<number>> {
  if (numbers.length === 0) return new Set();
  const search = numbers.map((n) => `${n}`).join(" ");
  const read = deps.listIssuesBySearch ?? listIssuesBySearch;
  const res = await read(search, { state: "open", repo: deps.githubRepo });
  if (isIssueReadFailure(res)) {
    console.error(`[blockers] open-blocker lookup failed (${res.code})`);
    // Conservative: treat all referenced blockers as open.
    return new Set(numbers);
  }
  return openNumbersFromRows(res.rows, numbers);
}

/**
 * Pure helper — from the seam's {@link IssueRow} rows of an open-state number
 * search, return the subset of `requested` numbers reported open. Intersecting
 * with `requested` guards against the search matching unrelated issues that
 * merely mention the number.
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
