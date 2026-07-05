/**
 * Tool-scout calendar walk (issue #485, Phase B of /hydra-tool-scout epic).
 *
 * Once-per-week trigger that builds the list of (category | dependency)
 * targets the scout should walk, filters them through three cooldown
 * tiers, and hands the survivors back to the caller (autopilot or the
 * `/hydra-tool-scout` skill) for dispatch.
 *
 * The walk is **deterministic**: given the same Redis state and the same
 * "now" timestamp, it returns the same target list. That lets the
 * autopilot's decide.py treat the walk as an idempotent signal — it can
 * recompute the list mid-week without changing the dispatch behaviour.
 *
 * Cooldown tiers (all checked, drop the target if ANY says "skip"):
 *
 *   1. Per-class (`scout_orch`): 7 days, read from the Dispatch-Class
 *      Taxonomy (`scripts/autopilot/classes.json` — the same row decide.py
 *      derives `SIGNAL_COOLDOWNS` from). This module assumes the class-level
 *      cooldown has already been honored by the caller and does not
 *      re-check it.
 *   2. Per-category: 30 days default. Stored at
 *      `hydra:scout:category-last-walked:<category>`. Default chosen to
 *      keep `typed-schemas` from being re-walked every weekly tick.
 *   3. Per-tool: 90 days. Owned by `seen-list.ts:isEligibleForReEval` —
 *      the calendar walk surfaces categories, not specific tools, so the
 *      per-tool cooldown lands inside the scout dispatch itself (during
 *      the seen-list filter gate). This module does NOT re-check it.
 *
 * Per the issue body's research question #2: when per-category cooldown
 * says "skip" but per-tool says "ready", the category-level skip wins
 * (operator preference: fewer issues). This is enforced by the order of
 * checks above — category is checked BEFORE the scout dispatches at all.
 *
 * Walk surface:
 *
 *   (a) `package.json` runtime dependencies from `~/hydra/package.json`
 *       (currently 4: express, ioredis, ws, @sentry/node) and from
 *       `~/hydra/dashboard/package.json` (per research question #4 — both
 *       are git-tracked, both are first-class deps the AI agents depend
 *       on, so both belong in the walk).
 *
 *   (b) Each H2 category in `docs/ai-leverage-categories.md` (10 entries
 *       as of Phase A).
 *
 * Per research question #3: the walk dispatches one scout per category
 * serially (caller controls dispatch — this module returns the target
 * list). This keeps per-category context isolation and lets the autopilot
 * track per-category cost. The trade-off (more dispatches = more wrapper
 * overhead) is acceptable because dispatches are at-most weekly.
 */

import { resolve } from "node:path";
import {
  getScoutCategoryLastWalked,
  getScoutLastCalendarWalk,
  getScoutSpendDaily,
  setScoutCategoryLastWalked,
  setScoutLastCalendarWalk,
  setScoutSpendDaily,
} from "../redis/scout.ts";
import { classByName } from "../taxonomy/classes.ts";
import { InvariantViolationError } from "../errors.ts";
// Walk-surface enumeration (FS-I/O leaf) lives in a sibling module (issue
// #2826). `listRuntimeDependencies` / `parseCategorySlugs` are re-exported
// below so existing importers of those symbols from calendar-walk.ts keep
// working unchanged; `listCategories` / `WalkTarget` are imported for
// in-file use only (their re-exports had no external consumers — demoted
// per the #2873 cleanup scan).
import {
  listCategories,
  listRuntimeDependencies,
  parseCategorySlugs,
  type WalkTarget,
} from "./calendar-walk-surface.ts";

// Re-export the externally-consumed walk-surface enumeration so
// `calendar-walk.ts` remains the stable import site for callers
// (interfaceImpact=none, design-concept invariant 3).
export { listRuntimeDependencies, parseCategorySlugs };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECONDS_PER_DAY = 24 * 60 * 60;
const MS_PER_DAY = SECONDS_PER_DAY * 1000;

