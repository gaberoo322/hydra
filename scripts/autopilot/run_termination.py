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
               --payload JSON [--backoffs "4 8 16"]
      Bounded-retry POST to <api-base>/api/autopilot/run-end, replicating
      bootstrap.sh's PRE-EXISTING curl -sf policy exactly (ANY non-2xx or
      connection failure is retryable; no 4xx-is-terminal shortcut — that
      shortcut is term-check.py-specific, see `stop_on_4xx` below). Prints
      the exact log lines `__reap_post_run_end` already printed pre-#4305
      (pinned by test/autopilot-dedup-reap.test.mts). Exits 0 on success,
      1 on exhaustion — the SAME exit contract the bash function had
      (`return 0` / `return 1`); every caller of `__reap_post_run_end`
      already wraps it in `|| true`, so this never aborts the unit stop.
"""

from __future__ import annotations

import argparse
import json
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
) -> tuple:
    """Bounded-retry POST to `<api_base>/api/autopilot/run-end`.

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
    """
    attempts_total = retries + 1
    attempt = 0
    while True:
        attempt += 1
        req = urllib.request.Request(
            f"{api_base}/api/autopilot/run-end",
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
        return 0

    # "exhausted" (stop_on_4xx=False means "terminal" can never be returned
    # here) — the EXACT pre-#4305 backstop line; the dead-pid sweeper backstop
    # contract (sweep-reader.ts) is unchanged.
    print(
        f"[autopilot] reap: run-end POST failed (orchestrator down?) "
        f"run_id={args.run_id} cause={args.cause} — sweeper will backstop"
    )
    return 1


def main(argv: list) -> int:
    if not argv:
        print("usage: run_termination.py <count-slots|post-run-end> ...", file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "count-slots":
        return _cli_count_slots(rest)
    if cmd == "post-run-end":
        return _cli_post_run_end(rest)
    print(f"run_termination.py: unknown subcommand {cmd!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
