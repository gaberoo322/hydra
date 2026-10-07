#!/usr/bin/env python3
"""
Plan parity over every decide() input the test suite produces (ADR-0043
slice 6, issue #4934 — the expand PR's critical gate).

For each captured `(state, candidates, events, now)` in decide-inputs.jsonl.gz:

  legacy  decide() over the state as captured (`state.signals` + the
          top-level blob fields — the kv / merge-signals.py form);
  json    decide() over the SAME state converted to the JSON Turn Snapshot
          form: `state.signals` and every blob field are REMOVED and a v1
          `state.turn_snapshot` carries them instead, with the packed wire
          strings turned into the structured shapes src/schemas/turn-snapshot.ts
          defines (pins → {issue, pr, branch}, anchors → ints, number lists →
          int arrays, the dirty surface → [{pr, closing_issue}]).

and asserts the two serialised Plans are byte-identical. Because the JSON
state has no `signals` key and no blob fields, a decide.py read that bypassed
scripts/autopilot/turn_snapshot.py would see nothing and the Plans would
diverge — so the run also proves the accessor is the only read path.

Values the typed form cannot represent (a fixture-authored anchor that is not
`issue-N`) would make the conversion lossy; they are counted and reported as
`unrepresentable`, never silently passed.

Prints one JSON summary line; exit 0 iff every entry is identical.
"""

import copy
import gzip
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "scripts", "autopilot"))

for var in ("HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS", "HYDRA_AUTOPILOT_EMIT_TURN_EVENTS"):
    os.environ.pop(var, None)
os.environ["HYDRA_AUTOPILOT_RUN_END_POST"] = "off"

import decide  # noqa: E402
import turn_snapshot as ts  # noqa: E402

PINS = ("orch_glm_red_forward_fix", "orch_dev_resume_pick", "orch_dirty_forward_fix", "target_dev_resume_pick")
ANCHORS = ("orch_pending_grill_anchor", "orch_dev_ready_anchor", "wayfinder_orch_frontier", "tickets_orch_pending_spec")
LISTS = (
    "needs_qa_numbers",
    "orch_needs_triage_items",
    "target_needs_triage_items",
    "orch_prs_dirty",
    "orch_prs_unchecked",
    "orch_prs_behind",
    "orch_prs_glm_red",
)
ISSUE_REF = re.compile(r"^issue-([1-9][0-9]*)$")


class Unrepresentable(Exception):
    pass


def _anchor_to_json(key: str, raw):
    """The legacy anchor value as the JSON int — only when every legacy reader
    of `key` would have returned exactly `issue-N` (or nothing)."""
    if raw is None:
        return None
    if isinstance(raw, str):
        stripped = raw.strip()
        if key in ("orch_pending_grill_anchor", "orch_dev_ready_anchor"):
            # _orch_anchor_signal strips and collapses "" / "none".
            if stripped in ("", "none"):
                return None
            m = ISSUE_REF.match(stripped)
        elif key == "wayfinder_orch_frontier":
            # read verbatim: a non-empty, non-"none" str is the ticket ref.
            if raw in ("", "none"):
                return None
            m = ISSUE_REF.match(raw)
        else:
            # tickets_orch_pending_spec: any truthy value is the spec ref.
            if raw == "":
                return None
            m = ISSUE_REF.match(raw)
        if m:
            return int(m.group(1))
        raise Unrepresentable(f"{key}={raw!r}")
    if key in ("orch_pending_grill_anchor", "orch_dev_ready_anchor"):
        return None  # a non-str never reads as an anchor there
    if not raw:
        return None
    raise Unrepresentable(f"{key}={raw!r}")


def to_json_form(state: dict) -> dict:
    s = copy.deepcopy(state)
    legacy = s.pop("signals", None)
    signals: dict = {}
    if isinstance(legacy, dict):
        for key, raw in legacy.items():
            if key in PINS:
                p = ts._parse_pin(raw)
                signals[key] = None if p is None else {"issue": p[0], "pr": p[1], "branch": p[2]}
            elif key in ANCHORS:
                signals[key] = _anchor_to_json(key, raw)
            elif key in LISTS:
                signals[key] = None if raw is None else ts._int_tokens(raw)
            elif key == "orch_prs_dirty_surface":
                signals[key] = None if raw is None else [
                    {"pr": pr, "closing_issue": issue}
                    for pr, issue in ts.dirty_surface_pairs({"signals": {key: raw}}, [], key)
                ]
            else:
                signals[key] = raw  # flags, counts, scalars, text: the reader's own coercion applies
    elif legacy is not None:
        raise Unrepresentable(f"signals is a {type(legacy).__name__}")
    blobs = {}
    for field in ts.BLOB_FIELDS:
        if field in s:
            blobs[field] = s.pop(field)
    snap = {
        "schema_version": ts.SCHEMA_VERSION,
        "generated_at": "plan-parity",
        "signals": signals,
        "blobs": blobs,
        "degraded": [],
        "validation": {"ok": True},
    }
    if "scout_spend_usd_today" in s:
        snap["scout_spend_usd_today"] = s.pop("scout_spend_usd_today")
    s["turn_snapshot"] = snap
    assert "signals" not in s and not any(f in s for f in ts.BLOB_FIELDS)
    return s


def run(entry: dict, state: dict) -> str:
    try:
        plan = decide.decide(state, copy.deepcopy(entry["candidates"]), copy.deepcopy(entry["events"]), now=entry["now"])
        return plan.to_json()
    except Exception as exc:  # a crash must crash identically in both forms
        return f"RAISED {type(exc).__name__}: {exc}"


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "decide-inputs.jsonl.gz")
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        entries = [json.loads(line) for line in fh if line.strip()]
    identical = 0
    with_signals = 0
    unrepresentable: list[str] = []
    diverged: list[dict] = []
    for i, entry in enumerate(entries):
        state = entry["state"]
        if isinstance(state, dict) and isinstance(state.get("signals"), dict) and state["signals"]:
            with_signals += 1
        try:
            json_state = to_json_form(state) if isinstance(state, dict) else state
        except Unrepresentable as exc:
            unrepresentable.append(f"#{i}: {exc}")
            continue
        legacy_plan = run(entry, copy.deepcopy(state))
        json_plan = run(entry, json_state)
        if legacy_plan == json_plan:
            identical += 1
        else:
            diverged.append({"index": i, "legacy": legacy_plan[:400], "json": json_plan[:400]})
    print(
        json.dumps(
            {
                "entries": len(entries),
                "with_signals": with_signals,
                "identical": identical,
                "unrepresentable": unrepresentable,
                "diverged": diverged[:5],
                "diverged_count": len(diverged),
            }
        )
    )
    return 0 if identical == len(entries) else 1


if __name__ == "__main__":
    sys.exit(main())
