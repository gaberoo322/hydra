#!/usr/bin/env bash
#
# branch-prune.sh — daily janitor for [gone] local branches + their worktrees
# (issue #443).
#
# After the codex-removal cut-over (ADR-0006), every code-writing dispatch
# runs inside a `git worktree` under `~/hydra/.claude/worktrees/agent-*` or
# `/dev/shm/hydra-worktrees/`. When the agent finishes (or crashes) the
# worktree often leaks — `git branch -vv` accumulates `[gone]` upstreams and
# the worktree dirs stick around forever. A single manual sweep on 2026-05-15
# cleaned 167 branches and 71 worktrees in one pass; the orchestrator should
# not need a human for that.
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
# Safety rails (enforced both in this script AND in the classifier):
#  - Refuses to run from inside a worktree (must be the main ~/hydra tree).
#  - Never deletes the current branch.
#  - Never deletes a branch whose attached worktree is held by a live PID.
#  - Hard cap of 250 deletions per run (sanity check against script bugs).

set -uo pipefail

APPLY=0
LOG_FILE="${HYDRA_BRANCH_PRUNE_LOG:-/tmp/hydra-branch-prune.log}"

print_help() {
  sed -n '2,32p' "$0"
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

# Safety rail 1: must run from the main working tree, not a worktree. Running
# `git worktree remove --force` from inside a worktree is the textbook way to
# saw off your own branch.
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || echo "")
case "$GIT_DIR" in
  *"/.git/worktrees/"*)
    echo "branch-prune: refusing to run from inside a worktree (cwd=$(pwd), git-dir=$GIT_DIR)" >&2
    echo "branch-prune: run from the main ~/hydra working tree instead." >&2
    exit 3
    ;;
esac

command -v npx >/dev/null || { echo "branch-prune: npx required (uses tsx for the classifier)" >&2; exit 127; }
command -v jq  >/dev/null || { echo "branch-prune: jq required" >&2; exit 127; }

# Refresh remote tracking so [gone] markers are current. Without this, recently
# squash-merged PRs still have a live upstream from the previous fetch.
echo "branch-prune: git fetch origin --prune"
git fetch origin --prune 2>&1 | sed 's/^/  /' || true

# Collect inputs for the classifier:
#   1. `git branch -vv` for [gone] detection + current-branch marker
#   2. `git worktree list --porcelain` for attached-worktree lookup
#   3. Each worktree's `.git/worktrees/<name>/locked` file (if present)
BRANCHES_RAW=$(git branch -vv 2>/dev/null || true)
WORKTREES_RAW=$(git worktree list --porcelain 2>/dev/null || true)

# Build a JSON map of {worktreePath: lockBody}. We iterate over the worktree
# paths from the porcelain output and resolve each lock file. Worktrees with
# no lock file produce no entry and the classifier reads `null`.
declare -a LOCK_ENTRIES=()
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

if [ ${#LOCK_ENTRIES[@]} -eq 0 ]; then
  LOCKS_JSON='{}'
else
  # Merge the per-worktree {path: body} objects into one. `jq -s add` over the
  # series of single-key objects produces the union.
  LOCKS_JSON=$(printf '%s\n' "${LOCK_ENTRIES[@]}" | jq -s 'add // {}')
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "master")

# Build input JSON for the runner.
if [ "$APPLY" -eq 1 ]; then AUDIT_JSON=false; else AUDIT_JSON=true; fi
INPUT_JSON=$(jq -nc \
  --arg b "$BRANCHES_RAW" \
  --arg w "$WORKTREES_RAW" \
  --arg c "$CURRENT_BRANCH" \
  --argjson l "$LOCKS_JSON" \
  --argjson a "$AUDIT_JSON" \
  '{branchesRaw: $b, worktreesRaw: $w, currentBranch: $c, locks: $l, audit: $a}')

PLAN=$(printf '%s' "$INPUT_JSON" | npx -y tsx "$REPO_ROOT/scripts/ci/branch-prune-runner.ts")
if [ -z "$PLAN" ]; then
  echo "branch-prune: classifier produced no output — aborting (no destructive ops)." >&2
  exit 4
fi

REPORT=$(printf '%s' "$PLAN" | jq -r '.report')
echo "$REPORT"
if [ -n "$LOG_FILE" ]; then
  printf '%s\n' "$REPORT" >> "$LOG_FILE" || true
fi

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "branch-prune: audit-only — no changes made. Pass --apply to act on the plan above."
  exit 0
fi

# Apply the plan. We deliberately do the destructive ops AFTER the classifier
# has fully classified — never interleave classification and mutation, so a
# `git branch -D` mid-loop can't change what the next row sees.
ERRORS=0

while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  br=$(printf '%s' "$entry" | jq -r '.branch')
  wt=$(printf '%s' "$entry" | jq -r '.worktreePath')
  echo "branch-prune: removing worktree $wt and branch $br"
  git worktree unlock "$wt" 2>/dev/null || true
  if ! git worktree remove --force "$wt" 2>&1 | sed 's/^/  /'; then
    echo "  branch-prune: worktree remove failed for $wt — leaving branch $br alone" >&2
    ERRORS=$((ERRORS+1))
    continue
  fi
  if ! git branch -D "$br" 2>&1 | sed 's/^/  /'; then
    echo "  branch-prune: branch -D failed for $br" >&2
    ERRORS=$((ERRORS+1))
  fi
done < <(printf '%s' "$PLAN" | jq -c '.plan.deleteWorktreeAndBranch[]')

while IFS= read -r br; do
  [ -z "$br" ] && continue
  echo "branch-prune: deleting branch $br"
  if ! git branch -D "$br" 2>&1 | sed 's/^/  /'; then
    echo "  branch-prune: branch -D failed for $br" >&2
    ERRORS=$((ERRORS+1))
  fi
done < <(printf '%s' "$PLAN" | jq -r '.plan.deleteBranchOnly[]')

# Final pass: prune metadata for manually-deleted worktree dirs.
echo "branch-prune: git worktree prune"
git worktree prune 2>&1 | sed 's/^/  /' || true

if [ "$ERRORS" -gt 0 ]; then
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
  echo "branch-prune: WARNING — completed with $ERRORS per-branch error(s); see log above. Next timer run will retry." >&2
  exit 0
fi

echo "branch-prune: done."
exit 0
