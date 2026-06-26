#!/usr/bin/env bash
#
# branch-prune.sh — daily janitor for [gone] local branches + their worktrees
# (issue #443; extended in #542 to cover the target repo).
#
# After the codex-removal cut-over (ADR-0006), every code-writing dispatch
# runs inside a `git worktree`:
#  - `hydra-dev` against `~/hydra` under `.claude/worktrees/agent-*` or
#    `/dev/shm/hydra-worktrees/issue-*`
#  - `hydra-target-build` against `~/hydra-betting` under
#    `/dev/shm/hydra-worktrees/hydra-betting-worktree-*` (added by #542)
#
# When an agent finishes (or crashes) the worktree often leaks — `git branch -vv`
# accumulates `[gone]` upstreams and the worktree dirs stick around forever.
# A single manual sweep on 2026-05-15 cleaned 167 branches and 71 worktrees in
# one pass; the orchestrator should not need a human for that.
#
# This script is the cron-driven side of the `hydra-branch-prune` skill. It
# delegates the classification to scripts/ci/branch-prune.ts (via the runner
# at scripts/ci/branch-prune-runner.ts) so the safety logic is unit-testable;
# the script itself is just glue (`git`, a `kill -0` PID check, the lock-file
# map) plus the destructive ops (`git worktree remove`, `git branch -D`).
#
# Default: dry-run (audit-only). The systemd timer wrapper passes --apply.
#
# Usage:
#   scripts/branch-prune.sh                  # audit-only (default)
#   scripts/branch-prune.sh --audit          # explicit audit-only
#   scripts/branch-prune.sh --apply          # actually delete
#   scripts/branch-prune.sh --log /path.log  # tee the report to a log file
#   scripts/branch-prune.sh --help
#
# Two-repo pass (issue #542 — scope-justification: the pre-existing
# single-repo loop was the only code path that GC'd worktrees, and target
# worktrees would otherwise leak forever):
#   Pass 1: ~/hydra            (orchestrator — original behavior)
#   Pass 2: ~/hydra-betting    (target — added so dev_target worktrees GC too)
# The classifier helper is pure, so it runs unchanged against either repo.
# A missing target repo is treated as a no-op (silent skip, exit 0).
#
# Safety rails (enforced both in this script AND in the classifier):
#  - Refuses to run from inside a worktree (must be a main working tree).
#  - Never deletes the current branch.
#  - Never deletes a branch whose attached worktree is held by a live PID.
#  - Hard cap of 250 deletions per run, applied INDEPENDENTLY per repo.

set -uo pipefail

APPLY=0
LOG_FILE="${HYDRA_BRANCH_PRUNE_LOG:-/tmp/hydra-branch-prune.log}"

print_help() {
  sed -n '2,46p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --audit|--dry-run|-n) APPLY=0; shift ;;
    --log) LOG_FILE="$2"; shift 2 ;;
    -h|--help) print_help; exit 0 ;;
    *) echo "branch-prune: unknown arg $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

command -v npx >/dev/null || { echo "branch-prune: npx required (uses tsx for the classifier)" >&2; exit 127; }
command -v jq  >/dev/null || { echo "branch-prune: jq required" >&2; exit 127; }

# Aggregate counters across both passes. Hard failures bump TOTAL_HARD_ERRORS
# (non-zero exit at end); per-branch errors bump TOTAL_SOFT_ERRORS (logged
# WARNING, exit 0 — see issue #494).
TOTAL_HARD_ERRORS=0
TOTAL_SOFT_ERRORS=0

