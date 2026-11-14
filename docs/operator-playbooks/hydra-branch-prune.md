---
name: hydra-branch-prune
description: Periodic cleanup of stale local branches and worktrees from completed agent dispatches. Detects [gone]-upstream branches, force-unlocks stale worktree locks (skipping live Claude agents), removes the worktrees, and deletes the branches.
when_to_use: "When the operator says 'prune branches' or 'clean stale worktrees', or after the daily merge wave."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
---

# Hydra Branch Prune

Reclaim local branches and worktrees that dispatches left behind. `scripts/branch-prune.sh` is the whole implementation: it gathers the git state, classifies through `scripts/ci/branch-prune.ts` (pure, pinned by the `test/*branch-prune*.test.mts` files) and only then runs the destructive `git` steps. This playbook says when to run it by hand and how to read what it prints.

Sister to `/hydra-pr-rebase`, which handles open PRs; this handles the post-merge side.

## Who runs it already

- `scripts/systemd/hydra-branch-prune.timer` runs `--apply` daily at 04:00 (`journalctl --user -u hydra-branch-prune`).
- `scripts/autopilot/reap.py` runs `--apply` best-effort after a worktree-bearing reap; `HYDRA_REAP_WORKTREE_GC=0` turns that trigger off.

Run it by hand only to look at what is accumulating, or after a merge wave when you do not want to wait for the timer.

## When NOT to run this

- From inside a worktree: the script refuses (exit 3). Run it from the main checkout.
- When local git state looks corrupt (`[gone]` markers can lie); run `/hydra-doctor` first.
- Inside a `dev_orch` / `dev_target` subagent.

## Process

```bash
scripts/branch-prune.sh           # audit only (default): prints the report, mutates nothing
scripts/branch-prune.sh --apply   # delete
```

Read the audit first. The report lists, per reclamation pass, what it would delete and every skip with its reason. The five passes are `[gone]` upstream, local-only orphan worktree, never-pushed dead branch, merged-remote zombie branch and master-tracking orphan; the action names and the rails that gate each are in `scripts/ci/branch-prune.ts`.

Skips you should expect and leave alone:

- `skip-live-agent`: a live process holds the worktree lock; the next run retries.
- `skip-too-young`: under the age floor or age unknown; deferred, never deleted.
- `skip-dirty-unpushed`: uncommitted work could not be committed and pushed to its own branch first; the worktree stays and is retried.
- `skip-current-branch` / `skip-cap`: refusing the checked-out branch, or the 250-deletions-per-repo cap.

The script processes the orchestrator repo, then the Target workspace resolved through the target-config seam; an unresolved Target skips that pass with a warning and still exits 0. The report is appended to `$HYDRA_BRANCH_PRUNE_LOG` (default `/tmp/hydra-branch-prune.log`).

Exit codes: 0 on success, including per-branch deletion errors (logged as a WARNING and retried next run); 1 when a pass hard-failed (worktree refusal or classifier produced no output; the log line says which); 127 when `jq` or `npx` is missing; 2 for an unknown argument.

## Rules

- Local state only: never `git push --force` or rebase from here.
- Merged-remote entries delete the LOCAL branch only; deleting a surviving `origin/<name>` ref is an operator decision, made after reading the audit.
- Never `rm -rf` a worktree directory; if `git worktree remove --force` fails, log the path for the operator.
- One pass, then exit.
