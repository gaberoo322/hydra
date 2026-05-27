/**
 * Lessons-trend aggregator (issue #619, PRD #615 slice 4).
 *
 * Strategic-review view of the learning system over a rolling window:
 *
 *   - `promotionRate`     — daily count of friction-pattern promotions
 *     (patterns reaching PROMOTION_THRESHOLD). Read from
 *     `hydra:friction:*:patterns` JSON arrays — count entries where
 *     `promoted === true` and `lastSeen` is inside the window.
 *   - `topFriction`       — top-5 promoted patterns by hit count across
 *     the window (skill, cue, hitCount).
 *   - `metaFrictionOpened` — number of `meta-friction` GitHub issues
 *     opened inside the window.
 *
 * # Design contract
 *
 * - **Pure helpers exported.** `pickTopFriction` and `promotionsByDay`
 *   are tested directly.
 * - **Never throws.** Sub-source failures degrade to zero / [] without
 *   blanking the whole response.
 * - **Friction reader is overridable.** Tests pass a stub so no Redis is
 *   required.
 */

import { promisify } from "node:util";
import { execFile as execFileSync } from "node:child_process";

import { PROMOTION_THRESHOLD } from "../pattern-memory/agent-memory.ts";
import type { FrictionPattern } from "./lessons-overnight.ts";

const execFile = promisify(execFileSync);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FrictionItem {
  skill: string;
  cue: string;
  hitCount: number;
  lastSeen: string;
}

export interface LessonsTrendResponse {
  windowDays: number;
  generatedAt: string;
  /** Daily-bucketed promotion counts. */
  promotionRate: { t: string; v: number }[];
  topFriction: FrictionItem[];
  metaFrictionOpened: number;
  /** PROMOTION_THRESHOLD echo so the dashboard can render labels. */
  promotionThreshold: number;
}

export interface LessonsTrendDeps {
  now?: Date;
  githubRepo?: string;
  execFileAsync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /**
   * Override the friction-patterns reader. Defaults to the same Redis
   * scan as `lessons-overnight.ts`. Tests pass a stub.
   */
  readFrictionPatterns?: () => Promise<
    Array<{ skill: string; patterns: FrictionPattern[] }>
  >;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getLessonsTrend(
  windowDays: number,
  deps: LessonsTrendDeps = {},
): Promise<LessonsTrendResponse> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const [patternsResult, metaResult] = await Promise.allSettled([
    (deps.readFrictionPatterns ?? defaultReadFrictionPatterns)(),
    countMetaFrictionIssues(windowStart, deps),
  ]);

  const groups =
    patternsResult.status === "fulfilled" ? patternsResult.value : [];
  if (patternsResult.status === "rejected") {
    console.error(
      `[lessons-trend] friction reader failed: ${patternsResult.reason?.message || patternsResult.reason}`,
    );
  }
  const meta = metaResult.status === "fulfilled" ? metaResult.value : 0;
  if (metaResult.status === "rejected") {
    console.error(
      `[lessons-trend] meta-friction count failed: ${metaResult.reason?.message || metaResult.reason}`,
    );
  }

  const promoted = collectPromoted(groups, windowStart, now);

  return {
    windowDays,
    generatedAt: now.toISOString(),
    promotionRate: promotionsByDay(promoted),
    topFriction: pickTopFriction(promoted, 5),
    metaFrictionOpened: meta,
    promotionThreshold: PROMOTION_THRESHOLD,
  };
}

async function defaultReadFrictionPatterns(): Promise<
  Array<{ skill: string; patterns: FrictionPattern[] }>
> {
  const { getRedisConnection } = await import("../redis/connection.ts");
  const r = getRedisConnection();
  const matches: string[] = [];
  let cursor = "0";
  do {
    const [next, page] = await r.scan(
      cursor,
      "MATCH",
      "hydra:friction:*:patterns",
      "COUNT",
      "200",
    );
    cursor = next;
    matches.push(...page);
  } while (cursor !== "0");

  const out: Array<{ skill: string; patterns: FrictionPattern[] }> = [];
  for (const key of matches) {
    const skill = key
      .replace(/^hydra:friction:/, "")
      .replace(/:patterns$/, "");
    const raw = await r.get(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed))
        out.push({ skill, patterns: parsed as FrictionPattern[] });
    } catch (err: any) {
      console.error(
        `[lessons-trend] failed to parse ${key}: ${err?.message || err}`,
      );
    }
  }
  return out;
}

