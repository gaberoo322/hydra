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
  "run_id":           str  # uuid stamped by bootstrap.sh; consumed by
                           # _synthesize_worktree_branch (issue #527)
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

  # NEW IN #426 — signal-driven classes track only `last_fired_at` (no slot).
  # `scout_orch` was added in #485 (Phase B of /hydra-tool-scout).
  "signal_last_fired": {
    "health":          unix-epoch | 0
    "sweep_orch":      unix-epoch | 0
    "sweep_target":    unix-epoch | 0
    "discover_orch":   unix-epoch | 0
    "discover_target": unix-epoch | 0
    "scout_orch":      unix-epoch | 0
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

  dispatch              { type, slot, skill, prompt_args, reason, worktreeBranch }
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
    # design_concept_orch (issue #466, Phase B of #437): grills an
    # orchestrator anchor before its dev_orch dispatch. Phase B is warn-
    # only — a draft artifact whose gateCheck() returns ok:false is still
    # treated as "fresh artifact present" and dev_orch proceeds. Phase C
    # (separate issue) will flip this to a hard block. The target mirror
    # (design_concept_target) lands in Phase D.
    "design_concept_orch",
)

SIGNAL_CLASSES = (
    "health",
    "sweep_orch",
    "sweep_target",
    "discover_orch",
    "discover_target",
    # scout_orch (issue #485, Phase B of /hydra-tool-scout epic): weekly
    # calendar walk over the AI-leverage taxonomy + runtime deps. Calendar-
    # driven, 7d cooldown — see src/scout/calendar-walk.ts for the walker
    # itself. Phase A (#484) shipped the skill + seen-list; Phase B wires
    # the autopilot dispatch so the walk runs unattended.
    "scout_orch",
)

# Cooldowns for signal-driven classes (seconds). Mirrors the legacy
# /tmp/hydra-last-*.txt files but lives inside state.json now.
SIGNAL_COOLDOWNS = {
    "health":          0,      # health is always allowed; rate-limited by signal
    "sweep_orch":      900,    # 15 min
    "sweep_target":    900,
    "discover_orch":   1800,   # 30 min
    "discover_target": 1800,
    # 7 days. The calendar walk takes ~a week's worth of context to digest
    # (10 categories + 2 dep manifests ≈ 12 dispatches; running it more
    # often produces duplicate work because the per-category cooldown is
    # 30d). Per-class cooldown is the back-stop; per-category cooldown is
    # the primary suppressor. See docs/operator-playbooks/hydra-autopilot.md.
    "scout_orch":      7 * 24 * 60 * 60,
}

# Wall-clock heartbeat: even with no signal, wake every 15 min to re-poll.
WALL_CLOCK_HEARTBEAT_SEC = 900

# Silent-wedge fallback timer (issue #509). When an active slot has been
# in flight for longer than this without a corresponding subagent_stop
# hook event, decide.py emits a `wait_or_reap` action so the operator
# loop falls back to reap.py. The slot_events stream is the primary
# accounting path; this fallback only fires when the hook itself silently
# failed (e.g. the subagent process crashed before reaching the harness's
# SubagentStop dispatch).
#
# Default 3600s (1h). Override with HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS.
def _subagent_max_wall_seconds(state: dict | None = None) -> int:
    """Resolve the silent-wedge cap from env or state.limits, default 3600."""
    env = os.environ.get("HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS")
    if env:
        try:
            return int(env)
        except (TypeError, ValueError):
            pass
    if state is not None:
        limits = state.get("limits") or {}
        v = limits.get("subagent_max_wall_seconds")
        if v is not None:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    return 3600


# Bounded slot_history ring buffer length — decide.py trims to this on
# every consumption pass so state.json doesn't grow unbounded across
# an 8-hour run.
SLOT_HISTORY_MAX_ENTRIES = 50


def _normalize_usage_eligibility(raw) -> dict:
    """Normalize the Subscription Usage Tracker payload (PR B1).

    `state.usage_eligibility` is sourced from the
    `usage_eligibility_json=` line emitted by collect-state.sh, which
    in turn comes from `GET /api/usage/eligibility`. The orchestrator
    side guarantees a stable shape, but the autopilot side has to
    tolerate missing / malformed input because:
      - the orchestrator can be unreachable mid-bootstrap
      - the playbook is a prompt and may drop the field on a bad turn
      - older state.json files (pre-PR-B1) won't have the field at all

    Returns the canonical shape:
        {"allow": bool, "shed": set[str], "reasons": dict}

    Missing / malformed input → {"allow": True, "shed": set(),
    "reasons": {}} so the tracker stays informational, not load-bearing.
    """
    if not isinstance(raw, dict):
        return {"allow": True, "shed": set(), "reasons": {}}
    allow = raw.get("allow")
    if not isinstance(allow, bool):
        allow = True
    shed_raw = raw.get("shed")
    if isinstance(shed_raw, list):
        shed = {s for s in shed_raw if isinstance(s, str)}
    else:
        shed = set()
    reasons_raw = raw.get("reasons")
    reasons = reasons_raw if isinstance(reasons_raw, dict) else {}
    return {"allow": allow, "shed": shed, "reasons": reasons}

# Confidence threshold: candidates below this don't justify a dev dispatch;
# we force research instead (grilled decision 6, AC: research dispatched
# when no candidate >= 0.5, capped at 4/day).
DEV_CONFIDENCE_THRESHOLD = 0.5

# Daily research-force cap (grilled decision 6).
RESEARCH_FORCE_DAILY_CAP = 4

# Tool-scout cost-cap defaults (issue #532). Mirror the constants in
# src/scout/calendar-walk.ts so the gate has sane fallbacks when state.json
# lacks the limits keys (e.g. legacy state from a v1 schema).
#
# `SCOUT_DAILY_COST_SHARE_DEFAULT` matches `SCOUT_DAILY_COST_SHARE` in TS —
# 4% of the daily budget. `DAILY_SPEND_CAP_USD_DEFAULT` matches the
# operator-facing $50/day cap documented in the dashboard. Both can be
# overridden via state.limits or the bootstrap env vars.
SCOUT_DAILY_COST_SHARE_DEFAULT = 0.04
DAILY_SPEND_CAP_USD_DEFAULT = 50.0

