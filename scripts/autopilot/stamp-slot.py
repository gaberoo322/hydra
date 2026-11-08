#!/usr/bin/env python3
"""
stamp-slot.py — record a dispatch on state.json from the plan action (issue #4831).

  python3 scripts/autopilot/stamp-slot.py <slot> <task_id> <model>
  python3 scripts/autopilot/stamp-slot.py claim <slot>

`claim <slot>` (ADR-0047 D4, issue #5418) runs BEFORE the `Agent(...)` call: it
opens the dispatcher's lifecycle claim via `scripts/lifecycle.ts dispatch` for a
pinned dev-role dispatch. It writes nothing to state.json and logs nothing.
Exit 0 = claimed (or `{"skipped": reason}`: signal class, `_target` scope,
non-dev role, no pinned anchor); exit 1 = refused (`claim-held`, `parked:*`,
`advance-refused`, `redis-failed`, timeout) — the parent spawns no Agent and
stamps nothing; exit 2 = usage / unreadable state or plan.

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

import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_ledger  # noqa: E402  (the ONE state-document parser/writer, #5075)
from decide_base import dispatch_anchor, dispatch_attempt, dispatch_intent, dispatch_pr  # noqa: E402  (#5381 accessors)

STATE_PATH = run_ledger.resolve_state_path()
PLAN_PATH = os.environ.get("HYDRA_AUTOPILOT_PLAN", "/tmp/hydra-autopilot-plan.json")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_effective_skill():
    """render-dispatch.py's `effective_skill` (issue #4833) — the ONE place the
    wayfinder_orch ticket-type → skill override lives, so the stamped slot
    records the skill that actually ran. Hyphenated filename → importlib."""
    path = os.path.join(SCRIPT_DIR, "render-dispatch.py")
    spec = importlib.util.spec_from_file_location("render_dispatch", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.effective_skill


effective_skill = _load_effective_skill()


def _load_plan(path: str) -> dict:
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


def slot_branch(action: dict, run_id: str, turn: int, cls: str) -> str:
    """The dispatch id / worktree branch for a dispatch — the ONE derivation shared
    by `build_slot` (the stamp) and `build_claim_argv` (the claim), so the claim
    key and the stamped slot's `dispatch_id` cannot drift (#5418)."""
    return action.get("worktreeBranch") or f"worktree-agent-{run_id[:8]}-t{turn}-{cls}"


