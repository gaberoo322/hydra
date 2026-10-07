#!/usr/bin/env python3
"""
turn_snapshot.py — the ONE reader of the Turn Snapshot (ADR-0043 Decision 5,
issue #4934; ADR-0007 keeps decide.py the pure brain).

What decide.py, render-dispatch.py, term-check.py and turn.sh's summary see
on a turn is ONE document: `state.turn_snapshot`, the typed JSON
`scripts/autopilot/turn-snapshot.ts` emits, validated on emit against
src/schemas/turn-snapshot.ts (the single source of truth for its shape) and
stored here by `turn_snapshot.py apply`. Packed strings are structured there:
pins are `{issue, pr, branch}`, anchors are ints, PR/issue lists are int
arrays, the dirty surface is `[{pr, closing_issue}]`.

There is no second form. A state without a usable snapshot (absent, wrong
`schema_version`, `validation.ok` not true, `signals`/`blobs` not objects)
reads as the ALL-DEGRADED snapshot ({@link ALL_DEGRADED_SIGNALS}): every
signal at its conservative value — nothing available, every producer cap
saturated, `health_fail` true so the doctor looks — and no blobs (the
previous turn's blob values on state are kept). decide.py therefore always
plans; it never runs on "nothing" and never crashes on a bad snapshot.

Every reader takes `state` (and `events`, where the decide.py helper did) and
keeps the exact event-then-state precedence and fail-open/fail-closed
semantics of the decide.py helper it was lifted from. The packed-string
parsers live HERE and nowhere else: decide.py never splits
`issue-N:PR:branch`. Signal EVENTS still carry that wire form — the session
writes them — so the same parsers read event values.

CLI (turn.sh):

  python3 scripts/autopilot/turn_snapshot.py apply <snapshot.json | -> [state.json]
  python3 scripts/autopilot/turn_snapshot.py apply --degraded <reason> [state.json]
  python3 scripts/autopilot/turn_snapshot.py summary [state.json]

stores the document on `state.turn_snapshot` (replaced, never merged), writes
the blob fields onto state (the previous value stays when a blob is absent),
seeds `state.slot_events` and advances `state.slot_events_last_id`. The
document is repaired PER FIELD first ({@link repair}): a signal that is
missing or of the wrong type takes its all-degraded value, a malformed blob
or `scout_spend_usd_today` is dropped, a malformed `degraded` entry is
dropped — each with a `degraded` marker — and the rest survives. Only a
structurally unusable document (unreadable, not JSON, not an object, wrong
`schema_version`, `validation.ok` not true, `signals`/`blobs` not objects)
is replaced whole by the all-degraded snapshot. Either way the apply
succeeds and the turn plans.

`apply --degraded <reason>` stores the all-degraded snapshot without reading
one (turn.sh, when the emit itself failed). `summary` prints turn.sh's
one-line usage summary, read through the accessor.

Exit 0 when a snapshot (repaired or all-degraded) was stored / the summary
printed; 1 when the state cannot be read or written; 2 on bad arguments.
Pure readers + one atomic write; no network.
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Any

SCHEMA_VERSION = 1
DEFAULT_STATE_PATH = os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json")

# The data-plane bodies decide.py normalises itself (state top-level fields).
BLOB_FIELDS = ("usage_eligibility", "emergency_brake", "target_risk_surface", "class_stats", "candidate_exclusions")
# Every blob the document may carry (slot_events feeds state.slot_events, not a blob field).
_ALL_BLOBS = BLOB_FIELDS + ("slot_events",)

# Signal kinds — the Python mirror of SignalsSchema in src/schemas/turn-snapshot.ts.
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
_COUNT_SIGNALS = ("scout_alert_eligible_count", "hitl_grill_open", "wayfinder_orch_inflight_global")
_TEXT_SIGNALS = ("target_needs_qa_pr_ref", "target_needs_qa_pr_head", "wayfinder_orch_ticket_type")
_SURFACE_SIGNAL = "orch_prs_dirty_surface"
_SHARE_SIGNAL = "orch_realm_weekly_share"

# The ALL-DEGRADED snapshot's signals: what decide.py reads when the turn's
# facts could not be read at all. Conservative, never optimistic — no work is
# "available", no board is "idle" or "due", every producer cap is saturated
# (so no backfill / scan / scout producer fires on facts nobody read), no pin
# or anchor is resolved, and `health_fail` + `orch_board_signals_degraded`
# are raised so the doctor runs and the degradation is visible. Also the
# per-field repair value of an invalid signal. Drift-tested against
# ALL_DEGRADED_SIGNALS in src/schemas/turn-snapshot.ts
# (test/turn-snapshot-json.test.mts).
ALL_DEGRADED_SIGNALS: dict[str, Any] = {
    "orch_work_available": False,
    "needs_qa_orch": False,
    "needs_research": False,
    "needs_triage_orch": False,
    "needs_qa_numbers": [],
    "orch_needs_triage_items": [],
    "untriaged_orphans_orch": False,
    "target_work_available": False,
    "target_board_work_available": False,
    "target_board_research_due": False,
    "target_wip_saturated": True,
    "needs_qa_target": False,
    "target_needs_qa_pr_ref": "",
    "target_needs_qa_pr_head": "",
    "target_dev_resume_pick": None,
    "needs_triage_target": False,
    "target_needs_triage_items": [],
    "health_fail": True,
    "scout_walk_due": False,
    "scout_board_saturated": True,
    "scout_alert_eligible_count": 0,
    "orch_backfill_idle": False,
    "arch_board_saturated": True,
    "hitl_grill_open": 0,
    "hitl_grill_saturated": True,
    "orch_board_signals_degraded": True,
    "cleanup_board_saturated": True,
    "skill_prune_board_saturated": True,
    "target_backfill_idle": False,
    "target_cleanup_board_saturated": True,
    "wire_or_retire_target_available": False,
    "design_qa_target_due": False,
    "design_qa_target_saturated": True,
    "retro_run_available": False,
    "retro_run_drillable": False,
    "orch_prs_dirty": [],
    "orch_prs_unchecked": [],
    "orch_prs_behind": [],
    "orch_ci_trigger_stale": False,
    "orch_prs_glm_red": [],
    "orch_glm_red_forward_fix": None,
    "orch_dev_resume_pick": None,
    "orch_dirty_forward_fix": None,
    "orch_prs_dirty_surface": [],
    "orch_pending_grill_anchor": None,
    "orch_dev_ready_anchor": None,
    "wayfinder_orch_frontier": None,
    "wayfinder_orch_ticket_type": "",
    "wayfinder_orch_inflight_global": 0,
    "tickets_available": False,
    "tickets_orch_pending_spec": None,
    "orch_realm_weekly_share": None,
}


def all_degraded_snapshot(reason: str, generated_at: str = "all-degraded") -> dict:
    """The whole-document fallback: every signal degraded, no blobs (previous state values kept)."""
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "signals": {k: (list(v) if isinstance(v, list) else v) for k, v in ALL_DEGRADED_SIGNALS.items()},
        "blobs": {},
        "degraded": [{"collector": "turn-snapshot", "field": "*", "reason": reason}],
        "validation": {"ok": True},
    }


_ALL_DEGRADED = all_degraded_snapshot("no usable Turn Snapshot on state")


# ---------------------------------------------------------------------------
# Snapshot access
# ---------------------------------------------------------------------------


def _usable(snap: Any) -> bool:
    """A structurally usable v1 document (the per-field checks are repair()'s)."""
    if not isinstance(snap, dict) or snap.get("schema_version") != SCHEMA_VERSION:
        return False
    validation = snap.get("validation")
    if not isinstance(validation, dict) or validation.get("ok") is not True:
        return False
    return isinstance(snap.get("signals"), dict) and isinstance(snap.get("blobs"), dict)


def snapshot(state: Any) -> dict:
    """This turn's Turn Snapshot: the usable v1 document on `state`, else the all-degraded one."""
    snap = state.get("turn_snapshot") if isinstance(state, dict) else None
    return snap if _usable(snap) else _ALL_DEGRADED


def _state_signal(state: Any, name: str) -> Any:
    """This turn's value of signal `name` (None = absent)."""
    return snapshot(state)["signals"].get(name)


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
    """Ints of a list value or of the event wire's space-separated text; bad tokens dropped."""
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
    """A scalar signal's value as-is (counts, the realm share, the wayfinder
    in-flight count / ticket type) — the caller applies its own coercion and
    fail-open default, exactly as before. None = absent."""
    return _state_signal(state, signal_name)


def anchor_ref(state: dict, signal_name: str) -> str | None:
    """An anchor signal as the canonical `issue-N` Anchor reference: a positive
    int → `issue-N`; null/absent/anything else → None."""
    value = _state_signal(state, signal_name)
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return f"issue-{value}"
    return None


def _parse_pin(raw: Any) -> tuple[int, int, str] | None:
    """A pin from its JSON form `{issue, pr, branch}` or the event wire `issue-N:PR:branch`."""
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
    `scout_spend_usd_today` scalar. The snapshot's value; ABSENT there means it
    did not parse this turn, so the previous value `apply` left on state is kept."""
    if not isinstance(state, dict):
        return None
    snap = snapshot(state)
    if name == "scout_spend_usd_today":
        if "scout_spend_usd_today" in snap:
            return snap["scout_spend_usd_today"]
    elif name in snap["blobs"]:
        return snap["blobs"][name]
    return state.get(name)


def usage_eligibility(state: dict) -> dict:
    """The usage-eligibility body as a dict ({} when absent or not an object) —
    render-dispatch.py / term-check.py / turn.sh's summary read it here."""
    value = blob(state, "usage_eligibility")
    return value if isinstance(value, dict) else {}


# ---------------------------------------------------------------------------
# Per-field repair (apply)
# ---------------------------------------------------------------------------


def degraded(state: dict, collectors: tuple[str, ...] = (), fields: tuple[str, ...] = ()) -> bool:
    """True when the turn's snapshot carries a degraded marker from one of
    `collectors`, or for one of `fields` — or is the all-degraded document
    (field `*`). Lets a policy fail CLOSED on a value read from a degraded
    collector instead of trusting its partial count. Never raises."""
    for m in snapshot(state).get("degraded") or []:
        if not isinstance(m, dict):
            continue
        if m.get("field") == "*" or m.get("collector") in collectors or m.get("field") in fields:
            return True
    return False


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _valid_signal(name: str, value: Any) -> bool:
    """`value` has the type SignalsSchema gives `name`."""
    if name in _PIN_SIGNALS:
        return value is None or (
            isinstance(value, dict)
            and set(value) == {"issue", "pr", "branch"}
            and _is_int(value["issue"]) and value["issue"] > 0
            and _is_int(value["pr"]) and value["pr"] > 0
            and isinstance(value["branch"], str) and value["branch"] != ""
        )
    if name in _ANCHOR_SIGNALS:
        return value is None or (_is_int(value) and value > 0)
    if name in _LIST_SIGNALS:
        return isinstance(value, list) and all(_is_int(n) and n > 0 for n in value)
    if name in _COUNT_SIGNALS:
        return _is_int(value) and value >= 0
    if name in _TEXT_SIGNALS:
        return isinstance(value, str)
    if name == _SURFACE_SIGNAL:
        return isinstance(value, list) and all(
            isinstance(e, dict)
            and set(e) == {"pr", "closing_issue"}
            and _is_int(e["pr"]) and e["pr"] > 0
            and (e["closing_issue"] is None or (_is_int(e["closing_issue"]) and e["closing_issue"] > 0))
            for e in value
        )
    if name == _SHARE_SIGNAL:
        return value is None or (
            isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 1
        )
    return isinstance(value, bool)


def _valid_degraded(entry: Any) -> bool:
    return (
        isinstance(entry, dict)
        and set(entry) == {"collector", "field", "reason"}
        and isinstance(entry["collector"], str) and entry["collector"] != ""
        and isinstance(entry["field"], str) and entry["field"] != ""
        and isinstance(entry["reason"], str)
    )


# Blobs a consumer indexes as a mapping: a non-object here would be read as
# "no verdict" (usage gate) or "brake off" — fail CLOSED instead by dropping it,
# which keeps the previous state value, with a marker.
_DICT_BLOBS = ("usage_eligibility", "emergency_brake")


def _valid_blob(name: str, value: Any) -> bool:
    if name == "candidate_exclusions":
        return isinstance(value, list) and all(isinstance(r, dict) for r in value)
    if name in _DICT_BLOBS:
        return isinstance(value, dict)
    return True  # inner shapes are owned by the service routes; presence + JSON is the contract


def repair(snap: dict) -> dict:
    """A usable document with every field checked: an invalid or missing signal
    takes its all-degraded value, an unknown signal / malformed blob / malformed
    `scout_spend_usd_today` / malformed `degraded` entry is dropped — each
    noted as a `degraded` marker. Returns a NEW document; never raises."""
    markers: list[dict] = []
    raw_degraded = snap.get("degraded")
    kept = [d for d in raw_degraded if _valid_degraded(d)] if isinstance(raw_degraded, list) else []
    if not isinstance(raw_degraded, list) or len(kept) != len(raw_degraded):
        markers.append({"collector": "turn-snapshot", "field": "degraded", "reason": "malformed-entry-dropped"})

    signals: dict = {}
    raw_signals = snap["signals"]
    for name, fallback in ALL_DEGRADED_SIGNALS.items():
        if name not in raw_signals:
            signals[name] = list(fallback) if isinstance(fallback, list) else fallback
            markers.append({"collector": "turn-snapshot", "field": name, "reason": "missing"})
        elif _valid_signal(name, raw_signals[name]):
            signals[name] = raw_signals[name]
        else:
            signals[name] = list(fallback) if isinstance(fallback, list) else fallback
            markers.append({"collector": "turn-snapshot", "field": name, "reason": "schema-invalid"})
    for name in raw_signals:
        if name not in ALL_DEGRADED_SIGNALS:
            markers.append({"collector": "turn-snapshot", "field": str(name), "reason": "unknown-signal-dropped"})

    blobs: dict = {}
    for name, value in snap["blobs"].items():
        if name in _ALL_BLOBS and _valid_blob(name, value):
            blobs[name] = value
        else:
            markers.append({"collector": "turn-snapshot", "field": str(name), "reason": "schema-invalid"})

    out = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": snap.get("generated_at") if isinstance(snap.get("generated_at"), str) else "unknown",
        "signals": signals,
        "blobs": blobs,
        "degraded": kept + markers,
        "validation": {"ok": True},
    }
    if "scout_spend_usd_today" in snap:
        spend = snap["scout_spend_usd_today"]
        if isinstance(spend, (int, float)) and not isinstance(spend, bool) and math.isfinite(spend) and spend >= 0:
            out["scout_spend_usd_today"] = spend
        else:
            out["degraded"].append({"collector": "turn-snapshot", "field": "scout_spend_usd_today", "reason": "schema-invalid"})
    if isinstance(snap.get("observability"), dict):
        out["observability"] = snap["observability"]
    return out


