#!/usr/bin/env python3
"""
Plan parity over every decide() input the test suite produces (ADR-0043
slice 6, issue #4934).

For each captured `(state, candidates, events, now)` in decide-inputs.jsonl.gz
the state — captured in the retired legacy form (`state.signals` + the
top-level blob fields) — is converted to the JSON Turn Snapshot form:
`state.signals` and every blob field are REMOVED and a v1
`state.turn_snapshot` carries them instead, with the packed wire strings
turned into the structured shapes src/schemas/turn-snapshot.ts defines (pins
→ {issue, pr, branch}, anchors → ints, number lists → int arrays, the dirty
surface → [{pr, closing_issue}], flags → bools, the realm share → float |
null, counts → ints). decide() plans over it, and the serialised Plan must be
byte-identical to the GOLDEN Plan recorded for that entry in
decide-plans.jsonl.gz.

The golden Plans were recorded from the 6a expand PR's JSON path (master at
ae84e68e6, where the legacy and JSON forms were proven identical over this
corpus) — so a 6b-or-later decide.py / accessor that plans differently on the
same facts fails here. Because the JSON state has no `signals` key and no
blob fields, a decide.py read that bypassed scripts/autopilot/turn_snapshot.py
would see nothing and the Plans would diverge.

Re-recorded once for an intentional decide.py change (issue #5058): the
GLM-only #4460 signals were folded into the provenance-agnostic resume pick
(see `_fold_retired_glm_signals`), which changed only the red-forward-fix
dispatch reason / surface-pr cause strings in the affected Plans.

  python3 plan_parity.py [--dump <path>] [corpus.jsonl.gz]
      compare against the golden Plans; `--dump` writes each converted
      snapshot as JSONL so the test can zod-check every converted value
  python3 plan_parity.py --write-golden [--autopilot-dir <dir>]
      record the golden Plans, planning with the decide.py / turn_snapshot.py
      in <dir> (default: this checkout's scripts/autopilot) — e.g. a
      worktree of the reference commit
  python3 plan_parity.py --all-degraded <doc.json> [...]
      also plan every entry twice more — over the TS all-degraded document in
      <doc.json> (what `turn-snapshot.ts --all-degraded` prints) and over the
      accessor's MARKER document (no signals: node could not run, #5083) — and
      count the entries whose two Plans are byte-identical (`marker_identical`)

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
GOLDEN_PLANS = os.path.join(HERE, "decide-plans.jsonl.gz")

_argv = sys.argv[1:]
AUTOPILOT_DIR = os.path.join(REPO, "scripts", "autopilot")
if "--autopilot-dir" in _argv:
    _i = _argv.index("--autopilot-dir")
    AUTOPILOT_DIR = os.path.abspath(_argv[_i + 1])
    del _argv[_i : _i + 2]
sys.path.insert(0, AUTOPILOT_DIR)

for var in ("HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS", "HYDRA_AUTOPILOT_EMIT_TURN_EVENTS"):
    os.environ.pop(var, None)
os.environ["HYDRA_AUTOPILOT_RUN_END_POST"] = "off"

import decide  # noqa: E402
import turn_snapshot as ts  # noqa: E402

PINS = ("orch_dev_resume_pick", "orch_dirty_forward_fix", "target_dev_resume_pick")
ANCHORS = ("orch_pending_grill_anchor", "orch_dev_ready_anchor", "wayfinder_orch_frontier", "tickets_orch_pending_spec")
LISTS = (
    "needs_qa_numbers",
    "orch_needs_triage_items",
    "target_needs_triage_items",
    "target_stale_in_progress_items",
    "target_blocked_items",
    "orch_prs_dirty",
    "orch_prs_unchecked",
    "orch_prs_behind",
    "orch_prs_red_resume",
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


# Issue #5058 retired the GLM-only #4460 signals into the provenance-agnostic
# resume pick. A corpus entry captured with the legacy GLM pick still carries
# the SAME facts — that PR is now named by `orch_dev_resume_pick` and listed in
# the red-CI cap scope `orch_prs_red_resume`, and its in-run tracker is
# `red_forward_fix_attempts` — so fold them forward instead of dropping the
# red-forward-fix path from the corpus. The legacy selector ran the non-GLM
# resume pick FIRST, so an entry that also carries one keeps it.
_RETIRED_GLM_PICK = "orch_glm_red_forward_fix"
_RETIRED_GLM_BUCKET = "orch_prs_glm_red"
_RETIRED_GLM_TRACKER = "glm_red_forward_fix_attempts"


def _fold_retired_glm_signals(legacy: dict) -> dict:
    if _RETIRED_GLM_PICK not in legacy and _RETIRED_GLM_BUCKET not in legacy:
        return legacy
    out = dict(legacy)
    glm_pick = ts._parse_pin(out.pop(_RETIRED_GLM_PICK, None))
    out.pop(_RETIRED_GLM_BUCKET, None)
    if glm_pick is not None and ts._parse_pin(out.get("orch_dev_resume_pick")) is None:
        out["orch_dev_resume_pick"] = f"issue-{glm_pick[0]}:{glm_pick[1]}:{glm_pick[2]}"
        out["orch_prs_red_resume"] = str(glm_pick[1])
    return out


def _fold_retired_glm_events(events):
    """The same fold for a signal EVENT carrying the retired GLM pick (events
    take precedence over state, so the fold must reach them too)."""
    if not isinstance(events, list):
        return events
    out = []
    for ev in events:
        if isinstance(ev, dict) and ev.get("type") == "signal" and ev.get("name") == _RETIRED_GLM_PICK:
            pin = ts._parse_pin(ev.get("value"))
            out.append({**ev, "name": "orch_dev_resume_pick"})
            out.append({**ev, "name": "orch_prs_red_resume", "value": str(pin[1]) if pin else ""})
        elif isinstance(ev, dict) and ev.get("type") == "signal" and ev.get("name") == _RETIRED_GLM_BUCKET:
            continue
        else:
            out.append(ev)
    return out


def _emittable_blob(field: str, value) -> bool:
    """Whether the TS emitter could carry this legacy blob value
    (src/schemas/turn-snapshot.ts BlobsSchema: the two mapping blobs are
    objects, candidate_exclusions a list of objects; the rest are presence +
    JSON). Lifted from the retired accessor-side repair (#5083) so the
    conversion stays the one the golden Plans were recorded over."""
    if field == "candidate_exclusions":
        return isinstance(value, list) and all(isinstance(r, dict) for r in value)
    if field in ("usage_eligibility", "emergency_brake"):
        return isinstance(value, dict)
    return True


def to_json_form(state: dict) -> dict:
    s = copy.deepcopy(state)
    if _RETIRED_GLM_TRACKER in s:
        s["red_forward_fix_attempts"] = s.pop(_RETIRED_GLM_TRACKER)
    legacy = s.pop("signals", None)
    signals: dict = {}
    if isinstance(legacy, dict):
        legacy = _fold_retired_glm_signals(legacy)
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
                    # parsed as the event wire (events take precedence over the state)
                    event = [{"type": "signal", "name": key, "value": raw}]
                    signals[key] = [{"pr": pr, "closing_issue": issue} for pr, issue in ts.dirty_surface_pairs({}, event, key)]
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
            value = s.pop(field)
            # A value the schema rejects (a non-object usage_eligibility, say)
            # can never be emitted — the TS emitter drops it with a marker — so
            # it is converted to ABSENT, which is also how decide.py reads it.
            if _emittable_blob(field, value):
                blobs[field] = value
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
        events = _fold_retired_glm_events(copy.deepcopy(entry["events"]))
        plan = decide.decide(state, copy.deepcopy(entry["candidates"]), events, now=entry["now"])
        return plan.to_json()
    except Exception as exc:  # a crash must crash identically in both forms
        return f"RAISED {type(exc).__name__}: {exc}"


def main() -> int:
    args = list(_argv)
    write_golden = "--write-golden" in args
    if write_golden:
        args.remove("--write-golden")
    dump = None
    if "--dump" in args:
        i = args.index("--dump")
        dump = args[i + 1]
        del args[i : i + 2]
    all_degraded = None
    if "--all-degraded" in args:
        i = args.index("--all-degraded")
        with open(args[i + 1], encoding="utf-8") as fh:
            all_degraded = json.load(fh)
        del args[i : i + 2]
    path = args[0] if args else os.path.join(HERE, "decide-inputs.jsonl.gz")
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        entries = [json.loads(line) for line in fh if line.strip()]
    golden: list[str] = []
    if not write_golden:
        with gzip.open(GOLDEN_PLANS, "rt", encoding="utf-8") as fh:
            golden = [json.loads(line)["plan"] for line in fh if line.strip()]
    dumped = open(dump, "w", encoding="utf-8") if dump else None
    identical = 0
    with_signals = 0
    unrepresentable: list[str] = []
    diverged: list[dict] = []
    plans: list[str] = []
    marker_checked = 0
    marker_identical = 0
    marker_diverged: list[int] = []
    for i, entry in enumerate(entries):
        state = entry["state"]
        if isinstance(state, dict) and isinstance(state.get("signals"), dict) and state["signals"]:
            with_signals += 1
        try:
            json_state = to_json_form(state) if isinstance(state, dict) else state
        except Unrepresentable as exc:
            unrepresentable.append(f"#{i}: {exc}")
            plans.append("UNREPRESENTABLE")
            continue
        if dumped is not None and isinstance(json_state, dict):
            dumped.write(json.dumps(json_state["turn_snapshot"]) + "\n")
        plan = run(entry, json_state)
        plans.append(plan)
        if all_degraded is not None and isinstance(json_state, dict):
            bare = {k: v for k, v in json_state.items() if k != "turn_snapshot"}
            marker_checked += 1
            ts_plan = run(entry, ts.apply(copy.deepcopy(all_degraded), copy.deepcopy(bare)))
            if ts_plan == run(entry, ts.apply(None, copy.deepcopy(bare), "node could not run")):
                marker_identical += 1
            else:
                marker_diverged.append(i)
        if not write_golden:
            if i < len(golden) and golden[i] == plan:
                identical += 1
            else:
                diverged.append({"index": i, "golden": (golden[i] if i < len(golden) else "<missing>")[:400], "plan": plan[:400]})
    if dumped is not None:
        dumped.close()
    if write_golden:
        body = "".join(json.dumps({"plan": plan}) + "\n" for plan in plans).encode("utf-8")
        with open(GOLDEN_PLANS, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as fh:
            fh.write(body)  # mtime=0: a re-record of the same Plans is byte-identical
        identical = len(plans)
    distinct = len(set(plans))
    print(
        json.dumps(
            {
                "entries": len(entries),
                "golden": len(golden) if not write_golden else len(plans),
                "with_signals": with_signals,
                "identical": identical,
                "distinct_plans": distinct,
                "unrepresentable": unrepresentable,
                "diverged": diverged[:5],
                "diverged_count": len(diverged),
                "autopilot_dir": os.path.relpath(AUTOPILOT_DIR, REPO) if AUTOPILOT_DIR.startswith(REPO + os.sep) else AUTOPILOT_DIR,
                "marker_checked": marker_checked,
                "marker_identical": marker_identical,
                "marker_diverged": marker_diverged[:10],
            }
        )
    )
    return 0 if identical == len(entries) and not unrepresentable else 1


if __name__ == "__main__":
    sys.exit(main())
