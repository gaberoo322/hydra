"""decide_selectors.discover — discover_orch / discover_target signal-class selectors (issue #4511).

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
    signal_dark_past_floor,
)

# Discover staleness floor (issue #4114). discover_orch's ONLY trigger from
# its #959 revival until #4114 was the shared `orch_backfill_idle` board-empty
# signal, which requires ready_for_agent==0 AND needs_research==0 AND
# needs_triage==0 AND work_queue==0 SIMULTANEOUSLY — a conjunction that
# essentially never holds on a healthy, continuously-stocked board (live
# evidence 2026-07-26..2026-08-17: 5-36 ready-for-agent issues at every
# sample, so the gate stayed false for 3+ weeks and the PRODUCER class went
# structurally dark — 0 dispatches since its revival, with architecture_orch /
# cleanup_orch frozen on the same shared gate since 2026-07-25). #3920's
# cooldown carry-forward fix was live and orthogonal: the selector simply
# never had a true input. A producer whose only trigger is "the board is
# empty" can never fire on a board that is doing its job.
#
# The floor gives discover_orch an alternate, additive trigger: fire on
# `orch_backfill_idle` OR when the class has been dark longer than this floor
# (7d — the scout_orch walk / design_qa_target / skill_prune calendar-cadence
# family: long enough to never meaningfully compete with active dev
# throughput week-to-week, short enough to guarantee the producer role is
# never dark for a month+). Deliberately DISTINCT from
# BACKFILL_STARVATION_FLOOR_SEC / signal_starved above (design-concept #4114
# INV-2): that floor is an intra-turn STAGGER override and keeps its exact
# semantics; this is a gate-level dispatch trigger on the selector itself.
# Scope (INV-3): discover_orch ONLY in this change — architecture_orch and
# cleanup_orch keep idle-only gating; the predicate is class-parameterized
# (see signal_dark_past_floor) so extending it to the siblings is a small
# follow-up, not a rewrite.
DISCOVER_STALENESS_FLOOR_SEC = 7 * 24 * 60 * 60


def _select_signal_discover_orch(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`discover_orch` signal-class selector (provenance: #959, #958, #4114, #4391)."""
    # Issue #959 (epic #958): revived. discover_orch keyed off `orch_idle`,
    # a signal collect-state.sh never emitted, so the arm was DEAD. It now
    # reads the unified `orch_backfill_idle` board-empty signal — the same
    # one architecture_orch reads — making it a backfill-set class on the
    # 1h cadence. The one-per-turn stagger guard in _rule_signals ensures
    # discover_orch and architecture_orch don't both fire on the same idle
    # turn; round-robin emerges from the per-class 1h cooldowns.
    #
    # Issue #4114: the idle-only trigger proved structurally dark on a
    # healthy board — orch_backfill_idle requires FOUR board metrics at
    # zero simultaneously, and a continuously-stocked board keeps it false
    # for weeks (the producer went 3+ weeks at 0 dispatches; see
    # DISCOVER_STALENESS_FLOOR_SEC above). The selector now fires on
    # EITHER the idle signal OR the staleness floor. The reason strings
    # keep the two paths distinguishable in the dispatch_decision audit
    # trail (design-concept #4114 INV-4, mirroring signal_starved's
    # 'backfill starvation floor (>24h since last X)' annotation pattern).
    # architecture_orch / cleanup_orch deliberately keep idle-only gating
    # (INV-3 — the sibling extension is a deferred follow-up).
    #
    # Issue #4391: while the operator-admission inbox (`hitl-grill`,
    # cap 10 in the Turn Snapshot) is saturated, every orchestrator-defect
    # finding this producer files parks into a lane only the operator
    # can drain — an idle-board dispatch is a guaranteed ~70-130k-token
    # no-op (measured 2026-09-05..06: 21 producer dispatches / ~2.0M
    # tokens / 0 admissible output against a 58-open inbox). The guard
    # suppresses the IDLE path ONLY: the staleness floor below stays
    # ungated so discover_orch can never go structurally dark on a full
    # inbox (INV-2) — it still fires at most once per 7d, bounded by the
    # 1h class cooldown. Absent signal → identical behaviour to today
    # (presence-gated like every sibling *_board_saturated guard, #4114 INV-6).
    if _orch_backfill_idle_present(state, events) and not _signal_present(
        state, events, "hitl_grill_saturated"
    ):
        return make_dispatch(sig, "hydra-discover", reason="orch board idle — discovery backfill")
    if signal_dark_past_floor(state, sig, now, DISCOVER_STALENESS_FLOOR_SEC):
        return make_dispatch(
            sig,
            "hydra-discover",
            reason=(
                f"discover staleness floor (>{DISCOVER_STALENESS_FLOOR_SEC // (24 * 60 * 60)}d"
                " dark since last fire): producer class dark on a busy board"
            ),
        )
    return None


def _select_signal_discover_target(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`discover_target` signal-class selector (no issue provenance cited; trigger rewired by #4607)."""
    # Issue #4607: this class used to gate on `target_idle` — a signal NO
    # producer ever emitted, so the class could NEVER fire (its trigger was
    # dead, silently tolerated on signal-parity-check's PRODUCERLESS list).
    # The selector now rides the PRODUCED Target board-empty signal
    # `target_backfill_idle` (the Turn Snapshot: triage==0 AND queued==0 AND
    # work_queue==0, API-down → false) — the exact twin of how cleanup_target
    # gates, and the Target mirror of how discover_orch rides
    # orch_backfill_idle. One predicate, one emit line: no alias re-emit of
    # the old name (the #959 anti-alias-drift stance). The bare read needs no
    # degraded-read guard: the producer already fails closed to `false` on a
    # failed board read, and `target_board_signals_degraded` is
    # advisory-observable by design. Self-limiting: any finding files
    # needs-triage on the Target board, un-idling target_backfill_idle until
    # sweep_target drains it. decide.py reads the precomputed signal only
    # (the signal-seam discipline).
    if _signal_present(state, events, "target_backfill_idle"):
        return make_dispatch(sig, "hydra-target-discover", reason="target diagnostics due")
    return None