# Slots that are scope-disallowed exclusion mask. Scope filter is an
# exclusion mask (grilled decision 3); `health` and `qa_*` are always
# allowed regardless of scope (qa reviews any PR, health is whole-system).
SCOPE_ORCH_ONLY_EXCLUDE = ("dev_target", "research_target", "qa_target", "sweep_target", "discover_target")
SCOPE_TARGET_ONLY_EXCLUDE = (
    "dev_orch", "research_orch", "qa_orch", "sweep_orch", "discover_orch",
    # design_concept_orch is orch-scope by definition (issue #466) —
    # excluded under target-only just like dev_orch / qa_orch / etc.
    "design_concept_orch",
    # scout_orch (issue #485) walks the orchestrator's AI-leverage
    # taxonomy + the orchestrator+dashboard runtime deps — purely orch-
    # scope work. Under `target-only` the autopilot is told to stay out
    # of orch issues; scout_orch belongs in that exclusion.
    "scout_orch",
)

# 5-retry escalation per pattern (issue #426 AC; failure modes section).
MAX_FAILURE_RETRIES = 5

# Default failure-log path consumed by self_heal.py when called from outside
# decide.py (e.g. the Bash hook around dispatch).
DEFAULT_FAILURE_LOG = "/tmp/hydra-autopilot-failures.jsonl"


# ---------------------------------------------------------------------------
# Action constructors (one per action type — keep the type literal greppable)
# ---------------------------------------------------------------------------

def make_dispatch(
    slot: str,
    skill: str,
    *,
    prompt_args: dict | None = None,
    reason: str = "",
    worktree_branch: str | None = None,
) -> dict:
    """Construct a `dispatch` action.

    `worktree_branch` (issue #527) is the branch name the dispatched
    subagent will run under. When None at construction time, `decide()`
    stamps a deterministic synthesised name (`_synthesize_worktree_branch`)
    before the plan is returned so every dispatch action carries the
    field. The dashboard's "Watch stream" cross-link (slice 4 of #496,
    PR #526) reads this to scope `/agents/stream?agent=<branch>`.

    The field name uses camelCase (`worktreeBranch`) because that's the
    schema the dashboard / `fetchTurnsWithJoins` consumers expect. The
    Python kwarg is snake_case for callsite ergonomics.
    """
    action: dict = {
        "type": "dispatch",
        "slot": slot,
        "skill": skill,
        "prompt_args": prompt_args or {},
        "reason": reason,
    }
    if worktree_branch:
        action["worktreeBranch"] = worktree_branch
    return action


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


# ---------------------------------------------------------------------------
# Observability event constructors (issue #668, slice A of epic #667)
# ---------------------------------------------------------------------------
#
# Three new event types ride the existing `hydra:autopilot:slot-events`
# Redis stream alongside the bash-hook events (`subagent_stop`,
# `slot_waiting_permission`). The `slot-events-bridge.ts` consumer is
# field-agnostic — it forwards every string/number field verbatim — so
# the new discriminators flow to dashboard WS clients without any bridge
# code changes. The bridge tests pin this round-trip explicitly.
#
# Payload shapes (each value MUST be string-serialisable for XADD):
#
#   turn_start         { event, turn_n, epoch, run_id, ts_epoch }
#   turn_end           { event, turn_n, epoch, run_id, dispatches,
#                        skipped, idle, tokens_after, ts_epoch }
#   dispatch_decision  { event, turn_n, class, outcome, reason, ts_epoch }
#                      outcome ∈ {dispatched, cooldown, budget, idle}
#
# These events do NOT replace the hook-emitted `subagent_stop` events —
# the hook is the source of truth for subagent lifecycle. The new events
# describe the autopilot's decision boundaries (turn-start /
# turn-end / per-class verdict), which the hooks have no visibility
# into.

DISPATCH_DECISION_OUTCOMES = frozenset({"dispatched", "cooldown", "budget", "idle"})


def make_turn_start_event(state: dict, now: int) -> dict:
    """Construct the per-turn `turn_start` observability event.

    Stringly-typed because the XADD path in `main()` writes field/value
    pairs that Redis returns as bytes; the bridge stringifies on the way
    out. We pre-stringify here so the XADD wrapper doesn't have to do
    type coercion.
    """
    return {
        "event": "turn_start",
        "turn_n": str(int(state.get("turn", 0) or 0)),
        "epoch": str(int(state.get("started_epoch", now) or now)),
        "run_id": str(state.get("run_id") or ""),
        "ts_epoch": str(now),
    }


def make_turn_end_event(
    state: dict,
    now: int,
    *,
    dispatches: int,
    skipped: int,
    idle: int,
    tokens_after: int,
) -> dict:
    """Construct the per-turn `turn_end` observability event.

    The four counters describe the turn's outcome:
      dispatches    — number of `dispatch` actions emitted
      skipped       — pipeline/signal classes considered but suppressed
      idle          — 1 iff the only emitted action was a `wait`/`wait_or_reap`
      tokens_after  — cumulative_tokens at the end of the turn
    """
    return {
        "event": "turn_end",
        "turn_n": str(int(state.get("turn", 0) or 0)),
        "epoch": str(int(state.get("started_epoch", now) or now)),
        "run_id": str(state.get("run_id") or ""),
        "dispatches": str(int(dispatches)),
        "skipped": str(int(skipped)),
        "idle": str(int(idle)),
        "tokens_after": str(int(tokens_after)),
        "ts_epoch": str(now),
    }


def make_dispatch_decision_event(
    state: dict,
    now: int,
    *,
    cls: str,
    outcome: str,
    reason: str,
) -> dict:
    """Construct one `dispatch_decision` event for a candidate class.

    `outcome` MUST be one of {dispatched, cooldown, budget, idle}.
    Unknown values are coerced to "idle" because over-counting idle
    decisions is the safe default — it never causes a stale dispatch.
    """
    if outcome not in DISPATCH_DECISION_OUTCOMES:
        outcome = "idle"
    return {
        "event": "dispatch_decision",
        "turn_n": str(int(state.get("turn", 0) or 0)),
        "class": str(cls),
        "outcome": outcome,
        "reason": str(reason),
        "ts_epoch": str(now),
    }


