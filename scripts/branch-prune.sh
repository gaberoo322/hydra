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

    # Collect inputs for the classifier:
    #   1. `git branch -vv` for [gone] detection + current-branch marker
    #   2. `git worktree list --porcelain` for attached-worktree lookup
    #   3. Each worktree's `.git/worktrees/<name>/locked` file (if present)
    local BRANCHES_RAW WORKTREES_RAW
    BRANCHES_RAW=$(git branch -vv 2>/dev/null || true)
    WORKTREES_RAW=$(git worktree list --porcelain 2>/dev/null || true)

    # Build a JSON map of {worktreePath: lockBody}.
    local -a LOCK_ENTRIES=()
    local line wt_path wt_name lockfile body
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
          ;;
      esac
    done <<<"$WORKTREES_RAW"

    local LOCKS_JSON
    if [ ${#LOCK_ENTRIES[@]} -eq 0 ]; then
      LOCKS_JSON='{}'
    else
      LOCKS_JSON=$(printf '%s\n' "${LOCK_ENTRIES[@]}" | jq -s 'add // {}')
    fi

    local CURRENT_BRANCH
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "master")

    local AUDIT_JSON
    if [ "$APPLY" -eq 1 ]; then AUDIT_JSON=false; else AUDIT_JSON=true; fi

    local INPUT_JSON PLAN REPORT
    INPUT_JSON=$(jq -nc \
      --arg b "$BRANCHES_RAW" \
      --arg w "$WORKTREES_RAW" \
      --arg c "$CURRENT_BRANCH" \
      --argjson l "$LOCKS_JSON" \
      --argjson a "$AUDIT_JSON" \
      '{branchesRaw: $b, worktreesRaw: $w, currentBranch: $c, locks: $l, audit: $a}')

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
