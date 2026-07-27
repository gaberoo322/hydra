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
# P1 HAZARD — issue #3732 (2026-07-27). Sparing the *candidate* says nothing
# about the other members of the candidate's process group, and this reaper
# kills by group. On this host all five GitHub Actions runners are user-scope
# units with `pid == pgid == sid == MainPID`, so EVERY process inside a CI job
# inherits pgid = the runner's session leader. A genuine issue-#226 leak inside
# a CI job is — correctly — not spared (its parents are dead, so the MainPID
# ancestor walk fails) but it still carries the runner's pgid, so
# `kill -KILL -- -$pgid` SIGKILLs the whole runner: Runner.Listener,
# Runner.Worker and 10 more siblings. A killed runner can cancel a `deploy`
# job, and a cancelled deploy leaves prod silently behind master with NO alarm
# (the watchdog checks health, not SHA drift).
#
# The fix is a KILL-PLAN SAFETY predicate, not a new spare: a group-kill is
# permitted only when no live member of that pgid — outside the candidate's own
# process tree — would be spared by the predicates above. Otherwise the reaper
# WARNs and downgrades to killing the candidate plus its live descendants,
# which is the correct blast radius for a leaked grandchild anyway and keeps
# the #226 esbuild-orphan case covered. A cmdline allowlist for
# `Runner.Listener` / `actions-runner*` was deliberately NOT made the
# load-bearing check: that is the exact shape of the #3730 bug.
#
# Every kill target is now logged as an explicit `PLAN` line, in dry-run too,
# so the journal is self-documenting about blast radius and a dry run alone
# pins the decision.
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

