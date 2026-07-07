/**
 * src/cost/cost-attribution.ts — per-class cost attribution (issue #1439).
 *
 * Answers the Cost-domain question "what dispatch class does this skill's token
 * spend belong to?": the dispatch-class → cost-bucket mapping (`skillToCostClass`)
 * and the per-class token rollup (`projectCostByClass` / `getCostByClass`). These
 * depend on the Dispatch-Class Taxonomy (`src/taxonomy/classes.ts`) and the daily
 * token counter (`src/cost/surrogate.ts`), so they live in the Cost module family
 * rather than in `src/metrics/` (relocated from `src/metrics/aggregate.ts` by
 * issue #2219 so the Cost module's knowledge is concentrated under `src/cost/`).
 *
 * Public symbols are re-exported from `src/cost/index.ts` — the single public
 * Interface of the Cost module; callers import from `../cost/index.ts`.
 */

import {
  getDailyTokenCounter,
  getRollingTokenCounter,
  todayDateString,
  dateStringDaysAgo,
} from "./surrogate.ts";
import { DISPATCH_CLASSES, classBySkill } from "../taxonomy/classes.ts";
import { InvariantViolationError } from "../errors.ts";

/**
 * The dispatch-class buckets used for per-class cost attribution. This is the
 * alphabet of the `costClass` column in the Dispatch-Class Taxonomy
 * (`scripts/autopilot/classes.json`, typed view in `src/taxonomy/classes.ts`):
 * the cost-driving code-writing / review / research / housekeeping classes,
 * plus an `other` long-tail bucket for everything else (sweep, digest, doctor,
 * autopilot itself, …) so no token spend silently disappears.
 */
export type CostClass =
  | "research"
  | "dev-orch"
  | "dev-target"
  | "qa"
  | "cleanup"
  | "retro"
  | "other";

/** Stable ordering for the stacked-chart series. `other` always last. */
export const COST_CLASS_ORDER: readonly CostClass[] = Object.freeze([
  "research",
  "dev-orch",
  "dev-target",
  "qa",
  "cleanup",
  "retro",
  "other",
]);

const COST_CLASS_SET: ReadonlySet<string> = new Set(COST_CLASS_ORDER);

// Module-load invariant (epic #1669, slice #1671): every taxonomy row's
// costClass must be one of the declared buckets above, so the cast inside
// skillToCostClass is proven safe. Adding a class with a NEW bucket therefore
// forces an explicit edit to CostClass / COST_CLASS_ORDER / projectCostByClass
// instead of silently mis-bucketing its tokens to `other`. This is a
// boundary/invariant guard, not merge/verification code, so throwing is the
// documented convention (CLAUDE.md; mirrors src/taxonomy/classes.ts's
// fail-loud contract). It enforces a Cost-domain invariant, so it lives at the
// Cost-module boundary (issue #2219).
for (const row of DISPATCH_CLASSES) {
  if (!COST_CLASS_SET.has(row.costClass)) {
    throw new InvariantViolationError(
      `cost attribution: dispatch class "${row.name}" carries unknown ` +
        `costClass "${row.costClass}" — add the bucket to CostClass / ` +
        `COST_CLASS_ORDER / projectCostByClass in src/cost/cost-attribution.ts`,
    );
  }
}

/**
 * Skills that appear in the per-skill token counters but are NOT dispatch
 * classes (no row in the taxonomy — nothing in decide.py dispatches them;
 * they run operator-invoked or sub-dispatched). The taxonomy deliberately
 * covers only the dispatch alphabet, so these few attributions stay local.
 * Pinned by test/cost-by-class.test.mts.
 */
const NON_CLASS_SKILL_COST: Readonly<Record<string, CostClass>> = Object.freeze({
  "hydra-issue-research": "research",
  "hydra-architect": "research",
  "hydra-target-retro": "retro",
});

