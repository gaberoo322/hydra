#!/usr/bin/env python3
"""
merge-signals.py — the Signal wiring table as code (issue #4829).

Phase 1 of /hydra-autopilot runs `collect-state.sh`, which emits one
`key=value` line per raw signal plus a few JSON blobs. decide.py never reads
those lines: it reads `state.signals` (booleans, verbatim strings, optional
anchor refs) and a handful of verbatim-merged top-level state fields. The hop
between the two was the "Signal wiring (state.signals)" table (now the
hydra-autopilot-signal-wiring.md sidecar, issue #4837) — a
TABLE, executed by the autopilot session itself each turn. No script did it,
so every unattended session either wrote a merge helper from scratch or reused
an untracked copy, and nothing kept that copy in step with the table
(the #4342 defect class, re-opened one hop downstream).

This script is that hop. `SIGNAL_RULES` below IS the table: one `Rule` per
promoted `state.signals` key, in table order. The parity check
(`scripts/ci/signal-parity-check.ts`, leg L4) reads the `Rule("<key>", …)`
literals and fails the required test job when a table row has no rule here
or a rule here has no table row — so a wiring row can no longer land without
the code that promotes it.

Contract
--------
  python3 scripts/autopilot/merge-signals.py <collect-output | -> [state.json]

  * `state.signals` is REPLACED wholesale — never deep-merged. Run 9ede5aef
    deep-merged and carried `orch_pending_grill_anchor` one turn past the
    grill that cleared it, re-dispatching design_concept_orch on a grill-clear
    anchor. A key absent from this turn's collect output is absent from
    `state.signals` afterwards.
  * `state.turn` is never written (the decide.py CLI owns it, issue #1769);
    nothing outside the fields named in `BLOB_FIELDS` / `TOP_LEVEL_FIELDS` and
    `signals` is touched.
  * Writes go through a sibling temp file + `os.replace`, the same atomic
    write-back decide.py uses.
  * A line that is neither `key=value` nor the board-state JSON line is
    ignored. A JSON blob that fails to parse leaves the PREVIOUS value of its
    state field in place and prints one stderr line — except `slot_events`,
    which is per-turn consumption: an unreadable blob yields `[]` (replaying
    last turn's events would double-count completions) and leaves
    `slot_events_last_id` untouched.
  * Exit 0 on success; 1 when the state file cannot be read or parsed; 2 on
    bad arguments. The one stdout line is a JSON summary for the turn log.

Default state path: `$HYDRA_AUTOPILOT_STATE`, else
`/tmp/hydra-autopilot-state.json` (the heartbeat.py / term-check.py idiom).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Callable

DEFAULT_STATE_PATH = os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json")

# Sentinel a derivation returns to leave its key OUT of state.signals (the
# "none → omit" convention for the optional anchor refs: decide.py treats an
# absent key, an empty string and the literal "none" alike, but the table says
# omit, so omit).
OMIT = object()

KV_LINE = re.compile(r"^([a-z][a-z0-9_]*)=(.*)$")
BOARD_LINE_PREFIX = '{"needs_qa"'


# ---------------------------------------------------------------------------
# Derivations — each returns a value for state.signals, or OMIT
# ---------------------------------------------------------------------------

Derive = Callable[[dict[str, str], dict], object]


def _int(raw: str | None, default: int = 0) -> int:
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return default


def count(key: str) -> Derive:
    """Integer count, verbatim (non-numeric → 0)."""
    return lambda kv, board: _int(kv.get(key))


def count_gt0(key: str) -> Derive:
    """`<key> > 0` from the key=value stream."""
    return lambda kv, board: _int(kv.get(key)) > 0


def count_eq0(key: str) -> Derive:
    """`<key> == 0` from the key=value stream (the board-empty shape)."""
    return lambda kv, board: _int(kv.get(key)) == 0


def count_gt(key: str, cap: int) -> Derive:
    """`<key> > cap` — a saturation cap applied here, not in collect-state."""
    return lambda kv, board: _int(kv.get(key)) > cap


def board_gt0(field: str) -> Derive:
    """`<field> > 0` from the board-state JSON line (the orch board counts)."""
    return lambda kv, board: _int(board.get(field)) > 0


def flag(key: str) -> Derive:
    """A `true`/`false` literal collect-state already resolved (absent → false)."""
    return lambda kv, board: (kv.get(key) or "").strip().lower() == "true"


def text(key: str, default: str = "") -> Derive:
    """A string merged verbatim (absent → default)."""
    return lambda kv, board: kv.get(key, default)


def ref(key: str) -> Derive:
    """An optional `issue-N`-shaped ref: `none`, empty or absent → OMIT the key."""

    def derive(kv: dict[str, str], board: dict) -> object:
        value = (kv.get(key) or "").strip()
        return value if value and value != "none" else OMIT

    return derive


def stale_days(key: str, days: int) -> Derive:
    """True when the ISO-8601 instant is older than `days`, empty, or unparseable."""

    def derive(kv: dict[str, str], board: dict) -> object:
        raw = (kv.get(key) or "").strip()
        if not raw:
            return True
        try:
            then = datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return True
        return (time.time() - then) > days * 86400

    return derive


def health_fail(key: str) -> Derive:
    """`health=FAIL` (any first token other than `ok`) OR `failed_services > 0`.

    collect-state prints `health=<status> redis=<bool>` on a readable health
    endpoint and the bare `health=FAIL` otherwise. An ABSENT health line reads
    as not-failed (the collector did not run; dispatching hydra-doctor on a
    missing line would spend a dispatch on nothing it can diagnose).
    """

    def derive(kv: dict[str, str], board: dict) -> object:
        status = (kv.get(key) or "ok").split()
        return (status[0] if status else "ok") != "ok" or _int(kv.get("failed_services")) > 0

    return derive


@dataclass(frozen=True)
class Rule:
    """One promoted `state.signals` key and how it is derived."""

    key: str
    derive: Derive


# ---------------------------------------------------------------------------
# THE TABLE. One Rule per promoted state.signals key, in the order the
# "Signal wiring (state.signals)" table (hydra-autopilot-signal-wiring.md sidecar) lists them. The parity
# check's L4 leg reads the `Rule("<key>"` literals below — keep one Rule per
# line, key first, so the extractor stays trivial.
# ---------------------------------------------------------------------------

SIGNAL_RULES: tuple[Rule, ...] = (
    # orch board (board-state JSON line)
    Rule("orch_work_available", board_gt0("ready_for_agent")),
    Rule("needs_qa_orch", board_gt0("needs_qa")),
    Rule("needs_research", board_gt0("needs_research")),
    Rule("needs_triage_orch", board_gt0("needs_triage")),
    Rule("needs_qa_numbers", text("needs_qa_numbers")),
    Rule("orch_needs_triage_items", text("orch_needs_triage_items")),
    Rule("untriaged_orphans_orch", count_gt0("untriaged_orphans")),
    # target lane
    Rule("target_work_available", count_gt0("work_queue")),
    Rule("target_board_work_available", count_gt0("target_ready_for_agent")),
    Rule("target_board_research_due", count_eq0("target_ready_for_agent")),
    Rule("target_wip_saturated", flag("target_wip_saturated")),
    Rule("needs_qa_target", count_gt0("target_needs_qa")),
    Rule("target_needs_qa_pr_ref", text("target_needs_qa_pr_ref")),
    Rule("target_needs_qa_pr_head", text("target_needs_qa_pr_head")),
    Rule("target_dev_resume_pick", ref("target_dev_resume_pick")),
    Rule("needs_triage_target", count_gt0("target_needs_triage")),
    Rule("target_needs_triage_items", text("target_needs_triage_items")),
    # health / scout
    Rule("health_fail", health_fail("health")),
    Rule("scout_walk_due", stale_days("scout_last_walk_iso", 7)),
    Rule("scout_board_saturated", count_gt("scout_board_open_enhancements", 20)),
    Rule("scout_alert_eligible_count", count("scout_alert_eligible_count")),
    # backfill producers and their saturation caps
    Rule("orch_backfill_idle", flag("orch_backfill_idle")),
    Rule("arch_board_saturated", flag("arch_board_saturated")),
    Rule("hitl_grill_open", count("hitl_grill_open")),
    Rule("hitl_grill_saturated", flag("hitl_grill_saturated")),
    Rule("orch_board_signals_degraded", flag("orch_board_signals_degraded")),
    Rule("cleanup_board_saturated", flag("cleanup_board_saturated")),
    Rule("skill_prune_board_saturated", flag("skill_prune_board_saturated")),
    Rule("target_backfill_idle", flag("target_backfill_idle")),
    Rule("target_cleanup_board_saturated", flag("target_cleanup_board_saturated")),
    Rule("wire_or_retire_target_available", flag("wire_or_retire_target_available")),
    Rule("design_qa_target_due", flag("design_qa_target_due")),
    Rule("design_qa_target_saturated", flag("design_qa_target_saturated")),
    Rule("retro_run_available", flag("retro_run_available")),
    Rule("retro_run_drillable", flag("retro_run_drillable")),
    # PR gate (issue #4240) and the GLM / resume picks
    Rule("orch_prs_dirty", text("orch_prs_dirty")),
    Rule("orch_prs_unchecked", text("orch_prs_unchecked")),
    Rule("orch_prs_behind", text("orch_prs_behind")),
    Rule("orch_ci_trigger_stale", flag("orch_ci_trigger_stale")),
    Rule("orch_prs_glm_red", text("orch_prs_glm_red")),
    Rule("orch_glm_red_forward_fix", ref("orch_glm_red_forward_fix")),
    Rule("orch_dev_resume_pick", ref("orch_dev_resume_pick")),
    Rule("orch_dirty_forward_fix", ref("orch_dirty_forward_fix")),
    Rule("orch_prs_dirty_surface", text("orch_prs_dirty_surface")),
    # grill gate (issue #628 / #3711 / #3798)
    Rule("orch_pending_grill_anchor", ref("orch_pending_grill_anchor")),
    Rule("orch_dev_ready_anchor", ref("orch_dev_ready_anchor")),
    # wayfinder / tickets stages (ADR-0029, ADR-0030)
    Rule("wayfinder_orch_frontier", ref("wayfinder_orch_frontier")),
    Rule("wayfinder_orch_ticket_type", text("wayfinder_orch_ticket_type")),
    Rule("wayfinder_orch_inflight_global", text("wayfinder_orch_inflight_global", "0")),
    Rule("tickets_available", flag("tickets_available")),
    Rule("tickets_orch_pending_spec", ref("tickets_orch_pending_spec")),
    # budget
    Rule("orch_realm_weekly_share", text("orch_realm_weekly_share", "unavailable")),
)

# JSON blobs merged VERBATIM onto top-level state fields (the table's
# `state.<field> (object, merged verbatim)` rows). `slot_events_json` is
# handled separately below (it unwraps to two fields).
BLOB_FIELDS: tuple[tuple[str, str], ...] = (
    ("usage_eligibility_json", "usage_eligibility"),
    ("emergency_brake_json", "emergency_brake"),
    ("target_risk_surface_json", "target_risk_surface"),
    ("class_stats_json", "class_stats"),
    ("candidate_exclusions_json", "candidate_exclusions"),
)

# Scalars the table says decide.py reads "directly from state" that
# collect-state does emit. (`dev_target_spend_usd_cycle` has no emitter and is
# left to whatever already sits on state.)
TOP_LEVEL_FIELDS: tuple[tuple[str, str], ...] = (("scout_spend_usd_today", "scout_spend_usd_today"),)

SLOT_EVENTS_BLOB = "slot_events_json"


# ---------------------------------------------------------------------------
# Pure core
# ---------------------------------------------------------------------------


def parse_collect_output(text_out: str) -> tuple[dict[str, str], dict]:
    """Split collect-state output into the key=value map and the board-state
    JSON object. Only the FIRST board line counts; every other non-kv line is
    ignored (collect-state prints a few bare status tokens, e.g. CODEX_IDLE).
    """
    kv: dict[str, str] = {}
    board: dict = {}
    for line in text_out.splitlines():
        if not board and line.startswith(BOARD_LINE_PREFIX):
            try:
                parsed = json.loads(line)
            except ValueError as exc:
                print(f"[merge-signals] board-state line unparseable, orch board counts read as 0: {exc}", file=sys.stderr)
                continue
            if isinstance(parsed, dict):
                board = parsed
            continue
        m = KV_LINE.match(line)
        if m:
            kv[m.group(1)] = m.group(2)
    return kv, board


def derive_signals(kv: dict[str, str], board: dict) -> dict:
    """Apply every Rule; OMIT drops the key."""
    signals: dict = {}
    for rule in SIGNAL_RULES:
        value = rule.derive(kv, board)
        if value is not OMIT:
            signals[rule.key] = value
    return signals


def _parse_blob(kv: dict[str, str], key: str) -> tuple[bool, object]:
    """(present-and-parsed, value). Absent/empty → (False, None); unparseable →
    (False, None) after one stderr line."""
    raw = kv.get(key)
    if raw is None or raw == "":
        return False, None
    try:
        return True, json.loads(raw)
    except ValueError as exc:
        print(f"[merge-signals] {key} unparseable, previous state value kept: {exc}", file=sys.stderr)
        return False, None


def merge(collect_text: str, state: dict) -> dict:
    """Return `state` with signals + blobs refreshed from one collect-state
    output. Mutates and returns the same dict; never touches `turn`."""
    kv, board = parse_collect_output(collect_text)
    state["signals"] = derive_signals(kv, board)

    for blob_key, field in BLOB_FIELDS:
        ok, value = _parse_blob(kv, blob_key)
        if ok:
            state[field] = value

    for kv_key, field in TOP_LEVEL_FIELDS:
        raw = kv.get(kv_key)
        if raw is not None and raw != "":
            try:
                state[field] = float(raw)
            except ValueError:
                print(f"[merge-signals] {kv_key}={raw!r} is not a number, previous state value kept", file=sys.stderr)

    ok, events = _parse_blob(kv, SLOT_EVENTS_BLOB)
    if ok and isinstance(events, dict):
        rows = events.get("events")
        state["slot_events"] = rows if isinstance(rows, list) else []
        if events.get("last_id"):
            state["slot_events_last_id"] = events["last_id"]
    elif ok and isinstance(events, list):
        state["slot_events"] = events
    else:
        # Absent or unreadable: no events THIS turn. Replaying the previous
        # list would double-count completions, so the per-turn field resets.
        state["slot_events"] = []
    return state


def summary(state: dict) -> dict:
    eligibility = state.get("usage_eligibility")
    return {
        "signals_keys": len(state.get("signals") or {}),
        "slot_events": len(state.get("slot_events") or []),
        "slot_events_last_id": state.get("slot_events_last_id"),
        "allow": eligibility.get("allow") if isinstance(eligibility, dict) else None,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    if len(argv) < 2 or len(argv) > 3 or argv[1] in ("-h", "--help"):
        print("usage: merge-signals.py <collect-output-file | -> [state.json]", file=sys.stderr)
        return 2
    collect_path = argv[1]
    state_path = argv[2] if len(argv) == 3 else DEFAULT_STATE_PATH
    try:
        collect_text = sys.stdin.read() if collect_path == "-" else open(collect_path, encoding="utf-8").read()
    except OSError as exc:
        print(f"[merge-signals] cannot read collect output {collect_path}: {exc}", file=sys.stderr)
        return 2
    try:
        with open(state_path, encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"[merge-signals] cannot read state {state_path}: {exc}", file=sys.stderr)
        return 1
    if not isinstance(state, dict):
        print(f"[merge-signals] state {state_path} is not a JSON object", file=sys.stderr)
        return 1

    merge(collect_text, state)

    tmp = f"{state_path}.merge-signals.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=1)
        fh.write("\n")
    os.replace(tmp, state_path)
    print(json.dumps(summary(state)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
