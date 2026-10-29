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
        pipeline_filled=<F>/<P> signal_active=<S>/<Q> last_action=<type>

(One line — newlines above are line-wrap for readability only.)

The denominators `<P>` and `<Q>` are derived from the Dispatch-Class
Taxonomy (scripts/autopilot/classes.json) via decide.py's PIPELINE_SLOTS and
SIGNAL_CLASSES tuples — `len(PIPELINE_SLOTS)` / `len(SIGNAL_CLASSES)` — never
hardcoded (issue #4637; the old literal 6 / 5 had drifted from the live
alphabet).

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
  - `pipeline_filled=<F>/<P>` — count of PIPELINE_SLOTS keys whose
                              state.slots entry is not null (so 0..P;
                              a stale non-taxonomy key never counts).
                              We keep the operator-
                              readable label `pipeline_filled` even
                              though the JSON field is `slots` — the
                              two-name asymmetry was the issue-author's
                              call (see #435 body).
  - `signal_active=<S>/<Q>` — count of SIGNAL_CLASSES whose
                            state.signal_last_fired epoch is non-zero AND
                            within the
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
  runtime failure path; we never propagate those back to the model. The ONE
  deliberate exception is the import of decide.py's taxonomy tuples: it has
  no fallback (issue #4637) — if decide.py cannot load classes.json there
  was no decision turn to report, and a fallback alphabet would be exactly
  the hardcoded class list the taxonomy exists to kill.
- `HYDRA_AUTOPILOT_STATE` and `HYDRA_AUTOPILOT_HEARTBEAT` env vars
  override the default paths (used by the regression test).
- Cooldown lookup IS `decide.py:SIGNAL_COOLDOWNS` (imported, not copied),
  so it cannot drift from the taxonomy.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Import the taxonomy-derived alphabet from decide.py (which loads
# scripts/autopilot/classes.json fail-loud at import) so the denominators,
# the counted keys and the cooldowns all come from the one table. Path
# manipulation is intentional — decide.py is a sibling. NO try/except
# fallback (issue #4637): an import failure propagates (fail loud) rather
# than substituting a hardcoded class list that silently drifts.
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from decide import PIPELINE_SLOTS, SIGNAL_CLASSES, SIGNAL_COOLDOWNS  # type: ignore[import-not-found]  # noqa: E402
import run_ledger  # noqa: E402  (the ONE state-document parser, #5075)

# Heartbeat-line denominators, derived from the taxonomy (never literals).
PIPELINE_DENOMINATOR = len(PIPELINE_SLOTS)
SIGNAL_DENOMINATOR = len(SIGNAL_CLASSES)


STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))
HEARTBEAT_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_HEARTBEAT", "/tmp/hydra-autopilot-heartbeat.txt"))
# Issue #498 — slice 2 wires heartbeat.py into the per-turn POST so the
# /autopilot dashboard sees actions/reasons/slots immediately, not just the
# file mtime. Best-effort; POST failure NEVER aborts the turn (heartbeat is
# observability, not correctness — same contract as the other autopilot scripts).
PLAN_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_PLAN", "/tmp/hydra-autopilot-plan.json"))
HYDRA_API_BASE = os.environ.get("HYDRA_API_BASE", "http://localhost:4000")
TURN_POST_TIMEOUT_SEC = 3


def _count_pipeline_filled(state: dict) -> int:
    """Count PIPELINE_SLOTS keys whose state.slots entry is non-null. Only
    taxonomy keys count, so a stale/unknown key in state.json can never push
    the numerator past PIPELINE_DENOMINATOR.
    """
    slots = state.get("slots") or {}
    return sum(1 for name in PIPELINE_SLOTS if slots.get(name) is not None)


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
    # Iterate the taxonomy's SIGNAL_CLASSES, not last_fired.items(): a stale
    # non-taxonomy key in state.json can never push the numerator past
    # SIGNAL_DENOMINATOR (issue #4637).
    for cls in SIGNAL_CLASSES:
        ts = last_fired.get(cls)
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
        f"pipeline_filled={pipeline_filled}/{PIPELINE_DENOMINATOR} "
        f"signal_active={signal_active}/{SIGNAL_DENOMINATOR} "
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
        or mismatched plan is stale. The `(run_id, turn)` equality is
        STRICT — no tolerance window. Since #1769 the decide.py CLI is
        the SINGLE writer of `state.turn` (one pre-decide bump, persisted
        atomically before the plan is stamped), so a fresh plan matches
        by construction and any mismatch is a real contract violation —
        an exact `plan.turn == state.turn - 1` lag means something other
        than decide.py incremented the counter, and the reason string
        names that cause so the retro bundle can self-diagnose.
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
        reason = f"plan turn={plan_turn_i} != state turn={state_turn}"
        if plan_turn_i == state_turn - 1:
            # Diagnostic only — the guard stays strict. decide.py owns the
            # turn counter (#1769), so an exact off-by-one can only mean a
            # second writer (e.g. a session-improvised bump) violated the
            # single-writer contract.
            reason += (
                " (exact off-by-one: state.turn is only incremented by"
                " decide.py — see #1769)"
            )
        return reason
    return None


def _fold_decisions(events: list) -> dict:
    """Fold decide.py's dispatch_decision events into {class: {outcome, reason}}.

    Issue #4635 (ADR-0034 §9.2) — heartbeat FORWARDS, never re-derives: the
    per-class verdicts persisted on the turn row are exactly what decide.py
    already emitted, folded in event order with last-write-wins — EXCEPT
    that an outcome of 'dispatched' is sticky (a dispatch that already
    happened stays attributed to this turn even if a later event in the
    same plan re-evaluates the class). Malformed events are skipped, never
    raised on: this helper runs on the turn-POST path, which is best-effort
    observability.
    """
    decisions: dict = {}
    if not isinstance(events, list):
        return decisions
    for ev in events:
        if not isinstance(ev, dict):
            continue
        if ev.get("event") != "dispatch_decision":
            continue
        cls = ev.get("class")
        outcome = ev.get("outcome")
        reason = ev.get("reason")
        if not isinstance(cls, str) or not isinstance(outcome, str) or not isinstance(reason, str):
            continue
        prev = decisions.get(cls)
        if isinstance(prev, dict) and prev.get("outcome") == "dispatched":
            continue
        decisions[cls] = {"outcome": outcome, "reason": reason}
    return decisions


def post_turn(state: dict, plan: dict, now: int) -> None:
    """Issue #498 — POST one immutable turn record to /api/autopilot/turn.

    Idempotent on (run_id, turn_n): re-POST at the same turn_n is a no-op
    server-side, so a heartbeat retry never double-counts dispatches.

    Issue #1732 — the plan is attributed ONLY when its run_id/turn stamp
    matches the live state (see `_plan_stale_reason`). A stale plan still
    produces a turn record, but with empty `actions` and an explicit
    `plan-stale-skipped: ...` reason instead of another run's dispatches.

    Issue #1769 — the freshness equality is strict because the decide.py
    CLI is the single writer of `state.turn` (pre-decide bump, persisted
    atomically before the plan is stamped), so plan and state agree by
    construction. A stale-plan record still POSTs — empty `actions`, but
    the explicit reason — so an idle or contract-violating turn keeps its
    diagnostic trail (the run-69442b4c failure was losing exactly that).

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
    # Issue #4635 (ADR-0034 §9.2): the observability fields below are only
    # trustworthy off a plan decide.py actually produced for THIS turn —
    # empty ({} — missing/unreadable) is just as vacuous as stale.
    plan_usable = bool(plan) and stale_reason is None
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
        # Issue #4635 (ADR-0034 §9.2): burned_classes comes from state
        # (decide.py's own view), so it is sent on EVERY turn regardless of
        # plan staleness.
        "burned_classes": state.get("burned_classes") or [],
    }
    # Issue #4635 (ADR-0034 §9.2): forward the turn's per-class decisions
    # and usage-gate verdicts — folded from decide.py's own plan events /
    # debug block, NEVER re-derived here. Omitted entirely (not {} / true)
    # when the plan is stale or empty, so the server-side verdict freshness
    # reads 'unknown' rather than trusting a vacuous verdict.
    if plan_usable:
        debug = plan.get("debug")
        if not isinstance(debug, dict):
            debug = {}
        body["decisions"] = _fold_decisions(plan.get("events"))
        shed = debug.get("usage_shed")
        body["usage_shed"] = shed if isinstance(shed, list) else []
        body["usage_allow"] = "usage_dispatch_blocked" not in debug
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
        state = run_ledger.load(STATE_PATH, fill_defaults=False)
    except FileNotFoundError:
        # No state.json yet — bootstrap hasn't run or path is wrong.
        # Still write a minimal heartbeat so mtime advances.
        line = f"{ts} {os.getpid()} unknown turn=0 dispatches=0 tokens=0 pipeline_filled=0/{PIPELINE_DENOMINATOR} signal_active=0/{SIGNAL_DENOMINATOR} last_action={last_action} note=no-state"
        try:
            HEARTBEAT_PATH.write_text(line + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"[autopilot] heartbeat: write failed ({exc})", file=sys.stderr)
            return 2
        return 1
    except (ValueError, OSError, run_ledger.LedgerTypeError) as exc:
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
