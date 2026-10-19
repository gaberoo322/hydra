#!/usr/bin/env bash
#
# turn.sh — one autopilot decision turn, Phases 1–4, as ONE command (issue #4831).
#
#   bash scripts/autopilot/turn.sh [events.json]
#
# Runs, in order, the scripts the playbook's Loop used to list as separate
# session steps — each of which an unattended session issued as its own model
# call, with hand-written glue between them:
#
#   1. turn-snapshot.ts  (Phase 1)   the JSON Turn Snapshot (ADR-0043, #4934):
#                                   every collector in one process, with the
#                                   slot-events cursor read from state,
#                                   validated (and repaired per field) on emit
#   2. turn_snapshot.py apply (Phase 1)  stores it on state.turn_snapshot — the
#                                   ONE form decide.py, render-dispatch.py and
#                                   term-check.py read, through
#                                   scripts/autopilot/turn_snapshot.py. A failed
#                                   emit or an unusable document stores the
#                                   ALL-DEGRADED snapshot instead (conservative:
#                                   nothing available, every producer cap
#                                   saturated, health_fail) — the turn still plans.
#   3. term-check.py     (Phase 3)   prints TERM:<cause> | OK — informational here;
#                                   decide.py emits the `terminate` action itself
#   4. decide.py decide  (Phase 3)   the plan, written to $HYDRA_AUTOPILOT_PLAN
#   5. assert_invariants.py (Phase 4)
#
# then prints a compact plan summary (turn, actions without the sentinel,
# reasons) and the usage summary (`turn_snapshot.py summary`) so the session
# reads one result instead of five. The session still owns Phase 5 (executing
# the actions) and 5a (the heartbeat), because those need the Agent tool.
#
# Inputs
#   events.json   typed-event list for decide.py (default
#                 $HYDRA_AUTOPILOT_EVENTS = /tmp/hydra-autopilot-events.json);
#                 an absent file means `[]` — never a missing argument error,
#                 because most turns have no events.
#   candidates    $HYDRA_AUTOPILOT_CANDIDATES (default
#                 /tmp/hydra-autopilot-candidates.json); created as
#                 {"candidates": []} when absent (the retired-substrate shape,
#                 ADR-0031).
#
# Env overrides (tests, replays)
#   HYDRA_AUTOPILOT_STATE / _PLAN / _CANDIDATES / _EVENTS   the /tmp paths
#   HYDRA_AUTOPILOT_SNAPSHOT       where the JSON Turn Snapshot is written
#                                  (default /tmp/hydra-autopilot-snapshot.json)
#   HYDRA_AUTOPILOT_SNAPSHOT_REPLAY  a recorded JSON snapshot to apply INSTEAD
#                                  of running the collectors (the fixture
#                                  suite, and an operator replaying a turn
#                                  offline); unusable → all-degraded, as live
#
# Exit codes: 0 — plan written and invariants hold; decide.py's own non-zero
# code when it fails (its stderr tail is echoed); 1 when assert_invariants.py
# rejects the plan; 2 when the state is missing or cannot be written. A failed
# or unusable snapshot is NOT fatal: the all-degraded snapshot is applied and
# the turn proceeds on it.
#
# Never writes state.turn (the decide.py CLI owns it, #1769) and never edits
# state.json itself — turn_snapshot.py and decide.py are the only writers here.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$REPO_ROOT" || exit 2

STATE="${HYDRA_AUTOPILOT_STATE:-/tmp/hydra-autopilot-state.json}"
PLAN="${HYDRA_AUTOPILOT_PLAN:-/tmp/hydra-autopilot-plan.json}"
CANDIDATES="${HYDRA_AUTOPILOT_CANDIDATES:-/tmp/hydra-autopilot-candidates.json}"
EVENTS="${1:-${HYDRA_AUTOPILOT_EVENTS:-/tmp/hydra-autopilot-events.json}}"
SNAPSHOT="${HYDRA_AUTOPILOT_SNAPSHOT:-/tmp/hydra-autopilot-snapshot.json}"
SNAPSHOT_ERR="${SNAPSHOT%.json}.err"

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,59p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [ ! -s "$STATE" ]; then
  echo "[turn] FATAL: no state at $STATE — run bootstrap.sh first (Phase 0)" >&2
  exit 2