/**
 * Map a dispatched skill name to its cost-attribution class — a read of the
 * taxonomy's `costClass` column (which is where e.g. `hydra-target-qa` → `qa`
 * and the discover/scout/architecture research-family folding now live as
 * table rows). Pure + exported so the test suite can pin the mapping. Skills
 * absent from the taxonomy (and from the non-class residual above) fall to
 * `other` rather than `unknown` so the bucket sum always equals the daily
 * total.
 */
export function skillToCostClass(skill: string | undefined | null): CostClass {
  const s = (skill || "").trim().toLowerCase();
  if (!s) return "other";
  const row = classBySkill(s);
  // Cast is safe: the module-load invariant above proves every row's
  // costClass is a member of COST_CLASS_ORDER.
  if (row) return row.costClass as CostClass;
  return NON_CLASS_SKILL_COST[s] ?? "other";
}

interface CostByClassEntry {
  /** Total tokens attributed to this class for the window. */
  tokens: number;
  /** Fraction of the window's total tokens (0..1, rounded to 2 dp). */
  fraction: number;
  /** Skills that rolled up into this class (sorted by tokens desc). */
  skills: Array<{ skill: string; tokens: number }>;
}

export interface CostByClassResult {
  /** YYYY-MM-DD (UTC) the breakdown was computed for. */
  date: string;
  /** Total subagent tokens across all classes for the date. */
  totalTokens: number;
  /** Per-class breakdown keyed by CostClass; every class present, zeros included. */
  byClass: Record<CostClass, CostByClassEntry>;
  /**
   * Human-readable window label for the operator-facing view. For a single-date
   * read it is the date string; for the default rolling read (issue #2427) it
   * spells out the trailing-24h UTC span so the dashboard can label "today"
   * honestly and a thin post-UTC-midnight sliver never reads a false 0%.
   */
  window: string;
}

/**
 * Pure projection: fold a per-skill token breakdown (the shape returned by
 * `getDailyTokenCounter().bySkill`) into per-class totals + fractions.
 *
 * Exported separately from the Redis-reading `getCostByClass` so the fold is
 * unit-testable on fixtures without a live Redis (ADR-0014 pure-core seam).
 */
export function projectCostByClass(
  bySkill: Array<{ skill: string; tokens: number }>,
  date: string,
  window?: string,
): CostByClassResult {
  const byClass: Record<CostClass, CostByClassEntry> = {
    research: { tokens: 0, fraction: 0, skills: [] },
    "dev-orch": { tokens: 0, fraction: 0, skills: [] },
    "dev-target": { tokens: 0, fraction: 0, skills: [] },
    qa: { tokens: 0, fraction: 0, skills: [] },
    cleanup: { tokens: 0, fraction: 0, skills: [] },
    retro: { tokens: 0, fraction: 0, skills: [] },
    other: { tokens: 0, fraction: 0, skills: [] },
  };

  let totalTokens = 0;
  for (const { skill, tokens } of bySkill) {
    const n = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
    if (n === 0) continue;
    const cls = skillToCostClass(skill);
    byClass[cls].tokens += n;
    byClass[cls].skills.push({ skill, tokens: n });
    totalTokens += n;
  }

  for (const cls of COST_CLASS_ORDER) {
    const entry = byClass[cls];
    entry.fraction = totalTokens > 0
      ? Math.round((entry.tokens / totalTokens) * 100) / 100
      : 0;
    entry.skills.sort((a, b) => b.tokens - a.tokens);
  }

  return { date, totalTokens, byClass, window: window ?? date };
}

/**
 * Read the per-class cost breakdown for a given date (defaults to today UTC).
 *
 * Composes the existing per-skill daily token counter (`getDailyTokenCounter`,
 * the surrogate this orchestrator already populates at autopilot reap time)
 * with the pure `projectCostByClass` fold. No new Redis write path — the
 * per-skill data already carries the class signal via the skill name.
 */
