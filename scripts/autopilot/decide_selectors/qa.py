"""decide_selectors.qa — qa_orch / qa_target pipeline-slot selectors (issue #4511).

Layer 2 of 3 of the decision brain. Imports the standard library and
decide_base only — never `decide`, never another decide_selectors module.
decide.py binds the handlers below by name into `_SLOT_SELECTORS`.
Every definition here moved verbatim from decide.py.
"""

from __future__ import annotations

from decide_base import (
    QA_STALL_MAX_ATTEMPTS,
    _needs_qa_target_pr_ref,
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
    """`qa_target` pipeline-slot selector (provenance: #3435, #4576)."""
    # `needs_qa_target` is the orch-style Target QA trigger. Post-#3435 /
    # ADR-0031 the autopilot sets it from the scope=target GitHub board's
    # `target_needs_qa > 0` count (collect-state.sh) — the same board read
    # that drives `dev_target` / `research_target` — so Target QA dispatch is
    # now GitHub-board-derived like the rest of the Target branch. The
    # selector is substrate-agnostic: it reads one boolean signal regardless
    # of whether it was sourced from the board or (legacy) Redis.
    #
    # Post-#4576 the dispatch skill is `hydra-target-qa`, the purpose-built
    # Target QA skill (classes.json's qa_target row has always named it —
    # this selector was the drift). The previously-dispatched `hydra-qa` has
    # NO target-scope path: nothing in it reads `prompt_args.scope`, it
    # self-selects from the ORCHESTRATOR repo's needs-qa lane, so a literal
    # dispatch either duplicated qa_orch's review or no-op'd (issue #4576's
    # finding). `prompt_args.scope` stays "target" (INV-4 — the trigger's
    # board provenance, same shape as qa_orch's "orch"), and a pre-resolved
    # `pr_ref` is attached ONLY when `target_needs_qa_pr_ref` is a non-empty
    # string — never "" or null — so hydra-target-qa always receives either
    # a real PR URL or no key at all (its own step 1 resolves the PR the
    # current Target build opened when the key is absent).
    if _signal_present(state, events, "needs_qa_target"):
        prompt_args: dict = {"scope": "target"}
        pr_ref = _needs_qa_target_pr_ref(state, events)
        if pr_ref:
            prompt_args["pr_ref"] = pr_ref
        return make_dispatch(cls, "hydra-target-qa", prompt_args=prompt_args, reason="needs-qa target")
    return None


# ---------------------------------------------------------------------------
# qa_orch per-issue stall-cap guard (issue #3829, design-concept issue-3829)
# ---------------------------------------------------------------------------
#
# Loosely mirrors the #3729 sweep_target per-item guard directly above's
# collect-state-emits-a-fresh-per-turn-list shape, but the eligibility rule is
# different in kind: #3729 tracks EVERY current item on a TIME backoff (an
# item is eligible once its stamp ages past a window — a throttle on a
# noisy-but-eventually-correct verdict). #3829 tracks ONLY the HEAD of the
# needs-qa set on an ATTEMPT COUNT cap (the head stops being eligible once
# qa_orch has fired against it QA_STALL_MAX_ATTEMPTS times) because it needs
# to actually STOP dispatching against an issue that structurally cannot reach
# a verdict — a time backoff alone would not terminate the loop, only slow it
# (see QA_STALL_MAX_ATTEMPTS's docstring), and tracking every item (not just
# the head) would falsely accumulate attempts against queued issues hydra-qa
# never actually reviewed (design-concept invariant 4 — see the rejected
# alternative in the design-concept artifact for the full reasoning).

def _qa_orch_needs_qa_numbers(state: dict, events: list[dict]) -> list[int] | None:
    """Read the current turn's orch needs-qa issue-number list (issue #3829).

    collect-state.sh emits `needs_qa_numbers` as a fresh per-turn fact (a
    space-separated list of orch issue numbers, in the SAME unsorted-default
    `gh issue list --label needs-qa` order hydra-qa's own self-selection query
    uses — order is load-bearing here, unlike the #3729 item SET, because
    `numbers[0]` is defined to be the issue hydra-qa will actually review
    next), which the playbook merges verbatim into
    `state.signals.needs_qa_numbers`. Returns `None` when the signal is
    ABSENT (a degraded board read, or a pre-#3829 playbook) — the fail-open
    sentinel the caller uses to fall back to the coarse `needs_qa_orch`
    boolean alone, exactly like the sweep_target precedent. An EMPTY emitted
    list is returned as an empty list, distinct from absence, but the caller
    treats both the same (no head known -> fail open).

    Pure: no side effects.
    """
    raw = None
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == "needs_qa_numbers":
            raw = ev.get("value")
            break
    if raw is None:
        raw = (state.get("signals") or {}).get("needs_qa_numbers")
    if raw is None:
        return None
    out: list[int] = []
    candidates = raw if isinstance(raw, (list, tuple)) else str(raw).split()
    for token in candidates:
        try:
            out.append(int(str(token).strip()))
        except (TypeError, ValueError):
            continue
    return out


def _qa_orch_item_attempts(state: dict) -> dict[int, int]:
    """Read the persisted per-issue attempt tracker as `{issue_number: count}`.

    `state.qa_orch_item_attempts` is keyed by the STRING issue number (JSON
    object keys are strings). By construction (see `_bump_qa_orch_stall_
    tracker`) this map holds AT MOST ONE entry — the current needs-qa head —
    at any time. Returns a fresh `{int: int}` dict; an absent/malformed map
    yields `{}` (the current head, if any, is fresh at 0 prior attempts).

    Pure: no side effects.
    """
    raw = state.get("qa_orch_item_attempts")
    if not isinstance(raw, dict):
        return {}
    out: dict[int, int] = {}
    for k, v in raw.items():
        try:
            out[int(k)] = int(v)
        except (TypeError, ValueError):
            continue
    return out


def _qa_orch_item_eligible(attempts: int) -> bool:
    """True iff a single issue's attempt count is under the cap. Pure."""
    return attempts < QA_STALL_MAX_ATTEMPTS


def _bump_qa_orch_stall_tracker(state: dict, head: int) -> bool:
    """Mutate state: increment the attempt count for the CURRENT needs-qa
    HEAD issue only (a qa_orch dispatch just fired against it), replacing
    whatever the tracker held before.

    Issue #3829, design-concept invariant 4 (never increment a non-head
    issue) + invariant 5 (prune once an issue leaves the needs-qa set):
    rebuilding the map to hold ONLY the current head's bumped count is what
    implements both — a former head that is no longer head this turn
    (verdict reached, or a new head took over) is dropped, so a later
    re-open under the same number starts back at 0 rather than inheriting a
    stale count, and a non-head issue merely present in the set is never
    touched. Returns True iff the map changed (so `main()` can persist it via
    `_persist_state_writeback`, the same change-detection pattern as
    `target_triage_item_stamps` / `research_force_counter` — invariant 6).
    """
    before = state.get("qa_orch_item_attempts")
    prior = _qa_orch_item_attempts(state)
    updated = {str(head): prior.get(head, 0) + 1}
    state["qa_orch_item_attempts"] = updated
    return before != updated