fi

# --- Phase 1: collect ------------------------------------------------------
# The cursor lives on state (bootstrap seeds it; the snapshot apply advances
# it) — pass it so the slot-events read resumes where the last turn ended.
cursor=$(jq -r '.slot_events_last_id // 0' "$STATE" 2>/dev/null || echo 0)

if [ -n "${HYDRA_AUTOPILOT_SNAPSHOT_REPLAY:-}" ]; then
  echo "[turn] snapshot: replaying $HYDRA_AUTOPILOT_SNAPSHOT_REPLAY"
  apply_args=("$HYDRA_AUTOPILOT_SNAPSHOT_REPLAY")
else
  HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID="$cursor" node --no-warnings --experimental-strip-types \
    "$SCRIPT_DIR/turn-snapshot.ts" --format json --gh-list-limit "${HYDRA_GH_ISSUE_LIST_LIMIT:-100}" \
    >"$SNAPSHOT" 2>"$SNAPSHOT_ERR"
  snapshot_rc=$?
  if [ "$snapshot_rc" -eq 0 ]; then
    apply_args=("$SNAPSHOT")
  else
    # Never trust a partial document from a failed emit: the turn plans on
    # the all-degraded snapshot instead.
    echo "[turn] JSON Turn Snapshot emit failed (exit=$snapshot_rc) — applying the all-degraded snapshot for this turn" >&2
    tail -3 "$SNAPSHOT_ERR" >&2
    apply_args=(--degraded "turn-snapshot.ts exited $snapshot_rc")
  fi
fi
if ! applied=$(python3 "$SCRIPT_DIR/turn_snapshot.py" apply "${apply_args[@]}" "$STATE"); then
  echo "[turn] FATAL: turn_snapshot.py apply could not update $STATE" >&2
  exit 2
fi
echo "[turn] snapshot: $(jq -r '"form=\(.form) degraded=\(.degraded)"' <<<"$applied" 2>/dev/null || echo "$applied") cursor=$cursor"

# --- Phase 3: term-check (informational) + decide ----------------------------
HYDRA_AUTOPILOT_STATE="$STATE" python3 "$SCRIPT_DIR/term-check.py" 2>&1 | tail -1 | sed 's/^/[turn] term-check: /'

[ -s "$CANDIDATES" ] || printf '{"candidates": []}\n' >"$CANDIDATES"
if [ ! -s "$EVENTS" ]; then
  printf '[]\n' >"$EVENTS"
  echo "[turn] events: none ($EVENTS absent → [])"
fi

decide_err="${PLAN%.json}.decide.err"
python3 "$SCRIPT_DIR/decide.py" decide "$STATE" "$CANDIDATES" "$EVENTS" >"$PLAN" 2>"$decide_err"
decide_rc=$?
if [ "$decide_rc" -ne 0 ] || [ ! -s "$PLAN" ]; then
  echo "[turn] FATAL: decide.py exit=$decide_rc" >&2
  tail -5 "$decide_err" >&2
  exit "$(( decide_rc == 0 ? 2 : decide_rc ))"
fi

# --- Phase 4: invariants ------------------------------------------------------
if ! python3 "$SCRIPT_DIR/assert_invariants.py" "$PLAN" "$STATE"; then
  echo "[turn] FATAL: assert_invariants.py rejected the plan — do NOT execute it" >&2
  exit 1
fi

# --- Summary -----------------------------------------------------------------
jq -c '{turn, actions: [.actions[] | del(.dispatchSentinel)], reasons: (.reasons // [])}' "$PLAN"
python3 "$SCRIPT_DIR/turn_snapshot.py" summary "$STATE"
echo "[turn] OK — plan at $PLAN. Next: execute each action (Phase 5), stamp every dispatch with stamp-slot.py, then heartbeat.py --last-action=<type>."
