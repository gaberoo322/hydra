"""`dispatch_selectors.wayfinder` — signal-class selector for wayfinder_orch.

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
    make_dispatch,
)


def _select_signal_wayfinder_orch(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`wayfinder_orch` signal-class selector (provenance: #3351, #3350, #2575, #1093, #3354)."""
    # Issue #3351 (epic #3350, ADR-0029 — autopilot charts & works wayfinder
    # maps). The single AFK working class for wayfinder maps: work the next
    # unblocked frontier ticket on an open approved orchestrator
    # `wayfinder:map`. This is the tracer-bullet slice #3351 exercising the
    # full working path end-to-end on a scratch map.
    #
    # SIGNAL-SEAM DISCIPLINE (AC #3): decide.py stays PURE — no gh / curl /
    # GraphQL here. The native GraphQL frontier enumeration (per open
    # approved wayfinder:map, walk sub-issues -> first AFK-typed
    # [wayfinder:research | wayfinder:task], unblocked [all blocked-by
    # closed], unclaimed ticket) lives ONLY in collect-state.sh, which
    # pre-resolves the pick into two precomputed signals this selector reads
    # verbatim:
    #   - `wayfinder_orch_frontier`     — the resolved `issue-<N>` ticket ref
    #     (or `none` / absent when no map has an eligible frontier ticket).
    #   - `wayfinder_orch_ticket_type`  — `research` | `task`, so the playbook
    #     can resolve ticket-type -> skill at dispatch time
    #     (research -> /hydra-issue-research, task -> /hydra-dev).
    #
    # The 1h class cooldown (SIGNAL_COOLDOWNS["wayfinder_orch"], honored by
    # the shared signal_is_cooled guard at the top of this function) enforces
    # one frontier ticket per fire — mirroring the discover/cleanup 1h
    # backfill cadence. Like cleanup_orch (also 1h) the bootstrap seed is a
    # benign hardening, not a correctness requirement (a stray extra fire
    # after a pace-gate relaunch merely works one more frontier step); the
    # #2575 cooldown-bootstrap bug class bites the LONG-cooldown classes, not
    # a 1h step. NOT in BACKFILL_SIGNAL_CLASSES (map-anchored, not idle-backfill).
    #
    # decide.py emits a PURE dispatch action referencing the pre-resolved
    # ticket: `skill` defaults to hydra-issue-research (the common frontier
    # type) and the ticket ref + type are threaded into prompt_args so the
    # playbook's ticket-type router can override the skill per dispatch and
    # the worker knows exactly which ticket to resolve. The model param is
    # OMITTED (inherit the parent per #1093).
    signals = state.get("signals") if isinstance(state, dict) else None
    frontier = (
        signals.get("wayfinder_orch_frontier") if isinstance(signals, dict) else None
    )
    if not (isinstance(frontier, str) and frontier and frontier != "none"):
        # No open approved map has an eligible (AFK-typed, unblocked,
        # unclaimed) frontier ticket — nothing to work.
        return None
    # Saturation guard — global cap <=2 concurrent workers (issue #3354,
    # ADR-0029 Decision 2). collect-state.sh pre-resolves the count of live
    # `wayfinder_orch` workers (OPEN, self-assigned, AFK-typed sub-issues
    # across all approved maps) into the `wayfinder_orch_inflight_global`
    # signal; we read it VERBATIM (PURITY: no gh/curl/GraphQL here — the
    # enumeration lives only in collect-state.sh). Suppress a new dispatch
    # once two workers are already in flight, so the class never exceeds the
    # global cap. Guard order is FRONTIER-FIRST, then cap: the frontier is
    # resolved above, then the cap is applied only when there IS work to do.
    #
    # Per-map single-flight (<=1 in-flight per map) is enforced STRUCTURALLY
    # in collect-state.sh (a map with an in-flight worker yields no frontier
    # pick), so decide.py needs only the global-cap ceiling here.
    #
    # Fail-open on an ABSENT / malformed counter (default 0): a missing signal
    # means the guard has no evidence of saturation, so it must not block the
    # frontier — it blocks ONLY on a positive count that reaches the cap. This
    # is the safe direction; the structural per-map guard + the assignee-based
    # frontier exclusion already prevent double-dispatch of a single ticket.
    inflight = signals.get("wayfinder_orch_inflight_global") if isinstance(signals, dict) else None
    try:
        inflight_n = int(inflight)
    except (TypeError, ValueError):
        inflight_n = 0
    if inflight_n >= 2:
        # Global cap reached — two workers already in flight; hold this fire.
        return None
    ticket_type = (
        signals.get("wayfinder_orch_ticket_type") if isinstance(signals, dict) else None
    )
    # Default to `research` when collect-state.sh didn't stamp a type — the
    # taxonomy default skill (hydra-issue-research) matches, so an unstamped
    # frontier ticket still dispatches safely rather than blocking the path.
    if ticket_type not in ("research", "task"):
        ticket_type = "research"
    return make_dispatch(
        sig,
        "hydra-issue-research",
        prompt_args={"ticket": frontier, "ticket_type": ticket_type},
        reason=(
            f"wayfinder map frontier ticket {frontier} ({ticket_type}) "
            "unblocked and unclaimed — work it"
        ),
    )
