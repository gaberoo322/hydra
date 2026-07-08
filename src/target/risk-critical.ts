/**
 * Risk-critical Target file-path classifier (epic #3014, ADR-0026 — the Target
 * Manifest generalizes the prior betting-specific risk flag to a target-agnostic
 * "risk-critical" flag; the betting vocabulary now lives only in the target repo).
 *
 * A pure, data-driven classifier that labels a set of changed Target file paths
 * as **risk-critical** (in the target's declared risk surface) vs. **safe** (UI,
 * docs, config). It is the keystone dependency every downstream Target gate
 * routes on (independent QA, design-concept artifact, mutation kill-floor).
 *
 * # The risk surface is an ARGUMENT, not a hardcoded const (ADR-0026 decision 3)
 *
 * The prior frozen path const held betting paths in orchestrator `src/` — a
 * latent ADR-0013 defect ("no target vocabulary in src/"). It is deleted.
 * `classifyRisk(paths, surface, appSubdir)` now takes the risk surface (and the
 * app subdir) as arguments, sourced from the target's
 * `.hydra/manifest.json` (`riskCritical.surface` + `verify.appSubdir`). Betting
 * is "just another target": it ships a manifest declaring its six risk globs; no
 * betting data lives here.
 *
 * **Explicitly NOT a tier ladder.** Unlike the Orchestrator's monotonic T1→T4
 * Modification Tier ladder (`src/tier-classifier.ts`), this is a two-level
 * boolean: a Target path is either in the risk surface or it is not. There is no
 * depth ordering and no third level (ADR-0026 decision 4).
 *
 * Matching rules (deliberately dumb and auditable — no globs, mirroring the
 * Verifier-Core matcher in `src/untouchable.ts`):
 *   1. Normalize a leading "./" away.
 *   2. Normalize a leading `<appSubdir>/` away (ADR-0026, replacing the prior
 *      hardcoded `web/` strip). A target whose source tree is nested in a subdir
 *      (e.g. hydra-betting's `web/`) reports diff paths rooted at that subdir
 *      (`web/src/lib/providers/...`); stripping the declared `appSubdir` prefix
 *      lets the bare `src/lib/...` surface entries match the real layout. A
 *      repo-root target declares `appSubdir: ""`, so nothing is stripped.
 *   3. Directory prefix: a surface entry ending in "/" matches the directory
 *      itself and anything beneath it.
 *   4. Exact match: a surface entry without a trailing "/" matches that path only.
 *
 * These surface paths are relative to the **Target** repo, `appSubdir`-stripped.
 * The Orchestrator owns the classifier so the build-quality machinery can route
 * on it; the surface DATA lives in the target repo's manifest.
 */

/**
 * A target's risk surface: the list of path entries (from `.hydra/manifest.json`
 * `riskCritical.surface`) that define which paths are risk-critical. A trailing
 * "/" makes an entry a directory prefix; no trailing "/" makes it an exact file.
 */
export type RiskSurface = readonly string[];

/**
 * The result of classifying a set of changed Target paths.
 *
 * - `riskCritical` — true if ANY input path touches the target's risk surface.
 * - `matchedPaths` — the subset of input paths that matched (in input order,
 *   de-duplicated). Empty when `riskCritical` is false.
 */
export interface TargetRiskClassification {
  riskCritical: boolean;
  matchedPaths: string[];
}

/**
 * Normalize a path for matching: drop a single leading "./", then a single
 * leading `<appSubdir>/` (ADR-0026, replacing the prior hardcoded `web/` strip).
 *
 * A target whose source lives in a subdir (e.g. hydra-betting's `web/`) reports
 * diff paths like `web/src/lib/providers/...`; stripping the declared `appSubdir`
 * prefix lets the bare `src/lib/...` surface entries match. `appSubdir === ""`
 * (a repo-root target) strips nothing. A path that is NOT under `appSubdir` is
 * left unchanged, so both the nested and the bare layout match.
 */
function normalize(path: string, appSubdir: string): string {
  const withoutDotSlash = path.replace(/^\.\//, "");
  if (!appSubdir) return withoutDotSlash;
  // Strip a single leading "<appSubdir>/" prefix (exactly once).
  const prefix = appSubdir.endsWith("/") ? appSubdir : `${appSubdir}/`;
  return withoutDotSlash.startsWith(prefix)
    ? withoutDotSlash.slice(prefix.length)
    : withoutDotSlash;
}

/**
 * Returns true if a single Target `path` is in the target's risk `surface`.
 *
 * Matching mirrors `isVerifierCore` in `src/untouchable.ts`: exact match for
 * file entries, prefix match for directory entries (those ending in "/"). The
 * `surface` and `appSubdir` come from the target's manifest; `appSubdir`
 * defaults to `""` (repo-root, strip nothing).
 */
export function isRiskCriticalPath(
  path: string,
  surface: RiskSurface,
  appSubdir = "",
): boolean {
  if (!path) return false;
  if (!Array.isArray(surface)) return false;
  const normalized = normalize(path, appSubdir);
  for (const entry of surface) {
    if (typeof entry !== "string" || entry.length === 0) continue;
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
 * Classify a set of changed Target paths as risk-critical or safe against the
 * target's declared risk `surface`.
 *
 * Pure and total: never throws, never touches Redis / network / the filesystem.
 * A non-array, empty, or all-safe input returns
 * `{ riskCritical: false, matchedPaths: [] }`. Non-string and empty-string
 * entries are ignored. Matched paths preserve input order and are
 * de-duplicated.
 *
 * @param paths     the changed Target file paths (may be `appSubdir`-rooted).
 * @param surface   the target's risk surface (manifest `riskCritical.surface`).
 * @param appSubdir the target's app subdir (manifest `verify.appSubdir`);
 *                  defaults to `""` (repo-root, strip nothing).
 */
export function classifyRisk(
  paths: readonly string[],
  surface: RiskSurface,
  appSubdir = "",
): TargetRiskClassification {
  if (!Array.isArray(paths)) {
    return { riskCritical: false, matchedPaths: [] };
  }
  const matchedPaths: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) continue;
    if (isRiskCriticalPath(path, surface, appSubdir) && !seen.has(path)) {
      seen.add(path);
      matchedPaths.push(path);
    }
  }
  return { riskCritical: matchedPaths.length > 0, matchedPaths };
}
