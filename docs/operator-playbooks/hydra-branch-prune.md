---
name: hydra-branch-prune
description: Periodic cleanup of stale local branches and worktrees from completed agent dispatches. Detects [gone]-upstream branches, force-unlocks stale worktree locks (skipping live Claude agents), removes the worktrees, and deletes the branches.
when_to_use: "When the user says 'prune branches', 'clean stale worktrees', or autopilot wants to garbage-collect after the daily merge wave. Safe to run on a cron from autopilot Phase 4."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
claude_only: true
---

# Hydra Branch Prune

Sister skill to `hydra-pr-rebase` (open-PR side). This one handles the *post-merge* janitorial side: branches whose upstream is gone after a squash-merge, plus the worktrees that were attached to them — AND, since issue #911, the **local-only orphan worktrees** the `[gone]` signal can never reclaim.

After the codex-removal cut-over (ADR-0006) every code-writing dispatch runs inside a `git worktree` under `~/hydra/.claude/worktrees/agent-*` or `/dev/shm/hydra-worktrees/`. When the agent finishes (or crashes, or is force-quit) the worktree often leaks — `git branch -vv` accumulates `[gone]` upstreams and the worktree dirs stay around indefinitely. A single manual sweep on 2026-05-15 cleaned **167 branches and 71 worktrees** in one pass; the orchestrator should not need a human for that.

The skill is one pass over the local repo, then exit. The scheduling cadence is owned by `scripts/systemd/hydra-branch-prune.timer` (see "Scheduling" below) — the skill itself is on-demand.

## Two reclamation passes (root cause — issue #911)

The original skill only ever acted on `[gone]` upstreams. A snapshot on **2026-06-02, taken immediately after a full `--apply` run**, exposed the structural gap:

- **549 local branches / 120 worktrees** still present after the sweep.
- Of those, only **4 branches were `[gone]`**; **338 were local-only with no upstream at all**; 211 had a live upstream (open PRs).
- Of the 123 worktrees, only **4 were held by a live PID** — **98 carried a lock file whose PID was dead**, and 21 had no lock.

