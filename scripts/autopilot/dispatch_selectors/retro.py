"""`dispatch_selectors.retro` — signal-class selector for retro_orch.

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
    RETRO_ORCH_WEEKLY_OVERRIDE_SEC,
    _signal_present,
    make_dispatch,
    signal_dark_past_floor,
)


def _select_signal_retro_orch(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`retro_orch` signal-class selector (provenance: #920, #917, #919, #1078, #3871, #4114)."""
    # Issue #920 (parent #917). Daily per-run retrospective: dispatch the
    # /hydra-retro skill (#919) to turn the most-recent COMPLETED run into
    # conservative, recurrence-gated improvement proposals.
    #
    # Gating is intentionally minimal — a signal class has no slot
    # semantics and decide.py dispatches every pipeline slot BEFORE the
    # signal loop, so a retro inherently never preempts a dev/QA/research
    # dispatch (the issue's "spare-capacity" requirement). The daily
    # cadence is enforced by the 24h SIGNAL_COOLDOWNS["retro_orch"], which
    # the `signal_is_cooled` guard at the top of this function already
    # honors (so a fired retro won't re-fire for 24h even while a
    # completed run keeps surfacing).
    #
    # `retro_run_available` is the precomputed signal from collect-state.sh:
    # true iff a COMPLETED run exists to analyse. decide.py reads it
    # verbatim and never recomputes run state here — the same signal-seam
    # discipline as scout_orch / architecture_orch.
    #
    # No run_id is threaded through prompt_args: the hydra-retro skill
    # defaults to the latest completed run when invoked with no argument
    # (see docs/operator-playbooks/hydra-retro.md "Resolve the run id").
    # Mirroring architecture_orch's no-args dispatch keeps decide.py pure
    # and avoids hard-coupling to the run-id resolution path.
    #
    # `apply:true` IS threaded, however (issue #1078): hydra-retro defaults
    # to --audit/dry-run, so an argument-free headless dispatch files ZERO
    # issues and opens ZERO PRs — every scheduled retro is then a silent
    # no-op on GitHub, defeating the signal class's entire purpose
    # (≤2 issues + ≤1 gated PR per run). Stamping `apply:true` makes the
    # autopilot forward `--apply` (the playbook maps `apply=true` →
    # `--apply`), so the headless retro emits. `--audit` remains the
    # explicit opt-in for a manual operator inspection run.
    #
    # Issue #3871 (2026-08-19 operator grill corrections to the original
    # #920 design): a completed run existing is no longer sufficient on
    # its own — `retro_run_drillable` (also precomputed by
    # collect-state.sh, from the SAME run's retro bundle) gates whether
    # that run actually has anything to analyse. The observed 2026-08-05
    # run (2bcba309) spent 115k tokens / 28 tool calls dispatching
    # /hydra-retro only to find every drill input empty; that question is
    # answerable from the bundle JSON alone, which is what
    # `retro_run_drillable` precomputes.
    if not _signal_present(state, events, "retro_run_available"):
        return None
    if _signal_present(state, events, "retro_run_drillable"):
        return make_dispatch(
            sig,
            "hydra-retro",
            prompt_args={"apply": True},
            reason="completed run available and drillable — daily retrospective",
        )
    # Correction (a): a clean-run SKIP must NOT stamp the cooldown.
    # `retro_run_available` tracks the MOST-RECENT completed run; if a
    # clean run's skip stamped `signal_last_fired.retro_orch`, a
    # different run completing an hour later with genuine findings would
    # be suppressed for the rest of the 24h window — by which time it is
    # no longer the most-recent run and may never be retro'd at all.
    # Returning None here (rather than calling make_dispatch, the only
    # thing the dispatcher stamps the cooldown from) IS the fix: this
    # skip leaves signal_last_fired.retro_orch untouched.
    #
    # Correction (b): the weekly full-retro override. The entire saving
    # from the drillability pre-check rests on that predicate staying
    # correct — if it silently breaks, "filed no findings" and "was
    # never dispatched" are indistinguishable from outside, so nothing
    # would surface the bug. Force a real retro at least once every
    # RETRO_ORCH_WEEKLY_OVERRIDE_SEC regardless of retro_run_drillable;
    # signal_dark_past_floor's "never fired == maximally stale" semantics
    # (issue #4114) mean a fresh bootstrap's first turn is immediately
    # override-eligible rather than waiting a full week.
    if signal_dark_past_floor(state, sig, now, RETRO_ORCH_WEEKLY_OVERRIDE_SEC):
        return make_dispatch(
            sig,
            "hydra-retro",
            prompt_args={"apply": True},
            reason=(
                "weekly full-retro override (issue #3871): drillability "
                "predicate check — forces a real retro at least every "
                f"{RETRO_ORCH_WEEKLY_OVERRIDE_SEC // (24 * 60 * 60)}d so a "
                "silently broken retro_run_drillable can never permanently "
                "blind the learning loop"
            ),
        )
    return None
