#!/usr/bin/env python3
"""
turn_snapshot.py — the ONE reader decide.py uses for the Turn Snapshot
(ADR-0043 Decision 5, issue #4934; ADR-0007 keeps decide.py the pure brain).

What decide.py sees on a turn arrives in one of two forms:

  JSON form    `state.turn_snapshot` — the typed document
               `scripts/autopilot/turn-snapshot.ts --format json` emits,
               validated on emit against src/schemas/turn-snapshot.ts (the
               single source of truth for its shape). turn.sh stores it with
               `turn_snapshot.py apply`. Packed strings are structured there:
               pins are `{issue, pr, branch}`, anchors are ints, PR/issue
               lists are int arrays, the dirty surface is `[{pr, closing_issue}]`.
  legacy form  `state.signals` + the top-level blob fields, as
               merge-signals.py writes them from collect-state.sh's kv lines.
               The FALLBACK while the expand PR (6a) is live; the contract
               PR (6b) deletes it together with collect-state.sh and
               merge-signals.py.

Every reader here takes `state` (and `events`, where the old decide.py helper
did) and answers in ONE typed shape whichever form is present. The JSON form
wins whenever `state.turn_snapshot` is a valid v1 document; anything else
reads the legacy form. Each reader keeps the exact event-then-state
precedence and fail-open/fail-closed semantics of the decide.py helper it was
lifted from, so decide.py's policy is unchanged — only where the bytes come
from moved. The packed-string parsers live HERE and nowhere else: decide.py
never splits `issue-N:PR:branch`. (Signal EVENTS still carry the legacy wire
form — the session writes them — so the same parsers read event values.)

CLI (turn.sh, the JSON path of Phase 1):

  python3 scripts/autopilot/turn_snapshot.py apply <snapshot.json | -> [state.json]

stores the document on `state.turn_snapshot` (replaced, never merged), seeds
`state.slot_events` / advances `state.slot_events_last_id` exactly as
merge-signals.py does, and — expand-phase compat only — writes the legacy
`state.signals` + top-level blob fields that render-dispatch.py, term-check.py
and turn.sh's summary still read. Exit 0 on success; 1 when the state cannot
be read; 2 on bad arguments; 3 when the snapshot is unreadable or did not
validate (turn.sh then runs the kv path for the turn). Pure readers + one
atomic write; no network.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

SCHEMA_VERSION = 1
DEFAULT_STATE_PATH = os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json")

# The data-plane bodies decide.py normalises itself (state top-level fields).
BLOB_FIELDS = ("usage_eligibility", "emergency_brake", "target_risk_surface", "class_stats", "candidate_exclusions")

# Signals whose "nothing" is an OMITTED legacy key (merge-signals.py's `ref`).
_PIN_SIGNALS = ("orch_glm_red_forward_fix", "orch_dev_resume_pick", "orch_dirty_forward_fix", "target_dev_resume_pick")
_ANCHOR_SIGNALS = ("orch_pending_grill_anchor", "orch_dev_ready_anchor", "wayfinder_orch_frontier", "tickets_orch_pending_spec")
_LIST_SIGNALS = (
    "needs_qa_numbers",
    "orch_needs_triage_items",
    "target_needs_triage_items",
    "orch_prs_dirty",
    "orch_prs_unchecked",
    "orch_prs_behind",
    "orch_prs_glm_red",
)


# ---------------------------------------------------------------------------
# Form detection
# ---------------------------------------------------------------------------


def snapshot(state: Any) -> dict | None:
    """The valid v1 JSON Turn Snapshot on `state`, or None (→ legacy form)."""
    if not isinstance(state, dict):
        return None
    snap = state.get("turn_snapshot")
    if not isinstance(snap, dict) or snap.get("schema_version") != SCHEMA_VERSION:
        return None
    validation = snap.get("validation")
    if not isinstance(validation, dict) or validation.get("ok") is not True:
        return None
    if not isinstance(snap.get("signals"), dict) or not isinstance(snap.get("blobs"), dict):
        return None
    return snap


def _state_signal(state: dict, name: str) -> Any:
    """This turn's value of signal `name` from whichever form is present (None = absent)."""
    snap = snapshot(state)
    if snap is not None:
        return snap["signals"].get(name)
    return (state.get("signals") or {}).get(name)


