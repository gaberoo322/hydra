#!/usr/bin/env python3
"""
term-check.py — Phase 3 of /hydra-autopilot.

Reads /tmp/hydra-autopilot-state.json and prints one line:

  TERM:budget     — token budget exhausted, jump to Phase 7
  TERM:wall_clock — wall-clock cap exceeded, jump to Phase 7
  TERM:idle       — idle-drain turns reached with no slots in flight
  OK              — keep iterating

The playbook's Phase 3 instructs the model: "if output starts with
TERM:, jump immediately to Phase 7; if OK, proceed to Phase 4."

This script is intentionally pure — it makes no state mutations.
Slot counting is by `not None`, matching the Phase 0 state shape
(slots[<class>] = null when empty, dict when occupied).

Exit code is always 0; the model parses stdout to make the decision.

Behavior-preserving extraction of the Phase 3 heredoc (issue #409).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))


def main() -> int:
    if not STATE_PATH.exists():
        # If Phase 0 hasn't run, treat as OK to avoid spurious termination.
        print("OK state-missing")
        return 0
    s = json.loads(STATE_PATH.read_text())
    limits = s["limits"]
    elapsed = int(time.time()) - s["started_epoch"]
    tokens = s["cumulative_tokens"]
    slots_occupied = sum(1 for v in s["slots"].values() if v is not None)

    if tokens >= limits["token_budget"]:
        print(f"TERM:budget tokens={tokens}/{limits['token_budget']} elapsed={elapsed}s")
    elif elapsed >= limits["wall_clock_max_sec"]:
        print(f"TERM:wall_clock elapsed={elapsed}s/{limits['wall_clock_max_sec']}s tokens={tokens}")
    elif s["idle_turns"] >= limits["idle_drain_turns"] and slots_occupied == 0:
        print(f"TERM:idle idle_turns={s['idle_turns']} slots=0")
    else:
        print(
            f"OK elapsed={elapsed}s tokens={tokens}/{limits['token_budget']} "
            f"idle={s['idle_turns']}/{limits['idle_drain_turns']} slots={slots_occupied}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