const SCOUT_ORCH_ROW = classByName("scout_orch");
if (!SCOUT_ORCH_ROW || SCOUT_ORCH_ROW.cooldownSeconds === null) {
  // Boundary/invariant guard (CLAUDE.md): the taxonomy is the single source
  // of truth for class cooldowns — there is deliberately no fallback
  // constant here (epic #1669, slice #1671).
  throw new InvariantViolationError(
    'scout calendar-walk: dispatch-class taxonomy lacks a "scout_orch" ' +
      "signal row with cooldownSeconds (scripts/autopilot/classes.json)",
  );
}

/** Per-class cooldown for `scout_orch`, read from the Dispatch-Class
 * Taxonomy — the same row decide.py derives `SIGNAL_COOLDOWNS` from, so the
 * two runtimes read one file and cannot drift. */
export const CLASS_COOLDOWN_DAYS =
  SCOUT_ORCH_ROW.cooldownSeconds / SECONDS_PER_DAY;

/** Default per-category cooldown — research question #2 default. */
export const CATEGORY_COOLDOWN_DAYS = 30;

/** Steady-state cost slice as a fraction of the daily token budget.
 *
 * Research question #1: ~4% of the $50/day cap (≈ \$2/day). Each scout
 * dispatch consumes ~30–50K tokens; a weekly walk over 10 categories +
 * 2 dep manifests ≈ 12 dispatches / 7 days ≈ 1.7 dispatches/day. Operators
 * override via `state.limits.scout_cost_share` — `decide.py:_select_for_signal`
 * reads it at runtime (issue #532 wired enforcement on top of this constant).
 */
export const SCOUT_DAILY_COST_SHARE = 0.04;

/** TTL on the per-day scout spend mirror key (issue #532). 7 days. */
const SCOUT_SPEND_DAILY_TTL_SECONDS = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Output of the walk decision step. */
export interface WalkPlan {
  /** True when the per-class (`scout_orch`) cooldown has elapsed. */
  classCooledDown: boolean;
  /** Targets eligible for dispatch (per-category cooldown elapsed). */
  eligible: WalkTarget[];
  /** Targets skipped because of per-category cooldown (for diagnostics). */
  skipped: WalkTarget[];
  /**
   * The "now" timestamp the walk was computed against (ISO-8601). Pinned
   * here so callers can record it on dispatch without redundant clock reads.
   */
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Cooldown checks
// ---------------------------------------------------------------------------

/**
 * Pure cooldown predicate over (lastIso, cooldownDays, now). Treats:
 *   - no prior walk (null/empty) → eligible
 *   - unparseable timestamp → eligible (corrupt-record fallback)
 *   - cooldown elapsed → eligible
 */
export function isCooledDown(
  lastIso: string | null,
  cooldownDays: number,
  now: Date = new Date(),
): boolean {
  if (!lastIso) return true;
  const lastMs = Date.parse(lastIso);
  if (!Number.isFinite(lastMs)) return true;
  const ageDays = (now.getTime() - lastMs) / MS_PER_DAY;
  return ageDays >= cooldownDays;
}

/** Read the per-class (`scout_orch`) cooldown state. Network call. */
export async function isClassCooledDown(now: Date = new Date()): Promise<boolean> {
  const last = await getScoutLastCalendarWalk();
  return isCooledDown(last, CLASS_COOLDOWN_DAYS, now);
}

/** Read the per-category cooldown state. Network call. */
export async function isCategoryCooledDown(
  category: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!category) throw new TypeError("isCategoryCooledDown: category required");
  const last = await getScoutCategoryLastWalked(category);
  return isCooledDown(last, CATEGORY_COOLDOWN_DAYS, now);
}

// ---------------------------------------------------------------------------
// Stamp helpers — called by the autopilot AFTER successful dispatch
// ---------------------------------------------------------------------------

/** Record that the weekly walk fired (resets the 7d class cooldown). */
export async function stampClassWalk(now: Date = new Date()): Promise<void> {
  await setScoutLastCalendarWalk(now.toISOString());
}

/** Record that a specific category was walked (resets the 30d category cooldown). */
export async function stampCategoryWalk(
  category: string,
  now: Date = new Date(),
): Promise<void> {
  if (!category) throw new TypeError("stampCategoryWalk: category required");
  await setScoutCategoryLastWalked(category, now.toISOString());
}

