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
import urllib.request
import urllib.error
from pathlib import Path

STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))
HYDRA_API_BASE = os.environ.get("HYDRA_API_BASE", "http://localhost:4000")


def post_run_end(run_id: str, cause: str, ended_epoch: int) -> None:
    """Best-effort POST to /api/autopilot/run-end (issue #497).

    Failure is logged to stderr but never propagates — term-check.py exits 0
    so the playbook can still terminate gracefully even if the orchestrator
    is unreachable. The endpoint is idempotent, so playbook retries are safe.
    """
    if not run_id:
        return
    payload = json.dumps({
        "run_id": run_id,
        "cause": cause,
        "ended_epoch": ended_epoch,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{HYDRA_API_BASE}/api/autopilot/run-end",
        data=payload,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        print(f"[autopilot] term-check run-end POST failed: {exc}", file=sys.stderr)


def main() -> int:
    if not STATE_PATH.exists():
        # If Phase 0 hasn't run, treat as OK to avoid spurious termination.
        print("OK state-missing")
        return 0
    s = json.loads(STATE_PATH.read_text())
    limits = s["limits"]
    now = int(time.time())
    elapsed = now - s["started_epoch"]
    tokens = s["cumulative_tokens"]
    slots_occupied = sum(1 for v in s["slots"].values() if v is not None)
    run_id = s.get("run_id", "")

    cause: str | None = None
    if tokens >= limits["token_budget"]:
        cause = "budget"
        print(f"TERM:budget tokens={tokens}/{limits['token_budget']} elapsed={elapsed}s")
    elif elapsed >= limits["wall_clock_max_sec"]:
        cause = "wall_clock"
        print(f"TERM:wall_clock elapsed={elapsed}s/{limits['wall_clock_max_sec']}s tokens={tokens}")
    elif s["idle_turns"] >= limits["idle_drain_turns"] and slots_occupied == 0:
        cause = "idle"
        print(f"TERM:idle idle_turns={s['idle_turns']} slots=0")
    else:
        print(
            f"OK elapsed={elapsed}s tokens={tokens}/{limits['token_budget']} "
            f"idle={s['idle_turns']}/{limits['idle_drain_turns']} slots={slots_occupied}"
        )

    # Issue #497 — register the terminal transition with the orchestrator so
    # the /autopilot dashboard reflects the actual term_reason instead of
    # waiting for the read-time sweeper to misclassify it as `crash`.
    if cause is not None:
        post_run_end(run_id, cause, now)

    return 0


if __name__ == "__main__":
    sys.exit(main())