def make_wait_or_reap(slot: str, task_id: str, age_seconds: int, reason: str = "") -> dict:
    """Silent-wedge fallback (issue #509). Hooks are the primary slot
    accounting path; this action fires when an active slot has aged past
    `subagent_max_wall_seconds` with no matching `subagent_stop` event in
    `state.slot_events`. The autopilot turn handles it by invoking
    `reap.py completion` as a forced reap — the existing fallback CLI.

    The action carries enough metadata that the harness can dispatch the
    reap deterministically: `{slot, task_id, age_seconds, reason}`.
    """
    return {
        "type": "wait_or_reap",
        "slot": slot,
        "task_id": task_id,
        "age_seconds": int(age_seconds),
        "reason": reason,
    }


def _synthesize_worktree_branch(state: dict, slot: str) -> str:
    """Deterministic branch name for a dispatch action (issue #527).

    The Claude harness's `Agent(isolation="worktree", ...)` creates a fresh
    `worktree-agent-<hash>` branch at dispatch time — decide.py can't see
    that hash because it runs before the Agent call. Instead we stamp a
    deterministic name the playbook can also derive: the prefix matches
    `collect-state.sh`'s recognised set (`worktree-agent-*`) and the suffix
    embeds `runId`/`turn`/`slot` so the dashboard's "Watch stream" link
    has a stable `?agent=<branch>` value to filter on.

    runId is shortened to the first 8 hex chars of the UUID to keep the
    branch name terse — the dashboard only needs a stable identifier per
    dispatch, not the full UUID. If state lacks a run_id (legacy / test
    callers), we fall back to a `local` token so the prefix stays valid.
    """
    run_id = state.get("run_id") or ""
    if isinstance(run_id, str) and len(run_id) >= 8:
        run_token = run_id.replace("-", "")[:8]
    else:
        run_token = "local"
    turn = state.get("turn", 0)
    try:
        turn_token = str(int(turn))
    except (TypeError, ValueError):
        turn_token = "0"
    return f"worktree-agent-{run_token}-t{turn_token}-{slot}"


def make_dispatch_sentinel(skill: str, dispatch_id: str, run_id: str | None = None) -> str:
    """Build the hidden dispatch sentinel comment (issue #692).

    The autopilot playbook prepends this single line to the FIRST user
    message of every Agent-tool dispatch prompt. A project-scoped
    SessionStart hook (`scripts/hooks/session-start-capture.sh`) regex-
    extracts it from the session transcript and POSTs the parsed
    `(skill, dispatchId, runId)` tuple to `/api/dispatches/subagent`,
    registering the subagent session into the dispatch registry.

    Form (`runId` omitted when not in an autopilot run):

        <!-- hydra-dispatch v1 skill={skill} dispatchId={id} runId={runId} -->

    Field values are emitted verbatim; callers pass already-clean tokens
    (the skill name and the synthesised worktree branch). The hook's
    extractor reads each field independently, so field order is not load-
    bearing — but we keep the canonical order for readability.
    """
    parts = [
        "<!-- hydra-dispatch v1",
        f"skill={skill}",
        f"dispatchId={dispatch_id}",
    ]
    if run_id:
        parts.append(f"runId={run_id}")
    parts.append("-->")
    return " ".join(parts)


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
    "wait_or_reap",
})


# ---------------------------------------------------------------------------
# Plan container
# ---------------------------------------------------------------------------

