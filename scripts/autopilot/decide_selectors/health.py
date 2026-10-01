"""decide_selectors.health — health signal-class selector (issue #4511).

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


def _select_signal_health(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`health` signal-class selector (no issue provenance cited)."""
    if _signal_present(state, events, "health_fail"):
        return make_dispatch(sig, "hydra-doctor", reason="health probe failed")
    return None
