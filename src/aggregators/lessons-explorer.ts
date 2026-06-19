/**
 * Lessons-explorer aggregator (issue #620, PRD #615) — Explore page Lessons tab.
 *
 * Browses promoted lessons across every skill. A "promoted lesson" is a
 * `MemoryPattern` with `promoted: true` stored under
 * `hydra:memory:{skill}:patterns`. The Lessons tab sorts by firing frequency
 * (post-promotion hit count) so the operator can spot the rules that keep
 * earning their keep vs. promotion candidates that quieted down.
 *
 * Filters
 * -------
 * The Explore tab passes an optional `skill` filter (substring/exact match).
 * Other filters can be added later; the schema reserves `filters` as an
 * object rather than baking the shape into the function signature.
 *
 * # Design contract
 *
 * - **Pure classifier exported.** `liftPromotedLessons` is tested directly.
 * - **Never throws.** Redis failure → `[]`.
 * - **Source-of-truth = Redis.** We never read the on-disk `lessons.md`
 *   files under `~/.claude/skills/{name}/` — those files are the
 *   human-facing artifact and may lag the in-Redis `promoted: true` state.
 *   The aggregator reflects Redis.
 */

import { PROMOTION_THRESHOLD } from "../pattern-memory/constants.ts";
import { scanPatternGroupsRaw } from "../redis/agent-memory.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PromotedLesson {
  skill: string;
  cue: string;
  severity: "prevent" | "reinforce";
  hitCount: number;
  /** Hits at the moment of promotion — baseline for "post-promotion firings". */
  hitsAtPromotion: number | null;
  /** Firings since promotion = hitCount - hitsAtPromotion, when both known. */
  postPromotionHits: number | null;
  promotedAt: string;
  lastSeen: string;
  examples: string[];
  /** True when a previously-promoted pattern was later demoted. */
  demoted: boolean;
}

export interface LessonsExplorerFilters {
  skill?: string;
}

export interface LessonsExplorerSnapshot {
  lessons: PromotedLesson[];
  /** Echo of the promotion threshold so the dashboard can label "≥N hits". */
  promotionThreshold: number;
  generatedAt: string;
}

export interface LessonsExplorerDeps {
  now?: Date;
  /**
   * Override the patterns reader. Returns `{ skill, patterns }` tuples
   * across both the memory namespace and (for completeness) the friction
   * namespace — though promoted patterns predominantly live in memory.
   * Tests pass a stub so they don't need a live Redis.
   */
  readMemoryPatterns?: () => Promise<Array<{ skill: string; patterns: RawMemoryPattern[] }>>;
}

export interface RawMemoryPattern {
  category: string;
  severity?: "prevent" | "reinforce";
  hitCount: number;
  promoted?: boolean;
  promotedAt?: string;
  hitsAtPromotion?: number;
  demoted?: boolean;
  lastSeen?: string;
  examples?: string[];
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function getLessonsExplorer(
  filters: LessonsExplorerFilters = {},
  deps: LessonsExplorerDeps = {},
): Promise<LessonsExplorerSnapshot> {
  const now = deps.now ?? new Date();
  const reader = deps.readMemoryPatterns ?? defaultReadMemoryPatterns;

  let groups: Array<{ skill: string; patterns: RawMemoryPattern[] }>;
  try {
    groups = await reader();
  } catch (err: any) {
    console.error(
      `[lessons-explorer] reader failed: ${err?.message || err}`,
    );
    groups = [];
  }

  const lessons: PromotedLesson[] = [];
  for (const { skill, patterns } of groups) {
    if (filters.skill && !skillMatches(skill, filters.skill)) continue;
    lessons.push(...liftPromotedLessons(skill, patterns));
  }
  // Firing frequency = hitCount, descending. Stable secondary by skill+cue
  // so the table doesn't shuffle between polls when counts tie.
  lessons.sort((a, b) => {
    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
    if (a.skill !== b.skill) return a.skill.localeCompare(b.skill);
    return a.cue.localeCompare(b.cue);
  });

  return {
    lessons,
    promotionThreshold: PROMOTION_THRESHOLD,
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Pure helper — exported for tests. Lifts the promoted patterns for ONE
 * skill into the dashboard-facing shape. Drops un-promoted rows and rows
 * missing the structural fields the table needs.
 */
export function liftPromotedLessons(
  skill: string,
  patterns: readonly RawMemoryPattern[],
): PromotedLesson[] {
  if (!Array.isArray(patterns)) return [];
  const out: PromotedLesson[] = [];
  for (const p of patterns) {
    if (!p || typeof p !== "object") continue;
    if (!p.promoted) continue;
    const hitCount = Number(p.hitCount);
    if (!Number.isFinite(hitCount) || hitCount < 0) continue;
    const cue = typeof p.category === "string" && p.category.length > 0 ? p.category : "(unknown cue)";
    const hitsAtPromotion =
      typeof p.hitsAtPromotion === "number" && Number.isFinite(p.hitsAtPromotion)
        ? p.hitsAtPromotion
        : null;
    const postPromotionHits =
      hitsAtPromotion !== null ? Math.max(0, hitCount - hitsAtPromotion) : null;
    out.push({
      skill,
      cue,
      severity: p.severity === "reinforce" ? "reinforce" : "prevent",
      hitCount,
      hitsAtPromotion,
      postPromotionHits,
      promotedAt: typeof p.promotedAt === "string" ? p.promotedAt : "",
      lastSeen: typeof p.lastSeen === "string" ? p.lastSeen : "",
      examples: Array.isArray(p.examples)
        ? p.examples.filter((e): e is string => typeof e === "string").slice(0, 3)
        : [],
      demoted: Boolean(p.demoted),
    });
  }
  return out;
}

/** Pure helper — exported for tests. Filter match: exact or case-insensitive substring. */
export function skillMatches(skill: string, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return skill.toLowerCase().includes(f);
}

// ---------------------------------------------------------------------------
// Default Redis reader
// ---------------------------------------------------------------------------

async function defaultReadMemoryPatterns(): Promise<
  Array<{ skill: string; patterns: RawMemoryPattern[] }>
> {
  // The SCAN cursor walk + GET against `hydra:memory:*:patterns` lives behind
  // the typed seam (`scanPatternGroupsRaw`); this reader owns only the per-key
  // JSON parse + array narrowing into its `RawMemoryPattern` shape.
  const groups = await scanPatternGroupsRaw("memory");
  const out: Array<{ skill: string; patterns: RawMemoryPattern[] }> = [];
  for (const { name: skill, raw } of groups) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push({ skill, patterns: parsed as RawMemoryPattern[] });
    } catch (err: any) {
      console.error(
        `[lessons-explorer] failed to parse hydra:memory:${skill}:patterns: ${err?.message || err}`,
      );
    }
  }
  return out;
}
