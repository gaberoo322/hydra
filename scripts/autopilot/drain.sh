#!/usr/bin/env bash
#
# drain.sh — Phase 7 of /hydra-autopilot.
#
# Print the final summary line to stdout. Operators see this in
# `journalctl --user -u hydra-autopilot.service`. The actual drain
# (waiting for in-flight class slots) and final hydra-digest dispatch
# stay in the playbook prose because they require the Claude harness:
# bash can't wait on Agent() background tasks.
#
# This script handles the deterministic tail:
#   1. Read state.json for cumulative tokens / dispatch count / budget
#   2. Compute duration HH:MM from started_epoch
#   3. Print the final line
#   4. POST the run-tally amendment (issue #4551) — best-effort, AFTER the
#      FINAL line so the operator-facing summary is never delayed or lost
#
# Usage:
#   drain.sh
#
# Behavior-preserving extraction of the Phase 7 final-line heredoc
# (issue #409); the run-tally tail was added by issue #4551.

set -uo pipefail

STATE_PATH="${HYDRA_AUTOPILOT_STATE:-/tmp/hydra-autopilot-state.json}"
LOG_PATH="${HYDRA_AUTOPILOT_LOG:-/tmp/hydra-autopilot-nightly.log}"

if [ ! -f "$STATE_PATH" ]; then
  echo "[autopilot] FINAL | state-missing | digest=$LOG_PATH"
  exit 0
fi

DRAIN_PROJ="$(python3 "$(dirname "$0")/run_ledger.py" project "$STATE_PATH" started_epoch cumulative_tokens limits.token_budget dispatches)"
python3 - "$DRAIN_PROJ" "$LOG_PATH" <<'PY'
import json, sys, time
s, log_path = json.loads(sys.argv[1]), sys.argv[2]
elapsed = int(time.time()) - s["started_epoch"]
hh, mm = elapsed // 3600, (elapsed % 3600) // 60
duration = f"{hh:02d}:{mm:02d}"
tokens = s["cumulative_tokens"] or 0
budget = s["limits.token_budget"]
dispatches = s["dispatches"] or 0
print(
    f"[autopilot] FINAL | duration={duration} | dispatches={dispatches} | "
    f"tokens={tokens}/{budget} | digest={log_path}"
)
PY

# Issue #4551 — the run-tally amendment, (a) of the two deterministic
# session-tail writers. decide.py POSTed run-end at the terminate decision
# (the first-wins cause of record) while pipeline slots were still in flight;
# Phase 7's reaps have since advanced state.json cumulative_tokens, and this
# is the tail point where that true tally can finally reach the run record
# (the ExecStopPost reap's post-run-end follow-up is writer (b)). The sub-
# command reads run_id + cumulative_tokens from the same STATE_PATH, stamps
# ended_epoch=now, and POSTs /api/autopilot/run-tally — amend-only and
# monotone, so the ordering versus writer (b) is safe either way. A state
# with no run_id (isolated/test runs) is a silent no-op. Best-effort, never
# fatal: it ALWAYS exits 0, logs failures to stderr, and cannot displace the
# FINAL line above.
python3 "$(dirname "$0")/run_termination.py" post-run-tally \
  --api-base "${HYDRA_API_BASE:-http://localhost:4000}" \
  --state "$STATE_PATH" \
  --backoffs "${HYDRA_AUTOPILOT_RUN_TALLY_BACKOFFS:-4 8}" || true
