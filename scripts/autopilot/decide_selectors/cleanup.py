"""decide_selectors.cleanup — cleanup_orch / cleanup_target signal-class selectors (issue #4511).

Layer 2 of 3 of the decision brain. Imports the standard library and
decide_base only — never `decide`, never another decide_selectors module.
decide.py binds the handlers below by name into `_SIGNAL_SELECTORS`.
Every definition here moved verbatim from decide.py.
"""

from __future__ import annotations

from decide_base import (
    _orch_backfill_idle_present,
    _signal_present,
    make_dispatch,
)


def _select_signal_cleanup_orch(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`cleanup_orch` signal-class selector (provenance: #960, #958)."""
    # Issue #960 (parent #958). Board-idle backfill: when the orchestrator
    # board has gone idle (collect-state.sh emits the unified
    # `orch_backfill_idle` signal), reclaim spare capacity by dispatching the
    # headless /hydra-cleanup skill — a DETERMINISTIC dead-code +
    # simplification detector (knip/ts-prune devDependency) that files
    # high-confidence, mechanically-verifiable findings as ready-for-agent
    # issues whose acceptance criterion is "remove X AND npm test/tsc still
    # pass".
    #
    # `cleanup_board_saturated` is the anti-feedback-loop guard, mirroring
    # arch_board_saturated: once the board already holds enough open
    # `cleanup-scan`-labelled findings (cap owned by collect-state.sh), the
    # scan suppresses itself. It is checked FIRST — before the cooldown (via
    # signal_is_cooled above) — exactly like architecture_orch's
    # arch_board_saturated / scout_orch's scout_board_saturated early-return.
    #
    # Unlike architecture_orch / discover_orch, cleanup_orch is NOT in
    # BACKFILL_SIGNAL_CLASSES, so it is exempt from the one-per-turn stagger
    # guard in _rule_signal_classes and may dispatch on the same idle turn as
    # a staggered backfill class. This is deliberate (epic #958): dead-code
    # removal is the highest-confidence continuous-backfill work and is meant
    # to run hot. The 1h class cooldown is the only cadence back-stop.
    #
    # decide.py reads the precomputed signals only — it never recomputes
    # board-empty / saturation / cooldown here (the signal-seam discipline).
    if _signal_present(state, events, "cleanup_board_saturated"):
        return None
    if _orch_backfill_idle_present(state, events):
        # `apply:true` (issue #4605): hydra-cleanup is dry-run by default
        # (files nothing), so an argument-free headless dispatch is a silent
        # no-op — the same defeat pattern retro_orch's #1078 lesson fixed.
        # Stamping apply:true here (mirroring the retro_orch arm literal)
        # makes the autopilot forward `--apply`, so the idle-backfill
        # dispatch actually files the dead-code/simplification findings.
        return make_dispatch(
            sig,
            "hydra-cleanup",
            prompt_args={"apply": True},
            reason="orch board idle — dead-code / simplification backfill",
        )
    return None


def _select_signal_cleanup_target(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`cleanup_target` signal-class selector (no issue provenance cited)."""
    # The Target mirror of cleanup_orch (operator-approved 2026-06-10).
    # When the Target backlog has no actionable work (collect-state.sh
    # emits `target_backfill_idle` — triage, queued, and the Redis
    # work-queue are all empty), reclaim spare capacity by dispatching the
    # headless /hydra-target-cleanup skill: a DETERMINISTIC demote-only
    # dead-export sweep over ~/hydra-betting/web. It emits ONLY findings
    # the Target's CLAUDE.md rule-3 carve-out authorises (demote-class,
    # past the 45-day wiring grace) as ready-for-agent backlog items whose
    # acceptance check is self-checking ("drop the export keyword AND
    # test/typecheck/deadcode:check stay green with a tightened baseline").
    #
    # `target_cleanup_board_saturated` is the anti-feedback-loop guard,
    # checked FIRST (before the cooldown via signal_is_cooled above) —
    # exactly the cleanup_orch / arch_board_saturated discipline. The cap
    # (10 open `cleanup-scan`-labelled backlog items) is owned by
    # collect-state.sh; the emit runner re-checks it as a belt-and-braces
    # back-stop.
    #
    # decide.py reads the precomputed signals only — it never recomputes
    # board-empty / saturation / cooldown here (the signal-seam discipline).
    if _signal_present(state, events, "target_cleanup_board_saturated"):
        return None
    if _signal_present(state, events, "target_backfill_idle"):
        return make_dispatch(
            sig,
            "hydra-target-cleanup",
            prompt_args={"apply": True},
            reason="target backlog idle — demote-only dead-export backfill",
        )
    return None
