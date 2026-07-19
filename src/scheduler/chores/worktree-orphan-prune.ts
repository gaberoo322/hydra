/**
 * Orphan-worktree prune chore (issue #3136).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`). It reclaims
 * orphaned `/dev/shm/hydra-worktrees/` worktrees in the target workspace so the
 * stale-branch sweep can then delete their pinned `feature/claude-cycle-*`
 * branches — a registered worktree holding a feature branch makes `git branch -D`
 * fail closed (recurrence of #2115 -> #2465).
 *
 * WHY a chore and not just the startup prune: `pruneOrphanedTargetWorktrees` ran
 * ONLY once at boot (`src/index.ts`). A target build that crashes mid-cycle
 * leaves a `/dev/shm` worktree pinning its branch, and because those worktrees
 * are past the 6h age floor only after some hours, the boot-time sweep that ran
 * at startup missed them — they accumulated between restarts and the hourly
 * branch-cleanup chore then failed on every tick (issue #3136 evidence: three
 * stale `feature/claude-cycle-*` worktrees over an ~8h window). Running the SAME
 * reclaim on the hourly housekeeping cadence closes that gap: an orphan that
 * crosses the age floor is now reaped within the hour instead of surviving until
 * the next process restart.
 *
 * This is the SAME orchestration the startup path wires — it delegates to the
 * shared `pruneOrphanedTargetWorktrees` (`src/worktree-orphan.ts`), which owns
 * the never-touch-first liveness discipline (never reap the main tree, the
 * current branch, an out-of-scope dir, a LIVE-agent worktree, or one under the
 * 6h floor). This chore adds no reclaim policy of its own; it only re-runs that
 * policy on a schedule. `src/index.ts` keeps its startup call (fast reclaim on
 * boot); this chore is the periodic backstop, so the two are complementary, not
 * duplicative (the reclaim itself is idempotent — a second run over an
 * already-clean set is a guaranteed no-op).
 *
 * No Redis time-guard: the underlying prune is intrinsically idempotent (it only
 * removes worktrees that classify `delete-orphan-worktree`), so an hourly tick
 * against an all-live / all-young / already-clean set is a silent no-op —
 * mirroring `wiring-liveness` and `stale-inprogress-return`, which also carry no
 * cadence guard.
 *
 * NEVER THROWS (CLAUDE.md fail-loud + host-probe never-throw conventions):
 * `pruneOrphanedTargetWorktrees` is itself best-effort/never-throwing, and this
 * wrapper additionally try/catches so a fault routes to a logged `0` rather than
 * an exception. Combined with `runChore`'s try/catch in the registry, there is no
 * path by which this chore can abort the housekeeping run.
 *
 * Observability (issue #3136 suggested-fix 3): the chore surfaces every triggered
 * cleanup on the `[Housekeeping]` log channel — the per-reclaim lines from the
 * shared pruner plus a single summary line here when `reclaimed > 0`. A clean
 * tick is silent (consistent with the rest of the chore family, which only logs
 * when it did work), so the log signal is exactly "a cleanup was triggered".
 */

import { readFileSync, statSync } from "node:fs";
import { getTargetWorkspace } from "../../target-config.ts";
import { gitExec } from "../../github/git.ts";
import { isLivePid } from "../../process-probe.ts";
import { pruneOrphanedTargetWorktrees } from "../../worktree-orphan.ts";
import { logger } from "../../logger.ts";

/**
 * External touchpoints of the orphan-worktree prune chore, injected so the chore
 * is unit-testable without touching the real host / a live git workspace. In
 * production, every dep defaults to the SAME live wiring `src/index.ts` uses for
 * the startup prune (`github/git::gitExec`, `node:fs`, `isLivePid`, `Date.now`)
 * plus the target-workspace resolver.
 */
export interface WorktreeOrphanPruneDeps {
  /** Resolve the absolute target-workspace path. Defaults to {@link getTargetWorkspace}. */
  getWorkspace?: () => string;
  /** Run a git subcommand in the workspace; matches `github/git::gitExec`. */
  gitExec?: typeof gitExec;
  /** Read a file's text (the worktree lock body). Defaults to `node:fs::readFileSync`. */
  readFileSync?: (path: string, encoding: "utf-8") => string;
  /** Stat a path (the worktree dir mtime). Defaults to `node:fs::statSync`. */
  statSync?: (path: string) => { mtimeMs: number };
  /** Host liveness predicate. Defaults to the consolidated {@link isLivePid}. */
  isLivePid?: (pid: number) => boolean;
  /** Wall-clock source (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injectable prune orchestration — defaults to the shared
   * {@link pruneOrphanedTargetWorktrees}. Exposed so a unit test can assert the
   * chore's wiring + logging without exercising the pruner's full git-porcelain
   * path (that path is covered by `test/worktree-orphan.test.mts`).
   */
  prune?: typeof pruneOrphanedTargetWorktrees;
}

/**
 * Run the orphan-worktree prune chore. Reclaims eligible orphaned `/dev/shm`
 * worktrees in the target workspace and returns the count reclaimed this tick
 * (0 when nothing was eligible / on any fault). Never throws.
 *
 * Returns the reclaimed count so the registry / a test can observe whether the
 * chore did work this invocation.
 */
export async function runWorktreeOrphanPrune(
  deps: WorktreeOrphanPruneDeps = {},
): Promise<number> {
  const getWorkspace = deps.getWorkspace ?? getTargetWorkspace;
  const git = deps.gitExec ?? gitExec;
  const readFile = deps.readFileSync ?? readFileSync;
  const stat = deps.statSync ?? statSync;
  const livePid = deps.isLivePid ?? isLivePid;
  const now = deps.now ?? Date.now;
  const prune = deps.prune ?? pruneOrphanedTargetWorktrees;

  try {
    const workspace = getWorkspace();
    // Same git-exec options the startup path uses (5s timeout, cwd = workspace).
    const gitOpts = { cwd: workspace, timeout: 5000 };
    const reclaimed = await prune(workspace, gitOpts, {
      gitExec: git,
      readFileSync: readFile,
      statSync: stat,
      isLivePid: livePid,
      now,
    });
    if (reclaimed > 0) {
      logger.info(
        { reclaimed },
        "worktree-orphan-prune: reclaimed orphan worktree(s) (issue #3136)",
      );
    }
    return reclaimed;
  } catch (err: any) {
    // Defense in depth: the pruner is already never-throwing, but a never-throw
    // chore must not leak an exception even if a dep does. Fail loud, return 0.
    logger.error({ err }, "worktree-orphan-prune failed");
    return 0;
  }
}