KILL PLAN (issue #3732). Sparing a process says nothing about the other
members of its process GROUP, and this reaper kills by group. On this host
every process inside a GitHub Actions job inherits pgid = the runner's session
leader, so group-killing one leaked test process would SIGKILL the entire
runner. A group-kill is therefore permitted only when no live member of that
pgid — outside the candidate's own process tree — would itself be spared.
Otherwise the reaper WARNs and downgrades to killing the candidate plus its
live descendants. Every candidate's targets are logged as a PLAN line, in dry
run too, so blast radius is auditable before anything is signalled. A
candidate that has already exited by kill time is skipped outright: its
recorded pgid is never group-killed on its behalf.
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
# Test seams (issues #3730, #3732). Production leaves all five UNSET and every
# fact is read from the live host. test/reap-stale-test-procs.test.mts points
# them at fixture files so every direction — spare the supervised service, still
# kill the genuinely leaked tsx, never group-kill a CI runner — is pinned
# deterministically without spawning (or killing) a single real process.
#   HYDRA_REAP_PROC_ROOT    — stands in for /proc (per-pid cgroup lookups)
#   HYDRA_REAP_PS_SNAPSHOT  — file of `pid|ppid|pgid|age_seconds|cmd` records
#   HYDRA_REAP_UNIT_MAINPID — file of `unit<TAB>mainpid` lines
#   HYDRA_REAP_KILL_SINK    — file that RECORDS kill targets instead of
#                             signalling, so --apply targeting is assertable
#   HYDRA_REAP_VANISHED_PIDS— comma-separated pids to treat as already exited,
#                             the only way to express the exit-mid-sweep race
#
# When HYDRA_REAP_PS_SNAPSHOT is set the snapshot IS the world: liveness is
# snapshot membership rather than `kill -0`, because fixture pids sit above
# pid_max and would otherwise all read as dead.
# ---------------------------------------------------------------------------
PROC_ROOT="${HYDRA_REAP_PROC_ROOT:-/proc}"
PS_SNAPSHOT_FILE="${HYDRA_REAP_PS_SNAPSHOT:-}"
UNIT_MAINPID_FILE="${HYDRA_REAP_UNIT_MAINPID:-}"
KILL_SINK_FILE="${HYDRA_REAP_KILL_SINK:-}"
VANISHED_PIDS="${HYDRA_REAP_VANISHED_PIDS:-}"

log() {
  printf '[reap-stale-test-procs] %s\n' "$*"
}

# One consistent snapshot of every process as `pid|ppid|pgid|age_seconds|cmd`.
# `etimes` is elapsed wall-clock seconds straight from procps, which replaces
# the former per-pid `ps -p <pid> -o lstart=` + `date -d` reparse: one fork
# instead of N, and no second-sample skew between the age and the snapshot.
#
# `ppid` joined the record in issue #3732. Reading ancestry, group membership
# and descendants from this one snapshot (instead of forking `ps -p` per level)
# buys three things: a process can no longer fail its own ancestry walk by
# exiting mid-sweep — which is how a short-lived `node:test` child got
# misclassified as an unsupervised leak and its runner-session pgid
# group-killed — descendant enumeration becomes free, and a synthetic CI-runner
# process tree becomes expressible as a test fixture.
proc_snapshot() {
  if [[ -n "$PS_SNAPSHOT_FILE" ]]; then
    cat "$PS_SNAPSHOT_FILE" 2>/dev/null || true
    return
  fi
  ps -eo pid=,ppid=,pgid=,etimes=,cmd= 2>/dev/null \
    | awk '{ pid=$1; ppid=$2; pgid=$3; age=$4; $1=""; $2=""; $3=""; $4=""; sub(/^ +/, ""); print pid"|"ppid"|"pgid"|"age"|"$0 }'
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

# Returns 0 when $2 appears as an ancestor of $1. A pid whose parents have all
# exited walks straight up to the systemd manager and returns 1.
#
# Issue #3732: ancestry is resolved from the ps snapshot, not from a per-level
# `ps -p` fork. The old form asked the LIVE host about a pid the snapshot had
# already observed, so a process that exited between the snapshot and the walk
# answered "no parent" — indistinguishable from a genuine orphan, and the
# reaper then group-killed that dead process's recorded pgid. Measured on this
# host during a live CI run: 1-3 pattern-matching `node:test` children per
# 150ms window were present in the snapshot and gone milliseconds later.
has_ancestor_pid() {
  local pid="$1" target="$2"
  local guard=20  # don't loop more than 20 levels (defensive)
  [[ -n "$target" && "$target" != "0" ]] || return 1
  while [[ -n "$pid" && "$pid" != "1" && "$pid" != "0" && $guard -gt 0 ]]; do
    guard=$((guard - 1))
    local ppid="${PPID_OF[$pid]:-}"
    [[ -n "$ppid" ]] || return 1  # not in the snapshot — treat as no ancestor
    [[ "$ppid" == "$target" ]] && return 0
    pid="$ppid"
  done
  return 1
}

# Is this pid still around at kill time? The snapshot ages while the sweep runs
# (a MainPID query is a D-Bus round trip), so every signal is preceded by a
# fresh liveness check — invariant: a vanished candidate is a NO-OP, never a
# kill, and its recorded pgid is never group-killed on its behalf.
#
# `kill -0` fails with EPERM for a process we do not own, which would read as
# "dead" and let it be group-killed as collateral; the /proc fallback keeps
# such a process visible as a live group member.
is_live() {
  local pid="$1"
  [[ -n "$pid" && "$pid" != "0" ]] || return 1
  if [[ -n "$PS_SNAPSHOT_FILE" ]]; then
    case ",${VANISHED_PIDS}," in *",$pid,"*) return 1 ;; esac
    [[ -n "${CMD_OF[$pid]+set}" ]]
    return
  fi
  kill -0 "$pid" 2>/dev/null && return 0
  [[ -e "/proc/$pid" ]]
}

# Space-separated live descendants of $1 (excluding $1 itself), breadth-first
# over the snapshot's pid->children index. This is the blast radius the reaper
# falls back to when a group-kill is refused: issue #226 is fundamentally about
# orphaned `esbuild --service` grandchildren, so a BARE single-pid kill would
# lose the capability the group-kill exists to provide.
live_descendants() {
  local root="$1" queue="$1" out="" cur child guard=0
  while [[ -n "$queue" ]]; do
    guard=$((guard + 1))
    (( guard > 5000 )) && break  # defensive: never spin on a malformed snapshot
    cur="${queue%% *}"
    if [[ "$cur" == "$queue" ]]; then queue=""; else queue="${queue#* }"; fi
    for child in ${CHILDREN_OF[$cur]:-}; do
      [[ "$child" == "$root" ]] && continue
      case " $out " in *" $child "*) continue ;; esac
      is_live "$child" || continue
      out="${out:+$out }$child"
      queue="${queue:+$queue }$child"
    done
  done
  printf '%s' "$out"
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
#
# DELIBERATELY still reads the LIVE host rather than the snapshot, unlike
# has_ancestor_pid above. This predicate matches COMMAND LINES and includes the
# pid itself, and its `*/hydra*` arm matches any path under ~/hydra — so
# feeding it snapshot cmds would make every leaked `.../hydra/node_modules/.bin/tsx`
# spare ITSELF and silently neuter the whole issue-#226 reaper. Rescoping that
# glob is a real but separate change; it is not smuggled into the #3732
# kill-plan fix. The live-`ps` form fails closed on a gone process, which for
# this predicate is the safe direction (it can only cause a kill of something
# already dead, and is_live() now gates that too).
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

# THE #3732 GUARD. Echoes `<pid> <reason>` and returns 0 when the candidate's
# process group contains a live member that this reaper's own predicates would
# spare — i.e. when `kill -KILL -- -$pgid` would take out something we have
# explicitly decided not to kill. Returns 1 (group-kill is safe) otherwise.
#
# The pgid LEADER is probed first because it short-circuits the case that
# motivated this guard in a single systemctl call: all five GitHub Actions
# runners on this host are user-scope units with pid == pgid == sid == MainPID,
# so the leader of any CI job's group IS `github-actions-runner-N.service`'s
# MainPID and resolves `<unit>:main` immediately.
#
# The candidate's OWN process tree is excluded from the blocker set on purpose:
# those pids are killed under either plan, so they cannot inform the CHOICE
# between plans, and counting them would downgrade almost every genuine leak
# group for no gain. What this predicate asks is exactly: "does group-killing
# reach anything spare-worthy OUTSIDE the tree we already intend to kill?"
#
# A `<unit>:unknown` member (the systemd query itself failed) blocks the
# group-kill exactly like a confirmed MainPID — the #3730 fail-safe asymmetry
# extends to blast radius, not just to the candidate.
group_kill_blocker() {
  local pgid="$1" candidate="$2" excluded="$3" member seen="" supervisor
  for member in "$pgid" ${MEMBERS_OF_PGID[$pgid]:-}; do
    [[ -n "$member" && "$member" != "0" ]] || continue
    [[ "$member" == "$candidate" ]] && continue
    case " $excluded " in *" $member "*) continue ;; esac
    case " $seen " in *" $member "*) continue ;; esac
    seen="${seen:+$seen }$member"
    is_live "$member" || continue
    if supervisor=$(is_systemd_supervised "$member"); then
      printf '%s %s' "$member" "$supervisor"
      return 0
    fi
    if has_live_hydra_ancestor "$member"; then
      printf '%s %s' "$member" "live-hydra-ancestor"
      return 0
    fi
  done
  return 1
}