async function countMetaFrictionIssues(
  windowStart: Date,
  deps: LessonsTrendDeps,
): Promise<number> {
  const exec = deps.execFileAsync ?? execFile;
  const repo = deps.githubRepo ?? "gaberoo322/hydra";
  if (!repo) return 0;
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
      "200",
      "--json",
      "number,createdAt",
    ],
    { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return parseMetaFrictionCount(stdout, windowStart);
}

/**
 * Pure helper — exported for tests. Counts items in the `gh issue list
 * --json number,createdAt` output that fall inside the window. The gh
 * `created:>=YYYY-MM-DD` search is coarse (day-level), so we re-filter
 * by exact timestamp.
 */
export function parseMetaFrictionCount(
  jsonStdout: string,
  windowStart: Date,
): number {
  if (!jsonStdout.trim()) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  const startMs = windowStart.getTime();
  let n = 0;
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object") continue;
    const createdAt = (candidate as { createdAt?: unknown }).createdAt;
    if (typeof createdAt !== "string") continue;
    const ms = Date.parse(createdAt);
    if (!Number.isFinite(ms) || ms < startMs) continue;
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

interface PromotedEntry {
  skill: string;
  cue: string;
  hitCount: number;
  lastSeen: string;
  lastSeenMs: number;
}

/**
 * Pure helper — exported for tests. Walks every (skill, pattern) pair,
 * keeps the promoted ones whose `lastSeen` is inside the window, and
 * returns the flat list. Falls back to filtering on hitCount >= threshold
 * when `promoted` is not set (older patterns may pre-date the flag).
 */
export function collectPromoted(
  groups: Array<{ skill: string; patterns: FrictionPattern[] }>,
  windowStart: Date,
  now: Date,
): PromotedEntry[] {
  if (!Array.isArray(groups)) return [];
  const startMs = windowStart.getTime();
  const endMs = now.getTime();
  const out: PromotedEntry[] = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const skill = typeof group.skill === "string" ? group.skill : "(unknown)";
    if (!Array.isArray(group.patterns)) continue;
    for (const p of group.patterns) {
      if (!p || typeof p !== "object") continue;
      const promoted =
        p.promoted === true ||
        (typeof p.hitCount === "number" && p.hitCount >= PROMOTION_THRESHOLD);
      if (!promoted) continue;
      const lastSeen = typeof p.lastSeen === "string" ? p.lastSeen : "";
      const ms = Date.parse(lastSeen);
      if (!Number.isFinite(ms)) continue;
      if (ms < startMs || ms > endMs) continue;
      const hitCount = Number(p.hitCount);
      out.push({
        skill,
        cue: typeof p.category === "string" ? p.category : "(unknown cue)",
        hitCount: Number.isFinite(hitCount) ? hitCount : 0,
        lastSeen,
        lastSeenMs: ms,
      });
    }
  }
  return out;
}

/**
 * Pure helper — exported for tests. Buckets promoted entries by UTC day.
 */
export function promotionsByDay(
  promoted: PromotedEntry[],
): { t: string; v: number }[] {
  if (!Array.isArray(promoted) || promoted.length === 0) return [];
  const byDay = new Map<string, number>();
  for (const p of promoted) {
    const d = new Date(p.lastSeenMs);
    const key = dayBucketKey(d);
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  const out: { t: string; v: number }[] = [];
  for (const [t, v] of byDay.entries()) out.push({ t, v });
  out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return out;
}

/**
 * Pure helper — exported for tests. Returns the top-N promoted entries by
 * hit count, descending. Ties broken by lastSeen (more-recent first).
 */
export function pickTopFriction(
  promoted: PromotedEntry[],
  limit: number,
): FrictionItem[] {
  if (!Array.isArray(promoted) || promoted.length === 0) return [];
  const n = Math.max(0, Math.floor(limit));
  if (n === 0) return [];
  const sorted = [...promoted].sort((a, b) => {
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    return b.lastSeenMs - a.lastSeenMs;
  });
  return sorted.slice(0, n).map((p) => ({
    skill: p.skill,
    cue: p.cue,
    hitCount: p.hitCount,
    lastSeen: p.lastSeen,
  }));
}

function dayBucketKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}T00:00:00.000Z`;
}
