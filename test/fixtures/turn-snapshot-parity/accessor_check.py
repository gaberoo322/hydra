#!/usr/bin/env python3
"""
The Python half of the Turn Snapshot contract test (ADR-0043 Decision 5,
issue #4934; test/turn-snapshot-json.test.mts drives it).

stdin: `[{"name": str, "snapshot": str | null}]` — each `snapshot` is the raw
text turn.sh would hand `turn_snapshot.py apply` (null = the emit failed:
`apply --degraded`). For each case this applies it to a base autopilot state
(the decide-golden idle-triage-sweep fixture, its own snapshot and blob
fields removed) exactly as the CLI does — per-field repair for a usable
document, the all-degraded snapshot for an unusable one — then

  * reads every signal back through each accessor reader decide.py uses, and
  * runs decide.decide() over the result — which must return a Plan, never raise.

stdout: `{"cases": [{name, form, degraded, readings, plan_ok, actions, error}]}`.
"""

import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "scripts", "autopilot"))
for var in ("HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS", "HYDRA_AUTOPILOT_EMIT_TURN_EVENTS"):
    os.environ.pop(var, None)
os.environ["HYDRA_AUTOPILOT_RUN_END_POST"] = "off"

import decide  # noqa: E402
import turn_snapshot as ts  # noqa: E402

BASE_DIR = os.path.join(REPO, "test", "fixtures", "decide-golden", "idle-triage-sweep")


def readings(state: dict) -> dict:
    out = {}
    for name in ts.snapshot(state)["signals"]:
        out[name] = {"present": ts.signal_present(state, [], name), "scalar": ts.scalar(state, name)}
    for name in ts._PIN_SIGNALS:
        out.setdefault(name, {})["pin"] = ts.pin(state, [], name)
    for name in ts._ANCHOR_SIGNALS:
        out.setdefault(name, {})["anchor"] = ts.anchor_ref(state, name)
    for name in ts._LIST_SIGNALS:
        out.setdefault(name, {})["ordered"] = ts.ordered_numbers(state, [], name)
        out[name]["prs"] = ts.pr_numbers(state, [], name)
    out.setdefault("orch_prs_dirty_surface", {})["pairs"] = ts.dirty_surface_pairs(state, [], "orch_prs_dirty_surface")
    for name in ("target_needs_qa_pr_ref", "target_needs_qa_pr_head"):
        out.setdefault(name, {})["text"] = ts.text(state, [], name)
    out["_blobs"] = {f: ts.blob(state, f) for f in (*ts.BLOB_FIELDS, "scout_spend_usd_today")}
    out["_slot_events"] = {"events": state.get("slot_events"), "last_id": state.get("slot_events_last_id")}
    return out


def main() -> int:
    cases = json.load(sys.stdin)
    with open(os.path.join(BASE_DIR, "state.json"), encoding="utf-8") as fh:
        base = json.load(fh)
    with open(os.path.join(BASE_DIR, "candidates.json"), encoding="utf-8") as fh:
        candidates = json.load(fh)
    with open(os.path.join(BASE_DIR, "meta.json"), encoding="utf-8") as fh:
        now = json.load(fh)["now"]
    for f in (*ts.BLOB_FIELDS, "scout_spend_usd_today", "turn_snapshot", "slot_events", "slot_events_last_id"):
        base.pop(f, None)
    results = []
    for case in cases:
        text = case.get("snapshot")
        snap, reason = None, None
        if text is None:
            reason = "the Turn Snapshot emit failed"
        else:
            try:
                snap = json.loads(text)
            except ValueError as exc:
                reason = f"unreadable: {exc}"
            if reason is None and not ts._usable(snap):
                reason = ts._why_unusable(snap)
        state = ts.apply(snap if reason is None else None, copy.deepcopy(base), reason)
        result = {
            "name": case["name"],
            "form": "json" if reason is None else "all-degraded",
            "degraded": state["turn_snapshot"]["degraded"],
            "readings": readings(state),
        }
        try:
            plan = json.loads(decide.decide(state, copy.deepcopy(candidates), [], now=now).to_json())
            result["plan_ok"] = True
            result["actions"] = [
                {"type": a.get("type"), "slot": a.get("slot"), "skill": a.get("skill"), "reason": a.get("reason")} for a in plan.get("actions", [])
            ]
        except Exception as exc:  # noqa: BLE001 — the contract is "never raises"; report it
            result["plan_ok"] = False
            result["error"] = f"{type(exc).__name__}: {exc}"
        results.append(result)
    print(json.dumps({"cases": results}, default=list))
    return 0


if __name__ == "__main__":
    sys.exit(main())