def _event_value(events: list[dict], name: str) -> tuple[bool, Any]:
    """(found, value) of the FIRST `signal` event named `name`."""
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == name:
            return True, ev.get("value")
    return False, None


def _first_event_value_or_none(events: list[dict], name: str) -> Any:
    found, value = _event_value(events, name)
    return value if found else None


# ---------------------------------------------------------------------------
# Readers (one per read shape decide.py had)
# ---------------------------------------------------------------------------


def signal_present(state: dict, events: list[dict], signal: str) -> bool:
    """A flag by name. Events take precedence over state (a valueless event reads True)."""
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == signal:
            return bool(ev.get("value", True))
    return bool(_state_signal(state, signal))


def _raw_signal(state: dict, events: list[dict], name: str) -> Any:
    """The first matching `signal` event's value wins, else this turn's state value."""
    found, value = _event_value(events, name)
    if found:
        return value
    return _state_signal(state, name)


def _int_tokens(raw: Any) -> list[int]:
    """Ints of a list value or of the legacy space-separated text; bad tokens dropped."""
    candidates = raw if isinstance(raw, (list, tuple)) else str(raw).split()
    out: list[int] = []
    for token in candidates:
        try:
            out.append(int(str(token).strip()))
        except (TypeError, ValueError):
            continue
    return out


def pr_numbers(state: dict, events: list[dict], key: str) -> list[int]:
    """A PR-gate PR-number signal (#4240) as a deduplicated ascending list; absent → []."""
    raw = _raw_signal(state, events, key)
    if raw is None:
        return []
    return sorted(set(_int_tokens(raw)))


def item_set(state: dict, events: list[dict], signal_name: str) -> set[int] | None:
    """A needs-triage item set (#3729/#3939). None when ABSENT (fail-open sentinel)."""
    raw = _first_event_value_or_none(events, signal_name)
    if raw is None:
        raw = _state_signal(state, signal_name)
    if raw is None:
        return None
    return set(_int_tokens(raw))


def ordered_numbers(state: dict, events: list[dict], signal_name: str) -> list[int] | None:
    """An ORDERED number list (`needs_qa_numbers`, #3829 — `[0]` is QA's next pick). None when ABSENT."""
    raw = _first_event_value_or_none(events, signal_name)
    if raw is None:
        raw = _state_signal(state, signal_name)
    if raw is None:
        return None
    return _int_tokens(raw)


def text(state: dict, events: list[dict], signal_name: str) -> str | None:
    """A verbatim string signal (e.g. `target_needs_qa_pr_ref`), stripped; absent/empty → None."""
    raw = _first_event_value_or_none(events, signal_name)
    if raw is None:
        raw = _state_signal(state, signal_name)
    if raw is None:
        return None
    value = str(raw).strip()
    return value or None


def scalar(state: dict, signal_name: str) -> Any:
    """A scalar signal's state value as-is (counts, the realm share, the wayfinder
    in-flight count / ticket type) — the caller applies its own coercion and
    fail-open default, exactly as before. None = absent."""
    return _state_signal(state, signal_name)


def anchor_ref(state: dict, signal_name: str) -> Any:
    """An anchor signal as the canonical `issue-N` Anchor reference.

    JSON form: a positive int → `issue-N`; null/absent → None. Legacy form: the
    state value verbatim (an `issue-N` string, `none`, or whatever an older
    turn left) — the caller keeps its own absent/`none` normalisation."""
    snap = snapshot(state)
    if snap is None:
        return (state.get("signals") or {}).get(signal_name) if isinstance(state, dict) else None
    value = snap["signals"].get(signal_name)
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return f"issue-{value}"
    return None