# Signal one target: a bare pid, or `-<pgid>` for a whole group. The kill sink
# seam records targets instead of signalling so --apply TARGETING is assertable
# in tests; without it no test could reach the kill path at all (every case
# passes --dry-run), which is why the #3732 acceptance criterion was previously
# unmeetable.
send_kill() {
  local target="$1"
  if [[ -n "$KILL_SINK_FILE" ]]; then
    printf '%s\n' "$target" >> "$KILL_SINK_FILE"
    return 0
  fi
  kill -KILL -- "$target" 2>/dev/null
}

# Walk every running process and pick the candidates. We take ONE `ps -eo`
# snapshot rather than nested `pgrep`s so the view is consistent.
candidates=$(proc_snapshot)

# Snapshot indices. Every ancestry / group / descendant question below is
# answered from these, so age, supervision, group membership and blast radius
# all resolve against ONE observation of the process table.
declare -A PPID_OF=()
declare -A CMD_OF=()
declare -A MEMBERS_OF_PGID=()
declare -A CHILDREN_OF=()

while IFS='|' read -r s_pid s_ppid s_pgid s_age s_cmd; do
  [[ -n "$s_pid" ]] || continue
  PPID_OF["$s_pid"]="$s_ppid"
  CMD_OF["$s_pid"]="$s_cmd"
  if [[ -n "$s_pgid" ]]; then
    MEMBERS_OF_PGID["$s_pgid"]="${MEMBERS_OF_PGID[$s_pgid]:-}${MEMBERS_OF_PGID[$s_pgid]:+ }$s_pid"
  fi
  if [[ -n "$s_ppid" && "$s_ppid" != "$s_pid" ]]; then
    CHILDREN_OF["$s_ppid"]="${CHILDREN_OF[$s_ppid]:-}${CHILDREN_OF[$s_ppid]:+ }$s_pid"
  fi
