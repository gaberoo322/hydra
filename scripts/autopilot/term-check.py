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


# Bounded retry for the terminal run-end POST. Three attempts with a short
# linear backoff absorb a transient orchestrator hiccup / race against
# shutdown without blocking the loop for long. The endpoint is idempotent on
# run_id, so retrying after a partial success is safe.
RUN_END_RETRIES = 3
RUN_END_BACKOFF_SEC = 1.0


def post_run_end(run_id: str, cause: str, ended_epoch: int) -> bool:
    """POST to /api/autopilot/run-end with a bounded retry (issue #497, #898).

    Returns True iff a terminal status was recorded (a 2xx, OR a 404/409-class
    response that means the run is already terminal — both are idempotent
    no-ops from this caller's perspective). Returns False if every attempt
    failed to reach the orchestrator.

    Failure NEVER propagates — term-check.py exits 0 so the playbook can still
    terminate gracefully even if the orchestrator is unreachable. But unlike
    the pre-#898 version, a failed terminal POST is now LOUD (a clear stderr
    summary after exhausting retries) instead of a single swallowed line, and
    the systemd ExecStopPost reap hook (scripts/autopilot/bootstrap.sh --reap)
    is the backstop that records the terminal status if every retry here lost.
    """
    if not run_id:
        return False
    payload = json.dumps({
        "run_id": run_id,
        "cause": cause,
        "ended_epoch": ended_epoch,
    }).encode("utf-8")
    last_exc: Exception | None = None
    for attempt in range(1, RUN_END_RETRIES + 1):
        req = urllib.request.Request(
            f"{HYDRA_API_BASE}/api/autopilot/run-end",
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
            return True
        except urllib.error.HTTPError as exc:
            # A 4xx (e.g. 404 unknown run, 409 already-terminal) is a
            # deterministic answer, not a transient fault — the run already
            # has (or can never have) a terminal status from our side. Don't
            # burn retries on it.
            if 400 <= exc.code < 500:
                print(
                    f"[autopilot] term-check run-end got HTTP {exc.code} "
                    f"(treating as already-terminal / idempotent no-op)",
                    file=sys.stderr,
                )
                return True
            last_exc = exc
        except (urllib.error.URLError, OSError) as exc:
            last_exc = exc
        if attempt < RUN_END_RETRIES:
            time.sleep(RUN_END_BACKOFF_SEC * attempt)
    print(
        f"[autopilot] term-check run-end POST FAILED after {RUN_END_RETRIES} "
        f"attempts (run_id={run_id} cause={cause}): {last_exc}. The "
        f"ExecStopPost reap hook will backstop the terminal status.",
        file=sys.stderr,
    )
    return False


def count_slots_occupied(s: dict) -> int:
    """Count "work in flight" for the idle-drain gate (issue #2030).

    Sums two sources, mirroring `bootstrap.sh:__reap_count_slots_occupied`:

      1. Pipeline slots (`s["slots"]`) — a slot is occupied when non-null
         (the 7 long-lived dev/qa/research/design slots).
      2. Background/signal classes fired DURING this run — every
         `s["signal_last_fired"][<class>]` whose timestamp is
         `>= s["started_epoch"]`. These (`sweep_orch` / `retro_orch` /
         `discover_*` / `scout_orch` / `architecture_orch` / `cleanup_*`)
         never enter `slots`, so the prior slots-only count saw 0 for a
         background-only run and prematurely tripped `TERM:idle` — the same
         gap #2030 fixes in the reap baton-pass derivation.

    Pure and total over its input: a missing/garbage `slots`,
    `signal_last_fired`, or `started_epoch` degrades that source to 0 (the
    conservative direction: prefer "busy" over a false idle-terminate).
    """
    slots = s.get("slots") or {}
    pipeline = sum(1 for v in slots.values() if v is not None) if isinstance(slots, dict) else 0
    try:
        start = int(s.get("started_epoch") or 0)
    except (TypeError, ValueError):
        start = 0
    fired = s.get("signal_last_fired") or {}
    background = 0
    if isinstance(fired, dict):
        for ts in fired.values():
            try:
                ts_int = int(ts)
            except (TypeError, ValueError):
                continue
            if ts_int > 0 and ts_int >= start:
                background += 1
    return pipeline + background


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
    slots_occupied = count_slots_occupied(s)
    run_id = s.get("run_id", "")

    cause: str | None = None
    # `tokens` is state.json's `cumulative_tokens` — the per-turn surrogate that
    # reap.py increments on every subagent completion (reap.py: `s["cumulative_tokens"]
    # += total_tokens`). This is a LIVE gate, NOT dead code (issue #2429): the
    # input is the local state file, never the Redis run hash, so it accumulates
    # and fires for any multi-turn run regardless of the print-mode session model
    # (#1352/#1903) that can leave the run hash at 0 for a 1-2-turn run. The run
    # hash `cumulative_tokens` is a downstream MIRROR of this same value (POSTed by
    # heartbeat.py -> recordTurn in src/autopilot/runs.ts), used only for the
    # dashboard — it is NOT what this budget term reads. decide.py's
    # `_check_termination` mirrors this exact comparison, and both are pinned by a
    # regression test (test/autopilot-scripts.test.mts "prints TERM:budget when
    # cumulative tokens >= budget" + INV-005 in assert_invariants.py). Do not
    # "remove the dead branch" — measure state.json first (it is non-zero on any
    # live run; see issue #2429's investigation).
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
