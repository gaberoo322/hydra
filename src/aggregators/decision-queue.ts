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

import { execFileViaSeam } from "../github/exec-file-compat.ts";
import { resolveGithubRepo } from "../github/issues.ts";

import type { DecisionItemSource } from "./types.ts";

// The production default routes `gh`/`git` through the GitHub CLI Adapter seam
// (issue #899). Tests still inject `deps.execFileAsync` directly — this only
// changes the default, not the injection seam.
const execFile = execFileViaSeam;

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
  /** Async exec used for `gh` sub-shells. Defaults to `promisify(execFile)`. */
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** GitHub repo handle (`owner/name`). Defaults to `gaberoo322/hydra`. */
  githubRepo?: string;
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
  const [digestResult, readyResult, infoResult] = await Promise.allSettled([
    fetchOperatorDigestItems(deps),
    fetchLabeledItems("ready-for-human", deps),
    fetchLabeledItems("needs-info", deps),
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

function settledOrEmpty<T>(result: PromiseSettledResult<T[]>, label: string): T[] {
  if (result.status === "fulfilled") return result.value;
  console.error(
    `[decision-queue] sub-source failed (${label}): ${result.reason?.message || result.reason}`,
  );
  return [];
}

// ---------------------------------------------------------------------------
// Pure helper: merge + dedupe + sort
// ---------------------------------------------------------------------------

interface RawDecisionInput {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
}

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
  deps: DecisionQueueDeps,
): Promise<RawDecisionInput[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = resolveGithubRepo(deps.githubRepo);
  if (!repo) return [];
  const now = deps.now ?? new Date();
  // Look for digest titles for "today" and "yesterday" — the morning hand-off
  // skill writes a YYYY-MM-DD-suffixed issue, and the operator may still be
  // working the previous day's queue when this runs.
  const candidates = [datedTitle(now), datedTitle(addDays(now, -1))];

  const items: RawDecisionInput[] = [];
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
      const parsed = parseDigestSearchOutput(stdout, title);
      items.push(...parsed);
    } catch (err: any) {
      // Sub-failure is logged but doesn't abort — the labeled-issue sources
      // can still produce a useful queue.
      console.error(
        `[decision-queue] digest search failed for "${title}": ${err?.message || err}`,
      );
    }
  }
  return items;
}

/**
 * Pure helper — exported for tests. Parses the `gh issue list --json` output
 * of a digest-title search, finds the exact-title match, then extracts every
 * `#N` reference from the body. For each referenced number, returns a raw
 * decision input. The title/url/createdAt/labels fields are inherited from
 * the digest issue itself so the dashboard has something to render even if
 * the referenced sub-issue lookup later fails (sub-issues are fetched
 * separately by the labeled-issue sub-sources).
 */
export function parseDigestSearchOutput(
  jsonStdout: string,
  expectedTitle: string,
): RawDecisionInput[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: number;
      title?: string;
      body?: string;
      url?: string;
      createdAt?: string;
      labels?: Array<{ name?: string }>;
    };
    if (c.title !== expectedTitle) continue;
    if (typeof c.body !== "string") return [];
    const refs = extractIssueRefs(c.body);
    return refs.map((number) => ({
      number,
      title: `Referenced from ${expectedTitle} (#${number})`,
      url: `https://github.com/gaberoo322/hydra/issues/${number}`,
      createdAt: typeof c.createdAt === "string" ? c.createdAt : new Date(0).toISOString(),
      labels: (c.labels ?? [])
        .map((l) => l?.name)
        .filter((n): n is string => typeof n === "string"),
    }));
  }
  return [];
}

/**
 * Pure helper — exported for tests. Pulls every `#N` reference out of a
 * markdown body, dedupes, and returns the numbers in order of first
 * appearance. Skips inline code spans (anything inside backticks) so URLs
 * or commit hashes in code don't poison the queue.
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
// Sub-source: labeled-issue lists (ready-for-human, needs-info)
// ---------------------------------------------------------------------------

async function fetchLabeledItems(
  label: string,
  deps: DecisionQueueDeps,
): Promise<RawDecisionInput[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = resolveGithubRepo(deps.githubRepo);
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
      "100",
      "--json",
      "number,title,url,createdAt,labels",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseLabeledIssuesOutput(stdout);
}

/**
 * Pure helper — exported for tests. Parses `gh issue list --json` output
 * for a labeled query and produces the raw decision-input shape. Returns
 * `[]` on any structural issue rather than throwing.
 */
export function parseLabeledIssuesOutput(jsonStdout: string): RawDecisionInput[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: RawDecisionInput[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: unknown;
      title?: unknown;
      url?: unknown;
      createdAt?: unknown;
      labels?: Array<{ name?: unknown }>;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    out.push({
      number,
      title: typeof c.title === "string" ? c.title : `Issue #${number}`,
      url: typeof c.url === "string" ? c.url : `https://github.com/gaberoo322/hydra/issues/${number}`,
      createdAt: typeof c.createdAt === "string" ? c.createdAt : new Date(0).toISOString(),
      labels: (c.labels ?? [])
        .map((l) => l?.name)
        .filter((n): n is string => typeof n === "string"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small date helpers — pure, exported for tests
// ---------------------------------------------------------------------------

export function datedTitle(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `Operator decision queue ${yyyy}-${mm}-${dd}`;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}