@dataclass
class Plan:
    actions: list[dict] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    debug: dict[str, Any] = field(default_factory=dict)
    # Observability events emitted by this turn (issue #668, slice A of
    # autopilot observability epic #667). The list contains
    # `turn_start`, `turn_end`, and one `dispatch_decision` per candidate
    # pipeline/signal class considered. The CLI wrapper XADDs these to
    # `hydra:autopilot:slot-events` so `slot-events-bridge.ts` can
    # forward them to dashboard WS clients. `decide()` itself stays pure
    # — it only appends dicts; the side-effect lives in `main()`.
    events: list[dict] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps({
            "actions": self.actions,
            "reasons": self.reasons,
            "debug": self.debug,
            "events": self.events,
        })

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
           d) for dev_orch: `orch_work_available` signal is set (post-#458)
           e) for dev_target: `target_work_available` signal is set; the top
              /api/anchor/candidates entry is surfaced as an anchor hint
              when its score >= 0.5
           f) for research_target: top candidate score below 0.5 forces a
              research_target dispatch capped at 4/day (post-#458 this
              moved off research_orch)

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

    # Slice A of autopilot observability epic (#667 → issue #668):
    # emit `turn_start` at the very top of the decision turn so dashboard
    # WS clients can pin a "turn started" frame even if the rest of the
    # turn terminates the loop. The matching `turn_end` is emitted just
    # before `return plan` at the bottom of this function.
    plan.events.append(make_turn_start_event(state, now))

    # 1. Termination
    term = _check_termination(state, now)
    if term is not None:
        plan.add(term, reason="termination")
        plan.debug["terminate"] = term.get("cause")
        # Termination is a turn-ending decision in its own right — emit
        # `turn_end` so the dashboard's per-turn counters close cleanly.
        plan.events.append(
            make_turn_end_event(
                state,
                now,
                dispatches=0,
                skipped=0,
                idle=0,
                tokens_after=int(state.get("cumulative_tokens", 0) or 0),
            )
        )
        return plan

    # 1.5. Hook-delivered slot events (issue #509).
    #
    # `state.slot_events` is the per-turn batch read by collect-state.sh
    # from the `hydra:autopilot:slot-events` Redis stream. We translate
    # each `subagent_stop` event into the same `completion` event shape
    # consumed by step 2, AND append a structured record to
    # `state.slot_history` for operator visibility. We do this here (not
    # in step 2) so the slot-history side effect happens even if the
    # event somehow lacks the task_id required for a reap (e.g. when the
    # subagent crashed before the harness allocated one).
    #
    # `slot_waiting_permission` events get appended to
    # `state.failure_log` with a `permission_wait` pattern. The slot
    # stays active — the subagent is paused, not done.
    slot_events_raw = state.get("slot_events") or []
    if isinstance(slot_events_raw, dict):
        # Tolerate the collect-state JSON shape {"events": [...], "last_id": ...}
        slot_events_raw = slot_events_raw.get("events") or []
    synthesised_completions: list[dict] = []
    for raw_ev in slot_events_raw:
        if not isinstance(raw_ev, dict):
            continue
        fields = raw_ev.get("fields") if "fields" in raw_ev else raw_ev
        if not isinstance(fields, dict):
            continue
        kind = fields.get("event")
        if kind == "subagent_stop":
            slot = fields.get("slot") or "unknown"
            status = fields.get("status") or "unknown"
            task_id = fields.get("task_id") or ""
            summary = fields.get("summary") or ""
            try:
                ts_epoch = int(fields.get("ts_epoch") or 0)
            except (TypeError, ValueError):
                ts_epoch = 0
            # Append to slot_history (state mutation for telemetry).
            history = state.get("slot_history")
            if not isinstance(history, list):
                history = []
            history.append({
                "slot": slot,
                "status": status,
                "task_id": task_id,
                "summary": summary,
                "ts_epoch": ts_epoch,
            })
            if len(history) > SLOT_HISTORY_MAX_ENTRIES:
                history = history[-SLOT_HISTORY_MAX_ENTRIES:]
            state["slot_history"] = history
            # Failure outcomes also land in failure_log so self_heal.py
            # sees them. We don't dedup against existing failure_log
            # entries — the caller is expected to invoke decide once per
            # turn with a fresh batch.
            if status in ("failure", "budget_exceeded"):
                flog = state.get("failure_log")
                if not isinstance(flog, list):
                    flog = []
                flog.append({
                    "ts": ts_epoch or now,
                    "pattern": f"subagent_{status}",
                    "slot": slot,
                    "task_id": task_id,
                    "action": "subagent_stop",
                    "note": summary,
                })
                state["failure_log"] = flog
            # Synthesise a `completion` event so step 2's reap loop fires
            # and frees the slot. We DO require a task_id for the reap
            # to be useful — without it reap.py can't dedup.
            if task_id:
                # Best-effort token recovery from slot, if the harness
                # stamped partial_tokens. The hook itself doesn't carry
                # tokens (the harness payload doesn't expose them
                # reliably); we trust slot.partial_tokens as the floor.
                slot_obj = (state.get("slots") or {}).get(slot)
                tokens = 0
                skill = None
                if isinstance(slot_obj, dict):
                    try:
                        tokens = int(slot_obj.get("partial_tokens") or 0)
                    except (TypeError, ValueError):
                        tokens = 0
                    skill = slot_obj.get("skill")
                synthesised_completions.append({
                    "type": "completion",
                    "slot": slot,
                    "task_id": task_id,
                    "total_tokens": tokens,
                    "skill": skill,
                    "_source": "slot_events",
                })
        elif kind == "slot_waiting_permission":
            slot = fields.get("slot") or "unknown"
            prompt = fields.get("prompt") or ""
            try:
                ts_epoch = int(fields.get("ts_epoch") or 0)
            except (TypeError, ValueError):
                ts_epoch = 0
            flog = state.get("failure_log")
            if not isinstance(flog, list):
                flog = []
            flog.append({
                "ts": ts_epoch or now,
                "pattern": "permission_wait",
                "slot": slot,
                "task_id": "",
                "action": "slot_waiting_permission",
                "note": prompt,
            })
            state["failure_log"] = flog

    # Prepend synthesised completions so they precede any caller-supplied
    # `completion` events in step 2's iteration order.
    if synthesised_completions:
        events = synthesised_completions + events

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

    # 3.5. Subscription Usage Tracker eligibility gate (PR B1).
    #
    # `state.usage_eligibility` is populated by the playbook from the
    # `usage_eligibility_json=` line that collect-state.sh emits each
    # turn. The verdict has two independent levels:
    #
    #   - `allow == False`  → hard stop. The tracker reports the 5h
    #     consumption is at or above 90% of the calibrated quota. We
    #     do not dispatch any class this turn — every class is blocked.
    #   - `shed: [...]`     → soft throttle. Projected weekly consumption
    #     is over 100%. Skip those classes (today: sweep_*, discover_*,
    #     scout_orch) but keep dev_*, qa_*, research_*, design_concept_*,
    #     health.
    #
    # Missing, malformed, or uncalibrated payloads are treated as "no
    # signal" — the tracker is informational, not load-bearing for
    # correctness. We dispatch normally and let the operator notice.
    usage_eligibility = _normalize_usage_eligibility(state.get("usage_eligibility"))
    dispatch_blocked = not usage_eligibility["allow"]
    shed_classes = usage_eligibility["shed"]
    if dispatch_blocked:
        plan.debug["usage_dispatch_blocked"] = usage_eligibility["reasons"]
    if shed_classes:
        plan.debug["usage_shed"] = sorted(shed_classes)

    # 4. Pipeline dispatch
    slots = state.get("slots") or {}
    burned = set(state.get("burned_classes") or [])
    best = best_candidate(candidates)
    best_score = float(best.get("score", 0.0)) if best else 0.0

    pipeline_priority = (
        "qa_orch",
        "qa_target",
        # design_concept_orch precedes dev_orch in priority order (issue
        # #466 sequencing rule): when an orch anchor needs a fresh
        # artifact, we grill before coding. The selector below returns
        # None for dev_orch on the same turn so they don't double-fire,
        # and in warn-only mode the artifact's presence (even draft) lets
        # dev_orch proceed next turn.
        "design_concept_orch",
        "dev_orch",
        "dev_target",
        "research_orch",
        "research_target",
    )

    dispatched_any = False
    # Slice A observability bookkeeping (issue #668): count the
    # candidate classes that were skipped (any non-dispatched outcome)
    # so the `turn_end` event carries `dispatches` + `skipped` totals.
    skipped_count = 0

    for cls in pipeline_priority:
        if dispatch_blocked:
            # Budget-style suppression: usage tracker said "allow=False".
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="budget",
                    reason="usage tracker dispatch_blocked",
                )
            )
            skipped_count += 1
            continue  # do NOT break — keep emitting one event per class
        if cls in shed_classes:
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="budget",
                    reason="usage tracker shed",
                )
            )
            skipped_count += 1
            continue
        if slots.get(cls) is not None:
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="cooldown",
                    reason="slot busy",
                )
            )
            skipped_count += 1
            continue  # slot busy
        if cls in burned:
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="cooldown",
                    reason="class burned (soft-cap)",
                )
            )
            skipped_count += 1
            continue
        if scope_excluded(scope, cls):
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="idle",
                    reason=f"scope excluded ({scope})",
                )
            )
            skipped_count += 1
            continue
        action = _select_for_slot(cls, state, candidates, events, best, best_score, now)
        if action is None:
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="idle",
                    reason="selector found no eligible work",
                )
            )
            skipped_count += 1
            continue
        plan.add(action, reason=f"dispatch:{cls}")
        plan.events.append(
            make_dispatch_decision_event(
                state, now, cls=cls, outcome="dispatched",
                reason=str(action.get("reason") or "dispatched"),
            )
        )
        dispatched_any = True

    # 5. Signal classes — each is independent. Health pre-empts when sick.
    # Signal classes also respect `burned_classes`: if reap.py burned a
    # signal class on soft-cap (issue #432 — a runaway hydra-discover),
    # we must NOT re-dispatch it for the rest of this session, mirroring
    # the pipeline-slot suppression in step 4. Before #432 this check
    # was missing and only pipeline slots were honored.
    for sig in (
        "health",
        "sweep_orch",
        "sweep_target",
        "discover_orch",
        "discover_target",
        # scout_orch (issue #485, Phase B) — calendar-driven, 7d cooldown.
        # collect-state.sh emits `scout_walk_due` when the per-class
        # cooldown has elapsed; this loop honors the SIGNAL_COOLDOWNS
        # back-stop in parallel.
        "scout_orch",
    ):
        if dispatch_blocked:
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="budget",
                    reason="usage tracker dispatch_blocked",
                )
            )
            skipped_count += 1
            continue
        if sig in shed_classes:
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="budget",
                    reason="usage tracker shed",
                )
            )
            skipped_count += 1
            continue
        if scope_excluded(scope, sig):
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="idle",
                    reason=f"scope excluded ({scope})",
                )
            )
            skipped_count += 1
            continue
        if sig in burned:
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="cooldown",
                    reason="signal class burned (soft-cap)",
                )
            )
            skipped_count += 1
            continue
        # Cost-cap gate (issue #532) — checked BEFORE _select_for_signal so
        # it fires before the cooldown read. Per AC: "cost-cap gate fires
        # before cooldown gate (cap is the harder limit)". Only `scout_orch`
        # has a cost-cap today; other signal classes fall through.
        if sig == "scout_orch" and scout_cost_cap_exceeded(state):
            cap = scout_cost_cap_state(state)
            plan.debug.setdefault("scout_cost_cap_skipped", {
                "share": cap["share"],
                "cap_usd": cap["cap_usd"],
                "spend_usd": cap["spend_usd"],
            })
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="budget",
                    reason="scout cost-cap exceeded",
                )
            )
            skipped_count += 1
            continue
        action = _select_for_signal(sig, state, events, now)
        if action is None:
            # Could be cooldown OR idle (no signal present); inspect the
            # state to disambiguate. signal_is_cooled returns False when
            # we're still inside the per-class cooldown window.
            if not signal_is_cooled(state, sig, now):
                outcome = "cooldown"
                reason = f"signal cooldown active ({sig})"
            else:
                outcome = "idle"
                reason = "no triggering signal"
            plan.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome=outcome, reason=reason,
                )
            )
            skipped_count += 1
            continue
        plan.add(action, reason=f"signal:{sig}")
        plan.events.append(
            make_dispatch_decision_event(
                state, now, cls=sig, outcome="dispatched",
                reason=str(action.get("reason") or "dispatched"),
            )
        )
        dispatched_any = True

    # 5.5. Silent-wedge fallback (issue #509).
    #
    # If an active slot has aged past `subagent_max_wall_seconds` AND no
    # `subagent_stop` event arrived for its task_id, emit a
    # `wait_or_reap` action so the harness invokes reap.py as a forced
    # fallback. Hooks are the primary path; this only fires when the
    # hook itself silently failed.
    #
    # We check this AFTER dispatch decisions because a wait_or_reap is
    # a slot-clear action; mixing it into the same plan as a new
    # dispatch on the SAME slot would violate INV-006 (reap-before-
    # dispatch). The slot was busy at decision time, so no new dispatch
    # for that slot was emitted above.
    max_wall = _subagent_max_wall_seconds(state)
    # Build a set of task_ids we already saw a completion for (this
    # turn's batch — either via slot_events or caller-supplied events).
    completed_task_ids: set[str] = set()
    for ev in events:
        if ev.get("type") == "completion":
            tid = ev.get("task_id")
            if tid:
                completed_task_ids.add(tid)
    for cls, slot_obj in (slots.items() if isinstance(slots, dict) else []):
        if not isinstance(slot_obj, dict):
            continue
        started_epoch = slot_obj.get("started_epoch")
        if started_epoch is None:
            # Tolerate legacy `started` ISO8601 by attempting to parse.
            started_iso = slot_obj.get("started")
            if isinstance(started_iso, str):
                try:
                    from datetime import datetime
                    started_epoch = int(datetime.fromisoformat(started_iso.replace("Z", "+00:00")).timestamp())
                except (ValueError, TypeError):
                    started_epoch = None
        try:
            started_epoch_i = int(started_epoch) if started_epoch is not None else None
        except (TypeError, ValueError):
            started_epoch_i = None
        if started_epoch_i is None:
            continue
        age = now - started_epoch_i
        if age < max_wall:
            continue
        task_id = slot_obj.get("task_id") or ""
        if task_id and task_id in completed_task_ids:
            continue
        plan.add(
            make_wait_or_reap(
                cls,
                task_id,
                age,
                f"silent-wedge fallback: {cls} active for {age}s with no SubagentStop event (cap {max_wall}s)",
            ),
            reason=f"silent-wedge:{cls}",
        )

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

    # 7. Stamp `worktreeBranch` + `dispatchSentinel` on every dispatch action
    #    (issue #527 / issue #692).
    #
    # The dashboard's slice-4 "Watch stream" cross-link (PR #526) reads
    # `action.worktreeBranch` to scope `/agents/stream?agent=<branch>`. We
    # stamp the field here — once per plan, after dispatch decisions are
    # finalised — so every code-writing / signal-class dispatch carries a
    # stable identifier. Skip stamping a fresh branch on actions that already
    # supply one (forward-compat for selectors that learn the harness-
    # generated branch name later).
    #
    # `dispatchSentinel` (issue #692) is the hidden marker the playbook
    # prepends to the FIRST user message of the Agent-tool prompt. It uses the
    # resolved `worktreeBranch` as the stable per-dispatch id so the
    # SessionStart capture hook can join the subagent session back to this
    # turn. We stamp it for EVERY dispatch action (even ones that arrived with
    # a pre-set worktreeBranch) so no dispatch escapes session capture.
    #
    # AC10 / AC12 / AC9 schema-closure note: both fields go on the turn-row
    # JSON inside an action; they are NEVER written as a top-level field on
    # `hydra:autopilot:run:<id>`. The slice-2 turn writer serialises actions
    # verbatim, so these stamps flow through to /api/autopilot/runs/:runId
    # without further changes.
    run_id = state.get("run_id") or ""
    run_token = run_id if isinstance(run_id, str) and run_id else None
    for action in plan.actions:
        if not isinstance(action, dict):
            continue
        if action.get("type") != "dispatch":
            continue
        slot = action.get("slot")
        if not isinstance(slot, str) or not slot:
            continue
        if not action.get("worktreeBranch"):
            action["worktreeBranch"] = _synthesize_worktree_branch(state, slot)
        skill = action.get("skill")
        if isinstance(skill, str) and skill:
            action["dispatchSentinel"] = make_dispatch_sentinel(
                skill,
                action["worktreeBranch"],
                run_token,
            )

    # Slice A observability close-out (issue #668). Emit `turn_end` last
    # so the dashboard knows the turn finished decision-making cleanly
    # (vs the termination short-circuit above, which emits its own
    # `turn_end` before bailing). `idle` is 1 iff the turn produced no
    # dispatch actions at all — the heartbeat / busy-wait path.
    dispatch_count = sum(1 for a in plan.actions if isinstance(a, dict) and a.get("type") == "dispatch")
    plan.events.append(
        make_turn_end_event(
            state,
            now,
            dispatches=dispatch_count,
            skipped=skipped_count,
            idle=0 if dispatch_count > 0 else 1,
            tokens_after=int(state.get("cumulative_tokens", 0) or 0),
        )
    )

    return plan


