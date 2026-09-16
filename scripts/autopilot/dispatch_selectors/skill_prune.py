"""`dispatch_selectors.skill_prune` — signal-class selector for skill_prune.

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
    _orch_backfill_idle_present,
    _signal_present,
    make_dispatch,
)


def _select_signal_skill_prune(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`skill_prune` signal-class selector (provenance: #2949, #2944, #2575, #1078, #1093)."""
    # Issue #2949 (epic #2944, the skill-quality overhaul). The recurring,
    # eval-gated PROMPT counterpart to cleanup_orch's mechanical dead-CODE
    # sweep: dispatch the headless /hydra-skill-prune skill to prune the
    # Orchestrator's playbook-generated skills. Each run picks EXACTLY ONE
    # generated skill (largest-over-baseline first, else round-robin) and
    # proposes deletions along the Pocock pruning taxonomy (duplication /
    # sediment / no-op). The deletion test is made deterministic — candidates
    # are validated by running the promptfoo eval (evals/skill-prune.yaml,
    # offline echo provider) and requiring golden-task contract-token parity
    # before a PR opens; a failing eval aborts the PR and files a needs-triage
    # issue listing the candidates instead. Output is AT MOST one T1/T2 PR per
    # run editing only that playbook (plus its regenerated skill + its
    # shrink-only-tightened skill-size-baseline.json entry).
    #
    # Spare-capacity backfill: keyed off the same `orch_backfill_idle` signal
    # as architecture_orch / cleanup_orch (collect-state.sh emits it when the
    # orchestrator board has gone idle). The 7d class cooldown
    # (SIGNAL_COOLDOWNS["skill_prune"], honored by the shared signal_is_cooled
    # guard at the top of this function) is the primary cadence control — the
    # scout_orch calendar discipline, since the accretion worth pruning takes
    # a week to accumulate — and is seeded in bootstrap.sh's signal_last_fired
    # so it survives the pace-gate relaunch (the #2575 cooldown-bootstrap bug
    # class). NOT in BACKFILL_SIGNAL_CLASSES: like cleanup_orch it rides the
    # idle signal but rate-limits on its own cooldown, not the one-per-turn
    # stagger.
    #
    # `skill_prune_board_saturated` is the anti-flood cap, checked FIRST
    # (before the cooldown, exactly like cleanup_orch / cleanup_board_saturated
    # and design_qa_target / design_qa_target_saturated): once the board
    # already holds enough open skill-prune proposal work the pass suppresses
    # itself so a healthy skill set isn't re-pruned into churn.
    #
    # The dispatch stamps `apply: true` (the #1078 retro/cleanup anti-dry-run-
    # no-op lesson: the skill is dry-run by default, so a headless dispatch
    # without it files/opens NOTHING) and OMITS the model param (inherit the
    # parent per #1093 — judgment work; the Haiku-premature-exit failure mode
    # is documented). decide.py reads the precomputed signals only — it never
    # reads the playbooks or runs the eval here (the signal-seam discipline).
    if _signal_present(state, events, "skill_prune_board_saturated"):
        return None
    if _orch_backfill_idle_present(state, events):
        return make_dispatch(
            sig,
            "hydra-skill-prune",
            prompt_args={"apply": True},
            reason="orch board idle — eval-gated skill prune backfill",
        )
    return None
