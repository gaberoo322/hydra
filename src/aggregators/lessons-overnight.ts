/**
 * Lessons-overnight aggregator (issue #617, PRD #615).
 *
 * Returns two correlated learning-system signals for the dashboard:
 *
 *   - `promotionCandidates` — friction patterns that are near the
 *     PROMOTION_THRESHOLD but not yet promoted. These are the items that
 *     would auto-open a `meta-friction` GitHub issue on the next hit.
 *     The dashboard surfaces them so the operator can see what the
 *     subagents are quietly working around.
 *   - `metaFrictionOpened` — `meta-friction` GitHub issues opened inside
 *     the window. These are friction patterns that already crossed the
 *     threshold and got escalated.
 *
 * # Data path
 *
 * 1. Promotion candidates come from Redis — scan `hydra:friction:*:patterns`
 *    keys, parse each as a JSON array of `MemoryPattern`, and keep entries
 *    with `hitCount` in `[PROMOTION_THRESHOLD - WINDOW, PROMOTION_THRESHOLD)`
 *    and `!promoted`. Default window is 1 hit so the dashboard shows items
 *    one hit shy of promotion.
 * 2. Meta-friction issues come from `gh issue list --label meta-friction`
 *    with a `created:>=YYYY-MM-DD` filter.
 *
 * # Design contract
 *
 * - **Pure parsers exported.** `parseMetaFrictionIssues` and
 *   `filterNearPromotion` are tested directly.
 * - **Never throws.** Sub-fetch failure degrades to `[]` for that bucket.
 * - **Threshold is the runtime constant.** Imports `PROMOTION_THRESHOLD`
 *   from `pattern-memory/agent-memory.ts` so a future bump to the
 *   threshold flows through without a parallel edit here.
 */

import { promisify } from "node:util";
import { execFile as execFileSync } from "node:child_process";

import { PROMOTION_THRESHOLD } from "../pattern-memory/agent-memory.ts";

const execFile = promisify(execFileSync);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PromotionCandidate {
  skill: string;
  cue: string;
  hitCount: number;
  hitsToPromotion: number;
  lastSeen: string;
  examples: string[];
}

export interface MetaFrictionIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
}

export interface OvernightLessons {
  promotionCandidates: PromotionCandidate[];
  metaFrictionOpened: MetaFrictionIssue[];
  windowHours: number;
  generatedAt: string;
  /** PROMOTION_THRESHOLD echo so the dashboard can render "K of N hits". */
  promotionThreshold: number;
}

export interface LessonsOvernightDeps {
  now?: Date;
  githubRepo?: string;
  /** How many hits short of the threshold still counts as a candidate. Default 1. */
  candidateWindow?: number;
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Override the friction-patterns reader. Returns a list of
   * `{skill, patterns}` tuples. Defaults to scanning Redis. Tests pass a
   * stub so they don't need a live Redis.
   */
  readFrictionPatterns?: () => Promise<Array<{ skill: string; patterns: FrictionPattern[] }>>;
}

/**
 * Minimal shape of one entry in a `hydra:friction:{skill}:patterns` JSON
 * array. Mirrors `MemoryPattern` from `pattern-memory/agent-memory.ts` but
 * only the fields this aggregator reads — keeping the type local avoids a
 * circular ts-only coupling on `MemoryPattern`'s growing field list.
 */
export interface FrictionPattern {
  category: string;
  hitCount: number;
  promoted?: boolean;
  lastSeen: string;
  examples?: string[];
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getOvernightLessons(
  windowHours: number,
  deps: LessonsOvernightDeps = {},
): Promise<OvernightLessons> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const candidateWindow = Math.max(1, Math.floor(deps.candidateWindow ?? 1));

  const [candidatesResult, issuesResult] = await Promise.allSettled([
    readPromotionCandidates(candidateWindow, deps),
    readMetaFrictionIssues(windowStart, deps),
  ]);

  return {
    promotionCandidates: settledOrEmpty(candidatesResult, "lessons-overnight/candidates"),
    metaFrictionOpened: settledOrEmpty(issuesResult, "lessons-overnight/meta-friction"),
    windowHours,
    generatedAt: now.toISOString(),
    promotionThreshold: PROMOTION_THRESHOLD,
  };
}

function settledOrEmpty<T>(result: PromiseSettledResult<T[]>, label: string): T[] {
  if (result.status === "fulfilled") return result.value;
  console.error(
    `[lessons-overnight] sub-source failed (${label}): ${result.reason?.message || result.reason}`,
  );
  return [];
}

// ---------------------------------------------------------------------------
// Sub-source: friction promotion candidates
// ---------------------------------------------------------------------------

