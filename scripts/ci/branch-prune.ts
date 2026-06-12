/**
 * scripts/ci/branch-prune.ts — Pure helpers for the hydra-branch-prune skill
 * (issue #443).
 *
 * Background: the codex-removal cut-over (ADR-0006) made every code-writing
 * dispatch run inside a `git worktree`. Many worktrees and their branches
 * leak — process crashes, harness restarts, force-quits — leaving the local
 * repo with hundreds of `[gone]` upstreams and worktree dirs over time. One
 * session in 2026-05-15 manually swept 167 branches and 71 worktrees in a
 * single pass; the orchestrator should not need an operator for that.
 *
 * The hydra-branch-prune skill walks `git branch -vv` for `[gone]`-upstream
 * entries (the strong signal of a squash-merged or closed PR), figures out
 * which worktree (if any) is attached to each branch, and classifies each
 * candidate as one of:
 *
 *   delete-worktree-and-branch — worktree exists, no live agent holding it,
 *                                past the age floor
 *   delete-branch-only         — no worktree attached, just delete the branch
 *   skip-live-agent            — worktree is held by a live `claude` PID
 *   skip-current-branch        — the candidate IS our current branch
 *   skip-too-young             — worktree under the age floor / unknown age
 *                                (issue #1773 — auto-merge `--delete-branch`
 *                                makes an in-flight cycle's upstream `[gone]`
 *                                mid-cycle; defer instead of reaping)
 *   skip-cap                   — we already hit the hard cap (250) this run
 *
 * Idempotency is naturally enforced by `git branch -D` (the branch ceases to
 * exist after one successful prune, so the next sweep no-ops on it) and by
 * `git worktree remove --force` (the dir is gone, so the next sweep doesn't
 * see it as attached).
 *
 * ── Worktree-orphan GC (issue #911) ──────────────────────────────────────
 *
 * The `[gone]`-branch pass above structurally CANNOT reclaim the dominant
 * accumulation source. A snapshot on 2026-06-02, taken immediately after a
 * full `--apply` run, found 549 local branches / 120 worktrees of which only
 * 4 branches were `[gone]` — and 119 of the 123 worktrees were held by a
 * DEAD lock-file PID. The bulk are **local-only** branches (QA worktrees,
 * crashed dev attempts) that never had an upstream, so they never become
 * `[gone]` and the branch pass skips them forever.
 *
 * {@link classifyWorktreeOrphan} closes that gap. It is keyed on the
 * WORKTREE (not the branch) and reclaims a worktree regardless of upstream
 * state when ALL of the liveness rails hold:
 *
 *   - the worktree is NOT the main working tree (`isMain` false),
 *   - it is NOT the current worktree / current branch,
 *   - its lock-file PID is dead (or it carries no live PID at all),
 *   - its branch is NOT the head of any OPEN PR (caller supplies the set),
 *   - it is older than a minimum-age floor (default 6h) so an in-flight
 *     dispatch that simply hasn't taken its lock yet is never reaped.
 *
 * The age floor + open-PR-head set are the two signals the `[gone]` pass
 * never needed; the caller (the shell driver) computes both (`stat` mtime,
 * `gh pr list`) and feeds them in, keeping this module pure.
 *
 * This module is pure — no fs / network / git — so it can be unit tested
 * directly. See test/hydra-branch-prune.test.mts.
 */

/** Minimal worktree shape — what we parse out of `git worktree list --porcelain`. */
export interface WorktreeRow {
  /** Absolute path to the worktree dir (the "worktree <path>" line). */
  path: string;
  /** Branch checked out in the worktree (the "branch refs/heads/<name>" line), or null for detached HEAD. */
  branch: string | null;
  /** PID of the Claude agent holding the lock file, or null if no lockfile / not lockable. */
  lockedByPid: number | null;
  /**
   * Age of the worktree dir in seconds (caller-computed from the dir mtime),
   * or null if the caller could not stat it. Consumed by the worktree-orphan
   * GC ({@link classifyWorktreeOrphan}) AND — since issue #1773 — by the
   * `[gone]`-branch pass's `delete-worktree-and-branch` arm, which defers
   * (`skip-too-young`) when the age is unknown or under the floor. Optional so
   * older call sites keep compiling; an absent age is treated conservatively
   * as unknown (skip, never delete the worktree).
   */
  ageSeconds?: number | null;
}

