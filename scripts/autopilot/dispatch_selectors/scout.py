"""`dispatch_selectors.scout` — signal-class selector for scout_orch.

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


def _select_signal_scout_orch(
    sig: str,
    state: dict,
    events: list[dict],
    now: int,
) -> dict | None:
    """`scout_orch` signal-class selector (provenance: #485, #483, #486)."""
    # Issue #485 (Phase B of /hydra-tool-scout, parent #483). Calendar-
    # driven path: fires when the weekly walk is due AND the orchestrator
    # board isn't already saturated with proposal-grade work — the
    # playbook prose pins the `>20 open enhancement issues` ceiling
    # (see hydra-tool-scout.md "When NOT to run this"). decide.py honors
    # it via the `scout_board_saturated` signal so the gate is checked
    # once at collect-state.sh time, not re-parsed here.
    #
    # The actual category/dep selection is in `src/scout/calendar-walk.ts`;
    # decide.py only emits the dispatch — the skill itself walks the
    # planner output and invokes one scout per eligible target.
    #
    # Issue #486 (Phase C) — ALERT-driven path: when
    # `scout_alert_eligible_count > 0` AND the orchestrator board
    # isn't saturated, fire the same skill with `trigger: "alert"` so
    # acute failure patterns (test_decline, rollback_cluster, etc.)
    # get a same-day investigation instead of waiting for the weekly
    # walk. The skill reads `/api/scout/alert-plan` to learn which
    # categories to research. Per-class cooldown DOES still apply
    # (SIGNAL_COOLDOWNS["scout_orch"] = 7d) — that's the back-stop
    # against the listener firing more than once per week even
    # under sustained alert pressure. The 24h per-pattern dedup
    # inside the listener is the primary suppressor; the 7d class
    # cooldown is the safety net.
    if _signal_present(state, events, "scout_board_saturated"):
        return None
    alert_count = int((state.get("signals") or {}).get("scout_alert_eligible_count") or 0)
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == "scout_alert_eligible_count":
            try:
                alert_count = int(ev.get("value") or 0)
            except (TypeError, ValueError):
                alert_count = 0
            break
    if alert_count > 0:
        return make_dispatch(
            sig,
            "hydra-tool-scout",
            prompt_args={"trigger": "alert"},
            reason=f"alert-driven scout: {alert_count} eligible alert(s)",
        )
    if _signal_present(state, events, "scout_walk_due"):
        return make_dispatch(
            sig,
            "hydra-tool-scout",
            prompt_args={"trigger": "calendar"},
            reason="weekly calendar walk due",
        )
    return None
