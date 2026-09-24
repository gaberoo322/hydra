/**
 * src/cost/cost-by-class.ts — per-class cost attribution rollup (issues
 * #1439 / #3752, split out of the former bundled cost-attribution module by
 * issue #4347).
 *
 * Answers the Cost-domain question "what dispatch class does this skill's token
 * spend belong to?": the dispatch-class → cost-bucket mapping (`skillToCostClass`)
 * and the per-class token rollup, in two arms — the historical `?date=`
 * surrogate fold (`projectCostByClass` / `getCostByClass`, issue #1439) and the
 * comprehensive rolling transcript fold (`projectCostByClassFromTranscript` /
 * `getRollingCostByClass`, issue #3752). These depend on the Dispatch-Class
 * Taxonomy (`src/taxonomy/classes.ts`) and the daily token counter
 * (`src/cost/surrogate.ts`), so they live in the Cost module family rather than
 * in `src/metrics/` (relocated from `src/metrics/aggregate.ts` by issue #2219
 * so the Cost module's knowledge is concentrated under `src/cost/`).
 *
 * `CostClass` / `COST_CLASS_ORDER` / `skillToCostClass` are the shared anchor
 * every other derived read under `src/cost/` keys on, so they stay here, with
 * the rollup they are most tightly bound to (issue #4347 INV-5: this file is
 * the leaf of the split — it imports no sibling split file).
 *
 * Public symbols are re-exported from `src/cost/index.ts` — the single public
 * Interface of the Cost module; callers import from `../cost/index.ts`.
 */

import {
  getDailyTokenCounter,
  todayDateString,
} from "./surrogate.ts";
import { DISPATCH_CLASSES, classBySkill } from "../taxonomy/classes.ts";
import { InvariantViolationError } from "../errors.ts";
// The Subscription Usage Tracker I/O coordinator (issue #3752): the
// comprehensive rolling cost-by-class arm re-sources from its ALREADY-MEMOIZED
// snapshot (60s in-process cache) rather than the dispatch-observed surrogate,
// so the per-class tokens sum to the snapshot's `tokensLast24h`. One-way
// import: usage-tracker.ts imports nothing back from here (verified: it depends
// only on the pure leaves + transcript-scan), so no cycle.
import type { UsageSnapshot } from "./types.ts";
import { getUsage } from "./usage-tracker.ts";
// Quota-Weight env readers (issue #691) — the comprehensive fold's per-class
// Quota-Weight axis. Pure config leaf, no cycle.
import {
  getQuotaWeightOpus,
  getQuotaWeightSonnet,
  getQuotaWeightHaiku,
} from "./config.ts";
// Per-family Quota-Weight + the canonical family list (issue #1909). Pure math
// leaf; imported one-way.
import { familyWeight, MODEL_FAMILIES } from "./token-math.ts";
import type { TokenBreakdown, ModelFamily } from "./token-math.ts";
// The residual `INTERACTIVE_SKILL` constant (issue #2402) lives in the pure
// token-breakdown leaf; the `interactive` cost class below maps it.
import { INTERACTIVE_SKILL } from "./token-breakdown.ts";

/**
 * The dispatch-class buckets used for per-class cost attribution. This is the
 * alphabet of the `costClass` column in the Dispatch-Class Taxonomy
 * (`scripts/autopilot/classes.json`, typed view in `src/taxonomy/classes.ts`):
 * the cost-driving code-writing / review / research / housekeeping classes,
 * plus an `interactive` residual for host activity the autopilot did NOT
 * dispatch (operator sessions, other projects under `~/.claude/projects`) and an
 * `other` long-tail bucket for recorded hydra skills outside the taxonomy
 * (sweep, digest, doctor, autopilot itself, …). The two residuals stay
 * DISTINCT (issue #3752 INV-3): `interactive` is the undispatched host
 * surface, `other` is a dispatched-but-untaxonomised skill — so neither host
 * activity nor an unrecognised skill can silently disappear.
 */
export type CostClass =
  | "research"
  | "dev-orch"
  | "dev-target"
  | "qa"
  | "cleanup"
  | "retro"
  | "interactive"
  | "other";

