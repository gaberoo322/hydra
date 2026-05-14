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
#
# Usage:
#   drain.sh <merged_prs>
#
# Behavior-preserving extraction of the Phase 7 final-line heredoc
# (issue #409).

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
