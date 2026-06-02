#!/usr/bin/env bash
#
# reap-stale-test-procs.sh — defense in depth for issue #226.
#
# The orchestrator's own deep-tree spawns (grounding's `npm test` /
# `npm run typecheck`, the per-mutant test runs in mutation.ts) now go
# through src/exec-with-timeout.ts (`execWithGroupCleanup`), which kills the
# entire process group when an in-process timeout fires (wired in issue #844;
# before that the helper was orphaned and this primary-defense claim was
# false). That covers what the orchestrator controls.
#
# But the orchestrator does NOT control everything that spawns tsx/esbuild on
# this host — Claude Code worktree sessions and manual `npx tsx` invocations
# from operator shells can still leak grandchildren in failure modes we cannot
# reach in-process. This reaper is the out-of-process safety net for exactly
# those: a delayed, heuristic sweep, not the first line of defense.
#
# This reaper finds tsx, esbuild --service, npm-exec, and node --test
# processes older than $MAX_AGE_MIN minutes whose ancestor tree no longer
# contains a live Hydra orchestrator or interactive Claude/Codex session,
# and SIGKILLs their entire process groups. It logs every kill to stdout
# (which systemd captures into journalctl) so the operator can correlate
# kills with cycle history.
#
# Default: dry-run unless `--apply` is passed. The systemd timer wrapper
# always passes `--apply`.
#
# Usage:
#   scripts/reap-stale-test-procs.sh                  # dry run (default)
#   scripts/reap-stale-test-procs.sh --dry-run        # explicit dry run
#   scripts/reap-stale-test-procs.sh --apply          # actually kill
#   scripts/reap-stale-test-procs.sh --max-age 60     # 60-minute cutoff
#   scripts/reap-stale-test-procs.sh --help

set -uo pipefail

DRY_RUN=1
MAX_AGE_MIN=30

print_help() {
  cat <<EOF
reap-stale-test-procs.sh — kill stale tsx/esbuild/npm-exec/node-test
processes older than MAX_AGE_MIN whose Hydra/Claude ancestor is gone.
Defense in depth for issue #226 (process group cleanup leaks).

Usage:
  $(basename "$0") [--apply | --dry-run] [--max-age MIN] [--help]

Options:
  --apply         Actually send SIGKILL. Without this we only print.
  --dry-run       Default. Print what would be killed without doing it.
  --max-age MIN   Only consider processes older than MIN minutes. Default 30.
  --help          Show this help.

Targets (case-insensitive command match):
  tsx
  esbuild --service
  npm exec
  node --test

A process is considered stale when its --max-age threshold is exceeded
AND no living ancestor in its pid tree matches "hydra-orchestrator",
"claude", "codex" interactive sessions, or any current systemd-managed
hydra-* unit. When in doubt, the reaper leaves the process alone.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)    DRY_RUN=0 ;;
    --dry-run)  DRY_RUN=1 ;;
    --max-age)  shift; MAX_AGE_MIN="${1:-30}" ;;
    --help|-h)  print_help; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; print_help >&2; exit 2 ;;
  esac
  shift
done

if ! [[ "$MAX_AGE_MIN" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --max-age must be a non-negative integer (got '$MAX_AGE_MIN')" >&2
  exit 2
fi

NOW_EPOCH=$(date +%s)
MAX_AGE_SEC=$((MAX_AGE_MIN * 60))

log() {
  printf '[reap-stale-test-procs] %s\n' "$*"
}

# A live "hydra ancestor" is an interactive Claude / Codex session, the
# orchestrator service, or anything else we explicitly want to spare.
# Returns 0 if the given PID has such an ancestor; 1 otherwise.
has_live_hydra_ancestor() {
  local pid="$1"
  local guard=20  # don't loop more than 20 levels (defensive)
  while [[ "$pid" != "1" && "$pid" != "0" && -n "$pid" && $guard -gt 0 ]]; do
    guard=$((guard - 1))
    local cmd ppid
    cmd=$(ps -p "$pid" -o cmd= 2>/dev/null || true)
    ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)
    if [[ -z "$cmd" ]]; then
      return 1  # process gone — no ancestor
    fi
    case "$cmd" in
      *hydra-orchestrator*|*"claude "*|*"/claude"*|*"codex "*|*"/codex"*|*"hydra "*|*"/hydra"*)
        return 0
        ;;
    esac
    pid="$ppid"
  done
  return 1
}

age_seconds() {
  local pid="$1"
  local lstart
  lstart=$(ps -p "$pid" -o lstart= 2>/dev/null || true)
  if [[ -z "$lstart" ]]; then
    echo 0
    return
  fi
  local started
  started=$(date -d "$lstart" +%s 2>/dev/null || echo 0)
  if [[ "$started" -eq 0 ]]; then
    echo 0
    return
  fi
  echo $((NOW_EPOCH - started))
}

# Walk every running process and pick the candidates. We use `ps -eo` once
# rather than nested `pgrep`s so the snapshot is consistent.
candidates=$(ps -eo pid=,pgid=,cmd= 2>/dev/null \
  | awk '{ pid=$1; pgid=$2; $1=""; $2=""; sub(/^  */,""); cmd=$0; print pid"|"pgid"|"cmd }')

killed=0
spared=0
considered=0

while IFS='|' read -r pid pgid cmd; do
  # Only consider the targets named in the issue.
  case "$cmd" in
    *tsx*|*"esbuild --service"*|*"npm exec"*|*"npm-exec"*|*"node --test"*|*"node --experimental-strip-types --test"*)
      ;;
    *)
      continue
      ;;
  esac
  considered=$((considered + 1))

  age=$(age_seconds "$pid")
  if (( age < MAX_AGE_SEC )); then
    continue
  fi

  if has_live_hydra_ancestor "$pid"; then
    spared=$((spared + 1))
    continue
  fi

  log "STALE pid=$pid pgid=$pgid age=${age}s cmd=$cmd"
  if (( DRY_RUN == 1 )); then
    continue
  fi

  if [[ -z "$pgid" || "$pgid" == "0" ]]; then
    log "  no pgid — falling back to single-pid SIGKILL"
    kill -KILL "$pid" 2>/dev/null && killed=$((killed + 1)) || true
  else
    if kill -KILL -- "-$pgid" 2>/dev/null; then
      log "  SIGKILL group -$pgid"
      killed=$((killed + 1))
    else
      # Group may already be partially gone; fall back to single PID.
      kill -KILL "$pid" 2>/dev/null && killed=$((killed + 1)) || true
    fi
  fi
done <<< "$candidates"

if (( DRY_RUN == 1 )); then
  log "DRY RUN — considered=$considered spared=$spared would-kill=$((considered - spared))"
else
  log "considered=$considered spared=$spared killed=$killed"
fi

# Always exit 0; the timer should not fire failure alerts on a quiet run.
exit 0