**Root cause:** the dominant accumulation source is **local-only worktrees** — QA worktrees (`agent-qa-NNN`, `pr-NNN-qa`), abandoned/crashed dev attempts, and worktrees leaked by the run-termination bug (#898). These are created locally for a single dispatch and **never pushed**, so they never acquire an upstream → never become `[gone]` → the `[gone]`-keyed pass skips them **forever**. Nothing tore them down at dispatch-reap time either.

The fix adds a second pass that closes the gap:

1. **Branch pass (`[gone]`)** — unchanged. Reclaims branches whose upstream is gone after a squash-merge, plus their attached worktrees.
2. **Worktree-orphan GC** (issue #911) — keyed on the *worktree*, not the branch. Reclaims a worktree **regardless of upstream state** when every liveness rail holds (see below).

Both passes share the same 250-deletion hard cap in a single run (the worktree pass is seeded with the branch pass's deletion count), and both refuse to touch a live-PID worktree or the current branch.

## When NOT to run this

- From inside a worktree. `scripts/branch-prune.sh` refuses to run when `git rev-parse --git-dir` points under `.git/worktrees/` — running `git worktree remove --force` while sitting inside a worktree is the textbook way to saw off the branch you're standing on.
- When master is itself broken — squash-merge detection works fine on a broken master, but a corrupted local index can lie about `[gone]` markers. Run `/hydra-doctor` first if anything else feels off.
- Inside a `dev_orch` / `dev_target` subagent — those run in their own worktree (and would be refused by the safety rail anyway). This skill belongs to the autopilot parent context or the daily timer.

## How it decides what to prune

The pure classifier lives at `scripts/ci/branch-prune.ts` and is exercised by `test/hydra-branch-prune.test.mts`. It takes three inputs:

1. `git branch -vv` — every local branch, with the `[<upstream>: gone]` marker for squash-merged / deleted upstreams.
2. `git worktree list --porcelain` — every attached worktree and the branch it has checked out.
3. The body of each `.git/worktrees/<name>/locked` file (if present) — these are the lock notes the Claude harness writes when an agent claims a worktree, and they contain `(pid <N>)` markers for the live process.

The classifier emits one of six actions per branch:

| Action                          | Condition                                                                              | What the driver does                                  |
| ------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `delete-worktree-and-branch`    | Upstream gone; worktree attached; no live PID holding the lock                         | `git worktree unlock` → `git worktree remove --force` → `git branch -D` |
| `delete-branch-only`            | Upstream gone; no attached worktree                                                    | `git branch -D`                                       |
| `skip-live-agent`               | Upstream gone; worktree attached; lock-file PID is a live process (`kill -0` succeeds) | Leave alone; the *next* run will retry once the agent finishes |
| `skip-current-branch`           | Branch IS the currently-checked-out branch                                             | Refuse — never delete the current branch              |
| `skip-not-gone`                 | Upstream is healthy (no `[gone]` marker)                                               | Skip — not a prune candidate                          |
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

The two extra signals the `[gone]` pass never needed:

- **Open-PR-head set** — built from `gh pr list --state open --json headRefName`. A worktree whose branch heads an open PR is preserved even with a dead PID (the PR may still merge). A missing/unauthenticated `gh` degrades to an *empty* set, which only ever makes the GC **more** conservative (it then relies on age + dead-PID alone) — never less.
- **Age floor** — the worktree dir's mtime vs now. Default **6h** (`DEFAULT_WORKTREE_MIN_AGE_SECONDS`), overridable via `HYDRA_WORKTREE_MIN_AGE_SECONDS`. 6h comfortably exceeds the subagent wall-clock cap (default 3600s), so a worktree past the floor whose PID is also dead is unambiguously abandoned. Age is the **last** gate — checked only after the worktree is provably not live and not an open-PR head — so a never-reaped live agent surfaces as `skip-live-agent`, not `skip-too-young`.

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

## Worktree-orphan GC acceptance criteria (issue #911)

- [x] Root-cause analysis (see "Two reclamation passes"): the 338 local-only branches / ~119 reclaimable worktrees are QA + crashed-dev worktrees that never had an upstream and so are invisible to the `[gone]` pass forever.
- [x] A permanent mechanism reclaims local-only orphaned worktrees (no upstream, dead/no PID, not an open-PR head, past the age floor) — `classifyWorktreeOrphans` in `scripts/ci/branch-prune.ts`, driven by `scripts/branch-prune.sh`.
- [x] Never removes a worktree held by a live PID (`skip-live-agent`, checked before age) and never deletes the current branch (`skip-current-worktree` / `skip-main-worktree`). Covered by `test/hydra-branch-prune.test.mts`.
- [x] Steady-state population is bounded: every reaped dispatch triggers the GC (reap.py) and the daily timer is the backstop, so orphans no longer monotonically accumulate.
- [x] `npm run typecheck:test` and `npm test` pass; the pure classifier change is covered by `test/hydra-branch-prune.test.mts`.

## Acceptance criteria (issue #443)

- [x] `~/.claude/skills/hydra-branch-prune/SKILL.md` is generated from this playbook by `scripts/sync-skills.sh`.
- [x] Dry-run mode (`--audit`) prints what would be deleted without acting.
- [x] Live-agent detection verified by `test/hydra-branch-prune.test.mts` — a worktree whose lock-file PID is alive is NOT removed.
- [x] The skill is run via a daily systemd timer at 04:00 local with `--apply`. Documented above; choice of systemd over autopilot is explicit.
- [x] Output captured to `/tmp/hydra-branch-prune.log` (operator-overridable via `$HYDRA_BRANCH_PRUNE_LOG`).

## Tier

Tier 2 (new automation; new test). No Untouchable Core changes — verified against `src/untouchable.ts`. The live tier classifier is the authoritative answer; the PR body carries `Tier:` from the API.
