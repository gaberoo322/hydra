"""decide_selectors.sweep — sweep_orch / sweep_target signal-class selectors (issue #4511).

Layer 2 of 3 of the decision brain. Imports the standard library and
decide_base only — never `decide`, never another decide_selectors module.
decide.py binds the handlers below by name into `_SIGNAL_SELECTORS`.
Every definition here moved verbatim from decide.py.
"""

from __future__ import annotations

import turn_snapshot as ts

import os

from decide_base import (
    _signal_present,
    make_dispatch,
)

# Per-item verdict-stability backoff for sweep_target (issue #3729). A FIXED
# (not exponential, not class-wide) window: each Target needs-triage item carries
# its OWN independent clock in `state.target_triage_item_stamps`. An item is
# eligible for a sweep_target dispatch iff it has no stamp OR its stamp is older
# than this window; on fire, every item in the CURRENT needs-triage set is
# stamped (resetting the whole lane's clock uniformly) and stamps for items no
# longer in the set are pruned.
#
# The literal distinction from the rejected Option B (class-level exponential
# backoff): a class-wide timer cannot tell "item X was just checked" from "item Y
# was just checked", so a fresh actionable item arriving during another item's
# backoff would be starved until the whole class cooled. The per-item map gives
# each item an independent clock, so a genuinely new item is always eligible
# immediately (issue #3729 INV-2) regardless of any sibling's staleness.
#
# Default 6h — long enough to suppress the observed verdict-thrash cadence in the
# issue's evidence (#631: 10 label events/28h ≈ one every 2.8h; #626: 12/36h ≈
# one every 3h) yet short enough that a grace-window boundary (2026-08-02 /
# 2026-08-10) still gets same-day re-examination. Env-overridable for tuning
# without a code change (mirrors HYDRA_WAYFINDER_STALENESS_SEC); resolved once at
# import so decide() stays a pure function of (state, events, now).
TARGET_TRIAGE_BACKOFF_SEC = int(
    os.environ.get("HYDRA_TARGET_TRIAGE_BACKOFF_SEC") or (6 * 60 * 60)
)

# Issue #3939 — the orchestrator-side mirror of TARGET_TRIAGE_BACKOFF_SEC. Same
# 6h default, same env-override shape, same rationale: long enough to suppress
# the observed re-fire churn (sweep_orch re-fired every 900s against a
# permanently-parked standing-trigger item, ~200-300K tokens/hour of pure churn;
# autopilot run 3ce9e61a 2026-08-10) yet short enough that a genuinely-changed
# item still gets same-day re-examination. Kept as a SEPARATE constant + env var
# (HYDRA_ORCH_TRIAGE_BACKOFF_SEC, NOT HYDRA_TARGET_TRIAGE_BACKOFF_SEC) so the two
# sweep lanes can be tuned independently — they have different verdict-thrash
# economics (target = time-gated wire-or-retire items; orch = standing re-check
# triggers). Resolved once at import so decide() stays a pure function of
# (state, events, now) (issue #3939 INV-3/INV-13).
ORCH_TRIAGE_BACKOFF_SEC = int(
    os.environ.get("HYDRA_ORCH_TRIAGE_BACKOFF_SEC") or (6 * 60 * 60)
)


def _triage_item_set(
    state: dict, events: list[dict], signal_name: str
) -> set[int] | None:
    """Read the current turn's needs-triage item-number set (issues #3729/#3939).

    The Turn Snapshot carries ``target_needs_triage_items`` / ``orch_needs_triage_items``
    as a fresh per-turn fact (an issue-number list on
    ``state.turn_snapshot.signals.<signal_name>``; a signal EVENT may carry the
    space-separated wire form, e.g. ``626 631``). The accessor returns it as a
    set of ints. SHARED by the
    target (#3729) and orch (#3939) sweep lanes, parameterized by signal name —
    the guard is shared, not forked (INV-10).

    Returns ``None`` when the signal is ABSENT (null in the snapshot — e.g. a
    degraded board read). An absent list is
    the fail-open sentinel: the caller fires on the coarse boolean alone rather
    than dead-arming the sweep (the #3709/#3939 defect class). An EMPTY emitted
    list (``""``) is returned as an empty set, distinct from absence — but the
    caller treats both the same (no per-item granularity → fail open, INV-9).

    Pure: no side effects (INV-13).
    """
    return ts.item_set(state, events, signal_name)


