"""decide_selectors.wire_or_retire — wire_or_retire_target signal-class selector (issue #4511).

Layer 2 of 3 of the decision brain. Imports the standard library and
decide_base only — never `decide`, never another decide_selectors module.
decide.py binds the handler below by name into `_SIGNAL_SELECTORS`.
Every definition here moved verbatim from decide.py.
"""

from __future__ import annotations

import turn_snapshot as ts

from decide_base import (
    _normalize_target_risk_surface,
    _signal_present,
    make_dispatch,
)


# Per-run cap on how many wire-or-retire items the resolver may advance
# (design concept for #2722, epic #2720): "At most 2 items resolved per run,
# oldest-first." Threaded into `prompt_args.max_items` on every
# `wire_or_retire_target` dispatch so the cap is machine-enforceable at the
# dispatch seam, not prose-only.
WIRE_OR_RETIRE_MAX_ITEMS = 2

# Risk carve-out for `wire_or_retire_target` (issue #2722, epic #2720;
# re-sourced off the Target Manifest in #4411): modules under the manifest's
# `riskCritical.surface` (ADR-0026) ALWAYS route ready-for-human and NEVER get
# a WIRE/RETIRE verdict. The list itself is no longer a decide.py constant —
# it is resolved fresh every turn by the Turn Snapshot (via
# `scripts/target/print-target-facts.ts` → `loadRiskSurface`) into
# `state.target_risk_surface`, normalized by `_normalize_target_risk_surface`
# above, and threaded verbatim into `prompt_args.risk_carveout` so the guard
# stays auditable in the dispatch record and unit-testable — decide.py reads
# the precomputed value only (INV-1: it stays a pure function of state.json,
# no manifest file read, no subprocess). The carve-out IS the manifest
# surface now: over-routing to human is safe, under-routing is not, and a
# target that declares no surface fails CLOSED (the dispatch is withheld
# entirely — see the `wire_or_retire_target` signal handler below) rather
# than falling back to any hardcoded list.


def _select_signal_wire_or_retire_target(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`wire_or_retire_target` signal-class selector (provenance: #2722, #2720, #2721, #4411, #2575, #1093, #1078)."""
    # Issue #2722 (epic #2720) — the JUDGMENT counterpart to cleanup_target's
    # mechanical sweep. cleanup_target files needs-triage `wire-or-retire`-
    # labelled Target backlog items for modules past the 45-day wiring grace;
    # those items are the DECISION queue. The prompt-shaped resolver protocol
    # drafted in their bodies is what failed (items were laundered into the
    # backlog lane where no sweep looks — hence the #2721 lane guard). This
    # class dispatches the headless /hydra-wire-or-retire skill to actually
    # RESOLVE those items: git-log archaeology + cross-ref of config/direction
    # vision/priorities/roadmap + the Target backlog open AND done lanes →
    # a WIRE (rewrite into a concrete ready-for-agent wiring task) / RETIRE
    # (rewrite into a ready-for-agent retirement task citing the deadcode
    # scan) / UNCLEAR (route ready-for-human and stop) verdict per module,
    # resolving at most 2 items per run.
    #
    # Hard carve-out (enforced in the skill, restated here for the record):
    # modules under the Target Manifest's `riskCritical.surface` (ADR-0026,
    # `state.target_risk_surface`) ALWAYS route ready-for-human. Ambiguity
    # never resolves to deletion (Target CLAUDE.md rule 6, fail closed).
    # The outer signal loop already withheld this dispatch entirely when
    # the surface could not be resolved (the fail-closed gate above, issue
    # #4411) — reaching this branch means the signal is present AND the
    # surface is ok.
    #
    # Fires on `wire_or_retire_target_available` — collect-state.sh emits it
    # when >=1 open wire-or-retire-labelled item sits in the Target triage
    # lane. The 24h class cooldown (SIGNAL_COOLDOWNS, honored by the shared
    # signal_is_cooled guard at the top of this function) enforces the
    # once-per-day cadence so the same triage queue isn't re-dispatched every
    # idle turn; it is seeded in bootstrap.sh's signal_last_fired so it
    # survives the pace-gate relaunch (the #2575 cooldown-bootstrap bug class).
    #
    # The dispatch OMITS the model param (inherit the parent per the #1093
    # fallback): this is judgment work, and the Haiku-premature-exit failure
    # mode (a low-tier model narrates "standing by" and exits in seconds) is
    # documented — so no `model` key is passed here, mirroring how the other
    # judgment classes leave model resolution to the parent session.
    #
    # decide.py reads the precomputed signal only — it never recomputes the
    # triage-lane membership here (the signal-seam discipline).
    if _signal_present(state, events, "wire_or_retire_target_available"):
        # prompt_args stamps the three machine-enforceable dispatch
        # parameters the design concept (Invariant 9) requires:
        #   - apply: True    — the retro #1078 / cleanup_orch anti-dry-run-
        #     no-op fix. The autopilot maps apply=true -> --apply; without
        #     it every dispatched run is a silent headless dry-run that
        #     resolves nothing (the skill has no default-apply mode).
        #     Precedent: retro_orch and cleanup_target both stamp apply:True.
        #   - max_items: 2   — the per-run resolution cap (oldest-first).
        #   - risk_carveout  — the machine-readable carve-out list threaded
        #     verbatim so the risk/live-execution guard is auditable in the
        #     dispatch record, not prose-only (the item-685/687 failure mode).
        #     Sourced from `state.target_risk_surface` (issue #4411) — the
        #     Target Manifest's `riskCritical.surface`, joined onto
        #     `verify.appSubdir` by `print-target-facts.ts`, never a
        #     decide.py constant. The outer signal loop already withheld
        #     this dispatch when the surface was unresolved, so `surface`
        #     is guaranteed non-empty here; the defensive `or []` only
        #     protects against a future direct call to this function.
        risk_surface = _normalize_target_risk_surface(ts.blob(state, "target_risk_surface"))
        return make_dispatch(
            sig,
            "hydra-wire-or-retire",
            prompt_args={
                "apply": True,
                "max_items": WIRE_OR_RETIRE_MAX_ITEMS,
                "risk_carveout": list(risk_surface["surface"] or []),
            },
            reason="target triage has wire-or-retire items — resolve WIRE/RETIRE/UNCLEAR",
        )
    return None
