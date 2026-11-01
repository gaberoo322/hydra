#!/usr/bin/env bash
#
# reap-stale-tmp.sh — out-of-process safety net for leaked test temp dirs in
# the shared /tmp (2026-10-31 inode-exhaustion outage).
#
# /tmp on this host is a tmpfs capped at 1,048,576 inodes and is shared by the
# CI runners and every agent worktree. On 2026-10-31 it hit 100% inode use with
# 8.6G of space still free, and every process that writes a temp file failed
# with ENOSPC (CI jobs, agent dispatches, Claude Code's own Bash tool). The
# leakers were test runs that create a temp dir and never remove it:
#
#   - Vitest 5.0.1 (claw-street-bets #335): `tmpdir()/<nanoid21>/ssr/<sha1>`
#     per run, never removed (fixed upstream in 5.0.5, but a killed vitest
#     never reaches close() and still leaks its dir).
#   - mkdtemp fixtures with no cleanup (hydra #5326, claw-street-bets #336).
#
# The OS's own systemd-tmpfiles-clean ages /tmp out at 10 days, and at the
# observed leak rates 10 days of leftovers is more than the inode cap. This
# reaper closes that gap: hourly, it removes ONLY top-level /tmp entries that
#
#   1. are directories (never symlinks — find does not follow them),
#   2. are owned by the invoking user,
#   3. have had NOTHING in their subtree modified for --max-age minutes, and
#   4. fit a temp-dir shape: mkdtemp's `<prefix>-<6 chars>`, or Vitest's
#      21-char nanoid dir whose ONLY entry is `ssr/` (shapes below), and
#   5. are not a long-lived tool's runtime dir (DENY_RE below).
#
# Anything else is left alone. The fixes for each leaker are still the primary
# defense; this only stops a recurrence from becoming an outage.
#
# Usage: reap-stale-tmp.sh [--apply] [--max-age MINUTES]
#   Default is a dry run that prints what would be removed.
#   HYDRA_TMP_REAP_ROOT overrides the scanned directory (test seam; default /tmp).
#
# Exits 0 even when a removal fails (the failure is logged), like the sibling
# reap-stale-test-procs.sh, so the timer unit stays clean; read
# `journalctl --user -u hydra-tmp-reaper` for the output.

set -uo pipefail

APPLY=0
MAX_AGE_MIN=720
ROOT="${HYDRA_TMP_REAP_ROOT:-/tmp}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --max-age)
      shift
      MAX_AGE_MIN="${1:-}"
      ;;
    -h|--help)
      sed -n '2,37p' "$0"
      exit 0
      ;;
    *)
      echo "reap-stale-tmp: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if ! [[ "$MAX_AGE_MIN" =~ ^[0-9]+$ ]] || [ "$MAX_AGE_MIN" -lt 60 ]; then
  echo "reap-stale-tmp: --max-age must be an integer >= 60 minutes (got '$MAX_AGE_MIN')" >&2
  exit 2
fi

if [ ! -d "$ROOT" ]; then
  echo "reap-stale-tmp: root '$ROOT' is not a directory" >&2
  exit 2
fi

# Shapes. mkdtemp(prefix) appends exactly 6 characters from [A-Za-z0-9], so a
# leaked fixture dir is `<prefix><6 chars>` with a prefix ending in `-` or `.`
# (`csb-outcomes-route-1d5vgA`, `pmh-e2e-Ab12Cd`). Matching the SHAPE instead
# of a list of known prefixes is the point: a safety net has to catch the next
# leaker nobody has found yet, not only the ones already filed.
#
# Vitest's root tmp dir is a 21-char nanoid whose ONLY entry is `ssr/`; any
# other nanoid-named dir is not ours to judge.
#
# Both shapes are further gated on staleness of the WHOLE subtree (see
# is_quiet below), not just the dir's own mtime, so a temp dir a long-running
# process is still writing into is never touched however old the dir itself is.
MKDTEMP_RE='^[A-Za-z][A-Za-z0-9_.-]*[-.][A-Za-z0-9]{6}$'
NANOID_RE='^[A-Za-z0-9_-]{21}$'
# Top-level names this reaper must never remove even if they fit a shape:
# per-user runtime dirs owned by long-lived tools.
DENY_RE='^(claude-|tsx-|systemd-|tmux-|ssh-|snap-|node-compile-cache|com\.google\.|\.)'

# classify <basename> <path> -> prints the class name, or nothing if no match.
classify() {
  local name="$1" path="$2"
  [[ "$name" =~ $DENY_RE ]] && return
  if [[ "$name" =~ $NANOID_RE ]]; then
    local entries
    entries=$(ls -A -- "$path" 2>/dev/null)
    if [ "$entries" = "ssr" ] && [ -d "$path/ssr" ] && [ ! -L "$path/ssr" ]; then
      printf 'vitest-ssr\n'
    fi
    return
  fi
  if [[ "$name" =~ $MKDTEMP_RE ]]; then
    # Class label = the mkdtemp prefix, for the per-class journal counts.
    printf 'mkdtemp:%s\n' "${name:0:${#name}-6}"
  fi
}

# is_quiet <path> -> true when nothing in the subtree changed within the window.
is_quiet() {
  [ -z "$(find "$1" -xdev -mmin "-$MAX_AGE_MIN" -print -quit 2>/dev/null)" ]
}

uid=$(id -u)
matched=0
removed=0
failed=0
spared=0
declare -A by_class=()

while IFS= read -r -d '' path; do
  name="${path##*/}"
  class=$(classify "$name" "$path")
  if [ -z "$class" ]; then
    spared=$((spared + 1))
    continue
  fi
  if ! is_quiet "$path"; then
    spared=$((spared + 1))
    continue
  fi
  matched=$((matched + 1))
  by_class[$class]=$(( ${by_class[$class]:-0} + 1 ))
  if [ "$APPLY" -eq 1 ]; then
    if rm -rf -- "$path" 2>/dev/null; then
      removed=$((removed + 1))
    else
      failed=$((failed + 1))
      echo "FAILED path=$path class=$class"
    fi
  else
    echo "WOULD-REMOVE path=$path class=$class"
  fi
done < <(find "$ROOT" -mindepth 1 -maxdepth 1 -xdev -type d -user "$uid" -mmin "+$MAX_AGE_MIN" -print0 2>/dev/null)

for class in "${!by_class[@]}"; do
  echo "CLASS class=$class count=${by_class[$class]}"
done | sort

mode=dry-run
[ "$APPLY" -eq 1 ] && mode=apply
echo "SUMMARY mode=$mode root=$ROOT max_age_min=$MAX_AGE_MIN matched=$matched removed=$removed failed=$failed spared=$spared"
exit 0