def build_slot(action: dict, task_id: str, model: str, run_id: str, turn: int, now: int) -> dict:
    """The slot record for a pipeline dispatch — pure, for the fixture suite."""
    cls = str(action.get("slot"))
    branch = slot_branch(action, run_id, turn, cls)
    attempt = dispatch_attempt(action)
    record: dict = {
        "skill": effective_skill(action),
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
    anchor = dispatch_anchor(action)
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
        record = {"signal_last_fired": now, "skill": effective_skill(action), "task_id": task_id}
    state["dispatches"] = int(state.get("dispatches") or 0) + 1
    return record


CLAIM_TIMEOUT_S = 60
_ISSUE_ANCHOR_RE = re.compile(r"^issue-(\d+)$")
_CLAIM_PURPOSES = {
    "Fresh": "fresh",
    "ResumeBranch": "resume",
    "ResumeSalvage": "resume",
    "ForwardFixRed": "forward-fix",
    "ForwardFixConflict": "forward-fix",
    "ForwardFixConflictWithFail": "forward-fix",
}


def _is_dev_role(slot: str) -> bool:
    """Mirror of src/lifecycle/caps.ts classRole(): `dev_*` / `glm*` -> dev.
    Drift-guarded over every classes.json slot by test/lifecycle-dispatch-adoption.test.mts."""
    return slot.startswith("dev_") or slot.startswith("glm")


def claim_skip_reason(state: dict, action: dict, slot: str) -> str | None:
    """Why `claim` must skip this slot (INV-3), or None when it should claim. Pure."""
    if slot not in (state.get("slots") or {}):
        return "signal-class"
    if slot.endswith("_target"):
        return "target-scope"
    if not _is_dev_role(slot):
        return "non-dev-role"
    anchor = dispatch_anchor(action)
    if not isinstance(anchor, str) or not _ISSUE_ANCHOR_RE.match(anchor):
        return "no-pinned-anchor"
    return None


def build_claim_argv(state: dict, action: dict, slot: str) -> list[str]:
    """argv of the `lifecycle dispatch` call for a pinned dispatch — pure."""
    anchor = dispatch_anchor(action)
    m = _ISSUE_ANCHOR_RE.match(str(anchor))
    if m is None:
        raise ValueError(f"anchor {anchor!r} is not issue-<N>")
    intent = dispatch_intent(action)
    purpose = _CLAIM_PURPOSES.get(getattr(intent, "kind", ""), "fresh")
    run_id = str(state.get("run_id") or "")
    turn = int(state.get("turn") or 0)
    branch = slot_branch(action, run_id, turn, slot)
    argv = [
        "npx", "tsx", "scripts/lifecycle.ts", "dispatch", m.group(1),
        "--dispatch", str(branch), "--class", slot, "--run", run_id,
        "--actor", "autopilot",
    ]
    pr = dispatch_pr(action)
    if pr is not None:
        argv += ["--pr", str(pr)]
    argv += ["--purpose", purpose]
    return argv


def claim(state: dict, plan: dict, slot: str) -> int:
    """Open the dispatcher claim for `slot`; returns the process exit code."""
    action = find_dispatch(plan, slot)
    if action is None:
        print(f"[stamp-slot] plan {PLAN_PATH} has no dispatch action for slot {slot!r} — nothing claimed", file=sys.stderr)
        return 1
    reason = claim_skip_reason(state, action, slot)
    if reason is not None:
        print(json.dumps({"skipped": reason}))
        return 0
    argv = build_claim_argv(state, action, slot)
    repo_root = os.path.dirname(os.path.dirname(SCRIPT_DIR))
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=CLAIM_TIMEOUT_S, check=False, cwd=repo_root)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"[stamp-slot] claim could not run (fail-closed): {exc}", file=sys.stderr)
        print(json.dumps({"ok": False, "code": "claim-error"}))
        return 1
    out = (proc.stdout or "").strip()
    if proc.returncode == 0:
        print(out or json.dumps({"ok": True}))
        return 0
    code = "claim-failed"
    try:
        parsed = json.loads(out.splitlines()[-1]) if out else {}
        if isinstance(parsed, dict) and isinstance(parsed.get("code"), str):
            code = parsed["code"]
    except (ValueError, IndexError):
        print(f"[stamp-slot] claim stdout unparsable: {out[:200]!r}", file=sys.stderr)
    print(json.dumps({"ok": False, "code": code}))
    return 1


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "claim":
        try:
            try:
                state = run_ledger.load(STATE_PATH, fill_defaults=False)
            except run_ledger.LedgerTypeError:
                state = run_ledger.read_prior(STATE_PATH)
                if not isinstance(state, dict):
                    raise
            plan = _load_plan(PLAN_PATH)
        except (OSError, ValueError, run_ledger.LedgerTypeError) as exc:
            print(f"[stamp-slot] cannot read state/plan: {exc}", file=sys.stderr)
            return 2
        return claim(state, plan, argv[2])
    if len(argv) != 4 or argv[1] in ("-h", "--help"):
        print("usage: stamp-slot.py <slot> <task_id> <model> | claim <slot>", file=sys.stderr)
        return 2
    slot, task_id, model = argv[1], argv[2], argv[3]
    try:
        try:
            state = run_ledger.load(STATE_PATH, fill_defaults=False)
        except run_ledger.LedgerTypeError as exc:
            # A wrong-typed declared field must not stop a dispatch stamp: read leniently.
            state = run_ledger.read_prior(STATE_PATH)
            if not isinstance(state, dict):
                raise
            print(f"[stamp-slot] state failed type validation ({exc}); stamping leniently", file=sys.stderr)
        plan = _load_plan(PLAN_PATH)
    except (OSError, ValueError, run_ledger.LedgerTypeError) as exc:
        print(f"[stamp-slot] cannot read state/plan: {exc}", file=sys.stderr)
        return 2
    try:
        record = stamp(state, plan, slot, task_id, model)
    except LookupError as exc:
        print(f"[stamp-slot] {exc} — nothing written", file=sys.stderr)
        return 1

    try:
        try:
            run_ledger.persist(state, STATE_PATH)
        except run_ledger.LedgerTypeError as exc:
            print(f"[stamp-slot] state failed type validation on write ({exc}); persisting unvalidated", file=sys.stderr)
            run_ledger.persist(state, STATE_PATH, validate=False)
    except OSError as exc:
        print(f"[stamp-slot] cannot write state: {exc}", file=sys.stderr)
        return 2

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
