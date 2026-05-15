#!/usr/bin/env bash
#
# status.sh — one-shot snapshot of /hydra-autopilot health (issue #435).
#
# Pretty-prints the three operator-facing artefacts that together answer
# "is the autopilot alive and progressing?":
#
#   1. the per-turn heartbeat line (file + mtime + wedge verdict)
#   2. a compact state.json view (slots, signal_last_fired, burned)
#   3. the last 10 lines of the nightly run log
#
# Designed to be safe to run on demand or from a shell prompt. Reads
# only; never mutates state.
#
# Wedge verdict: if the heartbeat mtime is more than $WEDGE_THRESHOLD_SEC
# seconds in the past AND the recorded pid is still alive, we print a
# bold WEDGE LIKELY line. The threshold defaults to 600s (10 min); the
# longest legitimate decision-turn duration in practice is the hydra-dev
# slow path, which lands under that.
#
# Env (optional):
#   HYDRA_AUTOPILOT_HEARTBEAT  override heartbeat path
#   HYDRA_AUTOPILOT_STATE      override state.json path
#   HYDRA_AUTOPILOT_LOG        override nightly run-log path
#   WEDGE_THRESHOLD_SEC        wedge mtime threshold (default 600)
#
# Exit code is always 0 — diagnostic only.

set -uo pipefail

HEARTBEAT="${HYDRA_AUTOPILOT_HEARTBEAT:-/tmp/hydra-autopilot-heartbeat.txt}"
STATE="${HYDRA_AUTOPILOT_STATE:-/tmp/hydra-autopilot-state.json}"
LOG="${HYDRA_AUTOPILOT_LOG:-/tmp/hydra-autopilot-nightly.log}"
THRESHOLD="${WEDGE_THRESHOLD_SEC:-600}"

now=$(date -u +%s)

echo "=== heartbeat (${HEARTBEAT}) ==="
if [ -f "$HEARTBEAT" ]; then
  mtime=$(stat -c %Y "$HEARTBEAT" 2>/dev/null || stat -f %m "$HEARTBEAT" 2>/dev/null || echo 0)
  age=$(( now - mtime ))
  echo "mtime: $(date -u -d "@${mtime}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "${mtime}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) (age ${age}s)"
  cat "$HEARTBEAT"

  # Extract the pid from the heartbeat line (field 2 of the per-turn
  # format; field 3 of the legacy `start pid=N run_id=...` format).
  # We try the per-turn format first.
  pid=$(awk 'NR==1 { print $2 }' "$HEARTBEAT")
  case "$pid" in
    [0-9]*) ;;
    *) pid=$(awk 'NR==1 { for (i=1;i<=NF;i++) if ($i ~ /^pid=/) { sub(/^pid=/,"",$i); print $i; exit } }' "$HEARTBEAT") ;;
  esac

  if [ "$age" -gt "$THRESHOLD" ] && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo
    echo "!!! WEDGE LIKELY: heartbeat is ${age}s old (> ${THRESHOLD}s) but pid ${pid} is still alive."
    echo "!!! See docs/operator-playbooks/hydra-autopilot.md 'Inspecting a run'."
  fi
else
  echo "(missing — autopilot may not be running)"
fi
echo

echo "=== state (${STATE}) ==="
if [ -f "$STATE" ] && command -v jq >/dev/null 2>&1; then
  jq '{turn, dispatches, cumulative_tokens, slots, signal_last_fired, burned_classes, idle_turns}' "$STATE" 2>/dev/null \
    || cat "$STATE"
elif [ -f "$STATE" ]; then
  cat "$STATE"
else
  echo "(missing)"
fi
echo

echo "=== log tail (${LOG}) ==="
if [ -f "$LOG" ]; then
  tail -n 10 "$LOG"
else
  echo "(missing)"
fi
