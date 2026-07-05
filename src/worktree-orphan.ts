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
 * Purity boundary: the CLASSIFIER region (through classifyOrphanWorktree) is
 * pure — no fs / network / git — so it unit-tests directly. Below the marked
 * "IMPURE ORCHESTRATION" divider lives pruneOrphanedTargetWorktrees, which DOES
 * do I/O (reading lock bodies, statting dir mtimes, running git); it is kept
 * testable-without-real-I/O by taking every side-effecting dependency through
 * an injected deps bag ({ gitExec, readFileSync, statSync, isLivePid, now }),
 * so the module still unit-tests with stubs and never touches the real host in
 * a test. See test/worktree-orphan.test.mts.
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
type LivePidCheck = (pid: number) => boolean;

/**
 * Canonical host liveness predicate — the ONE `kill -0` probe the orchestrator
 * shares across the startup prune, the branch-prune runner, and the run-
 * projection sweeper (previously three subtly-divergent private copies;
 * consolidated in issue #2816).
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

// ===========================================================================
// IMPURE ORCHESTRATION (deps injected)
//
// Everything ABOVE this divider is pure and unit-tests without any I/O.
// pruneOrphanedTargetWorktrees BELOW does real I/O (git exec, fs reads/stats,
// wall-clock), but ONLY through the injected `PruneDeps` bag — so it stays
// unit-testable with stubs and never touches the real host under test. The
// src/index.ts caller wires the live deps (github/git::gitExec, node:fs,
// Date.now, isLivePid); a test passes fakes. This keeps the classifier region's
// "Pure — no fs/network/git" contract honest.
// ===========================================================================

/**
 * Structural shape of a `gitExec` result — a discriminated union mirroring
 * `src/github/exec.ts::GhResult`. Declared locally (not imported) so this
 * module keeps zero import-time coupling to the github/ seam; the caller passes
 * the real `gitExec` and it structurally satisfies `GitExec`.
 */
type GitExecResult =
  | { ok: true; data: { stdout: string; stderr: string } }
  | { ok: false; code: string; stderr: string };

/** The injectable git runner — matches `github/git::gitExec`'s call shape. */
type GitExec = (
  args: string[],
  opts: { cwd: string; timeout: number },
) => Promise<GitExecResult>;

/**
 * Side-effecting dependencies the pruner needs, injected so the pruner is
 * unit-testable without touching the real host. In production, index.ts wires:
 *   { gitExec: github/git::gitExec, readFileSync/statSync: node:fs,
 *     isLivePid, now: Date.now }.
 */
export interface PruneDeps {
  /** Run a git subcommand in the workspace; returns a GhResult-shaped union. */
  gitExec: GitExec;
  /** Read a file's text (used for the worktree lock body). Throws if absent. */
  readFileSync: (path: string, encoding: "utf-8") => string;
  /** Stat a path (used for the worktree dir mtime). Throws if the dir vanished. */
  statSync: (path: string) => { mtimeMs: number };
  /** Host liveness predicate — defaults conceptually to {@link isLivePid}. */
  isLivePid: LivePidCheck;
  /** Wall-clock source (ms since epoch) for the dir-age computation. */
  now: () => number;
}

/**
 * Reclaim orphaned `/dev/shm/hydra-worktrees/` worktrees in the target
 * workspace so the stale-branch sweep (src/index.ts) can then delete their
 * feature branches — a registered worktree holding a `feature/*` branch makes
 * `git branch -D` fail closed (issue #2465, recurrence of #2115).
 *
 * Never-touch-first: it delegates the reclaim decision to the pure
 * {@link classifyOrphanWorktree} — never reaping the main tree, the current
 * branch, an out-of-scope dir, a worktree held by a LIVE agent pid, or one
 * under the 6h age floor. `git worktree remove --force` unregisters the entry
 * AND removes the dir; the trailing `git worktree prune` reclaims any registry
 * entry whose dir already vanished.
 *
 * Best-effort / never-throwing — it runs inside server.listen's try/catch, so a
 * git fault `console.error`s and returns the count reclaimed so far (0 on any
 * unreachable / non-orphan state). Idempotent: a second run no-ops.
 *
 * All I/O flows through {@link PruneDeps}, so this unit-tests with stubs.
 */
