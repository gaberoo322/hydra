// Deployed-version probe — the health-domain leaf that answers "what semver tag
// is the orchestrator running from?" (issue #3677, epic #3676 alpha).
//
// WHY THIS FILE EXISTS
//   #3677 (alpha of the dashboard-version epic #3676) stamps an annotated semver
//   git tag on the deployed SHA at deploy time (scripts/deploy.sh, after the
//   health gate). This leaf gives the /api/health surface an IMMEDIATE consumer
//   of that tag: "what version is prod running?" — the cheap counterpart to the
//   richer GET /api/versions read (#3680) that depends on this ticket. It is a
//   1:1 structural MIRROR of its sibling src/health/deployed-sha.ts (the read
//   path #734/#2605 established): same singleton 60s cache, same injectable
//   {now, gitExec} deps bag, same never-throw degrade-to-null contract, routed
//   through the same gitExec GitHub-CLI Adapter seam (#896/#899).
//
// SINGLETON LIFECYCLE (mirrors src/health/deployed-sha.ts, itself mirroring wol.ts)
//   The per-2-minute watchdog poll plus dashboard traffic is a hot path, so the
//   60s TTL cache is a genuine performance concern — it must be a process-lifetime
//   singleton, not a caller-owned argument threaded through the route. The module
//   owns the cache; resetDeployedVersionCache() is the test hook that clears it
//   so a test gets a deterministic cold start.
//
// INJECTABLE DEPS (mirrors src/health/deployed-sha.ts DeployedShaDeps)
//   getDeployedVersion({ now?, gitExec? }) takes a defaulted deps bag so a test
//   can pin the tag (stub gitExec) and advance the clock past the TTL (stub now)
//   to exercise cache-hit vs cache-miss refetch deterministically — without
//   spawning a real git process.
import { resolve } from "node:path";

import { gitExec as defaultGitExec } from "../github/git.ts";
import { isGhFailure } from "../github/exec.ts";
import { logger } from "../logger.ts";

// $HYDRA_ROOT is the checkout deploy.sh leaves on master HEAD; the tag read is a
// `git describe --tags --abbrev=0` against it.
const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");

/**
 * The deployed-version cache TTL (ms). Mirrors DEPLOYED_SHA_TTL_MS — the
 * per-2-minute watchdog poll plus dashboard traffic must not fork a git process
 * on every /health hit.
 */
export const DEPLOYED_VERSION_TTL_MS = 60_000;

/**
 * Injectable dependencies for {@link getDeployedVersion}. Both default so
 * production callers pass nothing; a test substitutes them to pin behavior
 * without a real git checkout or wall clock. Mirrors DeployedShaDeps in
 * src/health/deployed-sha.ts.
 */
export interface DeployedVersionDeps {
  /** Clock source (default `Date.now`) — advance past the TTL to force a refetch. */
  now?: () => number;
  /** The git exec seam (default the #899 gitExec adapter) — stub to pin the tag. */
  gitExec?: typeof defaultGitExec;
}

// Process-lifetime cache singleton. Owned by this module (not threaded through
// the route) so the watchdog hot path shares one cache across requests.
let deployedVersionCache: { version: string | null; at: number } = { version: null, at: 0 };

/**
 * Read the semver tag the orchestrator is running from (`git describe --tags
 * --abbrev=0` against $HYDRA_ROOT), cached for {@link DEPLOYED_VERSION_TTL_MS}.
 *
 * The read routes through the gitExec GitHub-CLI Adapter seam (#899), which
 * NEVER throws — a failure arm (untagged repo, git missing, or timeout) degrades
 * to null and is logged once per cache window (not once per /health hit), then
 * the field is simply omitted from the response. `git describe --tags` exits
 * non-zero on a repo with no tags, so an untagged repo (fresh checkout, before
 * the first deploy tag) naturally degrades to null. This is a pure read that
 * must never throw and never block /health (CLAUDE.md never-throw-from-health-
 * path rule).
 *
 * @param deps injectable clock + git seam (both defaulted; production passes none).
 */
export async function getDeployedVersion(deps: DeployedVersionDeps = {}): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const gitExec = deps.gitExec ?? defaultGitExec;

  const at = now();
  if (deployedVersionCache.version !== null && at - deployedVersionCache.at < DEPLOYED_VERSION_TTL_MS) {
    return deployedVersionCache.version;
  }
  // Routes `git describe --tags --abbrev=0` through the GitHub CLI Adapter seam
  // (issue #899). The seam never throws; a failure arm (untagged repo, git
  // missing, or timeout) degrades to null — the field is advisory and must
  // never block /health.
  const result = await gitExec(
    ["-C", HYDRA_ROOT, "describe", "--tags", "--abbrev=0"],
    { timeout: 3000 },
  );
  if (isGhFailure(result)) {
    // Log once-per-cache-window so a misconfigured host is visible without
    // spamming, then omit the field. An untagged repo (no tags yet) lands here
    // too, which is the expected pre-first-deploy state — hence a soft null.
    logger.error(
      { code: result.code, stderr: result.stderr.slice(0, 200) },
      "[API] /health deployedVersion unavailable",
    );
    deployedVersionCache = { version: null, at };
    return null;
  }
  const version = result.data.stdout.trim() || null;
  deployedVersionCache = { version, at };
  return version;
}

/**
 * Test hook: drop the memoized deployed-version cache so the NEXT
 * {@link getDeployedVersion} call re-reads from git. Mirrors
 * resetDeployedShaCache() in src/health/deployed-sha.ts — this repo has no
 * module-reset harness, so a leaf that owns a process-lifetime singleton exports
 * an explicit reset for deterministic tests.
 */
export function resetDeployedVersionCache(): void {
  deployedVersionCache = { version: null, at: 0 };
}
