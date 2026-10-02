"""decide_selectors.design_qa — design_qa_target signal-class selector (issue #4511).

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

# Per-run cap on how many design-QA findings the visual-review pass may file
# (issue #2739, parent #2732): "file AT MOST 3 deduped needs-triage items per
# run". Threaded into `prompt_args.max_items` on every design_qa_target
# dispatch so the cap is machine-enforceable at the dispatch seam, not
# prose-only — the same discipline as WIRE_OR_RETIRE_MAX_ITEMS above.
DESIGN_QA_TARGET_MAX_ITEMS = 3


def _select_signal_design_qa_target(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`design_qa_target` signal-class selector (provenance: #2739, #2732, #2720, #2575, #1093, #1078)."""
    # Issue #2739 (parent #2732, the Target UI-quality loop). Periodic
    # VISUAL QA of the Target UI: dispatches the headless /hydra-design-qa
    # skill (which seam-resolves the Target workspace itself, #4528) to
    # capture the slice-1 screenshot set of every nav-registry route, judge
    # each page against the Target's design-language ADR (convention glob
    # docs/adr/*design-language*.md under that seam-resolved Target
    # workspace — density budget, clutter, consistency), and file AT MOST 3
    # deduped needs-triage Target-backlog items per run, each citing the
    # specific ADR rule violated plus screenshot evidence.
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
    # class). collect-state.sh emits `design_qa_target_due` true only when
    # ALL THREE hold: the Target board read succeeded AND the board is not
    # saturated AND at least one file matches the design-language ADR
    # convention glob (docs/adr/*design-language*.md) under the seam-resolved
    # Target workspace (#4528: a post-swap Target with no design ADR
    # otherwise pays a ~50k-token no-op dispatch every 7d with nothing to
    # grade). An unresolved workspace or zero glob matches fails closed —
    # due=false, the class stays dormant, never dispatching on a guessed
    # Target. collect-state.sh also emits an advisory adr-present
    # observability key on every branch (so a dormant class stays visible,
    # not silently zero) that is read by NOBODY here: decide.py deliberately
    # never reads it — the selector below reads exactly two signals,
    # `design_qa_target_saturated` FIRST, then `design_qa_target_due`
    # (pinned by test/autopilot-target-board-signals.test.mts, which fails
    # if this file so much as mentions the advisory key's literal name).
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
