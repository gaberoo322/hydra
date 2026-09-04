"""reap_state.py — state.json / Redis plumbing for scripts/autopilot/reap.py
(issue #4366, the bounded first slice of the reap.py six-way split surfaced
by an architecture-scan).

Owns:
  - state.json load/save — the SHARED, unlocked /tmp file every autopilot
    process reads/writes unless HYDRA_AUTOPILOT_STATE overrides it (see
    reap.py's module docstring, issue #3895)
  - the `reaped_task_ids` dedup ledger, FIFO-bounded to REAPED_TASK_IDS_CAP
  - the docker-exec redis-cli seam (issue #2715 / #3785) and the cross-run
    cooldown mirror built on it

Imported by reap.py via a guarded `sys.path` insert + name-binding import
(see reap.py's header comment) — never via attribute access, so a
`reap.load_state = spy`-style monkeypatch in
test/autopilot-dedup-reap.test.mts keeps working. This module is a library,
not a CLI: no shebang, no `__main__` block, no exec bit — matching the
pr-refs.py / run_termination.py precedent for a shared leaf.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))

REAPED_TASK_IDS_CAP = 1000

# Issue #2715 — Redis mirror of the cross-run cooldown subset.
#
# /tmp/hydra-autopilot-state.json is boot-wiped, so `signal_last_fired` /
# `research_force_counter` are lost on host reboot and the long-cooldown classes
# reset to epoch 0 (a per-reboot recurrence of the #2575 churn). Redis survives
# reboot (AOF + docker volume), so reap mirrors the cross-run subset to Redis on
# EVERY completion — the reliable executor-side "a class fired" seam (reap runs on
# every terminal dispatch, including signal-class completions). bootstrap.sh reads
# these keys back as a seed tier behind the prior file (prior-file → Redis → 0).
#
# The bash→Redis seam is `docker exec hydra-redis-1 redis-cli` — the exact pattern
# collect-state.sh uses — not a typed accessor / HTTP route (design-concept #2715).
# `HYDRA_AUTOPILOT_REDIS_CLI` overrides the argv prefix so tests inject a stub and
# exercise the mirror hermetically. Every write is best-effort / fail-open: any
# error logs to stderr and NEVER aborts the reap (design-concept #2715 Invariant 5).
REDIS_SIGNAL_LAST_FIRED_KEY = "hydra:autopilot:signal-last-fired"
REDIS_RESEARCH_FORCE_KEY = "hydra:autopilot:research-force-counter"


def load_state() -> dict | None:
    if not STATE_PATH.exists():
        print(f"[autopilot] reap: state file missing at {STATE_PATH}; skipping", file=sys.stderr)
        return None
    return json.loads(STATE_PATH.read_text())


def save_state(s: dict) -> None:
    STATE_PATH.write_text(json.dumps(s))


def redis_cli(*args: str, capture: bool = False) -> str | None:
    """Run one redis-cli command best-effort (issue #2715). Never raises.

    Mirrors the docker-exec redis-cli seam collect-state.sh uses. The argv prefix
    is `docker exec hydra-redis-1 redis-cli` unless HYDRA_AUTOPILOT_REDIS_CLI
    overrides it (whitespace-split — a trusted test/override prefix, e.g.
    `redis-cli -h 127.0.0.1 -p 6390`, or a stub recorder). Any failure (redis
    down, docker absent, timeout) is logged to stderr and swallowed: the state
    file is already the source of truth, so a missed mirror only costs one extra
    post-reboot fire, never a crash.

    `capture` (issue #3785): the fire-and-forget WRITE call sites (the #2715
    HSET/SET mirrors below) all use the default `capture=False` — unchanged
    DEVNULL stdout, `None` return, byte-identical behavior. Passing
    `capture=True` (the ONE read call site, `_recover_worktree_branch` in
    reap.py) instead pipes stdout and returns it decoded + stripped —
    redis-cli in a non-tty/piped invocation (this is a `subprocess.run`, never
    a tty) prints a successful reply's raw value with no surrounding quotes,
    and prints nothing (an empty stdout) for a nil/missing key or field. A
    failure — non-2xx exit, timeout, docker/redis absent — returns `None`
    under `capture=True` too, exactly like the fire-and-forget write path:
    never raises, never distinguishes "empty" from "erred" for the caller
    (both mean "no value").
    """
    override = os.environ.get("HYDRA_AUTOPILOT_REDIS_CLI", "").strip()
    if override:
        cmd = [*override.split(), *args]
    else:
        cmd = ["docker", "exec", "hydra-redis-1", "redis-cli", *args]
    try:
        result = subprocess.run(
            cmd,
            check=False,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        print(
            f"[autopilot] reap: redis mirror {args[:2]} failed ({exc}); "
            "state.json remains source of truth",
            file=sys.stderr,
        )
        return None
    if not capture:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.decode("utf-8", errors="replace").strip()


def mirror_cross_run_state_to_redis(s: dict) -> None:
    """Mirror the cross-run durable subset of state to Redis (issue #2715).

    ONLY the reboot-survival subset is mirrored — `signal_last_fired` (the 10
    signal classes) and `research_force_counter`. Run-scoped fields
    (pid/turn/dispatches/slots/idle_turns/burned_classes) are NEVER mirrored:
    they legitimately die with the run and the concurrent-run PID guard + #1352
    slot re-seeding DEPEND on them resetting (design-concept #2715 Invariant 4).

    Called after `save_state` in `run_completion`, so a Redis hiccup can never
    lose the local write. Best-effort throughout — no exception escapes.
    """
    try:
        slf = s.get("signal_last_fired")
        if isinstance(slf, dict) and slf:
            # HSET the hash field-by-field; each value is an epoch int (or 0).
            # Skip non-int-coercible values rather than corrupting the field.
            hset_args: list[str] = ["HSET", REDIS_SIGNAL_LAST_FIRED_KEY]
            for cls, ts in slf.items():
                try:
                    hset_args.extend([str(cls), str(int(ts))])
                except (TypeError, ValueError):
                    continue
            # Only issue the HSET when at least one field pair was collected.
            if len(hset_args) > 2:
                redis_cli(*hset_args)

        rfc = s.get("research_force_counter")
        if isinstance(rfc, dict):
            # Store as one canonical-JSON string (a date-keyed nested object) so
            # bootstrap can prune it to today's key on read, mirroring the
            # prior-file path. An empty {} is still written — it faithfully
            # records "no forced-research today" and never resurrects a stale day.
            redis_cli(
                "SET",
                REDIS_RESEARCH_FORCE_KEY,
                json.dumps(rfc, sort_keys=True),
            )
    except Exception as exc:  # pragma: no cover - defensive belt-and-braces
        # The subset mirror is a pure best-effort side-effect; never let it
        # bubble up and abort a reap that already persisted state locally.
        print(
            f"[autopilot] reap: cross-run redis mirror failed ({exc}); "
            "state.json remains source of truth",
            file=sys.stderr,
        )


def ensure_reaped_list(s: dict) -> list[str]:
    """Read `reaped_task_ids` from state, defaulting to []. Tolerates older
    state.json files written before issue #411 that lack the field."""
    ids = s.get("reaped_task_ids")
    if not isinstance(ids, list):
        ids = []
        s["reaped_task_ids"] = ids
    return ids


def bound_reaped(ids: list[str]) -> list[str]:
    """FIFO-bound the dedup ledger to the most-recent 1000 entries."""
    if len(ids) > REAPED_TASK_IDS_CAP:
        return ids[-REAPED_TASK_IDS_CAP:]
    return ids
