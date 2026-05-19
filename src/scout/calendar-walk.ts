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
 *   1. Per-class (`scout_orch`): 7 days. Owned by `decide.py`'s
 *      `SIGNAL_COOLDOWNS` — this module assumes the class-level cooldown
 *      has already been honored by the caller and does not re-check it.
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

import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { redisKeys } from "../redis-keys.ts";
import { getString, setString } from "../redis/kv.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Per-class cooldown for `scout_orch` (mirrors `decide.py:SIGNAL_COOLDOWNS`). */
export const CLASS_COOLDOWN_DAYS = 7;

/** Default per-category cooldown — research question #2 default. */
export const CATEGORY_COOLDOWN_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Steady-state cost slice as a fraction of the daily token budget.
 *
 * Research question #1: ~4% of the $50/day cap (≈ \$2/day). Each scout
 * dispatch consumes ~30–50K tokens; a weekly walk over 10 categories +
 * 2 dep manifests ≈ 12 dispatches / 7 days ≈ 1.7 dispatches/day. Operators
 * override via `state.limits.scout_cost_share` (autopilot reads this in
 * Phase B follow-up — the constant here is the documented default).
 */
export const SCOUT_DAILY_COST_SHARE = 0.04;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single target the walk surfaces — either a category slug or a dep name. */
export interface WalkTarget {
  /** Stable identifier the dispatch uses (category slug OR `dep:<name>`). */
  slug: string;
  /** Whether this comes from `docs/ai-leverage-categories.md` or `package.json`. */
  kind: "category" | "dependency";
  /** Free-text source label for diagnostics (file path or section). */
  source: string;
}

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
// Discovery: build the target list from disk
// ---------------------------------------------------------------------------

/**
 * Parse the orchestrator + dashboard `package.json` runtime deps. Excludes
 * `devDependencies` — those don't ship in the running process and aren't
 * load-bearing for AI-agent leverage. Pure async I/O; no Redis.
 */
export async function listRuntimeDependencies(
  hydraRoot: string,
): Promise<WalkTarget[]> {
  const out: WalkTarget[] = [];

  async function readDeps(path: string, sourceLabel: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf-8");
    } catch (err) {
      // Best-effort — log + skip rather than throw. A missing manifest is a
      // diagnostic, not a fatal walk error.
      console.error(`calendar-walk: failed to read ${path}:`, err);
      return;
    }
    let parsed: { dependencies?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`calendar-walk: failed to parse ${path}:`, err);
      return;
    }
    const deps = parsed.dependencies ?? {};
    for (const name of Object.keys(deps).sort()) {
      out.push({
        slug: `dep:${name}`,
        kind: "dependency",
        source: sourceLabel,
      });
    }
  }

  await readDeps(resolve(hydraRoot, "package.json"), "package.json");
  await readDeps(
    resolve(hydraRoot, "dashboard", "package.json"),
    "dashboard/package.json",
  );
  return out;
}

/**
 * Parse `docs/ai-leverage-categories.md` and extract each H2 heading as a
 * category slug. Format: `## <N>. <slug>` (matches the Phase A doc).
 *
 * Pure parser — no Redis, no network. Tests pass a fixture instead of the
 * real file to pin behaviour without coupling to doc edits.
 */
export function parseCategorySlugs(markdown: string): WalkTarget[] {
  const out: WalkTarget[] = [];
  const seen = new Set<string>();
  // Match lines of the form `## 1. typed-schemas` or `## typed-schemas`
  // (the leading number-and-dot is optional so a future doc edit that drops
  // the numbering still works).
  const re = /^##\s+(?:\d+\.\s+)?([a-z0-9][a-z0-9-]*)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const slug = m[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      kind: "category",
      source: "docs/ai-leverage-categories.md",
    });
  }
  return out;
}

/**
 * Convenience: read + parse `docs/ai-leverage-categories.md` from disk.
 */
export async function listCategories(hydraRoot: string): Promise<WalkTarget[]> {
  const path = resolve(hydraRoot, "docs", "ai-leverage-categories.md");
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (err) {
    console.error(`calendar-walk: failed to read ${path}:`, err);
    return [];
  }
  return parseCategorySlugs(raw);
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
  const last = await getString(redisKeys.scoutLastCalendarWalk());
  return isCooledDown(last, CLASS_COOLDOWN_DAYS, now);
}

/** Read the per-category cooldown state. Network call. */
export async function isCategoryCooledDown(
  category: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!category) throw new TypeError("isCategoryCooledDown: category required");
  const last = await getString(redisKeys.scoutCategoryLastWalked(category));
  return isCooledDown(last, CATEGORY_COOLDOWN_DAYS, now);
}

// ---------------------------------------------------------------------------
// Stamp helpers — called by the autopilot AFTER successful dispatch
// ---------------------------------------------------------------------------

/** Record that the weekly walk fired (resets the 7d class cooldown). */
export async function stampClassWalk(now: Date = new Date()): Promise<void> {
  await setString(redisKeys.scoutLastCalendarWalk(), now.toISOString());
}

/** Record that a specific category was walked (resets the 30d category cooldown). */
export async function stampCategoryWalk(
  category: string,
  now: Date = new Date(),
): Promise<void> {
  if (!category) throw new TypeError("stampCategoryWalk: category required");
  await setString(
    redisKeys.scoutCategoryLastWalked(category),
    now.toISOString(),
  );
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
