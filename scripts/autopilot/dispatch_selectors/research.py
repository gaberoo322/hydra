"""`dispatch_selectors.research` — pipeline-slot selectors for research_orch / research_target.

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


def _select_slot_research_orch(
    cls: str,
    state: dict,
    candidates: dict | None,
    events: list[dict],
    best: dict | None,
    best_score: float,
    now: int,
) -> dict | None:
    """`research_orch` pipeline-slot selector (provenance: #458)."""
    # ISSUE #458: the candidate-driven force-research trigger moved to
    # research_target (the candidates feed is target-product work). The
    # orchestrator-side research force lives in the explicit
    # `needs_research` signal — that's the only path that fires
    # research_orch now. The daily cap still applies if the signal
    # repeatedly fires within a day.
    if _signal_present(state, events, "needs_research"):
        return make_dispatch(cls, "hydra-issue-research", reason="explicit needs-research signal")
    return None

def _select_slot_research_target(
    cls: str,
    state: dict,
    candidates: dict | None,
    events: list[dict],
    best: dict | None,
    best_score: float,
    now: int,
) -> dict | None:
    """`research_target` pipeline-slot selector (provenance: #3832, #3455, #3435, #3432)."""
    # Two triggers, both board-derived: (a) explicit target_research_due
    # signal, or (b) target_board_research_due — the ADR-0031 board-empty
    # signal collect-state.sh sets when target_ready_for_agent == 0.
    #
    # ISSUE #3832: the retired candidate-feed forced-research branch that
    # used to live here (`candidates is not None and
    # research_recommended(candidates)`) was REMOVED.
    # /api/anchor/candidates was RETIRED in #3455, so the feed is
    # permanently empty and research_recommended()'s fail-open default
    # (`if not candidates_payload: return True` fires for a `{}` payload)
    # forced research_target on every turn until the INV-010 daily cap
    # tripped — self-refuting churn (~181k tokens/cycle) that re-fired on
    # completion and masked this very board signal. research_recommended()
    # and best_candidate() are RETAINED (still read by the dev_target steer
    # slot above), and the INV-010 daily-force-cap machinery
    # (_research_force_allowed / _research_force_stamp /
    # RESEARCH_FORCE_DAILY_CAP) is intentionally left in place even though
    # it is now caller-less from this selector — its removal is
    # Verifier-Core-adjacent and out of scope for #3832.
    if _signal_present(state, events, "target_research_due"):
        return make_dispatch(cls, "hydra-target-research", reason="target research due")
    # GITHUB-BOARD BRANCH (issue #3435, spec #3432, ADR-0031). Orch-style
    # Target dispatch: an EMPTY scope=target board (no ready-for-agent,
    # unblocked issues) means the Target product needs more research
    # direction. collect-state.sh sets `target_board_research_due` when
    # `target_ready_for_agent == 0`. This is a plain board-empty signal, so
    # it is NOT subject to the daily force cap — it fires no more often
    # than the pace-gated turn cadence and its class cooldown allow,
    # mirroring how `dev_target`/`qa_target` read their board signals
    # directly.
    if _signal_present(state, events, "target_board_research_due"):
        return make_dispatch(
            cls,
            "hydra-target-research",
            reason="target GitHub board empty of ready-for-agent work",
        )
    return None
