"""`dispatch_selectors.tickets` — signal-class selector for tickets_orch.

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


def _select_signal_tickets_orch(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`tickets_orch` signal-class selector (provenance: #3423, #3419, #3992, #4014, #2575, #1093)."""
    # Issue #3423 (epic #3419, ADR-0030 Decision 2/5 — one autonomous Pocock
    # skill lineage; the delta/contract slice that WIRES this selector). The
    # tickets-STAGE producer: dispatch the vendored upstream `to-tickets`
    # skill + the thin Hydra AFK overlay to turn a resolved plan/finding into
    # one parent epic + N tracer-bullet child issues on the orchestrator GH
    # board. `hydra-prd` is DEMOTED to the called PrdInput->issue renderer
    # library invoked BY that overlay (scripts/ci/hydra-prd-render.ts) — it is
    # no longer a standalone dispatch identity and has NO class row, so the
    # selector dispatches `hydra-tickets` — the COMPOSED skill (vendored
    # to-tickets base + AFK overlay, #3992). NEVER the bare upstream
    # `to-tickets` (it ships disable-model-invocation and hard-errors under
    # Skill-tool dispatch) and NEVER `hydra-prd`.
    #
    # SIGNAL-SEAM DISCIPLINE: decide.py stays PURE — no gh / curl / GraphQL
    # here. collect-state.sh owns the board enumeration ("does a resolved plan
    # await ticketing?") and pre-resolves it into two signals this selector
    # reads VERBATIM: `tickets_available` (the presence gate) and
    # `tickets_orch_pending_spec` (an `issue-<N>` ref for the oldest
    # unassigned open `needs-tickets` spec, or `none`). That producer + the
    # `needs-tickets` board condition landed in #4014 — pre-#4014 the signal
    # had zero producers repo-wide and this arm was a documented, tested
    # no-op (the same expand-then-wire cadence wayfinder_orch used: wire the
    # selector in one slice, land the collect-state.sh producer in the next).
    # NOTE (#4014): the 1h plan-anchored `tickets_orch` class is, like its
    # structural twin `wayfinder_orch`, DELIBERATELY NOT seeded into
    # bootstrap.sh's carry-forward `signal_last_fired` set — a missing entry
    # reads as never-fired (immediately eligible) with no #2575 re-run hazard,
    # so the producer alone is sufficient to wake the class.
    #
    # 1h class cooldown (SIGNAL_COOLDOWNS["tickets_orch"], honored by the
    # shared signal_is_cooled guard at the top of this function) is the
    # back-stop; board state is the primary suppressor (an epic is only
    # rendered when a resolved plan awaits ticketing). NOT in
    # BACKFILL_SIGNAL_CLASSES (plan-anchored, not idle-backfill). The model
    # param is OMITTED (producer work inherits the parent per #1093).
    if _signal_present(state, events, "tickets_available"):
        # Thread the pre-resolved spec ref into prompt_args so hydra-tickets
        # knows EXACTLY which spec to decompose — the same pre-resolution seam
        # wayfinder_orch uses (frontier ref -> prompt_args.ticket). decide.py
        # stays PURE: it reads the precomputed ref, never enumerates the board.
        _tk_signals = state.get("signals") if isinstance(state, dict) else None
        pending_spec = (
            _tk_signals.get("tickets_orch_pending_spec")
            if isinstance(_tk_signals, dict)
            else None
        )
        return make_dispatch(
            sig,
            "hydra-tickets",
            prompt_args={"spec_issue": pending_spec} if pending_spec else {},
            reason=(
                f"resolved plan {pending_spec} awaits ticketing"
                f" — render epic + tracer children"
                if pending_spec
                else "resolved plan awaits ticketing — render epic + tracer children"
            ),
        )
    return None
