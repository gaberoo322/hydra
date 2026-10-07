#!/usr/bin/env python3
"""
Wire parity + accessor round-trip for the JSON Turn Snapshot (ADR-0043 slice
6, issue #4934). Driven by test/turn-snapshot-json.test.mts.

stdin: a JSON list of cases `{name, kv, snapshot}` — the kv lines AND the
JSON document the SAME typed collector values render to (`snapshot` is the
exact printed text, raw blobs spliced). For each case:

  1. state_kv   = merge-signals.py's merge(kv)            (the legacy path)
     state_json = turn_snapshot.py's apply(snapshot)      (the JSON path)
     → `signals`, every blob field, `scout_spend_usd_today`, `slot_events`
       and the cursor must be identical (compared as sorted JSON, so an
       int/float or key-presence drift fails too);
  2. decide.py over a real captured base state overlaid with each — the JSON
     one with `signals` and the blob fields REMOVED — must yield the same Plan;
  3. `readings`: every accessor reader over the JSON state, for the contract
     test to compare against the document's typed fields.

stdout: one JSON object `{cases: [{name, state_equal, diffs, plan_equal, readings}]}`.
"""

import copy
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
AUTOPILOT = os.path.join(REPO, "scripts", "autopilot")
sys.path.insert(0, AUTOPILOT)
for var in ("HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS", "HYDRA_AUTOPILOT_EMIT_TURN_EVENTS"):
    os.environ.pop(var, None)
os.environ["HYDRA_AUTOPILOT_RUN_END_POST"] = "off"

import decide  # noqa: E402
import turn_snapshot as ts  # noqa: E402

_spec = importlib.util.spec_from_file_location("merge_signals", os.path.join(AUTOPILOT, "merge-signals.py"))
merge_signals = importlib.util.module_from_spec(_spec)
sys.modules["merge_signals"] = merge_signals  # @dataclass resolves its module by name
_spec.loader.exec_module(merge_signals)

COMPARED = ("signals", *ts.BLOB_FIELDS, "scout_spend_usd_today", "slot_events", "slot_events_last_id")
BASE_DIR = os.path.join(REPO, "test", "fixtures", "decide-golden", "idle-triage-sweep")


def canon(v):
    return json.dumps(v, sort_keys=True)


def readings(state: dict) -> dict:
    out = {}
    for name in ts.snapshot(state)["signals"]:
        out[name] = {
            "present": ts.signal_present(state, [], name),
            "scalar": ts.scalar(state, name),
        }
    for name in ts._PIN_SIGNALS:
        out[name]["pin"] = ts.pin(state, [], name)
    for name in ts._ANCHOR_SIGNALS:
        out[name]["anchor"] = ts.anchor_ref(state, name)
    for name in ts._LIST_SIGNALS:
        out[name]["ordered"] = ts.ordered_numbers(state, [], name)
        out[name]["prs"] = ts.pr_numbers(state, [], name)
    out["orch_prs_dirty_surface"]["pairs"] = ts.dirty_surface_pairs(state, [], "orch_prs_dirty_surface")
    for name in ("target_needs_qa_pr_ref", "target_needs_qa_pr_head"):
        out[name]["text"] = ts.text(state, [], name)
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
    base.pop("signals", None)
    for f in (*ts.BLOB_FIELDS, "scout_spend_usd_today", "turn_snapshot"):
        base.pop(f, None)
    results = []
    for case in cases:
        state_kv = merge_signals.merge(case["kv"], {})
        snap = json.loads(case["snapshot"])
        state_json = ts.apply(snap, {})
        diffs = [k for k in COMPARED if canon(state_kv.get(k, "<absent>")) != canon(state_json.get(k, "<absent>"))]
        legacy_state = {**copy.deepcopy(base), **{k: v for k, v in state_kv.items() if k != "turn_snapshot"}}
        json_only = {**copy.deepcopy(base), **copy.deepcopy(state_json)}
        json_only.pop("signals", None)
        for f in (*ts.BLOB_FIELDS, "scout_spend_usd_today"):
            json_only.pop(f, None)
        plan_kv = decide.decide(legacy_state, copy.deepcopy(candidates), [], now=now).to_json()
        plan_json = decide.decide(json_only, copy.deepcopy(candidates), [], now=now).to_json()
        results.append(
            {
                "name": case["name"],
                "state_equal": not diffs,
                "diffs": {k: [state_kv.get(k, "<absent>"), state_json.get(k, "<absent>")] for k in diffs},
                "plan_equal": plan_kv == plan_json,
                "plan_actions": len(json.loads(plan_json)["actions"]),
                "readings": readings(state_json),
            }
        )
    print(json.dumps({"cases": results}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