export async function pruneOrphanedTargetWorktrees(
  workspace: string,
  gitOpts: { cwd: string; timeout: number },
  deps: PruneDeps,
): Promise<number> {
  const { gitExec, readFileSync, statSync, isLivePid: livePid, now } = deps;

  // Locate the common git dir so we can read each worktree's lock-file body
  // (`<commonDir>/worktrees/<id>/locked`), whose `(pid N)` token feeds the
  // live-agent guard. `git worktree list --porcelain` does not carry the PID.
  const commonDirRes = await gitExec(["rev-parse", "--git-common-dir"], gitOpts);
  if (commonDirRes.ok === false) {
    console.error(`[Hydra] Startup worktree prune: 'git rev-parse --git-common-dir' failed (${commonDirRes.code}) — skipping`);
    return 0;
  }
  let commonDir = commonDirRes.data.stdout.trim();
  if (!commonDir) return 0;
  // A relative `.git` resolves against the workspace cwd.
  if (!commonDir.startsWith("/")) commonDir = joinPath(workspace, commonDir);

  const listed = await gitExec(["worktree", "list", "--porcelain"], gitOpts);
  if (listed.ok === false) {
    console.error(`[Hydra] Startup worktree prune: 'git worktree list' failed (${listed.code}) — skipping`);
    return 0;
  }

  // Read lock-file bodies for each worktree so the classifier's live-PID rail
  // can parse the `(pid N)` token. The worktree id is the basename of its path
  // (git's `.git/worktrees/<id>` convention); the lock lives in the common git
  // dir, never under the (possibly-vanished) worktree dir itself.
  const porcelain = listed.data.stdout;
  const lockBodies = new Map<string, string>();
  for (const wt of parseWorktreeList(porcelain)) {
    const id = wt.path.slice(wt.path.lastIndexOf("/") + 1);
    try {
      lockBodies.set(wt.path, readFileSync(joinPath(commonDir, "worktrees", id, "locked"), "utf-8"));
    } catch { /* intentional: no lock file = unlocked worktree, not an error */ }
  }
  // Parse once with lock bodies (populates lockedByPid), then attach each dir's
  // mtime age — the last gate the age-floor rail checks. A vanished dir leaves
  // ageSeconds null = unknown = conservative skip (git worktree prune reclaims
  // its registry entry instead).
  const withLocks: WorktreeRow[] = parseWorktreeList(porcelain, lockBodies).map((wt) => {
    let ageSeconds: number | null = null;
    try {
      ageSeconds = Math.floor((now() - statSync(wt.path).mtimeMs) / 1000);
    } catch { /* intentional: dir already gone = let `git worktree prune` reclaim the registry entry */ }
    return { ...wt, ageSeconds };
  });

  // The main working tree is the first porcelain stanza; never reclaim it.
  const mainWorktreePath = withLocks.length > 0 ? withLocks[0].path : workspace;

  let reclaimed = 0;
  for (const wt of withLocks) {
    const result = classifyOrphanWorktree(wt, {
      mainWorktreePath,
      // Startup runs on `main`; the orphans hold `feature/*` branches. Pass the
      // real current branch so the never-reap-current-branch rail is honest.
      currentBranch: "main",
      isLivePid: livePid,
      minAgeSeconds: DEFAULT_WORKTREE_MIN_AGE_SECONDS,
      // Scope the destructive action to `/dev/shm/hydra-worktrees/` — the dir
      // family the recurrence (#2115 -> #2465) is observed in. A worktree
      // elsewhere is left for the hydra-branch-prune skill's broader sweep.
      scopePrefix: "/dev/shm/hydra-worktrees/",
    });
    if (result.action !== "delete-orphan-worktree") continue;
    const removed = await gitExec(["worktree", "remove", "--force", wt.path], gitOpts);
    if (removed.ok === false) {
      console.error(`[Hydra] Startup worktree prune: 'git worktree remove --force ${wt.path}' skipped (${removed.code})`);
      continue;
    }
    reclaimed++;
    console.log(`[Hydra] Startup worktree prune: reclaimed orphan worktree ${wt.path}${wt.branch ? ` (branch ${wt.branch})` : ""}`);
  }

  // Reclaim any registry entry whose dir already vanished (the orphan dir was
  // removed out-of-band but `.git/worktrees/<id>` lingered) so a stale entry
  // can't keep blocking its branch on a later boot.
  const pruned = await gitExec(["worktree", "prune"], gitOpts);
  if (pruned.ok === false) {
    console.error(`[Hydra] Startup worktree prune: 'git worktree prune' skipped (${pruned.code})`);
  }

  return reclaimed;
}

/**
 * Join path segments with `/`, collapsing an existing trailing slash on the
 * left segment. Local so this module keeps no node:path import (purity of the
 * upper region); behaviour matches `node:path.join` for the absolute-POSIX
 * segments this pruner builds (`<commonDir>/worktrees/<id>/locked`).
 */
function joinPath(...segments: string[]): string {
  return segments
    .filter((s) => s.length > 0)
    .map((s, i) => (i === 0 ? s.replace(/\/+$/, "") : s.replace(/^\/+|\/+$/g, "")))
    .join("/");
}
