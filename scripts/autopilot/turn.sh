#!/usr/bin/env bash
#
# turn.sh — one autopilot decision turn, Phases 1–4, as ONE command (issue #4831).
#
#   bash scripts/autopilot/turn.sh [events.json]
#
# Runs, in order, the five scripts the playbook's Loop used to list as
# separate session steps — each of which an unattended session issued as its
# own model call, with hand-written glue between them:
#
#   1. turn-snapshot.ts --format json (Phase 1)  the JSON Turn Snapshot
#      (ADR-0043 slice 6, #4934), every collector in one process, with the
#      slot-events cursor read from state, validated on emit
#   2. turn_snapshot.py apply (Phase 1)  stores it on state.turn_snapshot —
#      the form decide.py reads through scripts/autopilot/turn_snapshot.py
#      FALLBACK (automatic, per turn): if the JSON emit fails (non-zero exit,
#      empty output, unparseable, or validation.ok=false) the turn runs the
#      legacy pair instead — collect-state.sh, then merge-signals.py
#      (collect output → state.signals + blobs, #4829) — exactly as before.
#   3. term-check.py     (Phase 3)   prints TERM:<cause> | OK — informational here;
#                                   decide.py emits the `terminate` action itself
#   4. decide.py decide  (Phase 3)   the plan, written to $HYDRA_AUTOPILOT_PLAN
#   5. assert_invariants.py (Phase 4)
#
# then prints a compact plan summary (turn, actions without the sentinel,
# reasons, the usage percentages) so the session reads one result instead of
# five. The session still owns Phase 5 (executing the actions) and 5a (the
# heartbeat), because those need the Agent tool.
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
#   HYDRA_AUTOPILOT_SNAPSHOT_FORMAT  json (default; kv when COLLECT_REPLAY is
#                                  set) | kv — kv skips the JSON emit and runs
#                                  the legacy pair directly
#   HYDRA_AUTOPILOT_SNAPSHOT_REPLAY  a recorded JSON snapshot to apply INSTEAD
#                                  of running the collectors (unusable → the
#                                  kv path, as for a live emit)
#   HYDRA_AUTOPILOT_COLLECT_OUT    where collect output is written
#                                  (default /tmp/hydra-autopilot-collect.txt)
#   HYDRA_AUTOPILOT_COLLECT_REPLAY a recorded collect output to use INSTEAD of
#                                  running collect-state.sh (the fixture suite,
#                                  and an operator replaying a turn offline)
#
# Exit codes: 0 — plan written and invariants hold; decide.py's own non-zero
# code when it fails (its stderr tail is echoed); 1 when assert_invariants.py
# rejects the plan. A failed JSON emit is NOT fatal (the kv fallback runs), and
# collect-state.sh failing is NOT fatal either: it degrades its own signals
# (orch_board_signals_degraded etc.) and the turn proceeds on what it emitted,
# exactly as the hand-run loop did.
#
# Never writes state.turn (the decide.py CLI owns it, #1769) and never edits
# state.json itself — turn_snapshot.py (or merge-signals.py) and decide.py are
# the only writers here.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$REPO_ROOT" || exit 2

STATE="${HYDRA_AUTOPILOT_STATE:-/tmp/hydra-autopilot-state.json}"
PLAN="${HYDRA_AUTOPILOT_PLAN:-/tmp/hydra-autopilot-plan.json}"
CANDIDATES="${HYDRA_AUTOPILOT_CANDIDATES:-/tmp/hydra-autopilot-candidates.json}"
EVENTS="${1:-${HYDRA_AUTOPILOT_EVENTS:-/tmp/hydra-autopilot-events.json}}"
COLLECT_OUT="${HYDRA_AUTOPILOT_COLLECT_OUT:-/tmp/hydra-autopilot-collect.txt}"
COLLECT_ERR="${COLLECT_OUT%.txt}.err"
SNAPSHOT="${HYDRA_AUTOPILOT_SNAPSHOT:-/tmp/hydra-autopilot-snapshot.json}"
SNAPSHOT_ERR="${SNAPSHOT%.json}.err"

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,61p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [ ! -s "$STATE" ]; then
  echo "[turn] FATAL: no state at $STATE — run bootstrap.sh first (Phase 0)" >&2
  exit 2
fi

# --- Phase 1: collect ------------------------------------------------------
# The cursor lives on state (bootstrap seeds it; the snapshot apply /
# merge-signals.py advances it) — pass it so the slot-events read resumes
# where the last turn ended.
cursor=$(jq -r '.slot_events_last_id // 0' "$STATE" 2>/dev/null || echo 0)