def apply(snap: Any, state: dict, unusable_reason: str | None = None) -> dict:
    """Store this turn's Turn Snapshot on `state` — the per-field-repaired
    document, or the all-degraded one when `snap` is structurally unusable.
    Mutates and returns `state`; never touches `turn`, never raises."""
    if _usable(snap):
        doc = repair(snap)
    else:
        doc = all_degraded_snapshot(unusable_reason or "structurally unusable Turn Snapshot")
    state["turn_snapshot"] = doc
    blobs = doc["blobs"]
    for field in BLOB_FIELDS:
        if field in blobs:
            state[field] = blobs[field]
    if "scout_spend_usd_today" in doc:
        state["scout_spend_usd_today"] = float(doc["scout_spend_usd_today"])
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


def _why_unusable(snap: Any) -> str:
    if not isinstance(snap, dict):
        return f"not a JSON object ({type(snap).__name__})"
    if snap.get("schema_version") != SCHEMA_VERSION:
        return f"schema_version {snap.get('schema_version')!r} is not {SCHEMA_VERSION}"
    validation = snap.get("validation")
    if not isinstance(validation, dict) or validation.get("ok") is not True:
        return "failed validation on emit"
    return "signals/blobs are not objects"


def _read_state(state_path: str) -> dict | None:
    try:
        with open(state_path, encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"[turn_snapshot] cannot read state {state_path}: {exc}", file=sys.stderr)
        return None
    if not isinstance(state, dict):
        print(f"[turn_snapshot] state {state_path} is not a JSON object", file=sys.stderr)
        return None
    return state


