/**
 * Money-critical risk classifier for Target (hydra-betting) file paths
 * (issue #1053, parent epic #1052 — "Selectively converge the Target SDLC
 * with the Orchestrator's build-quality machinery").
 *
 * A pure, data-driven classifier that labels a set of changed Target file
 * paths as **money-critical** (provider integrations, execution, staking /
 * bet-math) vs. **safe** (UI, docs, config). It is the keystone dependency
 * every downstream Target gate routes on (independent QA #1055, design-concept
 * artifact #1056, mutation kill-floor #1057).
 *
 * This is the data-driven replacement for the hardcoded
 * "NEVER delete src/lib/providers/ or src/lib/execution/" rule: the protected
 * surface is now a single declared const that is trivial to extend instead of
 * being scattered through prose and prompts.
 *
 * **Explicitly NOT a tier ladder.** Unlike the Orchestrator's monotonic
 * T1→T4 Modification Tier ladder (`src/tier-classifier.ts`), this is a
 * two-level boolean: a Target path either touches money-critical surface or
 * it does not. There is no depth ordering and no third level.
 *
 * Matching rules (deliberately dumb and auditable — no globs, mirroring the
 * Verifier-Core matcher in `src/untouchable.ts`):
 *   1. Normalize a leading "./" away.
 *   2. Directory prefix: an entry ending in "/" matches the directory itself
 *      and anything beneath it.
 *   3. Exact match: an entry without a trailing "/" matches that path only.
 *
 * Note these paths are relative to the **Target** repo (hydra-betting), not
 * the Orchestrator — e.g. `src/lib/providers/` is a hydra-betting path. The
 * Orchestrator merely owns the classifier so the build-quality machinery can
 * route on it.
 */

/**
 * The result of classifying a set of changed Target paths.
 *
 * - `moneyCritical` — true if ANY input path touches money-critical surface.
 * - `matchedPaths` — the subset of input paths that matched (in input order,
 *   de-duplicated). Empty when `moneyCritical` is false.
 */
export interface TargetRiskClassification {
  moneyCritical: boolean;
  matchedPaths: string[];
}

/**
 * Canonical money-critical Target path set — the single source of truth for
 * which hydra-betting paths handle real money. Easy to extend: add a path
 * here (trailing "/" for a directory, no trailing "/" for an exact file).
 *
 * Covers the four money-critical surfaces named in the issue:
 *   - provider integrations (sportsbook / exchange API clients),
 *   - execution (bet placement / order routing),
 *   - staking (stake sizing / bankroll allocation),
 *   - bet-math (odds, edge, probability, settlement math).
 */
export const MONEY_CRITICAL_TARGET_PATHS: readonly string[] = Object.freeze([
  // Provider integrations — the hardcoded rule's first protected directory.
  "src/lib/providers/",
  // Execution — bet placement / order routing; the rule's second directory.
  "src/lib/execution/",
  // Staking — stake sizing / bankroll allocation.
  "src/lib/staking/",
  // Bet-math — odds, edge, probability, and settlement math.
  "src/lib/bet-math/",
]);

/** Normalize a path for matching: drop a single leading "./". */
function normalize(path: string): string {
  return path.replace(/^\.\//, "");
}

/**
 * Returns true if a single Target `path` touches money-critical surface.
 *
 * Matching mirrors `isVerifierCore` in `src/untouchable.ts`: exact match for
 * file entries, prefix match for directory entries (those ending in "/").
 */
export function isMoneyCriticalPath(path: string): boolean {
  if (!path) return false;
  const normalized = normalize(path);
  for (const entry of MONEY_CRITICAL_TARGET_PATHS) {
    if (entry.endsWith("/")) {
      if (normalized === entry.slice(0, -1) || normalized.startsWith(entry)) {
        return true;
      }
    } else if (normalized === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Classify a set of changed Target paths as money-critical or safe.
 *
 * Pure and total: never throws, never touches Redis / network / the
 * filesystem. A non-array, empty, or all-safe input returns
 * `{ moneyCritical: false, matchedPaths: [] }`. Non-string and empty-string
 * entries are ignored. Matched paths preserve input order and are
 * de-duplicated.
 */
export function classifyTargetRisk(paths: readonly string[]): TargetRiskClassification {
  if (!Array.isArray(paths)) {
    return { moneyCritical: false, matchedPaths: [] };
  }
  const matchedPaths: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) continue;
    if (isMoneyCriticalPath(path) && !seen.has(path)) {
      seen.add(path);
      matchedPaths.push(path);
    }
  }
  return { moneyCritical: matchedPaths.length > 0, matchedPaths };
}
