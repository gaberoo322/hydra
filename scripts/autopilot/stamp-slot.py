#!/usr/bin/env python3
"""
stamp-slot.py — record a dispatch on state.json from the plan action (issue #4831).

  python3 scripts/autopilot/stamp-slot.py <slot> <task_id> <model>

Run right after the `Agent(...)` call for a `dispatch` action. `<slot>` is the
action's `slot` (the class), `<task_id>` the bare agent hash the Agent tool
returned (reap.py keys the completion on it, #3391), `<model>` the alias the
dispatch was actually launched with (the per-class map, an `escalate_model`
hint, or `inherit` when `model` was omitted). Everything else is read from
the plan action for that slot — skill, worktreeBranch, isolation,
prompt_args.anchor, prompt_args.attempt — so the slot carries what reap.py
and decide.py read back:

  task_id, skill, started, started_epoch, branch / worktreeBranch /
  dispatch_id (the synthesised cycleId, #3391/#3785), model, turn, attempt,
  isolation, anchor (when pinned).

reap.py's `_recover_worktree_branch` and its `anchor` deposit fallback exist
because the hand-stamped slot "never carried branch or anchor" — this writer
does, so the primary path is the stamped field and the Redis recovery stays
the fallback it was designed to be.

A pipeline class (a key of state.slots) gets its slot dict replaced. A signal
class gets `signal_last_fired[<class>] = now`. Either way `dispatches` is
incremented and a `dispatch <class> <skill> <ts>` line is appended to the run
log through dispatch.sh (the log's single writer) — best-effort, never fatal.

Exit 0 on success; 1 when the plan has no dispatch action for that slot
(nothing is written: a stamp for a dispatch the brain did not plan is the
error, not something to paper over); 2 on bad arguments / unreadable files.

Paths: $HYDRA_AUTOPILOT_STATE (/tmp/hydra-autopilot-state.json),
$HYDRA_AUTOPILOT_PLAN (/tmp/hydra-autopilot-plan.json).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

STATE_PATH = os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json")
PLAN_PATH = os.environ.get("HYDRA_AUTOPILOT_PLAN", "/tmp/hydra-autopilot-plan.json")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    return data


def find_dispatch(plan: dict, slot: str) -> dict | None:
    """The plan's `dispatch` action for `slot`, or None."""
    for action in plan.get("actions") or []:
        if isinstance(action, dict) and action.get("type") == "dispatch" and action.get("slot") == slot:
            return action
    return None


def build_slot(action: dict, task_id: str, model: str, run_id: str, turn: int, now: int) -> dict:
    """The slot record for a pipeline dispatch — pure, for the fixture suite."""
    prompt_args = action.get("prompt_args") if isinstance(action.get("prompt_args"), dict) else {}
    cls = str(action.get("slot"))
    branch = action.get("worktreeBranch") or f"worktree-agent-{run_id[:8]}-t{turn}-{cls}"
    try:
        attempt = int(prompt_args.get("attempt") or 1)
    except (TypeError, ValueError):
        attempt = 1
    record: dict = {
        "skill": action.get("skill"),
        "task_id": task_id,
        "started": datetime.fromtimestamp(now, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "started_epoch": now,
        "branch": branch,
        "worktreeBranch": branch,
        "dispatch_id": branch,
        "model": model,
        "turn": turn,
        "attempt": attempt,
        "isolation": action.get("isolation") or "worktree",
    }
    anchor = prompt_args.get("anchor")
    if isinstance(anchor, str) and anchor:
        record["anchor"] = anchor
    return record


def stamp(state: dict, plan: dict, slot: str, task_id: str, model: str, now: int | None = None) -> dict:
    """Apply the stamp to `state` (mutating) and return the record written.
    Raises LookupError when the plan has no dispatch for `slot`."""
    action = find_dispatch(plan, slot)
    if action is None:
        raise LookupError(f"plan {PLAN_PATH} has no dispatch action for slot {slot!r}")
    now = int(time.time()) if now is None else now
    turn = int(state.get("turn") or 0)
    run_id = str(state.get("run_id") or "")
    slots = state.setdefault("slots", {})
    if slot in slots:
        record = build_slot(action, task_id, model, run_id, turn, now)
        slots[slot] = record
    else:
        state.setdefault("signal_last_fired", {})[slot] = now
        record = {"signal_last_fired": now, "skill": action.get("skill"), "task_id": task_id}
    state["dispatches"] = int(state.get("dispatches") or 0) + 1
    return record


def main(argv: list[str]) -> int:
    if len(argv) != 4 or argv[1] in ("-h", "--help"):
        print("usage: stamp-slot.py <slot> <task_id> <model>", file=sys.stderr)
        return 2
    slot, task_id, model = argv[1], argv[2], argv[3]
    try:
        state = _load(STATE_PATH)
        plan = _load(PLAN_PATH)
    except (OSError, ValueError) as exc:
        print(f"[stamp-slot] cannot read state/plan: {exc}", file=sys.stderr)
        return 2
    try:
        record = stamp(state, plan, slot, task_id, model)
    except LookupError as exc:
        print(f"[stamp-slot] {exc} — nothing written", file=sys.stderr)
        return 1

    tmp = f"{STATE_PATH}.stamp-slot.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=1)
        fh.write("\n")
    os.replace(tmp, STATE_PATH)

    skill = record.get("skill") or "?"
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        subprocess.run(
            ["bash", os.path.join(SCRIPT_DIR, "dispatch.sh"), "log", slot, str(skill), ts],
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"[stamp-slot] dispatch.sh log failed (state already stamped): {exc}", file=sys.stderr)
    print(json.dumps({"slot": slot, "task_id": task_id, "model": model, "dispatches": state["dispatches"], "record": record}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
