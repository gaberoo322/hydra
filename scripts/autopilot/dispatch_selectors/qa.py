"""`dispatch_selectors.qa` — pipeline-slot selectors for qa_orch / qa_target.

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
    _bump_qa_orch_stall_tracker,
    _qa_orch_item_attempts,
    _qa_orch_item_eligible,
    _qa_orch_needs_qa_numbers,
    _signal_present,
    make_dispatch,
)


def _select_slot_qa_orch(
    cls: str,
    state: dict,
    candidates: dict | None,
    events: list[dict],
    best: dict | None,
    best_score: float,
    now: int,
) -> dict | None:
    """`qa_orch` pipeline-slot selector (provenance: #3829, #3729, #3709)."""
    if not _signal_present(state, events, "needs_qa_orch"):
        return None
    # Per-issue STALL CAP guard (issue #3829, design-concept issue-3829).
    # The coarse `needs_qa_orch` boolean above stays TRUE for as long as
    # ANY needs-qa issue sits on the board — including one that
    # structurally cannot reach a verdict (repeatable worktree loss, an
    # infra failure that reproduces every retry, etc.), which busy-loops
    # qa_orch at 30-65k tokens/turn with no bound. This is an ADDITIONAL,
    # independent, AND-composed condition (invariant 7: a healthy,
    # non-stalled backlog's dispatch path is unchanged until the cap is
    # actually hit).
    #
    # UNLIKE the #3729 sweep_target per-item guard (which tracks EVERY
    # current item), this tracks ONLY the HEAD of the needs-qa set —
    # `needs_qa_numbers[0]` — because hydra-qa self-selects via its own
    # unsorted-default `gh issue list --label needs-qa --jq '.[0]'` query,
    # so the head is deterministically the ONLY issue any given qa_orch
    # dispatch will actually review (invariant 4). Bumping every item in
    # the set (as a naive #3729-style port would) was considered and
    # rejected at design time: it would falsely accumulate attempts
    # against issues sitting further back in the queue that were never
    # actually reviewed, risking a false "stalled" verdict on a
    # healthy-but-queued issue the moment it becomes the new head.
    numbers = _qa_orch_needs_qa_numbers(state, events)
    if numbers:
        head = numbers[0]
        attempts = _qa_orch_item_attempts(state)
        if not _qa_orch_item_eligible(attempts.get(head, 0)):
            # The head issue has exhausted its attempt cap -> suppress
            # this turn. `needs_qa_orch` stays true (the raw label count
            # did not change); the pipeline rule surfaces this specific
            # reason instead of the generic "idle" one, and the stalled
            # issue number rides the dispatch_decision event + plan debug
            # for visibility (issue #3829 acceptance criterion: "becomes
            # visible ... rather than silently consuming budget";
            # design-concept invariant 1: a structured signal, never a GH
            # label mutation from this pure decision engine).
            state["qa_orch_stalled_issue"] = head
            return None
        state.pop("qa_orch_stalled_issue", None)
        # Bump ONLY the head's count. Rebuilding the tracker to hold just
        # this one (bumped) entry is what implements the prune contract
        # (invariant 5): a former head that is no longer the head this
        # turn (verdict reached, or superseded by a new head) is dropped,
        # so a later re-open under the same number starts fresh at 0.
        _bump_qa_orch_stall_tracker(state, head)
    # `numbers` absent/empty (no per-item fact this turn — a degraded
    # board read or a pre-#3829 playbook) -> fail OPEN on the coarse
    # boolean alone, preserving pre-#3829 behaviour so a transient wiring
    # gap never dead-arms qa_orch (the #3709 defect class).
    return make_dispatch(cls, "hydra-qa", prompt_args={"scope": "orch"}, reason="needs-qa")

def _select_slot_qa_target(
    cls: str,
    state: dict,
    candidates: dict | None,
    events: list[dict],
    best: dict | None,
    best_score: float,
    now: int,
) -> dict | None:
    """`qa_target` pipeline-slot selector (provenance: #3435)."""
    # `needs_qa_target` is the orch-style Target QA trigger. Post-#3435 /
    # ADR-0031 the autopilot sets it from the scope=target GitHub board's
    # `target_needs_qa > 0` count (collect-state.sh) — the same board read
    # that drives `dev_target` / `research_target` — so Target QA dispatch is
    # now GitHub-board-derived like the rest of the Target branch. The
    # selector is substrate-agnostic: it reads one boolean signal regardless
    # of whether it was sourced from the board or (legacy) Redis.
    if _signal_present(state, events, "needs_qa_target"):
        return make_dispatch(cls, "hydra-qa", prompt_args={"scope": "target"}, reason="needs-qa target")
    return None
