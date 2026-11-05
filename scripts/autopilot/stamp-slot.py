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
        record = {"signal_last_fired": now, "skill": effective_skill(action), "task_id": task_id}
    state["dispatches"] = int(state.get("dispatches") or 0) + 1
    return record


REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
_ISSUE_ANCHOR_RE = re.compile(r"^issue-(\d+)$")


def plan_claim(state: dict, plan: dict, slot: str) -> dict:
    """Decide the pre-spawn lifecycle claim for `slot` (issue #5315, INV-3/INV-4).

    Pure. Returns `{"claim": "skipped", "reason": ...}` when no claim applies, else
    `{"claim": "dispatch", "issue", "dispatch_id", "cls", "run", "purpose", "pr"}`.
    A skip is NOT an error: the parent still calls `Agent`."""
    action = find_dispatch(plan, slot)
    if action is None:
        return {"claim": "skipped", "reason": "no-dispatch-action"}
    if slot.endswith("_target"):
        return {"claim": "skipped", "reason": "target-scope"}
    if slot not in (state.get("slots") or {}):
        return {"claim": "skipped", "reason": "signal-class"}
    # Only dev_* classes are claimed here and released by reap (reap.claim_release_outcome
    # keys on the slot's `anchor`): any other pipeline class would leak a no-TTL claim
    # (INV-6). qa_* workers claim and release their own review (hydra-qa playbook, INV-5):
    # decide.py emits no prompt_args.issue and a pinned qa slot carries no `anchor`.
    if slot.startswith("qa_"):
        return {"claim": "skipped", "reason": "worker-claims"}
    if not slot.startswith("dev_"):
        return {"claim": "skipped", "reason": "no-release-role"}
    prompt_args = action.get("prompt_args") if isinstance(action.get("prompt_args"), dict) else {}
    anchor = prompt_args.get("anchor")
    m = _ISSUE_ANCHOR_RE.match(anchor) if isinstance(anchor, str) else None
    if m is None:
        return {"claim": "skipped", "reason": "unpinned"}
    run_id = str(state.get("run_id") or "")
    turn = int(state.get("turn") or 0)
    dispatch_id = action.get("worktreeBranch") or f"worktree-agent-{run_id[:8]}-t{turn}-{slot}"
    pr_raw = prompt_args.get("forward_fix_pr")
    pr_digits = re.sub(r"\D", "", str(pr_raw)) if pr_raw else ""
    pr = int(pr_digits) if pr_digits else None
    if pr:
        purpose = "forward-fix"
    elif prompt_args.get("resume") is True:
        purpose = "resume"
    else:
        purpose = "fresh"
    return {
        "claim": "dispatch",
        "issue": int(m.group(1)),
        "dispatch_id": dispatch_id,
        "cls": slot,
        "run": run_id,
        "purpose": purpose,
        "pr": pr,
    }


def claim_argv(spec: dict) -> list[str]:
    """The `npx tsx scripts/lifecycle.ts dispatch ...` argv for a `dispatch` spec."""
    argv = [
        "npx", "tsx", "scripts/lifecycle.ts", "dispatch", str(spec["issue"]),
        "--dispatch", spec["dispatch_id"], "--class", spec["cls"], "--run", spec["run"],
        "--purpose", spec["purpose"],
    ]
    if spec.get("pr"):
        argv += ["--pr", str(spec["pr"])]
    return argv


def run_claim(slot: str) -> int:
    """`stamp-slot.py claim <slot>`: run between render-dispatch.py and `Agent(...)`.

    Exit 0 prints one JSON line (the seam's result, or `{"claim":"skipped",...}`);
    exit 1 (claim-held, parked:<arm>, an enforce refusal, an unusable seam result)
    means the parent MUST NOT call `Agent` and MUST NOT run the post-spawn stamp —
    the slot stays empty and decide.py re-plans next turn. Exit 2: unreadable files."""
    try:
        state = run_ledger.read_prior(STATE_PATH)
        if not isinstance(state, dict):
            raise ValueError(f"{STATE_PATH} is not a JSON object")
        plan = _load_plan(PLAN_PATH)
    except (OSError, ValueError) as exc:
        print(f"[stamp-slot] cannot read state/plan: {exc}", file=sys.stderr)
        return 2
    spec = plan_claim(state, plan, slot)
    if spec["claim"] == "skipped":
        print(json.dumps(spec))
        return 0
    try:
        proc = subprocess.run(
            claim_argv(spec), cwd=REPO_ROOT, capture_output=True, text=True, check=False, timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(
            f"[stamp-slot] claim failed issue=#{spec['issue']} dispatch={spec['dispatch_id']}: {exc}",
            file=sys.stderr,
        )
        return 1
    out = (proc.stdout or "").strip()
    last = out.splitlines()[-1] if out else json.dumps({"ok": False, "code": "no-output"})
    print(last)
    try:
        parsed = json.loads(last)
    except ValueError:
        parsed = None
    # Fail closed (INV-3, INV-11): exit 0 is not enough, the seam must report ok:true.
    if proc.returncode == 0 and not (isinstance(parsed, dict) and parsed.get("ok") is True):
        print(
            f"[stamp-slot] claim result unusable issue=#{spec['issue']} dispatch={spec['dispatch_id']}: {last}",
            file=sys.stderr,
        )
        return 1
    if proc.returncode != 0:
        print(
            f"[stamp-slot] claim refused issue=#{spec['issue']} dispatch={spec['dispatch_id']} "
            f"rc={proc.returncode}: {last}",
            file=sys.stderr,
        )
        return 1
    return 0


def run_release_claim(slot: str) -> int:
    """`stamp-slot.py release-claim <slot>`: roll back the pre-spawn claim when `Agent`
    never spawned (hook deny, error), so no orphan claim blocks the next dispatch
    (INV-3 needs its matching close). Releases with outcome `released`. Exit 0 also
    when no claim applies; exit 1 when the seam refuses; exit 2: unreadable files."""
    try:
        state = run_ledger.read_prior(STATE_PATH)
        if not isinstance(state, dict):
            raise ValueError(f"{STATE_PATH} is not a JSON object")
        plan = _load_plan(PLAN_PATH)
    except (OSError, ValueError) as exc:
        print(f"[stamp-slot] cannot read state/plan: {exc}", file=sys.stderr)
        return 2
    spec = plan_claim(state, plan, slot)
    if spec["claim"] == "skipped":
        print(json.dumps(spec))
        return 0
    argv = [
        "npx", "tsx", "scripts/lifecycle.ts", "release", str(spec["issue"]),
        "--dispatch", spec["dispatch_id"], "--outcome", "released",
    ]
    try:
        proc = subprocess.run(argv, cwd=REPO_ROOT, capture_output=True, text=True, check=False, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"[stamp-slot] release-claim failed issue=#{spec['issue']}: {exc}", file=sys.stderr)
        return 1
    out = (proc.stdout or "").strip()
    print(out.splitlines()[-1] if out else json.dumps({"ok": False, "code": "no-output"}))
    return 0 if proc.returncode == 0 else 1


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "claim":
        return run_claim(argv[2])
    if len(argv) == 3 and argv[1] == "release-claim":
        return run_release_claim(argv[2])
    if len(argv) != 4 or argv[1] in ("-h", "--help"):
        print("usage: stamp-slot.py <slot> <task_id> <model>  |  stamp-slot.py claim <slot>", file=sys.stderr)
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