export async function getCostByClass(dateOverride?: string): Promise<CostByClassResult> {
  const date = dateOverride || todayDateString();
  const counter = await getDailyTokenCounter(date);
  return projectCostByClass(counter.bySkill, counter.date);
}

/**
 * Read the per-class cost breakdown over a rolling ~24h UTC window ending at
 * `now` (issue #2427).
 *
 * This is the read the operator-facing "today" view should use: the surrogate
 * stores per-UTC-day buckets only, so a single-day `getCostByClass()` taken
 * just after UTC midnight covers a thin sliver and reads a false 0% for classes
 * that demonstrably ran earlier in the operator's local day (the false
 * "decide.py isn't dispatching" alarm #2427 was filed for). Folding the
 * previous UTC day in via `getRollingTokenCounter` guarantees the at-a-glance
 * number always spans the trailing ~24h regardless of where `now` falls inside
 * the UTC day.
 *
 * Callers that want a specific calendar day (an explicit `?date=`) must use
 * `getCostByClass(date)` — this function is exclusively the default-"today"
 * path. The `window` field on the result spells out the span for honest
 * labelling.
 */
export async function getRollingCostByClass(now: Date = new Date()): Promise<CostByClassResult> {
  const counter = await getRollingTokenCounter(now);
  return projectCostByClass(counter.bySkill, counter.date, counter.window);
}

// ---------------------------------------------------------------------------
// Cost per merged PR — a pure DERIVED ratio (issue #2807)
// ---------------------------------------------------------------------------

/** Default trailing window (whole UTC days) for the cost/merged-PR read. */
export const DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS = 30;

export interface CostPerMergedPrResult {
  /** Total subagent tokens summed over the trailing window. */
  totalTokens: number;
  /** Count of merged PRs (merged cycles) over the trailing window. */
  mergedPrCount: number;
  /**
   * Derived ratio: `totalTokens / mergedPrCount`, rounded to the nearest
   * integer token. `null` when `mergedPrCount` is 0 — a zero merged count is
   * distinct from a genuine "0 tokens per merge", so the ratio is undefined
   * rather than a misleading Infinity/0. Consumers render `null` as "—".
   */
  tokensPerMergedPr: number | null;
  /** The trailing window (whole UTC days) the totals were summed over. */
  windowDays: number;
  /**
   * Human-readable window label for the operator-facing view, e.g.
   * "last 30d (UTC) · 2026-06-05 → 2026-07-04". Spells out the span so the
   * dashboard can label the ratio honestly.
   */
  window: string;
}

/**
 * Pure projection: derive the cost-per-merged-PR ratio from an already-summed
 * token total and an already-counted merged-PR count.
 *
 * Exported separately from the Redis/trend-reading `getCostPerMergedPr` so the
 * ratio math is unit-testable on fixtures without a live Redis or metrics feed
 * (ADR-0014 pure-core seam). This introduces NO new token-recording writer — it
 * is a derived read over totals the surrogate and the cycle-metrics feed already
 * record (design-concept 99ef93a0 / issue #2807 invariant).
 */
export function projectCostPerMergedPr(
  totalTokens: number,
  mergedPrCount: number,
  windowDays: number,
  window?: string,
): CostPerMergedPrResult {
  const tokens = Number.isFinite(totalTokens) && totalTokens > 0 ? Math.floor(totalTokens) : 0;
  const merged = Number.isFinite(mergedPrCount) && mergedPrCount > 0 ? Math.floor(mergedPrCount) : 0;
  const days = Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : 0;
  const tokensPerMergedPr = merged > 0 ? Math.round(tokens / merged) : null;
  return {
    totalTokens: tokens,
    mergedPrCount: merged,
    tokensPerMergedPr,
    windowDays: days,
    window: window ?? `last ${days}d (UTC)`,
  };
}

/**
 * Sum the per-UTC-day subagent token buckets over the trailing `windowDays`
 * (inclusive of today). Composes the existing per-day surrogate counter — NO
 * new Redis write path; a pure read fold over the daily buckets the autopilot
 * already populates at reap time.
 *
 * Best-effort: each per-day sub-read already degrades to 0 on a Redis hiccup
 * (`getDailyTokenCounter`), so a partial window yields a partial sum rather
 * than a thrown error.
 */
