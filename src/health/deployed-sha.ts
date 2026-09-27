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
import { logger } from "../logger.ts";

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

// Sibling cache for the origin/master probe (issue #4008). Unlike
// deployedShaCache, this one caches a null RESULT too: `git ls-remote origin`
// is a network round-trip, so a failure must be TTL-cached or every /health
// hit re-pays the timeout — the deployedSha local-read failure mode is cheap
// enough to retry per-request, the remote one is not. `at: -Infinity` makes
// the very first read an unconditional cache miss.
let remoteMasterShaCache: { sha: string | null; at: number } = { sha: null, at: -Infinity };

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
    logger.error(
      { code: result.code, stderr: result.stderr.slice(0, 200) },
      "[API] /health deployedSha unavailable",
    );
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

/**
 * Read origin/master's HEAD SHA (`git ls-remote origin master`), cached for
 * {@link DEPLOYED_SHA_TTL_MS} (issue #4008 — the /health page's deploy-DRIFT
 * axis).
 *
 * The sibling probe to {@link getDeployedSha}, with the same contract
 * (design-concept 2880e735, invariant 4): NEVER throws and NEVER blocks
 * /health — a network/git failure (offline host, credential prompt, no
 * remote) degrades to null, and the client renders the drift axis UNKNOWN
 * rather than a confident in-sync/drifted claim. The route ships the RAW SHA;
 * drift itself is computed client-side from the two decomposable inputs
 * (ADR-0034 §5 rule 3 — never a server-side derived boolean).
 *
 * A null result is TTL-cached like a success (see remoteMasterShaCache) so an
 * unreachable origin costs one timeout per cache window, not one per hit.
 *
 * @param deps injectable clock + git seam (both defaulted; production passes none).
 */
export async function getRemoteMasterSha(deps: DeployedShaDeps = {}): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const gitExec = deps.gitExec ?? defaultGitExec;

  const at = now();
  if (at - remoteMasterShaCache.at < DEPLOYED_SHA_TTL_MS) {
    return remoteMasterShaCache.sha;
  }
  // `git ls-remote origin master` prints `<sha>\trefs/heads/master`; the SHA is
  // the first whitespace-delimited field (empty output → null, not a crash).
  const result = await gitExec(["-C", HYDRA_ROOT, "ls-remote", "origin", "master"], { timeout: 5000 });
  let sha: string | null = null;
  if (isGhFailure(result)) {
    // Log once-per-cache-window so a misconfigured/offline host is visible
    // without spamming, then degrade to null (UNKNOWN on the drift axis).
    logger.error(
      { code: result.code, stderr: result.stderr.slice(0, 200) },
      "[API] /health originMasterSha unavailable",
    );
  } else {
    sha = result.data.stdout.trim().split(/\s+/)[0] || null;
  }
  remoteMasterShaCache = { sha, at };
  return sha;
}

// ---------------------------------------------------------------------------
// Deploy drift — sustained-drift grace (issue #4623, ADR-0034 §8.1 rank 0)
// ---------------------------------------------------------------------------

/**
 * How long (seconds) the deployed SHA must continuously differ from
 * origin/master before the drift counts as a "machine stopped" line on the
 * attention feed. This is the single source of truth for the value
 * `scripts/hydra-watchdog.sh` defaults `HYDRA_WATCHDOG_AUTODEPLOY_GRACE_SECONDS`
 * to — `test/attention-buckets.test.mts` pins the script default to this
 * constant. Deliberately NOT env-overridable: the orchestrator unit and the
 * watchdog timer run with separate environments, so an env read here would
 * silently diverge rather than share one value.
 */
export const DEPLOY_DRIFT_GRACE_SECONDS = 600;

/**
 * Pure drift first-seen transition — the in-process twin of the watchdog's
 * `hydra-watchdog-drift-since` marker file, with identical semantics:
 *
 * - either SHA unknown (null) → the memo is left untouched (neither set nor
 *   cleared; the caller reports the read as UNKNOWN);
 * - SHAs equal → cleared (null);
 * - SHAs differ → kept if already set (even when origin/master advanced
 *   again), otherwise set to `nowMs`.
 */
export function nextDriftFirstSeen(
  prevFirstSeenMs: number | null,
  deployedSha: string | null,
  originMasterSha: string | null,
  nowMs: number,
): number | null {
  if (deployedSha === null || originMasterSha === null) return prevFirstSeenMs;
  if (deployedSha === originMasterSha) return null;
  return prevFirstSeenMs ?? nowMs;
}

// Process-lifetime drift first-seen memo (mirrors deployedShaCache ownership).
let driftFirstSeenMs: number | null = null;

/** Test hook: clear the drift first-seen memo (mirrors resetDeployedShaCache). */
export function resetDeployDriftMemo(): void {
  driftFirstSeenMs = null;
}

/** One observation of deploy drift, as the attention feed consumes it. */
export interface DeployDriftReading {
  deployedSha: string | null;
  originMasterSha: string | null;
  /** Epoch ms the current drift episode was first observed, or null. */
  firstSeenMs: number | null;
  /** Seconds the drift has been continuously observed, or null when not drifting. */
  driftSeconds: number | null;
  /** True iff both SHAs are known, differ, and drift ≥ DEPLOY_DRIFT_GRACE_SECONDS. */
  active: boolean;
}

/**
 * Read both SHAs (through the cached probes above), advance the drift memo via
 * {@link nextDriftFirstSeen}, and report whether the drift is sustained past
 * {@link DEPLOY_DRIFT_GRACE_SECONDS}. Never throws (both probes never throw);
 * a null SHA leaves `active` false and the caller renders UNKNOWN.
 */
export async function readDeployDrift(deps: DeployedShaDeps = {}): Promise<DeployDriftReading> {
  const now = deps.now ?? Date.now;
  const [deployedSha, originMasterSha] = await Promise.all([
    getDeployedSha(deps),
    getRemoteMasterSha(deps),
  ]);
  const nowMs = now();
  driftFirstSeenMs = nextDriftFirstSeen(driftFirstSeenMs, deployedSha, originMasterSha, nowMs);
  const drifting =
    deployedSha !== null && originMasterSha !== null && deployedSha !== originMasterSha;
  const driftSeconds =
    drifting && driftFirstSeenMs !== null
      ? Math.max(0, Math.floor((nowMs - driftFirstSeenMs) / 1000))
      : null;
  return {
    deployedSha,
    originMasterSha,
    firstSeenMs: drifting ? driftFirstSeenMs : null,
    driftSeconds,
    active: driftSeconds !== null && driftSeconds >= DEPLOY_DRIFT_GRACE_SECONDS,
  };
}
