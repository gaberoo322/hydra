"""`dispatch_selectors.design_qa` — signal-class selector for design_qa_target.

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
    DESIGN_QA_TARGET_MAX_ITEMS,
    _signal_present,
    make_dispatch,
)


def _select_signal_design_qa_target(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`design_qa_target` signal-class selector (provenance: #2739, #2732, #2720, #2575, #1093, #1078)."""
    # Issue #2739 (parent #2732, the Target UI-quality loop). Periodic
    # VISUAL QA of the Target UI: dispatches the headless /hydra-design-qa
    # skill to capture the slice-1 screenshot set of every nav-registry
    # route on ~/hydra-betting/web, judge each page against the Target
    # design-language ADR (hydra-betting/docs/adr/0005-design-language.md —
    # density budget, clutter, consistency), and file AT MOST 3 deduped
    # needs-triage Target-backlog items per run, each citing the specific
    # ADR rule violated plus screenshot evidence.
    #
    # This is JUDGMENT work, so findings route needs-triage (NOT
    # ready-for-agent) — mirroring wire_or_retire_target's confidence-routing
    # discipline (epic #2720): an autonomous visual verdict is a candidate
    # for a human/triage pass, never a self-authorised code task.
    #
    # Calendar cadence like scout_orch: the 7d class cooldown
    # (SIGNAL_COOLDOWNS["design_qa_target"], honored by the shared
    # signal_is_cooled guard at the top of this function) is the primary
    # cadence control and is seeded in bootstrap.sh's signal_last_fired so it
    # survives the pace-gate relaunch (the #2575 cooldown-bootstrap bug
    # class). collect-state.sh emits `design_qa_target_due` true whenever the
    # Target board is reachable AND not saturated — there is always UI to
    # review, so the "due" predicate is just "board reachable + capacity".
    #
    # `design_qa_target_saturated` is the anti-flood cap, checked FIRST
    # (before the cooldown, exactly like cleanup_target /
    # target_cleanup_board_saturated): a board already holding >5 open
    # `design-qa`-labelled Target-backlog items suppresses the pass so a
    # healthy UI isn't re-reviewed into an ever-growing triage pile.
    #
    # The dispatch OMITS the model param (inherit the parent per #1093):
    # judgment work, and the Haiku-premature-exit failure mode is documented
    # — so no `model` key is passed here, mirroring the other judgment
    # classes (wire_or_retire_target).
    #
    # decide.py reads the precomputed signals only — it never captures
    # screenshots or reads the Target board here (the signal-seam
    # discipline). `apply: True` follows the #1078 retro_orch lesson: a
    # dry-run-default skill dispatched headlessly without it is a silent
    # no-op that files nothing. `max_items` threads the per-run cap so the
    # "≤3 findings" contract is machine-enforceable at the dispatch seam.
    if _signal_present(state, events, "design_qa_target_saturated"):
        return None
    if _signal_present(state, events, "design_qa_target_due"):
        return make_dispatch(
            sig,
            "hydra-design-qa",
            prompt_args={
                "apply": True,
                "max_items": DESIGN_QA_TARGET_MAX_ITEMS,
            },
            reason="target design-QA cadence due — screenshot review vs design ADR",
        )
    return None
