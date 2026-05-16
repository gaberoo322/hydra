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
 *   delete-worktree-and-branch — worktree exists, no live agent holding it
 *   delete-branch-only         — no worktree attached, just delete the branch
 *   skip-live-agent            — worktree is held by a live `claude` PID
 *   skip-current-branch        — the candidate IS our current branch
 *   skip-cap                   — we already hit the hard cap (250) this run
 *
 * Idempotency is naturally enforced by `git branch -D` (the branch ceases to
 * exist after one successful prune, so the next sweep no-ops on it) and by
 * `git worktree remove --force` (the dir is gone, so the next sweep doesn't
 * see it as attached).
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
 *  5. Branch has an attached worktree (no live PID)   → delete-worktree-and-branch
 *  6. Otherwise (no attached worktree)                → delete-branch-only
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
    return {
      action: "delete-worktree-and-branch",
      reason: `${row.name} upstream gone; worktree ${wt.path} attached (no live agent) — remove worktree, then delete branch.`,
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
