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
# processes older than $MAX_AGE_MIN minutes that are NOT supervised by a live
# systemd unit and whose ancestor tree no longer contains a live Hydra
# orchestrator or interactive Claude/Codex session, and SIGKILLs their entire
# process groups. It logs every kill to stdout (which systemd captures into
# journalctl) so the operator can correlate kills with cycle history.
#
# P1 INCIDENT — issue #3730 (2026-07-26). For weeks the help text below
# promised a spare for "any current systemd-managed hydra-* unit" that was
# never implemented: `has_live_hydra_ancestor()` only pattern-matched ancestor
# COMMAND LINES, and a systemd service's ancestor is the systemd manager while
# its own cmd is arbitrary (`npm exec next start --port 3333`). So the reaper
# SIGKILLed the production Target web server (hydra-betting-web.service) once
# an hour, 23 times in 24h, each costing a ~2m24s Next.js cold start that
# failed every Target runner POSTing to :3333. `is_systemd_supervised()` below
# implements the missing spare.
#
# WHY THE SPARE IS *NOT* "any .service cgroup member" (the obvious fix, and
# the one #3730 originally proposed): on this host EVERY process an autopilot
# Claude session spawns inherits the `hydra-autopilot.service` cgroup —
# including exactly the leaked tsx grandchildren issue #226 exists to reap.
# Cgroup membership is inherited at fork and survives reparenting to init, so
# "is in a .service cgroup" (or "is in a hydra-*.service cgroup") is true of
# the leak class too and would neuter this reaper completely. The predicate
# that actually separates the two is SUPERVISION, not membership: a process is
# spared when it IS the cgroup unit's MainPID, or is a still-live descendant of
# it. The Target web server is its unit's MainPID; a leaked tsx whose parents
# have died is neither (its ancestor walk reaches the systemd manager without
# passing through the unit's MainPID).
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
processes older than MAX_AGE_MIN that no live systemd unit supervises and
whose Hydra/Claude ancestor is gone.
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