done <<< "$candidates"

killed=0
spared=0
spared_unknown=0
considered=0
below_age=0
would_kill=0
downgraded=0
vanished=0

while IFS='|' read -r pid ppid pgid age cmd; do
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

  # Issue #3732, invariant: A VANISHED CANDIDATE IS A NO-OP, NEVER A KILL.
  # The snapshot ages while the sweep runs. If the candidate is already gone,
  # killing "it" can only mean killing its recorded pgid — a group it no longer
  # occupies, which on this host is routinely a CI runner's session. Skip.
  if ! is_live "$pid"; then
    vanished=$((vanished + 1))
    log "VANISHED pid=$pid pgid=$pgid age=${age}s — exited during the sweep; its pgid is NOT group-killed cmd=$cmd"
    continue
  fi

  log "STALE pid=$pid pgid=$pgid age=${age}s cmd=$cmd"
  would_kill=$((would_kill + 1))

  # Decide the blast radius BEFORE the dry-run bail, so a dry run pins the
  # choice and the production journal documents exactly what was signalled.
  descendants=$(live_descendants "$pid")
  plan="group"
  targets="-$pgid"
  if [[ -z "$pgid" || "$pgid" == "0" ]]; then
    plan="descendants"
    log "  no pgid — falling back to candidate + live descendants"
  elif blocker=$(group_kill_blocker "$pgid" "$pid" "$descendants"); then
    plan="descendants"
    downgraded=$((downgraded + 1))
    log "  WARN pid=$pid pgid=$pgid reason=group-contains-spared-member blocker-pid=${blocker%% *} blocker-reason=${blocker#* } action=downgraded-to-candidate-plus-descendants (cue: reaper-group-kill-downgraded)"
  fi
  [[ "$plan" == "group" ]] || targets="$pid${descendants:+ $descendants}"
  log "  PLAN pid=$pid plan=$plan targets=$targets"

  if (( DRY_RUN == 1 )); then
    continue
  fi

  if [[ "$plan" == "group" ]]; then
    if send_kill "$targets"; then
      log "  SIGKILL group $targets"
      killed=$((killed + 1))
      continue
    fi
    # Group may already be partially gone; fall back to the narrow plan.
    plan="descendants"
    targets="$pid${descendants:+ $descendants}"
    log "  group SIGKILL failed — falling back plan=descendants targets=$targets"
  fi
  signalled=0
  for target in $targets; do
    send_kill "$target" && signalled=1
  done
  (( signalled == 1 )) && killed=$((killed + 1))
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
  log "DRY RUN — considered=$considered spared=$spared spared-unknown=$spared_unknown below-age=$below_age vanished=$vanished downgraded=$downgraded would-kill=$would_kill"
else
  log "considered=$considered spared=$spared spared-unknown=$spared_unknown below-age=$below_age vanished=$vanished downgraded=$downgraded killed=$killed"
fi
if (( spared_unknown > 0 )); then
  log "WARN degraded sweep — $spared_unknown process(es) spared because the systemd MainPID query failed; systemd/D-Bus may be unreachable (cue: reaper-systemd-query-failed)"
fi
if (( downgraded > 0 )); then
  log "WARN $downgraded group-kill(s) downgraded because the process group contained a supervised or otherwise spared member — the classic case is a leaked test process inside a GitHub Actions job, whose pgid is the runner's own session leader (issue #3732) (cue: reaper-group-kill-downgraded)"
fi

# Always exit 0; the timer should not fire failure alerts on a quiet run.
exit 0
