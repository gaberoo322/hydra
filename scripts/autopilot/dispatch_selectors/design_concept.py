"""`dispatch_selectors.design_concept` — pipeline-slot selector for design_concept_orch.

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
    _orch_anchor_signal,
    make_dispatch,
)


def _select_slot_design_concept_orch(
    cls: str,
    state: dict,
    candidates: dict | None,
    events: list[dict],
    best: dict | None,
    best_score: float,
    now: int,
) -> dict | None:
    """`design_concept_orch` pipeline-slot selector (provenance: #466, #437, #628, #458, #751, #3870, #3754, #3711)."""
    # ISSUE #466 (Phase B of #437): fire `hydra-grill` for the top
    # orch candidate when it has work pending AND no fresh artifact.
    # The selector is intentionally additive to Phase A:
    #
    # - When the artifact is missing OR stale, dispatch
    #   `hydra-grill` with the anchorRef and scope='orch'. The
    #   pipeline_priority ordering (design_concept_orch BEFORE
    #   dev_orch) means dev_orch's own selector also returns None for
    #   this turn, so we don't double-fire on the same anchor.
    # - When the artifact is fresh (even warn-only), this selector
    #   returns None — Phase B treats warn-only artifacts as "fresh"
    #   so dev_orch proceeds in the same plan. Phase C will tighten
    #   to gateOk-only.
    #
    # ISSUE #628 — TWO INPUT PATHS:
    #
    #   1. `state.signals.orch_pending_grill_anchor` (preferred). A
    #      string anchorRef set by `collect-state.sh` from the orch
    #      GH `ready-for-agent` board. This is the orch-scope feed
    #      the selector was missing — `best` in /api/anchor/candidates
    #      is structurally a target-product candidate post-#458, so
    #      reading `best.designConcept` (the pre-#628 path) never
    #      fired on orch work. The collect-state loop already does
    #      the artifact-freshness lookup, so the presence of this
    #      signal IS the trigger.
    #
    #   2. `best.designConcept` (legacy fallback) — REMOVED in issue
    #      #751. The fallback read `best` from /api/anchor/candidates,
    #      which post-#458 is structurally target-product work
    #      (item-<N>). Under scope='orch' it could ONLY misfire:
    #      grilling a target candidate as an orch design concept,
    #      burning a subagent and persisting a cross-scope artifact.
    #      The candidate feed and the orch GH board are distinct
    #      sources, so the fallback's stated trigger ("orch candidate
    #      showed up in best") was structurally impossible post-#458.
    #      `orch_pending_grill_anchor` (path 1) is now the SINGLE
    #      source of truth for orch grill anchors. When it is absent
    #      or 'none', this selector returns None (no grill) and
    #      dev_orch proceeds.
    #
    # ISSUE #3870: the `orch_work_available` precondition that used to
    # gate this selector (mirroring dev_orch's own gate) was REMOVED.
    # `orch_work_available` is dev_orch's authoring-pool signal —
    # `ready_for_agent > 0` in collect-state.sh — and under a live GLM
    # dev-drainer partition (#3754) it EXCLUDES every `glm-eligible`
    # issue, because a live drainer authors those on its own z.ai quota
    # and counting them would dispatch a second Claude author onto the
    # same work. But `design_concept_orch` doesn't author anything — it
    # only produces a design-concept artifact, which a glm-eligible issue
    # still needs regardless of who eventually builds it
    # (`src/autopilot/board-state.ts`'s `deriveBoardState` doc: "still
    # designs every glm-eligible issue"). Reusing dev_orch's pool-sizing
    # signal as this selector's trigger accidentally coupled *designing*
    # to *building*: with the partition live, `orch_work_available` could
    # be absent (0 non-glm ready-for-agent issues) while
    # `orch_pending_grill_anchor` was correctly set to a glm-eligible
    # anchor awaiting a design concept — and that anchor sat unfired
    # (observed: `orch_pending_grill_anchor=issue-3785` across turns 2-3
    # of run 2bcba309). `orch_pending_grill_anchor` alone is already a
    # strict, sufficient trigger: collect-state.sh's `ORCH_GRILL_PICK`
    # loop only ever sets it to a real ready-for-agent, non-target-backlog
    # issue lacking a fresh artifact (see the normalisation below), so
    # dropping the redundant precondition does not risk firing on an
    # empty board — it only stops a glm-eligible anchor from being
    # discarded one line before it would have been used. dev_orch's own
    # `orch_work_available` gate (above, in the `cls == "dev_orch"`
    # branch) is UNCHANGED — this selector's fix does not touch it.

    # Same normalisation as the dev_orch gate above — one home for the
    # absent/"none"/malformed collapse (issue #3711).
    signals = state.get("signals") if isinstance(state, dict) else None
    orch_anchor = _orch_anchor_signal(signals, "orch_pending_grill_anchor")
    if orch_anchor is not None:
        return make_dispatch(
            cls,
            "hydra-grill",
            prompt_args={"scope": "orch", "anchor": orch_anchor},
            reason=(
                "orch GH ready-for-agent issue lacks fresh design-concept artifact "
                "(Phase B warn-only, #628 orch-scope path)"
            ),
        )

    # No orch grill-pending anchor on the GH board → no orch grill.
    # (Issue #751: the legacy `best.designConcept` fallback was removed
    # because /api/anchor/candidates is target-product work, never an
    # orch-scope grill anchor.)
    return None