# prune_repo <label> <repo-root>
#
# Run the full classify-and-apply pass over a single repo. Pure subshell —
# `cd`s inside, so the caller's cwd is not affected.
#
# Exit-code contract:
#  - 0  → success (or per-branch soft errors only; soft count printed as `SOFT:<N>`)
#  - >0 → hard failure (worktree refusal, missing tool, classifier no-output)
prune_repo() {
  local LABEL="$1"
  local REPO="$2"

  if [ ! -d "$REPO/.git" ]; then
    echo "branch-prune: [$LABEL] $REPO has no .git — skipping."
    return 0
  fi

  # Run the per-repo body in a subshell so cd/local state doesn't leak. Capture
  # the soft-error count via a sentinel line on stdout (`__SOFT_ERRORS__:<N>`),
  # parsed by the caller. This avoids needing a temp file.
  local OUTPUT
  OUTPUT=$(
    set -uo pipefail
    cd "$REPO" || { echo "branch-prune: [$LABEL] cd $REPO failed" >&2; exit 3; }

    # Safety rail 1: must run from the main working tree, not a worktree.
    # Running `git worktree remove --force` from inside a worktree is the
    # textbook way to saw off your own branch.
    local GIT_DIR
    GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || echo "")
    case "$GIT_DIR" in
      *"/.git/worktrees/"*)
        echo "branch-prune: [$LABEL] refusing to run from inside a worktree (cwd=$(pwd), git-dir=$GIT_DIR)" >&2
        echo "branch-prune: [$LABEL] run from the main $REPO working tree instead." >&2
        exit 3
        ;;
    esac

    # Refresh remote tracking so [gone] markers are current. Without this,
    # recently squash-merged PRs still have a live upstream from the previous
    # fetch.
    echo "branch-prune: [$LABEL] git fetch origin --prune"
    git fetch origin --prune 2>&1 | sed "s/^/  [$LABEL] /" || true

    # Early prune (issue #2115): reconcile worktree metadata BEFORE any
    # branch-delete pass. A dispatch worktree under /dev/shm (tmpfs) can vanish
    # on reboot while git's `.git/worktrees/<name>` metadata persists — git then
    # still believes the branch is "used by worktree at /dev/shm/..." and a
    # later `git branch -D` fails with that exact error, even though the dir is
    # long gone. `git worktree prune` is git's own sanctioned metadata
    # reconciliation: it drops administrative entries whose worktree dir no
    # longer exists, releasing the branch->worktree binding so the subsequent
    # delete passes succeed. It is a safe no-op when there is no stale metadata,
    # and never makes any pass less conservative (it only frees branches git
    # itself agrees are no longer in use). We deliberately do NOT `rm -rf` the
    # /dev/shm dir — metadata reconciliation, not directory deletion, is the
    # fix (the established 6h age floor from #1773 still guards live cycles).
    # The end-of-pass prune below stays — it cleans metadata for worktree dirs
    # removed DURING this run.
    echo "branch-prune: [$LABEL] git worktree prune (pre-delete metadata reconcile)"
    git worktree prune 2>&1 | sed "s/^/  [$LABEL] /" || true

    # Collect inputs for the classifier:
    #   1. `git branch -vv` for [gone] detection + current-branch marker
    #   2. `git worktree list --porcelain` for attached-worktree lookup
    #   3. Each worktree's `.git/worktrees/<name>/locked` file (if present)
    local BRANCHES_RAW WORKTREES_RAW
    BRANCHES_RAW=$(git branch -vv 2>/dev/null || true)
    WORKTREES_RAW=$(git worktree list --porcelain 2>/dev/null || true)

    # Build a JSON map of {worktreePath: lockBody} AND {worktreePath: ageSeconds}.
    # The age map feeds the worktree-orphan GC (issue #911): a worktree's dir
    # mtime is the cheapest available "last touched" signal, and the GC defers
    # any worktree younger than its age floor so an in-flight dispatch that
    # hasn't taken its lock yet is never reaped.
    local -a LOCK_ENTRIES=()
    local -a AGE_ENTRIES=()
    local line wt_path wt_name lockfile body now mtime age
    now=$(date +%s)
    while IFS= read -r line; do
      case "$line" in
        "worktree "*)
          wt_path="${line#worktree }"
          wt_name="${wt_path##*/}"
          lockfile=".git/worktrees/${wt_name}/locked"
          if [ -f "$lockfile" ]; then
            body=$(cat "$lockfile" 2>/dev/null || true)
            LOCK_ENTRIES+=("$(jq -nc --arg p "$wt_path" --arg b "$body" '{($p): $b}')")
          fi
          # Age = now - dir mtime. `stat` may fail for the main worktree's own
          # path on some platforms; tolerate by simply omitting the entry (the
          # classifier treats a missing age as "unknown" → skip, never delete).
          mtime=$(stat -c %Y "$wt_path" 2>/dev/null || stat -f %m "$wt_path" 2>/dev/null || echo "")
          if [ -n "$mtime" ]; then
            age=$((now - mtime))
            [ "$age" -lt 0 ] && age=0
            AGE_ENTRIES+=("$(jq -nc --arg p "$wt_path" --argjson s "$age" '{($p): $s}')")
          fi
          ;;
      esac
    done <<<"$WORKTREES_RAW"

    local LOCKS_JSON AGES_JSON
    if [ ${#LOCK_ENTRIES[@]} -eq 0 ]; then
      LOCKS_JSON='{}'
    else
      LOCKS_JSON=$(printf '%s\n' "${LOCK_ENTRIES[@]}" | jq -s 'add // {}')
    fi
    if [ ${#AGE_ENTRIES[@]} -eq 0 ]; then
      AGES_JSON='{}'
    else
      AGES_JSON=$(printf '%s\n' "${AGE_ENTRIES[@]}" | jq -s 'add // {}')
    fi

    # Per-branch ref ages (issue #1784) — feeds the dead-branch GC's age
    # floor. Age = now - the ref's last reflog update (the moment the branch
    # was created or last moved), falling back to the tip committer date when
    # the reflog is unavailable. The reflog signal matters: a branch freshly
    # cut from master has an OLD tip commit but a NEW reflog entry, and the
    # floor must protect it. A branch with neither signal is simply omitted —
    # the classifier treats unknown age as skip, never delete.
    local -a BRANCH_AGE_ENTRIES=()
    local br_name br_ts br_age
    while IFS= read -r br_name; do
      [ -z "$br_name" ] && continue
      br_ts=$(git log -g -1 --format=%ct "refs/heads/$br_name" -- 2>/dev/null | head -1)
      [ -z "$br_ts" ] && br_ts=$(git log -1 --format=%ct "refs/heads/$br_name" -- 2>/dev/null | head -1)
      [ -z "$br_ts" ] && continue
      br_age=$((now - br_ts))
      [ "$br_age" -lt 0 ] && br_age=0
      BRANCH_AGE_ENTRIES+=("$(jq -nc --arg n "$br_name" --argjson s "$br_age" '{($n): $s}')")
    done < <(git for-each-ref refs/heads --format='%(refname:short)' 2>/dev/null)

    local BRANCH_AGES_JSON
    if [ ${#BRANCH_AGE_ENTRIES[@]} -eq 0 ]; then
      BRANCH_AGES_JSON='{}'
    else
      BRANCH_AGES_JSON=$(printf '%s\n' "${BRANCH_AGE_ENTRIES[@]}" | jq -s 'add // {}')
    fi

    # Per-branch upstream short-names (issue #2459) — feeds the master-tracking-
    # orphan GC's foreign-upstream predicate. A dispatch branch created via
    # `git worktree add` / `checkout -b` can INHERIT `origin/master` as its
    # upstream (rather than `origin/<own-name>`); such a branch never goes
    # `[gone]` and was never a PR head, so the first four passes skip it forever.
    # `%(upstream:short)` renders the tracked ref (e.g. `origin/master`) or an
    # empty string when the branch has no configured upstream. We map only
    # branches WITH an upstream; an absent entry leaves upstreamRef null in the
    # classifier → the branch is out of that pass's scope (conservative no-op).
    # Read-only `git for-each-ref` enumeration — no mutation, no remote calls.
    local -a BRANCH_UPSTREAM_ENTRIES=()
    local bu_name bu_up
    while IFS=$'\t' read -r bu_name bu_up; do
      [ -z "$bu_name" ] && continue
      [ -z "$bu_up" ] && continue
      BRANCH_UPSTREAM_ENTRIES+=("$(jq -nc --arg n "$bu_name" --arg u "$bu_up" '{($n): $u}')")
    done < <(git for-each-ref refs/heads --format='%(refname:short)%09%(upstream:short)' 2>/dev/null)

    local BRANCH_UPSTREAMS_JSON
    if [ ${#BRANCH_UPSTREAM_ENTRIES[@]} -eq 0 ]; then
      BRANCH_UPSTREAMS_JSON='{}'
    else
      BRANCH_UPSTREAMS_JSON=$(printf '%s\n' "${BRANCH_UPSTREAM_ENTRIES[@]}" | jq -s 'add // {}')
    fi

    # Open-PR head branches — a worktree whose branch heads an open PR is
    # preserved even when its lock PID is dead (the PR may still merge). A
    # missing/unauthenticated `gh` degrades to an empty set: the GC then
    # protects nothing on this signal, so it relies on age + dead-PID alone.
    # That is the safe direction — it only ever makes the GC MORE conservative
    # for branches it would otherwise have reclaimed.
    # We resolve the repo from this clone's `origin` remote (via `gh`'s own
    # inference) rather than hard-coding a slug, so the same code path works for
    # both the orchestrator and target passes.
    local OPEN_PR_HEADS_JSON
    if command -v gh >/dev/null 2>&1; then
      OPEN_PR_HEADS_JSON=$(gh pr list --state open --limit 1000 \
        --json headRefName --jq '[.[].headRefName]' 2>/dev/null || echo '[]')
    else
      OPEN_PR_HEADS_JSON='[]'
    fi
    [ -z "$OPEN_PR_HEADS_JSON" ] && OPEN_PR_HEADS_JSON='[]'

    # Merged/closed-PR head branches (issue #2029) — the positive merge signal
    # for the merged-remote GC pass. A squash-merge that did NOT --delete-branch
    # leaves `origin/<name>` alive, so the local upstream never goes [gone] and
    # the first three passes never reclaim it. `gh pr list --state all` returns
    # OPEN+CLOSED+MERGED; we keep only the headRefNames whose state is
    # MERGED or CLOSED (the dead ones). A missing/unauthenticated `gh` degrades
    # to an EMPTY set → the merged-remote pass deletes NOTHING (it only ever
    # acts on a positive merge signal, never on its absence). We use the same
    # 1000 limit as the open query; standing accumulation that exceeds it is
    # reclaimed across successive daily runs (the cap is per-pass, not a
    # one-shot requirement).
    local MERGED_CLOSED_PR_HEADS_JSON
    if command -v gh >/dev/null 2>&1; then
      MERGED_CLOSED_PR_HEADS_JSON=$(gh pr list --state all --limit 1000 \
        --json headRefName,state \
        --jq '[.[] | select(.state == "MERGED" or .state == "CLOSED") | .headRefName]' \
        2>/dev/null || echo '[]')
    else
      MERGED_CLOSED_PR_HEADS_JSON='[]'
    fi
    [ -z "$MERGED_CLOSED_PR_HEADS_JSON" ] && MERGED_CLOSED_PR_HEADS_JSON='[]'

    local CURRENT_BRANCH MAIN_WT
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "master")
    # The main working tree is the first stanza of `git worktree list` — it is
    # the top-level repo dir, never under `.git/worktrees/`.
    MAIN_WT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$REPO")

    local AUDIT_JSON
    if [ "$APPLY" -eq 1 ]; then AUDIT_JSON=false; else AUDIT_JSON=true; fi

    # Age floor override (seconds). Default lives in the classifier (6h).
    local MIN_AGE_JSON
    MIN_AGE_JSON="${HYDRA_WORKTREE_MIN_AGE_SECONDS:-null}"

    local INPUT_JSON PLAN REPORT
    INPUT_JSON=$(jq -nc \
      --arg b "$BRANCHES_RAW" \
      --arg w "$WORKTREES_RAW" \
      --arg c "$CURRENT_BRANCH" \
      --arg m "$MAIN_WT" \
      --argjson l "$LOCKS_JSON" \
      --argjson ag "$AGES_JSON" \
      --argjson ba "$BRANCH_AGES_JSON" \
      --argjson bu "$BRANCH_UPSTREAMS_JSON" \
      --argjson ph "$OPEN_PR_HEADS_JSON" \
      --argjson mc "$MERGED_CLOSED_PR_HEADS_JSON" \
      --argjson mn "$MIN_AGE_JSON" \
      --argjson a "$AUDIT_JSON" \
      '{branchesRaw: $b, worktreesRaw: $w, currentBranch: $c, mainWorktreePath: $m,
        locks: $l, worktreeAges: $ag, branchAges: $ba, branchUpstreams: $bu,
        openPrHeads: $ph, mergedOrClosedPrHeads: $mc, minAgeSeconds: $mn, audit: $a}')

    PLAN=$(printf '%s' "$INPUT_JSON" | npx -y tsx "$REPO_ROOT/scripts/ci/branch-prune-runner.ts")
    if [ -z "$PLAN" ]; then
      echo "branch-prune: [$LABEL] classifier produced no output — aborting (no destructive ops)." >&2
      exit 4
    fi

    REPORT=$(printf '%s' "$PLAN" | jq -r '.report')
    echo "===== branch-prune pass: $LABEL ($REPO) ====="
    echo "$REPORT"
    if [ -n "$LOG_FILE" ]; then
      {
        printf '===== branch-prune pass: %s (%s) =====\n' "$LABEL" "$REPO"
        printf '%s\n' "$REPORT"
      } >> "$LOG_FILE" || true
    fi

    if [ "$APPLY" -ne 1 ]; then
      echo
      echo "branch-prune: [$LABEL] audit-only — no changes made. Pass --apply to act on the plan above."
      echo "__SOFT_ERRORS__:0"
      exit 0
    fi

    # Apply the plan. We deliberately do the destructive ops AFTER the
    # classifier has fully classified — never interleave classification and
    # mutation, so a `git branch -D` mid-loop can't change what the next row
    # sees.
    local ERRORS=0
    local entry br wt

    while IFS= read -r entry; do
      [ -z "$entry" ] && continue
      br=$(printf '%s' "$entry" | jq -r '.branch')
      wt=$(printf '%s' "$entry" | jq -r '.worktreePath')
      echo "branch-prune: [$LABEL] removing worktree $wt and branch $br"
      git worktree unlock "$wt" 2>/dev/null || true
      if ! git worktree remove --force "$wt" 2>&1 | sed "s/^/  [$LABEL] /"; then
        echo "  branch-prune: [$LABEL] worktree remove failed for $wt — leaving branch $br alone" >&2
        ERRORS=$((ERRORS+1))
        continue
      fi
      if ! git branch -D "$br" 2>&1 | sed "s/^/  [$LABEL] /"; then
        echo "  branch-prune: [$LABEL] branch -D failed for $br" >&2
        ERRORS=$((ERRORS+1))
      fi
    done < <(printf '%s' "$PLAN" | jq -c '.plan.deleteWorktreeAndBranch[]')

    while IFS= read -r br; do
      [ -z "$br" ] && continue
      echo "branch-prune: [$LABEL] deleting branch $br"
      if ! git branch -D "$br" 2>&1 | sed "s/^/  [$LABEL] /"; then
        echo "  branch-prune: [$LABEL] branch -D failed for $br" >&2
        ERRORS=$((ERRORS+1))
      fi
    done < <(printf '%s' "$PLAN" | jq -r '.plan.deleteBranchOnly[]')

    # Worktree-orphan GC (issue #911): reclaim local-only orphan worktrees the
    # [gone]-branch passes above never see. Same order as delete-worktree-and-
    # branch — remove the worktree first, then delete its branch (if any; a
    # detached worktree has none). A failure to remove the worktree leaves the
    # branch alone, exactly like the [gone] path.
    while IFS= read -r entry; do
      [ -z "$entry" ] && continue
      wt=$(printf '%s' "$entry" | jq -r '.worktreePath')
      br=$(printf '%s' "$entry" | jq -r '.branch // ""')
      echo "branch-prune: [$LABEL] reclaiming orphan worktree $wt${br:+ and branch $br}"
      git worktree unlock "$wt" 2>/dev/null || true
      if ! git worktree remove --force "$wt" 2>&1 | sed "s/^/  [$LABEL] /"; then
        echo "  branch-prune: [$LABEL] orphan worktree remove failed for $wt — leaving branch ${br:-<detached>} alone" >&2
        ERRORS=$((ERRORS+1))
        continue
      fi
      if [ -n "$br" ]; then
        if ! git branch -D "$br" 2>&1 | sed "s/^/  [$LABEL] /"; then
          echo "  branch-prune: [$LABEL] branch -D failed for orphan $br" >&2
          ERRORS=$((ERRORS+1))
        fi
      fi
    done < <(printf '%s' "$PLAN" | jq -c '.plan.deleteOrphanWorktree[]')

    # Dead-branch GC (issue #1784): never-pushed dead-dispatch branches — no
    # upstream (invisible to the [gone] pass), worktree already reaped
    # (invisible to the orphan GC). The classifier guarantees these are
    # dispatch-shaped names, not the current branch, not an open-PR head, not
    # checked out anywhere, and past the age floor — so a plain branch -D is
    # all that's left. `// []` tolerates an older runner emitting no such key.
    while IFS= read -r br; do
      [ -z "$br" ] && continue
      echo "branch-prune: [$LABEL] deleting dead-dispatch branch $br (no upstream, no PR)"
      if ! git branch -D "$br" 2>&1 | sed "s/^/  [$LABEL] /"; then
        echo "  branch-prune: [$LABEL] branch -D failed for dead-dispatch $br" >&2
        ERRORS=$((ERRORS+1))
      fi
    done < <(printf '%s' "$PLAN" | jq -r '.plan.deleteBranchNoUpstream // [] | .[]')

    # Merged-remote GC (issue #2029): local refs of MERGED/CLOSED PRs whose
    # remote branch was never deleted (zombie origin ref → upstream never
    # [gone], so passes 1 and 3 both skip them). The classifier guarantees a
    # positive merge signal, a dispatch-shaped name, not the current branch,
    # no live/attached worktree, and past the age floor — so a plain LOCAL
    # `git branch -D` is all that's left. We deliberately do NOT touch the
    # remote ref: `git push origin --delete` is an external-account action
    # (ADR-0005) and stays an operator step. `// []` tolerates an older runner.
    while IFS= read -r br; do
      [ -z "$br" ] && continue
      echo "branch-prune: [$LABEL] deleting merged-remote local branch $br (PR merged/closed, zombie remote ref left for operator)"
      if ! git branch -D "$br" 2>&1 | sed "s/^/  [$LABEL] /"; then
        echo "  branch-prune: [$LABEL] branch -D failed for merged-remote $br" >&2
        ERRORS=$((ERRORS+1))
      fi
    done < <(printf '%s' "$PLAN" | jq -r '.plan.deleteBranchMergedRemote // [] | .[]')

    # Master-tracking-orphan GC (issue #2459): dispatch branches that INHERITED
    # `origin/master` as their upstream (via `git worktree add` / `checkout -b`)
    # and were never pushed under their own name. The upstream is healthy and
    # non-[gone] forever, and the name was never a PR head, so passes 1/3/4 all
    # skip them permanently. The classifier guarantees a foreign-upstream signal,
    # a dispatch-shaped name, not the current branch, no live/attached worktree,
    # not an open-PR head, and past the age floor — so a plain LOCAL
    # `git branch -D` is all that's left. There is no `origin/<name>` remote ref
    # to touch (its absence is exactly why these accumulate), so the local-only
    # invariant (ADR-0005) is naturally airtight. `// []` tolerates an older runner.
    while IFS= read -r br; do
      [ -z "$br" ] && continue
      echo "branch-prune: [$LABEL] deleting master-tracking-orphan local branch $br (tracks origin/master, never pushed under its own name)"
      if ! git branch -D "$br" 2>&1 | sed "s/^/  [$LABEL] /"; then
        echo "  branch-prune: [$LABEL] branch -D failed for master-tracking-orphan $br" >&2
        ERRORS=$((ERRORS+1))
      fi
    done < <(printf '%s' "$PLAN" | jq -r '.plan.deleteBranchMasterTrackingOrphan // [] | .[]')

    # Final pass: prune metadata for manually-deleted worktree dirs.
    echo "branch-prune: [$LABEL] git worktree prune"
    git worktree prune 2>&1 | sed "s/^/  [$LABEL] /" || true

    echo "branch-prune: [$LABEL] done (per-branch errors: $ERRORS)."
    # Sentinel for the caller — parsed below.
    echo "__SOFT_ERRORS__:$ERRORS"
    exit 0
  )
  local RC=$?

  # Print the captured output back to the user (minus the sentinel line).
  printf '%s\n' "$OUTPUT" | grep -v '^__SOFT_ERRORS__:' || true

  if [ "$RC" -ne 0 ]; then
    TOTAL_HARD_ERRORS=$((TOTAL_HARD_ERRORS + 1))
    return 0
  fi

  # Extract the sentinel — defaults to 0 if absent (shouldn't happen on RC=0).
  local SOFT
  SOFT=$(printf '%s\n' "$OUTPUT" | grep '^__SOFT_ERRORS__:' | tail -1 | cut -d: -f2)
  SOFT=${SOFT:-0}
  TOTAL_SOFT_ERRORS=$((TOTAL_SOFT_ERRORS + SOFT))
  return 0
}

# Pass 1: orchestrator repo (~/hydra). The historical single-repo behavior.
prune_repo "orchestrator" "$REPO_ROOT"

# Pass 2: target repo (~/hydra-betting). Added in issue #542 so the worktrees
# created by hydra-target-build Step 0.6 are GC'd by the same daily timer.
# A missing target repo is a silent no-op — orchestrators that run without a
# target should not be alarmed.
TARGET_REPO="${HYDRA_TARGET_REPO:-$HOME/hydra-betting}"
prune_repo "target" "$TARGET_REPO"

if [ "$TOTAL_HARD_ERRORS" -gt 0 ]; then
  echo "branch-prune: hard failure in $TOTAL_HARD_ERRORS pass(es) — see log above." >&2
  exit 1
fi

if [ "$TOTAL_SOFT_ERRORS" -gt 0 ]; then
  # Per-branch errors are non-fatal by design — the next timer run picks them
  # up (e.g. a worktree lock held by a dead PID will clear once the lock is
  # released, an `rm -rf` race resolves on the next pass, etc.). Exit 0 with a
  # WARNING so the systemd unit doesn't flap to `failed` for transient cleanup
  # hiccups. Hard failures (worktree refusal, missing jq/npx, classifier
  # returning no output) are still non-zero via their own `exit` statements
  # above — only the per-branch error counter is downgraded here.
  #
  # Matches the inline comment on `hydra-branch-prune.service`'s ExecStart
  # ("don't fail the service — the next run picks them up"). See issue #494
  # for the prior mismatch that caused spurious `failed_services=1` signals
  # for hydra-doctor to triage.
  echo "branch-prune: WARNING — completed with $TOTAL_SOFT_ERRORS per-branch error(s); see log above. Next timer run will retry." >&2
  exit 0
fi

echo "branch-prune: all passes done."
exit 0