/** Minimal branch shape — what we parse out of `git branch -vv`. */
export interface BranchRow {
  /** Branch name (no `* ` prefix, no leading whitespace). */
  name: string;
  /** True iff the upstream tracking branch is marked `[<upstream>: gone]`. */
  upstreamGone: boolean;
  /** True iff this branch is the currently-checked-out branch (the one prefixed by `* `). */
  isCurrent: boolean;
}

export type PruneAction =
  | "delete-worktree-and-branch"
  | "delete-branch-only"
  | "skip-live-agent"
  | "skip-current-branch"
  | "skip-not-gone"
  | "skip-too-young"
  | "skip-cap";

export interface ClassifyResult {
  action: PruneAction;
  /** Human-readable reason for the action — used in the report body. */
  reason: string;
  /** Attached worktree row, if any. Surfaced so the shell driver knows which path to remove. */
  worktree: WorktreeRow | null;
}

/**
 * Hard cap on branch deletions per run. Defense against script bugs that
 * misclassify everything as `delete-*`. The AC for issue #443 calls this out
 * explicitly: "Hard cap: never delete more than 250 branches in one run
 * (sanity check against script bugs)."
 */
export const HARD_CAP_DELETIONS_PER_RUN = 250;

/**
 * Parse the `(pid <N>)` token out of a worktree lock-file body.
 *
 * The Claude harness writes lock files like:
 *   `claude agent agent-abc123 (pid 12345)`
 *
 * Implementation note from the operator who learned this the hard way:
 * "Parse `(pid` as a field token, not the bare word `pid` — they collide."
 * The substring `pid ` shows up in random English text inside lock notes;
 * the literal `(pid <digits>)` form is the stable marker.
 *
 * Returns null if no `(pid <N>)` token is present.
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
 * Parse a single line of `git branch -vv` output into a {@link BranchRow}.
 *
 * Example inputs:
 *   "* master                        f4d3ecc [origin/master] fix(autopilot): ..."
 *   "  issue-443-branch-prune-skill  abc1234 [origin/issue-443-branch-prune-skill: gone] wip"
 *   "  worktree-agent-xyz            def5678 (no tracking info)"
 *   "+ issue-foo                     abc1234 [origin/issue-foo: gone] handed off to another worktree"
 *
 * The `* ` prefix marks the current branch; `+ ` marks a branch checked out in
 * another worktree; a leading space means no marker. We strip the marker and
 * read the name (first whitespace-delimited token after the marker).
 *
 * Returns null if the line is empty / malformed.
 */
export function parseBranchLine(line: string): BranchRow | null {
  if (!line || !line.trim()) return null;

  // Strip the marker column. The marker is exactly one character (`*`, `+`,
  // or space) followed by a space, per `git branch -vv` output convention.
  const marker = line.charAt(0);
  const rest = line.slice(2);

  // Branch name = first whitespace-delimited token.
  const m = rest.match(/^(\S+)\s/);
  if (!m) return null;
  const name = m[1];

  // Upstream-gone marker. We look for the literal `[<anything>: gone]` token —
  // git always renders the colon and space, and `gone` is the trailing marker
  // word inside the bracket.
  const upstreamGone = /\[[^\]]*:\s*gone\]/.test(rest);

  return {
    name,
    upstreamGone,
    isCurrent: marker === "*",
  };
}

/**
 * Parse `git worktree list --porcelain` output into structured rows.
 *
 * The porcelain format emits a stanza per worktree:
 *
 *   worktree /path/to/wt
 *   HEAD <sha>
 *   branch refs/heads/<name>
 *
 * (Detached worktrees emit `detached` instead of `branch`, and bare/main
 * repos may omit some lines. We tolerate both.)
 *
 * `locks` is an optional map from worktree-path → lockfile body, looked up
 * by the caller via `cat <path>/.git/worktrees/<name>/locked` (or its
 * equivalent for the main worktree). When provided, we run the body through
 * {@link parseLockPid} to populate `lockedByPid`.
 */
