"""decide_selectors.qa — qa_orch / qa_target pipeline-slot selectors (issue #4511).

Layer 2 of 3 of the decision brain. Imports the standard library and
decide_base only — never `decide`, never another decide_selectors module.
decide.py binds the handlers below by name into `_SLOT_SELECTORS`.
Every definition here moved verbatim from decide.py.
"""

from __future__ import annotations

import turn_snapshot as ts

from decide_base import (
    _needs_qa_target_pr_head,
    _needs_qa_target_pr_ref,
    _parked_issues,
    _parked_read_degraded,
    ReviewLane,
    ReviewSelfSelect,
    TargetReviewPr,
    TargetReviewSelfSelect,
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
    # `needs_qa_numbers[0]` — because the dispatch's ReviewLane intent names
    # exactly that parked-filtered head (#5382), so the head is
    # deterministically the ONLY issue any given qa_orch dispatch will
    # actually review (invariant 4). Bumping every item in
    # the set (as a naive #3729-style port would) was considered and
    # rejected at design time: it would falsely accumulate attempts
    # against issues sitting further back in the queue that were never
    # actually reviewed, risking a false "stalled" verdict on a
    # healthy-but-queued issue the moment it becomes the new head.
    numbers = _qa_orch_needs_qa_numbers(state, events)
    intent = ReviewSelfSelect()
    # #5319 INV-4: a degraded parked read fails CLOSED on every path, including
    # the absent/empty-numbers boolean fallback below (QA r2).
    if _parked_read_degraded(state, events):
        return None
    if numbers:
        # #5319 (ADR-0047 Decision 6): a parked needs-qa issue is the operator's
        # (human hold) - never reviewed. Drop parked numbers; if nothing is left
        # there is nothing to dispatch on.
        parked = _parked_issues(state, events)
        numbers = [n for n in numbers if n not in parked]
        if not numbers:
            return None
        head = numbers[0]
        # #5318 INV-7/INV-8: there is no per-run attempt counter here any more.
        # A QA dispatch that ends with the anchor still `needs-qa` is released
        # as a `stall` claim outcome (reap.py), and the seam's qa-stall Live Cap
        # parks the issue; a parked issue is dropped above. The selector never
        # suppresses on a count and never writes a label.
        # #5382: always name the head the selector chose plus the parked-filtered
        # remainder, so the renderer never re-reads the lane (the #5319 bug class).
        # A duplicated number in the snapshot (fixture or double-read) collapses to its first occurrence.
        rest = tuple(f"issue-{n}" for n in dict.fromkeys(numbers[1:]) if n != head)
        intent = ReviewLane(anchor=f"issue-{head}", rest=rest)
    # `numbers` absent/empty (no per-item fact this turn — a degraded
    # board read or a pre-#3829 playbook) -> ReviewSelfSelect: fail OPEN on the
    # coarse boolean alone, preserving pre-#3829 behaviour so a transient wiring
    # gap never dead-arms qa_orch (the #3709 defect class).
    return make_dispatch(cls, "hydra-qa", intent=intent, reason="needs-qa")


def _select_slot_qa_target(
    cls: str,
    state: dict,
    candidates: dict | None,
    events: list[dict],
    best: dict | None,
    best_score: float,
    now: int,
) -> dict | None:
    """`qa_target` pipeline-slot selector (provenance: #3435, #4576)."""
    # `needs_qa_target` is the orch-style Target QA trigger. Post-#3435 /
    # ADR-0031 the autopilot sets it from the scope=target GitHub board's
    # `target_needs_qa > 0` count (the Turn Snapshot) — the same board read
    # that drives `dev_target` / `research_target` — so Target QA dispatch is
    # now GitHub-board-derived like the rest of the Target branch. The
    # selector is substrate-agnostic: it reads one boolean signal regardless
    # of whether it was sourced from the board or (legacy) Redis.
    #
    # Post-#4576 the dispatch skill is `hydra-target-qa`, the purpose-built
    # Target QA skill (classes.json's qa_target row has always named it —
    # this selector was the drift). The previously-dispatched `hydra-qa` has
    # NO target-scope path: it self-selects from the ORCHESTRATOR repo's
    # needs-qa lane, so a literal dispatch either duplicated qa_orch's review
    # or no-op'd (issue #4576's finding). Since #5383 the dispatch carries a
    # typed intent (qa_target is target-scope by its class row): a
    # TargetReviewPr is built ONLY when `target_needs_qa_pr_ref` is a
    # non-empty string — never "" or null — otherwise TargetReviewSelfSelect,
    # so hydra-target-qa always receives either a real PR URL or none (its own
    # step 1 resolves the PR the current Target build opened).
    if _signal_present(state, events, "needs_qa_target"):
        # Issue #5383: the action carries a typed intent (no prompt_args). A
        # non-empty ref -> TargetReviewPr(pr_ref, head); absent/empty ->
        # TargetReviewSelfSelect (the #4576 INV-5 fail-open arm).
        pr_ref = _needs_qa_target_pr_ref(state, events)
        if pr_ref:
            intent = TargetReviewPr(pr_ref=pr_ref, head=_needs_qa_target_pr_head(state, events) or None)
        else:
            intent = TargetReviewSelfSelect()
        return make_dispatch(cls, "hydra-target-qa", intent=intent, reason="needs-qa target")
    return None


# ---------------------------------------------------------------------------
# qa_orch needs-qa head (issue #3829; the per-run stall counter retired by #5318)
# ---------------------------------------------------------------------------
#
# The head of the needs-qa set (`numbers[0]`) is the issue hydra-qa will review
# next. The per-run attempt counter that used to cap it (#3829) is gone: the
# qa-stall Live Cap in the lifecycle seam parks an issue whose QA dispatches
# keep ending without a verdict (ADR-0047 D6), and parked issues are filtered
# out of the lane by `_parked_issues`.

def _qa_orch_needs_qa_numbers(state: dict, events: list[dict]) -> list[int] | None:
    """Read the current turn's orch needs-qa issue-number list (issue #3829).

    The Turn Snapshot carries `needs_qa_numbers` as a fresh per-turn fact (a
    list of orch issue numbers, in the SAME unsorted-default
    `gh issue list --label needs-qa` order hydra-qa's own self-selection query
    uses — order is load-bearing here, unlike the #3729 item SET, because
    `numbers[0]` is defined to be the issue hydra-qa will actually review
    next) on `state.turn_snapshot.signals.needs_qa_numbers`. Returns `None`
    when the signal is ABSENT (a degraded board read) — the fail-open
    sentinel the caller uses to fall back to the coarse `needs_qa_orch`
    boolean alone, exactly like the sweep_target precedent. An EMPTY emitted
    list is returned as an empty list, distinct from absence, but the caller
    treats both the same (no head known -> fail open).

    Pure: no side effects.
    """
    return ts.ordered_numbers(state, events, "needs_qa_numbers")