export async function sumTokensOverWindow(
  windowDays: number = DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS,
  now: Date = new Date(),
): Promise<{ totalTokens: number; window: string; dates: [string, string] }> {
  const days = Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : 1;
  const counters = await Promise.all(
    Array.from({ length: days }, (_unused, i) => getDailyTokenCounter(dateStringDaysAgo(i, now))),
  );
  const totalTokens = counters.reduce((sum, c) => sum + (Number.isFinite(c.tokens) ? c.tokens : 0), 0);
  const newest = dateStringDaysAgo(0, now);
  const oldest = dateStringDaysAgo(days - 1, now);
  return {
    totalTokens,
    window: `last ${days}d (UTC) · ${oldest} → ${newest}`,
    dates: [oldest, newest],
  };
}

/**
 * Read the cost-per-merged-PR ratio over a trailing `windowDays` UTC window.
 *
 * Composes the token total (summed from the per-day surrogate buckets via
 * `sumTokensOverWindow`) with a caller-supplied merged-PR count from the
 * existing cycle-metrics / PR-lifecycle merged feed, then folds them through the
 * pure `projectCostPerMergedPr`. The merged count is injected (not read here) so
 * the Cost module stays free of a `src/metrics/` import — the API route
 * (`src/api/metrics.ts`) owns the composition of the two feeds (design-concept
 * 99ef93a0 / issue #2807: derived ratio, single public Interface).
 */
export async function getCostPerMergedPr(
  mergedPrCount: number,
  windowDays: number = DEFAULT_COST_PER_MERGED_PR_WINDOW_DAYS,
  now: Date = new Date(),
): Promise<CostPerMergedPrResult> {
  const { totalTokens, window } = await sumTokensOverWindow(windowDays, now);
  return projectCostPerMergedPr(totalTokens, mergedPrCount, windowDays, window);
}

// ---------------------------------------------------------------------------
// Per-class cost efficiency — the QA-cost-dominance audit read (issue #2971)
// ---------------------------------------------------------------------------
//
// The discover finding #2971 flagged QA as the single largest daily token
// consumer (~38% of daily tokens) and asked whether validation scope is
// appropriately scoped. But the issue itself notes the raw share is NOT a
// finding: comprehensive QA is appropriate, and QA runs proportionally to dev
// output, so a high QA *share* is expected, not wasteful. The falsifiable,
// actionable number is QA tokens **per merged PR** — the unit-economics of
// validation — which reframes "QA is 38% of spend" (alarming) as "QA costs N
// tokens per merged PR" (comparable across windows, a real efficiency signal).
//
// This is a PURE DERIVED read (design-concept 4d98ab3d, invariant 6:
// evidence-backed against recorded data). It composes two already-recorded
// feeds — the per-class token rollup (`projectCostByClass`, from the per-skill
// surrogate) and a merged-PR count (injected from the cycle-metrics merged
// feed, exactly as `getCostPerMergedPr` does) — with NO new token-recording
// writer, NO USD/dollar surface, NO gating (invariants 1–5). The per-class
// buckets still sum to the daily total; this read is additive.

/** One class's efficiency line in the audit read. */
export interface ClassCostEfficiencyEntry {
  /** Total tokens attributed to this class over the window. */
  tokens: number;
  /** Fraction of the window's total tokens (0..1, 2dp) — the raw "share". */
  fraction: number;
  /**
   * Derived unit-economics: `tokens / mergedPrCount`, rounded to the nearest
   * integer token. `null` when `mergedPrCount` is 0 (undefined, not a
   * misleading 0/Infinity) — consumers render `null` as "—". This is the
   * falsifiable efficiency number the audit turns on: a class's raw share is
   * expected to track its output, so the per-merge cost is what tells an
   * over-scoped class apart from a merely busy one.
   */
  tokensPerMergedPr: number | null;
}

