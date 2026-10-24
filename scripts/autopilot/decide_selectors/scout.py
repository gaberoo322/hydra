"""decide_selectors.scout — scout_orch signal-class selector (issue #4511).

Layer 2 of 3 of the decision brain. Imports the standard library and
decide_base only — never `decide`, never another decide_selectors module.
decide.py binds the handler below by name into `_SIGNAL_SELECTORS`.
Every definition here moved verbatim from decide.py.
"""

from __future__ import annotations

from decide_base import (
    _signal_present,
    make_dispatch,
)


def _select_signal_scout_orch(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`scout_orch` signal-class selector (provenance: #485, #483, #486, #5054)."""
    # Issue #485 (Phase B of /hydra-tool-scout, parent #483). Calendar-
    # driven path: fires when the weekly walk is due AND the orchestrator
    # board isn't already saturated with proposal-grade work — the
    # playbook prose pins the `>20 open enhancement issues` ceiling
    # (see hydra-tool-scout.md "When NOT to run this"). decide.py honors
    # it via the `scout_board_saturated` signal so the gate is checked
    # once at the Turn Snapshot time, not re-parsed here.
    #
    # The actual category/dep selection is in `src/scout/calendar-walk.ts`;
    # decide.py only emits the dispatch — the skill itself walks the
    # planner output and invokes one scout per eligible target.
    #
    # The Phase C alert-driven arm (#486) was retired in #5054: the
    # `pattern:*` alerts it consumed never had a producer (#5053).
    if _signal_present(state, events, "scout_board_saturated"):
        return None
    if _signal_present(state, events, "scout_walk_due"):
        return make_dispatch(
            sig,
            "hydra-tool-scout",
            prompt_args={"trigger": "calendar"},
            reason="weekly calendar walk due",
        )
    return None
