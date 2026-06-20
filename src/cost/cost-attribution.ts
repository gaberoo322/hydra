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

import { getDailyTokenCounter, todayDateString } from "./surrogate.ts";
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

export interface CostByClassEntry {
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

  return { date, totalTokens, byClass };
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