export function parseWorktreeList(
  porcelain: string,
  locks: ReadonlyMap<string, string> = new Map(),
): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  if (!porcelain) return rows;

  // Stanzas are blank-line delimited; the final stanza may or may not have a
  // trailing blank line, so we always flush on EOF.
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
        // ref looks like `refs/heads/<name>`; strip the prefix if present.
        branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      }
      // We intentionally ignore HEAD, bare, locked, prunable, detached — the
      // caller maps lock-bodies separately so this parser stays pure on its
      // input string.
    }

    if (!path) continue;
    const lockBody = locks.get(path) ?? null;
    rows.push({
      path,
      branch,
      lockedByPid: parseLockPid(lockBody),
    });
  }

  return rows;
}

/**
 * Build a lookup from branch-name → worktree row. A branch may only be checked
 * out in at most one worktree (git enforces this), so the map is 1:1 on the
 * subset of worktrees that have a non-null branch.
 */
function indexWorktreesByBranch(worktrees: readonly WorktreeRow[]): Map<string, WorktreeRow> {
  const ix = new Map<string, WorktreeRow>();
  for (const wt of worktrees) {
    if (wt.branch) ix.set(wt.branch, wt);
  }
  return ix;
}

/**
 * Predicate: is the PID currently alive on this host?
 *
 * Injected as a parameter (rather than hardwired to `kill -0`) so unit tests
 * can drive every branch deterministically. The shell driver wraps the real
 * `kill -0 <pid>` check.
 */
export type LivePidCheck = (pid: number) => boolean;

export interface ClassifyContext {
  /** Branch name the orchestrator is currently sitting on (e.g. `master`, or a worktree's own branch). */
  currentBranch: string;
  /** Worktrees parsed from `git worktree list --porcelain`. */
  worktrees: readonly WorktreeRow[];
  /** Live-PID predicate — true iff the given PID is currently running. */
  isLivePid: LivePidCheck;
  /**
   * Optional injected counter for the per-run hard cap. The shell driver
   * passes a stateful counter so {@link classifyBranch} can return
   * `skip-cap` once {@link HARD_CAP_DELETIONS_PER_RUN} has been reached.
   * If omitted, the cap is not enforced (used by `classifyBatch` which has
   * its own cap accounting).
   */
  deletionCount?: () => number;
  /**
   * Minimum worktree age (seconds) before the `delete-worktree-and-branch`
   * arm may fire (issue #1773). Defaults to
   * {@link DEFAULT_WORKTREE_MIN_AGE_SECONDS}. An auto-merge with
   * `--delete-branch` flips the local upstream to `[gone]` the instant the PR
   * merges — while the dispatching cycle may still be running post-merge
   * steps inside its worktree (and a manually-created worktree carries no
   * lock file, so the live-PID rail never protects it). The age floor gives
   * such an in-flight cycle a grace window; a worktree under the floor (or
   * with unknown age) classifies as `skip-too-young` and is deferred to the
   * next sweep. Branch-only deletions (no attached worktree) are unaffected.
   */
  minAgeSeconds?: number;
}

/**
 * Classify a single branch row. Pure — no I/O.
 *
 * Decision order (highest priority first):
 *
 *  1. Branch is the current branch                    → skip-current-branch
 *  2. Branch's upstream is NOT `gone`                 → skip-not-gone
 *  3. We already hit the per-run hard cap             → skip-cap
 *  4. Branch has an attached worktree held by a live PID → skip-live-agent
 *  5. Attached worktree is under the age floor (or its age is unknown)
 *                                                     → skip-too-young
 *  6. Branch has an attached worktree (no live PID, past the floor)
 *                                                     → delete-worktree-and-branch
 *  7. Otherwise (no attached worktree)                → delete-branch-only
 *
 * The age floor (issue #1773) mirrors the worktree-orphan pass (#911): age is
 * the LAST gate before worktree deletion, checked only after the live-PID
 * rail, so a fresh worktree held by a live agent still surfaces as
 * `skip-live-agent` (the precise reason) rather than `skip-too-young`.
 */
