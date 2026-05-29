#!/usr/bin/env bash
#
# housekeeping.sh
#
# Best-effort trigger for the orchestrator's hourly housekeeping chores
# (issue #723, scheduler fold PR-3/4). The five time-boxed chores
# (blocked re-escalation, done-lane pruning, weekly digest, memory
# consolidation, design-concept snapshot) were moved out of the 2-minute
# scheduler tick into the idempotent `POST /api/maintenance/housekeeping`
# endpoint. They still run IN the orchestrator process (they use the live
# eventBus + dynamic imports), so this script just pings the endpoint.
#
# Driven by hydra-housekeeping.timer (OnCalendar=hourly, Persistent=true).
#
# Best-effort by design: a non-200 (orchestrator down, restarting, etc.) is
# logged but NEVER fails hard. Each chore carries its own internal time-guard,
# so a missed hourly tick is harmless — the next tick (or Persistent=true
# catch-up after a downtime window) picks the work back up.

set -uo pipefail

ENDPOINT="${HYDRA_HOUSEKEEPING_ENDPOINT:-http://localhost:4000/api/maintenance/housekeeping}"

log() {
  echo "hydra-housekeeping: $*"
}

# -w writes the HTTP status to stdout after the body; capture both so we can
# log a non-200 without tripping `set -e` (which we deliberately do NOT set).
RESPONSE=$(curl -sS -X POST -m 30 -w $'\n%{http_code}' "$ENDPOINT" 2>&1) || {
  log "WARN curl failed (orchestrator unreachable?): ${RESPONSE}"
  exit 0
}

HTTP_CODE=$(printf '%s' "$RESPONSE" | tail -n1)
BODY=$(printf '%s' "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" == "200" ]]; then
  log "ok (${HTTP_CODE}): ${BODY}"
else
  log "WARN non-200 (${HTTP_CODE}): ${BODY}"
fi

# Always exit 0 — housekeeping is best-effort and must never fail the timer.
exit 0
