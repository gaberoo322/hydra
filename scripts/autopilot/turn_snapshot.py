#!/usr/bin/env python3
"""
turn_snapshot.py — the ONE reader of the Turn Snapshot (ADR-0043 Decision 5,
issue #4934; ADR-0007 keeps decide.py the pure brain; store-only since #5083).

What decide.py, render-dispatch.py and turn.sh's summary see
on a turn is ONE document: `state.turn_snapshot`, the typed JSON
`scripts/autopilot/turn-snapshot.ts` emits. The TS emitter is its ONLY
validator: src/schemas/turn-snapshot.ts is the single source of truth for its
shape, the emitter repairs an invalid field to its all-degraded value on emit,
and a failed collector run is replaced — by turn.sh — with the document
`turn-snapshot.ts --all-degraded` prints. This module TRUSTS that document:
`apply` stores it as emitted, and nothing here re-validates, repairs or knows
a signal's type or default (no Python copy of the schema exists). Packed
strings are structured there: pins are `{issue, pr, branch}`, anchors are
ints, PR/issue lists are int arrays, the dirty surface is `[{pr, closing_issue}]`.

The one Python-made document is the MARKER ({@link marker_document}): what
`apply` stores when no document could be read at all — an unreadable file, or
`apply --degraded <reason>` (turn.sh, when node itself could not run
turn-snapshot.ts, not even `--all-degraded`). It carries the `*` degraded
marker and NO `signals`, and a document without signals reads as
every-signal-degraded: each reader returns its absent value (None, which the
reader's own fail-open / fail-closed default turns into "nothing available"),
and a flag reads by the all-degraded document's naming convention — a fault or
cap flag (a name ending `_fail`, `_degraded` or `_saturated`) is raised, every
other flag is not (pinned on the TS side in test/turn-snapshot-json.test.mts) —
so decide.py plans exactly as it does on the TS all-degraded document: the
doctor runs, no producer cap opens, no work is "available". It never crashes
on a missing snapshot.

An ABSENT key is read two ways. In production a document that carries
`signals` but not the one asked for reads absent (None) — decide.py's
fail-open/fail-closed defaults apply, as they always have. In replay mode
(HYDRA_AUTOPILOT_SNAPSHOT_REPLAY set: turn.sh replaying a recorded document,
the golden harnesses) the same read RAISES {@link UnknownSignalError}: a
signal decide.py reads that the schema does not emit fails loud instead of
silently planning on its absence. (A blob is legitimately absent — its body
did not parse this turn — so only a blob name outside {@link BLOB_FIELDS}
raises there.)

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
seeds `state.slot_events` and advances `state.slot_events_last_id`. A file
that cannot be read as a JSON object is stored as the marker document.
`apply --degraded <reason>` stores the marker document without reading one.
`summary` prints turn.sh's one-line usage summary, read through the accessor.

Exit 0 when a snapshot (the document or the marker) was stored / the summary
printed; 1 when the state cannot be read or written; 2 on bad arguments.
Pure readers + one atomic write; no network.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

SCHEMA_VERSION = 1
DEFAULT_STATE_PATH = os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json")
# Set → replay / golden mode: a read of a signal the document does not carry raises.
REPLAY_ENV = "HYDRA_AUTOPILOT_SNAPSHOT_REPLAY"

# The data-plane bodies decide.py normalises itself (state top-level fields).
BLOB_FIELDS = ("usage_eligibility", "emergency_brake", "target_risk_surface", "class_stats", "candidate_exclusions")
# Every blob name a reader may ask for (slot_events feeds state.slot_events).
_KNOWN_BLOBS = BLOB_FIELDS + ("slot_events",)
# A document without signals raises the flags named by the all-degraded convention: faults and caps.
_RAISED_WHEN_UNREAD = ("_fail", "_degraded", "_saturated")


class UnknownSignalError(LookupError):
    """Replay mode: decide.py read a key the stored Turn Snapshot does not carry."""


def marker_document(reason: str) -> dict:
    """The minimal document stored when no Turn Snapshot could be read: no
    signals (every signal reads degraded), no blobs (the previous state values
    are kept), one `*` marker naming why."""
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": "unread",
        "degraded": [{"collector": "turn-snapshot", "field": "*", "reason": reason}],
    }


_UNREAD = marker_document("no Turn Snapshot on state")


def _replay_mode() -> bool:
    return bool(os.environ.get(REPLAY_ENV))


# ---------------------------------------------------------------------------
# Snapshot access
# ---------------------------------------------------------------------------


def snapshot(state: Any) -> dict:
    """This turn's Turn Snapshot as stored on `state`, else the marker document."""
    snap = state.get("turn_snapshot") if isinstance(state, dict) else None
    return snap if isinstance(snap, dict) else _UNREAD


