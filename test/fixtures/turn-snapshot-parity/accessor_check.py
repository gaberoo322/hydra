#!/usr/bin/env python3
"""
The Python half of the Turn Snapshot contract test (ADR-0043 Decision 5,
issue #4934; store-only accessor since #5083; test/turn-snapshot-json.test.mts
drives it).

stdin: `[{"name": str, "snapshot": str | null, "names"?: [str]}]` — each
`snapshot` is the raw text turn.sh would hand `turn_snapshot.py apply` (null =
no document: `apply --degraded`, the marker). For each case this applies it to
a base autopilot state (the decide-golden idle-triage-sweep fixture, its own
snapshot and blob fields removed) exactly as the CLI does — the document as
emitted, or the marker document when it cannot be read as a JSON object — then

  * reads each signal back through EVERY accessor reader decide.py uses (the
    caller picks the reader that fits the signal's schema type; `names`
    defaults to the stored document's own signal keys), and
  * runs decide.decide() over the result — which must return a Plan, never raise.

stdout: `{"cases": [{name, form, stored_identical, degraded, readings, plan_ok, actions, error}]}`.
Run with HYDRA_AUTOPILOT_SNAPSHOT_REPLAY set, a read of a signal the document
lacks is reported as `{"raised": ...}` and decide() fails (plan_ok false).
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


def readings(state: dict, names: list[str]) -> dict:
    out = {}
    for name in names:
        try:
            out[name] = {
                "present": ts.signal_present(state, [], name),
                "scalar": ts.scalar(state, name),
                "pin": ts.pin(state, [], name),
                "anchor": ts.anchor_ref(state, name),
                "ordered": ts.ordered_numbers(state, [], name),
                "prs": ts.pr_numbers(state, [], name),
                "pairs": ts.dirty_surface_pairs(state, [], name),
                "recheck": ts.qa_verdict_recheck(state, [], name),
                "text": ts.text(state, [], name),
            }
        except ts.UnknownSignalError as exc:
            # replay mode: the read failed loud — report it, the caller asserts on it
            out[name] = {"raised": f"UnknownSignalError: {exc}"}
    out["_blobs"] = {f: ts.blob(state, f) for f in (*ts.BLOB_FIELDS, "scout_spend_usd_today")}
    out["_slot_events"] = {"events": state.get("slot_events"), "last_id": state.get("slot_events_last_id")}
    return out


def _canon(value) -> str:
    return json.dumps(value, sort_keys=True)


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
            except (ValueError, RecursionError) as exc:
                reason = f"unreadable: {exc}"
            if reason is None and not isinstance(snap, dict):
                reason = f"not a JSON object ({type(snap).__name__})"
        state = ts.apply(copy.deepcopy(snap) if reason is None else None, copy.deepcopy(base), reason)
        stored = state["turn_snapshot"]
        signals = stored.get("signals")
        names = case.get("names") or (list(signals) if isinstance(signals, dict) else [])
        result = {
            "name": case["name"],
            "form": "json" if reason is None else "marker",
            "stored_identical": reason is None and _canon(stored) == _canon(snap),
            "degraded": stored.get("degraded"),
            "readings": readings(state, names),
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
