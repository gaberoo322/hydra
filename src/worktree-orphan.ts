/**
 * worktree-orphan.ts — pure classifier for the startup orphan-worktree prune
 * (issue #2465, recurrence of #2115).
 *
 * Background: a code-writing dispatch into the target project (hydra-betting)
 * runs in a `/dev/shm/hydra-worktrees/` worktree. When that dispatch crashes or
 * exits uncleanly, the worktree dir AND its `.git/worktrees/<id>` registry entry
 * survive with the feature branch still checked out there. The startup
 * `git branch -D` sweep in src/index.ts then fails closed — git refuses to
 * delete a branch a registered worktree still holds — so stale feature branches
 * accumulate over every boot.
 *
 * This module is the `src/`-resident home for the SAME never-touch-first
 * liveness discipline the hydra-branch-prune skill encodes in
 * scripts/ci/branch-prune.ts (issue #911's worktree-orphan GC): a worktree is
 * reclaimed ONLY when it is not the main tree, not held by a live agent PID, and
 * past a 6h age floor. It is deliberately a NARROW slice of that skill's logic —
 * the skill owns the broad multi-pass branch GC; this owns the one boot-time
 * repair the recurrence is observed in. Kept here (not imported from
 * scripts/ci/) because tsconfig `rootDir` is `./src` — src cannot import a
 * scripts/ module — and because this safety logic is orchestrator runtime
 * behaviour, not CI-only tooling.
 *
 * Pure — no fs / network / git — so it unit-tests directly. The I/O (reading
 * lock bodies, statting dir mtimes, running git) lives in the src/index.ts
 * caller. See test/worktree-orphan.test.mts.
 */

/** Minimal worktree shape parsed out of `git worktree list --porcelain`. */
export interface WorktreeRow {
  /** Absolute path to the worktree dir (the "worktree <path>" line). */
  path: string;
  /** Branch checked out in the worktree, or null for a detached HEAD. */
  branch: string | null;
  /** PID of the Claude agent holding the lock file, or null if unlocked. */
  lockedByPid: number | null;
  /**
   * Age of the worktree dir in seconds (caller-computed from the dir mtime), or
   * null if the caller could not stat it. Null = unknown = conservative skip
   * (never reap a dir we know nothing about).
   */
  ageSeconds?: number | null;
}

/**
 * Default minimum age (seconds) before a worktree is reap-eligible. An
 * in-flight dispatch that was just created but has not yet written its lock file
 * looks identical to a crashed orphan; the age floor protects it. 6h comfortably
 * exceeds the subagent wall-clock cap, so any worktree older than this floor
 * whose PID is also dead is unambiguously abandoned. Matches
 * scripts/ci/branch-prune.ts::DEFAULT_WORKTREE_MIN_AGE_SECONDS.
 */
export const DEFAULT_WORKTREE_MIN_AGE_SECONDS = 6 * 60 * 60;

/**
 * Parse the `(pid <N>)` token out of a worktree lock-file body.
 *
 * The Claude harness writes lock files like `claude agent agent-abc (pid 12345)`.
 * Parse `(pid` as a field token, not the bare word `pid` — they collide with
 * random English in a lock note. Returns null if no `(pid <N>)` token is present.
 */
export function parseLockPid(lockBody: string | null | undefined): number | null {
  if (!lockBody) return null;
  const m = lockBody.match(/\(pid\s+(\d+)\)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Parse `git worktree list --porcelain` output into structured rows.
 *
 * The porcelain format emits a blank-line-delimited stanza per worktree:
 *   worktree /path/to/wt
 *   HEAD <sha>
 *   branch refs/heads/<name>
 * (Detached worktrees emit `detached` instead of `branch`.)
 *
 * `locks` maps worktree-path → lock-file body; when present the body is run
 * through {@link parseLockPid} to populate `lockedByPid`.
 */
export function parseWorktreeList(
  porcelain: string,
  locks: ReadonlyMap<string, string> = new Map(),
): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  if (!porcelain) return rows;

  const stanzas = porcelain.split(/\n\s*\n/);
  for (const stanza of stanzas) {
    if (!stanza.trim()) continue;

    let path: string | null = null;
    let branch: string | null = null;
    for (const raw of stanza.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      }
    }

    if (!path) continue;
    const lockBody = locks.get(path) ?? null;
    rows.push({ path, branch, lockedByPid: parseLockPid(lockBody) });
  }
  return rows;
}