def summary(state: dict) -> dict:
    """turn.sh's usage summary line: the usage meter + quota fields, read through the accessor."""
    eligibility = usage_eligibility(state)
    usage = eligibility.get("usage") if isinstance(eligibility.get("usage"), dict) else {}
    slots = state.get("slots") if isinstance(state.get("slots"), dict) else {}
    return {
        "percentLast5h": usage.get("percentLast5h"),
        "percentSinceReset": usage.get("percentSinceReset"),
        "allow": eligibility.get("allow"),
        "quota_baseline": state.get("quota_baseline"),
        "cumulative_tokens": state.get("cumulative_tokens"),
        "slots_occupied": [k for k, v in slots.items() if v is not None],
        "snapshot_degraded": len(snapshot(state).get("degraded") or []),
    }


def _apply_cli(args: list[str]) -> int:
    if len(args) >= 2 and args[0] == "--degraded":
        snap_path, reason, rest = None, args[1] or "the Turn Snapshot emit failed", args[2:]
    else:
        snap_path, reason, rest = (args[0] if args else None), None, args[1:]
    if snap_path is None and reason is None or len(rest) > 1:
        return -1
    state_path = rest[0] if rest else DEFAULT_STATE_PATH
    state = _read_state(state_path)
    if state is None:
        return 1

    snap: Any = None
    if snap_path is not None:
        try:
            raw = sys.stdin.read() if snap_path == "-" else open(snap_path, encoding="utf-8").read()
            snap = json.loads(raw)
        except (OSError, ValueError, RecursionError) as exc:
            # RecursionError: a pathologically nested document overflows the
            # parser — as unusable as non-JSON, so it takes the same fallback.
            reason = f"unreadable: {type(exc).__name__}: {exc}"[:300]
        if reason is None and not _usable(snap):
            reason = _why_unusable(snap)
        if reason is not None:
            print(f"[turn_snapshot] {snap_path} is not a usable v{SCHEMA_VERSION} Turn Snapshot ({reason}) — applying the all-degraded snapshot", file=sys.stderr)

    try:
        apply(snap if reason is None else None, state, reason)
        text_out = json.dumps(state, indent=1)
    except (RecursionError, ValueError) as exc:
        # A parseable but pathologically nested value (a blob, typically) can
        # still overflow the repair walk or the serialiser: re-read the state
        # and apply the all-degraded snapshot instead of failing the turn.
        reason = f"unserialisable: {type(exc).__name__}: {exc}"[:300]
        print(f"[turn_snapshot] {snap_path} could not be applied ({reason}) — applying the all-degraded snapshot", file=sys.stderr)
        state = _read_state(state_path)
        if state is None:
            return 1
        apply(None, state, reason)
        text_out = json.dumps(state, indent=1)
    tmp = f"{state_path}.turn-snapshot.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text_out)
            fh.write("\n")
        os.replace(tmp, state_path)
    except OSError as exc:
        print(f"[turn_snapshot] cannot write state {state_path}: {exc}", file=sys.stderr)
        return 1
    doc = state["turn_snapshot"]
    eligibility = state.get("usage_eligibility")
    print(
        json.dumps(
            {
                "form": "json" if reason is None else "all-degraded",
                "signals_keys": len(doc["signals"]),
                "degraded": len(doc["degraded"]),
                "slot_events": len(state.get("slot_events") or []),
                "slot_events_last_id": state.get("slot_events_last_id"),
                "allow": eligibility.get("allow") if isinstance(eligibility, dict) else None,
            }
        )
    )
    return 0


USAGE = (
    "usage: turn_snapshot.py apply <snapshot.json | -> [state.json]\n"
    "       turn_snapshot.py apply --degraded <reason> [state.json]\n"
    "       turn_snapshot.py summary [state.json]"
)


def main(argv: list[str]) -> int:
    cmd, args = (argv[1] if len(argv) > 1 else ""), argv[2:]
    if cmd == "apply":
        code = _apply_cli(args)
    elif cmd == "summary" and len(args) <= 1:
        state = _read_state(args[0] if args else DEFAULT_STATE_PATH)
        if state is None:
            return 1
        print(json.dumps(summary(state)))
        code = 0
    else:
        code = -1
    if code == -1:
        print(USAGE, file=sys.stderr)
        return 2
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