// ---------------------------------------------------------------------------
// Cost-cap accounting (issue #532) — wire-up for the daily scout-spend gate
// ---------------------------------------------------------------------------

/** UTC ISO date (YYYY-MM-DD) used to key the daily scout-spend mirror. */
export function scoutSpendDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Record (overwrite) the per-day scout token spend mirror used by the
 * autopilot's cost-cap gate (issue #532).
 *
 * This is intentionally a SET (not INCR): `collect-state.sh` derives the
 * value each turn from the authoritative `hydra:metrics:tokens:by-skill:
 * daily:<DATE>[hydra-tool-scout]` surrogate populated by the existing
 * `/api/metrics/tokens` writer (issue #394). A mirror keeps the gate's
 * read path simple and centralises the TTL contract for the
 * `hydra:scout:spend:<DATE>` key documented in the issue body.
 *
 * 7-day TTL matches the issue's acceptance criterion. The TTL is
 * re-stamped on every write so the key ages out one week after the
 * LAST mirror write, not first creation.
 *
 * @param tokens  total tokens consumed today by `hydra-tool-scout` (>=0)
 * @param now     optional Date for deterministic tests
 */
export async function recordScoutSpend(
  tokens: number,
  now: Date = new Date(),
): Promise<void> {
  const clean = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  const date = scoutSpendDateString(now);
  await setScoutSpendDaily(date, String(clean), SCOUT_SPEND_DAILY_TTL_SECONDS);
}

/**
 * Read the per-day scout token spend mirror for today.
 *
 * Returns 0 when:
 *   - the key is absent (no scout dispatches today, or the mirror has
 *     not been written this turn yet)
 *   - the key's value is non-numeric or negative (corrupt-record fallback)
 *
 * Pure read — never writes. Network call.
 */
export async function getScoutSpendToday(
  now: Date = new Date(),
): Promise<number> {
  const date = scoutSpendDateString(now);
  const raw = await getScoutSpendDaily(date);
  if (raw === null || raw === undefined) return 0;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

// ---------------------------------------------------------------------------
// Top-level walk planner
// ---------------------------------------------------------------------------

/**
 * Build the full walk plan: discover targets, run per-category cooldown
 * filters, return eligible vs skipped lists.
 *
 * The caller (autopilot decide.py via the playbook, or the `/hydra-tool-scout`
 * skill running unattended) is responsible for:
 *   1. Honoring the per-class cooldown (`classCooledDown === false` → bail).
 *   2. Dispatching one scout per eligible target.
 *   3. Calling `stampCategoryWalk(slug)` AFTER each successful dispatch.
 *   4. Calling `stampClassWalk()` once after the full sweep finishes.
 *
 * `hydraRoot` defaults to `process.env.HYDRA_ROOT || ~/hydra` per the
 * codebase convention (mirrors `src/api.ts`).
 */
export async function planWalk(
  hydraRoot: string = resolve(process.env.HYDRA_ROOT || (process.env.HOME ?? ""), "hydra"),
  now: Date = new Date(),
): Promise<WalkPlan> {
  const classCooledDown = await isClassCooledDown(now);
  const [categories, deps] = await Promise.all([
    listCategories(hydraRoot),
    listRuntimeDependencies(hydraRoot),
  ]);
  const all = [...categories, ...deps];
  const eligible: WalkTarget[] = [];
  const skipped: WalkTarget[] = [];

  // Per-category cooldown applies to category-kind targets only. Dependencies
  // don't have a "category cooldown" — they're individually tracked via the
  // per-tool seen-list inside the scout itself. The 90d per-tool cooldown
  // handles dedup for `dep:express` and friends.
  for (const target of all) {
    if (target.kind === "category") {
      const ok = await isCategoryCooledDown(target.slug, now);
      if (ok) eligible.push(target);
      else skipped.push(target);
    } else {
      eligible.push(target);
    }
  }

  return {
    classCooledDown,
    eligible,
    skipped,
    computedAt: now.toISOString(),
  };
}
