"""`dispatch_selectors.sweep` — signal-class selectors for sweep_orch / sweep_target.

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
    ORCH_TRIAGE_BACKOFF_SEC,
    TARGET_TRIAGE_BACKOFF_SEC,
    _signal_present,
    _stamp_triage_items,
    _triage_item_eligible,
    _triage_item_set,
    _triage_stamps,
    make_dispatch,
)


def _select_signal_sweep_orch(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`sweep_orch` signal-class selector (provenance: #3939, #3729, #3709, #2426, #2828, #2958, #3728, #3817)."""
    if _signal_present(state, events, "needs_triage_orch"):
        # Per-item verdict-stability guard (issue #3939 — the orchestrator
        # mirror of the sweep_target #3729 guard). `needs_triage_orch` is a
        # COARSE presence boolean (`needs_triage > 0`) with no per-item gate;
        # a needs-triage issue that is a STANDING re-check trigger (one whose
        # own ACs say "re-triage forward when condition X is met") parks in
        # the lane indefinitely — sweep correctly declines to route it, the
        # lane stays non-empty, and sweep_orch re-fired every 900s to re-make
        # the identical no-op decision (~200-300K tokens/hour of pure churn;
        # autopilot run 3ce9e61a 2026-08-10). This AND-composes a per-item
        # eligibility gate — SHARED with sweep_target via the lane-
        # parameterized helpers (_triage_item_set / _triage_stamps /
        # _triage_item_eligible / _stamp_triage_items, INV-10) — so a re-fire
        # happens only when an item is new (INV-2) or its
        # ORCH_TRIAGE_BACKOFF_SEC window has elapsed (INV-3). On fire, every
        # item in the CURRENT set is stamped and departed items are pruned
        # (INV-5). The 900s class cooldown checked above stays a necessary,
        # independent condition (INV-1).
        items = _triage_item_set(state, events, "orch_needs_triage_items")
        if items:
            stamps = _triage_stamps(state, "orch_triage_item_stamps")
            if any(
                _triage_item_eligible(
                    stamps.get(n, 0), now, ORCH_TRIAGE_BACKOFF_SEC
                )
                for n in items
            ):
                _stamp_triage_items(state, items, now, "orch_triage_item_stamps")
                return make_dispatch(
                    sig, "hydra-sweep", reason="needs-triage on orch board"
                )
            # Every current item was checked inside its backoff window → the
            # needs_triage_orch branch is suppressed this turn. FALL THROUGH
            # to the untriaged_orphans_orch check below (INV-6): a parked
            # standing-trigger must never cause a live orphan-routing
            # opportunity to be silently dropped. needs_triage_orch stays
            # true (presence gate, INV-3); the lane re-opens for re-examination
            # as each item's window elapses.
        else:
            # items absent/empty (no per-item fact — a degraded board read
            # or a pre-#3939 playbook) → fail OPEN on the coarse boolean
            # alone (INV-9), never dead-arming the sweep (the #3709 defect
            # class). Nothing is stamped (no item set is known).
            return make_dispatch(
                sig, "hydra-sweep", reason="needs-triage on orch board"
            )
    # Untriaged-orphans triage backstop (issue #2426). An open issue that
    # carries NONE of the actionable/lifecycle labels {ready-for-agent,
    # in-progress, blocked, needs-qa, needs-triage, needs-research,
    # target-backlog} is invisible to BOTH the dev_orch dispatch path
    # (which keys only on ready-for-agent) AND the needs_triage_orch sweep
    # path (which keys only on needs-triage). collect-state.sh emits an
    # `untriaged_orphans` COUNT for exactly that blind spot; the playbook
    # maps `untriaged_orphans > 0` → the boolean `untriaged_orphans_orch`
    # signal (mirroring the needs_triage > 0 → needs_triage_orch mapping).
    # Route those orphans through the SAME hydra-sweep triage skill so a
    # mislabeled/orphaned issue lands in an actionable lane instead of
    # silently falling off the board. Subject to the same sweep_orch
    # cooldown (already enforced above) so it cannot busy-loop.
    #
    # Reached in THREE cases: needs_triage_orch absent; needs_triage_orch
    # present with NO per-item fact (fail-open already returned above); or
    # needs_triage_orch present with every item inside its per-item backoff
    # window (the #3939 fall-through, INV-6). This orphan branch receives NO
    # per-item stamp/backoff guard (INV-7): orphans are structurally self-
    # resolving — sweep assigning ANY lifecycle label removes an item from
    # the orphan set permanently, so a persistently-recurring orphan is a
    # classifier exclusion-set gap (fixed by widening the exclusion, as
    # #2828/#2958/#3728/#3817 did), never a standing-recheck state to throttle.
    if _signal_present(state, events, "untriaged_orphans_orch"):
        return make_dispatch(sig, "hydra-sweep", reason="untriaged orphans on orch board (no actionable label)")
    return None

def _select_signal_sweep_target(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`sweep_target` signal-class selector (provenance: #3709, #3729, #631, #626)."""
    # Coarse presence gate (issue #3709): the Target board has needs-triage
    # items at all. This boolean stays TRUE even when every item is inside
    # its per-item backoff window below (INV-3) — the raw label count does
    # not change, only the per-item eligibility does.
    if not _signal_present(state, events, "needs_triage_target"):
        return None
    # Per-item verdict-stability guard (issue #3729). Successive sweeps at
    # the 900s class cooldown reached mutually contradictory verdicts on the
    # same date-gated items (the evidence: #631 took 10 label events in 28h,
    # #626 took 12 in 36h). The class-level cooldown (checked above) stays a
    # necessary condition (INV-1); this is an ADDITIONAL, independent,
    # AND-composed condition. sweep_target fires iff >=1 item in the current
    # turn's needs-triage set is eligible (no stamp, or a stamp older than
    # the per-item backoff window). On fire, every item in the CURRENT set is
    # stamped so the whole lane's clock resets uniformly, and stamps for
    # items no longer in the set are pruned (INV-4/INV-5).
    items = _triage_item_set(state, events, "target_needs_triage_items")
    if items:
        stamps = _triage_stamps(state, "target_triage_item_stamps")
        if not any(
            _triage_item_eligible(stamps.get(n, 0), now, TARGET_TRIAGE_BACKOFF_SEC)
            for n in items
        ):
            # Every current item was checked inside its backoff window →
            # suppress this turn. needs_triage_target stays true (INV-3);
            # the lane re-opens for re-examination as each item's window
            # elapses.
            return None
        _stamp_triage_items(state, items, now, "target_triage_item_stamps")
    # `items` absent/empty (no per-item fact this turn — a degraded board
    # read or a pre-#3729 playbook) → fail OPEN on the coarse boolean alone,
    # preserving the pre-#3729 behaviour so a transient wiring gap never
    # dead-arms sweep_target (the #3709 defect class).
    return make_dispatch(sig, "hydra-target-sweep", reason="target board hygiene due")
