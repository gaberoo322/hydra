#!/usr/bin/env python3
"""
term-check.py — Phase 3 of /hydra-autopilot.

Reads /tmp/hydra-autopilot-state.json and prints one line:

  TERM:quota               — this run's account-utilization delta crossed its
                              opt-in quota cap (issue #3867; jump to Phase 7)
  TERM:budget              — token budget exhausted, jump to Phase 7
  TERM:wall_clock          — wall-clock cap exceeded, jump to Phase 7
  TERM:idle                — idle-drain turns reached with no slots in flight
  TERM:context_compaction  — periodic session-restart cadence reached
                              (issue #3787 — cuts the parent session's own
                              prompt-cache re-read cost; jump to Phase 7)
  OK                       — keep iterating

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
import math
import os
import sys
import time
from pathlib import Path

# Issue #4305: `count_slots_occupied` and the run-end POST retry loop used to
# be reimplemented here AND independently in `bootstrap.sh` (`__reap_...`
# functions) — two hand-mirrored copies of the same predicates, kept in sync
# only by prose comments. `run_termination.py` (same directory — Python puts
# the running script's own dir on sys.path[0], so a plain import resolves it;
# no importlib workaround needed, unlike pr-refs.py's hyphenated filename) is
# now the ONE implementation both this file and bootstrap.sh use.
from run_termination import count_slots_occupied as _shared_count_slots_occupied
from run_termination import post_run_end as _shared_post_run_end

STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))
HYDRA_API_BASE = os.environ.get("HYDRA_API_BASE", "http://localhost:4000")

# Periodic session-restart cadence (issue #3787). Mirrors
# `decide.py.CONTEXT_COMPACTION_TURNS_DEFAULT` — see that constant's
# docstring for the full rationale (including the raw-API-call vs Autopilot-
# Turn unit correction against the issue's literal 80-120 figure). Kept as a
# literal duplicate rather than an import: term-check.py is intentionally
# dependency-free (stdlib only) so Phase 3 stays a cheap, side-effect-free
# pre-check ahead of the authoritative Phase 4 `decide.py` invocation, which
# mirrors this exact comparison via `state.limits.context_compaction_turns`.
CONTEXT_COMPACTION_TURNS_DEFAULT = 8

# Quota-percent budget (issue #3867). Mirrors `decide.py`'s `_quota_caps` /
# `_quota_current_percents` / `_quota_delta_exceeded` — see the block comment
# above `decide.py.QUOTA_CAP_DISABLED` for the full rationale (the token budget
# is denominated in subagent-reported tokens, which under-measure real
# cache-weighted account utilization by ~2 orders of magnitude; run 2bcba309
# "spent" 801k of 4M while the meter moved 2% -> 30%).
#
# Kept as a literal mirror rather than an import, the same convention as
# CONTEXT_COMPACTION_TURNS_DEFAULT above: term-check.py is intentionally
# dependency-free so Phase 3 stays a cheap, SIDE-EFFECT-FREE pre-check ahead of
# the authoritative Phase 4 `decide.py` invocation.
#
# The one asymmetry — and it is deliberate, not drift: decide.py OWNS the baseline
# capture (`_capture_quota_baseline`, which mutates state.json), because that is a
# side effect. term-check.py only READS `state.quota_baseline`, so on the very
# first turn of a run (before decide.py has captured anything) it simply prints OK
# and the authoritative check happens moments later in Phase 4. Both files clamp a
# negative delta to zero identically, so a mid-run 5h-window reset can never trip
# either one.
QUOTA_CAP_DISABLED = 0.0


def _quota_finite_pct(value) -> float | None:
    """Mirror of `decide.py._quota_finite_pct` — usable percentage, or None.

    Rejects bools (a JSON `true` must never read as 1%), non-numerics, NaN/±inf,
    and negatives.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    if not math.isfinite(f) or f < 0:
        return None
    return f


def _quota_caps(limits: dict) -> tuple[float, float]:
    """Mirror of `decide.py._quota_caps` — `(cap_5h_pts, cap_week_pts)`.

    `0.0` means DISABLED; absent / negative / unparseable also resolve to
    disabled (the fail-safe direction — an accidental tiny cap would terminate
    healthy runs instantly).
    """
    def _one(key: str) -> float:
        try:
            raw = limits.get(key, 0)
            v = float(raw if raw is not None else 0)
        except (TypeError, ValueError):
            return QUOTA_CAP_DISABLED
        if not math.isfinite(v) or v <= 0:
            return QUOTA_CAP_DISABLED
        return v

    return _one("quota_5h_max_pts"), _one("quota_week_max_pts")


def _quota_current_percents(s: dict) -> tuple[float | None, float | None]:
    """Mirror of `decide.py._quota_current_percents`.

    Reads `state.usage_eligibility.usage` (injected every turn by
    collect-state.sh — zero new I/O). `(None, None)` when the meter is not usable:
    an absent / malformed payload, or `calibrated` anything other than `True`.
    """
    raw = s.get("usage_eligibility")
    if not isinstance(raw, dict):
        return (None, None)
    usage = raw.get("usage")
    if not isinstance(usage, dict) or usage.get("calibrated") is not True:
        return (None, None)
    return (
        _quota_finite_pct(usage.get("percentLast5h")),
        _quota_finite_pct(usage.get("percentSinceReset")),
    )


