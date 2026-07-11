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
 * - **Shared meta-friction reader.** `metaFrictionOpened` is the `.length` of
 *   the seam's `readMetaFrictionIssues` (issue #864) — the shared reader
 *   already re-filters by exact `createdAt`, so its count is the in-window
 *   total without a separate count parser.
 */

import { PROMOTION_THRESHOLD } from "../pattern-memory/index.ts";
import {
  readFrictionPatterns,
  readMetaFrictionIssues,
} from "./friction-source.ts";
import {
  windowStart as trendWindowStart,
  dayBucketKey,
  sortByTimeAsc,
  type TrendPoint,
} from "./trend-series.ts";
import type { listIssuesBySearchOrEmpty } from "../github/issues.ts";
import type { FrictionPattern } from "../pattern-memory/index.ts";

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
  promotionRate: TrendPoint[];
  topFriction: FrictionItem[];
  metaFrictionOpened: number;
  /** PROMOTION_THRESHOLD echo so the dashboard can render labels. */
  promotionThreshold: number;
}

export interface LessonsTrendDeps {
  now?: Date;
  githubRepo?: string;
  /**
   * Override the GitHub Issue/PR Read seam reader (issue #908/#915) used by the
   * meta-friction read. Passed straight through to `readMetaFrictionIssues`.
   */
  listIssuesBySearchOrEmpty?: typeof listIssuesBySearchOrEmpty;
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
  const windowStart = trendWindowStart(now, windowDays);

  const [patternsResult, metaResult] = await Promise.allSettled([
    (deps.readFrictionPatterns ??
      (() => readFrictionPatterns<FrictionPattern>("lessons-trend")))(),
    readMetaFrictionIssues("lessons-trend", windowStart, deps),
  ]);

  const groups =
    patternsResult.status === "fulfilled" ? patternsResult.value : [];
  if (patternsResult.status === "rejected") {
    console.error(
      `[lessons-trend] friction reader failed: ${patternsResult.reason?.message || patternsResult.reason}`,
    );
  }
  // The shared reader already never-throws + re-filters by exact createdAt, so
  // its length is the in-window meta-friction count. The allSettled wrapper is
  // belt-and-suspenders in case a future deps stub rejects.
  const meta = metaResult.status === "fulfilled" ? metaResult.value.length : 0;
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
export function promotionsByDay(promoted: PromotedEntry[]): TrendPoint[] {
  if (!Array.isArray(promoted) || promoted.length === 0) return [];
  const byDay = new Map<string, number>();
  for (const p of promoted) {
    const key = dayBucketKey(new Date(p.lastSeenMs));
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  const out: TrendPoint[] = [];
  for (const [t, v] of byDay.entries()) out.push({ t, v });
  return sortByTimeAsc(out);
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
