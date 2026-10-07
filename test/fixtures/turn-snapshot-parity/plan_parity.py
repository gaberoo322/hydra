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
          int arrays, the dirty surface → [{pr, closing_issue}], flags →
          bools, the realm share → float | null, counts → ints). With
          `--dump <path>` each converted document is written as JSONL so the
          test can zod-check every converted value.

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
# The schema's scalar keys (src/schemas/turn-snapshot.ts) — converted to their typed shape too.
FLAGS = (
    "orch_work_available", "needs_qa_orch", "needs_research", "needs_triage_orch", "untriaged_orphans_orch",
    "target_work_available", "target_board_work_available", "target_board_research_due", "target_wip_saturated",
    "needs_qa_target", "needs_triage_target", "health_fail", "scout_walk_due", "scout_board_saturated",
    "orch_backfill_idle", "arch_board_saturated", "hitl_grill_saturated", "orch_board_signals_degraded",
    "cleanup_board_saturated", "skill_prune_board_saturated", "target_backfill_idle",
    "target_cleanup_board_saturated", "wire_or_retire_target_available", "design_qa_target_due",
    "design_qa_target_saturated", "retro_run_available", "retro_run_drillable", "orch_ci_trigger_stale",
    "tickets_available",
)
TEXTS = ("target_needs_qa_pr_ref", "target_needs_qa_pr_head")
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
                if raw is not None:  # None reads as absent; the schema has no null list
                    signals[key] = ts._int_tokens(raw)
            elif key == "orch_prs_dirty_surface":
                if raw is not None:
                    signals[key] = [
                    {"pr": pr, "closing_issue": issue}
                        for pr, issue in ts.dirty_surface_pairs({"signals": {key: raw}}, [], key)
                    ]
            elif key in FLAGS:
                signals[key] = bool(raw)  # signal_present() reads bool(value)
            elif key in TEXTS:
                if raw is not None:
                    signals[key] = str(raw)  # text() reads str(value).strip(); None stays absent
            elif key == "wayfinder_orch_ticket_type":
                # the selector keeps "research" | "task" and defaults anything else to research
                signals[key] = raw if isinstance(raw, str) else ""
            elif key == "wayfinder_orch_inflight_global":
                # the selector reads int(value), unparseable → 0, and only compares >= 2
                try:
                    n = int(raw)
                except (TypeError, ValueError):
                    n = 0
                signals[key] = max(n, 0)
            elif key == "scout_alert_eligible_count":
                # the selector reads int(value or 0) — a value that would raise there is not representable
                try:
                    n = int(raw or 0)
                except (TypeError, ValueError):
                    raise Unrepresentable(f"{key}={raw!r}")
                signals[key] = max(n, 0)  # only `> 0` is read
            elif key == "hitl_grill_open":
                try:
                    signals[key] = max(int(raw), 0)  # observability only; decide.py never reads it
                except (TypeError, ValueError):
                    signals[key] = 0
            elif key == "orch_realm_weekly_share":
                # `_realm_share_finite` is the one reading: "0.1234" → 0.1234, "unavailable"/bad → None
                signals[key] = decide._realm_share_finite(raw)
            else:
                signals[key] = raw  # a key outside the schema (a producerless test signal): verbatim
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
    args = sys.argv[1:]
    dump = None
    if "--dump" in args:
        i = args.index("--dump")
        dump = args[i + 1]
        del args[i : i + 2]
    path = args[0] if args else os.path.join(HERE, "decide-inputs.jsonl.gz")
    dumped = open(dump, "w", encoding="utf-8") if dump else None
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
        if dumped is not None and isinstance(json_state, dict):
            dumped.write(json.dumps(json_state["turn_snapshot"]) + "\n")
        legacy_plan = run(entry, copy.deepcopy(state))
        json_plan = run(entry, json_state)
        if legacy_plan == json_plan:
            identical += 1
        else:
            diverged.append({"index": i, "legacy": legacy_plan[:400], "json": json_plan[:400]})
    if dumped is not None:
        dumped.close()
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