# ---------------------------------------------------------------------------
# Internal slot selectors
# ---------------------------------------------------------------------------

def _candidate_design_concept(
    candidates: dict | None,
    best: dict | None,
) -> dict | None:
    """Return the `designConcept` sub-object on the best candidate, if any.

    ISSUE #751: no longer consumed by the decision path — the legacy
    `best.designConcept` orch-grill / dev_orch-yield branches that called
    this were removed (the candidates feed is target-product work, never an
    orch-scope grill anchor). Retained as the canonical Python-side
    description of the `designConcept` block shape that
    `src/api/anchor.ts` documents and produces.

    Phase B (issue #466) wiring: the orchestrator's anchor-candidates feed
    MAY annotate each candidate with a `designConcept` block that mirrors
    the relevant fields from `getDesignConcept(anchorRef)`:

        {
          "present": <bool>,
          "isFresh": <bool>,      # ≤7d per DESIGN_CONCEPT_MAX_AGE_MS
          "status":  "draft" | "approved" | "stale" | null,
          "gateOk":  <bool>,      # gateCheck(d).ok at the time of fetch
        }

    decide.py treats a MISSING `designConcept` block as "no information"
    rather than "no artifact" — that lets B-1 land warn-only against an
    API that hasn't been extended to surface the field yet. Once the
    candidate API is extended (a separate sub-issue under #437), the
    field will be present on every candidate and the selector below
    starts gating.

    Returns None when the field is absent OR the best candidate is None.
    """
    if not best:
        return None
    dc = best.get("designConcept")
    if not isinstance(dc, dict):
        return None
    return dc