def quota_delta_exceeded(s: dict) -> tuple[str, str] | None:
    """Mirror of `decide.py._quota_delta_exceeded` — `(window, detail)` or None.

    PURE. Fail-open (returns None, keep iterating) on every uncertain condition:
    cap disabled, no `quota_baseline` captured yet, no usable current reading. The
    5h window is checked before the weekly one (tighter, faster-moving bound, and
    the one the issue's acceptance criterion names). A negative delta is clamped
    to zero so a mid-run window reset never reads as spend.
    """
    limits = s.get("limits") or {}
    cap_5h, cap_week = _quota_caps(limits)
    if cap_5h <= 0 and cap_week <= 0:
        return None
    base = s.get("quota_baseline")
    if not isinstance(base, dict):
        return None
    cur_5h, cur_week = _quota_current_percents(s)

    for window, cap, cur, base_key in (
        ("5h", cap_5h, cur_5h, "percent_5h"),
        ("week", cap_week, cur_week, "percent_week"),
    ):
        if cap <= 0 or cur is None:
            continue
        prev = _quota_finite_pct(base.get(base_key))
        if prev is None:
            continue
        delta = cur - prev
        if delta < 0:
            delta = 0.0
        if delta >= cap:
            return (
                window,
                f"{window} utilization +{delta:.1f}pts >= cap {cap:.1f}pts "
                f"(baseline={prev:.1f} current={cur:.1f})",
            )
    return None


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

    Issue #4305: the retry-with-backoff LOOP is now `run_termination.py`'s
    shared `post_run_end` (the same implementation `bootstrap.sh` shells out
    to) — this wrapper owns only the request-body shape, ITS OWN retry count
    (RUN_END_RETRIES=3) / backoff (linear, RUN_END_BACKOFF_SEC-based) /
    early-stop-on-4xx policy, and its own log wording, all unchanged from
    pre-#4305.
    """
    if not run_id:
        return False
    payload = json.dumps({
        "run_id": run_id,
        "cause": cause,
        "ended_epoch": ended_epoch,
    }).encode("utf-8")
    # Linear backoff (1x, 2x, ... RUN_END_BACKOFF_SEC), matching the
    # pre-#4305 `time.sleep(RUN_END_BACKOFF_SEC * attempt)` schedule exactly.
    backoff_schedule = [RUN_END_BACKOFF_SEC * n for n in range(1, RUN_END_RETRIES)]
    outcome, attempt = _shared_post_run_end(
        HYDRA_API_BASE,
        payload,
        retries=RUN_END_RETRIES - 1,
        backoff_schedule=backoff_schedule,
        stop_on_4xx=True,
        timeout=5.0,
    )
    if outcome == "success":
        return True
    if outcome == "terminal":
        print(
            f"[autopilot] term-check run-end got a 4xx "
            f"(treating as already-terminal / idempotent no-op)",
            file=sys.stderr,
        )
        return True
    print(
        f"[autopilot] term-check run-end POST FAILED after {attempt} "
        f"attempts (run_id={run_id} cause={cause}). The "
        f"ExecStopPost reap hook will backstop the terminal status.",
        file=sys.stderr,
    )
    return False


def count_slots_occupied(s: dict) -> int:
    """Count "work in flight" for the idle-drain gate (issue #2030).

    Issue #4305: this is now a thin wrapper over `run_termination.py`'s
    canonical `count_slots_occupied` — THE ONE implementation of the
    predicate, also used by `bootstrap.sh`'s `__reap_count_slots_occupied`
    (which shells out to the same module). See that function's docstring for
    the full two-source derivation (pipeline slots + this-run background
    fires) and the conservative degrade-to-0 behaviour on malformed input.
    """
    return _shared_count_slots_occupied(s)


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
    # Quota-percent budget (issue #3867) — checked FIRST, mirroring decide.py's
    # `_check_termination` ordering. When both this and the token budget trip on
    # the same turn, `quota` is the more diagnostic cause: it is denominated in
    # the currency the operator actually pays, whereas `cumulative_tokens`
    # under-measures real cache-weighted spend by ~2 orders of magnitude. Disabled
    # by default (`limits.quota_*_max_pts` absent or 0), so on a default run this
    # branch is inert and `budget` still wins exactly as it did pre-#3867.
    quota_hit = quota_delta_exceeded(s)
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
    if quota_hit is not None:
        cause = "quota"
        print(f"TERM:quota {quota_hit[1]} elapsed={elapsed}s")
    elif tokens >= limits["token_budget"]:
        cause = "budget"
        print(f"TERM:budget tokens={tokens}/{limits['token_budget']} elapsed={elapsed}s")
    elif elapsed >= limits["wall_clock_max_sec"]:
        cause = "wall_clock"
        print(f"TERM:wall_clock elapsed={elapsed}s/{limits['wall_clock_max_sec']}s tokens={tokens}")
    elif s["idle_turns"] >= limits["idle_drain_turns"] and slots_occupied == 0:
        cause = "idle"
        print(f"TERM:idle idle_turns={s['idle_turns']} slots=0")
    else:
        # Periodic session-restart (issue #3787) — checked LAST, mirroring
        # decide.py's `_check_termination` ordering, so a genuinely urgent
        # condition above always wins on the same turn. Deliberately NOT
        # gated on `slots_occupied == 0` (unlike `idle` above): see
        # decide.py's CONTEXT_COMPACTION_TURNS_DEFAULT docstring.
        try:
            compaction_turns = int(
                limits.get("context_compaction_turns", CONTEXT_COMPACTION_TURNS_DEFAULT)
            )
        except (TypeError, ValueError):
            compaction_turns = CONTEXT_COMPACTION_TURNS_DEFAULT
        turn = int(s.get("turn", 0) or 0)
        if compaction_turns > 0 and turn > 0 and turn % compaction_turns == 0:
            cause = "context_compaction"
            print(f"TERM:context_compaction turn={turn} cadence={compaction_turns}")

    if cause is None:
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