export function classifyBranch(row: BranchRow, ctx: ClassifyContext): ClassifyResult {
  if (row.isCurrent || row.name === ctx.currentBranch) {
    return {
      action: "skip-current-branch",
      reason: `${row.name} is the current branch — refusing to delete.`,
      worktree: null,
    };
  }

  if (!row.upstreamGone) {
    return {
      action: "skip-not-gone",
      reason: `${row.name} upstream is not [gone] — not a prune candidate.`,
      worktree: null,
    };
  }

  if (ctx.deletionCount && ctx.deletionCount() >= HARD_CAP_DELETIONS_PER_RUN) {
    return {
      action: "skip-cap",
      reason: `Per-run hard cap (${HARD_CAP_DELETIONS_PER_RUN}) reached — refusing to delete more.`,
      worktree: null,
    };
  }

  const byBranch = indexWorktreesByBranch(ctx.worktrees);
  const wt = byBranch.get(row.name) ?? null;

  if (wt && wt.lockedByPid !== null && ctx.isLivePid(wt.lockedByPid)) {
    return {
      action: "skip-live-agent",
      reason: `${row.name} worktree ${wt.path} is held by live PID ${wt.lockedByPid} — leave for next run.`,
      worktree: wt,
    };
  }

  if (wt) {
    // Age floor (issue #1773). An auto-merged PR's `--delete-branch` makes the
    // upstream `[gone]` immediately, but the dispatching cycle may still be
    // mid-flight in this worktree (manually-created worktrees carry no lock
    // file, so the live-PID rail above cannot protect them). Defer young
    // worktrees; treat unknown age conservatively as too-young — never reap a
    // dir we know nothing about (same discipline as classifyWorktreeOrphan).
    const minAge = ctx.minAgeSeconds ?? DEFAULT_WORKTREE_MIN_AGE_SECONDS;
    if (wt.ageSeconds === null || wt.ageSeconds === undefined || wt.ageSeconds < minAge) {
      const ageNote =
        wt.ageSeconds === null || wt.ageSeconds === undefined ? "unknown age" : `${wt.ageSeconds}s old`;
      return {
        action: "skip-too-young",
        reason: `${row.name} upstream gone but worktree ${wt.path} is ${ageNote}, under the ${minAge}s floor — defer in case it is an in-flight cycle (auto-merge deletes the branch before the cycle finishes).`,
        worktree: wt,
      };
    }

    return {
      action: "delete-worktree-and-branch",
      reason: `${row.name} upstream gone; worktree ${wt.path} attached (no live agent, ${wt.ageSeconds}s old) — remove worktree, then delete branch.`,
      worktree: wt,
    };
  }

  return {
    action: "delete-branch-only",
    reason: `${row.name} upstream gone; no attached worktree — delete branch.`,
    worktree: null,
  };
}

export interface ClassifyBuckets {
  deleteWorktreeAndBranch: Array<{ row: BranchRow; worktree: WorktreeRow }>;
  deleteBranchOnly: BranchRow[];
  skipLiveAgent: Array<{ row: BranchRow; worktree: WorktreeRow; pid: number }>;
  skip: Array<{ row: BranchRow; reason: string }>;
  /** True iff any candidate was deferred because the hard cap was reached. */
  cappedOut: boolean;
}

/**
 * Classify a batch of branch rows. Maintains a running deletion counter so
 * the hard cap fires deterministically once {@link HARD_CAP_DELETIONS_PER_RUN}
 * delete-* actions have been issued in this batch. Input order is preserved
 * within each bucket.
 */