A process is SPARED, regardless of age, when a live systemd unit supervises
it: its cgroup names a *.service unit and the process either IS that unit's
MainPID or is a still-live descendant of it. This covers every long-running
service on the host (hydra-betting-web.service, context7.service, ...) —
including non-hydra units, deliberately: nothing this reaper is meant to catch
is supervised by a service, and a narrower hydra-* match would still kill a
third-party service that happens to run \`npm exec\` (issue #3730).

Membership in a service cgroup ALONE never spares a process: every autopilot
Claude descendant inherits the hydra-autopilot.service cgroup, so a membership
test would spare the leaked grandchildren issue #226 exists to reap.

If the MainPID query itself FAILS (systemd/D-Bus unreachable) the process is
SPARED and a WARN naming the pid and unit is logged, and the summary reports a
separate spared-unknown count. "We could not tell" is never treated as "not
supervised": a missed kill leaks memory until the next hourly sweep, a wrong
kill takes down the production Target web server.

Otherwise a process is considered stale when its --max-age threshold is
exceeded AND no living ancestor in its pid tree matches "hydra-orchestrator",
"claude", or "codex" interactive sessions. When in doubt, the reaper leaves
the process alone.
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

MAX_AGE_SEC=$((MAX_AGE_MIN * 60))

# ---------------------------------------------------------------------------
# Test seams (issue #3730). Production leaves all three UNSET and every fact
# is read from the live host. test/reap-stale-test-procs.test.mts points them
# at fixture files so both sparing directions — spare the supervised service,
# still kill the genuinely leaked tsx — are pinned deterministically without
# spawning (or killing) a single real process.
#   HYDRA_REAP_PROC_ROOT    — stands in for /proc (per-pid cgroup lookups)
#   HYDRA_REAP_PS_SNAPSHOT  — file of `pid|pgid|age_seconds|cmd` records
#   HYDRA_REAP_UNIT_MAINPID — file of `unit<TAB>mainpid` lines
# ---------------------------------------------------------------------------
PROC_ROOT="${HYDRA_REAP_PROC_ROOT:-/proc}"
PS_SNAPSHOT_FILE="${HYDRA_REAP_PS_SNAPSHOT:-}"
UNIT_MAINPID_FILE="${HYDRA_REAP_UNIT_MAINPID:-}"

log() {
  printf '[reap-stale-test-procs] %s\n' "$*"
}

# One consistent snapshot of every process as `pid|pgid|age_seconds|cmd`.
# `etimes` is elapsed wall-clock seconds straight from procps, which replaces
# the former per-pid `ps -p <pid> -o lstart=` + `date -d` reparse: one fork
# instead of N, and no second-sample skew between the age and the snapshot.
proc_snapshot() {
  if [[ -n "$PS_SNAPSHOT_FILE" ]]; then
    cat "$PS_SNAPSHOT_FILE" 2>/dev/null || true
    return
  fi
  ps -eo pid=,pgid=,etimes=,cmd= 2>/dev/null \
    | awk '{ pid=$1; pgid=$2; age=$3; $1=""; $2=""; $3=""; sub(/^ +/, ""); print pid"|"pgid"|"age"|"$0 }'
}

# The cgroup blob for a pid (empty when the process is gone).
cgroup_of() {
  cat "${PROC_ROOT}/$1/cgroup" 2>/dev/null || true
}

# MainPID of a systemd unit. THREE distinct outcomes, because collapsing them is
# how this reaper killed prod (issue #3730 QA):
#   rc 0 + pid on stdout — the query answered
#   rc 1                 — the query answered "no MainPID" (unit inactive/unknown)
#   rc 2                 — THE QUERY ITSELF FAILED (systemd/D-Bus unreachable)
# rc 2 is NOT the same answer as rc 1. The original code wrote
# `systemctl ... 2>/dev/null || true`, which swallowed the failure and let the
# caller fall through to "not supervised" — so a broken D-Bus session
# (`DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent`) made the reaper SIGKILL the
# production Target web server again, silently, through a brand-new trigger.
# Callers MUST treat rc 2 as "spare, and say so loudly".
unit_main_pid() {
  local unit="$1" scope="$2" out rc
  if [[ -n "$UNIT_MAINPID_FILE" ]]; then
    out=$(awk -F'\t' -v u="$unit" '$1 == u { print $2; exit }' "$UNIT_MAINPID_FILE" 2>/dev/null)
    rc=$?
    (( rc == 0 )) || return 2  # fixture unreadable — same unknown as a dead bus
    [[ -n "$out" ]] || return 1
    printf '%s' "$out"
    return 0
  fi
  out=$(systemctl "$scope" show "$unit" -p MainPID --value 2>/dev/null)
  rc=$?
  (( rc == 0 )) || return 2
  [[ -n "$out" ]] || return 1
  printf '%s' "$out"
  return 0
}

# Returns 0 when $2 appears as a living ancestor of $1. A pid whose parents
# have all exited walks straight up to the systemd manager and returns 1.
has_ancestor_pid() {
  local pid="$1" target="$2"
  local guard=20  # don't loop more than 20 levels (defensive)
  [[ -n "$target" && "$target" != "0" ]] || return 1
  while [[ -n "$pid" && "$pid" != "1" && "$pid" != "0" && $guard -gt 0 ]]; do
    guard=$((guard - 1))
    local ppid
    ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)
    [[ -n "$ppid" ]] || return 1  # process gone mid-walk
    [[ "$ppid" == "$target" ]] && return 0
    pid="$ppid"
  done
  return 1
}

# Echoes the *.service unit that supervises $1, or nothing. The unit is the
# deepest `.service` component of the pid's cgroup path; `user@<uid>.service`
# is deliberately excluded because that is the per-user systemd MANAGER, whose
# MainPID is an ancestor of essentially everything in the session — treating it
# as a supervisor would spare every leaked process on the host.
supervising_unit() {
  local pid="$1" cg unit="" scope="--system" line tail
  cg=$(cgroup_of "$pid")
  [[ -n "$cg" ]] || return 1
  while IFS= read -r line; do
    tail="${line##*/}"
    case "$tail" in
      user@*.service) ;;
      *.service)
        unit="$tail"
        # A user-manager cgroup path carries `/user@<uid>.service/`; anything
        # else is a system-scope unit.
        case "$line" in
          */user@*) scope="--user" ;;
          *)        scope="--system" ;;
        esac
        ;;
    esac
  done <<< "$cg"
  [[ -n "$unit" ]] || return 1
  printf '%s %s' "$unit" "$scope"
}

# The issue-#3730 spare: is this pid supervised by a live systemd unit?
# Echoes `<unit>:main` when the pid IS the unit's MainPID (a genuine
# long-running service — the hydra-betting-web.service case this incident was
# about) and `<unit>:descendant` when it is merely a still-live child of it.
# The caller logs only the `main` case: during an autopilot run every live tsx
# under the Claude session is a descendant of hydra-autopilot.service's MainPID,
# and a line each would drown the journal. Both are spared either way — a live
# descendant was already spared by has_live_hydra_ancestor(), so this changes
# the reason and the count, never the set of processes killed.
is_systemd_supervised() {
  local pid="$1" resolved unit scope mainpid rc
  resolved=$(supervising_unit "$pid") || return 1
  unit="${resolved%% *}"
  scope="${resolved##* }"
  mainpid=$(unit_main_pid "$unit" "$scope")
  rc=$?
  # FAIL SAFE, NOT FAIL OPEN (issue #3730 QA). We could not determine whether a
  # unit supervises this pid, so we decline to kill it and the caller WARNs. The
  # asymmetry is deliberate: a missed kill leaks some memory until the next
  # hourly sweep, a wrong kill takes down the production Target web server for a
  # ~2m24s cold start. `unknown` is only ever reached for a process that IS in a
  # *.service cgroup — a leak with no service cgroup never consults systemd at
  # all, so a dead bus does not make the reaper a no-op for the #226 class.
  if (( rc == 2 )); then
    printf '%s:unknown' "$unit"
    return 0
  fi
  (( rc == 0 )) || return 1
  mainpid="${mainpid//[!0-9]/}"
  [[ -n "$mainpid" && "$mainpid" != "0" ]] || return 1
  if [[ "$pid" == "$mainpid" ]]; then
    printf '%s:main' "$unit"
    return 0
  fi
  if has_ancestor_pid "$pid" "$mainpid"; then
    printf '%s:descendant' "$unit"
    return 0
  fi
  return 1
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

# Walk every running process and pick the candidates. We take ONE `ps -eo`
# snapshot rather than nested `pgrep`s so the view is consistent.
candidates=$(proc_snapshot)

killed=0
spared=0
spared_unknown=0
considered=0
below_age=0
would_kill=0

while IFS='|' read -r pid pgid age cmd; do
  # Only consider the targets named in the issue.
  case "$cmd" in
    *tsx*|*"esbuild --service"*|*"npm exec"*|*"npm-exec"*|*"node --test"*|*"node --experimental-strip-types --test"*)
      ;;
    *)
      continue
      ;;
  esac
  considered=$((considered + 1))

  # Issue #3730: the systemd-supervision spare is checked FIRST, before the age
  # filter, so a long-lived service is counted and logged as spared rather than
  # silently skipped — `spared=0` on every run is what hid this bug for weeks.
  if supervisor=$(is_systemd_supervised "$pid"); then
    spared=$((spared + 1))
    case "$supervisor" in
      *:main)
        log "SPARE pid=$pid unit=${supervisor%:main} reason=systemd-mainpid cmd=$cmd"
        ;;
      *:unknown)
        # Loud by contract (CLAUDE.md fail-loud): a silent fall-through here is
        # exactly what re-created the #3730 incident. Never downgrade this to a
        # quiet skip, and never make it conditional on DRY_RUN.
        spared_unknown=$((spared_unknown + 1))
        log "WARN pid=$pid unit=${supervisor%:unknown} reason=systemd-query-failed action=spared-on-unknown (cue: reaper-systemd-query-failed) cmd=$cmd"
        ;;
    esac
    continue
  fi

  if [[ ! "$age" =~ ^[0-9]+$ ]] || (( age < MAX_AGE_SEC )); then
    below_age=$((below_age + 1))
    continue
  fi

  # Ancestor spares stay counted-but-unlogged: during an autopilot run there
  # are many live tsx children and a line each would drown the journal.
  if has_live_hydra_ancestor "$pid"; then
    spared=$((spared + 1))
    continue
  fi

  log "STALE pid=$pid pgid=$pgid age=${age}s cmd=$cmd"
  would_kill=$((would_kill + 1))
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

# Issue #3730: `would-kill` counts the processes that actually cleared BOTH the
# spare checks and the age filter — i.e. exactly the STALE lines printed above.
# It used to be computed as `considered - spared`, but `considered` counts every
# pattern match before the age filter runs, so a quiet dry run reported
# `would-kill=9` while printing zero STALE lines.
# `spared-unknown` is broken out of `spared` deliberately (issue #3730 QA): a
# process spared because systemd confirmed it is a unit's MainPID is a healthy
# steady state, whereas one spared because the query FAILED means this host's
# systemd/D-Bus is unreachable and the reaper is running degraded. Those must
# never be indistinguishable in the summary — a non-zero spared-unknown is an
# operator signal, not routine.
if (( DRY_RUN == 1 )); then
  log "DRY RUN — considered=$considered spared=$spared spared-unknown=$spared_unknown below-age=$below_age would-kill=$would_kill"
else
  log "considered=$considered spared=$spared spared-unknown=$spared_unknown below-age=$below_age killed=$killed"
fi
if (( spared_unknown > 0 )); then
  log "WARN degraded sweep — $spared_unknown process(es) spared because the systemd MainPID query failed; systemd/D-Bus may be unreachable (cue: reaper-systemd-query-failed)"
fi

# Always exit 0; the timer should not fire failure alerts on a quiet run.
exit 0