def _design_concept_is_fresh(dc: dict | None) -> bool:
    """Phase B freshness check — true iff present AND isFresh.

    A draft/warn-only artifact (status='draft', gateOk=false) is still
    considered "fresh" here per the issue #466 grilled decision: warn-only
    proceeds — the artifact was written, the gate flagged it, the handoff
    was filed by hydra-grill, and visibility is upstream's job. Phase C
    flips this to require `gateOk` true.
    """
    if not dc:
        return False
    return bool(dc.get("present")) and bool(dc.get("isFresh"))


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
        # ISSUE #458: dev_orch must consume the orchestrator GH `ready-for-agent`
        # board, NOT /api/anchor/candidates. The unified candidates feed is
        # dominated by target-product work in this deployment (item-26x are all
        # hydra-betting tasks), and routing them to dev_orch caused hydra-dev
        # to receive target-only anchors and either escalate or misroute.
        #
        # New contract: dev_orch fires iff `orch_work_available` is set
        # (collect-state.sh sets this when `ready_for_agent > 0`). hydra-dev
        # picks its own issue from `gh issue list --label ready-for-agent`
        # on `gaberoo322/hydra` — no anchor is passed through prompt_args
        # because the candidate feed is structurally the wrong source.
        if not _signal_present(state, events, "orch_work_available"):
            return None
        # ISSUE #751: the legacy `best.designConcept` stale-suppression was
        # REMOVED here too. It read `best` from /api/anchor/candidates —
        # structurally a TARGET candidate post-#458 — and yielded dev_orch
        # when that target candidate's designConcept was stale, on the
        # assumption that `design_concept_orch` would grill it this turn.
        # That grill no longer fires for target candidates (it never should
        # have under orch scope), so the suppression would deadlock the orch
        # path: dev_orch yields, no grill fires, nothing advances. dev_orch
        # sequencing now keys ONLY off the orch-scope `orch_pending_grill_anchor`
        # signal below — the single source of truth for orch grill anchors.
        #
        # Issue #628 / #751: if `orch_pending_grill_anchor` is set, the
        # design_concept_orch selector will dispatch hydra-grill on this
        # turn — dev_orch MUST yield to maintain the grill-before-dev
        # sequencing rule. This is the ONLY remaining yield path.
        signals = state.get("signals") if isinstance(state, dict) else None
        orch_anchor = (
            signals.get("orch_pending_grill_anchor") if isinstance(signals, dict) else None
        )
        if isinstance(orch_anchor, str) and orch_anchor and orch_anchor != "none":
            return None
        return make_dispatch(cls, "hydra-dev", reason="orch board has ready-for-agent issues")
    if cls == "dev_target":
        # Use board signal (work_queue / target backlog) — dev_target dispatches
        # are driven by the target-side queue. AFTER #458 it ALSO surfaces the
        # best /api/anchor/candidates entry as an anchor hint, because the
        # unified candidates feed IS target-product work in this deployment.
        if _signal_present(state, events, "target_work_available"):
            prompt_args: dict = {}
            if best and best_score >= DEV_CONFIDENCE_THRESHOLD:
                ref = best.get("anchorRef") or best.get("issue")
                if ref is not None:
                    prompt_args["anchor"] = ref
                    prompt_args["score"] = best_score
            return make_dispatch(
                cls,
                "hydra-target-build",
                prompt_args=prompt_args,
                reason="target work queue non-empty",
            )
        return None
    if cls == "research_orch":
        # ISSUE #458: the candidate-driven force-research trigger moved to
        # research_target (the candidates feed is target-product work). The
        # orchestrator-side research force lives in the explicit
        # `needs_research` signal — that's the only path that fires
        # research_orch now. The daily cap still applies if the signal
        # repeatedly fires within a day.
        if _signal_present(state, events, "needs_research"):
            return make_dispatch(cls, "hydra-issue-research", reason="explicit needs-research signal")
        return None
    if cls == "research_target":
        # Two triggers: (a) explicit target_research_due signal, or
        # (b) best /api/anchor/candidates score below the dev threshold —
        # the candidates feed IS the target backlog, so a weak top score
        # means the target product needs more research direction (post-#458,
        # this trigger moved here from research_orch).
        if _signal_present(state, events, "target_research_due"):
            return make_dispatch(cls, "hydra-target-research", reason="target research due")
        if candidates is not None and (best is None or best_score < DEV_CONFIDENCE_THRESHOLD):
            if _research_force_allowed(state, "research_target", now):
                return make_dispatch(
                    cls,
                    "hydra-target-research",
                    prompt_args={"forced": True},
                    reason="best target-candidate below threshold; forced",
                )
        return None
    if cls == "design_concept_orch":
        # ISSUE #466 (Phase B of #437): fire `hydra-grill` for the top
        # orch candidate when it has work pending AND no fresh artifact.
        # The selector is intentionally additive to Phase A:
        #
        # - `orch_work_available` signal must be present (same gate as
        #   dev_orch).
        # - When the artifact is missing OR stale, dispatch
        #   `hydra-grill` with the anchorRef and scope='orch'. The
        #   pipeline_priority ordering (design_concept_orch BEFORE
        #   dev_orch) means dev_orch's own selector also returns None for
        #   this turn, so we don't double-fire on the same anchor.
        # - When the artifact is fresh (even warn-only), this selector
        #   returns None — Phase B treats warn-only artifacts as "fresh"
        #   so dev_orch proceeds in the same plan. Phase C will tighten
        #   to gateOk-only.
        #
        # ISSUE #628 — TWO INPUT PATHS:
        #
        #   1. `state.signals.orch_pending_grill_anchor` (preferred). A
        #      string anchorRef set by `collect-state.sh` from the orch
        #      GH `ready-for-agent` board. This is the orch-scope feed
        #      the selector was missing — `best` in /api/anchor/candidates
        #      is structurally a target-product candidate post-#458, so
        #      reading `best.designConcept` (the pre-#628 path) never
        #      fired on orch work. The collect-state loop already does
        #      the artifact-freshness lookup, so the presence of this
        #      signal IS the trigger.
        #
        #   2. `best.designConcept` (legacy fallback) — REMOVED in issue
        #      #751. The fallback read `best` from /api/anchor/candidates,
        #      which post-#458 is structurally target-product work
        #      (item-<N>). Under scope='orch' it could ONLY misfire:
        #      grilling a target candidate as an orch design concept,
        #      burning a subagent and persisting a cross-scope artifact.
        #      The candidate feed and the orch GH board are distinct
        #      sources, so the fallback's stated trigger ("orch candidate
        #      showed up in best") was structurally impossible post-#458.
        #      `orch_pending_grill_anchor` (path 1) is now the SINGLE
        #      source of truth for orch grill anchors. When it is absent
        #      or 'none', this selector returns None (no grill) and
        #      dev_orch proceeds.
        if not _signal_present(state, events, "orch_work_available"):
            return None

        signals = state.get("signals") if isinstance(state, dict) else None
        orch_anchor = (
            signals.get("orch_pending_grill_anchor") if isinstance(signals, dict) else None
        )
        if isinstance(orch_anchor, str) and orch_anchor and orch_anchor != "none":
            return make_dispatch(
                cls,
                "hydra-grill",
                prompt_args={"scope": "orch", "anchor": orch_anchor},
                reason=(
                    "orch GH ready-for-agent issue lacks fresh design-concept artifact "
                    "(Phase B warn-only, #628 orch-scope path)"
                ),
            )

        # No orch grill-pending anchor on the GH board → no orch grill.
        # (Issue #751: the legacy `best.designConcept` fallback was removed
        # because /api/anchor/candidates is target-product work, never an
        # orch-scope grill anchor.)
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
    if sig == "scout_orch":
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