export function classifyBatch(rows: readonly BranchRow[], ctx: Omit<ClassifyContext, "deletionCount">): ClassifyBuckets {
  const buckets: ClassifyBuckets = {
    deleteWorktreeAndBranch: [],
    deleteBranchOnly: [],
    skipLiveAgent: [],
    skip: [],
    cappedOut: false,
  };

  let deletions = 0;
  const ctxWithCounter: ClassifyContext = {
    ...ctx,
    deletionCount: () => deletions,
  };

  for (const row of rows) {
    const r = classifyBranch(row, ctxWithCounter);
    switch (r.action) {
      case "delete-worktree-and-branch":
        // Worktree is guaranteed non-null here by classifyBranch's contract.
        buckets.deleteWorktreeAndBranch.push({ row, worktree: r.worktree as WorktreeRow });
        deletions++;
        break;
      case "delete-branch-only":
        buckets.deleteBranchOnly.push(row);
        deletions++;
        break;
      case "skip-live-agent":
        // PID is guaranteed non-null here by classifyBranch's decision order.
        buckets.skipLiveAgent.push({
          row,
          worktree: r.worktree as WorktreeRow,
          pid: (r.worktree as WorktreeRow).lockedByPid as number,
        });
        break;
      case "skip-cap":
        buckets.cappedOut = true;
        buckets.skip.push({ row, reason: r.reason });
        break;
      default:
        buckets.skip.push({ row, reason: r.reason });
        break;
    }
  }

  return buckets;
}

/**
 * Render a single-pass report. Pure — deterministic for testability.
 */
