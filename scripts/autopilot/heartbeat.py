#!/usr/bin/env python3
"""
heartbeat.py — per-decision-turn heartbeat writer (issue #435).

Background
----------
`/tmp/hydra-autopilot-heartbeat.txt` was historically written ONCE by
`bootstrap.sh` (Phase 0) and never updated for the rest of the run. The
file mtime therefore reflected only the run-start instant; an operator
running `find /tmp/hydra-autopilot-heartbeat.txt -mmin -5` got the same
answer (file modified within 5 minutes) for the first 5 minutes of every
run, then nothing useful afterwards.

The 2026-05-15 silent-wedge incident exposed the gap: a live `claude -p`
autopilot process with a 20-minute-old heartbeat looked identical to
"still working" by file mtime alone, since `claude -p` buffers stdout
and there was no other liveness signal. Operators had no <10-minute
mechanism to distinguish "model is mid-turn thinking" from "model is
wedged and producing nothing".

Contract (issue #435 acceptance criteria)
-----------------------------------------
This script writes ONE line to the heartbeat file every decision turn,
overwriting any previous content. The format is:

    <epoch> <pid> <run_id> turn=<N> dispatches=<M> tokens=<K>
        pipeline_filled=<F>/6 signal_active=<S>/5 last_action=<type>

(One line — newlines above are line-wrap for readability only.)

Field semantics:
  - `<epoch>`         — current unix epoch seconds (drives mtime; the
                        file's mtime is what operators actually grep on
                        via `find -mmin`)
  - `<pid>`           — pid stamped into state.json at Phase 0 (the
                        long-running `claude -p` process)
  - `<run_id>`        — uuid stamped into state.json at Phase 0
  - `turn=<N>`        — state.turn (monotonic across the run)
  - `dispatches=<M>`  — state.dispatches (lifetime count)
  - `tokens=<K>`      — state.cumulative_tokens
  - `pipeline_filled=<F>/6` — count of state.slots entries that are not
                              null (so 0..6). We keep the operator-
                              readable label `pipeline_filled` even
                              though the JSON field is `slots` — the
                              two-name asymmetry was the issue-author's
                              call (see #435 body).
  - `signal_active=<S>/5` — count of state.signal_last_fired entries
                            whose epoch is non-zero AND within the
                            class's cooldown window. "Active" means
                            "fired recently enough that it would still
                            be on cooldown if a new signal arrived".
                            This is the most useful operator-facing
                            interpretation (a signal that fired hours
                            ago and is fully cooled is functionally
                            inactive).
  - `last_action=<type>` — the action.type from the most recent plan,
                            passed in via --last-action. Defaults to
                            "(none)" when omitted (first turn, or no
                            plan written yet).

Wedge detection (operator playbook)
-----------------------------------
A stale heartbeat (mtime >10 min ago) combined with a live process pid
is the canonical signature of a model-loop wedge. Operators run:

    find /tmp/hydra-autopilot-heartbeat.txt -mmin -10
    # ^ empty result + live pid == wedge

The 10-min threshold matches the longest legitimate decision-turn
duration (a hydra-dev dispatch's prompt build + claim, on the slow
path). Anything beyond that is a model that has stopped looping.

Implementation notes
--------------------
- The script is pure (one read + one write); failures only ever degrade
  observability, never autopilot correctness. We catch and log every
  failure path; we never propagate exceptions back to the model.
- `HYDRA_AUTOPILOT_STATE` and `HYDRA_AUTOPILOT_HEARTBEAT` env vars
  override the default paths (used by the regression test).
- Cooldown lookup mirrors `decide.py:SIGNAL_COOLDOWNS` exactly. If those
  values drift here vs there, the signal_active count will lie — the
  test pins the constant to decide.py's via import to avoid that.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Import SIGNAL_COOLDOWNS from decide.py so the cooldown definitions stay
# in lockstep. Path manipulation is intentional — decide.py is a sibling.
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
try:
    from decide import SIGNAL_COOLDOWNS  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — fallback if decide.py is broken
    # Conservative default: every signal class with a 15-min cooldown.
    # If we can't import, observability degrades to "any non-zero
    # signal_last_fired counts as active" — wrong but loud, not silent.
    SIGNAL_COOLDOWNS = {
        "health": 0,
        "sweep_orch": 900,
        "sweep_target": 900,
        "discover_orch": 1800,
        "discover_target": 1800,
    }


STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))
HEARTBEAT_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_HEARTBEAT", "/tmp/hydra-autopilot-heartbeat.txt"))
# Issue #498 — slice 2 wires heartbeat.py into the per-turn POST so the
# /autopilot dashboard sees actions/reasons/slots immediately, not just the
# file mtime. Best-effort; POST failure NEVER aborts the turn (heartbeat is
# observability, not correctness — same contract as slice 1's term-check.py).
PLAN_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_PLAN", "/tmp/hydra-autopilot-plan.json"))
HYDRA_API_BASE = os.environ.get("HYDRA_API_BASE", "http://localhost:4000")
TURN_POST_TIMEOUT_SEC = 3


def _count_pipeline_filled(state: dict) -> int:
    slots = state.get("slots") or {}
    return sum(1 for v in slots.values() if v is not None)


def _count_signal_active(state: dict, now: int) -> int:
    """Count signal classes whose last-fired timestamp is still within
    its cooldown window. `health` has cooldown 0 (always-allowed) and
    is therefore counted as "active" only when its last_fired is the
    current turn (i.e. epoch within 60s); otherwise the 0-cooldown
    semantic would mean "always active forever after the first fire",
    which is operator-confusing.
    """
    last_fired = state.get("signal_last_fired") or {}
    active = 0
    for cls, ts in last_fired.items():
        try:
            ts_i = int(ts or 0)
        except (TypeError, ValueError):
            continue
        if ts_i <= 0:
            continue
        cooldown = SIGNAL_COOLDOWNS.get(cls, 0)
        if cooldown == 0:
            # Treat as active only if very recently fired (within 60s).
            if (now - ts_i) <= 60:
                active += 1
        else:
            if (now - ts_i) < cooldown:
                active += 1
    return active


def _format_line(state: dict, last_action: str, now: int) -> str:
    pid = state.get("pid") or os.getpid()
    run_id = state.get("run_id") or "unknown"
    turn = int(state.get("turn", 0) or 0)
    dispatches = int(state.get("dispatches", 0) or 0)
    tokens = int(state.get("cumulative_tokens", 0) or 0)
    pipeline_filled = _count_pipeline_filled(state)
    signal_active = _count_signal_active(state, now)
    return (
        f"{now} {pid} {run_id} "
        f"turn={turn} dispatches={dispatches} tokens={tokens} "
        f"pipeline_filled={pipeline_filled}/6 "
        f"signal_active={signal_active}/5 "
        f"last_action={last_action}"
    )


def _read_plan() -> dict:
    """Best-effort load of /tmp/hydra-autopilot-plan.json. Returns {} on any
    failure — we don't want a missing-or-malformed plan to suppress the
    turn POST (the turn POST still has meaningful slots_snapshot,
    signals_snapshot, and counter info even with no actions/reasons).
    """
    try:
        return json.loads(PLAN_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _plan_stale_reason(state: dict, plan: dict) -> str | None:
    """Issue #1732 — freshness check before attributing plan actions.

    Returns None when `plan` verifiably belongs to the current
    (run_id, turn) in `state`; otherwise a short reason string explaining
    why the plan must not be attributed to this turn record.

    Background: the default PLAN_PATH (/tmp/hydra-autopilot-plan.json)
    frequently holds a STALE plan — the autopilot session often writes
    decide output to ad-hoc per-turn filenames (`...-plan-r5t1.json`),
    leaving the default path untouched across runs. Joining the live
    state with whatever the default path held misattributed a foreign
    run's `dispatch` actions into turn records (runs ebcfebd2/b2422e61,
    2026-06-11), drifting the run's dispatch counters and polluting the
    retro bundle's idle-streak signal.

    Rules:
      - empty plan ({} — missing/unreadable file) is NOT stale: the turn
        POST proceeds with no actions, exactly as before #1732;
      - a non-empty plan must carry a `run_id` + `turn` stamp matching
        the live state (decide.py stamps both since #1732); an unstamped
        or mismatched plan is stale.
    """
    if not plan:
        return None
    plan_run = plan.get("run_id")
    plan_turn = plan.get("turn")
    if plan_run is None or plan_turn is None:
        return "plan carries no run_id/turn stamp (pre-#1732 plan or foreign writer)"
    state_run = str(state.get("run_id") or "")
    if str(plan_run) != state_run:
        return f"plan run_id={plan_run} != state run_id={state_run}"
    try:
        plan_turn_i = int(plan_turn)
    except (TypeError, ValueError):
        return f"plan turn={plan_turn!r} is not an integer"
    state_turn = int(state.get("turn", 0) or 0)
    if plan_turn_i != state_turn:
        return f"plan turn={plan_turn_i} != state turn={state_turn}"
    return None


def post_turn(state: dict, plan: dict, now: int) -> None:
    """Issue #498 — POST one immutable turn record to /api/autopilot/turn.

    Idempotent on (run_id, turn_n): re-POST at the same turn_n is a no-op
    server-side, so a heartbeat retry never double-counts dispatches.

    Issue #1732 — the plan is attributed ONLY when its run_id/turn stamp
    matches the live state (see `_plan_stale_reason`). A stale plan still
    produces a turn record, but with empty `actions` and an explicit
    `plan-stale-skipped: ...` reason instead of another run's dispatches.

    NEVER raises — every failure path logs to stderr and returns. Heartbeat
    is best-effort observability (issue #435 contract), so an orchestrator
    outage cannot wedge the autopilot turn loop.
    """
    run_id = state.get("run_id") or ""
    if not run_id:
        return
    turn_n = state.get("turn")
    if turn_n is None:
        return

    stale_reason = _plan_stale_reason(state, plan)
    if stale_reason is None:
        actions = plan.get("actions") or []
        reasons = plan.get("reasons") or []
    else:
        # Fail loud (observability contract): record the skip, never
        # attribute a stale plan's actions to this turn.
        print(f"[autopilot] heartbeat: stale plan skipped ({stale_reason})", file=sys.stderr)
        actions = []
        reasons = [f"plan-stale-skipped: {stale_reason}"]

    body = {
        "run_id": run_id,
        "turn_n": int(turn_n),
        "epoch": now,
        "actions": actions,
        "reasons": reasons,
        "slots_snapshot": state.get("slots") or {},
        "signals_snapshot": state.get("signal_last_fired") or {},
        "tokens_after": int(state.get("cumulative_tokens", 0) or 0),
        "idle_turns": int(state.get("idle_turns", 0) or 0),
    }
    try:
        payload = json.dumps(body).encode("utf-8")
    except (TypeError, ValueError) as exc:
        print(f"[autopilot] heartbeat: turn payload serialize failed ({exc})", file=sys.stderr)
        return

    req = urllib.request.Request(
        f"{HYDRA_API_BASE}/api/autopilot/turn",
        data=payload,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TURN_POST_TIMEOUT_SEC) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        # Orchestrator unreachable / slow / 5xx — log and move on.
        print(f"[autopilot] heartbeat: turn POST failed ({exc})", file=sys.stderr)


def write_heartbeat(last_action: str = "(none)", *, now: int | None = None) -> int:
    """Read state.json, build the one-line update, overwrite the
    heartbeat file. Returns 0 on success, non-zero (but never raises)
    on failure — heartbeat is observability, not correctness.
    """
    ts = int(time.time()) if now is None else int(now)
    try:
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        # No state.json yet — bootstrap hasn't run or path is wrong.
        # Still write a minimal heartbeat so mtime advances.
        line = f"{ts} {os.getpid()} unknown turn=0 dispatches=0 tokens=0 pipeline_filled=0/6 signal_active=0/5 last_action={last_action} note=no-state"
        try:
            HEARTBEAT_PATH.write_text(line + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"[autopilot] heartbeat: write failed ({exc})", file=sys.stderr)
            return 2
        return 1
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[autopilot] heartbeat: state read failed ({exc})", file=sys.stderr)
        return 2

    line = _format_line(state, last_action, ts)
    try:
        HEARTBEAT_PATH.write_text(line + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"[autopilot] heartbeat: write failed ({exc})", file=sys.stderr)
        return 2

    # Issue #498 — POST per-turn record to the orchestrator AFTER the file
    # write so a slow/failed POST never delays the file mtime update (which
    # is what wedge-detection grep's on).
    post_turn(state, _read_plan(), ts)
    return 0


def main(argv: list[str]) -> int:
    # Tiny CLI: `heartbeat.py [--last-action <type>]`
    last_action = "(none)"
    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg in ("--last-action", "-a") and i + 1 < len(argv):
            last_action = argv[i + 1]
            i += 2
            continue
        if arg.startswith("--last-action="):
            last_action = arg.split("=", 1)[1]
            i += 1
            continue
        if arg in ("-h", "--help"):
            print(
                "usage: heartbeat.py [--last-action <type>]\n"
                "Writes one line to $HYDRA_AUTOPILOT_HEARTBEAT (default /tmp/hydra-autopilot-heartbeat.txt).\n"
                "Reads $HYDRA_AUTOPILOT_STATE (default /tmp/hydra-autopilot-state.json)."
            )
            return 0
        # Unknown arg — warn and continue (heartbeat is best-effort).
        print(f"[autopilot] heartbeat: ignoring unknown arg {arg!r}", file=sys.stderr)
        i += 1
    return write_heartbeat(last_action)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