/** Live-PID predicate — true iff the given PID is currently running on this host. */
export type LivePidCheck = (pid: number) => boolean;

type OrphanAction =
  | "delete-orphan-worktree"
  | "skip-main-worktree"
  | "skip-current-worktree"
  | "skip-out-of-scope"
  | "skip-live-agent"
  | "skip-too-young";

export interface OrphanResult {
  action: OrphanAction;
  reason: string;
}

export interface OrphanContext {
  /** Absolute path of the MAIN working tree — never reclaim it. */
  mainWorktreePath: string;
  /** Branch the orchestrator is currently sitting on — its worktree is preserved. */
  currentBranch: string;
  /** Live-PID predicate — true iff the given PID is currently running. */
  isLivePid: LivePidCheck;
  /** Minimum worktree age (seconds) before it is reap-eligible. */
  minAgeSeconds: number;
  /**
   * Optional path prefix the destructive action is scoped to (e.g.
   * `/dev/shm/hydra-worktrees/`). A worktree outside it classifies
   * `skip-out-of-scope` so the broader hydra-branch-prune skill owns it. If
   * omitted, every worktree is in scope.
   */
  scopePrefix?: string;
}

/**
 * Classify a single worktree row for the startup orphan prune. Pure — no I/O.
 *
 * Decision order (highest priority first), never-touch-first:
 *  1. Worktree IS the main working tree               → skip-main-worktree
 *  2. Worktree's branch is the current branch         → skip-current-worktree
 *  3. Worktree is outside the scoped path prefix      → skip-out-of-scope
 *  4. Lock-file PID is a live process                 → skip-live-agent
 *  5. Worktree is younger than the age floor (or age unknown) → skip-too-young
 *  6. Otherwise (dead/no PID, in scope, old)          → delete-orphan-worktree
 *
 * Age is the LAST gate before deletion: a freshly-created worktree held by a
 * live agent surfaces as skip-live-agent (the precise reason), not too-young.
 */
export function classifyOrphanWorktree(wt: WorktreeRow, ctx: OrphanContext): OrphanResult {
  if (wt.path === ctx.mainWorktreePath) {
    return { action: "skip-main-worktree", reason: `${wt.path} is the main working tree — never reclaim.` };
  }
  if (wt.branch !== null && wt.branch === ctx.currentBranch) {
    return {
      action: "skip-current-worktree",
      reason: `${wt.path} has the current branch ${wt.branch} checked out — refusing to remove.`,
    };
  }
  if (ctx.scopePrefix && !wt.path.startsWith(ctx.scopePrefix)) {
    return {
      action: "skip-out-of-scope",
      reason: `${wt.path} is outside ${ctx.scopePrefix} — left for the hydra-branch-prune skill's broader sweep.`,
    };
  }
  if (wt.lockedByPid !== null && ctx.isLivePid(wt.lockedByPid)) {
    return {
      action: "skip-live-agent",
      reason: `${wt.path} is held by live PID ${wt.lockedByPid} — leave for next run.`,
    };
  }
  if (wt.ageSeconds === null || wt.ageSeconds === undefined || wt.ageSeconds < ctx.minAgeSeconds) {
    const ageNote = wt.ageSeconds === null || wt.ageSeconds === undefined ? "unknown age" : `${wt.ageSeconds}s old`;
    return {
      action: "skip-too-young",
      reason: `${wt.path} is ${ageNote}, under the ${ctx.minAgeSeconds}s floor — defer in case it is an in-flight dispatch.`,
    };
  }
  return {
    action: "delete-orphan-worktree",
    reason:
      `${wt.path} is an orphan (` +
      `${wt.lockedByPid !== null ? `dead PID ${wt.lockedByPid}` : "no live agent"}, ` +
      `${wt.branch ? `branch ${wt.branch}` : "detached"}, ${wt.ageSeconds}s old` +
      `) — remove worktree${wt.branch ? `, then its branch is reclaimable` : ""}.`,
  };
}
