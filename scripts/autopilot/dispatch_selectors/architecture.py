"""`dispatch_selectors.architecture` — signal-class selector for architecture_orch.

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
    _orch_backfill_idle_present,
    _signal_present,
    make_dispatch,
)


def _select_signal_architecture_orch(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`architecture_orch` signal-class selector (provenance: #790, #787, #959, #958, #788, #789, #4391, #4114)."""
    # Issue #790 (parent #787); unified by #959 (epic #958). Board-idle
    # backfill: when the orchestrator board has gone idle (collect-state.sh
    # emits the unified `orch_backfill_idle` signal), reclaim spare capacity
    # by dispatching the headless /hydra-architecture-scan wrapper (#788) to
    # surface architecture-deepening candidates as tracked issues.
    #
    # arch_board_saturated is the anti-feedback-loop guard: once the board
    # already holds enough proposal-grade architecture work (N=5-10 cap,
    # owned by collect-state.sh #789), the scan suppresses itself. It is
    # checked FIRST — before the cooldown (via signal_is_cooled above) and
    # before the one-per-turn stagger guard in _rule_signals — mirroring
    # scout_orch's scout_board_saturated early-return. At the new 1h cadence
    # (#959) this cap matters MORE: it is the PRIMARY suppressor, the 1h
    # class cooldown only the back-stop. The stagger MUST NOT bypass it.
    #
    # decide.py reads the precomputed signals only — it never recomputes
    # board-empty / cooldown here; that round-trip is exactly the gate-
    # re-parsing failure mode the signal seam exists to prevent.
    if _signal_present(state, events, "arch_board_saturated"):
        return None
    # Issue #4391: the second anti-feedback-loop guard for the idle path.
    # arch-scan parks its Worth-exploring / Untouchable-Core candidates
    # straight into `hitl-grill`, and its Strong→needs-triage output is
    # relabelled there downstream by the 2026-08-19 admission rule — so a
    # saturated operator inbox means every dispatch parks into a lane the
    # system cannot drain, the guaranteed-no-op this cap exists to stop.
    # Unlike discover_orch there is NO staleness floor here (#4114 INV-3
    # deferred the sibling floors), so this suppressor is total while the
    # inbox is full: the operator draining it below the cap is the
    # release, and the emitted `hitl_grill_open` count keeps the reason
    # observable. Absent signal → unchanged behaviour (INV-6).
    if _signal_present(state, events, "hitl_grill_saturated"):
        return None
    if _orch_backfill_idle_present(state, events):
        return make_dispatch(
            sig,
            "hydra-architecture-scan",
            reason="orch board idle — architecture backfill",
        )
    return None
