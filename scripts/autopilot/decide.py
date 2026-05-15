#!/usr/bin/env python3
"""
decide.py — L2 decision brain for /hydra-autopilot (issue #426).

The autopilot rewrite (closes #426) moves all decision logic out of the
playbook prose and into this file. The model becomes a thin Agent-tool-
caller: each tick it collects state + candidates + events, calls
`decide(state, candidates, events)`, and executes the typed action list
the function returns. The model never reasons about "what to do" inline
again — the answer comes from this Python function so it can be unit
tested, version controlled, and audited.

==================================================================
DECISION POLICY (single source of truth)
==================================================================

Inputs
------
state          — /tmp/hydra-autopilot-state.json snapshot (see schema below)
candidates     — GET /api/anchor/candidates payload (issue #424)
events         — list of events since last tick (TaskNotification, board
                  delta, wall-clock heartbeat). Each event has a `type`
                  and optional payload.

Outputs
-------
A `Plan` object: an ordered list of typed Actions plus a small
metadata block (reasons, debug hints). The model walks the list in
order and dispatches each action through the appropriate tool:

  Action.type          Tool the model invokes
  -----------          ----------------------
  dispatch             Agent(run_in_background=True, ...)
  queue-decision       Bash(./scripts/autopilot/queue-decision.sh ...)
  auto-merge           Bash(gh pr review/merge)
  apply-operator-approved   Bash(gh pr edit --add-label operator-approved)
  update-branch        Bash(gh pr update-branch)
  reap                 Bash(./scripts/autopilot/reap.py completion ...)
  terminate            Bash(./scripts/autopilot/drain.sh <N>) + Phase 7
  wait                 Sleep + re-enter loop (heartbeat fallback)
  wait-for-api         Bash(curl --retry ...) then re-enter loop

The function is **pure** (no fs / network / Redis side effects), so it is
trivially unit-testable from `test/autopilot-decide.test.mts`.
Everything that DOES touch the world is one of the helper scripts in
`scripts/autopilot/*` invoked by the model executing an Action.

The 9 phase scripts shipped in #409–#413 stay as decide.py's helpers —
this is a brain-layer replacement, not a full rewrite.

==================================================================
STATE SCHEMA (post-migration, issue #426)
==================================================================

state.json {
  "started":          ISO8601 start time
  "started_epoch":    int unix-epoch start
  "turn":             int
  "limits": { ... }   # unchanged from #410 / #413
  "cumulative_tokens": int
  "dispatches":       int
  "idle_turns":       int
  "burned_classes":   [str]    # soft-cap suppressions (issue #395)
  "reaped_task_ids":  [str]    # FIFO-bounded 1000 (issue #411)

  # NEW IN #426 — 6 pipeline slots replace the previous 10-slot mix
  "slots": {
    "dev_orch":        null | { skill, started, task_id, partial_tokens, ... }
    "qa_orch":         null | { ... }
    "research_orch":   null | { ... }
    "dev_target":      null | { ... }
    "qa_target":       null | { ... }
    "research_target": null | { ... }
  }

  # NEW IN #426 — signal-driven classes track only `last_fired_at` (no slot)
  "signal_last_fired": {
    "health":          unix-epoch | 0
    "sweep_orch":      unix-epoch | 0
    "sweep_target":    unix-epoch | 0
    "discover_orch":   unix-epoch | 0
    "discover_target": unix-epoch | 0
  }

  # NEW IN #426 — failure-log ring buffer (used by self_heal.py)
  "failure_log": [
    { ts, pattern, retry_count, slot, action, note }
  ]
}

==================================================================
ACTION CATALOG
==================================================================

Every Action is a dict with a "type" key plus type-specific payload.
Helpers `make_*` construct them so call sites stay typed.

  dispatch              { type, slot, skill, prompt_args, reason }
  queue-decision        { type, pr_number, tier, reason, recommendation, link }
  auto-merge            { type, pr_number, tier, reason }
  apply-operator-approved { type, pr_number, tier, reason, mechanical }
  update-branch         { type, pr_number, reason }
  reap                  { type, slot, task_id, total_tokens, skill }
  terminate             { type, cause, merged_prs, reason }
  wait                  { type, seconds, reason }
  wait-for-api          { type, url, retries, reason }

==================================================================
MERGE POLICY (Option C, issue #426 grilled decision 8)
==================================================================

`should_auto_merge(tier, mechanical, has_scope_justification, qa_verdict)`:

  qa_verdict != PASS                    → False (INV-007 guard)
  tier in {1, 2}                        → True
  tier == 3 and not has_scope_justif    → True
  tier == 3 and has_scope_justif        → queue-decision (operator review)
  tier == 0 and mechanical == True      → apply-operator-approved (then auto-merge)
  tier == 0 and mechanical == False     → queue-decision (INV-001 enforces)
  tier == 0 and mechanical == "unclear" → queue-decision (conservative)

==================================================================
FAILURE PATTERNS (self_heal.py docstring is the single source of truth)
==================================================================

`decide()` reads `state.failure_log` and consults `self_heal.classify()`
to pick a retry strategy. Five consecutive failures of the same
pattern terminate the autopilot with a `failure_digest_path`.

==================================================================
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Sequence

# ---------------------------------------------------------------------------
# Public constants
# ---------------------------------------------------------------------------

PIPELINE_SLOTS = (
    "dev_orch",
    "qa_orch",
    "research_orch",
    "dev_target",
    "qa_target",
    "research_target",
)

SIGNAL_CLASSES = (
    "health",
    "sweep_orch",
    "sweep_target",
    "discover_orch",
    "discover_target",
)

# Cooldowns for signal-driven classes (seconds). Mirrors the legacy
# /tmp/hydra-last-*.txt files but lives inside state.json now.
SIGNAL_COOLDOWNS = {
    "health":          0,      # health is always allowed; rate-limited by signal
    "sweep_orch":      900,    # 15 min
    "sweep_target":    900,
    "discover_orch":   1800,   # 30 min
    "discover_target": 1800,
}

# Wall-clock heartbeat: even with no signal, wake every 15 min to re-poll.
WALL_CLOCK_HEARTBEAT_SEC = 900

# Confidence threshold: candidates below this don't justify a dev dispatch;
# we force research instead (grilled decision 6, AC: research dispatched
# when no candidate >= 0.5, capped at 4/day).
DEV_CONFIDENCE_THRESHOLD = 0.5

# Daily research-force cap (grilled decision 6).
RESEARCH_FORCE_DAILY_CAP = 4

# Slots that are scope-disallowed exclusion mask. Scope filter is an
# exclusion mask (grilled decision 3); `health` and `qa_*` are always
# allowed regardless of scope (qa reviews any PR, health is whole-system).
SCOPE_ORCH_ONLY_EXCLUDE = ("dev_target", "research_target", "qa_target", "sweep_target", "discover_target")
SCOPE_TARGET_ONLY_EXCLUDE = ("dev_orch", "research_orch", "qa_orch", "sweep_orch", "discover_orch")

# 5-retry escalation per pattern (issue #426 AC; failure modes section).
MAX_FAILURE_RETRIES = 5

# Default failure-log path consumed by self_heal.py when called from outside
# decide.py (e.g. the Bash hook around dispatch).
DEFAULT_FAILURE_LOG = "/tmp/hydra-autopilot-failures.jsonl"


# ---------------------------------------------------------------------------
# Action constructors (one per action type — keep the type literal greppable)
# ---------------------------------------------------------------------------

def make_dispatch(slot: str, skill: str, *, prompt_args: dict | None = None, reason: str = "") -> dict:
    return {
        "type": "dispatch",
        "slot": slot,
        "skill": skill,
        "prompt_args": prompt_args or {},
        "reason": reason,
    }


def make_queue_decision(pr_number: int | str, tier: int | str, reason: str, recommendation: str, link: str | None = None) -> dict:
    return {
        "type": "queue-decision",
        "pr_number": pr_number,
        "tier": tier,
        "reason": reason,
        "recommendation": recommendation,
        "link": link,
    }


def make_auto_merge(pr_number: int | str, tier: int | str, reason: str) -> dict:
    return {"type": "auto-merge", "pr_number": pr_number, "tier": tier, "reason": reason}


def make_apply_operator_approved(pr_number: int | str, tier: int | str, reason: str, mechanical: bool) -> dict:
    return {
        "type": "apply-operator-approved",
        "pr_number": pr_number,
        "tier": tier,
        "reason": reason,
        "mechanical": mechanical,
    }


def make_update_branch(pr_number: int | str, reason: str) -> dict:
    return {"type": "update-branch", "pr_number": pr_number, "reason": reason}


def make_reap(slot: str, task_id: str, total_tokens: int, skill: str | None = None) -> dict:
    return {
        "type": "reap",
        "slot": slot,
        "task_id": task_id,
        "total_tokens": int(total_tokens),
        "skill": skill,
    }


def make_terminate(cause: str, merged_prs: int = 0, reason: str = "") -> dict:
    return {"type": "terminate", "cause": cause, "merged_prs": merged_prs, "reason": reason}


def make_wait(seconds: int, reason: str = "") -> dict:
    return {"type": "wait", "seconds": int(seconds), "reason": reason}


def make_wait_for_api(url: str, retries: int = 5, reason: str = "") -> dict:
    return {"type": "wait-for-api", "url": url, "retries": int(retries), "reason": reason}


# Sentinel set of valid action types — used by INV-checks and tests.
VALID_ACTION_TYPES = frozenset({
    "dispatch",
    "queue-decision",
    "auto-merge",
    "apply-operator-approved",
    "update-branch",
    "reap",
    "terminate",
    "wait",
    "wait-for-api",
})


# ---------------------------------------------------------------------------
# Plan container
# ---------------------------------------------------------------------------

@dataclass
class Plan:
    actions: list[dict] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    debug: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps({"actions": self.actions, "reasons": self.reasons, "debug": self.debug})

    def add(self, action: dict, reason: str = "") -> None:
        self.actions.append(action)
        if reason:
            self.reasons.append(reason)


# ---------------------------------------------------------------------------
# Merge policy (Option C)
# ---------------------------------------------------------------------------

def should_auto_merge(
    tier: int | str,
    *,
    mechanical: bool | str | None,
    has_scope_justification: bool,
    qa_verdict: str,
) -> str:
    """Return one of:

      "auto-merge"               — call `gh pr review --approve && gh pr merge`
      "apply-operator-approved"  — add the label first; auto-merge happens next tick
      "queue-decision"           — operator review required
      "hold"                     — qa hasn't passed yet; do nothing

    `mechanical` is the result of `scripts/ci/mechanical-check.ts classifyDiff()`:
    `True` (mechanical), `False` (non-mechanical), or `"unclear"` (large /
    binary / unparseable). We treat `None` the same as `"unclear"`.

    `has_scope_justification` is True iff the PR body contains a
    `scope-justification:` block (per the #404 scope-check gate). On a
    Tier-3 PR that block opts the change INTO operator review — without it
    Tier-3 PRs auto-merge (grilled decision 7).

    `qa_verdict` is the QA-bot's structured verdict literal: PASS / FAIL /
    PENDING. Anything other than "PASS" returns "hold" so INV-007 holds.

    -----------------------------------------------------
    DOCSTRING IS THE SPEC (referenced from CLAUDE.md). Update CAREFULLY.
    -----------------------------------------------------
    """
    if qa_verdict != "PASS":
        return "hold"
    # Normalise tier
    try:
        t = int(tier)
    except (TypeError, ValueError):
        return "queue-decision"
    if t in (1, 2):
        return "auto-merge"
    if t == 3:
        return "queue-decision" if has_scope_justification else "auto-merge"
    if t == 0:
        if mechanical is True:
            return "apply-operator-approved"
        # False, "unclear", None → queue-decision
        return "queue-decision"
    # Unknown tier → conservative
    return "queue-decision"


# ---------------------------------------------------------------------------
# Scope filtering (exclusion mask)
# ---------------------------------------------------------------------------

def scope_excluded(scope: str, cls: str) -> bool:
    """True iff `cls` is excluded under the autopilot scope filter.

    Scope values: "all" | "orch-only" | "target-only". The filter is an
    exclusion mask (grilled decision 3). Only `health` is fully scope-
    agnostic (whole-system probes apply regardless of which side the
    operator is focused on); qa_orch and qa_target ARE excluded by the
    opposite-side scopes because reviewing a target PR while in
    `orch-only` mode would mean dispatching against a class the scope
    explicitly disallows (INV-008).
    """
    if scope == "all":
        return False
    if cls == "health":
        return False
    if scope == "orch-only":
        return cls in SCOPE_ORCH_ONLY_EXCLUDE
    if scope == "target-only":
        return cls in SCOPE_TARGET_ONLY_EXCLUDE
    return False


# ---------------------------------------------------------------------------
# Event/heartbeat helpers
# ---------------------------------------------------------------------------

def signal_is_cooled(state: dict, signal: str, now_epoch: int | None = None) -> bool:
    """True iff enough time has elapsed since the last `signal` firing."""
    cooldown = SIGNAL_COOLDOWNS.get(signal, 0)
    if cooldown == 0:
        return True
    last = state.get("signal_last_fired", {}).get(signal, 0) or 0
    now = now_epoch if now_epoch is not None else int(time.time())
    return (now - int(last)) >= cooldown


def stamp_signal(state: dict, signal: str, now_epoch: int | None = None) -> None:
    """Mutates state: record the last-fired timestamp for a signal class."""
    state.setdefault("signal_last_fired", {})
    state["signal_last_fired"][signal] = now_epoch if now_epoch is not None else int(time.time())


# ---------------------------------------------------------------------------
# Candidate selection
# ---------------------------------------------------------------------------

def best_candidate(candidates_payload: dict | None) -> dict | None:
    """Return the top scored candidate from /api/anchor/candidates payload, or None."""
    if not candidates_payload:
        return None
    cs = candidates_payload.get("candidates")
    if not cs:
        return None
    return cs[0] if isinstance(cs, list) else None


def research_recommended(candidates_payload: dict | None) -> bool:
    if not candidates_payload:
        return True
    return bool(candidates_payload.get("research_recommended"))


# ---------------------------------------------------------------------------
# Failure-pattern bookkeeping
# ---------------------------------------------------------------------------

def consecutive_failures_of(state: dict, pattern: str) -> int:
    """Count the trailing run of `pattern` failures in state.failure_log."""
    log = state.get("failure_log") or []
    n = 0
    for entry in reversed(log):
        if entry.get("pattern") == pattern:
            n += 1
        else:
            break
    return n


# ---------------------------------------------------------------------------
# The main decision function
# ---------------------------------------------------------------------------

def decide(state: dict, candidates: dict | None, events: Iterable[dict] | None = None) -> Plan:
    """Return a Plan (typed action list) for this tick.

    Pure: no side effects. Reads `state`, `candidates`, and `events` and
    returns a fresh Plan. The caller (the playbook / model) executes the
    actions in order.

    Decision order (each step appends 0+ actions):

      1. Termination check (budget / wall-clock / idle / 5-failure backstop).
         Emits exactly one `terminate` action and stops if tripped.

      2. Completion reaps for any slot that received a completion event.
         `reap` actions always precede `dispatch` actions (INV-006).

      3. Scope filter: drop any class excluded by limits.scope (INV-008).

      4. Pipeline dispatch (the 6 fixed slots, in priority order):
         qa_orch → qa_target → dev_orch → dev_target → research_orch → research_target.
         A free slot is filled iff:
           a) class not in burned_classes (soft cap, #395)
           b) class not scope-excluded
           c) at least one eligible candidate / signal for that slot
           d) for dev_orch: best candidate score >= 0.5 (grilled decision 6)
              Otherwise, force a research_orch dispatch capped at 4/day.

      5. Signal classes (health / sweep_* / discover_*): fire if signal
         cooled AND a relevant board signal is present.

      6. Auto-merge sweep: for each PR in `events` with a QA-PASS notification,
         consult should_auto_merge() and emit the corresponding action.

      7. Idle fallback: if nothing dispatched and no slots in flight,
         emit a `wait` for the heartbeat interval.

    The decision is intentionally compact — when in doubt, the function
    emits a `queue-decision` or `wait` rather than a riskier action.
    """
    plan = Plan()
    if not isinstance(state, dict):
        raise TypeError("decide(): state must be a dict")
    events = list(events or [])
    now = int(time.time())

    limits = state.get("limits") or {}
    scope = str(limits.get("scope", "all"))

    # 1. Termination
    term = _check_termination(state, now)
    if term is not None:
        plan.add(term, reason="termination")
        plan.debug["terminate"] = term.get("cause")
        return plan

    # 2. Completion reaps first (INV-006 — reap before dispatch).
    #
    # This loop is the ONLY producer of `reap` actions, and it MUST fire
    # for every subagent completion — pipeline (dev_orch, qa_orch,
    # research_orch + _target peers) OR signal (health, sweep_orch,
    # sweep_target, discover_orch, discover_target).
    #
    # Why this is load-bearing (issue #432): cumulative_tokens is the
    # input to the budget-exhaustion termination check (INV-005). If a
    # completion event is dropped here, the autopilot silently
    # mis-reports its token spend and may run past the budget.
    #
    # Contract — the playbook (or any caller building events.json) MUST
    # emit one event per TaskNotification, regardless of class kind:
    #   {"type": "completion",
    #    "slot": "<class>",        # pipeline class OR signal class
    #    "task_id": "<task_id>",
    #    "total_tokens": <int>,
    #    "skill": "<skill name>"}
    # The `class` key is accepted as a synonym of `slot` for callers that
    # prefer that wording for signal classes. Both work identically.
    #
    # We intentionally do NOT filter by PIPELINE_SLOTS / SIGNAL_CLASSES
    # membership here. A reap for an unknown class is still safer than a
    # missed reap — reap.py is idempotent and the unknown-class path is a
    # no-op on slot bookkeeping. Filtering would risk silently dropping
    # signal completions, which is exactly the bug this issue fixed.
    for ev in events:
        if ev.get("type") != "completion":
            continue
        slot = ev.get("slot") or ev.get("class")
        task_id = ev.get("task_id")
        tokens = int(ev.get("total_tokens") or 0)
        skill = ev.get("skill")
        if slot and task_id:
            plan.add(make_reap(slot, task_id, tokens, skill), reason=f"reap:{slot}")

    # 3. Auto-merge sweep — before dispatch so freed PRs don't compete with new work.
    for ev in events:
        if ev.get("type") != "qa-verdict":
            continue
        verdict = ev.get("verdict") or "PENDING"
        pr_number = ev.get("pr_number")
        tier = ev.get("tier")
        mechanical = ev.get("mechanical")
        has_scope_justif = bool(ev.get("has_scope_justification"))
        if pr_number is None or tier is None:
            continue
        decision = should_auto_merge(
            tier,
            mechanical=mechanical,
            has_scope_justification=has_scope_justif,
            qa_verdict=verdict,
        )
        link = ev.get("link")
        if decision == "auto-merge":
            plan.add(make_auto_merge(pr_number, tier, "qa pass + tier policy"), reason=f"auto-merge:#{pr_number}")
        elif decision == "apply-operator-approved":
            plan.add(
                make_apply_operator_approved(pr_number, tier, "tier-0 mechanical carve-out", mechanical=True),
                reason=f"apply-operator-approved:#{pr_number}",
            )
        elif decision == "queue-decision":
            reason_text = ev.get("reason") or _queue_reason_for(tier, mechanical, has_scope_justif)
            recommendation = ev.get("recommendation") or _queue_recommendation_for(tier, mechanical, has_scope_justif)
            plan.add(
                make_queue_decision(pr_number, tier, reason_text, recommendation, link),
                reason=f"queue-decision:#{pr_number}",
            )
        # "hold" → no action (qa hasn't passed yet)

    # 4. Pipeline dispatch
    slots = state.get("slots") or {}
    burned = set(state.get("burned_classes") or [])
    best = best_candidate(candidates)
    best_score = float(best.get("score", 0.0)) if best else 0.0

    pipeline_priority = (
        "qa_orch",
        "qa_target",
        "dev_orch",
        "dev_target",
        "research_orch",
        "research_target",
    )

    dispatched_any = False

    for cls in pipeline_priority:
        if slots.get(cls) is not None:
            continue  # slot busy
        if cls in burned:
            continue
        if scope_excluded(scope, cls):
            continue
        action = _select_for_slot(cls, state, candidates, events, best, best_score, now)
        if action is None:
            continue
        plan.add(action, reason=f"dispatch:{cls}")
        dispatched_any = True

    # 5. Signal classes — each is independent. Health pre-empts when sick.
    # Signal classes also respect `burned_classes`: if reap.py burned a
    # signal class on soft-cap (issue #432 — a runaway hydra-discover),
    # we must NOT re-dispatch it for the rest of this session, mirroring
    # the pipeline-slot suppression in step 4. Before #432 this check
    # was missing and only pipeline slots were honored.
    for sig in ("health", "sweep_orch", "sweep_target", "discover_orch", "discover_target"):
        if scope_excluded(scope, sig):
            continue
        if sig in burned:
            continue
        action = _select_for_signal(sig, state, events, now)
        if action is None:
            continue
        plan.add(action, reason=f"signal:{sig}")
        dispatched_any = True

    # 6. Idle fallback
    occupied = sum(1 for v in slots.values() if v is not None)
    if not dispatched_any and occupied == 0:
        plan.add(make_wait(WALL_CLOCK_HEARTBEAT_SEC, "idle heartbeat"), reason="heartbeat")
    elif not dispatched_any:
        # Pipeline is busy but we have nothing new to do — short nap
        plan.add(make_wait(60, "pipeline-busy nap"), reason="busy-wait")

    plan.debug["best_score"] = best_score
    plan.debug["occupied_slots"] = occupied
    plan.debug["scope"] = scope
    return plan


# ---------------------------------------------------------------------------
# Internal slot selectors
# ---------------------------------------------------------------------------

def _select_for_slot(
    cls: str,
    state: dict,
    candidates: dict | None,
    events: list[dict],
    best: dict | None,
    best_score: float,
    now: int,
) -> dict | None:
    """Return a dispatch action for `cls` or None if the slot should idle."""
    if cls == "qa_orch":
        if _signal_present(state, events, "needs_qa_orch"):
            return make_dispatch(cls, "hydra-qa", prompt_args={"scope": "orch"}, reason="needs-qa")
        return None
    if cls == "qa_target":
        if _signal_present(state, events, "needs_qa_target"):
            return make_dispatch(cls, "hydra-qa", prompt_args={"scope": "target"}, reason="needs-qa target")
        return None
    if cls == "dev_orch":
        if best and best_score >= DEV_CONFIDENCE_THRESHOLD:
            ref = best.get("anchorRef") or best.get("issue")
            return make_dispatch(cls, "hydra-dev", prompt_args={"anchor": ref, "score": best_score}, reason=f"top candidate score={best_score}")
        # No candidate above threshold → force research_orch instead (grilled decision 6).
        # The decide() main loop will pick this up when iterating to research_orch.
        return None
    if cls == "dev_target":
        # Use board signal (work_queue / target backlog) — dev_target dispatches
        # are driven by the target-side queue, not /api/anchor/candidates.
        if _signal_present(state, events, "target_work_available"):
            return make_dispatch(cls, "hydra-target-build", reason="target work queue non-empty")
        return None
    if cls == "research_orch":
        # Two triggers: (a) best-score floor (force-research, capped daily) or
        # (b) explicit needs-research signal.
        # `candidates is None` means we didn't query the API — DON'T force
        # research; the autopilot is mid-bootstrap. Only fire force-research
        # when we have an actual empty/weak candidates payload.
        if candidates is not None and (best is None or best_score < DEV_CONFIDENCE_THRESHOLD):
            if _research_force_allowed(state, "research_orch", now):
                return make_dispatch(cls, "hydra-research", prompt_args={"forced": True}, reason="best-score below threshold; forced")
        if _signal_present(state, events, "needs_research"):
            return make_dispatch(cls, "hydra-issue-research", reason="explicit needs-research signal")
        return None
    if cls == "research_target":
        if _signal_present(state, events, "target_research_due"):
            return make_dispatch(cls, "hydra-target-research", reason="target research due")
        return None
    return None


def _select_for_signal(sig: str, state: dict, events: list[dict], now: int) -> dict | None:
    if not signal_is_cooled(state, sig, now):
        return None
    if sig == "health":
        if _signal_present(state, events, "health_fail"):
            return make_dispatch(sig, "hydra-doctor", reason="health probe failed")
        return None
    if sig == "sweep_orch":
        if _signal_present(state, events, "needs_triage_orch"):
            return make_dispatch(sig, "hydra-sweep", reason="needs-triage on orch board")
        return None
    if sig == "sweep_target":
        if _signal_present(state, events, "needs_triage_target"):
            return make_dispatch(sig, "hydra-target-sweep", reason="target board hygiene due")
        return None
    if sig == "discover_orch":
        if _signal_present(state, events, "orch_idle"):
            return make_dispatch(sig, "hydra-discover", reason="orch board sparse")
        return None
    if sig == "discover_target":
        if _signal_present(state, events, "target_idle"):
            return make_dispatch(sig, "hydra-target-discover", reason="target diagnostics due")
        return None
    return None


def _signal_present(state: dict, events: list[dict], signal: str) -> bool:
    """Look up a board/event signal by name. Events take precedence over state."""
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == signal:
            return bool(ev.get("value", True))
    # Fallback: signals stored on state.signals (filled by collect-state.sh)
    return bool((state.get("signals") or {}).get(signal))


def _research_force_allowed(state: dict, slot: str, now: int) -> bool:
    """Per-day cap on forced research dispatches (grilled decision 6, AC: capped at 4/day)."""
    today = time.strftime("%Y-%m-%d", time.gmtime(now))
    counters = state.get("research_force_counter") or {}
    by_day = counters.get(today) or {}
    return int(by_day.get(slot, 0)) < RESEARCH_FORCE_DAILY_CAP


def _check_termination(state: dict, now: int) -> dict | None:
    """Mirror of term-check.py logic, expressed as an action."""
    limits = state.get("limits") or {}
    cumulative = int(state.get("cumulative_tokens", 0))
    budget = int(limits.get("token_budget", 2_000_000))
    elapsed = now - int(state.get("started_epoch", now))
    wall_max = int(limits.get("wall_clock_max_sec", 28_800))
    idle = int(state.get("idle_turns", 0))
    idle_max = int(limits.get("idle_drain_turns", 5))
    slots = state.get("slots") or {}
    occupied = sum(1 for v in slots.values() if v is not None)
    merged_prs = int(state.get("merged_prs", 0))

    if cumulative >= budget:
        return make_terminate("budget", merged_prs=merged_prs, reason=f"tokens={cumulative}/{budget}")
    if elapsed >= wall_max:
        return make_terminate("wall_clock", merged_prs=merged_prs, reason=f"elapsed={elapsed}s")
    if idle >= idle_max and occupied == 0:
        return make_terminate("idle", merged_prs=merged_prs, reason=f"idle_turns={idle}")

    # 5-failure global backstop — looks at the most recent failure pattern.
    log = state.get("failure_log") or []
    if log:
        last_pattern = log[-1].get("pattern")
        if last_pattern and consecutive_failures_of(state, last_pattern) >= MAX_FAILURE_RETRIES:
            return make_terminate(
                "failure_backstop",
                merged_prs=merged_prs,
                reason=f"5x consecutive {last_pattern}",
            )
    return None


# ---------------------------------------------------------------------------
# queue-decision text helpers
# ---------------------------------------------------------------------------

def _queue_reason_for(tier: int | str, mechanical: bool | str | None, has_scope_justif: bool) -> str:
    t = str(tier)
    if t == "0":
        return "Tier-0 non-mechanical change — operator review required"
    if t == "3" and has_scope_justif:
        return "Tier-3 with scope-justification block — explicit operator opt-in"
    return f"Tier-{t} PR queued for operator review"


def _queue_recommendation_for(tier: int | str, mechanical: bool | str | None, has_scope_justif: bool) -> str:
    t = str(tier)
    if t == "0":
        return "Review diff; if clean, add `operator-approved` label; otherwise close"
    if t == "3" and has_scope_justif:
        return "Inspect scope-justification; approve or push back"
    return "Operator review"


# ---------------------------------------------------------------------------
# CLI entry — minimal, exists so the playbook can `python3 decide.py ...`
# and parse the JSON plan. Tests import decide() directly.
# ---------------------------------------------------------------------------

def _load_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _smoke() -> int:
    """Smoke check: print the action catalog and verify /api/anchor/candidates is reachable.

    Called by `decide.py smoke`. Exits 0 even when the API is down — the
    point is to print a diagnostic, not to fail the autopilot loop.
    """
    print(json.dumps({
        "pipeline_slots": list(PIPELINE_SLOTS),
        "signal_classes": list(SIGNAL_CLASSES),
        "action_types": sorted(VALID_ACTION_TYPES),
        "merge_policy_doc": should_auto_merge.__doc__.splitlines()[0] if should_auto_merge.__doc__ else "",
    }))
    # Best-effort candidates probe (non-fatal):
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:4000/api/anchor/candidates?limit=1", timeout=3) as resp:
            body = resp.read().decode("utf-8")
            print(f"candidates_probe: status={resp.status} body_len={len(body)}")
    except Exception as exc:  # noqa: BLE001 — diagnostic only
        print(f"candidates_probe: failed ({exc})")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) <= 1:
        print(
            "usage: decide.py decide <state.json> [candidates.json] [events.json]\n"
            "       decide.py smoke",
            file=sys.stderr,
        )
        return 2
    sub = argv[1]
    if sub == "smoke":
        return _smoke()
    if sub == "decide":
        if len(argv) < 3:
            print("decide.py decide: missing <state.json>", file=sys.stderr)
            return 2
        state = _load_json(argv[2])
        candidates = _load_json(argv[3]) if len(argv) > 3 else None
        events = _load_json(argv[4]) if len(argv) > 4 else None
        plan = decide(state, candidates, events)
        print(plan.to_json())
        return 0
    print(f"decide.py: unknown subcommand {sub!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
