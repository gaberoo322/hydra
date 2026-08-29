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
  todayDateString,
  dateStringDaysAgo,
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
// Dispatch -> issue cost-join ledger (issue #4126, ADR-0032 epic #4123 slice
// gamma): the Redis-seam accessors this module composes into the by-issue
// read surface. One-way import — `src/redis/cost.ts` imports nothing back.
import {
  listDispatchCostJoinIssues,
  getDispatchCostJoinForIssue,
  getUnattributedDispatchCostJoin,
} from "../redis/cost.ts";
import type { DispatchCostJoinRecord } from "../redis/cost.ts";

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
interface ClassCostEfficiencyEntry {
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
  opts: { snapshot?: UsageSnapshot } = {},
): Promise<ClassCostEfficiencyResult> {
  const costByClass = await getRollingCostByClass(now, opts);
  return projectClassCostEfficiency(costByClass, mergedPrCount);
}

// ---------------------------------------------------------------------------
// Usage-by-issue — the dispatch -> issue cost join read surface (issue #4126,
// ADR-0032 epic #4123 slice gamma)
// ---------------------------------------------------------------------------

/** One issue's rolled-up dispatch-cost-join ledger. */
export interface UsageByIssueEntry {
  issue: number;
  /** Sum of `dispatchTokensEstimate` across every recorded dispatch for this issue. */
  totalDispatchTokensEstimate: number;
  /** Number of recorded dispatches (any class) attributed to this issue. */
  dispatchCount: number;
  /** Per-class token subtotal, keyed by the raw dispatch-class name. */
  byClass: Record<string, number>;
  /** The raw records this entry was folded from, newest-first. */
  records: DispatchCostJoinRecord[];
}

/**
 * `GET /api/usage/by-issue`'s response shape. Always carries the residual —
 * issue #4126's acceptance criterion that an unattributable dispatch is
 * reported as an explicit residual, never dropped — and `attributedPercent`
 * alongside it, mirroring the existing `attributedPercent` convention
 * `UsageSnapshot` already established for skill-level attribution (~90%
 * there; this is the SAME honesty contract at issue granularity).
 */
export interface UsageByIssueResult {
  /** Every attributed issue's rollup (or just the one queried, if filtered),
   *  sorted by `totalDispatchTokensEstimate` descending. */
  byIssue: UsageByIssueEntry[];
  /** Sum of every attributed issue's `totalDispatchTokensEstimate`. */
  totalAttributedTokensEstimate: number;
  /** Sum of the unattributable residual ledger's `dispatchTokensEstimate`. */
  residualTokensEstimate: number;
  /** Count of unattributable records — never silently dropped (issue #4126). */
  residualDispatchCount: number;
  /** `100 * attributed / (attributed + residual)`, rounded to 2dp; 0 when
   *  both are 0 (nothing recorded yet). */
  attributedPercent: number;
  /** ISO8601 timestamp this view was assembled. */
  generatedAt: string;
}

/**
 * Pure fold: turn a per-issue set of raw ledger reads plus the global
 * unattributed residual into the {@link UsageByIssueResult} shape. Redis-free
 * (ADR-0014 pure-core seam) so the fold is unit-testable on fixtures without
 * a live Redis — mirrors `projectCostByClass` / `projectClassCostEfficiency`'s
 * split from their Redis-reading `get*` coordinators above.
 */
export function projectUsageByIssue(
  perIssue: Array<{ issue: number; records: DispatchCostJoinRecord[] }>,
  unattributed: DispatchCostJoinRecord[],
  now: () => string = () => new Date().toISOString(),
): UsageByIssueResult {
  const byIssue: UsageByIssueEntry[] = [];
  let totalAttributed = 0;

  for (const { issue, records } of perIssue) {
    const byClass: Record<string, number> = {};
    let issueTotal = 0;
    for (const rec of records) {
      const n =
        Number.isFinite(rec.dispatchTokensEstimate) && rec.dispatchTokensEstimate > 0
          ? rec.dispatchTokensEstimate
          : 0;
      byClass[rec.class] = (byClass[rec.class] || 0) + n;
      issueTotal += n;
    }
    byIssue.push({
      issue,
      totalDispatchTokensEstimate: issueTotal,
      dispatchCount: records.length,
      byClass,
      records,
    });
    totalAttributed += issueTotal;
  }
  byIssue.sort((a, b) => b.totalDispatchTokensEstimate - a.totalDispatchTokensEstimate);

  let residual = 0;
  for (const rec of unattributed) {
    residual +=
      Number.isFinite(rec.dispatchTokensEstimate) && rec.dispatchTokensEstimate > 0
        ? rec.dispatchTokensEstimate
        : 0;
  }

  const denom = totalAttributed + residual;
  const attributedPercent = denom > 0 ? Math.round((totalAttributed / denom) * 10000) / 100 : 0;

  return {
    byIssue,
    totalAttributedTokensEstimate: totalAttributed,
    residualTokensEstimate: residual,
    residualDispatchCount: unattributed.length,
    attributedPercent,
    generatedAt: now(),
  };
}

/**
 * Read the dispatch -> issue cost-join view (issue #4126). No `issueFilter`
 * reads every issue in the index; a supplied `issueFilter` narrows `byIssue`
 * to that one issue while the residual / `attributedPercent` figures still
 * fold over the WHOLE ledger (see this file's `UsageByIssueQuerySchema`
 * consumer in `src/api/usage.ts` for why: a GLM-arm issue's residual
 * visibility must not depend on which issue the caller happened to query).
 */
export async function getUsageByIssue(issueFilter?: number): Promise<UsageByIssueResult> {
  const unattributed = await getUnattributedDispatchCostJoin();
  if (issueFilter) {
    const records = await getDispatchCostJoinForIssue(issueFilter);
    return projectUsageByIssue([{ issue: issueFilter, records }], unattributed);
  }
  const issues = await listDispatchCostJoinIssues();
  const perIssue = await Promise.all(
    issues.map(async (issue) => ({ issue, records: await getDispatchCostJoinForIssue(issue) })),
  );
  return projectUsageByIssue(perIssue, unattributed);
}