export interface ClassCostEfficiencyResult {
  /** YYYY-MM-DD (UTC) the underlying per-class breakdown was computed for. */
  date: string;
  /** Total subagent tokens across all classes for the window. */
  totalTokens: number;
  /** Count of merged PRs over the window the per-merge ratios are derived from. */
  mergedPrCount: number;
  /**
   * Per-class efficiency keyed by CostClass; every class present (zeros
   * included, in `COST_CLASS_ORDER`), so the audit can compare QA against every
   * sibling class on the SAME per-merge basis rather than in isolation.
   */
  byClass: Record<CostClass, ClassCostEfficiencyEntry>;
  /**
   * The QA class's entry, surfaced at the top level so the #2971 audit read is
   * a one-hop lookup (`.qa.tokensPerMergedPr`) rather than a byClass dig. QA is
   * the finding's subject; every other class is available under `byClass` for
   * the comparative baseline the audit needs.
   */
  qa: ClassCostEfficiencyEntry;
  /** Human-readable window label (mirrors the source `CostByClassResult.window`). */
  window: string;
}

/**
 * Pure projection: fold an already-computed per-class token breakdown
 * (`CostByClassResult`) plus a merged-PR count into per-class efficiency lines
 * (tokens, share, tokens-per-merged-PR).
 *
 * Exported separately from the Redis-reading `getClassCostEfficiency` so the
 * unit-economics math is testable on fixtures without a live Redis or metrics
 * feed (ADR-0014 pure-core seam). Introduces NO new writer — it re-derives over
 * the `byClass` totals `projectCostByClass` already produced and a merged count
 * the caller injects from the cycle-metrics feed (issue #2971 invariant 6).
 */
export function projectClassCostEfficiency(
  costByClass: CostByClassResult,
  mergedPrCount: number,
): ClassCostEfficiencyResult {
  const merged =
    Number.isFinite(mergedPrCount) && mergedPrCount > 0 ? Math.floor(mergedPrCount) : 0;

  const byClass = {} as Record<CostClass, ClassCostEfficiencyEntry>;
  for (const cls of COST_CLASS_ORDER) {
    const src = costByClass.byClass[cls];
    const tokens = Number.isFinite(src?.tokens) && src.tokens > 0 ? Math.floor(src.tokens) : 0;
    byClass[cls] = {
      tokens,
      fraction: Number.isFinite(src?.fraction) ? src.fraction : 0,
      tokensPerMergedPr: merged > 0 ? Math.round(tokens / merged) : null,
    };
  }

  return {
    date: costByClass.date,
    totalTokens:
      Number.isFinite(costByClass.totalTokens) && costByClass.totalTokens > 0
        ? Math.floor(costByClass.totalTokens)
        : 0,
    mergedPrCount: merged,
    byClass,
    qa: byClass.qa,
    window: costByClass.window,
  };
}

/**
 * Read the per-class cost-efficiency breakdown over the default rolling ~24h
 * UTC window (the operator-facing "today" view — issue #2427 window semantics),
 * with the tokens-per-merged-PR ratio derived from an injected merged-PR count.
 *
 * Composes `getRollingCostByClass` (the per-class token rollup) with the pure
 * `projectClassCostEfficiency` fold. The merged count is INJECTED (not read
 * here) so the Cost module stays free of a `src/metrics/` import — the API
 * route (`src/api/metrics.ts`) owns the composition of the two feeds, exactly
 * as `getCostPerMergedPr` does (issue #2971: derived read, single public
 * Interface, no cross-import).
 */
export async function getClassCostEfficiency(
  mergedPrCount: number,
  now: Date = new Date(),
): Promise<ClassCostEfficiencyResult> {
  const costByClass = await getRollingCostByClass(now);
  return projectClassCostEfficiency(costByClass, mergedPrCount);
}