def _signals(state: Any) -> dict | None:
    """The document's signals; None when it carries none (every signal degraded)."""
    signals = snapshot(state).get("signals")
    return signals if isinstance(signals, dict) else None


def _state_signal(state: Any, name: str) -> Any:
    """This turn's value of signal `name` (None = absent or degraded). A key
    missing from a document that carries signals raises in replay mode."""
    signals = _signals(state)
    if signals is None:
        return None
    if name in signals:
        return signals[name]
    if _replay_mode():
        raise UnknownSignalError(f"{REPLAY_ENV} is set and the Turn Snapshot carries no signal {name!r} — decide.py reads a signal the schema does not emit")
    return None


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
    """A flag by name. Events take precedence over state (a valueless event reads
    True). A document without signals raises only the fault / cap flags."""
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == signal:
            return bool(ev.get("value", True))
    if _signals(state) is None:
        return signal.endswith(_RAISED_WHEN_UNREAD)
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


def qa_verdict_recheck(state: dict, events: list[dict], signal_name: str) -> list[dict]:
    """The durable QA-verdict recheck entries (#5052) as `qa-verdict` event dicts,
    ascending by PR, deduplicated by PR, for every PR NOT already named by a
    session `qa-verdict` event in `events` (the event wins). Each entry is the
    `qa-verdict-event.sh` shape {type, pr_number, tier, verdict, verdict_sha,
    head_sha, verdict_at_head}. Malformed entries are dropped (fail-closed: no entry, no merge);
    never raises. Snapshot-only: a `signal` event cannot inject a recheck."""
    raw = _state_signal(state, signal_name)
    if not isinstance(raw, list):
        return []
    named = {
        ev.get("pr_number")
        for ev in events
        if isinstance(ev, dict) and ev.get("type") == "qa-verdict" and ev.get("pr_number") is not None
    }
    out: dict[int, dict] = {}
    for entry in raw:
        if not _valid_recheck_entry(entry) or entry["pr"] in named:
            continue
        out[entry["pr"]] = {
            "type": "qa-verdict",
            "pr_number": entry["pr"],
            "tier": entry["tier"],
            "verdict": entry["verdict"],
            "verdict_sha": entry["verdict_sha"],
            "head_sha": entry["head_sha"],
            "verdict_at_head": entry["verdict_at_head"],
            "recheck": True,
        }
    return [out[k] for k in sorted(out)]


def blob(state: dict, name: str) -> Any:
    """A data-plane blob decide.py normalises itself (usage eligibility, emergency
    brake, Target risk surface, class stats, candidate exclusions). The snapshot's value; ABSENT there means it
    did not parse this turn, so the previous value `apply` left on state is kept.
    A name outside {@link BLOB_FIELDS} raises in replay mode."""
    if not isinstance(state, dict):
        return None
    if name not in _KNOWN_BLOBS and _replay_mode():
        raise UnknownSignalError(f"{REPLAY_ENV} is set and {name!r} is not a Turn Snapshot blob")
    snap = snapshot(state)
    blobs = snap.get("blobs") if isinstance(snap.get("blobs"), dict) else {}
    if name in blobs:
        return blobs[name]
    return state.get(name)


