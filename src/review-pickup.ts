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
  parseDigestSearchOutput,
  parseLabeledIssuesOutput,
  datedTitle,
} from "./aggregators/decision-queue.ts";
import { execFileViaSeam } from "./github/exec-file-compat.ts";

// The production default routes `gh`/`git` through the GitHub CLI Adapter seam
// (issue #899). Tests still inject `deps.execFileAsync` directly — this only
// changes the default, not the injection seam.
const execFile = execFileViaSeam;

const DEFAULT_REPO = "gaberoo322/hydra";

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

type ExecFileAsync = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface PickupSetDeps {
  /** Wall-clock anchor — defaults to `new Date()`. Drives the YYYY-MM-DD digest title. */
  now?: Date;
  /** Async exec used for `gh` sub-shells. Defaults to `promisify(execFile)`. */
  execFileAsync?: ExecFileAsync;
  /** GitHub repo handle (`owner/name`). Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
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
  const [digestResult, readyResult, blockedResult] = await Promise.allSettled([
    fetchOperatorDigestItems(deps),
    fetchReadyForHumanItems(deps),
    fetchStaleBlockedItems(deps),
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
  deps: PickupSetDeps,
): Promise<RawPickupInput[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = deps.githubRepo ?? DEFAULT_REPO;
  if (!repo) return [];
  const now = deps.now ?? new Date();
  // The morning hand-off writes a YYYY-MM-DD-suffixed issue; the operator may
  // still be working yesterday's queue when this runs, so check both.
  const candidates = [datedTitle(now), datedTitle(addDays(now, -1))];

  const items: RawPickupInput[] = [];
  for (const title of candidates) {
    try {
      const { stdout } = await exec(
        "gh",
        [
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--search",
          `in:title "${title}"`,
          "--limit",
          "5",
          "--json",
          "number,title,body,url,createdAt,labels",
        ],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      // parseDigestSearchOutput returns the digest-issue-derived rows; we map
      // them down to the lean pickup shape (number/title/url).
      for (const row of parseDigestSearchOutput(stdout, title)) {
        items.push({ number: row.number, title: row.title, url: row.url });
      }
    } catch (err: any) {
      console.error(
        `[review-pickup] digest search failed for "${title}": ${err?.message || err}`,
      );
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Sub-source: ready-for-human labeled issues
// ---------------------------------------------------------------------------

async function fetchReadyForHumanItems(
  deps: PickupSetDeps,
): Promise<RawPickupInput[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = deps.githubRepo ?? DEFAULT_REPO;
  if (!repo) return [];
  const { stdout } = await exec(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      "ready-for-human",
      "--limit",
      "100",
      "--json",
      "number,title,url,createdAt,labels",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseLabeledIssuesOutput(stdout).map((r) => ({
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
  deps: PickupSetDeps,
): Promise<RawPickupInput[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = deps.githubRepo ?? DEFAULT_REPO;
  if (!repo) return [];

  const { stdout } = await exec(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      "blocked",
      "--limit",
      "100",
      "--json",
      "number,title,url,body",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );

  const blocked = parseBlockedIssuesOutput(stdout);
  if (blocked.length === 0) return [];

  // Collect the union of referenced blocker numbers across all blocked issues.
  const referenced = new Set<number>();
  for (const b of blocked) {
    for (const n of b.blockerRefs) referenced.add(n);
  }

  let openBlockers = new Set<number>();
  if (referenced.size > 0) {
    try {
      openBlockers = await fetchOpenIssueNumbers(exec, repo, [...referenced]);
    } catch (err: any) {
      console.error(
        `[review-pickup] open-blocker lookup failed: ${err?.message || err}`,
      );
      // Conservative: treat all referenced blockers as open so none of these
      // count as stale (no false notification on a lookup failure).
      openBlockers = referenced;
    }
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
 * Pure helper — parse `gh issue list --json number,title,url,body` for the
 * `blocked` label and extract each issue's claimed blocker references.
 */
export function parseBlockedIssuesOutput(jsonStdout: string): BlockedIssue[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: BlockedIssue[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: unknown;
      title?: unknown;
      url?: unknown;
      body?: unknown;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    const body = typeof c.body === "string" ? c.body : "";
    out.push({
      number,
      title: typeof c.title === "string" ? c.title : `Issue #${number}`,
      url:
        typeof c.url === "string"
          ? c.url
          : `https://github.com/${DEFAULT_REPO}/issues/${number}`,
      // Reuse the digest ref extractor — same `#N` semantics, code-span-safe.
      blockerRefs: extractIssueRefs(body).filter((n) => n !== number),
    });
  }
  return out;
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
 * single `gh issue list --search "<n1> <n2> ..." --state open` query.
 */
async function fetchOpenIssueNumbers(
  exec: ExecFileAsync,
  repo: string,
  numbers: number[],
): Promise<Set<number>> {
  if (numbers.length === 0) return new Set();
  // `in:title`-free search: bare numbers match the issue-number index.
  const search = numbers.map((n) => `${n}`).join(" ");
  const { stdout } = await exec(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      search,
      "--limit",
      "100",
      "--json",
      "number",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseOpenNumbers(stdout, numbers);
}

/**
 * Pure helper — exported for tests. Parse `gh issue list --json number` output
 * and return the subset of `requested` numbers that the query reports as open.
 * Intersecting with `requested` guards against the search matching unrelated
 * issues that merely mention the number.
 */
export function parseOpenNumbers(
  jsonStdout: string,
  requested: number[],
): Set<number> {
  const requestedSet = new Set(requested);
  const open = new Set<number>();
  if (!jsonStdout.trim()) return open;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return open;
  }
  if (!Array.isArray(parsed)) return open;
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const n = (candidate as { number?: unknown }).number;
    if (typeof n === "number" && requestedSet.has(n)) open.add(n);
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
