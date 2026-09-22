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
#   3. Accept merged_PRs as a positional arg (the playbook counts this
#      during Phase 2 reaps; bash can't recover it from state alone)
#   4. Print the final line
#   5. POST the run-tally amendment (issue #4551) — best-effort, AFTER the
#      FINAL line so the operator-facing summary is never delayed or lost
#
# Usage:
#   drain.sh <merged_prs>
#
# Behavior-preserving extraction of the Phase 7 final-line heredoc
# (issue #409); the run-tally tail was added by issue #4551.

set -uo pipefail

STATE_PATH="${HYDRA_AUTOPILOT_STATE:-/tmp/hydra-autopilot-state.json}"
LOG_PATH="${HYDRA_AUTOPILOT_LOG:-/tmp/hydra-autopilot-nightly.log}"

merged_prs="${1:-0}"

if [ ! -f "$STATE_PATH" ]; then
  echo "[autopilot] FINAL | state-missing | digest=$LOG_PATH"
  exit 0
fi

python3 - "$STATE_PATH" "$merged_prs" "$LOG_PATH" <<'PY'
import json, sys, time
state_path, merged_prs, log_path = sys.argv[1], sys.argv[2], sys.argv[3]
s = json.load(open(state_path))
elapsed = int(time.time()) - s["started_epoch"]
hh, mm = elapsed // 3600, (elapsed % 3600) // 60
duration = f"{hh:02d}:{mm:02d}"
tokens = s.get("cumulative_tokens", 0)
budget = s["limits"]["token_budget"]
dispatches = s.get("dispatches", 0)
print(
    f"[autopilot] FINAL | duration={duration} | dispatches={dispatches} | "
    f"tokens={tokens}/{budget} | merged_PRs={merged_prs} | digest={log_path}"
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