def _triage_stamps(state: dict, key: str) -> dict[int, int]:
    """Read a persisted per-item stamp map as ``{item_number: epoch}``.

    ``state.<key>`` is keyed by the STRING item number (JSON object keys are
    strings) and valued by a unix epoch. Returns a fresh ``{int: int}`` dict; an
    absent/malformed map yields ``{}``. SHARED by the target
    (``target_triage_item_stamps``, #3729) and orch (``orch_triage_item_stamps``,
    #3939) stamp maps, parameterized by state key (INV-10). Pure (INV-13).
    """
    raw = state.get(key)
    if not isinstance(raw, dict):
        return {}
    out: dict[int, int] = {}
    for k, v in raw.items():
        try:
            out[int(k)] = int(v)
        except (TypeError, ValueError):
            continue
    return out


def _triage_item_eligible(stamp: int, now: int, backoff_sec: int) -> bool:
    """True iff a single item's stamp makes it eligible for a sweep this turn.

    An item is eligible iff it has NO prior stamp (``stamp <= 0`` — new to the
    lane, #3729 INV-2) OR its stamp is older than the per-item backoff window
    (INV-3/INV-6). The backoff is passed in (``TARGET_TRIAGE_BACKOFF_SEC`` /
    ``ORCH_TRIAGE_BACKOFF_SEC``) so the orch and target sweep lanes share ONE
    eligibility rule — and the exact ``>=`` boundary math that has duplication-
    drift risk if forked — while tuning independently (issue #3939 INV-10: the
    guard is shared, not forked). Pure (INV-13).
    """
    if stamp <= 0:
        return True
    return (now - stamp) >= backoff_sec


def _stamp_triage_items(state: dict, items: set[int], now: int, key: str) -> bool:
    """Mutate state: stamp every item in the CURRENT set, pruning the rest.

    Issue #3729 INV-4/INV-5 (target) / #3939 INV-5 (orch mirror). On a sweep
    fire, every item in the current turn's needs-triage set is stamped to
    ``now`` (not only the previously-eligible ones — a dispatch that examines
    the whole lane resets the clock uniformly), and any stamp whose item is NO
    LONGER in the set is dropped, so the stamp map never grows unbounded across
    a long-running session. SHARED by both sweep lanes, parameterized by state
    key (INV-10). Returns True iff the map changed (so ``main()`` can persist it
    via ``_persist_state_writeback``, the same change-detection pattern as
    ``research_force_counter``, INV-12).
    """
    before = state.get(key)
    # Rebuild from the current set only — pruning is structural, not an
    # optimization (issue #3729 INV-5). Key on the STRING number (JSON object keys).
    state[key] = {str(n): int(now) for n in items}
    return before != state[key]


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
        # _triage_item_eligible / _stamp_triage_items, #3939 INV-10) — so a re-fire
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
            # to the untriaged_orphans_orch check below (#3939 INV-6): a parked
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
    # path (which keys only on needs-triage). The Turn Snapshot emits an
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
            # suppress this turn. needs_triage_target stays true (issue #3729 INV-3);
            # the lane re-opens for re-examination as each item's window
            # elapses.
            return None
        _stamp_triage_items(state, items, now, "target_triage_item_stamps")
    # `items` absent/empty (no per-item fact this turn — a degraded board
    # read or a pre-#3729 playbook) → fail OPEN on the coarse boolean alone,
    # preserving the pre-#3729 behaviour so a transient wiring gap never
    # dead-arms sweep_target (the #3709 defect class).
    return make_dispatch(sig, "hydra-target-sweep", reason="target board hygiene due")
