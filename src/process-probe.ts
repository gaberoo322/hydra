/**
 * process-probe.ts — the ONE OS-level process-liveness leaf (issue #3503).
 *
 * Owns a single narrow concept: "is this OS-level process alive, and what does
 * that mean?" — the `kill -0` idiom and its ESRCH/EPERM error contract. Extracted
 * out of `src/worktree-orphan.ts` (which is 400+ lines of worktree-lifecycle
 * management) so callers with no interest in worktrees — the run-lifecycle state
 * machine, the run-projection sweeper, the branch-prune runner, the startup
 * prune — import this OS-probe concept from a conceptually appropriate home
 * rather than reaching cross-domain into a worktree module.
 *
 * Zero I/O beyond the single `process.kill(pid, 0)` signal-probe itself; no
 * Redis, no clock, no `await`. `worktree-orphan.ts` imports DOWN from this leaf
 * (a downward edge, not a cross-domain one) and keeps taking {@link LivePidCheck}
 * as an injectable dep so its impure orchestration stays unit-testable with stubs.
 */

/** Live-PID predicate — true iff the given PID is currently running on this host. */
export type LivePidCheck = (pid: number) => boolean;

/**
 * Canonical host liveness predicate — the ONE `kill -0` probe the orchestrator
 * shares across the startup prune, the branch-prune runner, and the run-
 * projection sweeper (previously three subtly-divergent private copies;
 * consolidated in issue #2816, extracted to this leaf in issue #3503).
 *
 * Returns `true` (LIVE — do NOT reclaim) for:
 *   (a) a pid whose `process.kill(pid, 0)` succeeds (the process exists), OR
 *   (b) `EPERM` — the process exists but we lack permission to signal it, OR
 *   (c) ANY invalid pid: `!Number.isFinite(pid) || pid <= 0`.
 *
 * Returns `false` (DEAD — reclaimable) ONLY when `process.kill(pid, 0)` throws
 * a non-`EPERM` error (`ESRCH` = no such process) for a finite, positive pid.
 *
 * The invalid-pid → LIVE rail is the safety-critical decision (issue #2816):
 * the most dangerous caller (pruneOrphanedTargetWorktrees / branch-prune
 * reclamation) DESTROYS a worktree/lock when this returns `false`. A garbage
 * pid (e.g. a `Number('')`/`Number(undefined)` → `NaN` from a truncated lock
 * body) means UNKNOWN, not KNOWN-DEAD; classifying unknown as dead could delete
 * an active agent's worktree (data loss), while classifying it as live merely
 * defers reclamation one boot (free, self-healing). Invalid == unknown ==
 * conservative-live. The two former unguarded copies (src/index.ts,
 * scripts/ci/branch-prune-runner.ts) omitted this guard and returned `false`
 * on a non-finite pid — that was the latent bug this consolidation fixes.
 */
export function isLivePid(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH = no such process (dead); EPERM = exists but unsignalable (live).
    if (err && err.code === "EPERM") return true;
    return false;
  }
}
