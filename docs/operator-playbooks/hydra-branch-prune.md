---
name: hydra-branch-prune
description: Periodic cleanup of stale local branches and worktrees from completed agent dispatches. Detects [gone]-upstream branches, force-unlocks stale worktree locks (skipping live Claude agents), removes the worktrees, and deletes the branches.
when_to_use: "When the operator says 'prune branches' or 'clean stale worktrees', or after the daily merge wave."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
claude_only: true
---

# Hydra Branch Prune

Sister skill to `hydra-pr-rebase` (open-PR side). This one handles the *post-merge* janitorial side: branches whose upstream is gone after a squash-merge, plus the worktrees that were attached to them — AND, since issue #911, the **local-only orphan worktrees** the `[gone]` signal can never reclaim — AND, since issue #1784, the **never-pushed dead-dispatch branches** (no upstream, no PR, worktree already reaped) that escape both of those passes — AND, since issue #2029, the **merged-remote zombie branches** (PR merged/closed but the `origin/<name>` remote ref still exists, so the upstream never goes `[gone]`) — AND, since issue #2459, the **master-tracking dispatch orphans** (a `worktree-agent-*` branch that inherited `origin/master` as its upstream and was never pushed under its own name, so its upstream is healthy and non-`[gone]` forever AND its name was never a PR head — escaping all four prior passes permanently).

After the codex-removal cut-over (ADR-0006) every code-writing dispatch runs inside a `git worktree` under `~/hydra/.claude/worktrees/agent-*` or `/dev/shm/hydra-worktrees/`. When the agent finishes (or crashes, or is force-quit) the worktree often leaks — `git branch -vv` accumulates `[gone]` upstreams and the worktree dirs stay around indefinitely. A single manual sweep on 2026-05-15 cleaned **167 branches and 71 worktrees** in one pass; the orchestrator should not need a human for that.

The skill is one pass over the local repo, then exit. The scheduling cadence is owned by `scripts/systemd/hydra-branch-prune.timer` (see "Scheduling" below) — the skill itself is on-demand.

## Five reclamation passes (root causes — issues #911, #1784, #2029, #2459)

The original skill only ever acted on `[gone]` upstreams. A snapshot on **2026-06-02, taken immediately after a full `--apply` run**, exposed the first structural gap:

- **549 local branches / 120 worktrees** still present after the sweep.
- Of those, only **4 branches were `[gone]`**; **338 were local-only with no upstream at all**; 211 had a live upstream (open PRs).
- Of the 123 worktrees, only **4 were held by a live PID** — **98 carried a lock file whose PID was dead**, and 21 had no lock.