def scout_cost_cap_state(state: dict) -> dict:
    """Resolve the tool-scout cost-cap inputs from state (issue #532).

    Reads (with sane fallbacks for legacy state shapes):
      - state.limits.scout_cost_share        (default SCOUT_DAILY_COST_SHARE_DEFAULT)
      - state.limits.daily_spend_cap_usd     (default DAILY_SPEND_CAP_USD_DEFAULT)
      - state.scout_spend_usd_today          (default 0.0)

    Returns a dict with the resolved floats AND a boolean `enforced` flag.
    `enforced` is False when the resolved daily cap is <= 0 (rate not
    configured) — in that case the gate is a no-op and we treat any spend
    value as below the (non-existent) cap. A `scout_cost_share` of exactly
    zero is treated as the documented kill-switch: `enforced` is True and
    `cap_usd` is 0.0, so the >= check suppresses every dispatch.

    Pure: no side effects.
    """
    limits = state.get("limits") or {}

    try:
        share = float(limits.get("scout_cost_share", SCOUT_DAILY_COST_SHARE_DEFAULT))
    except (TypeError, ValueError):
        share = SCOUT_DAILY_COST_SHARE_DEFAULT
    if not (share >= 0.0):  # NaN-safe
        share = SCOUT_DAILY_COST_SHARE_DEFAULT

    try:
        cap_total = float(limits.get("daily_spend_cap_usd", DAILY_SPEND_CAP_USD_DEFAULT))
    except (TypeError, ValueError):
        cap_total = DAILY_SPEND_CAP_USD_DEFAULT
    if not (cap_total >= 0.0):
        cap_total = DAILY_SPEND_CAP_USD_DEFAULT

    try:
        spend = float(state.get("scout_spend_usd_today", 0.0) or 0.0)
    except (TypeError, ValueError):
        spend = 0.0
    if not (spend >= 0.0):
        spend = 0.0

    cap_usd = cap_total * share

    # `enforced=True` when the operator explicitly configured a kill-switch
    # (share == 0.0) OR when there is a non-zero cap to compare against.
    # When cap_total is 0 (no rate configured) AND share > 0, the gate is a
    # no-op — `enforced=False` keeps Phase B's current behaviour intact for
    # operators who haven't opted in to HYDRA_TOKEN_USD_RATE yet.
    if share == 0.0:
        enforced = True
    else:
        enforced = cap_total > 0.0

    return {
        "share": share,
        "cap_total_usd": cap_total,
        "cap_usd": cap_usd,
        "spend_usd": spend,
        "enforced": enforced,
    }