/** Stable ordering for the stacked-chart series. `other` always last. */
export const COST_CLASS_ORDER: readonly CostClass[] = Object.freeze([
  "research",
  "dev-orch",
  "dev-target",
  "qa",
  "cleanup",
  "retro",
  "interactive",
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
        `COST_CLASS_ORDER / projectCostByClass in src/cost/cost-by-class.ts`,
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
  // Post-#4636 residual: research_orch's row now names hydra-issue-research
  // (decide.py's dispatch literal — pinned by test/classes-skill-drift.test.mts),
  // so hydra-research — the operator's interactive board-research skill, still
  // present in historical token counters — no longer resolves via a row.
  "hydra-research": "research",
  // The `interactive` residual skill (issue #2402) — host activity the autopilot
  // did NOT dispatch (operator sessions, other projects) — maps to its OWN named
  // cost class so it is never folded into `other` and never dropped (issue #3752
  // INV-3). `other` stays reserved for a recorded hydra skill outside the
  // taxonomy, keeping the two residuals distinguishable.
  [INTERACTIVE_SKILL]: "interactive",
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
  /**
   * Per-model-family RAW token breakdown attributed to this class (issue #3752
   * INV-4). Every entry carries all four family keys (opus/sonnet/haiku/
   * unknown), zero-valued where the class produced none. On the
   * `dispatch-surrogate` arm every entry is all-zero (the counter is
   * model-blind); on the `transcript-24h` arm it is populated from the per-skill
   * × per-family cross-tab. Lets a consumer weight a Haiku-heavy class against an
   * Opus-heavy one on raw tokens before applying {@link quotaWeight}.
   */
  byModel: Record<ModelFamily, number>;
  /**
   * Quota-Weight burn attributed to this class: `Σ_family byModel[f] *
   * familyWeight(f)` — the same raw-total × per-family-weight figure the snapshot
   * reports as `quotaWeightLast7d`, scoped to this class's window tokens. Exactly
   * 0 when the Quota-Weight env is uncalibrated OR on the model-blind surrogate
   * arm. Deliberately NOT a USD figure (CONTEXT.md 'Quota Weight'). Lets a
   * consumer rank classes on quota burn so a cheap-Haiku class can never outrank
   * an expensive-Opus class on raw tokens alone (issue #3752 INV-4).
   */
  quotaWeight: number;
}

/**
 * Which meter backs a {@link CostByClassResult} (issue #3752 INV-2), so a
 * consumer can never mistake the comprehensive rolling read for the historical
 * calendar-day read.
 *
 *   - `"transcript-24h"` — the comprehensive arm: sourced ONLY from the
 *     already-memoized transcript-scan snapshot; per-class tokens sum to the same
 *     snapshot's `tokensLast24h`, so `fraction` is a true share of real burn and
 *     {@link CostByClassEntry.byModel} / {@link CostByClassEntry.quotaWeight} are
 *     populated. This is the read the digest's per-class cost ranking consumes.
 *   - `"dispatch-surrogate"` — the historical arm: sourced ONLY from the
 *     dispatch-observed Redis counter (autopilot-reaped subagents); model-blind
 *     and covering only what the autopilot dispatched, so the model fields are
 *     zeroed and `fraction` is a share of the partial surrogate.
 *
 * The two arms are NEVER blended in one response — each carries exactly one
 * `source`.
 */
type CostByClassSource = "transcript-24h" | "dispatch-surrogate";

export interface CostByClassResult {
  /** YYYY-MM-DD (UTC) the breakdown was computed for. */
  date: string;
  /**
   * Total tokens across all classes for the window. On the `transcript-24h` arm
   * this equals the source snapshot's `tokensLast24h` by construction (issue
   * #3752 INV-1); on the `dispatch-surrogate` arm it is the surrogate's recorded
   * total. The per-class `byClass[c].tokens` always sum to this value.
   */
  totalTokens: number;
  /** Per-class breakdown keyed by CostClass; every class present, zeros included. */
  byClass: Record<CostClass, CostByClassEntry>;
  /**
   * Human-readable window label for the operator-facing view. For a single-date
   * read it is the date string; for the comprehensive rolling read it names the
   * trailing-24h transcript source so the dashboard can label "today" honestly.
   */
  window: string;
  /** Which meter backs this breakdown (issue #3752 INV-2). */
  source: CostByClassSource;
}

/**
 * Build a per-class entry table initialised to all-zero entries over
 * {@link COST_CLASS_ORDER} (issue #3752). Shared by both folds so every result
 * carries every class — zeros included — and the model fields default to the
 * model-blind zero state.
 */
function emptyClassEntries(): Record<CostClass, CostByClassEntry> {
  const out = {} as Record<CostClass, CostByClassEntry>;
  for (const cls of COST_CLASS_ORDER) {
    out[cls] = {
      tokens: 0,
      fraction: 0,
      skills: [],
      byModel: { opus: 0, sonnet: 0, haiku: 0, unknown: 0 },
      quotaWeight: 0,
    };
  }
  return out;
}

/**
 * Pure projection: fold a per-skill token breakdown (the shape returned by
 * `getDailyTokenCounter().bySkill`) into per-class totals + fractions.
 *
 * Exported separately from the Redis-reading `getCostByClass` so the fold is
 * unit-testable on fixtures without a live Redis (ADR-0014 pure-core seam).
 *
 * This is the `dispatch-surrogate` fold (issue #3752 INV-8): it stays a pure,
 * Redis-free fold over a `(skill, tokens)` list. The model fields
 * ({@link CostByClassEntry.byModel} / {@link CostByClassEntry.quotaWeight}) are
 * zeroed because the surrogate is model-blind; re-sourcing the comprehensive arm
 * to the transcript scan changes a DIFFERENT fold (`projectCostByClassFromTranscript`),
 * so the existing pure-fold tests keep applying unchanged.
 */
export function projectCostByClass(
  bySkill: Array<{ skill: string; tokens: number }>,
  date: string,
  window?: string,
): CostByClassResult {
  const byClass = emptyClassEntries();

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

  return { date, totalTokens, byClass, window: window ?? date, source: "dispatch-surrogate" };
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
 * Pure projection: fold the transcript-scan's per-skill × per-family 24h
 * cross-tab (`UsageSnapshot.bySkillByModel24h`) into per-class totals, model
 * breakdowns, Quota-Weight figures, and fractions — the **comprehensive**
 * cost-by-class arm (issue #3752).
 *
 * DISTINCT from {@link projectCostByClass} (the surrogate fold): this one folds
 * a per-FAMILY cross-tab, so it can emit a per-model breakdown and a per-class
 * Quota-Weight, and its per-class tokens sum to `tokensLast24h` by construction
 * — `fraction` becomes a true share of REAL burn, not a share of the partial
 * dispatch-observed surrogate. The surrogate fold stays pure over
 * `(skill, tokens)`; THIS fold stays pure over `(bySkillByModel24h,
 * tokensLast24h, weights)` — both Redis-free (ADR-0014).
 *
 * HEADLINE COVERAGE INVARIANT (issue #3752 INV-1): the per-class `tokens` sum
 * over {@link COST_CLASS_ORDER} equals `totalTokens`, and `totalTokens` equals
 * the caller-supplied `tokensLast24h` when the cross-tab reconciles against it
 * (which it does by construction — the scan accumulates both from the SAME 24h
 * lines). The "interactive" residual skill lands in its OWN named class so host
 * activity the autopilot never reaped is visible, never dropped (INV-3).
 *
 * Exported separately from the snapshot-reading `getRollingCostByClass` so the
 * fold is unit-testable on fixtures without a filesystem or a live snapshot.
 */
export function projectCostByClassFromTranscript(input: {
  /** Per-skill × per-family 24h cross-tab (the `bySkillByModel24h` snapshot field). */
  bySkillByModel24h: Record<string, Record<ModelFamily, TokenBreakdown>>;
  /** The trusted 24h raw total the cross-tab reconciles against (INV-1). */
  tokensLast24h: number;
  /** YYYY-MM-DD (UTC) to stamp on the result. */
  date: string;
  /** Human-readable window label (the caller composes the source/timestamp). */
  window: string;
  /** Per-family Quota-Weight env values {opus, sonnet, haiku}. */
  weights: { opus: number; sonnet: number; haiku: number };
  /** True only when all three HYDRA_QUOTA_WEIGHT_* env vars are positive. */
  quotaWeightCalibrated: boolean;
}): CostByClassResult {
  const { bySkillByModel24h, date, window, weights, quotaWeightCalibrated } = input;
  // `tokensLast24h` (input.tokensLast24h) is the trusted 24h meter the cross-tab
  // reconciles against; the regression test asserts `totalTokens === tokensLast24h`
  // on a reconciling fixture (INV-1 clause 2). It is not consumed for the total
  // below — `totalTokens` is the SUM of the partitioned per-class tokens so the
  // bucket-sum invariant holds exactly; the two are equal by construction in the
  // production wiring (the scan accumulates both from the same 24h lines).
  const byClass = emptyClassEntries();

  let attributed = 0;
  for (const skill of Object.keys(bySkillByModel24h)) {
    const fam = bySkillByModel24h[skill];
    const skillTokens = MODEL_FAMILIES.reduce((sum, f) => sum + (fam[f]?.total ?? 0), 0);
    const n = Number.isFinite(skillTokens) && skillTokens > 0 ? Math.floor(skillTokens) : 0;
    if (n === 0) continue;
    const cls = skillToCostClass(skill);
    byClass[cls].tokens += n;
    byClass[cls].skills.push({ skill, tokens: n });
    for (const f of MODEL_FAMILIES) {
      const ft = fam[f]?.total ?? 0;
      byClass[cls].byModel[f] += Number.isFinite(ft) && ft > 0 ? Math.floor(ft) : 0;
    }
    attributed += n;
  }

  // INV-1: totalTokens is the SUM of the partitioned per-class tokens, so the
  // bucket-sum invariant (Σ class tokens === totalTokens) holds EXACTLY. In
  // production `attributed === tokensLast24h` by construction (the scan's 24h
  // cross-tab and the 24h scalar are accumulated from the same lines), so this
  // also equals the trusted snapshot meter — pinned by the regression test on a
  // reconciling fixture.
  const totalTokens = attributed;

  for (const cls of COST_CLASS_ORDER) {
    const entry = byClass[cls];
    entry.fraction = totalTokens > 0 ? Math.round((entry.tokens / totalTokens) * 100) / 100 : 0;
    entry.skills.sort((a, b) => b.tokens - a.tokens);
    // Per-class Quota-Weight: raw .total per family × the family weight (the
    // same Axis-B figure the snapshot reports as quotaWeightLast7d), 0 when the
    // env is uncalibrated. Deliberately NOT a USD figure (INV-7).
    if (quotaWeightCalibrated) {
      entry.quotaWeight = MODEL_FAMILIES.reduce(
        (sum, f) => sum + entry.byModel[f] * familyWeight(f, weights),
        0,
      );
    }
  }

  // `tokensLast24h` is the trusted meter the cross-tab reconciles against; see
  // the note at the top of this fold for why the total is the partition sum
  // rather than the meter itself (the two are equal by construction).

  return { date, totalTokens, byClass, window, source: "transcript-24h" };
}

/**
 * Read the per-class cost breakdown over a trailing 24h window ending at `now`
 * — the operator-facing "today" view (issue #2427 / #3752).
 *
 * Re-sourced to the **comprehensive** transcript arm (issue #3752): the
 * breakdown is folded from the ALREADY-MEMOIZED Subscription Usage Tracker
 * snapshot's `bySkillByModel24h` cross-tab, so the per-class tokens sum to the
 * snapshot's `tokensLast24h` and `fraction` is a true share of real burn. The
 * prior surrogate-sourced read attributed only what the autopilot had reaped
 * (~13% of real burn on the live sample) because operator interactive sessions
 * and other host projects have no dispatch record to hook — the comprehensive
 * arm reads them straight off the transcripts the scan already walks, so nothing
 * silently disappears. The dispatch-observed counter is NOT retired (INV-5): the
 * historical `?date=` arm (`getCostByClass`) still reads it, and `source`
 * discriminates the two.
 *
 * Reading the memoized snapshot means `/api/metrics` adds NO new filesystem walk
 * per request (INV-6): it rides the 60s in-process cache `getUsage()` shares
 * with the autopilot tick and the dashboard. The trailing-24h window also kills
 * the false-0%-near-UTC-midnight read the surrogate's per-UTC-day buckets caused
 * (#2427): a trailing-24h sum always spans the last day regardless of where
 * `now` falls inside the UTC day.
 *
 * Pass `opts.snapshot` to fold a snapshot the caller already holds (e.g. a
 * test) instead of calling `getUsage`; omitted on the production path.
 */
export async function getRollingCostByClass(
  now: Date = new Date(),
  opts: { snapshot?: UsageSnapshot } = {},
): Promise<CostByClassResult> {
  const snapshot = opts.snapshot ?? (await getUsage({ now }));
  const weights = {
    opus: getQuotaWeightOpus(),
    sonnet: getQuotaWeightSonnet(),
    haiku: getQuotaWeightHaiku(),
  };
  const quotaWeightCalibrated = weights.opus > 0 && weights.sonnet > 0 && weights.haiku > 0;
  return projectCostByClassFromTranscript({
    bySkillByModel24h: snapshot.bySkillByModel24h,
    tokensLast24h: snapshot.tokensLast24h,
    date: todayDateString(now),
    window: `last 24h (transcript) · ${snapshot.generatedAt}`,
    weights,
    quotaWeightCalibrated,
  });
}