**Root cause (pass 2/3):** the dominant accumulation source there was **local-only worktrees** — QA worktrees (`agent-qa-NNN`, `pr-NNN-qa`), abandoned/crashed dev attempts, and worktrees leaked by the run-termination bug (#898). These are created locally for a single dispatch and **never pushed**, so they never acquire an upstream → never become `[gone]` → the `[gone]`-keyed pass skips them **forever**. Nothing tore them down at dispatch-reap time either.

A second snapshot on **2026-06-19** exposed the remaining gap (issue #2029): **~160 local branches with a LIVE (non-gone) `origin/*` upstream and 0 open PRs.** Their PRs were squash-merged or closed **without deleting the remote branch**, so `git fetch --prune` finds the upstream alive → never `[gone]` → pass 1 classifies them `skip-not-gone`, pass 3 classifies them `skip-has-upstream`. Auto-merge `--delete-branch` (enabled 2026-05-28) fixes the case **forward**; these predate it or merged without it.

A third snapshot on **2026-06-25** exposed the last structural gap (issue #2459): **108 surviving `worktree-agent-*` branches**, of which ~104 show `[origin/master: ahead N, behind M]` under `git branch -vv`. They were created via `git worktree add` / `checkout -b` **inheriting `origin/master` as their upstream** (not `origin/<own-name>`), the harness then opened the PR under a *different* branch name, and the `worktree-agent-*` branch was **never pushed under its own name**. Two consequences combine to defeat all four prior passes: (a) `origin/master` is the most-alive ref in the repo, so the upstream is healthy and **non-`[gone]` forever** (`git fetch --prune` has no `origin/worktree-agent-*` ref to prune) → pass 1 `skip-not-gone`, pass 3 `skip-has-upstream`; and (b) the name was **never a PR head** (`gh pr list --head <name>` is empty) → pass 4 `skip-pr-unresolved`. The distinguishing signal is **upstream-tracks-a-foreign-branch**: the tracked ref's branch segment differs from the local branch's own name.

The passes, in classification order:

1. **Branch pass (`[gone]`)** — reclaims branches whose upstream is gone after a squash-merge, plus their attached worktrees. Since issue #1773 the worktree-deletion arm is age-gated (see `skip-too-young` below): auto-merge with `--delete-branch` flips the upstream to `[gone]` the instant a PR merges, while the dispatching cycle may still be running post-merge steps inside its worktree — and a manually-created worktree (e.g. a target-build cycle's `/dev/shm` dir) carries no lock file, so the live-PID rail alone cannot protect it.
2. **Worktree-orphan GC** (issue #911) — keyed on the *worktree*, not the branch. Reclaims a worktree **regardless of upstream state** when every liveness rail holds (see below).
3. **Dead-branch GC** (issue #1784) — keyed on the *branch* again, but for the case the first two passes structurally miss: a dispatch that died **without ever opening a PR** leaves a branch with **no upstream at all** (never `[gone]`, so pass 1 classifies it `skip-not-gone` forever), and once its worktree is reaped there is nothing for pass 2 to key on either. Run f00da325 hit exactly this: two stale `issue-1676` branches (no PR, no upstream, ~4h idle) that a later dispatch had to liveness-check by hand, plus the sibling cue `pr-branch-held-by-stale-worktree` where a stale branch blocked a later checkout outright (cross-run recurrence 4 for cue `dead-prior-dispatch-branches-no-pr`). This pass deletes a local branch only when **all** of: no upstream, dispatch-shaped name (`issue-*`, `worktree-agent-*`, `agent-*`, `pr-<N>*` — operator branches are never eligible), not the current branch, not checked out in any worktree, not the head of an open PR, and past the same age floor.
4. **Merged-remote GC** (issue #2029) — keyed on the *branch* for the squash-merge-with-zombie-remote case: a branch with a **live (non-gone) upstream** whose PR is **MERGED or CLOSED**. The positive merge signal is the PR state (`gh pr list --state all`, filtered to MERGED/CLOSED head-refs), *not* the upstream marker — the whole point is the upstream is NOT `[gone]`. This pass deletes the **LOCAL** ref only when **all** of: has an upstream (else pass 3 owns it), upstream not `[gone]` (else pass 1 owns it), dispatch-shaped name, not the current branch, not a live-PID worktree, not the head of an open PR, has a MERGED/CLOSED PR signal, no attached worktree (else the orphan GC owns it), and past the same age floor. **Local-only invariant:** the zombie `origin/<name>` ref is left untouched — `git push origin --delete` is an external-account mutation (ADR-0005 escalation) and stays an operator step (see "Clearing the standing zombie remotes" below). Deleting the local ref alone is the safe, autonomous half.
5. **Master-tracking-orphan GC** (issue #2459) — keyed on the *branch* for the foreign-upstream case the first four passes all miss: a dispatch branch whose configured upstream is a **foreign branch** (almost always `origin/master`) rather than `origin/<own-name>`, with **no PR head** ever recorded for its name. The distinguishing signal is the per-branch upstream short-name (`git for-each-ref --format='%(upstream:short)'`): the tracked ref's branch segment differs from the branch's own name. This pass deletes the **LOCAL** ref only when **all** of: has an upstream (else pass 3 owns it), upstream not `[gone]` (else pass 1 owns it), **tracks a foreign upstream** (else it is a genuine `origin/<own-name>` work branch — `skip-self-tracking`), dispatch-shaped name, not the current branch, not a live-PID worktree, **not the head of an open PR** (negative guard — this pass has no positive merge signal, so an open-PR head is preserved), no attached worktree (else the orphan GC owns it), and past the same age floor. **Local-only invariant:** there is no `origin/<name>` remote ref to touch — its absence is precisely why these branches accumulate — so the local-only envelope is naturally airtight. **gh-absent asymmetry:** with no positive merge signal to lean on, a missing/unauthenticated `gh` degrades the open-PR-head guard to empty (the *less*-safe direction); the dispatch-name + dead-PID + no-attached-worktree + 6h age-floor rails therefore stand as independent backstops, exactly as the dead-branch GC (#1784) does.

All five passes share the same 250-deletion hard cap in a single run (each later pass is seeded with the earlier passes' deletion counts), and all refuse to touch a live-PID worktree or the current branch.

## When NOT to run this

- From inside a worktree. `scripts/branch-prune.sh` refuses to run when `git rev-parse --git-dir` points under `.git/worktrees/` — running `git worktree remove --force` while sitting inside a worktree is the textbook way to saw off the branch you're standing on.
- When master is itself broken — squash-merge detection works fine on a broken master, but a corrupted local index can lie about `[gone]` markers. Run `/hydra-doctor` first if anything else feels off.
- Inside a `dev_orch` / `dev_target` subagent — those run in their own worktree (and would be refused by the safety rail anyway). This skill belongs to the autopilot parent context or the daily timer.

## How it decides what to prune

The pure classifier lives at `scripts/ci/branch-prune.ts` and is exercised by `test/hydra-branch-prune.test.mts`. It takes three inputs:

1. `git branch -vv` — every local branch, with the `[<upstream>: gone]` marker for squash-merged / deleted upstreams.
2. `git worktree list --porcelain` — every attached worktree and the branch it has checked out.
3. The body of each `.git/worktrees/<name>/locked` file (if present) — these are the lock notes the Claude harness writes when an agent claims a worktree, and they contain `(pid <N>)` markers for the live process.

The classifier emits one of seven actions per branch:

| Action                          | Condition                                                                              | What the driver does                                  |
| ------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `delete-worktree-and-branch`    | Upstream gone; worktree attached; no live PID holding the lock; dir older than the age floor (6h) | `git worktree unlock` → `git worktree remove --force` → `git branch -D` |
| `delete-branch-only`            | Upstream gone; no attached worktree                                                    | `git branch -D`                                       |
| `skip-live-agent`               | Upstream gone; worktree attached; lock-file PID is a live process (`kill -0` succeeds) | Leave alone; the *next* run will retry once the agent finishes |
| `skip-current-branch`           | Branch IS the currently-checked-out branch                                             | Refuse — never delete the current branch              |
| `skip-not-gone`                 | Upstream is healthy (no `[gone]` marker)                                               | Skip — not a prune candidate                          |
| `skip-too-young`                | Upstream gone; worktree attached; dir younger than the age floor OR age unknown (issue #1773) | Defer — protects an in-flight cycle whose branch auto-merge just deleted |
| `skip-cap`                      | Already issued `HARD_CAP_DELETIONS_PER_RUN` (250) delete-* actions this run            | Skip — defer to the next run; defense against script bugs |

### Worktree-orphan GC actions (issue #911)

The second pass classifies each *worktree* (from `git worktree list --porcelain`) into one of:

| Action                    | Condition                                                                                                      | What the driver does                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `delete-orphan-worktree`  | Not main, not current; dead/no lock PID; branch is NOT an open-PR head; dir older than the age floor (6h)       | `git worktree unlock` → `git worktree remove --force` → `git branch -D` (skipped for detached) |
| `skip-main-worktree`      | The worktree IS the main working tree                                                                          | Never reclaim                                              |
| `skip-current-worktree`   | The worktree has the current branch checked out                                                               | Never reclaim                                              |
| `skip-live-agent`         | Lock-file PID is a live process (`kill -0` succeeds)                                                           | Defer — checked BEFORE age, so a fresh live agent is safe  |
| `skip-open-pr-head`       | The branch is the head of an OPEN PR (`gh pr list --json headRefName`)                                        | Preserve until the PR closes                               |
| `skip-too-young`          | The dir is younger than the age floor, OR its age is unknown (couldn't `stat`)                                | Defer — protects an in-flight dispatch that hasn't locked yet |
| `skip-cap`                | The shared 250-deletion hard cap is already reached this run                                                   | Defer to the next run                                      |

The two extra signals this pass introduced:

- **Open-PR-head set** — built from `gh pr list --state open --json headRefName`. A worktree whose branch heads an open PR is preserved even with a dead PID (the PR may still merge). A missing/unauthenticated `gh` degrades to an *empty* set, which only ever makes the GC **more** conservative (it then relies on age + dead-PID alone) — never less. This rail is GC-pass-only (a `[gone]` upstream already proves the PR closed).
- **Age floor** — the worktree dir's mtime vs now. Default **6h** (`DEFAULT_WORKTREE_MIN_AGE_SECONDS`), overridable via `HYDRA_WORKTREE_MIN_AGE_SECONDS`. 6h comfortably exceeds the subagent wall-clock cap (default 3600s), so a worktree past the floor whose PID is also dead is unambiguously abandoned. Age is the **last** gate — checked only after the worktree is provably not live and not an open-PR head — so a never-reaped live agent surfaces as `skip-live-agent`, not `skip-too-young`. Since issue #1773 the **same floor also gates the `[gone]` pass's worktree-deletion arm** (same env override, same unknown-age-means-skip discipline): a `[gone]` upstream no longer proves *abandonment*, because auto-merge `--delete-branch` creates it mid-cycle — in `claude-cycle-2026-06-11-0401` a prune sweep landed between the merge and the cycle's post-merge-health step and GC'd the cycle's `/dev/shm` worktree out from under it.

### Dead-branch GC actions (issue #1784)

The third pass classifies each *branch with no upstream* (from the same `git branch -vv` parse) into one of:

| Action                       | Condition                                                                                                   | What the driver does |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------- |
| `delete-branch-no-upstream`  | No upstream; dispatch-shaped name; not current; no attached worktree; not an open-PR head; past the age floor | `git branch -D`      |
| `skip-has-upstream`          | Branch has an upstream (gone or healthy) — pass 1's domain                                                  | Nothing (dropped from this pass's report; pass 1 already lists it) |
| `skip-not-dispatch-branch`   | Name doesn't match a dispatch-generated pattern                                                              | Never auto-delete operator branches |
| `skip-current-branch`        | Branch IS the currently-checked-out branch                                                                  | Refuse |
| `skip-live-agent`            | Checked out in a worktree held by a live PID                                                                | Defer — checked BEFORE age, so a fresh live agent is safe |
| `skip-open-pr-head`          | Branch heads an OPEN PR — a push without `-u` sets no local upstream, so this case is real                  | Preserve until the PR closes |
| `skip-attached-worktree`     | Checked out in a worktree (dead/no PID)                                                                      | Defer — the worktree-orphan GC owns attached worktrees and deletes worktree + branch together |
| `skip-too-young`             | Ref age under the floor, OR age unknown                                                                      | Defer — protects an in-flight dispatch |
| `skip-cap`                   | The shared 250-deletion hard cap is already reached this run                                                 | Defer to the next run |

The extra signal this pass introduced:

- **Per-branch ref age** — `now` minus the ref's last reflog update (`git log -g -1 --format=%ct refs/heads/<name>`), falling back to the tip committer date when the reflog is unavailable. The reflog signal matters: a branch freshly cut from master has an *old* tip commit but a *new* reflog entry, and the floor must protect it. A branch with neither signal gets unknown age → conservative skip, never delete. Same floor (`DEFAULT_WORKTREE_MIN_AGE_SECONDS`, 6h, `HYDRA_WORKTREE_MIN_AGE_SECONDS` override) as the other passes.
- **Dispatch-name rail** — a no-upstream branch is the *natural state* of any operator-made local branch (`git branch scratch`), so the pass only ever deletes names matching `DEAD_DISPATCH_BRANCH_PATTERNS` (`issue-<N>*`, `worktree-agent-*`, `agent-*`, `pr-<N>*`). Everything else surfaces in the report as `skip-not-dispatch-branch` so the operator can extend the list deliberately.
- Note the open-PR-head rail degrades to an empty set when `gh` is missing/unauthenticated — for THIS pass that is the less-safe direction (unlike the orphan GC, where the upstream signal backstops it), but the dispatch-name + age + attached-worktree rails still hold, and only *local* refs are ever deleted: the PR's remote branch is untouched, so the worst case is re-fetching the branch, not data loss.

### Merged-remote GC actions (issue #2029)

The fourth pass classifies each *branch with a live (non-gone) upstream* into one of:

| Action                       | Condition                                                                                                       | What the driver does |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------- |
| `delete-branch-merged-remote`| Live upstream; dispatch-shaped name; not current; PR is MERGED/CLOSED; no live/attached worktree; not an open-PR head; past the age floor | `git branch -D` (LOCAL only — the remote ref is left for the operator) |
| `skip-no-upstream`           | Branch has no upstream — pass 3's domain                                                                        | Nothing (dropped from this pass's report; pass 3 already covers it) |
| `skip-gone`                  | Upstream is `[gone]` — pass 1's domain                                                                          | Nothing (dropped; pass 1 already covers it) |
| `skip-not-dispatch-branch`   | Name doesn't match a dispatch-generated pattern                                                                 | Never auto-delete operator branches |
| `skip-current-branch`        | Branch IS the currently-checked-out branch                                                                      | Refuse |
| `skip-live-agent`            | Checked out in a worktree held by a live PID                                                                    | Defer — checked BEFORE the merge signal, so a fresh live agent is safe |
| `skip-pr-unresolved`         | Heads an OPEN PR, OR has no MERGED/CLOSED PR signal (gh absent / PR still open)                                 | Defer — never delete without a positive merge signal |
| `skip-attached-worktree`     | Has an attached worktree (dead/no PID)                                                                          | Defer — the worktree-orphan GC owns attached worktrees and deletes worktree + branch together |
| `skip-too-young`             | Ref age under the floor, OR age unknown                                                                         | Defer — protects an in-flight cycle |
| `skip-cap`                   | The shared 250-deletion hard cap is already reached this run                                                    | Defer to the next run |

The extra signal this pass introduced:

- **Merged/closed-PR head set** — `gh pr list --state all --json headRefName,state`, filtered to head-refs whose state is `MERGED` or `CLOSED`. This is the *positive* merge signal that replaces the `[gone]` marker for this case (the upstream is deliberately NOT `[gone]` here). A missing/unauthenticated `gh` degrades to an **empty** set → every branch classifies `skip-pr-unresolved` → the pass deletes **nothing**. Unlike the dead-branch GC's open-PR rail, this set is the pass's *sole* delete trigger, so an empty `gh` makes it a total no-op — the safe direction.
- **Local-only invariant** — this pass deletes the LOCAL `refs/heads/<name>` only. The zombie `origin/<name>` ref is an external-account mutation (`git push origin --delete`) and stays an operator-gated step (ADR-0005); the driver is text-guarded against ever pushing a remote-branch deletion. Deleting the local ref reclaims `git branch -vv` clutter and frees the local name for reuse; the forward fix for the remote side is auto-merge `--delete-branch`.

### Master-tracking-orphan GC actions (issue #2459)

The fifth pass classifies each *branch with a live (non-gone) upstream* into one of:

| Action                                  | Condition                                                                                                                         | What the driver does |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `delete-branch-master-tracking-orphan`  | Live upstream that **tracks a foreign branch** (e.g. `origin/master`); dispatch-shaped name; not current; not a live/attached worktree; not an open-PR head; past the age floor | `git branch -D` (LOCAL only — there is no `origin/<name>` ref to touch) |
| `skip-no-upstream`                      | Branch has no upstream — pass 3's domain                                                                                          | Nothing (dropped; pass 3 already covers it) |
| `skip-gone`                             | Upstream is `[gone]` — pass 1's domain                                                                                            | Nothing (dropped; pass 1 already covers it) |
| `skip-self-tracking`                    | Upstream tracks the branch's OWN `origin/<name>` (a genuine work branch), OR the upstream was not collected (null)                | Nothing (dropped — not this pass's concern; passes 1/4 own it) |
| `skip-not-dispatch-branch`              | Name doesn't match a dispatch-generated pattern                                                                                   | Never auto-delete operator branches |
| `skip-current-branch`                   | Branch IS the currently-checked-out branch                                                                                        | Refuse |
| `skip-live-agent`                       | Checked out in a worktree held by a live PID                                                                                      | Defer — checked BEFORE the open-PR / age rails, so a fresh live agent is safe |
| `skip-open-pr-head`                     | Heads an OPEN PR                                                                                                                  | Defer — **negative guard** (this pass has no positive merge signal, so it preserves an open-PR head) |
| `skip-attached-worktree`                | Has an attached worktree (dead/no PID)                                                                                            | Defer — the worktree-orphan GC owns attached worktrees and deletes worktree + branch together |
| `skip-too-young`                        | Ref age under the floor, OR age unknown                                                                                          | Defer — protects an in-flight cycle |
| `skip-cap`                              | The shared 250-deletion hard cap is already reached this run                                                                      | Defer to the next run |

The extra signal this pass introduced:

- **Per-branch upstream short-name** — `git for-each-ref refs/heads --format='%(refname:short)%09%(upstream:short)'`, mapping each local branch to the ref it tracks (e.g. `origin/master`). The classifier's `tracksForeignUpstream` predicate strips the remote prefix and compares the tracked branch segment to the branch's own name: differ → foreign (a master-tracking orphan); equal → `skip-self-tracking` (a genuine `origin/<own-name>` work branch). A branch with no collected upstream stays `skip-self-tracking` — the conservative direction (never reaped on missing info).
- **No positive merge signal** — unlike the merged-remote pass, this case has *no* PR to key on (the name was never a PR head). The open-PR-head set is therefore used as a **negative guard** only, and a missing/unauthenticated `gh` degrades it to empty (the *less*-safe direction); the dispatch-name + dead-PID + no-attached-worktree + age-floor rails stand as independent backstops, exactly as the dead-branch GC does.
- **Local-only invariant** — there is no `origin/<name>` ref to delete (its absence is precisely why these accumulate), so deleting the local `refs/heads/<name>` is the whole job; the driver's existing text-guard against `git push --delete` covers this pass too.

### Why these signals (and not the obvious ones)

- **Don't trust `git branch --merged origin/master`.** Squash-merges produce a different commit hash than the source branch ever had, so the local branch's tip is never an ancestor of master and `--merged` misses it. The `[gone]`-upstream signal (which `git fetch --prune` refreshes) catches squash-merges correctly.
- **Lock-file format**: `.git/worktrees/<name>/locked` contains text like `claude agent agent-XXX (pid <N>)`. Parse the `(pid <N>)` form — *not* the bare word `pid` — because operator notes and unrelated lock annotations contain that word in English prose. See `parseLockPid` for the regex.
- **Worktree paths span two roots**: `~/hydra/.claude/worktrees/` (default for Claude Code) and `/dev/shm/hydra-worktrees/` (used by Codex; legacy). We iterate via `git worktree list --porcelain` (canonical) rather than scanning either directory, so adding a new root doesn't require code changes.
- **Stuck worktrees**: occasionally `git worktree remove --force` fails (partial dir state). The driver logs these and continues; the skill *does not* auto-`rm -rf` the dir, because that's the kind of destructive thing the operator should approve. `git worktree prune` at the end cleans up metadata for dirs the operator manually deleted between runs.

## Process

### 1. Refresh remote tracking

```bash
git fetch origin --prune
```

This is what makes `[gone]` markers accurate. Without the prune, recently squash-merged PRs still show a live upstream from the previous fetch.

### 2. Collect classifier inputs

```bash
BRANCHES_RAW=$(git branch -vv)
WORKTREES_RAW=$(git worktree list --porcelain)
# plus the per-worktree .git/worktrees/<name>/locked contents
```

### 3. Drive the classifier

The shell driver (`scripts/branch-prune.sh`) builds a single JSON object and pipes it to `scripts/ci/branch-prune-runner.ts`. The runner returns a JSON plan + a human-readable report. The runner is side-effect-free — the shell driver is the only thing that runs `git branch -D` / `git worktree remove`.

```bash
INPUT_JSON=$(jq -nc \
  --arg b "$BRANCHES_RAW" \
  --arg w "$WORKTREES_RAW" \
  --arg c "$(git rev-parse --abbrev-ref HEAD)" \
  --argjson l "$LOCKS_JSON" \
  --argjson a "$AUDIT_JSON" \
  '{branchesRaw: $b, worktreesRaw: $w, currentBranch: $c, locks: $l, audit: $a}')

PLAN=$(printf '%s' "$INPUT_JSON" | npx tsx scripts/ci/branch-prune-runner.ts)
```

### 4. Apply (or print the audit)

In audit mode (default), the driver prints the rendered report and exits 0 with no mutations. With `--apply`:

```bash
# delete-worktree-and-branch entries (worktree first, then branch)
git worktree unlock "$wt"            # idempotent if already unlocked
git worktree remove --force "$wt"
git branch -D "$br"

# delete-branch-only entries
git branch -D "$br"

# delete-branch-no-upstream entries (dead-dispatch leftovers, issue #1784)
git branch -D "$br"

# delete-branch-merged-remote entries (merged/closed PR, zombie remote, issue #2029)
git branch -D "$br"   # LOCAL only — the origin/<name> ref is an operator step

# delete-branch-master-tracking-orphan entries (tracks origin/master, no PR, issue #2459)
git branch -D "$br"   # LOCAL only — there is no origin/<name> ref to touch

# final pass to clean up metadata for hand-removed worktree dirs
git worktree prune
```

The driver does the destructive ops AFTER the classifier has fully classified — never interleave classification and mutation, so a `git branch -D` mid-loop can't change what the next row sees.

### 5. Report

The driver writes a single deterministic report (rendered by `renderReport()` in the pure module). Example:

```
## Hydra Branch Prune — 2026-05-16T04:00:00Z

Scanned: 23 local branches

### Deleted (worktree + branch)
- issue-431-foo  (worktree: /home/gabe/hydra/.claude/worktrees/agent-xyz)
- issue-432-bar  (worktree: /dev/shm/hydra-worktrees/issue-432-...)

### Deleted (branch only)
- issue-430-baz
- worktree-agent-leftover-1

### Skipped — live agent
- issue-440-active  (worktree /home/gabe/hydra/.claude/worktrees/agent-current, pid 12345)

### Skipped — other
- master: master is the current branch — refusing to delete.
```

The full report is appended to `$HYDRA_BRANCH_PRUNE_LOG` (default `/tmp/hydra-branch-prune.log`) and emitted to systemd journal when run via the timer.

## Rules

- Never run `git rebase` or `git push --force` — this skill only operates on *local* state.
- Never delete the current branch. The classifier rejects it; the safety rail in the script rejects the worktree case too.
- Never operate on a `[gone]` branch whose worktree is held by a live PID. Defer to the next run; the next sweep will pick it up after the agent finishes.
- Never `rm -rf` a worktree dir from this skill. If `git worktree remove --force` can't recover, log the path and let the operator review.
- One pass over the local repo, then exit. The systemd timer drives the cadence.

## Audit mode

```bash
scripts/branch-prune.sh           # default: audit-only, prints what would be deleted
scripts/branch-prune.sh --audit   # explicit audit-only
scripts/branch-prune.sh --apply   # actually delete (this is what the timer uses)
```

## Scheduling

A daily systemd timer runs the skill off-peak. Two files under `scripts/systemd/`:

- `hydra-branch-prune.service` — oneshot that invokes `scripts/branch-prune.sh --apply`, output to journal.
- `hydra-branch-prune.timer` — `OnCalendar=*-*-* 04:00:00`, `RandomizedDelaySec=600`, persistent.

Operator install:

```bash
mkdir -p ~/.config/systemd/user
cp scripts/systemd/hydra-branch-prune.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hydra-branch-prune.timer
```

Inspect: `journalctl --user -u hydra-branch-prune` after the timer fires.

We deliberately chose systemd over autopilot's `SIGNAL_CLASSES` (the issue allows either):

- Branch pruning is pure shell work and needs zero LLM reasoning — wiring it through the autopilot decision loop would burn tokens for no benefit.
- The autopilot tick cadence is already crowded with classes that *do* need reasoning (qa, dev, research, sweep, discover).
- Systemd timers are persistent across orchestrator restarts, which matters because most leaks happen during crash-recovery.

If the operator later wants to bring this into the autopilot loop (e.g. to gate on "PR queue is empty"), the migration is small — add `branch_prune` to `SIGNAL_CLASSES`, set a 12h cooldown, and have `decide.py` emit a `dispatch` action for the same script. Until then, systemd carries it.

### Reap-time GC trigger (issue #911)

The daily timer bounds the *steady-state* population, but a worktree leaked at 04:01 would otherwise linger ~24h until the next sweep. To shorten that lag, `scripts/autopilot/reap.py`'s completion path fires `scripts/branch-prune.sh --apply` as a **best-effort** post-step after a worktree-bearing dispatch (`hydra-dev`, `hydra-target-build`, `hydra-qa`) reaps. Notes:

- reap.py never learns the worktree path (the Claude harness, not `dispatch.sh`, creates the worktree), so it cannot tear down by path — it delegates to the GC script, which reclaims orphans on its **own** safety rails (dead PID, age, open-PR head). This means it covers crash-leaks (#898) identically to clean reaps, with a single source of truth for the rails.
- Fully non-fatal: a missing script, a non-zero exit, or a timeout is logged to the run log (`worktree_gc_ok` / `worktree_gc_nonzero` / `worktree_gc_skipped`) and swallowed — it can never block or fail the reap path.
- Idempotent across rapid reaps (`git worktree remove` / `branch -D` no-op once gone).
- Operator opt-out: `HYDRA_REAP_WORKTREE_GC=0` disables the reap-time trigger; the daily timer still runs.

## Failure modes

- **Refusing to run from inside a worktree**: exit 3. Surface to operator; never auto-fix by `cd ~/hydra` because the operator may have unrelated work going on there.
- **`jq` or `npx` missing**: exit 127. Install per the README's deps.
- **Classifier produces no output**: exit 4 BEFORE any destructive op. This catches the case where `tsx` crashed silently.
- **Per-branch `git worktree remove` failure**: logged; counted in the error tally; does NOT prevent subsequent branches from being processed. Skill exits 1 if any per-branch error occurred.
- **Per-branch `git branch -D` failure**: same handling as above.
- **Live PID becomes dead between the classifier and the driver**: harmless. The next run picks up the branch (now `[gone]` + no live PID) and prunes it.
- **`gh` missing / unauthenticated (worktree-orphan GC)**: the open-PR-head set degrades to empty, making the GC *more* conservative — it then relies on dead-PID + age alone. It never becomes less safe.
- **`stat` fails for a worktree dir**: that worktree's age is reported as unknown, which the classifier treats as `skip-too-young` — it is never reclaimed on an unknown age.
- **Ref age unavailable (dead-branch GC)**: a branch with no reflog entry AND no readable tip committer date is omitted from the `branchAges` map → unknown age → `skip-too-young`, never deleted.
- **`gh` missing / unauthenticated (dead-branch GC)**: the open-PR-head rail degrades to empty — see the note in "Dead-branch GC actions" above; the remaining rails hold and only local refs are deleted, so an open PR's remote branch is never at risk.
- **`gh` missing / unauthenticated (merged-remote GC)**: the merged/closed-PR set degrades to empty. Because that set is this pass's *sole* delete trigger, the pass becomes a total no-op — it can never delete a branch without a positive MERGED/CLOSED signal. The safe direction.

## Worktree-orphan GC acceptance criteria (issue #911)

- [x] Root-cause analysis (see "Two reclamation passes"): the 338 local-only branches / ~119 reclaimable worktrees are QA + crashed-dev worktrees that never had an upstream and so are invisible to the `[gone]` pass forever.
- [x] A permanent mechanism reclaims local-only orphaned worktrees (no upstream, dead/no PID, not an open-PR head, past the age floor) — `classifyWorktreeOrphans` in `scripts/ci/branch-prune.ts`, driven by `scripts/branch-prune.sh`.
- [x] Never removes a worktree held by a live PID (`skip-live-agent`, checked before age) and never deletes the current branch (`skip-current-worktree` / `skip-main-worktree`). Covered by `test/hydra-branch-prune.test.mts`.
- [x] Steady-state population is bounded: every reaped dispatch triggers the GC (reap.py) and the daily timer is the backstop, so orphans no longer monotonically accumulate.
- [x] `npm run typecheck:test` and `npm test` pass; the pure classifier change is covered by `test/hydra-branch-prune.test.mts`.

## Dead-branch GC acceptance criteria (issue #1784)

- [x] A new `delete-branch-no-upstream` action handles local branches with no upstream, no open PR, past the age floor, and not checked out in any live worktree — `classifyDeadBranch` / `classifyDeadBranches` in `scripts/ci/branch-prune.ts`, driven by `scripts/branch-prune.sh`.
- [x] Branches with no upstream that ARE checked out in a live-PID worktree classify as `skip-live-agent`; open-PR heads as `skip-open-pr-head`; under-floor/unknown-age as `skip-too-young`. Covered by `test/hydra-branch-prune.test.mts`.
- [x] Operator-made branches are never eligible — the dispatch-name rail (`skip-not-dispatch-branch`) restricts deletion to `issue-*` / `worktree-agent-*` / `agent-*` / `pr-<N>*` names.
- [x] `npm test` and `npm run typecheck:test` pass.

## Merged-remote GC acceptance criteria (issue #2029)

- [x] A new `delete-branch-merged-remote` action reclaims local branches with a LIVE (non-gone) upstream whose PR is MERGED/CLOSED — the squash-merge-with-zombie-remote case that passes 1 (`skip-not-gone`) and 3 (`skip-has-upstream`) both miss — `classifyMergedRemote` / `classifyMergedRemotes` in `scripts/ci/branch-prune.ts`, driven by `scripts/branch-prune.sh`.
- [x] **Local-only invariant preserved**: the pass deletes the LOCAL ref only; the driver is text-guarded against `git push --delete` / colon-refspec remote deletion. Reclaiming the zombie `origin/*` ref is an operator step (see below). Covered by `test/hydra-branch-prune.test.mts`.
- [x] No positive merge signal → no deletion: an empty merged/closed set (gh absent/unauthenticated, or PR still open) classifies every branch `skip-pr-unresolved` → the pass is a no-op. Covered by `test/hydra-branch-prune.test.mts`.
- [x] Operator branches never eligible (dispatch-name rail); live-PID worktrees, open-PR heads, attached worktrees, and under-floor/unknown-age branches all skip with their precise reasons. Covered by `test/hydra-branch-prune.test.mts`.
- [x] The shared 250-deletion hard cap spans this pass too (seeded with the prior three passes' counts). Covered by `test/hydra-branch-prune.test.mts`.
- [x] `npm test` and `npm run typecheck:test` pass.

## Master-tracking-orphan GC acceptance criteria (issue #2459)

- [x] **Root-cause analysis** (see "Five reclamation passes"): the 108 surviving `worktree-agent-*` branches escape all four prior passes because ~104 track `origin/master` (a live, never-`[gone]` upstream) and were never PR heads — pass 1 `skip-not-gone`, pass 3 `skip-has-upstream`, pass 4 `skip-pr-unresolved`. The structural gap is a missing *classification*, not a missing cleanup mechanism (the daily timer + reap-time trigger already run).
- [x] A new `delete-branch-master-tracking-orphan` action reclaims local dispatch branches that track a **foreign upstream** (e.g. `origin/master`), were never pushed under their own name, have no open PR, no live/attached worktree, and are past the age floor — `classifyMasterTrackingOrphan` / `classifyMasterTrackingOrphans` in `scripts/ci/branch-prune.ts`, driven by `scripts/branch-prune.sh` (per-branch `%(upstream:short)` enumeration → `branchUpstreams` input).
- [x] **Foreign-upstream is the sole distinguishing predicate**: a branch self-tracking `origin/<own-name>` is a genuine work branch and classifies `skip-self-tracking` (dropped, never reaped); `tracksForeignUpstream` derives this by comparing the tracked branch segment to the branch's own name. Covered by `test/hydra-branch-prune.test.mts`.
- [x] **Local-only invariant preserved**: there is no `origin/<name>` ref to touch, so the pass deletes the LOCAL ref only; the driver's existing `git push --delete` text-guard covers it. Covered by `test/hydra-branch-prune.test.mts`.
- [x] **Negative open-PR guard + gh-absent backstops**: with no positive merge signal, the open-PR-head set preserves an open-PR head (`skip-open-pr-head`), and a missing `gh` degrades it to empty — the dispatch-name + dead-PID + no-attached-worktree + age-floor rails stand as independent backstops. Operator branches never eligible (dispatch-name rail). Covered by `test/hydra-branch-prune.test.mts`.
- [x] The shared 250-deletion hard cap spans this pass too (seeded with the prior four passes' counts). Covered by `test/hydra-branch-prune.test.mts`.
- [x] The `/dev/shm` stale-worktree half of the originating issue is **already covered by pass 2** (worktree-orphan GC, #911) which keys on `git worktree list` across both roots and age-gates at 6h — no new code; this pass is scoped to **branches only**.
- [x] `npm test` and `npm run typecheck:test` pass.

### Clearing the standing zombie remotes (operator step)

The merged-remote pass clears the **local** half autonomously. The standing **remote** half — the ~160 surviving `origin/<name>` refs whose PRs are merged/closed — is an external-account mutation (ADR-0005) and is **not** done by this skill or any dev dispatch. To clear them, the operator runs a one-off remote-delete sweep, after which the local refs go `[gone]` and the existing pass 1 reaps them on the next run:

```bash
# Audit first — list merged/closed PR head branches whose remote ref survives:
gh pr list --state all --limit 1000 --json headRefName,state \
  --jq '.[] | select(.state == "MERGED" or .state == "CLOSED") | .headRefName' \
  | while read -r b; do git ls-remote --exit-code --heads origin "$b" >/dev/null 2>&1 && echo "$b"; done

# Then delete the remote refs (operator-gated — review the list first):
#   gh api -X DELETE "repos/{owner}/{repo}/git/refs/heads/$b"   # or: git push origin --delete "$b"
```

Going forward, auto-merge `--delete-branch` (enabled 2026-05-28) prevents new zombie remotes; this step is a one-time cleanup of the accumulated backlog the issue calls out.

## Acceptance criteria (issue #443)

- [x] `~/.claude/skills/hydra-branch-prune/SKILL.md` is generated from this playbook by `scripts/sync-skills.sh`.
- [x] Dry-run mode (`--audit`) prints what would be deleted without acting.
- [x] Live-agent detection verified by `test/hydra-branch-prune.test.mts` — a worktree whose lock-file PID is alive is NOT removed.
- [x] The skill is run via a daily systemd timer at 04:00 local with `--apply`. Documented above; choice of systemd over autopilot is explicit.
- [x] Output captured to `/tmp/hydra-branch-prune.log` (operator-overridable via `$HYDRA_BRANCH_PRUNE_LOG`).

## Tier

Tier 2 (new automation; new test). No Untouchable Core changes — verified against `src/untouchable.ts`. The live tier classifier is the authoritative answer; the PR body carries `Tier:` from the API.