def usage_eligibility(state: dict) -> dict:
    """The usage-eligibility body as a dict ({} when absent or not an object) —
    render-dispatch.py / turn.sh's summary read it here."""
    value = blob(state, "usage_eligibility")
    return value if isinstance(value, dict) else {}


# ---------------------------------------------------------------------------
# Degradation + the recheck entry shape (reader-level, like the pin parser)
# ---------------------------------------------------------------------------


def degraded(state: dict, collectors: tuple[str, ...] = (), fields: tuple[str, ...] = ()) -> bool:
    """True when the turn's snapshot carries a degraded marker from one of
    `collectors`, or for one of `fields` — or is wholly degraded (field `*`:
    the all-degraded document or the marker). Lets a policy fail CLOSED on a
    value read from a degraded collector instead of trusting its partial
    count. Never raises."""
    for m in snapshot(state).get("degraded") or []:
        if not isinstance(m, dict):
            continue
        if m.get("field") == "*" or m.get("collector") in collectors or m.get("field") in fields:
            return True
    return False


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _valid_recheck_entry(e: Any) -> bool:
    """One recheck entry the reader can turn into a `qa-verdict` event (#5052
    INV-3/INV-7: a malformed entry fails closed — no entry, no merge)."""
    return (
        isinstance(e, dict)
        and set(e) == {"pr", "tier", "verdict", "verdict_sha", "head_sha", "verdict_at_head"}
        and _is_int(e["pr"]) and e["pr"] > 0
        and _is_int(e["tier"]) and 1 <= e["tier"] <= 4
        and isinstance(e["verdict"], str) and e["verdict"] != ""
        and isinstance(e["verdict_sha"], str)
        and isinstance(e["head_sha"], str)
        and isinstance(e["verdict_at_head"], bool)
    )


# ---------------------------------------------------------------------------
# apply — store-only
# ---------------------------------------------------------------------------


def apply(snap: Any, state: dict, unreadable_reason: str | None = None) -> dict:
    """Store this turn's Turn Snapshot on `state` as emitted — or the marker
    document when `snap` is not a JSON object (nothing could be read) — and
    hoist its blob fields and the slot events onto state.
    Mutates and returns `state`; never touches `turn`."""
    if isinstance(snap, dict):
        doc = snap
    else:
        doc = marker_document(unreadable_reason or f"not a JSON object ({type(snap).__name__})")
    state["turn_snapshot"] = doc
    blobs = doc.get("blobs") if isinstance(doc.get("blobs"), dict) else {}
    for field in BLOB_FIELDS:
        if field in blobs:
            state[field] = blobs[field]
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
            # parser — as unreadable as non-JSON, so it takes the same marker.
            reason = f"unreadable: {type(exc).__name__}: {exc}"[:300]
        if reason is None and not isinstance(snap, dict):
            reason = f"not a JSON object ({type(snap).__name__})"
        if reason is not None:
            print(f"[turn_snapshot] {snap_path} is not a readable Turn Snapshot ({reason}) — storing the marker document (every signal reads degraded)", file=sys.stderr)

    try:
        apply(snap if reason is None else None, state, reason)
        text_out = json.dumps(state, indent=1)
    except (RecursionError, ValueError, TypeError) as exc:
        # A parseable but pathologically nested value (a blob, typically) can
        # still overflow the serialiser: re-read the state and store the
        # marker document instead of failing the turn.
        reason = f"unserialisable: {type(exc).__name__}: {exc}"[:300]
        print(f"[turn_snapshot] {snap_path} could not be applied ({reason}) — storing the marker document", file=sys.stderr)
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
    signals = doc.get("signals")
    degraded_markers = doc.get("degraded")
    print(
        json.dumps(
            {
                "form": "json" if reason is None else "marker",
                "signals_keys": len(signals) if isinstance(signals, dict) else 0,
                "degraded": len(degraded_markers) if isinstance(degraded_markers, list) else 0,
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
