"""`dispatch_selectors.health` — signal-class selector for health.

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