def _parse_pin(raw: Any) -> tuple[int, int, str] | None:
    """A pin from its JSON form `{issue, pr, branch}` or the legacy `issue-N:PR:branch` wire."""
    if isinstance(raw, dict):
        issue, pr, branch = raw.get("issue"), raw.get("pr"), raw.get("branch")
        if any(isinstance(x, bool) or not isinstance(x, int) for x in (issue, pr)):
            return None
        if not isinstance(branch, str) or not branch.strip() or issue <= 0 or pr <= 0:
            return None
        return issue, pr, branch.strip()
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw or raw == "none":
        return None
    parts = raw.split(":")
    if len(parts) != 3:
        return None
    issue_part, pr_part, branch_part = parts
    if not issue_part.startswith("issue-"):
        return None
    try:
        issue_num = int(issue_part[len("issue-"):])
        pr_num = int(pr_part)
    except (TypeError, ValueError):
        return None
    branch = branch_part.strip()
    if issue_num <= 0 or pr_num <= 0 or not branch:
        return None
    return issue_num, pr_num, branch


def pin(state: dict, events: list[dict], name: str) -> tuple[int, int, str] | None:
    """A pre-resolved dev pin (#4460, #4518, #4739, #4807) as `(issue, pr, branch)`.
    Events take precedence over state. Absent / none / malformed → None; never raises."""
    return _parse_pin(_raw_signal(state, events, name))


def dirty_surface_pairs(state: dict, events: list[dict], name: str) -> list[tuple[int, int | None]]:
    """A dirty-surface signal (`orch_prs_dirty_surface`, #4807) as
    `[(pr, closing_issue|None)]`, ascending, deduplicated by PR (last wins).
    Malformed entries are dropped (fail-closed: surfacing is terminal)."""
    raw = _raw_signal(state, events, name)
    if raw is None:
        return []
    entries = raw if isinstance(raw, (list, tuple)) else str(raw).split()
    pairs: dict[int, int | None] = {}
    for entry in entries:
        if isinstance(entry, dict):
            pr_num, issue = entry.get("pr"), entry.get("closing_issue")
            if isinstance(pr_num, bool) or not isinstance(pr_num, int) or pr_num <= 0:
                continue
            if issue is not None and (isinstance(issue, bool) or not isinstance(issue, int) or issue <= 0):
                continue
            pairs[pr_num] = issue
            continue
        parts = str(entry).strip().split(":")
        if len(parts) != 2:
            continue
        try:
            pr_num = int(parts[0])
        except (TypeError, ValueError):
            continue
        if pr_num <= 0:
            continue
        issue_num: int | None = None
        if parts[1] != "none":
            try:
                issue_num = int(parts[1])
            except (TypeError, ValueError):
                continue
            if issue_num <= 0:
                continue
        pairs[pr_num] = issue_num
    return sorted(pairs.items())


def blob(state: dict, name: str) -> Any:
    """A data-plane blob decide.py normalises itself (usage eligibility, emergency
    brake, Target risk surface, class stats, candidate exclusions) and the
    `scout_spend_usd_today` scalar. JSON form: the snapshot's value; ABSENT there
    means it did not parse this turn, so the previous state value is kept (the
    kv path's rule). Legacy form: the state field."""
    if not isinstance(state, dict):
        return None
    snap = snapshot(state)
    if snap is not None:
        if name == "scout_spend_usd_today":
            if "scout_spend_usd_today" in snap:
                return snap["scout_spend_usd_today"]
        elif name in snap["blobs"]:
            return snap["blobs"][name]
    return state.get(name)


# ---------------------------------------------------------------------------
# Expand-phase compat: the JSON form projected onto the legacy state fields
# (render-dispatch.py, term-check.py and turn.sh's summary still read them).
# Deleted by 6b once those readers use this module.
# ---------------------------------------------------------------------------


def _pin_wire(value: Any) -> str | None:
    p = _parse_pin(value)
    return None if p is None else f"issue-{p[0]}:{p[1]}:{p[2]}"


