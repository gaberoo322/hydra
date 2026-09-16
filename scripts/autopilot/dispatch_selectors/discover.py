"""`dispatch_selectors.discover` — signal-class selectors for discover_orch / discover_target.

Split out of `decide.py` (issue #4511) so the file most agents touch for one
dispatch class is this small leaf, not the ~6,800-line monolith. `decide.py`
remains the single importable entry point and the single source of truth for
*what should happen* (ADR-0007): it still owns `_select_for_slot` /
`_select_for_signal`, builds `_SLOT_SELECTORS` / `_SIGNAL_SELECTORS` from
modules like this one, and is the only file these functions are dispatched
from. The `from decide import ...` below resolves against the *already
running* `decide`/`__main__` module (see the `sys.modules.setdefault` alias
near the top of decide.py) rather than re-executing the file — do not import
this module directly for side effects; it is only ever loaded by decide.py.
"""

from __future__ import annotations

from decide import (
    DISCOVER_STALENESS_FLOOR_SEC,
    _orch_backfill_idle_present,
    _signal_present,
    make_dispatch,
    signal_dark_past_floor,
)


def _select_signal_discover_orch(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`discover_orch` signal-class selector (provenance: #959, #958, #4114, #4391)."""
    # Issue #959 (epic #958): revived. discover_orch keyed off `orch_idle`,
    # a signal collect-state.sh never emitted, so the arm was DEAD. It now
    # reads the unified `orch_backfill_idle` board-empty signal — the same
    # one architecture_orch reads — making it a backfill-set class on the
    # 1h cadence. The one-per-turn stagger guard in _rule_signals ensures
    # discover_orch and architecture_orch don't both fire on the same idle
    # turn; round-robin emerges from the per-class 1h cooldowns.
    #
    # Issue #4114: the idle-only trigger proved structurally dark on a
    # healthy board — orch_backfill_idle requires FOUR board metrics at
    # zero simultaneously, and a continuously-stocked board keeps it false
    # for weeks (the producer went 3+ weeks at 0 dispatches; see
    # DISCOVER_STALENESS_FLOOR_SEC above). The selector now fires on
    # EITHER the idle signal OR the staleness floor. The reason strings
    # keep the two paths distinguishable in the dispatch_decision audit
    # trail (design-concept #4114 INV-4, mirroring signal_starved's
    # 'backfill starvation floor (>24h since last X)' annotation pattern).
    # architecture_orch / cleanup_orch deliberately keep idle-only gating
    # (INV-3 — the sibling extension is a deferred follow-up).
    #
    # Issue #4391: while the operator-admission inbox (`hitl-grill`,
    # cap 10 in collect-state.sh) is saturated, every orchestrator-defect
    # finding this producer files parks into a lane only the operator
    # can drain — an idle-board dispatch is a guaranteed ~70-130k-token
    # no-op (measured 2026-09-05..06: 21 producer dispatches / ~2.0M
    # tokens / 0 admissible output against a 58-open inbox). The guard
    # suppresses the IDLE path ONLY: the staleness floor below stays
    # ungated so discover_orch can never go structurally dark on a full
    # inbox (INV-2) — it still fires at most once per 7d, bounded by the
    # 1h class cooldown. Absent signal → identical behaviour to today
    # (presence-gated like every sibling *_board_saturated guard, INV-6).
    if _orch_backfill_idle_present(state, events) and not _signal_present(
        state, events, "hitl_grill_saturated"
    ):
        return make_dispatch(sig, "hydra-discover", reason="orch board idle — discovery backfill")
    if signal_dark_past_floor(state, sig, now, DISCOVER_STALENESS_FLOOR_SEC):
        return make_dispatch(
            sig,
            "hydra-discover",
            reason=(
                f"discover staleness floor (>{DISCOVER_STALENESS_FLOOR_SEC // (24 * 60 * 60)}d"
                " dark since last fire): producer class dark on a busy board"
            ),
        )
    return None

def _select_signal_discover_target(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`discover_target` signal-class selector (no issue provenance cited)."""
    if _signal_present(state, events, "target_idle"):
        return make_dispatch(sig, "hydra-target-discover", reason="target diagnostics due")
    return None
