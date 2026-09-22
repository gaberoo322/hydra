#!/usr/bin/env python3
"""run_termination.py — canonical Autopilot Run termination-path predicates,
shared across the bash/Python boundary (issue #4305).

Before this file, two operations were independently hand-mirrored:

  1. "is there still work in flight" (`count_slots_occupied`) — the idle-drain
     gate reads this from both `term-check.py`'s Phase 3 pre-check (Python)
     and `bootstrap.sh`'s `--reap` ExecStopPost backstop (bash, via jq).
     `term-check.py`'s old docstring literally said "mirrors
     bootstrap.sh:__reap_count_slots_occupied" — a hand-synced COMMENT
     standing in for a shared implementation, not an actual shared one.

  2. "POST /api/autopilot/run-end with bounded retry" (`post_run_end`) — the
     same shape (try, backoff, retry, give up) independently reimplemented in
     bash (curl, blanket-retry-on-any-non-2xx) and Python (urllib, stops
     early on a 4xx because that caller races decide.py's OWN run-end POST
     the same turn and a 4xx there means "already terminal").

This module is now the ONE implementation of both, following the precedent
`reap.py` already set for `pr-refs.py` (issue #3852): a shared predicate that
a caller loads/imports rather than re-deriving. `bootstrap.sh` shells out to
this file's CLI the same way it already shells out to `heartbeat.py`
(`python3 "$(dirname "$0")/heartbeat.py" ...`); `term-check.py` imports it
directly — both files live in `scripts/autopilot/`, and Python puts the
running script's own directory on `sys.path[0]`, so no `importlib` workaround
is needed here (unlike `pr-refs.py`, this filename has no hyphen).

Each call site keeps its OWN retry count / backoff schedule / early-stop
policy — those differ for good reasons documented at each call site — but the
control flow itself (try, log nothing here, backoff, retry, give up) is
written exactly once.

CLI (bootstrap.sh is the caller; never invoked with a leading `--`):

  count-slots <state.json path>
      Prints the integer work-in-flight count. Degrades to 0 on any
      missing/unreadable/malformed input — NEVER raises, matching the
      pre-existing bash/jq behaviour (an empty/failed jq read also became 0).

  post-run-end --api-base URL --run-id ID --cause CAUSE --exit-code N
               --payload JSON [--backoffs "4 8 16"] [--state PATH]
      Bounded-retry POST to <api-base>/api/autopilot/run-end, replicating
      bootstrap.sh's PRE-EXISTING curl -sf policy exactly (ANY non-2xx or
      connection failure is retryable; no 4xx-is-terminal shortcut — that
      shortcut is term-check.py-specific, see `stop_on_4xx` below). Prints
      the exact log lines `__reap_post_run_end` already printed pre-#4305
      (pinned by test/autopilot-dedup-reap.test.mts). Exits 0 on success,
      1 on exhaustion — the SAME exit contract the bash function had
      (`return 0` / `return 1`); every caller of `__reap_post_run_end`
      already wraps it in `|| true`, so this never aborts the unit stop.

      Issue #4551 follow-up: on a SUCCESSFUL run-end POST (the dedup arm
      included — decide.py already recorded the cause), this now also POSTs
      the run-TALLY amendment (/api/autopilot/run-tally) built from state.json
      (run_id + cumulative_tokens, ended_epoch=now) when the state file's
      run_id matches --run-id. The terminate-time run-end froze the tally at
      the decide instant while drain-phase reaps kept advancing
      state.json cumulative_tokens; this follow-up (firing at true process
      exit, after ALL drain-phase reaps) and the drain.sh tail writer are the
      two deterministic session-tail points that close that gap. Best-effort:
      a failed tally logs to stderr and NEVER changes this subcommand's exit
      code (which stays decided by the run-end POST alone). No follow-up on
      an EXHAUSTED run-end — the orchestrator is down, so the tally would
      only burn the same backoff schedule again before failing too.

  post-run-tally --api-base URL [--state PATH] [--backoffs "4 8"]
      The standalone tally writer — drain.sh's Phase 7 tail invokes this
      after printing its FINAL line (covering interactive runs whose session
      exits without an ExecStopPost reap). Reads run_id + cumulative_tokens
      from state.json (default: $HYDRA_AUTOPILOT_STATE, else
      /tmp/hydra-autopilot-state.json), stamps ended_epoch=now, and POSTs
      with bounded retry where a 4xx is a DETERMINISTIC stop (404 unknown
      run / 400 schema — retrying cannot change the answer). A state with no
      run_id (isolated/test runs) is a silent no-op. ALWAYS exits 0: the
      tally is an amend-only, never-fatal write (design-concept #4551 INV-7)
      — a final failure logs '[autopilot] run-tally POST failed' with the
      run_id to stderr and the run index keeps its last per-turn mirror.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def count_slots_occupied(state: dict) -> int:
    """THE canonical work-in-flight predicate (issue #2030, unified #4305).

    Sums two sources:

      1. Pipeline slots (`state["slots"]`) — a slot is occupied when
         non-null (the long-lived dev/qa/research/design slots).
      2. Background/signal classes fired DURING this run — every
         `state["signal_last_fired"][<class>]` whose timestamp is
         `>= state["started_epoch"]`. These (`sweep_orch` / `retro_orch` /
         `discover_*` / `scout_orch` / `architecture_orch` / `cleanup_*`)
         never enter `slots`, so a slots-only count would see 0 for a
         background-only run and prematurely signal idle/interrupted.

    Pure and total over its input: a missing/garbage `slots`,
    `signal_last_fired`, or `started_epoch` degrades that source to 0 (the
    conservative direction: prefer "busy" over a false idle-terminate /
    false-interrupted reap).
    """
    slots = state.get("slots") or {}
    pipeline = (
        sum(1 for v in slots.values() if v is not None)
        if isinstance(slots, dict)
        else 0
    )
    try:
        start = int(state.get("started_epoch") or 0)
    except (TypeError, ValueError):
        start = 0
    fired = state.get("signal_last_fired") or {}
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


def post_run_end(
    api_base: str,
    payload: bytes,
    *,
    retries: int,
    backoff_schedule: list,
    stop_on_4xx: bool,
    timeout: float = 5.0,
    on_retry=None,
    path: str = "/api/autopilot/run-end",
) -> tuple:
    """Bounded-retry POST to `<api-base>/api/autopilot/run-end` (by default).

    Returns `(outcome, attempts_used)` where `outcome` is one of:

      "success"   — a 2xx response.
      "terminal"  — a 4xx response AND `stop_on_4xx` — the caller's policy
                    for "this counts as done, stop retrying" (term-check.py's
                    policy; NOT bootstrap.sh's, which retries on every
                    non-2xx to match its pre-existing curl -sf behaviour).
      "exhausted" — every attempt failed and none remain.

    NEVER raises. `retries` is the number of RETRY attempts after the first
    try (so total attempts = retries + 1, matching both callers'
    pre-existing "attempts = backoffs + 1" convention). `on_retry`, if given,
    is called as `on_retry(attempt, attempts_total, delay)` immediately
    before sleeping on a retryable failure — the caller uses this to log its
    own attempt-failed line without this function owning any log wording.

    `path` (issue #4551) retargets the SAME bounded loop at the run-TALLY
    endpoint (`/api/autopilot/run-tally`) — the retry/backoff control flow is
    endpoint-agnostic, and this module exists precisely so it is written
    once. The default keeps the original run-end contract bit-for-bit for
    the existing importers (term-check.py) and callers (bootstrap.sh).
    """
    attempts_total = retries + 1
    attempt = 0
    while True:
        attempt += 1
        req = urllib.request.Request(
            f"{api_base}{path}",
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp.read()
            return ("success", attempt)
        except urllib.error.HTTPError as exc:
            if stop_on_4xx and 400 <= exc.code < 500:
                return ("terminal", attempt)
            # Otherwise any HTTP error status is retryable — matches curl
            # -sf, which fails on any status >= 400 with no early-stop
            # distinction between 4xx and 5xx.
        except (urllib.error.URLError, OSError):
            pass
        if attempt >= attempts_total:
            return ("exhausted", attempt)
        idx = attempt - 1
        if backoff_schedule:
            delay = backoff_schedule[idx] if idx < len(backoff_schedule) else backoff_schedule[-1]
        else:
            delay = 0
        try:
            delay = float(delay)
        except (TypeError, ValueError):
            delay = 0.0
        if delay < 0:
            delay = 0.0
        if on_retry is not None:
            on_retry(attempt, attempts_total, delay)
        time.sleep(delay)


def _fmt_delay(delay: float) -> str:
    """Match bash's integer-seconds formatting (`${delay}s`, e.g. `4s`/`0s`).

    Both callers' backoff schedules are always whole seconds; this only
    guards against a non-integral value ever reaching here.
    """
    if float(delay).is_integer():
        return str(int(delay))
    return str(delay)


# ---------------------------------------------------------------------------
# Run-tally amendment (issue #4551)
# ---------------------------------------------------------------------------


def _default_state_path() -> str:
    """The canonical state.json path — same default drain.sh/bootstrap.sh use."""
    return os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json")


def _load_state(path: str):
    """Read state.json as a dict, or None on any missing/unreadable/malformed
    input. NEVER raises — every tally caller degrades to "nothing to amend".
    """
    p = Path(path)
    if not p.is_file():
        return None
    try:
        state = json.loads(p.read_text())
    except Exception:
        # intentional: degrade to None — never blocks the caller's tail step.
        return None
    return state if isinstance(state, dict) else None


def build_run_tally_payload(state: dict):
    """Build the POST /api/autopilot/run-tally body from state.json (#4551).

    Returns the JSON-encoded payload, or None when the state carries no
    run_id (isolated/test runs — nothing to amend). The truth source is
    state.json `cumulative_tokens` — the SAME reap.py-advanced counter
    heartbeat.py already mirrors per turn (#2429); no new token accounting
    (design-concept INV-4). `ended_epoch` is stamped now, per the two
    session-tail writers' contract.
    """
    run_id = str(state.get("run_id") or "").strip()
    if not run_id:
        return None
    try:
        tokens = int(state.get("cumulative_tokens") or 0)
    except (TypeError, ValueError):
        tokens = 0
    if tokens < 0:
        tokens = 0
    return json.dumps(
        {
            "run_id": run_id,
            "cumulative_tokens": tokens,
            "ended_epoch": int(time.time()),
        }
    ).encode("utf-8")


def post_run_tally(
    api_base: str,
    payload: bytes,
    *,
    backoff_schedule: list,
    timeout: float = 5.0,
    on_retry=None,
) -> str:
    """Bounded-retry POST to `<api-base>/api/autopilot/run-tally`.

    The same ONE retry loop as `post_run_end`, retargeted via its `path`
    kwarg, with the tally's OWN early-stop policy: a 4xx is DETERMINISTIC
    (404 unknown run / 400 schema miss — retrying cannot change the answer),
    so `stop_on_4xx=True`. Returns the outcome ("success" / "terminal" /
    "exhausted"); NEVER raises.
    """
    outcome, _attempt = post_run_end(
        api_base,
        payload,
        retries=len(backoff_schedule),
        backoff_schedule=backoff_schedule,
        stop_on_4xx=True,
        timeout=timeout,
        on_retry=on_retry,
        path="/api/autopilot/run-tally",
    )
    return outcome


def _fire_tally_followup(
    api_base: str,
    state_path: str,
    run_id: str,
    backoff_schedule: list,
    *,
    log_prefix: str = "[autopilot] reap:",
) -> None:
    """The #4551 post-run-end follow-up: amend the just-ended run's tally.

    Only fires when the state file's run_id MATCHES the run the caller just
    ended — a newer run may have replaced state.json before the ExecStopPost
    reap fired, and amending the older run from the newer run's tally would
    corrupt it. Best-effort and NEVER fatal: any failure logs a
    '<prefix> run-tally POST failed' line with the run_id to stderr and the
    caller's exit code is untouched (the run-end POST already succeeded; the
    run index keeps its last per-turn mirror).
    """
    state = _load_state(state_path)
    if state is None:
        return
    payload = build_run_tally_payload(state)
    if payload is None:
        return
    if str(state.get("run_id") or "").strip() != run_id:
        return

    def on_retry(attempt: int, total: int, delay: float) -> None:
        print(
            f"{log_prefix} run-tally POST attempt {attempt}/{total} failed "
            f"— retrying in {_fmt_delay(delay)}s"
        )

    outcome = post_run_tally(
        api_base,
        payload,
        backoff_schedule=backoff_schedule,
        on_retry=on_retry,
    )
    if outcome == "success":
        print(f"{log_prefix} run-tally amendment posted run_id={run_id}")
        return
    detail = "4xx deterministic stop" if outcome == "terminal" else "orchestrator down?"
    print(
        f"{log_prefix} run-tally POST failed ({detail}) run_id={run_id} "
        f"— run index keeps the per-turn mirror",
        file=sys.stderr,
    )


def _cli_count_slots(argv: list) -> int:
    count = 0
    if argv:
        path = Path(argv[0])
        if path.is_file():
            try:
                state = json.loads(path.read_text())
                if isinstance(state, dict):
                    count = count_slots_occupied(state)
            except Exception:
                # intentional: degrade to 0 — never blocks the reap/pre-check.
                count = 0
    print(count)
    return 0


def _cli_post_run_end(argv: list) -> int:
    parser = argparse.ArgumentParser(prog="run_termination.py post-run-end")
    parser.add_argument("--api-base", required=True)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--cause", default="unknown")
    parser.add_argument("--exit-code", default="0")
    parser.add_argument("--payload", required=True)
    parser.add_argument("--backoffs", default="4 8 16")
    parser.add_argument(
        "--state",
        default=_default_state_path(),
        help="state.json for the #4551 tally follow-up (default: $HYDRA_AUTOPILOT_STATE)",
    )
    args = parser.parse_args(argv)

    try:
        backoff_schedule = [float(x) for x in args.backoffs.split()]
    except ValueError:
        backoff_schedule = []
    retries = len(backoff_schedule)
    attempts_total = retries + 1

    def on_retry(attempt: int, total: int, delay: float) -> None:
        print(
            f"[autopilot] reap: run-end POST attempt {attempt}/{total} failed "
            f"— retrying in {_fmt_delay(delay)}s"
        )

    outcome, attempt = post_run_end(
        args.api_base,
        args.payload.encode("utf-8"),
        retries=retries,
        backoff_schedule=backoff_schedule,
        stop_on_4xx=False,
        on_retry=on_retry,
    )

    if outcome == "success":
        if attempt > 1:
            print(
                f"[autopilot] reap: recorded run-end run_id={args.run_id} "
                f"cause={args.cause} exit_code={args.exit_code} (idempotent) "
                f"attempt={attempt}/{attempts_total}"
            )
        else:
            print(
                f"[autopilot] reap: recorded run-end run_id={args.run_id} "
                f"cause={args.cause} exit_code={args.exit_code} (idempotent)"
            )
        # Issue #4551: the run-end POST succeeded (first-wins OR the dedup
        # arm — decide.py already recorded the cause at terminate time), so
        # the row is terminal and the tally amendment can land. This fires at
        # true process exit, AFTER all drain-phase reaps advanced
        # state.json cumulative_tokens — the (b) session-tail writer. Never
        # changes this subcommand's exit code (still 0); no follow-up on the
        # exhausted branch below — a down orchestrator would only burn the
        # same backoff schedule again before failing the tally too.
        _fire_tally_followup(
            args.api_base,
            args.state,
            args.run_id,
            backoff_schedule,
        )
        return 0

    # "exhausted" (stop_on_4xx=False means "terminal" can never be returned
    # here) — the EXACT pre-#4305 backstop line; the dead-pid sweeper backstop
    # contract (sweep-reader.ts) is unchanged.
    print(
        f"[autopilot] reap: run-end POST failed (orchestrator down?) "
        f"run_id={args.run_id} cause={args.cause} — sweeper will backstop"
    )
    return 1


def _cli_post_run_tally(argv: list) -> int:
    """The standalone tally writer — drain.sh's Phase 7 tail (issue #4551).

    ALWAYS exits 0 (the tally is amend-only and never fatal — INV-7); a
    final failure logs '[autopilot] run-tally POST failed' with the run_id to
    stderr and the run index keeps its last per-turn mirror.
    """
    parser = argparse.ArgumentParser(prog="run_termination.py post-run-tally")
    parser.add_argument("--api-base", required=True)
    parser.add_argument(
        "--state",
        default=_default_state_path(),
        help="state.json carrying run_id + cumulative_tokens (default: $HYDRA_AUTOPILOT_STATE)",
    )
    parser.add_argument("--backoffs", default="4 8")
    args = parser.parse_args(argv)

    try:
        backoff_schedule = [float(x) for x in args.backoffs.split()]
    except ValueError:
        backoff_schedule = []

    state = _load_state(args.state)
    if state is None:
        print(
            f"[autopilot] run-tally: no readable state at {args.state} — nothing to amend",
            file=sys.stderr,
        )
        return 0
    payload = build_run_tally_payload(state)
    if payload is None:
        # No run_id (isolated/test runs) — a silent no-op, not a failure.
        return 0
    run_id = str(state.get("run_id") or "").strip()

    def on_retry(attempt: int, total: int, delay: float) -> None:
        print(
            f"[autopilot] run-tally: POST attempt {attempt}/{total} failed "
            f"— retrying in {_fmt_delay(delay)}s"
        )

    outcome = post_run_tally(
        args.api_base,
        payload,
        backoff_schedule=backoff_schedule,
        on_retry=on_retry,
    )
    if outcome == "success":
        tokens = json.loads(payload.decode("utf-8"))["cumulative_tokens"]
        print(f"[autopilot] run-tally: amendment posted run_id={run_id} tokens={tokens}")
        return 0
    detail = "4xx deterministic stop" if outcome == "terminal" else "orchestrator down?"
    print(
        f"[autopilot] run-tally POST failed ({detail}) run_id={run_id} "
        f"— run index keeps the per-turn mirror",
        file=sys.stderr,
    )
    return 0


def main(argv: list) -> int:
    if not argv:
        print("usage: run_termination.py <count-slots|post-run-end|post-run-tally> ...", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "count-slots":
        return _cli_count_slots(rest)
    if cmd == "post-run-end":
        return _cli_post_run_end(rest)
    if cmd == "post-run-tally":
        return _cli_post_run_tally(rest)
    print(f"run_termination.py: unknown subcommand {cmd!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