async function readPromotionCandidates(
  candidateWindow: number,
  deps: LessonsOvernightDeps,
): Promise<PromotionCandidate[]> {
  const reader = deps.readFrictionPatterns ?? defaultReadFrictionPatterns;
  const groups = await reader();
  const out: PromotionCandidate[] = [];
  for (const { skill, patterns } of groups) {
    out.push(...filterNearPromotion(skill, patterns, candidateWindow));
  }
  // Closest-to-promotion first so the dashboard's first row is the
  // pattern most likely to escalate next.
  out.sort((a, b) => a.hitsToPromotion - b.hitsToPromotion);
  return out;
}

/**
 * Pure helper — exported for tests. Filters a skill's friction patterns to
 * the un-promoted entries within `candidateWindow` hits of the threshold.
 */
export function filterNearPromotion(
  skill: string,
  patterns: FrictionPattern[],
  candidateWindow: number,
): PromotionCandidate[] {
  if (!Array.isArray(patterns)) return [];
  const min = Math.max(0, PROMOTION_THRESHOLD - candidateWindow);
  const out: PromotionCandidate[] = [];
  for (const p of patterns) {
    if (!p || typeof p !== "object") continue;
    if (p.promoted) continue;
    const hitCount = Number(p.hitCount);
    if (!Number.isFinite(hitCount) || hitCount < min) continue;
    if (hitCount >= PROMOTION_THRESHOLD) continue; // already at threshold — not a candidate
    out.push({
      skill,
      cue: typeof p.category === "string" ? p.category : "(unknown cue)",
      hitCount,
      hitsToPromotion: PROMOTION_THRESHOLD - hitCount,
      lastSeen: typeof p.lastSeen === "string" ? p.lastSeen : "",
      examples: Array.isArray(p.examples)
        ? p.examples.filter((e): e is string => typeof e === "string").slice(0, 3)
        : [],
    });
  }
  return out;
}

async function defaultReadFrictionPatterns(): Promise<
  Array<{ skill: string; patterns: FrictionPattern[] }>
> {
  // Scan all friction-pattern keys and parse each. We pull the connection
  // through the typed seam so the import-shape rule in
  // scripts/ci/redis-seam-check.ts is satisfied.
  const { getRedisConnection } = await import("../redis/connection.ts");
  const r = getRedisConnection();
  const matches: string[] = [];
  let cursor = "0";
  do {
    const [next, page] = await r.scan(cursor, "MATCH", "hydra:friction:*:patterns", "COUNT", "200");
    cursor = next;
    matches.push(...page);
  } while (cursor !== "0");

  const out: Array<{ skill: string; patterns: FrictionPattern[] }> = [];
  for (const key of matches) {
    const skill = key.replace(/^hydra:friction:/, "").replace(/:patterns$/, "");
    const raw = await r.get(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push({ skill, patterns: parsed as FrictionPattern[] });
    } catch (err: any) {
      console.error(`[lessons-overnight] failed to parse ${key}: ${err?.message || err}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sub-source: meta-friction issues opened in window
// ---------------------------------------------------------------------------

async function readMetaFrictionIssues(
  windowStart: Date,
  deps: LessonsOvernightDeps,
): Promise<MetaFrictionIssue[]> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = deps.githubRepo ?? "gaberoo322/hydra";
  if (!repo) return [];
  const sinceDate = windowStart.toISOString().split("T")[0];
  const { stdout } = await exec(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--label",
      "meta-friction",
      "--search",
      `created:>=${sinceDate}`,
      "--limit",
      "100",
      "--json",
      "number,title,url,createdAt",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseMetaFrictionIssues(stdout, windowStart);
}

/**
 * Pure helper — exported for tests. Parses `gh issue list --json` output for
 * the meta-friction label query and re-filters on createdAt so sub-day
 * windows don't include items from the search's coarser date-prefix
 * resolution.
 */
export function parseMetaFrictionIssues(
  jsonStdout: string,
  windowStart: Date,
): MetaFrictionIssue[] {
  if (!jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const startMs = windowStart.getTime();
  const out: MetaFrictionIssue[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as {
      number?: unknown;
      title?: unknown;
      url?: unknown;
      createdAt?: unknown;
    };
    const number = typeof c.number === "number" ? c.number : NaN;
    if (!Number.isFinite(number) || number <= 0) continue;
    const createdAt = typeof c.createdAt === "string" ? c.createdAt : "";
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs) || createdMs < startMs) continue;
    out.push({
      number,
      title: typeof c.title === "string" ? c.title : `Issue #${number}`,
      url: typeof c.url === "string" ? c.url : `https://github.com/gaberoo322/hydra/issues/${number}`,
      createdAt,
    });
  }
  out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return out;
}