def legacy_signals(snap: dict) -> dict:
    """`state.signals` exactly as merge-signals.py would derive it from the kv lines."""
    out: dict = {}
    for name, value in snap.get("signals", {}).items():
        if name in _PIN_SIGNALS:
            wire = _pin_wire(value)
            if wire is not None:
                out[name] = wire
        elif name in _ANCHOR_SIGNALS:
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                out[name] = f"issue-{value}"
        elif name in _LIST_SIGNALS:
            out[name] = " ".join(str(n) for n in value) if isinstance(value, list) else ""
        elif name == "orch_prs_dirty_surface":
            out[name] = " ".join(
                f"{e.get('pr')}:{'none' if e.get('closing_issue') is None else e.get('closing_issue')}"
                for e in (value if isinstance(value, list) else [])
                if isinstance(e, dict)
            )
        elif name == "orch_realm_weekly_share":
            out[name] = "unavailable" if value is None else f"{float(value):.4f}"
        elif name == "wayfinder_orch_inflight_global":
            out[name] = str(value)
        else:
            out[name] = value
    return out


def apply(snap: dict, state: dict) -> dict:
    """Store one JSON Turn Snapshot on `state` (merge-signals.py's contract, JSON in).
    Mutates and returns `state`; never touches `turn`."""
    state["turn_snapshot"] = snap
    state["signals"] = legacy_signals(snap)
    blobs = snap.get("blobs") or {}
    for field in BLOB_FIELDS:
        if field in blobs:
            state[field] = blobs[field]
    if "scout_spend_usd_today" in snap:
        state["scout_spend_usd_today"] = float(snap["scout_spend_usd_today"])
    events = blobs.get("slot_events")
    if isinstance(events, dict):
        rows = events.get("events")
        state["slot_events"] = rows if isinstance(rows, list) else []
        if events.get("last_id"):
            state["slot_events_last_id"] = events["last_id"]
    elif isinstance(events, list):
        state["slot_events"] = events
    else:
        # Absent or unreadable: no events THIS turn (replaying last turn's would double-count).
        state["slot_events"] = []
    return state


def main(argv: list[str]) -> int:
    if len(argv) < 3 or len(argv) > 4 or argv[1] != "apply":
        print("usage: turn_snapshot.py apply <snapshot.json | -> [state.json]", file=sys.stderr)
        return 2
    snap_path = argv[2]
    state_path = argv[3] if len(argv) == 4 else DEFAULT_STATE_PATH
    try:
        raw = sys.stdin.read() if snap_path == "-" else open(snap_path, encoding="utf-8").read()
        snap = json.loads(raw)
    except (OSError, ValueError) as exc:
        print(f"[turn_snapshot] cannot read snapshot {snap_path}: {exc}", file=sys.stderr)
        return 3
    if snapshot({"turn_snapshot": snap}) is None:
        print(f"[turn_snapshot] {snap_path} is not a valid v{SCHEMA_VERSION} Turn Snapshot (or failed validation on emit)", file=sys.stderr)
        return 3
    try:
        with open(state_path, encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"[turn_snapshot] cannot read state {state_path}: {exc}", file=sys.stderr)
        return 1
    if not isinstance(state, dict):
        print(f"[turn_snapshot] state {state_path} is not a JSON object", file=sys.stderr)
        return 1
    apply(snap, state)
    tmp = f"{state_path}.turn-snapshot.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=1)
        fh.write("\n")
    os.replace(tmp, state_path)
    eligibility = state.get("usage_eligibility")
    print(
        json.dumps(
            {
                "form": "json",
                "signals_keys": len(snap["signals"]),
                "degraded": len(snap.get("degraded") or []),
                "slot_events": len(state.get("slot_events") or []),
                "slot_events_last_id": state.get("slot_events_last_id"),
                "allow": eligibility.get("allow") if isinstance(eligibility, dict) else None,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