export function renderReport(buckets: ClassifyBuckets, when: string, auditOnly: boolean): string {
  const total =
    buckets.deleteWorktreeAndBranch.length +
    buckets.deleteBranchOnly.length +
    buckets.skipLiveAgent.length +
    buckets.skip.length;

  const verb = auditOnly ? "Would delete" : "Deleted";
  const lines: string[] = [];
  lines.push(`## Hydra Branch Prune — ${when}${auditOnly ? " (audit-only)" : ""}`);
  lines.push("");
  lines.push(`Scanned: ${total} local branches`);
  lines.push("");

  lines.push(`### ${verb} (worktree + branch)`);
  if (buckets.deleteWorktreeAndBranch.length === 0) {
    lines.push("- _none_");
  } else {
    for (const e of buckets.deleteWorktreeAndBranch) {
      lines.push(`- ${e.row.name}  (worktree: ${e.worktree.path})`);
    }
  }
  lines.push("");

  lines.push(`### ${verb} (branch only)`);
  if (buckets.deleteBranchOnly.length === 0) {
    lines.push("- _none_");
  } else {
    for (const r of buckets.deleteBranchOnly) {
      lines.push(`- ${r.name}`);
    }
  }
  lines.push("");

  lines.push("### Skipped — live agent");
  if (buckets.skipLiveAgent.length === 0) {
    lines.push("- _none_");
  } else {
    for (const e of buckets.skipLiveAgent) {
      lines.push(`- ${e.row.name}  (worktree ${e.worktree.path}, pid ${e.pid})`);
    }
  }
  lines.push("");

  lines.push("### Skipped — other");
  if (buckets.skip.length === 0) {
    lines.push("- _none_");
  } else {
    for (const s of buckets.skip) {
      lines.push(`- ${s.row.name}: ${s.reason}`);
    }
  }

  if (buckets.cappedOut) {
    lines.push("");
    lines.push(`> Hit per-run hard cap (${HARD_CAP_DELETIONS_PER_RUN}). Remaining candidates will be picked up on the next run.`);
  }

  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Worktree-orphan GC (issue #911)
//
// The branch pass above only ever fires on `[gone]` upstreams. Local-only
// worktrees (no upstream → never `[gone]`) are invisible to it forever, and
// those are the dominant accumulation source. The functions below classify by
// WORKTREE instead, so a crashed/abandoned dispatch's dir is reclaimed on
// liveness signals (dead lock PID + age) rather than on upstream state.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Default minimum age (seconds) before a worktree is GC-eligible. An in-flight
 * dispatch that has just been created but has not yet written its lock file
 * would otherwise look identical to a crashed orphan; the age floor protects
 * it. 6h comfortably exceeds the subagent wall-clock cap
 * (`HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS`, default 3600s) so any worktree
 * older than this floor whose PID is also dead is unambiguously abandoned.
 */
export const DEFAULT_WORKTREE_MIN_AGE_SECONDS = 6 * 60 * 60;

export type WorktreeOrphanAction =
  | "delete-orphan-worktree"
  | "skip-main-worktree"
  | "skip-current-worktree"
  | "skip-live-agent"
  | "skip-open-pr-head"
  | "skip-too-young"
  | "skip-cap";

export interface WorktreeOrphanResult {
  action: WorktreeOrphanAction;
  reason: string;
  worktree: WorktreeRow;
}

export interface WorktreeOrphanContext {
  /** Absolute path of the MAIN working tree (never reclaim it). */
  mainWorktreePath: string;
  /** Branch the orchestrator is currently sitting on — its worktree is preserved. */
  currentBranch: string;
  /** Live-PID predicate — true iff the given PID is currently running. */
  isLivePid: LivePidCheck;
  /**
   * Set of branch names that are the head of an OPEN PR. A worktree whose
   * branch is in this set is preserved even if its PID is dead — the PR may
   * still be merged, and tearing down the local branch would orphan the PR's
   * local checkout. Caller builds this from `gh pr list --json headRefName`.
   */
  openPrHeads: ReadonlySet<string>;
  /** Minimum worktree age (seconds) before it is GC-eligible. */
  minAgeSeconds: number;
  /**
   * Optional injected counter for the per-run hard cap. Shared with the branch
   * pass so the 250-deletion ceiling spans BOTH passes in one run.
   */
  deletionCount?: () => number;
}

/**
 * Classify a single worktree row for the orphan GC. Pure — no I/O.
 *
 * Decision order (highest priority first), mirroring {@link classifyBranch}'s
 * never-touch-first discipline:
 *
 *  1. Worktree IS the main working tree                 → skip-main-worktree
 *  2. Worktree's branch is the current branch           → skip-current-worktree
 *  3. We already hit the per-run hard cap               → skip-cap
 *  4. Lock-file PID is a live process                   → skip-live-agent
 *  5. Branch is the head of an open PR                  → skip-open-pr-head
 *  6. Worktree is younger than the age floor            → skip-too-young
 *  7. Otherwise (dead/no PID, not an open-PR head, old) → delete-orphan-worktree
 *
 * Note the age floor is checked AFTER the liveness/PR rails: a freshly-created
 * worktree held by a live agent must skip as `skip-live-agent` (the precise
 * reason), not `skip-too-young`. Age is the LAST gate before deletion.
 */
export function classifyWorktreeOrphan(
  wt: WorktreeRow,
  ctx: WorktreeOrphanContext,
): WorktreeOrphanResult {
  if (wt.path === ctx.mainWorktreePath) {
    return {
      action: "skip-main-worktree",
      reason: `${wt.path} is the main working tree — never reclaim.`,
      worktree: wt,
    };
  }

  if (wt.branch !== null && wt.branch === ctx.currentBranch) {
    return {
      action: "skip-current-worktree",
      reason: `${wt.path} has the current branch ${wt.branch} checked out — refusing to remove.`,
      worktree: wt,
    };
  }

  if (ctx.deletionCount && ctx.deletionCount() >= HARD_CAP_DELETIONS_PER_RUN) {
    return {
      action: "skip-cap",
      reason: `Per-run hard cap (${HARD_CAP_DELETIONS_PER_RUN}) reached — refusing to remove more.`,
      worktree: wt,
    };
  }

  if (wt.lockedByPid !== null && ctx.isLivePid(wt.lockedByPid)) {
    return {
      action: "skip-live-agent",
      reason: `${wt.path} is held by live PID ${wt.lockedByPid} — leave for next run.`,
      worktree: wt,
    };
  }

  if (wt.branch !== null && ctx.openPrHeads.has(wt.branch)) {
    return {
      action: "skip-open-pr-head",
      reason: `${wt.path} branch ${wt.branch} is the head of an open PR — preserve until the PR closes.`,
      worktree: wt,
    };
  }

  // Age floor — only reached once the worktree is provably not live and not an
  // open-PR head. A null ageSeconds means the caller could not stat the dir;
  // we treat that conservatively as "too young" (skip) rather than risk
  // reaping a dir we know nothing about.
  if (wt.ageSeconds === null || wt.ageSeconds === undefined || wt.ageSeconds < ctx.minAgeSeconds) {
    const ageNote = wt.ageSeconds === null || wt.ageSeconds === undefined ? "unknown age" : `${wt.ageSeconds}s old`;
    return {
      action: "skip-too-young",
      reason: `${wt.path} is ${ageNote}, under the ${ctx.minAgeSeconds}s floor — defer in case it is an in-flight dispatch.`,
      worktree: wt,
    };
  }

  return {
    action: "delete-orphan-worktree",
    reason:
      `${wt.path} is a local-only orphan (` +
      `${wt.lockedByPid !== null ? `dead PID ${wt.lockedByPid}` : "no live agent"}, ` +
      `${wt.branch ? `branch ${wt.branch} not an open-PR head` : "detached"}, ${wt.ageSeconds}s old` +
      `) — remove worktree${wt.branch ? `, then delete branch ${wt.branch}` : ""}.`,
    worktree: wt,
  };
}

export interface WorktreeOrphanBuckets {
  /** Worktrees to reclaim. `branch` is null for detached worktrees (no branch -D). */
  deleteOrphan: Array<{ worktree: WorktreeRow; branch: string | null }>;
  skip: Array<{ worktree: WorktreeRow; action: WorktreeOrphanAction; reason: string }>;
  /** True iff any candidate was deferred because the hard cap was reached. */
  cappedOut: boolean;
}

/**
 * Classify a batch of worktree rows for the orphan GC. Maintains a running
 * deletion counter; if {@link WorktreeOrphanContext.deletionCount} is supplied
 * it is summed with this pass's own deletions, so the 250-deletion hard cap
 * spans BOTH the branch pass and this pass in a single run. Input order is
 * preserved within each bucket.
 */
export function classifyWorktreeOrphans(
  worktrees: readonly WorktreeRow[],
  ctx: Omit<WorktreeOrphanContext, "deletionCount"> & { priorDeletions?: number },
): WorktreeOrphanBuckets {
  const buckets: WorktreeOrphanBuckets = {
    deleteOrphan: [],
    skip: [],
    cappedOut: false,
  };

  let localDeletions = 0;
  const prior = ctx.priorDeletions ?? 0;
  const ctxWithCounter: WorktreeOrphanContext = {
    ...ctx,
    deletionCount: () => prior + localDeletions,
  };

  for (const wt of worktrees) {
    const r = classifyWorktreeOrphan(wt, ctxWithCounter);
    if (r.action === "delete-orphan-worktree") {
      buckets.deleteOrphan.push({ worktree: wt, branch: wt.branch });
      localDeletions++;
    } else {
      if (r.action === "skip-cap") buckets.cappedOut = true;
      buckets.skip.push({ worktree: wt, action: r.action, reason: r.reason });
    }
  }

  return buckets;
}

/**
 * Render the worktree-orphan GC section of the report. Pure — deterministic.
 * Designed to be appended below the existing {@link renderReport} branch
 * section so a single run shows both passes.
 */
export function renderWorktreeOrphanReport(buckets: WorktreeOrphanBuckets, auditOnly: boolean): string {
  const verb = auditOnly ? "Would reclaim" : "Reclaimed";
  const lines: string[] = [];
  lines.push("### Worktree-orphan GC (issue #911)");
  lines.push("");

  lines.push(`#### ${verb} (local-only orphan worktrees)`);
  if (buckets.deleteOrphan.length === 0) {
    lines.push("- _none_");
  } else {
    for (const e of buckets.deleteOrphan) {
      lines.push(`- ${e.worktree.path}${e.branch ? `  (branch: ${e.branch})` : "  (detached)"}`);
    }
  }
  lines.push("");

  lines.push("#### Skipped — worktree GC");
  if (buckets.skip.length === 0) {
    lines.push("- _none_");
  } else {
    for (const s of buckets.skip) {
      lines.push(`- ${s.worktree.path}: ${s.reason}`);
    }
  }

  if (buckets.cappedOut) {
    lines.push("");
    lines.push(`> Hit per-run hard cap (${HARD_CAP_DELETIONS_PER_RUN}). Remaining worktrees will be picked up on the next run.`);
  }

  return lines.join("\n");
}
