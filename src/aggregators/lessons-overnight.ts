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
 * - **Pure parser exported.** `filterNearPromotion` is tested directly. The
 *   meta-friction `gh` read lives on the `friction-source.ts` seam (issue
 *   #864), shared with `friction-patterns.ts` and `lessons-trend.ts`.
 * - **Never throws.** Sub-fetch failure degrades to `[]` for that bucket.
 * - **Threshold is the runtime constant.** Imports `PROMOTION_THRESHOLD`
 *   from `pattern-memory/agent-memory.ts` so a future bump to the
 *   threshold flows through without a parallel edit here.
 */

import {
  PROMOTION_THRESHOLD,
  type FrictionPattern,
} from "../pattern-memory/index.ts";
import {
  readFrictionPatterns,
  readMetaFrictionIssues,
  type MetaFrictionIssue,
} from "./friction-source.ts";
import type { listIssuesBySearchOrEmpty } from "../github/issues.ts";
import { settledOrEmpty } from "../settled-fold.ts";

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
  /**
   * Override the GitHub Issue/PR Read seam reader (issue #908/#915) used by the
   * meta-friction read. Passed straight through to `readMetaFrictionIssues`.
   */
  listIssuesBySearchOrEmpty?: typeof listIssuesBySearchOrEmpty;
  /**
   * Override the friction-patterns reader. Returns a list of
   * `{skill, patterns}` tuples. Defaults to scanning Redis. Tests pass a
   * stub so they don't need a live Redis.
   */
  readFrictionPatterns?: () => Promise<Array<{ skill: string; patterns: FrictionPattern[] }>>;
}

// `FrictionPattern` (the read-side friction-pattern domain type) moved to its
// canonical home in `src/pattern-memory/friction-pattern.ts` (issue #2596),
// next to `MemoryPattern` and `PROMOTION_THRESHOLD`. Re-exported here (via the
// top-of-file import) so any consumer that still imports it from this
// aggregator keeps working.
export type { FrictionPattern };

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
    readMetaFrictionIssues("lessons-overnight", windowStart, deps),
  ]);

  return {
    promotionCandidates: settledOrEmpty(candidatesResult, "lessons-overnight/candidates"),
    metaFrictionOpened: settledOrEmpty(issuesResult, "lessons-overnight/meta-friction"),
    windowHours,
    generatedAt: now.toISOString(),
    promotionThreshold: PROMOTION_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// Sub-source: friction promotion candidates
// ---------------------------------------------------------------------------

async function readPromotionCandidates(
  candidateWindow: number,
  deps: LessonsOvernightDeps,
): Promise<PromotionCandidate[]> {
  const reader =
    deps.readFrictionPatterns ??
    (() => readFrictionPatterns<FrictionPattern>("lessons-overnight"));
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