def scout_cost_cap_exceeded(state: dict) -> bool:
    """True when the scout-orch cost-cap gate should suppress dispatch.

    Pure wrapper over `scout_cost_cap_state` — separated so callers can
    log either the bool decision or the full breakdown.
    """
    s = scout_cost_cap_state(state)
    if not s["enforced"]:
        return False
    return s["spend_usd"] >= s["cap_usd"]


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


def _xadd_observability_events(events: list[dict]) -> None:
    """Best-effort XADD of observability events (slice A of issue #667).

    Mirrors the bash hooks' XADD policy — never propagate Redis failures,
    log to stderr and move on. The events ride
    `hydra:autopilot:slot-events` alongside the hook-emitted lifecycle
    events; the field-agnostic bridge forwards every key/value pair.

    Honours HYDRA_REDIS_HOST / HYDRA_REDIS_PORT (and `docker` as a
    sentinel matching the hooks), and HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM
    for the stream key override. The XADD is fully gated behind
    `HYDRA_AUTOPILOT_EMIT_TURN_EVENTS` — when unset / falsy, decide.py
    stays a pure JSON emitter (existing test/playbook callers see no
    behaviour change). The autopilot bootstrap sets it explicitly so
    production runs emit; the test suite leaves it off.
    """
    if not events:
        return
    flag = os.environ.get("HYDRA_AUTOPILOT_EMIT_TURN_EVENTS", "").strip().lower()
    if flag not in ("1", "true", "yes", "on"):
        return
    redis_host = os.environ.get("HYDRA_REDIS_HOST", "localhost")
    redis_port = os.environ.get("HYDRA_REDIS_PORT", "6379")
    stream_key = os.environ.get(
        "HYDRA_AUTOPILOT_SLOT_EVENTS_STREAM",
        "hydra:autopilot:slot-events",
    )
    maxlen_cap = os.environ.get("HYDRA_AUTOPILOT_SLOT_EVENTS_MAXLEN", "1000")
    import subprocess
    for ev in events:
        if not isinstance(ev, dict):
            continue
        # Build `XADD <stream> MAXLEN ~ <cap> * field1 v1 field2 v2 ...`.
        args: list[str] = [
            "XADD", stream_key, "MAXLEN", "~", str(maxlen_cap), "*",
        ]
        for k, v in ev.items():
            args.extend([str(k), str(v)])
        try:
            if redis_host == "docker":
                cmd = ["docker", "exec", "hydra-redis-1", "redis-cli", *args]
            else:
                cmd = [
                    "redis-cli", "-h", redis_host, "-p", str(redis_port),
                    *args,
                ]
            subprocess.run(
                cmd,
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
            # Mirror the bash hooks' best-effort policy — log once, move on.
            print(
                f"decide.py: XADD to {stream_key} failed ({exc}); event={ev.get('event')!r}",
                file=sys.stderr,
            )


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
        _xadd_observability_events(plan.events)
        print(plan.to_json())
        return 0
    print(f"decide.py: unknown subcommand {sub!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
