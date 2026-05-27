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

import { promisify } from "node:util";
import { execFile as execFileSync } from "node:child_process";

const execFile = promisify(execFileSync);

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
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

const MAX_WINDOW_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 7;

const KNOWN_CLASS_LABELS = [
  "dev_orch",
  "dev_target",
  "qa",
  "health",
  "research_orch",
  "research_target",
  "sweep_orch",
  "sweep_target",
  "discover_orch",
  "discover_target",
] as const;

const UNCLASSIFIED = "unclassified";

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getBacklogFlow(
  windowDays: number,
  deps: BacklogFlowDeps = {},
): Promise<BacklogFlow> {
  const now = deps.now ?? new Date();
  const days = clampWindowDays(windowDays);
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const sinceDate = iso8601DateOnly(windowStart);

  const [addedResult, closedResult, blockedResult] = await Promise.allSettled([
    fetchIssuesByDateFilter(`created:>=${sinceDate}`, "all", deps),
    fetchIssuesByDateFilter(`closed:>=${sinceDate}`, "closed", deps),
    fetchIssuesWithLabel("blocked", deps),
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

function settledOrEmpty<T>(result: PromiseSettledResult<T[]>, label: string): T[] {
  if (result.status === "fulfilled") return result.value;
  console.error(
    `[backlog-flow] sub-source failed (${label}): ${result.reason?.message || result.reason}`,
  );
  return [];
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
 * Pure helper — exported for tests. Returns the first known autopilot-class
 * label on the issue, or "unclassified" if none of the known labels match.
 * Case-sensitive — the `gh issue list` payload preserves the label as
 * stored.
 */
export function classFromLabels(labels: readonly string[]): string {
  for (const label of labels) {
    if (typeof label !== "string") continue;
    if (KNOWN_CLASS_LABELS.includes(label as (typeof KNOWN_CLASS_LABELS)[number])) {
      return label;
    }
  }
  return UNCLASSIFIED;
}

/**
 * Pure helper — exported for tests. Produces one row per class that appears
 * in ANY of the three buckets. Sorted by `added + closed + blocked`
 * descending so the busiest class lands at the top.
 */
export function bucketByClass(
  added: readonly RawIssue[],
  closed: readonly RawIssue[],
  blocked: readonly RawIssue[],
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

/** Pure helper — exported for tests. Strips an ISO timestamp down to YYYY-MM-DD. */
export function iso8601DateOnly(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Pure helper — exported for tests. Parses `gh issue list --json` output
 * into the minimal shape the classifier needs. Returns `[]` on structural
 * problems.
 */
export function parseRawIssues(jsonStdout: string): RawIssue[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RawIssue[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as { number?: unknown; labels?: Array<{ name?: unknown }> };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    out.push({
      number,
      labels: (c.labels ?? [])
        .map((l) => l?.name)
        .filter((n): n is string => typeof n === "string"),
    });
  }
  return out;
}

interface RawIssue {
  number: number;
  labels: string[];
}

// ---------------------------------------------------------------------------
// Sub-sources
// ---------------------------------------------------------------------------

async function fetchIssuesByDateFilter(
  searchClause: string,
  state: "all" | "closed",
  deps: BacklogFlowDeps,
): Promise<RawIssue[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = deps.githubRepo ?? "gaberoo322/hydra";
  if (!repo) return [];
  const { stdout } = await exec(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      state,
      "--search",
      searchClause,
      "--limit",
      "1000",
      "--json",
      "number,labels",
    ],
    { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return parseRawIssues(stdout);
}

async function fetchIssuesWithLabel(
  label: string,
  deps: BacklogFlowDeps,
): Promise<RawIssue[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = deps.githubRepo ?? "gaberoo322/hydra";
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
      label,
      "--limit",
      "1000",
      "--json",
      "number,labels",
    ],
    { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return parseRawIssues(stdout);
}
