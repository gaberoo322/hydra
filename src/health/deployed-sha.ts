// Deployed-SHA probe — the health-domain leaf that answers "what commit is the
// orchestrator running from?" (issue #2605 — extracted from src/api/health.ts).
//
// WHY THIS FILE EXISTS
//   Issue #734 (deploy-drift backstop) added an advisory read of the SHA the
//   orchestrator is running from, so the watchdog (and operators) can compare it
//   against origin/master HEAD. It lived inline in the /api/health route factory
//   as the LAST piece of module-level mutable state remaining in the health
//   surface — the only stateful health module and the only I/O concern that was
//   never given a seam. Every other health I/O concern was already extracted into
//   this src/health/ family: diagnostics.ts (pure assessment), rules.ts, probe.ts
//   (ServiceProbe Adapter Seam), fan-out.ts (probe enumeration), wire.ts (response
//   projection), wol.ts (WakeGate). This leaf finishes the domain extraction: the
//   route file becomes stateless, and "how does the orchestrator know what commit
//   it is running from, cached?" gets a single named home alongside the other
//   probe concerns.
//
// SINGLETON LIFECYCLE (mirrors src/health/wol.ts getWolGates/resetWolGates, #2570)
//   The per-2-minute watchdog poll plus dashboard traffic is a hot path, so the
//   60s TTL cache is a genuine performance concern — it must be a process-lifetime
//   singleton, not a caller-owned argument threaded through the route (which would
//   push state back onto the route and diverge from the wol.ts precedent). The
//   module owns the cache; resetDeployedShaCache() is the test hook that clears it
//   so a test gets a deterministic cold start.
//
// INJECTABLE DEPS (mirrors src/health/fan-out.ts CollectProbeDeps, #2089)
//   getDeployedSha({ now?, gitExec? }) takes a defaulted deps bag so a test can
//   pin the SHA (stub gitExec) and advance the clock past the TTL (stub now) to
//   exercise cache-hit vs cache-miss refetch deterministically — without spawning
//   a real git process.
import { resolve } from "node:path";

import { gitExec as defaultGitExec } from "../github/git.ts";
import { isGhFailure } from "../github/exec.ts";

// $HYDRA_ROOT is the checkout deploy.sh leaves on master HEAD; the SHA read is a
// `git rev-parse HEAD` against it.
const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");

/**
 * The deployed-SHA cache TTL (ms). Preserved 1:1 from the former inline value in
 * src/api/health.ts — the per-2-minute watchdog poll plus dashboard traffic must
 * not fork a git process on every /health hit.
 */
export const DEPLOYED_SHA_TTL_MS = 60_000;

/**
 * Injectable dependencies for {@link getDeployedSha}. Both default so production
 * callers pass nothing; a test substitutes them to pin behavior without a real
 * git checkout or wall clock. Mirrors CollectProbeDeps in src/health/fan-out.ts.
 */
export interface DeployedShaDeps {
  /** Clock source (default `Date.now`) — advance past the TTL to force a refetch. */
  now?: () => number;
  /** The git exec seam (default the #899 gitExec adapter) — stub to pin the SHA. */
  gitExec?: typeof defaultGitExec;
}

// Process-lifetime cache singleton. Owned by this module (not threaded through
// the route) so the watchdog hot path shares one cache across requests.
let deployedShaCache: { sha: string | null; at: number } = { sha: null, at: 0 };

/**
 * Read the SHA the orchestrator is running from (`git rev-parse HEAD` against
 * $HYDRA_ROOT), cached for {@link DEPLOYED_SHA_TTL_MS}.
 *
 * The read routes through the gitExec GitHub-CLI Adapter seam (#899), which NEVER
 * throws — a failure arm (not a git checkout, git missing, or timeout) degrades to
 * null and is logged once per cache window (not once per /health hit), then the
 * field is simply omitted from the response. This is a pure read that must never
 * throw and never block /health (CLAUDE.md never-throw-from-health-path rule).
 *
 * @param deps injectable clock + git seam (both defaulted; production passes none).
 */
export async function getDeployedSha(deps: DeployedShaDeps = {}): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const gitExec = deps.gitExec ?? defaultGitExec;

  const at = now();
  if (deployedShaCache.sha !== null && at - deployedShaCache.at < DEPLOYED_SHA_TTL_MS) {
    return deployedShaCache.sha;
  }
  // Routes the `git rev-parse HEAD` through the GitHub CLI Adapter seam (issue
  // #899). The seam never throws; a failure arm (not a git checkout, git
  // missing, or timeout) degrades to null — the field is advisory and must
  // never block /health.
  const result = await gitExec(["-C", HYDRA_ROOT, "rev-parse", "HEAD"], { timeout: 3000 });
  if (isGhFailure(result)) {
    // Log once-per-cache-window so a misconfigured host is visible without
    // spamming, then omit the field.
    console.error(`[API] /health deployedSha unavailable (${result.code}): ${result.stderr.slice(0, 200)}`);
    deployedShaCache = { sha: null, at };
    return null;
  }
  const sha = result.data.stdout.trim() || null;
  deployedShaCache = { sha, at };
  return sha;
}

/**
 * Test hook: drop the memoized deployed-SHA cache so the NEXT
 * {@link getDeployedSha} call re-reads from git. Mirrors resetWolGates() in
 * src/health/wol.ts — this repo has no module-reset harness, so a leaf that owns
 * a process-lifetime singleton exports an explicit reset for deterministic tests.
 */
export function resetDeployedShaCache(): void {
  deployedShaCache = { sha: null, at: 0 };
}