# JSON Turn Snapshot first (ADR-0043 slice 6, #4934); the kv pair below is the
# automatic fallback whenever it does not produce a valid, applied snapshot.
# A kv replay (HYDRA_AUTOPILOT_COLLECT_REPLAY) keeps the turn offline: the
# format then defaults to kv. An EXPLICIT HYDRA_AUTOPILOT_SNAPSHOT_FORMAT=json
# still tries the live emit first, and the replay stands in for collect-state.sh
# only if it falls back (how the fallback itself is tested).
if [ -n "${HYDRA_AUTOPILOT_SNAPSHOT_FORMAT:-}" ]; then
  snapshot_format="$HYDRA_AUTOPILOT_SNAPSHOT_FORMAT"
elif [ -n "${HYDRA_AUTOPILOT_COLLECT_REPLAY:-}" ]; then
  snapshot_format=kv
else
  snapshot_format=json
fi
snapshot_form=kv
if [ -n "${HYDRA_AUTOPILOT_SNAPSHOT_REPLAY:-}" ]; then
  if python3 "$SCRIPT_DIR/turn_snapshot.py" apply "$HYDRA_AUTOPILOT_SNAPSHOT_REPLAY" "$STATE"; then
    snapshot_form=json
    echo "[turn] snapshot: replayed $HYDRA_AUTOPILOT_SNAPSHOT_REPLAY (json)"
  else
    echo "[turn] snapshot replay $HYDRA_AUTOPILOT_SNAPSHOT_REPLAY unusable — falling back to the kv path for this turn" >&2
  fi
elif [ "$snapshot_format" = "json" ]; then
  HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID="$cursor" node --no-warnings --experimental-strip-types \
    "$SCRIPT_DIR/turn-snapshot.ts" --format json --gh-list-limit "${HYDRA_GH_ISSUE_LIST_LIMIT:-100}" \
    >"$SNAPSHOT" 2>"$SNAPSHOT_ERR"
  snapshot_rc=$?
  if [ "$snapshot_rc" -eq 0 ] && [ -s "$SNAPSHOT" ] \
    && python3 "$SCRIPT_DIR/turn_snapshot.py" apply "$SNAPSHOT" "$STATE"; then
    snapshot_form=json
    echo "[turn] snapshot: json cursor=$cursor degraded=$(jq '.degraded | length' "$SNAPSHOT" 2>/dev/null || echo '?')"
  else
    echo "[turn] JSON Turn Snapshot unusable (exit=$snapshot_rc) — falling back to collect-state.sh + merge-signals.py (kv) for this turn" >&2
    tail -3 "$SNAPSHOT_ERR" >&2
  fi
fi

if [ "$snapshot_form" = "kv" ]; then
  if [ -n "${HYDRA_AUTOPILOT_COLLECT_REPLAY:-}" ]; then
    cp "$HYDRA_AUTOPILOT_COLLECT_REPLAY" "$COLLECT_OUT" || { echo "[turn] FATAL: cannot read replay $HYDRA_AUTOPILOT_COLLECT_REPLAY" >&2; exit 2; }
    echo "[turn] collect: replayed $HYDRA_AUTOPILOT_COLLECT_REPLAY"
  else
    HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID="$cursor" bash "$SCRIPT_DIR/collect-state.sh" >"$COLLECT_OUT" 2>"$COLLECT_ERR"
    collect_rc=$?
    echo "[turn] collect: exit=$collect_rc lines=$(wc -l <"$COLLECT_OUT") cursor=$cursor"
    if [ "$collect_rc" -ne 0 ]; then
      echo "[turn] collect-state.sh stderr tail:" >&2
      tail -5 "$COLLECT_ERR" >&2
    fi
  fi
  python3 "$SCRIPT_DIR/merge-signals.py" "$COLLECT_OUT" "$STATE" || { echo "[turn] FATAL: merge-signals.py failed" >&2; exit 2; }
fi

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
jq -c '{percentLast5h: .usage_eligibility.usage.percentLast5h, percentSinceReset: .usage_eligibility.usage.percentSinceReset, allow: .usage_eligibility.allow, quota_baseline, cumulative_tokens, slots_occupied: ([.slots | to_entries[] | select(.value != null) | .key])}' "$STATE"
echo "[turn] OK — plan at $PLAN. Next: execute each action (Phase 5), stamp every dispatch with stamp-slot.py, then heartbeat.py --last-action=<type>."
