"""admission.py -- ONE dispatch-admission verdict (epic #5476, issue #5478).

Answers "may this class dispatch now, and if not, which gate refused" for the
six gates the pipeline and signal emitters share. PURE: every input is an
argument -- no module globals, no state lookups, no I/O -- so the verdict is a
table-testable function and each emitter keeps owning the reason text and the
`dispatch_decision` event it writes for a given gate code.

Gate order (the first failing gate is the verdict):
  usage hard stop, usage shed, slot busy, scope excluded, burned,
  orch-realm share.

Emitter-specific gates (cooldown, Target WIP, qa_target hold, wire_or_retire
risk, zero-yield, selectors, stagger, skip-sets) are NOT here; they stay in
their emitter. assert_invariants.py deliberately does NOT import this module
(it is the independent check on the plan this module helps build).

Stdlib + the taxonomy leaf only. Imports neither `decide` nor `decide_base`.
"""

from __future__ import annotations

import os
import sys
from typing import Collection, Iterable, Mapping, NamedTuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import taxonomy  # noqa: E402

GATE_USAGE_DISPATCH_BLOCKED = "usage_dispatch_blocked"
GATE_USAGE_SHED = "usage_shed"
GATE_SLOT_BUSY = "slot_busy"
GATE_SCOPE_EXCLUDED = "scope_excluded"
GATE_BURNED = "burned"
GATE_ORCH_REALM_SHARE_EXCEEDED = "orch_realm_share_exceeded"

# The closed set, in evaluation order.
GATE_ORDER = (
    GATE_USAGE_DISPATCH_BLOCKED,
    GATE_USAGE_SHED,
    GATE_SLOT_BUSY,
    GATE_SCOPE_EXCLUDED,
    GATE_BURNED,
    GATE_ORCH_REALM_SHARE_EXCEEDED,
)


class Verdict(NamedTuple):
    """`gate` is None when admitted, else one code from GATE_ORDER."""

    admitted: bool
    gate: str | None


ADMITTED = Verdict(True, None)


def admit(
    cls: str,
    *,
    dispatch_blocked: bool,
    shed_classes: Collection[str],
    slots: Mapping[str, object],
    freed_slots: Collection[str],
    scope: str,
    burned_classes: Collection[str],
    orch_share_exceeded: bool,
    rows: Iterable[dict],
) -> Verdict:
    """Return ADMITTED, or a refusal carrying the first failing gate code.

    `slots` maps class -> occupant (None / absent == free). A class whose slot
    is occupied is refused unless it is in `freed_slots` (slots the plan is
    already freeing). `rows` is the loaded taxonomy (scope source for both the
    scope mask and the orch-only share gate). `orch_share_exceeded` is the
    pre-computed orch-realm weekly-share verdict; it applies only to classes
    whose taxonomy scope is `orch`.
    """
    rows = list(rows)
    if dispatch_blocked:
        return Verdict(False, GATE_USAGE_DISPATCH_BLOCKED)
    if cls in shed_classes:
        return Verdict(False, GATE_USAGE_SHED)
    if slots.get(cls) is not None and cls not in freed_slots:
        return Verdict(False, GATE_SLOT_BUSY)
    if taxonomy.scope_excluded(scope, cls, rows):
        return Verdict(False, GATE_SCOPE_EXCLUDED)
    if cls in burned_classes:
        return Verdict(False, GATE_BURNED)
    if orch_share_exceeded and any(
        r["name"] == cls and r["scope"] == "orch" for r in rows
    ):
        return Verdict(False, GATE_ORCH_REALM_SHARE_EXCEEDED)
    return ADMITTED
