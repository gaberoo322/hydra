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
  wait                 Sleep + re-enter loop (busy-wait nap while slots in
                       flight; a wait-only turn with zero occupied slots
                       terminates cleanly instead — issue #1352)
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
    # architecture_orch (#790) and retro_orch (#920) also track last-fired
    # here when they fire; absent keys default to 0 (never fired).
    # The backfill starvation floor (#2428, signal_starved) reads these same
    # timestamps to force a backfill class through the stagger if it has gone
    # dark for >24h — an absent/0 entry counts as never-fired → force-eligible.
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
MERGE POLICY (policy collapse, issue #742 / ADR-0015)
==================================================================

`should_auto_merge(tier, mechanical, has_scope_justification, qa_verdict)`:

  qa_verdict != PASS    → hold      (INV-007 guard)
  tier in {1, 2, 3, 4}  → auto-merge
  unparseable tier      → hold      (fail-safe: required depth cannot be proven)

  Merge eligibility is gated entirely by the *depth* requirements for the
  PR's tier (the QA verdict + holdback enrollment from #739/#740/#741), NOT
  by tier authority. Every tier resolves to `auto-merge` (depth met) or
  `hold` (depth not yet provably met) — there is no tier-triggered
  `queue-decision` or `apply-operator-approved` branch. The only route to
  the operator is an exhausted Deep-QA Remediation Loop (#740), which lives
  outside this function (CONTEXT.md:78, ADR-0005 amended closed list).

  `mechanical` and `has_scope_justification` are retained in the signature
  for call-site / test-helper stability but are no longer consulted.

  (ADR-0015 / issue #737 renumber: the deepest tier — Verifier Core — is T4.
  ADR-0020 Slice 2 / #743: the T4 arm flips to auto-merge on a PASS, identical
  to T1/T2/T3. decide.py stays pure and trusts the verdict; the base-ref
  `deep-qa-gate` required CI check independently enforces the SHA-bound Deep-QA
  PASS marker and fails closed if absent. INV-001 — the old plan-level "never
  auto-merge a T4 PR" guard — is retired; INV-007 remains the sole brain-side
  merge guard.)

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
# Public constants — derived from the Dispatch-Class Taxonomy (classes.json)
# ---------------------------------------------------------------------------
# scripts/autopilot/classes.json (epic #1669, slice #1670) is the single
# machine-readable table that owns the dispatch-class alphabet: one row per
# class with columns kind / skill / costClass / learningAgent /
# cooldownSeconds / scope / provenanceLabel (+ a free-form `notes` field that
# carries the per-class design rationale formerly inlined here as comments).
# decide.py derives PIPELINE_SLOTS, SIGNAL_CLASSES and SIGNAL_COOLDOWNS from
# it at import time and FAILS LOUD (TaxonomyError → non-zero exit) on a
# missing/malformed file or a row missing a required column. There is
# DELIBERATELY no fallback to embedded tuples — a silent fallback would
# resurrect the four-file taxonomy drift this table exists to kill.
#
# TaxonomyError subclasses RuntimeError (NOT SystemExit) so heartbeat.py's
# best-effort `from decide import SIGNAL_COOLDOWNS` keeps its documented
# `except Exception` degrade path, while any CLI invocation of decide.py
# still exits non-zero with the message.
#
# The brain keeps all POLICY — selectors, cooldown enforcement, scope masks
# (SCOPE_*_EXCLUDE), the BACKFILL_SIGNAL_CLASSES stagger set, cost-cap gates.
# The table is only the ALPHABET (ADR-0012). Row order in the file IS the
# dispatch order of the derived tuples.

_TAXONOMY_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "classes.json"
)

# Every column must be PRESENT on every row (nullable columns carry an
# explicit null, never an absent key) so a projection miss is loud.
_TAXONOMY_REQUIRED_COLUMNS = (
    "name",
    "kind",
    "skill",
    "costClass",
    "learningAgent",
    "cooldownSeconds",
    "scope",
    "provenanceLabel",
)

_TAXONOMY_KINDS = ("pipeline", "signal")
_TAXONOMY_SCOPES = ("orch", "target", "both")
_TAXONOMY_LEARNING_AGENTS = ("planner", "executor")


class TaxonomyError(RuntimeError):
    """classes.json is missing, malformed, or violates the row contract.

    Raised at import time (issue #1670) — decide.py refuses to start
    without a valid Dispatch-Class Taxonomy. NEVER caught internally to
    fall back to embedded tuples.
    """


def _taxonomy_fail(reason: str) -> "TaxonomyError":
    return TaxonomyError(
        f"decide.py: dispatch-class taxonomy {_TAXONOMY_PATH}: {reason} "
        "— refusing to start (no fallback tuples; epic #1669 / issue #1670)"
    )


def _load_class_taxonomy(path: str) -> tuple[dict, ...]:
    """Load + validate classes.json. Hard-fails on any contract violation."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        raise _taxonomy_fail("file is missing") from None
    except json.JSONDecodeError as exc:
        raise _taxonomy_fail(f"malformed JSON ({exc})") from None

    if not isinstance(raw, dict) or not isinstance(raw.get("classes"), list):
        raise _taxonomy_fail('top level must be an object with a "classes" list')
    rows = raw["classes"]
    if not rows:
        raise _taxonomy_fail('"classes" list is empty')

    seen_names: set[str] = set()
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            raise _taxonomy_fail(f"row {i} is not an object")
        missing = [c for c in _TAXONOMY_REQUIRED_COLUMNS if c not in row]
        if missing:
            raise _taxonomy_fail(
                f"row {i} ({row.get('name', '?')}) lacks required column(s): "
                + ", ".join(missing)
            )
        name = row["name"]
        if not isinstance(name, str) or not name:
            raise _taxonomy_fail(f"row {i}: name must be a non-empty string")
        if name in seen_names:
            raise _taxonomy_fail(f"duplicate class name: {name}")
        seen_names.add(name)
        if row["kind"] not in _TAXONOMY_KINDS:
            raise _taxonomy_fail(
                f"{name}: kind must be one of {_TAXONOMY_KINDS}, got {row['kind']!r}"
            )
        if not isinstance(row["skill"], str) or not row["skill"]:
            raise _taxonomy_fail(f"{name}: skill must be a non-empty string")
        if not isinstance(row["costClass"], str) or not row["costClass"]:
            raise _taxonomy_fail(f"{name}: costClass must be a non-empty string")
        if row["learningAgent"] is not None and (
            row["learningAgent"] not in _TAXONOMY_LEARNING_AGENTS
        ):
            raise _taxonomy_fail(
                f"{name}: learningAgent must be null or one of "
                f"{_TAXONOMY_LEARNING_AGENTS}, got {row['learningAgent']!r}"
            )
        if row["scope"] not in _TAXONOMY_SCOPES:
            raise _taxonomy_fail(
                f"{name}: scope must be one of {_TAXONOMY_SCOPES}, got {row['scope']!r}"
            )
        if row["provenanceLabel"] is not None and (
            not isinstance(row["provenanceLabel"], str) or not row["provenanceLabel"]
        ):
            raise _taxonomy_fail(
                f"{name}: provenanceLabel must be null or a non-empty string"
            )
        cooldown = row["cooldownSeconds"]
        if row["kind"] == "signal":
            # bool is an int subclass in Python — exclude it explicitly.
            if isinstance(cooldown, bool) or not isinstance(cooldown, int) or cooldown < 0:
                raise _taxonomy_fail(
                    f"{name}: signal rows need a non-negative integer "
                    f"cooldownSeconds, got {cooldown!r}"
                )
        elif cooldown is not None:
            raise _taxonomy_fail(
                f"{name}: pipeline rows must carry cooldownSeconds: null "
                f"(slots have no class cooldown), got {cooldown!r}"
            )

    return tuple(rows)


# The validated row tuple, exposed for future slices (#1671 folds the TS
# projections; decide.py itself only consumes the three derivations below).
CLASS_TAXONOMY = _load_class_taxonomy(_TAXONOMY_PATH)

PIPELINE_SLOTS = tuple(r["name"] for r in CLASS_TAXONOMY if r["kind"] == "pipeline")

SIGNAL_CLASSES = tuple(r["name"] for r in CLASS_TAXONOMY if r["kind"] == "signal")

# Class -> skill projection (issue #3274). The cascade-routing escalation
# re-dispatch (`_rule_escalation`) needs the skill for the class it is
# re-dispatching; derive it from the taxonomy alphabet so the escalation path
# can never name a skill that drifts from the class's real dispatch skill.
CLASS_SKILL = {r["name"]: r["skill"] for r in CLASS_TAXONOMY}

# Cooldowns for signal-driven classes (seconds). Mirrors the legacy
# /tmp/hydra-last-*.txt files but lives inside state.json now. Per-class
# cadence rationale lives in the row's `notes` field in classes.json.
SIGNAL_COOLDOWNS = {
    r["name"]: r["cooldownSeconds"] for r in CLASS_TAXONOMY if r["kind"] == "signal"
}

# Board-idle backfill set (issue #959, epic #958). Both classes key off the
# single unified `orch_backfill_idle` signal and share a 1h cadence, so on a
# fully-idle turn both could otherwise dispatch at once and whipsaw the board.
# The one-per-turn stagger guard in `_rule_signals` lets at most ONE of these
# dispatch per turn; round-robin across turns emerges for free from the
# per-class 1h cooldowns (the class that fired stamps its cooldown, so the
# OTHER class is the only eligible one next idle turn) — NO persistent rotation
# state needed, keeping decide.py a pure function of (state, events, now).
# retro_orch (run-anchored, 24h) and scout_orch (7d walk + cost-cap) are
# deliberately NOT in this set.
BACKFILL_SIGNAL_CLASSES = ("discover_orch", "architecture_orch")

# Backfill starvation floor (issue #2428). The one-per-turn stagger guard above
# means that on a busy run a staggered backfill class (discover_orch /
# architecture_orch) can LOSE the stagger slot every idle turn and go fully dark
# for a day or more — nobody chose that, it just emerges from the round-robin.
# The floor is a safety net: a backfill class that has NOT dispatched in
# >BACKFILL_STARVATION_FLOOR_SEC AND is otherwise eligible this turn (idle
# signal present, not saturated, not burned, cooled, in scope) BYPASSES the
# stagger suppression so it is forced through. Derived purely from the existing
# `signal_last_fired` timestamp (the same source signal_is_cooled reads) + now,
# so decide.py stays a pure function of (state, events, now) with NO new
# rotation state. cleanup_orch is exempt from the stagger guard entirely (it
# co-fires every idle turn) so it can never starve and needs no floor.
#
# An UNSEEN class (no signal_last_fired entry) is treated as having NEVER run,
# so it is floor-eligible immediately — the first idle turn after a fresh
# bootstrap forces any still-dark backfill class through rather than letting the
# stagger starve it for another full window.
BACKFILL_STARVATION_FLOOR_SEC = 24 * 60 * 60

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


def _normalize_emergency_brake(raw) -> dict:
    """Normalize the operator-only emergency-brake state (issue #744).

    `state.emergency_brake` is sourced from the `emergency_brake_json=` line
    emitted by collect-state.sh, which comes from
    `GET /api/autopilot/emergency-brake`. The autopilot side tolerates a
    missing / malformed field because:
      - the orchestrator can be unreachable mid-bootstrap
      - the playbook is a prompt and may drop the field on a bad turn
      - older state.json files (pre-#744) won't have the field at all

    Returns the canonical shape `{"engaged": bool}`.

    CRITICAL fail-safe direction: missing / malformed / non-dict input →
    `{"engaged": False}` (brake DISENGAGED). The brake is the exceptional,
    operator-asserted state; the default and the fail-open are both "off" so a
    transient orchestrator outage can never silently wedge auto-merge off. An
    operator who wants the brake held will see it re-asserted from Redis on the
    next turn once the orchestrator is reachable again.
    """
    if not isinstance(raw, dict):
        return {"engaged": False}
    return {"engaged": raw.get("engaged") is True}

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

# Per-cycle dev_target cost cap (issue #1059, leaf of epic #1052). Mirrors the
# Orchestrator's retired per-cycle dollar circuit-breaker pattern (the
# HYDRA_PER_CYCLE_COST_CAP_USD knob; src/cost/cap.ts was removed in #704 once
# HYDRA_TOKEN_USD_RATE went structurally $0) and the live scout cost-share gate
# above. This is a HIGH backstop, NOT a throttle: it only fires on a runaway
# cycle that has already burned through a large dollar budget on Target builds.
# Slices 3/5/6 (QA, mutation, retro) raise per-cycle Target spend on the single
# self-hosted runner, so a backstop guards against an unbounded dispatch loop.
#
# The default is deliberately high ($25/cycle) so day-to-day cycles never touch
# it. Operators tune it via `state.limits.per_cycle_cost_cap_usd` (or the
# bootstrap env var of the same shape). A value of 0 disables the gate entirely
# (no-op) — matching the scout gate's "rate not configured" degrade path, since
# no live USD rate exists on this deployment yet (#704). Spend is read from
# `state.dev_target_spend_usd_cycle` (default 0.0); absent that key the gate is
# a clean no-op, so legacy state shapes keep today's behaviour.
PER_CYCLE_COST_CAP_USD_DEFAULT = 25.0

# Per-run cap on how many wire-or-retire items the resolver may advance
# (design concept for #2722, epic #2720): "At most 2 items resolved per run,
# oldest-first." Threaded into `prompt_args.max_items` on every
# `wire_or_retire_target` dispatch so the cap is machine-enforceable at the
# dispatch seam, not prose-only.
WIRE_OR_RETIRE_MAX_ITEMS = 2

# Interim risk carve-out for `wire_or_retire_target` (issue #2722, epic #2720):
# modules under these prefixes / paths ALWAYS route ready-for-human and NEVER
# get a WIRE/RETIRE verdict. It is a machine-readable module-level constant —
# NOT prose in a comment — precisely because prose-only carve-outs are the
# documented failure mode (item-685/687 were laundered past the prose
# protocol). It is threaded verbatim into `prompt_args.risk_carveout` on every
# dispatch so the guard is auditable in the dispatch record and unit-testable.
# Deliberately a SUPERSET of TARGET_RISK_CORE's directories: over-routing to
# human is safe, under-routing is not. Successor: #2701's classifyTargetRisk,
# at which point this hardcoded list is retired.
WIRE_OR_RETIRE_RISK_CARVEOUT = (
    "web/src/lib/risk/",
    "web/src/lib/execution/",
    "web/src/lib/kalshi/kalshi-executor.ts",
)

# Per-run cap on how many design-QA findings the visual-review pass may file
# (issue #2739, parent #2732): "file AT MOST 3 deduped needs-triage items per
# run". Threaded into `prompt_args.max_items` on every design_qa_target
# dispatch so the cap is machine-enforceable at the dispatch seam, not
# prose-only — the same discipline as WIRE_OR_RETIRE_MAX_ITEMS above.
DESIGN_QA_TARGET_MAX_ITEMS = 3

# Slots that are scope-disallowed exclusion mask. Scope filter is an
# exclusion mask (grilled decision 3); `health` and `qa_*` are always
# allowed regardless of scope (qa reviews any PR, health is whole-system).
SCOPE_ORCH_ONLY_EXCLUDE = (
    "dev_target", "research_target", "qa_target", "sweep_target", "discover_target",
    # cleanup_target scans the TARGET (~/hydra-betting) and files target-
    # backlog items — target-scope by definition, so orch-only excludes it
    # (the mirror of cleanup_orch's place in SCOPE_TARGET_ONLY_EXCLUDE).
    "cleanup_target",
    # wire_or_retire_target (issue #2722, epic #2720) resolves Target
    # wire-or-retire backlog items (the judgment counterpart to
    # cleanup_target's mechanical sweep) — target-scope by definition, so
    # orch-only excludes it, mirroring cleanup_target above.
    "wire_or_retire_target",
    # design_qa_target (issue #2739, parent #2732) captures the Target's
    # nav-registry screenshot set and judges each page against the Target
    # design-language ADR, filing Target-backlog items — target-scope by
    # definition, so orch-only excludes it, mirroring cleanup_target /
    # wire_or_retire_target above.
    "design_qa_target",
)
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
    # architecture_orch (issue #790) scans the orchestrator's own codebase
    # architecture and emits orch-scope issues — orch-scope by definition.
    # Under `target-only` the autopilot stays out of orch work, so
    # architecture_orch is excluded (no architecture_target mirror yet; the
    # Target has a PR merge backlog, #718).
    "architecture_orch",
    # retro_orch (issue #920) analyses the orchestrator's OWN autopilot runs
    # and emits orch-scope improvement proposals (prompt/doc/code fixes to the
    # orchestrator + its subagents) — orch-scope by definition. Under
    # `target-only` the autopilot stays out of orch work, so retro_orch is
    # excluded, mirroring scout_orch / architecture_orch.
    "retro_orch",
    # cleanup_orch (issue #960) runs a deterministic dead-code / simplification
    # scan over the ORCHESTRATOR's own codebase and files orch-scope issues —
    # orch-scope by definition. Under `target-only` the autopilot stays out of
    # orch work, so cleanup_orch is excluded, mirroring scout_orch /
    # architecture_orch / retro_orch. Its Target mirror (`cleanup_target`,
    # operator-approved 2026-06-10 once the Target merge queue proved healthy —
    # the #718 PR-backlog blocker that deferred it is resolved) is target-scope
    # and so lives in SCOPE_ORCH_ONLY_EXCLUDE instead.
    "cleanup_orch",
    # skill_prune (issue #2949, epic #2944) prunes the ORCHESTRATOR's own
    # playbook-generated skills (docs/operator-playbooks/*.md) — orch-scope by
    # definition, the eval-gated prompt counterpart to cleanup_orch's mechanical
    # code sweep. Under `target-only` the autopilot stays out of orch work, so
    # skill_prune is excluded, mirroring scout_orch / architecture_orch /
    # retro_orch / cleanup_orch above.
    "skill_prune",
    # wayfinder_orch (issue #3351, epic #3350, ADR-0029) works the next unblocked
    # frontier ticket on an open approved orchestrator `wayfinder:map` — orch-scope
    # by definition (the maps live on the orchestrator GH board). Under
    # `target-only` the autopilot stays out of orch work, so wayfinder_orch is
    # excluded, mirroring scout_orch / architecture_orch / retro_orch / cleanup_orch
    # / skill_prune above.
    "wayfinder_orch",
)

# 5-retry escalation per pattern (issue #426 AC; failure modes section).
MAX_FAILURE_RETRIES = 5

# Default failure-log path consumed by self_heal.py when called from outside
# decide.py (e.g. the Bash hook around dispatch).
DEFAULT_FAILURE_LOG = "/tmp/hydra-autopilot-failures.jsonl"


# ---------------------------------------------------------------------------
# Cascade-routing escalation policy (issue #3274, design-concept issue-3274)
# ---------------------------------------------------------------------------
#
# SOTA cascade routing (RouteLLM / FrugalGPT): run a cheap tier, verify, and
# escalate to a stronger tier ONLY on a failed/no-op attempt. Hydra's cheapest
# same-turn verifier signal is the subagent STOP STATUS (success/no_op/failure/
# budget_exceeded) emitted by on-subagent-stop.sh — NOT CI (CI is asynchronous
# and emits no signal back into the turn; the async CI-failure trigger is a
# deferred Slice-B, per the design concept's rejected-alternatives + qaTrace).
#
# LAYERING (design-concept invariant 2): this policy is a decide.py CONSTANT,
# NOT a classes.json field. classes.json is the class-taxonomy ALPHABET; dispatch
# POLICY lives here + in the playbook. A class ABSENT from this dict never
# escalates (invariant 5) — so dev_orch (already Sonnet) is untouched.
#
# PURITY (design-concept invariant 1, issue #1093): decide.py emits NO concrete
# model field. `decide_escalation` returns only an `escalate_model` HINT that the
# playbook's dispatch step maps to the Agent model kwarg, overriding the static
# routing table for that one re-dispatch. The model lever stays in the playbook.
#
# Each policy row: triggers (the failure_log patterns that escalate), model (the
# escalate-to HINT), max_attempts (the hard cap — default 2, so a Haiku attempt
# escalates to at most ONE Sonnet retry, never a third dispatch; invariant 4).
#
# The two mapped stop statuses (see `_STOP_STATUS_TO_PATTERN`):
#   no_op   -> "subagent_noop"    (agent claimed no work)
#   failure -> "subagent_failure" (a real capability/verification failure)
#   budget_exceeded -> "subagent_failure" (folded — a hard-cap trip is a failure)
ESCALATION_POLICY: dict[str, dict] = {
    # cleanup_orch runs at Haiku and empirically premature-exits (no_op in
    # seconds). Escalate a no_op ONLY on a fresh (non-saturated) board — a
    # SATURATION-driven no_op (board full / no knip findings) would just
    # re-produce the same no_op at Sonnet cost (design-concept invariant 3 +
    # qaTrace ROI answer). A real verification/emit failure is capability-driven
    # and escalates regardless of saturation.
    "cleanup_orch": {
        "triggers": ("subagent_noop", "subagent_failure"),
        "model": "sonnet",
        "max_attempts": 2,
    },
}

# Default attempt cap when a policy row omits `max_attempts` (invariant 4).
ESCALATION_DEFAULT_MAX_ATTEMPTS = 2

# Map an on-subagent-stop.sh stop status to the failure_log pattern the
# escalation reducer keys on. `success` maps to None (clean completion never
# escalates). budget_exceeded folds onto subagent_failure — a hard-cap trip is a
# capability/runaway failure, not a saturation no_op.
_STOP_STATUS_TO_PATTERN: dict[str, str] = {
    "no_op": "subagent_noop",
    "failure": "subagent_failure",
    "budget_exceeded": "subagent_failure",
}


def stop_status_to_pattern(status: str | None) -> str | None:
    """Pure: map a stop status to its escalation-trigger pattern, or None.

    `success` / `unknown` / anything unmapped → None (never escalates). Kept a
    standalone pure function so both `_rule_slot_events` (failure_log visibility)
    and `decide_escalation` (the reducer) read the SAME mapping.
    """
    if not status:
        return None
    return _STOP_STATUS_TO_PATTERN.get(status)


def decide_escalation(
    *,
    slot: str,
    status: str | None,
    attempt: int,
    board_saturated: bool,
) -> dict:
    """Cascade-routing escalation reducer (issue #3274, prototyped 8/8 cases).

    PURE. Given one subagent StopOutcome, decide whether to re-dispatch the same
    class at a stronger model tier. Returns:

        {"escalate": bool, "escalate_model": str | None, "reason": str}

    `escalate_model` is a HINT the playbook maps to the Agent model kwarg — this
    function NEVER assigns a concrete model onto a dispatch action (decide.py
    stays pure, issue #1093 / design-concept invariant 1).

    Logic (design-concept qaTrace, prototype branch=logic):
      1. ESCALATION_POLICY[slot] absent  -> never escalate (invariant 5).
      2. status maps to a pattern NOT in the row's triggers -> no escalate.
      3. attempt >= max_attempts (default 2) -> no escalate (no attempt-3;
         invariant 4). `attempt` is the attempt number of the dispatch that JUST
         stopped (1 = the original cheap-tier run), sourced purely from the
         completing slot's `attempt` field (default 1 when unstamped).
      4. SATURATION GUARD (invariant 3): pattern == "subagent_noop" AND
         board_saturated -> suppress. A saturation no_op is work-availability-
         driven, not model-capability-driven. A "subagent_failure" is
         capability-driven and escalates regardless of saturation.
      5. else escalate=True, escalate_model = policy["model"].
    """
    no = lambda reason: {"escalate": False, "escalate_model": None, "reason": reason}

    policy = ESCALATION_POLICY.get(slot)
    if not policy:
        return no(f"{slot} not in ESCALATION_POLICY")

    pattern = stop_status_to_pattern(status)
    if pattern is None:
        return no(f"status {status!r} is not an escalation trigger")
    triggers = policy.get("triggers") or ()
    if pattern not in triggers:
        return no(f"pattern {pattern} not in {slot} triggers")

    max_attempts = int(policy.get("max_attempts", ESCALATION_DEFAULT_MAX_ATTEMPTS))
    try:
        attempt_i = int(attempt)
    except (TypeError, ValueError):
        attempt_i = 1
    if attempt_i >= max_attempts:
        return no(f"attempt {attempt_i} >= max_attempts {max_attempts}")

    if pattern == "subagent_noop" and board_saturated:
        return no(f"{slot} no_op on saturated board — suppress (saturation-driven)")

    return {
        "escalate": True,
        "escalate_model": policy["model"],
        "reason": f"{slot} {pattern} attempt {attempt_i} -> escalate to {policy['model']}",
    }


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


def make_route_prs_to_review(reason: str) -> dict:
    """Emergency-brake action (issue #744).

    Emitted exactly once per turn when the operator-only emergency brake is
    engaged, IN PLACE OF any `auto-merge` actions. decide() is pure and cannot
    enumerate open PRs (no gh/network), so this action carries no per-PR list:
    the playbook executes it by calling the server-side endpoint that lists
    open PRs (gh) and arms the /hydra-review pickup set via the existing
    reviewPickupArmed seam (src/redis/review.ts, #745). There is intentionally
    NO `make_engage_brake` / `make_disengage_brake` counterpart — the brake is
    operator-only and the autopilot has no write path to the flag.
    """
    return {"type": "route-prs-to-review", "reason": reason}


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

# `stagger` (issue #959, epic #958): a backfill-set class (BACKFILL_SIGNAL_CLASSES)
# that WOULD have dispatched this turn but was held back because another backfill
# class already dispatched — the one-per-turn anti-whipsaw guard. It is distinct
# from `idle` (no triggering signal) and `cooldown` (inside the per-class window):
# the class is fully eligible, just deferred to the next idle turn. Dashboard
# consumers only act on outcome==="dispatched", so this new value is ignored by
# them; it exists for turn-journal observability.
DISPATCH_DECISION_OUTCOMES = frozenset({"dispatched", "cooldown", "budget", "idle", "stagger"})


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


def make_cascade_escalation_event(
    state: dict,
    now: int,
    *,
    cls: str,
    attempt: int,
    trigger_reason: str,
    from_model: str,
    to_model: str,
) -> dict:
    """Construct one `cascade_routing_escalation` telemetry event (issue #3284).

    Emitted by `_rule_escalation` the moment the cascade reducer decides to
    re-dispatch a cheap-tier class at a stronger model. It records WHICH class
    escalated, the attempt number of the escalated re-dispatch, the trigger
    (the stop-status→pattern that fired the escalation, e.g. `subagent_noop` /
    `subagent_failure`), and the cheap→strong model tiers.

    The event carries the model TIERS (not a token cost) because the cost delta
    is not known at decision time — the escalated dispatch has not run yet. The
    aggregation lens (src/autopilot/cascade-telemetry.ts) joins these records to
    the per-class token surrogate to derive the realised cost delta.

    Rides `hydra:autopilot:slot-events` alongside the other decide.py
    observability events; the field-agnostic bridge forwards it verbatim.
    Every value is string-serialisable for XADD.
    """
    return {
        "event": "cascade_routing_escalation",
        "turn_n": str(int(state.get("turn", 0) or 0)),
        "run_id": str(state.get("run_id") or ""),
        "class": str(cls),
        "attempt": str(int(attempt)),
        "trigger_reason": str(trigger_reason),
        "from_model": str(from_model),
        "to_model": str(to_model),
        "ts_epoch": str(now),
    }


def make_cascade_blocked_event(
    state: dict,
    now: int,
    *,
    cls: str,
    trigger_reason: str,
    to_model: str,
    block_reason: str,
) -> dict:
    """Construct one `cascade_routing_blocked` telemetry event (issue #3284).

    Emitted by `_rule_escalation` when the Subscription Usage Tracker hard-stop
    (`dispatch_blocked`) suppresses an escalation the cascade reducer would
    OTHERWISE have fired. It answers the "is the gate too restrictive?" question
    the issue flags: without this event a throttled escalation is invisible and
    cannot be told apart from "cascading never triggered".

    `block_reason` is the gate verdict (today always the usage hard-stop);
    `to_model` is the escalate-to tier the gate suppressed. `trigger_reason` is
    the stop-status→pattern that WOULD have escalated. Every value is
    string-serialisable for XADD.
    """
    return {
        "event": "cascade_routing_blocked",
        "turn_n": str(int(state.get("turn", 0) or 0)),
        "run_id": str(state.get("run_id") or ""),
        "class": str(cls),
        "trigger_reason": str(trigger_reason),
        "to_model": str(to_model),
        "block_reason": str(block_reason),
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
    # Issue #744: emitted (in place of auto-merge) while the operator-only
    # emergency brake is engaged — routes open PRs to the /hydra-review pickup
    # set. Note there is deliberately NO engage/disengage action type here:
    # the brake is operator-only, so the autopilot has no write path to it.
    "route-prs-to-review",
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
    # Freshness stamp (issue #1732): the run_id + turn of the state this
    # plan was decided against. heartbeat.py's `post_turn` refuses to
    # attribute a plan whose stamp does not match the live state — the
    # default plan path (/tmp/hydra-autopilot-plan.json) frequently holds
    # a stale plan from a previous run, which misattributed foreign-run
    # dispatch actions into turn records (runs ebcfebd2/b2422e61,
    # 2026-06-11). Stamped by decide() from its input state; None when
    # the state carries no run_id (test fixtures, isolated runs).
    run_id: str | None = None
    turn: int | None = None

    def to_json(self) -> str:
        return json.dumps({
            "actions": self.actions,
            "reasons": self.reasons,
            "debug": self.debug,
            "events": self.events,
            "run_id": self.run_id,
            "turn": self.turn,
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

      "auto-merge"  — call `gh pr review --approve && gh pr merge`
      "hold"        — required verification depth not (yet) provably met; do nothing

    POLICY COLLAPSE (issue #742, ADR-0015): merge eligibility is gated
    entirely by the *depth* requirements for the PR's tier (the QA verdict +
    holdback enrollment from #739/#740/#741) and the Deep-QA Remediation Loop
    (#740) — NOT by tier authority. There is no longer a tier-triggered
    `queue-decision` or `apply-operator-approved` route: every tier resolves
    to `auto-merge` (depth met) or `hold` (depth not yet provably met). The
    ONLY surviving route to the operator is an exhausted remediation loop
    (a 2nd failed deep-QA pass on T4, #740) — that escalation lives outside
    this function (CONTEXT.md:78, ADR-0005 amended closed list).

    `qa_verdict` is the QA-bot's structured verdict literal: PASS / FAIL /
    PENDING. Anything other than "PASS" returns "hold" so INV-007 holds.

    `mechanical` and `has_scope_justification` are RETAINED for call-site /
    test-helper stability (the qaEvent() helper still passes them) but are no
    longer consulted by the merge policy — tier authority no longer gates the
    decision. Keeping the signature stable avoids churning every call site in
    this PR; dropping the params is a separate opportunistic cleanup.

    T4 (Verifier Core) returns `auto-merge` on a PASS, identical in shape to
    T1/T2/T3 (ADR-0020 Slice 2 / #743). The plane split is "decide.py trusts,
    CI enforces" (ADR-0020 Decision 3/5): this function is pure over the
    `qa-verdict` event and CANNOT see the Deep-QA PASS marker, so it *trusts*
    that the skill ran the deep branch and emits `auto-merge` on PASS. The
    independent enforcement of the T4 depth lives entirely in CI — the base-ref
    `deep-qa-gate` required check verifies the SHA-bound Deep-QA PASS marker
    and fails closed (blocking the merge in branch protection) if the marker is
    absent, even when this function emitted `auto-merge`. INV-001 (the old
    plan-level "never auto-merge a T4 PR" guard) is retired in this slice — a
    guard that cannot see the marker is theater; INV-007 (`qa_verdict==PASS`)
    is retained as the sole brain-side merge guard.

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
        # Unparseable tier → cannot prove the required verification depth was
        # met → fail-safe to hold (never auto-merge an unknown tier).
        return "hold"
    if t in (1, 2, 3, 4):
        # T1/T2/T3/T4: a PASS verdict → auto-merge for every tier. Tier
        # authority no longer gates the decision; scope review is a CI concern
        # and the T4 depth guarantee is the base-ref `deep-qa-gate` required
        # check (the SHA-bound Deep-QA PASS marker), not a brain-side branch.
        # decide.py trusts the verdict; CI enforces the marker (ADR-0020).
        return "auto-merge"
    # Unknown tier → fail-safe hold (cannot prove required depth).
    return "hold"


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


def signal_starved(
    state: dict, signal: str, now: int, floor_sec: int = BACKFILL_STARVATION_FLOOR_SEC
) -> bool:
    """True iff `signal` has not fired within `floor_sec` (the starvation floor).

    Issue #2428 — the read-only predicate behind the backfill starvation floor.
    Reads the same `signal_last_fired[<class>]` timestamp signal_is_cooled reads
    (the dispatcher-stamped last-run time), so it is a pure function of (state,
    now).

    An UNSEEN class (absent / null / 0 timestamp) is deliberately NOT starved.
    "Never fired" is the normal cold-start state right after a bootstrap — every
    backfill class is unseen then, and treating them all as starved would force
    them ALL through every idle turn and defeat the one-per-turn stagger
    entirely. The round-robin already drains a cold start fairly over successive
    turns; the floor is strictly a safety net for a class that DID run and then
    got starved out for >floor_sec, which only a real (non-zero) last-fired
    timestamp can evidence.

    Pure: never mutates state and never touches fs/network/Redis.
    """
    last = (state.get("signal_last_fired") or {}).get(signal, 0) or 0
    try:
        last_i = int(last)
    except (TypeError, ValueError):
        last_i = 0
    if last_i <= 0:
        # Never seen → cold-start, not starvation. Let the stagger round-robin
        # drain it normally; the floor only protects a class with a real prior
        # last-fired time that has since gone dark for >floor_sec.
        return False
    return (now - last_i) >= floor_sec


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
    """Read the candidate feed's precomputed `research_recommended` flag.

    `src/anchor-candidates.ts` is the single source of truth for "the
    target board is empty / top score is too weak → recommend research"
    (it applies RESEARCH_THRESHOLD). Both the research_target slot and the
    dev_target steer slot consume this one flag rather than each re-deriving
    a private score threshold, so the dispatch/research boundary has a single
    home and cannot silently diverge (issue #1129 finished).

    A missing/unusable payload (feed unreachable, or no `candidates` array)
    defaults to True — degrade toward research direction rather than
    starving the target backlog. This mirrors the pre-#1129 inline check,
    whose `best is None` arm fired research whenever the feed produced no
    top candidate.
    """
    if not candidates_payload:
        return True
    # A payload that doesn't carry a `candidates` list isn't a real
    # /api/anchor/candidates response (feed degraded / wrong shape). The
    # feed only stamps `research_recommended` alongside that array, so its
    # absence means "no usable candidate signal" → default to research,
    # matching the old `best is None` arm rather than reading the absent
    # flag as a falsy "do not research".
    if not isinstance(candidates_payload.get("candidates"), list):
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
# Per-step decision rules (issue #932)
# ---------------------------------------------------------------------------
#
# `decide()` (below) was historically a single ~570-line body in which nine
# inline steps all mutated one shared `plan` accumulator and read
# `state`/`events`/`now` inline. Each step is now lifted into its own pure
# rule function: it takes the read-only inputs it needs and RETURNS the
# actions / events / debug (and any rule-specific signals) it contributes,
# rather than reaching into a shared `plan`. `decide()` stays the deep entry
# point and the single ordered composition (the fold): it owns the decision
# ORDER, the INV-006 "reap before dispatch" guarantee, and the
# turn_start/turn_end bookkeeping; each rule owns its POLICY.
#
# This is the same deep-entry-point-over-pure-rules shape that
# `src/health-diagnostics.ts` and `src/aggregators/autopilot-health.ts`
# already adopted. The split is OUTPUT-EQUIVALENT — pinned by
# `test/autopilot-decide.test.mts` (and the decide-events / invariants /
# retro-class suites): no decision semantics change here.
#
# A few rules still MUTATE `state` (slot_history / failure_log appends in
# `_rule_slot_events`, signal-last-fired stamping inside the selectors). That
# side effect predates this refactor and the wire contract depends on it, so
# the owning rule keeps doing it explicitly — the change is structural, not a
# semantics change.


@dataclass
class _RuleOutput:
    """The contribution a single decision rule folds into the Plan.

    A rule is a pure ``(read-only inputs) -> _RuleOutput`` function. `decide()`
    folds each output into the running `Plan` in the documented order. Keeping
    `actions`/`reasons`/`events`/`debug` parallel to `Plan`'s own fields means
    the fold is a straight extend/update — no rule reaches into `Plan`.

    Rule-specific signals the fold needs are carried as explicit fields so the
    ordering logic in `decide()` stays readable:

      - `terminate`     — set by the termination rule; a non-None value tells
                          `decide()` to short-circuit the turn.
      - `dispatched`    — count of real `dispatch`/signal actions this rule
                          emitted (folds into `dispatched_any`).
      - `skipped`       — count of considered-but-not-dispatched classes
                          (folds into the `turn_end` `skipped` total).
    """

    actions: list[dict] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    debug: dict[str, Any] = field(default_factory=dict)
    terminate: dict | None = None
    dispatched: int = 0
    skipped: int = 0

    def emit(self, action: dict, reason: str = "") -> None:
        """Append an action (and optional reason) — mirrors Plan.add."""
        self.actions.append(action)
        if reason:
            self.reasons.append(reason)


def _rule_termination(state: dict, now: int) -> _RuleOutput:
    """Step 1 — termination check (budget / wall-clock / idle / 5-failure backstop).

    Returns a `_RuleOutput` whose `terminate` is the lone `terminate` action
    when tripped (and an early `turn_end` event, since termination is a
    turn-ending decision in its own right), or an empty output otherwise.
    """
    out = _RuleOutput()
    term = _check_termination(state, now)
    if term is None:
        return out
    out.emit(term, reason="termination")
    out.debug["terminate"] = term.get("cause")
    out.terminate = term
    # Termination is a turn-ending decision in its own right — emit
    # `turn_end` so the dashboard's per-turn counters close cleanly.
    out.events.append(
        make_turn_end_event(
            state,
            now,
            dispatches=0,
            skipped=0,
            idle=0,
            tokens_after=int(state.get("cumulative_tokens", 0) or 0),
        )
    )
    return out


def _rule_slot_events(state: dict, now: int) -> tuple[_RuleOutput, list[dict]]:
    """Step 1.5 — hook-delivered slot events (issue #509).

    Translates each `subagent_stop` event from `state.slot_events` into the
    `completion` event shape consumed by the reap rule, AND appends a
    structured record to `state.slot_history` for operator visibility.
    `slot_waiting_permission` events get appended to `state.failure_log` with a
    `permission_wait` pattern (the slot stays active — the subagent is paused,
    not done).

    This rule MUTATES `state` (slot_history / failure_log) — that telemetry
    side effect predates the #932 refactor and the wire contract depends on it,
    so it stays explicit here. It produces no plan actions; instead it RETURNS
    the synthesised `completion` events as the tuple's second element so
    `decide()` can prepend them to the event stream before the reap rule runs.
    """
    out = _RuleOutput()
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
            #
            # Issue #3274: `no_op` also lands here now (as pattern
            # `subagent_noop`) so it is VISIBLE to self_heal.classify() and the
            # cascade-routing escalation reducer. Previously a no_op was treated
            # as clean completion and recorded nowhere self_heal could see it.
            # Recording it changes VISIBILITY only — escalation is a separate,
            # gated decision in `_rule_escalation` (design-concept invariant 6).
            #
            # failure/budget_exceeded keep their EXACT prior `subagent_<status>`
            # spelling (self_heal + termination-counting semantics depend on it),
            # so we do NOT route them through the reducer's status->pattern fold
            # here — only ADD the net-new `no_op` case.
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
            elif status == "no_op":
                flog = state.get("failure_log")
                if not isinstance(flog, list):
                    flog = []
                flog.append({
                    "ts": ts_epoch or now,
                    "pattern": "subagent_noop",
                    "slot": slot,
                    "task_id": task_id,
                    "action": "subagent_stop",
                    "note": summary,
                })
                state["failure_log"] = flog
            # Synthesise a `completion` event so the reap rule fires and
            # frees the slot. We DO require a task_id for the reap to be
            # useful — without it reap.py can't dedup.
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
    return out, synthesised_completions


def _rule_completion_reaps(events: list[dict]) -> _RuleOutput:
    """Step 2 — completion reaps first (INV-006 — reap before dispatch).

    This rule is the ONLY producer of `reap` actions, and it MUST fire for
    every subagent completion — pipeline OR signal class. We intentionally do
    NOT filter by PIPELINE_SLOTS / SIGNAL_CLASSES membership: a reap for an
    unknown class is still safer than a missed reap (reap.py is idempotent and
    the unknown-class path is a no-op on slot bookkeeping). The `class` key is
    accepted as a synonym of `slot`.
    """
    out = _RuleOutput()
    for ev in events:
        if ev.get("type") != "completion":
            continue
        slot = ev.get("slot") or ev.get("class")
        task_id = ev.get("task_id")
        tokens = int(ev.get("total_tokens") or 0)
        skill = ev.get("skill")
        if slot and task_id:
            out.emit(make_reap(slot, task_id, tokens, skill), reason=f"reap:{slot}")
    return out


# Per-class board-saturation signal name for the escalation saturation guard
# (issue #3274). A `no_op` only suppresses escalation when THIS class's board is
# saturated (work-availability-driven no_op). A class not listed here has no
# saturation notion, so `board_saturated` reads False for it (a failure still
# escalates regardless; a no_op escalates on the assumption real work existed).
ESCALATION_SATURATION_SIGNAL = {
    "cleanup_orch": "cleanup_board_saturated",
}


def _rule_escalation(
    state: dict, events: list[dict], now: int, *, dispatch_blocked: bool = False
) -> tuple[_RuleOutput, set[str]]:
    """Cascade-routing escalation re-dispatch (issue #3274, design-concept issue-3274).

    Runs AFTER completion reaps (INV-006 — the just-stopped slot is reaped/freed
    before this rule re-dispatches into it). For each `subagent_stop` event this
    turn whose class is in `ESCALATION_POLICY`, consult the pure `decide_escalation`
    reducer; when it says escalate, emit a re-dispatch `dispatch` action for the
    SAME class carrying:

      - `prompt_args.escalate_model` — the escalate-to model HINT (e.g. "sonnet").
        decide.py stays pure (issue #1093 / invariant 1): it NEVER writes a
        concrete `model` field on the action; the playbook maps this hint to the
        Agent model kwarg, overriding the static per-class routing table for this
        one re-dispatch.
      - `prompt_args.attempt` — the escalated attempt number (prior_attempt + 1).
        The playbook stamps this onto the new slot so a subsequent no_op of the
        ESCALATION attempt reads attempt>=max_attempts and never triggers a THIRD
        dispatch (invariant 4).
      - `prompt_args.prior_attempt_status` — the stop status that triggered the
        escalation, for cycle-metric visibility (issue's priorAttemptStatus field).

    The attempt counter is sourced PURELY from the completing slot's `attempt`
    field (default 1 when unstamped — the original cheap-tier dispatch). The
    saturation flag is the precomputed per-class board-saturation signal read via
    the signal seam (decide.py never recomputes saturation).

    Returns `(out, escalated_slots)` — the second element is the set of class
    slots this rule re-dispatched into THIS turn. `decide()` threads it into
    `_rule_signal_classes` (step 5) so a signal class that the escalation rule
    already re-dispatched (the same reaped slot) is suppressed there — otherwise
    a `cleanup_orch` no_op on an idle board (`orch_backfill_idle=true`) would
    double-dispatch: once as the escalation re-dispatch here (step 2.5) and again
    as the ordinary signal-class dispatch (step 5), since `fold()` does not
    mutate `state["slots"]` so the signal rule reads the still-null reaped slot
    and fires independently. This mirrors the pipeline rule's
    `slots.get(cls) is not None` slot-busy guard for the escalation seam that
    dispatches into a reaped (still-null) slot within the same turn (issue #3274,
    QA blocker).

    `dispatch_blocked` is the Subscription Usage Tracker hard-stop verdict
    (`_rule_usage_eligibility`, step 3.5). When True the escalation re-dispatch is
    suppressed wholesale — mirroring the identical guard in `_rule_pipeline_dispatch`
    and `_rule_signal_classes` (issue #3274, QA blocker). Without this guard the
    escalation rule (step 2.5, ahead of the gate) could emit a MORE expensive
    Sonnet re-dispatch near budget exhaustion — the exact opposite of the cost
    win. `decide()` therefore hoists the pure usage-eligibility read ahead of this
    rule so `dispatch_blocked` is available here while the reap->escalate->auto-merge
    ordering (INV-006) is preserved.

    Pure w.r.t. fs/network/Redis; reads state.slot_events + state.slots + signals.
    """
    out = _RuleOutput()
    escalated_slots: set[str] = set()
    if dispatch_blocked:
        out.debug["escalation_usage_dispatch_blocked"] = True
    slot_events_raw = state.get("slot_events") or []
    if isinstance(slot_events_raw, dict):
        slot_events_raw = slot_events_raw.get("events") or []
    slots = state.get("slots") or {}
    for raw_ev in slot_events_raw:
        if not isinstance(raw_ev, dict):
            continue
        fields = raw_ev.get("fields") if "fields" in raw_ev else raw_ev
        if not isinstance(fields, dict):
            continue
        if fields.get("event") != "subagent_stop":
            continue
        slot = fields.get("slot") or "unknown"
        if slot not in ESCALATION_POLICY:
            continue
        status = fields.get("status") or "unknown"
        # Attempt number of the dispatch that JUST stopped (1 = original).
        slot_obj = slots.get(slot)
        try:
            prior_attempt = int(slot_obj.get("attempt")) if isinstance(slot_obj, dict) and slot_obj.get("attempt") is not None else 1
        except (TypeError, ValueError):
            prior_attempt = 1
        sat_signal = ESCALATION_SATURATION_SIGNAL.get(slot)
        board_saturated = bool(sat_signal and _signal_present(state, events, sat_signal))

        decision = decide_escalation(
            slot=slot,
            status=status,
            attempt=prior_attempt,
            board_saturated=board_saturated,
        )
        if not decision.get("escalate"):
            continue
        trigger_reason = stop_status_to_pattern(status) or status
        # Cascade telemetry (issue #3284): the escalation reducer says escalate.
        # Under the usage hard stop, we STILL walk here (unlike the previous
        # blanket early-return) so we can distinguish "cascading never triggered"
        # from "the gate throttled a would-be escalation" — the latter emits a
        # `cascade_routing_blocked` observability event and dispatches nothing,
        # exactly mirroring the suppress-but-record contract.
        if dispatch_blocked:
            out.events.append(
                make_cascade_blocked_event(
                    state,
                    now,
                    cls=slot,
                    trigger_reason=trigger_reason,
                    to_model=decision["escalate_model"],
                    block_reason="usage_dispatch_blocked",
                )
            )
            continue
        skill = CLASS_SKILL.get(slot, "")
        out.emit(
            make_dispatch(
                slot,
                skill,
                prompt_args={
                    "escalate_model": decision["escalate_model"],
                    "attempt": prior_attempt + 1,
                    "prior_attempt_status": status,
                },
                reason=decision["reason"],
            ),
            reason=decision["reason"],
        )
        # Cascade telemetry (issue #3284): record the realised escalation. The
        # event rides the slot-events stream alongside the dispatch; the
        # aggregation lens joins it to the per-class token surrogate for the
        # realised cost delta.
        out.events.append(
            make_cascade_escalation_event(
                state,
                now,
                cls=slot,
                attempt=prior_attempt + 1,
                trigger_reason=trigger_reason,
                # cheap tier is whatever the class ran at (Haiku, per classes.json);
                # the reducer's `escalate_model` is the strong tier it escalates to.
                from_model=str((slot_obj or {}).get("model") or "haiku") if isinstance(slot_obj, dict) else "haiku",
                to_model=decision["escalate_model"],
            )
        )
        out.dispatched += 1
        escalated_slots.add(slot)
    return out, escalated_slots


def _rule_auto_merge_sweep(state: dict, events: list[dict]) -> _RuleOutput:
    """Step 3 — auto-merge sweep (before dispatch so freed PRs don't compete).

    Emergency-brake gate (issue #744): the operator-only brake overrides the
    ADR-0015 depth-gated verdict at THIS call site — NOT inside
    `should_auto_merge()`, which stays a pure depth-policy function. When the
    brake is engaged we emit ZERO `auto-merge` actions and exactly ONE
    `route-prs-to-review` action. `decide()` never reads/writes the brake from
    Redis — it arrives as the read-only `state.emergency_brake` field.
    """
    out = _RuleOutput()
    emergency_brake = _normalize_emergency_brake(state.get("emergency_brake"))
    if emergency_brake["engaged"]:
        out.debug["emergency_brake_engaged"] = True
        out.emit(
            make_route_prs_to_review("emergency brake engaged — all auto-merge paused, routing open PRs to /hydra-review"),
            reason="emergency-brake:route-prs-to-review",
        )
        # Skip the per-PR auto-merge sweep entirely — the brake overrides the
        # depth verdict, so no qa-verdict event can produce an auto-merge.
        return out
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
        # Policy collapse (#742): should_auto_merge() returns only
        # "auto-merge" or "hold" — no tier-triggered queue-decision /
        # apply-operator-approved. Operator escalation now arrives solely
        # via the Deep-QA Remediation Loop (#740), not from this sweep.
        if decision == "auto-merge":
            out.emit(make_auto_merge(pr_number, tier, "qa pass + required depth met"), reason=f"auto-merge:#{pr_number}")
        # "hold" → no action (required verification depth not yet provably met)
    return out


def _rule_usage_eligibility(state: dict) -> tuple[_RuleOutput, bool, set[str]]:
    """Step 3.5 — Subscription Usage Tracker eligibility gate (PR B1).

    Returns `(output, dispatch_blocked, shed_classes)`. The dispatch rules
    (pipeline + signals) consult `dispatch_blocked` (hard stop — block every
    class this turn) and `shed_classes` (soft throttle — skip those classes).
    Missing / malformed payloads are treated as "no signal" — the tracker is
    informational, not load-bearing for correctness.
    """
    out = _RuleOutput()
    usage_eligibility = _normalize_usage_eligibility(state.get("usage_eligibility"))
    dispatch_blocked = not usage_eligibility["allow"]
    shed_classes = usage_eligibility["shed"]
    if dispatch_blocked:
        out.debug["usage_dispatch_blocked"] = usage_eligibility["reasons"]
    if shed_classes:
        out.debug["usage_shed"] = sorted(shed_classes)
    return out, dispatch_blocked, shed_classes


def _rule_pipeline_dispatch(
    state: dict,
    candidates: dict | None,
    events: list[dict],
    scope: str,
    now: int,
    *,
    dispatch_blocked: bool,
    shed_classes: set[str],
) -> _RuleOutput:
    """Step 4 — pipeline dispatch over the fixed slots, in priority order.

    A free slot is filled iff the class is allowed by the usage gate, the slot
    is free, the class isn't burned (soft-cap, #395) or scope-excluded, and the
    selector finds eligible work. One `dispatch_decision` event is emitted per
    candidate class (dispatched OR skipped) for observability (issue #668).
    """
    out = _RuleOutput()
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

    for cls in pipeline_priority:
        if dispatch_blocked:
            # Budget-style suppression: usage tracker said "allow=False".
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="budget",
                    reason="usage tracker dispatch_blocked",
                )
            )
            out.skipped += 1
            continue  # do NOT break — keep emitting one event per class
        if cls in shed_classes:
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="budget",
                    reason="usage tracker shed",
                )
            )
            out.skipped += 1
            continue
        if slots.get(cls) is not None:
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="cooldown",
                    reason="slot busy",
                )
            )
            out.skipped += 1
            continue  # slot busy
        if cls in burned:
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="cooldown",
                    reason="class burned (soft-cap)",
                )
            )
            out.skipped += 1
            continue
        if scope_excluded(scope, cls):
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="idle",
                    reason=f"scope excluded ({scope})",
                )
            )
            out.skipped += 1
            continue
        # Per-cycle cost-cap backstop (issue #1059) — checked BEFORE the
        # selector so a runaway cycle halts further dev_target sub-dispatch
        # regardless of available work. HIGH cap: this is a runaway backstop,
        # not a throttle. Only `dev_target` carries this cap today; other
        # pipeline classes fall through. Mirrors the scout cost-cap gate's
        # "cap is the harder limit, checked first" placement (issue #532).
        if cls == "dev_target" and dev_target_cost_cap_exceeded(state):
            cap = dev_target_cost_cap_state(state)
            out.debug.setdefault("dev_target_cost_cap_skipped", {
                "cap_usd": cap["cap_usd"],
                "spend_usd": cap["spend_usd"],
            })
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="budget",
                    reason="dev_target per-cycle cost-cap exceeded",
                )
            )
            out.skipped += 1
            continue
        action = _select_for_slot(cls, state, candidates, events, best, best_score, now)
        if action is None:
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="idle",
                    reason="selector found no eligible work",
                )
            )
            out.skipped += 1
            continue
        out.emit(action, reason=f"dispatch:{cls}")
        out.events.append(
            make_dispatch_decision_event(
                state, now, cls=cls, outcome="dispatched",
                reason=str(action.get("reason") or "dispatched"),
            )
        )
        out.dispatched += 1

    out.debug["best_score"] = best_score
    return out


def _rule_signal_classes(
    state: dict,
    events: list[dict],
    scope: str,
    now: int,
    *,
    dispatch_blocked: bool,
    shed_classes: set[str],
    escalated_slots: set[str],
) -> _RuleOutput:
    """Step 5 — signal classes (health / sweep_* / discover_* / scout / arch / retro).

    `escalated_slots` is the set of class slots the escalation rule (step 2.5,
    `_rule_escalation`) already re-dispatched THIS turn. A signal class present
    in it is skipped here so it never double-dispatches: on an idle board a
    `cleanup_orch` no_op both trips the escalation re-dispatch (step 2.5) and
    would otherwise re-fire as an ordinary `orch_backfill_idle` signal-class
    dispatch (step 5). `fold()` does not mutate `state["slots"]`, so without this
    guard the signal rule reads the still-null reaped slot and fires a second,
    duplicate `dispatch cleanup_orch` in the same plan (issue #3274, QA blocker).
    This is the signal-rule analogue of `_rule_pipeline_dispatch`'s
    `slots.get(cls) is not None` slot-busy guard.

    Each is independent. Signal classes also respect `burned_classes` (issue
    #432). For `scout_orch` the cost-cap gate (issue #532) fires BEFORE the
    cooldown read ("cap is the harder limit"). One `dispatch_decision` event is
    emitted per candidate signal class for observability.

    Board-idle backfill stagger (issue #959, epic #958): the two backfill-set
    classes (BACKFILL_SIGNAL_CLASSES) now share the unified `orch_backfill_idle`
    signal at a 1h cadence, so on a fully-idle turn both would otherwise emit a
    real dispatch and whipsaw the board. `backfill_dispatched` tracks whether a
    backfill class has ALREADY dispatched this turn; once one has, the loop
    records a `stagger` decision for the remaining backfill classes instead of
    a second real dispatch. The guard is applied AFTER `_select_for_signal`
    (so a saturated class — which returns None there — never consumes the slot,
    keeping the saturation cap the FIRST gate) and only to a class that would
    otherwise dispatch. Round-robin across turns emerges from the per-class 1h
    cooldowns, with no persistent rotation state.
    """
    out = _RuleOutput()
    burned = set(state.get("burned_classes") or [])
    backfill_dispatched = False
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
        # architecture_orch (issue #790) — idle-time fallback. Registered in
        # the dispatch iteration tuple so a real dispatch sets
        # dispatched_any=True, which yields idle=0 for the turn and stops
        # idle_turns from accumulating while a fallback is eligible (the AC
        # is met by being a real dispatch, NOT by editing the terminate path).
        "architecture_orch",
        # retro_orch (issue #920, parent #917) — daily per-run retrospective.
        # Registered LAST in the signal iteration so it is the lowest-priority
        # signal class: pipeline slots dispatch first (step 4), then the other
        # signal classes, and only then is spare capacity spent on a retro.
        # The 24h class cooldown (SIGNAL_COOLDOWNS) is honored by the shared
        # signal_is_cooled guard inside _select_for_signal.
        "retro_orch",
        # cleanup_orch (issue #960, parent #958) — board-idle backfill that runs
        # the deterministic dead-code / simplification detector. Keyed off the
        # same `orch_backfill_idle` signal as the backfill set but deliberately
        # NOT in BACKFILL_SIGNAL_CLASSES (no one-per-turn stagger): the
        # high-confidence mechanical workhorse runs hot, gated only by its own
        # `cleanup_board_saturated` cap + the 1h class cooldown.
        "cleanup_orch",
        # cleanup_target — the Target mirror: demote-only dead-export sweep
        # over ~/hydra-betting, filing target-backlog items. Keyed off
        # `target_backfill_idle`, capped by `target_cleanup_board_saturated`
        # (checked FIRST in the selector) + the 1h class cooldown.
        "cleanup_target",
        # wire_or_retire_target (issue #2722, epic #2720) — the JUDGMENT
        # counterpart to cleanup_target: resolves open `wire-or-retire`-labelled
        # Target backlog items sitting in the triage lane into a WIRE / RETIRE /
        # UNCLEAR verdict. Keyed off `wire_or_retire_target_available`; the 24h
        # class cooldown (seeded in bootstrap.sh, #2575 class) enforces the
        # once-per-day cadence. NOT in BACKFILL_SIGNAL_CLASSES.
        "wire_or_retire_target",
        # design_qa_target (issue #2739, parent #2732) — periodic VISUAL QA of
        # the Target UI: captures the nav-registry screenshot set and judges each
        # page against the Target design-language ADR, filing at most 3 deduped
        # needs-triage Target-backlog items per run. Calendar cadence like
        # scout_orch: the 7d class cooldown (seeded in bootstrap.sh, #2575 class)
        # owns cadence; `design_qa_target_saturated` is the anti-flood cap checked
        # FIRST in the selector, `design_qa_target_due` the presence signal. NOT
        # in BACKFILL_SIGNAL_CLASSES. Registered last as the lowest-priority
        # signal class — spare capacity only.
        "design_qa_target",
        # skill_prune (issue #2949, epic #2944) — the eval-gated PROMPT
        # counterpart to cleanup_orch's mechanical dead-CODE sweep: prunes the
        # Orchestrator's playbook-generated skills one at a time along the Pocock
        # taxonomy. Keyed off the same `orch_backfill_idle` spare-capacity signal
        # as architecture_orch/cleanup_orch, but the 7d class cooldown
        # (scout_orch's calendar discipline) is the primary cadence and
        # `skill_prune_board_saturated` is the anti-flood cap checked FIRST in the
        # selector. NOT in BACKFILL_SIGNAL_CLASSES (rate-limits on its own 7d
        # cooldown, not the one-per-turn stagger — like cleanup_orch). Registered
        # last as a lowest-priority signal class — spare capacity only.
        "skill_prune",
        # wayfinder_orch (issue #3351, epic #3350, ADR-0029) — the single AFK
        # working class for wayfinder maps. Fires on the pre-resolved
        # `wayfinder_orch_frontier` signal (collect-state.sh owns the native
        # GraphQL frontier enumeration; decide.py reads the resolved ticket ref
        # verbatim — the signal-seam discipline). 1h class cooldown, one frontier
        # ticket per fire. NOT in BACKFILL_SIGNAL_CLASSES (map-anchored, not
        # idle-backfill). Registered last as a lowest-priority signal class —
        # spare capacity only, never preempting a pipeline dispatch.
        "wayfinder_orch",
    ):
        if dispatch_blocked:
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="budget",
                    reason="usage tracker dispatch_blocked",
                )
            )
            out.skipped += 1
            continue
        if sig in shed_classes:
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="budget",
                    reason="usage tracker shed",
                )
            )
            out.skipped += 1
            continue
        if sig in escalated_slots:
            # The escalation rule (step 2.5) already re-dispatched this class
            # into the reaped slot THIS turn; suppress the ordinary signal-class
            # dispatch so the plan carries exactly one dispatch for the slot
            # (issue #3274 QA blocker — the idle-board cleanup_orch no_op
            # double-dispatch). Analogue of the pipeline rule's slot-busy guard.
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="cooldown",
                    reason="slot already re-dispatched by escalation this turn",
                )
            )
            out.skipped += 1
            continue
        if scope_excluded(scope, sig):
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="idle",
                    reason=f"scope excluded ({scope})",
                )
            )
            out.skipped += 1
            continue
        if sig in burned:
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="cooldown",
                    reason="signal class burned (soft-cap)",
                )
            )
            out.skipped += 1
            continue
        # Cost-cap gate (issue #532) — checked BEFORE _select_for_signal so
        # it fires before the cooldown read. Per AC: "cost-cap gate fires
        # before cooldown gate (cap is the harder limit)". Only `scout_orch`
        # has a cost-cap today; other signal classes fall through.
        if sig == "scout_orch" and scout_cost_cap_exceeded(state):
            cap = scout_cost_cap_state(state)
            out.debug.setdefault("scout_cost_cap_skipped", {
                "share": cap["share"],
                "cap_usd": cap["cap_usd"],
                "spend_usd": cap["spend_usd"],
            })
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="budget",
                    reason="scout cost-cap exceeded",
                )
            )
            out.skipped += 1
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
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome=outcome, reason=reason,
                )
            )
            out.skipped += 1
            continue
        # Board-idle backfill stagger (issue #959): at most ONE backfill-set
        # class dispatches per turn. `action` is non-None here, so this class
        # passed its saturation cap + cooldown + presence checks and WOULD
        # dispatch — but if another backfill class already did so this turn,
        # record a `stagger` decision instead of a second real dispatch.
        #
        # Starvation floor (issue #2428): a backfill class that has not fired in
        # >24h is FORCED through even when another backfill class already
        # dispatched this turn — the stagger round-robin must never let a quality
        # class go dark for a full day. The floor is checked AFTER the saturation
        # cap / cooldown / scope / burned gates above (all of which already
        # passed, since `action` is non-None) so a starved class can NEVER bypass
        # the saturation cap (the FIRST gate) — it only overrides the
        # one-per-turn stagger. The starved dispatch does NOT consume the
        # backfill_dispatched slot for other (non-starved) classes: it is an
        # additive exception, not a replacement for the round-robin winner.
        if sig in BACKFILL_SIGNAL_CLASSES:
            starved = signal_starved(state, sig, now)
            if backfill_dispatched and not starved:
                out.events.append(
                    make_dispatch_decision_event(
                        state, now, cls=sig, outcome="stagger",
                        reason="board-idle backfill: another backfill class already dispatched this turn",
                    )
                )
                out.skipped += 1
                continue
            if not backfill_dispatched:
                backfill_dispatched = True
            if starved:
                # Annotate the forced dispatch so the audit trail shows the floor
                # (not the round-robin) selected it. Mutating action["reason"]
                # here is safe — `action` is this turn's freshly-built dict.
                action["reason"] = (
                    f"backfill starvation floor (>24h since last {sig}): "
                    + str(action.get("reason") or "dispatched")
                )
        out.emit(action, reason=f"signal:{sig}")
        out.events.append(
            make_dispatch_decision_event(
                state, now, cls=sig, outcome="dispatched",
                reason=str(action.get("reason") or "dispatched"),
            )
        )
        out.dispatched += 1
    return out


def _rule_silent_wedge(state: dict, events: list[dict], now: int) -> _RuleOutput:
    """Step 5.5 — silent-wedge fallback (issue #509).

    If an active slot has aged past `subagent_max_wall_seconds` AND no
    `subagent_stop` event arrived for its task_id, emit a `wait_or_reap` so the
    harness invokes reap.py as a forced fallback. Hooks are the primary path;
    this only fires when the hook itself silently failed.

    Checked AFTER dispatch decisions because a wait_or_reap is a slot-clear
    action; the slot was busy at decision time so no new dispatch for that slot
    was emitted (INV-006 reap-before-dispatch preserved).
    """
    out = _RuleOutput()
    slots = state.get("slots") or {}
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
        out.emit(
            make_wait_or_reap(
                cls,
                task_id,
                age,
                f"silent-wedge fallback: {cls} active for {age}s with no SubagentStop event (cap {max_wall}s)",
            ),
            reason=f"silent-wedge:{cls}",
        )
    return out


def _rule_idle_fallback(
    state: dict, *, dispatched_any: bool, plan_has_actions: bool
) -> _RuleOutput:
    """Step 6 — idle fallback.

    Issue #1352: a wait-only turn with zero occupied slots now TERMINATES the
    run cleanly (`cause=idle`) instead of emitting an idle-heartbeat `wait`.
    The `claude -p` print-mode session physically exits the moment the model
    emits its final message — a foreground 900s sleep never happens, so the
    old heartbeat wait was a fiction: the process died one second after the
    plan and the ExecStopPost reap backstop stamped the run `interrupted`
    (13/13 sampled ended runs, 0 drillable retro dispatches). Per ADR-0021 D5
    continuity comes from the pace-gate relaunch, not from one immortal
    session, so ending the run here loses nothing — it just records the
    designed exit as the clean idle drain it actually is.

    Slots in flight keep the old behaviour: background dispatches hold the
    print-mode process alive and re-invoke it on completion, so a short
    busy-wait nap is real there. A turn that emitted other actions (merges,
    reaps, queue-decisions) but no dispatch also keeps the heartbeat wait —
    terminating mid-housekeeping is not this rule's call.

    Also records the `occupied_slots` debug hint.
    """
    out = _RuleOutput()
    slots = state.get("slots") or {}
    occupied = sum(1 for v in slots.values() if v is not None)
    if not dispatched_any and occupied == 0 and not plan_has_actions:
        out.emit(
            make_terminate(
                "idle",
                merged_prs=int(state.get("merged_prs", 0) or 0),
                reason="wait-only turn, no slots in flight — print-mode session exits on wait; clean idle drain (issue #1352)",
            ),
            reason="idle-drain",
        )
        out.debug["idle_fallback"] = "terminate"
    elif not dispatched_any and occupied == 0:
        out.emit(make_wait(WALL_CLOCK_HEARTBEAT_SEC, "idle heartbeat"), reason="heartbeat")
    elif not dispatched_any:
        # Pipeline is busy but we have nothing new to do — short nap
        out.emit(make_wait(60, "pipeline-busy nap"), reason="busy-wait")
    out.debug["occupied_slots"] = occupied
    return out


def _stamp_dispatch_metadata(actions: list[dict], state: dict) -> None:
    """Step 7 — stamp `worktreeBranch` + `dispatchSentinel` on dispatch actions.

    Mutates `actions` in place (issue #527 / issue #692). The dashboard's
    slice-4 "Watch stream" cross-link reads `action.worktreeBranch`; the
    `dispatchSentinel` is the hidden marker the playbook prepends to the FIRST
    user message so the SessionStart capture hook can join the subagent session
    back to this turn. We stamp it for EVERY dispatch action (even ones that
    arrived with a pre-set worktreeBranch) so no dispatch escapes session
    capture. Both fields go on the turn-row JSON inside an action — NEVER as a
    top-level field on `hydra:autopilot:run:<id>`.
    """
    run_id = state.get("run_id") or ""
    run_token = run_id if isinstance(run_id, str) and run_id else None
    for action in actions:
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


# ---------------------------------------------------------------------------
# The main decision function
# ---------------------------------------------------------------------------

def decide(
    state: dict,
    candidates: dict | None,
    events: Iterable[dict] | None = None,
    now: int | None = None,
) -> Plan:
    """Return a Plan (typed action list) for this tick.

    Pure: no side effects. Reads `state`, `candidates`, and `events` and
    returns a fresh Plan. The caller (the playbook / model) executes the
    actions in order.

    `now` (issue #2713) is the decision clock as a unix epoch. Injecting it
    makes decide() a reproducibly pure function of its arguments, so the
    golden-plan regression suite (test/decide-golden.test.mts) can replay
    captured production `(state, candidates, events)` triples and assert the
    verbatim Plan. `main()` supplies real wall-clock time; when omitted
    (legacy in-process callers), decide() falls back to `time.time()`.

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
    now = int(time.time()) if now is None else int(now)

    # Issue #1732 — stamp the plan with the (run_id, turn) identity of the
    # state it was decided against, so heartbeat.py can verify the plan file
    # it reads belongs to THIS run/turn before attributing its actions to a
    # turn record. Pure: derived solely from the input state.
    # Issue #1769 — main() bumps state.turn and persists it atomically BEFORE
    # calling decide(), so this stamp equals the persisted state.json turn by
    # construction (decide.py CLI is the SINGLE writer of the turn counter;
    # the model session must never write it). The stamp itself stays a pure
    # read of the input state — the bump is a main()-side CLI effect.
    run_id_raw = state.get("run_id")
    plan.run_id = str(run_id_raw) if run_id_raw else None
    plan.turn = int(state.get("turn", 0) or 0)

    limits = state.get("limits") or {}
    scope = str(limits.get("scope", "all"))

    def fold(out: _RuleOutput) -> None:
        """Merge a rule's contribution into the running Plan, in place.

        The fold is a straight extend/update because `_RuleOutput` mirrors the
        `Plan` fields — no rule reaches into `Plan` directly. `actions` and
        `reasons` are already paired by the rule's `emit()`, so we extend both.
        """
        plan.actions.extend(out.actions)
        plan.reasons.extend(out.reasons)
        plan.events.extend(out.events)
        plan.debug.update(out.debug)

    # Slice A of autopilot observability epic (#667 → issue #668):
    # emit `turn_start` at the very top of the decision turn so dashboard
    # WS clients can pin a "turn started" frame even if the rest of the
    # turn terminates the loop. The matching `turn_end` is emitted just
    # before `return plan` at the bottom of this function.
    plan.events.append(make_turn_start_event(state, now))

    # 1. Termination — a turn-ending decision; short-circuit when tripped.
    term_out = _rule_termination(state, now)
    fold(term_out)
    if term_out.terminate is not None:
        return plan

    # 1.5. Hook-delivered slot events (issue #509). Mutates state
    # (slot_history / failure_log) and returns synthesised `completion`
    # events. We prepend those so they precede any caller-supplied
    # `completion` events in the reap rule's iteration order.
    slot_out, synthesised_completions = _rule_slot_events(state, now)
    fold(slot_out)
    if synthesised_completions:
        events = synthesised_completions + events

    # 2. Completion reaps first (INV-006 — reap before dispatch).
    fold(_rule_completion_reaps(events))

    # 2.4. Subscription Usage Tracker eligibility gate (PR B1). Read AHEAD of the
    #      escalation rule (step 2.5) — `_rule_usage_eligibility` is pure over
    #      `state` alone, so hoisting it does not disturb the
    #      reap->escalate->auto-merge ordering (INV-006). The verdict threads into
    #      the escalation rule AND the dispatch rules below as `dispatch_blocked`
    #      (hard stop — no dispatch of ANY class, including the escalation
    #      re-dispatch, issue #3274 QA blocker) + `shed_classes` (soft throttle).
    usage_out, dispatch_blocked, shed_classes = _rule_usage_eligibility(state)
    fold(usage_out)

    # 2.5. Cascade-routing escalation re-dispatch (issue #3274). Runs AFTER the
    #      completion reaps above so the just-stopped slot is freed before this
    #      rule re-dispatches into it at a stronger model tier (INV-006). A
    #      no_op / failure of a class in ESCALATION_POLICY (today: cleanup_orch
    #      at Haiku) re-dispatches once at the escalate_model HINT, gated by the
    #      saturation guard + attempt cap in `decide_escalation`. `dispatch_blocked`
    #      hard-suppresses the re-dispatch under the usage gate so a cheap-tier
    #      no_op cannot trigger a MORE expensive Sonnet escalation near budget
    #      exhaustion (issue #3274 QA blocker) — mirroring the pipeline/signal rules.
    escalation_out, escalated_slots = _rule_escalation(
        state, events, now, dispatch_blocked=dispatch_blocked
    )
    fold(escalation_out)

    # 3. Auto-merge sweep — before dispatch so freed PRs don't compete with
    #    new work; emergency brake (issue #744) overrides the depth verdict.
    fold(_rule_auto_merge_sweep(state, events))

    # 4. Pipeline dispatch (the fixed slots, in priority order).
    pipeline_out = _rule_pipeline_dispatch(
        state, candidates, events, scope, now,
        dispatch_blocked=dispatch_blocked, shed_classes=shed_classes,
    )
    fold(pipeline_out)

    # 5. Signal classes (health / sweep_* / discover_* / scout / arch / retro).
    signal_out = _rule_signal_classes(
        state, events, scope, now,
        dispatch_blocked=dispatch_blocked, shed_classes=shed_classes,
        escalated_slots=escalated_slots,
    )
    fold(signal_out)

    dispatched_any = (
        pipeline_out.dispatched + signal_out.dispatched + escalation_out.dispatched
    ) > 0
    skipped_count = pipeline_out.skipped + signal_out.skipped

    # 5.5. Silent-wedge fallback (issue #509) — checked AFTER dispatch
    #      decisions so a slot-clear can't race a same-slot dispatch (INV-006).
    fold(_rule_silent_wedge(state, events, now))

    # 6. Idle fallback (clean idle-drain terminate / heartbeat / busy-wait nap).
    #    `plan_has_actions` distinguishes a true wait-only turn (terminate
    #    cleanly, issue #1352) from a turn that did housekeeping work
    #    (merges / reaps / queue-decisions) without dispatching.
    fold(
        _rule_idle_fallback(
            state,
            dispatched_any=dispatched_any,
            plan_has_actions=bool(plan.actions),
        )
    )

    plan.debug["scope"] = scope

    # 7. Stamp `worktreeBranch` + `dispatchSentinel` on every dispatch action
    #    (issue #527 / issue #692) — once per plan, after dispatch decisions
    #    are finalised, so every dispatch carries a stable identifier.
    _stamp_dispatch_metadata(plan.actions, state)

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
            # ISSUE #1129 (finished): the dev-steer half of the single target
            # candidate boundary now reads the SAME feed-owned flag the
            # research_target slot does. `not research_recommended(candidates)`
            # means the feed judged the top candidate strong enough to steer a
            # build — the exact negation of "recommend research". This is the
            # one home for the boundary; decide.py holds no private threshold.
            # The `best` guard stays only to extract the anchorRef/score hint.
            if best and not research_recommended(candidates):
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
        # (b) the candidate feed's precomputed `research_recommended` flag —
        # the candidates feed IS the target backlog, so a feed that flags
        # "board empty / top score too weak" means the target product needs
        # more research direction (post-#458, this trigger moved here from
        # research_orch). Both this slot AND the dev_target steer slot now
        # consume the one flag the feed computes (anchor-candidates.ts applies
        # RESEARCH_THRESHOLD). The boundary has a single home: there is no
        # second threshold constant in decide.py to silently diverge from
        # (issue #1129 finished — the private dev-side threshold was deleted).
        if _signal_present(state, events, "target_research_due"):
            return make_dispatch(cls, "hydra-target-research", reason="target research due")
        if candidates is not None and research_recommended(candidates):
            if _research_force_allowed(state, "research_target", now):
                # Issue #1666: stamp the daily force counter at the commit
                # point — every drop-gate (burned/scope/busy/shed) has already
                # passed in _rule_pipeline_dispatch, so this dispatch WILL be
                # emitted. Without the stamp the 4/day cap was dead code and
                # one run forced 46 research_target dispatches.
                _research_force_stamp(state, "research_target", now)
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
        # Untriaged-orphans triage backstop (issue #2426). An open issue that
        # carries NONE of the actionable/lifecycle labels {ready-for-agent,
        # in-progress, blocked, needs-qa, needs-triage, needs-research,
        # target-backlog} is invisible to BOTH the dev_orch dispatch path
        # (which keys only on ready-for-agent) AND the needs_triage_orch sweep
        # path (which keys only on needs-triage). collect-state.sh emits an
        # `untriaged_orphans` COUNT for exactly that blind spot; the playbook
        # maps `untriaged_orphans > 0` → the boolean `untriaged_orphans_orch`
        # signal (mirroring the needs_triage > 0 → needs_triage_orch mapping).
        # Route those orphans through the SAME hydra-sweep triage skill so a
        # mislabeled/orphaned issue lands in an actionable lane instead of
        # silently falling off the board. Subject to the same sweep_orch
        # cooldown (already enforced above) so it cannot busy-loop.
        if _signal_present(state, events, "untriaged_orphans_orch"):
            return make_dispatch(sig, "hydra-sweep", reason="untriaged orphans on orch board (no actionable label)")
        return None
    if sig == "sweep_target":
        if _signal_present(state, events, "needs_triage_target"):
            return make_dispatch(sig, "hydra-target-sweep", reason="target board hygiene due")
        return None
    if sig == "discover_orch":
        # Issue #959 (epic #958): revived. discover_orch keyed off `orch_idle`,
        # a signal collect-state.sh never emitted, so the arm was DEAD. It now
        # reads the unified `orch_backfill_idle` board-empty signal — the same
        # one architecture_orch reads — making it a backfill-set class on the
        # 1h cadence. The one-per-turn stagger guard in _rule_signals ensures
        # discover_orch and architecture_orch don't both fire on the same idle
        # turn; round-robin emerges from the per-class 1h cooldowns.
        if _signal_present(state, events, "orch_backfill_idle"):
            return make_dispatch(sig, "hydra-discover", reason="orch board idle — discovery backfill")
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
    if sig == "architecture_orch":
        # Issue #790 (parent #787); unified by #959 (epic #958). Board-idle
        # backfill: when the orchestrator board has gone idle (collect-state.sh
        # emits the unified `orch_backfill_idle` signal), reclaim spare capacity
        # by dispatching the headless /hydra-architecture-scan wrapper (#788) to
        # surface architecture-deepening candidates as tracked issues.
        #
        # arch_board_saturated is the anti-feedback-loop guard: once the board
        # already holds enough proposal-grade architecture work (N=5-10 cap,
        # owned by collect-state.sh #789), the scan suppresses itself. It is
        # checked FIRST — before the cooldown (via signal_is_cooled above) and
        # before the one-per-turn stagger guard in _rule_signals — mirroring
        # scout_orch's scout_board_saturated early-return. At the new 1h cadence
        # (#959) this cap matters MORE: it is the PRIMARY suppressor, the 1h
        # class cooldown only the back-stop. The stagger MUST NOT bypass it.
        #
        # decide.py reads the precomputed signals only — it never recomputes
        # board-empty / cooldown here; that round-trip is exactly the gate-
        # re-parsing failure mode the signal seam exists to prevent.
        if _signal_present(state, events, "arch_board_saturated"):
            return None
        if _signal_present(state, events, "orch_backfill_idle"):
            return make_dispatch(
                sig,
                "hydra-architecture-scan",
                reason="orch board idle — architecture backfill",
            )
        return None
    if sig == "retro_orch":
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
        if _signal_present(state, events, "retro_run_available"):
            return make_dispatch(
                sig,
                "hydra-retro",
                prompt_args={"apply": True},
                reason="completed run available — daily retrospective",
            )
        return None
    if sig == "cleanup_orch":
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
        if _signal_present(state, events, "orch_backfill_idle"):
            return make_dispatch(
                sig,
                "hydra-cleanup",
                reason="orch board idle — dead-code / simplification backfill",
            )
        return None
    if sig == "cleanup_target":
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
    if sig == "wire_or_retire_target":
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
        # modules under web/src/lib/risk/ or live-execution paths ALWAYS route
        # ready-for-human — an interim hardcoded list until #2701's
        # classifyTargetRisk exists. Ambiguity never resolves to deletion
        # (Target CLAUDE.md rule 6, fail closed).
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
            return make_dispatch(
                sig,
                "hydra-wire-or-retire",
                prompt_args={
                    "apply": True,
                    "max_items": WIRE_OR_RETIRE_MAX_ITEMS,
                    "risk_carveout": list(WIRE_OR_RETIRE_RISK_CARVEOUT),
                },
                reason="target triage has wire-or-retire items — resolve WIRE/RETIRE/UNCLEAR",
            )
        return None
    if sig == "design_qa_target":
        # Issue #2739 (parent #2732, the Target UI-quality loop). Periodic
        # VISUAL QA of the Target UI: dispatches the headless /hydra-design-qa
        # skill to capture the slice-1 screenshot set of every nav-registry
        # route on ~/hydra-betting/web, judge each page against the Target
        # design-language ADR (hydra-betting/docs/adr/0005-design-language.md —
        # density budget, clutter, consistency), and file AT MOST 3 deduped
        # needs-triage Target-backlog items per run, each citing the specific
        # ADR rule violated plus screenshot evidence.
        #
        # This is JUDGMENT work, so findings route needs-triage (NOT
        # ready-for-agent) — mirroring wire_or_retire_target's confidence-routing
        # discipline (epic #2720): an autonomous visual verdict is a candidate
        # for a human/triage pass, never a self-authorised code task.
        #
        # Calendar cadence like scout_orch: the 7d class cooldown
        # (SIGNAL_COOLDOWNS["design_qa_target"], honored by the shared
        # signal_is_cooled guard at the top of this function) is the primary
        # cadence control and is seeded in bootstrap.sh's signal_last_fired so it
        # survives the pace-gate relaunch (the #2575 cooldown-bootstrap bug
        # class). collect-state.sh emits `design_qa_target_due` true whenever the
        # Target board is reachable AND not saturated — there is always UI to
        # review, so the "due" predicate is just "board reachable + capacity".
        #
        # `design_qa_target_saturated` is the anti-flood cap, checked FIRST
        # (before the cooldown, exactly like cleanup_target /
        # target_cleanup_board_saturated): a board already holding >5 open
        # `design-qa`-labelled Target-backlog items suppresses the pass so a
        # healthy UI isn't re-reviewed into an ever-growing triage pile.
        #
        # The dispatch OMITS the model param (inherit the parent per #1093):
        # judgment work, and the Haiku-premature-exit failure mode is documented
        # — so no `model` key is passed here, mirroring the other judgment
        # classes (wire_or_retire_target).
        #
        # decide.py reads the precomputed signals only — it never captures
        # screenshots or reads the Target board here (the signal-seam
        # discipline). `apply: True` follows the #1078 retro_orch lesson: a
        # dry-run-default skill dispatched headlessly without it is a silent
        # no-op that files nothing. `max_items` threads the per-run cap so the
        # "≤3 findings" contract is machine-enforceable at the dispatch seam.
        if _signal_present(state, events, "design_qa_target_saturated"):
            return None
        if _signal_present(state, events, "design_qa_target_due"):
            return make_dispatch(
                sig,
                "hydra-design-qa",
                prompt_args={
                    "apply": True,
                    "max_items": DESIGN_QA_TARGET_MAX_ITEMS,
                },
                reason="target design-QA cadence due — screenshot review vs design ADR",
            )
        return None
    if sig == "skill_prune":
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
        if _signal_present(state, events, "orch_backfill_idle"):
            return make_dispatch(
                sig,
                "hydra-skill-prune",
                prompt_args={"apply": True},
                reason="orch board idle — eval-gated skill prune backfill",
            )
        return None
    if sig == "wayfinder_orch":
        # Issue #3351 (epic #3350, ADR-0029 — autopilot charts & works wayfinder
        # maps). The single AFK working class for wayfinder maps: work the next
        # unblocked frontier ticket on an open approved orchestrator
        # `wayfinder:map`. This is the tracer-bullet slice #3351 exercising the
        # full working path end-to-end on a scratch map.
        #
        # SIGNAL-SEAM DISCIPLINE (AC #3): decide.py stays PURE — no gh / curl /
        # GraphQL here. The native GraphQL frontier enumeration (per open
        # approved wayfinder:map, walk sub-issues -> first AFK-typed
        # [wayfinder:research | wayfinder:task], unblocked [all blocked-by
        # closed], unclaimed ticket) lives ONLY in collect-state.sh, which
        # pre-resolves the pick into two precomputed signals this selector reads
        # verbatim:
        #   - `wayfinder_orch_frontier`     — the resolved `issue-<N>` ticket ref
        #     (or `none` / absent when no map has an eligible frontier ticket).
        #   - `wayfinder_orch_ticket_type`  — `research` | `task`, so the playbook
        #     can resolve ticket-type -> skill at dispatch time
        #     (research -> /hydra-issue-research, task -> /hydra-dev).
        #
        # The 1h class cooldown (SIGNAL_COOLDOWNS["wayfinder_orch"], honored by
        # the shared signal_is_cooled guard at the top of this function) enforces
        # one frontier ticket per fire — mirroring the discover/cleanup 1h
        # backfill cadence. Like cleanup_orch (also 1h) the bootstrap seed is a
        # benign hardening, not a correctness requirement (a stray extra fire
        # after a pace-gate relaunch merely works one more frontier step); the
        # #2575 cooldown-bootstrap bug class bites the LONG-cooldown classes, not
        # a 1h step. NOT in BACKFILL_SIGNAL_CLASSES (map-anchored, not idle-backfill).
        #
        # decide.py emits a PURE dispatch action referencing the pre-resolved
        # ticket: `skill` defaults to hydra-issue-research (the common frontier
        # type) and the ticket ref + type are threaded into prompt_args so the
        # playbook's ticket-type router can override the skill per dispatch and
        # the worker knows exactly which ticket to resolve. The model param is
        # OMITTED (inherit the parent per #1093).
        signals = state.get("signals") if isinstance(state, dict) else None
        frontier = (
            signals.get("wayfinder_orch_frontier") if isinstance(signals, dict) else None
        )
        if not (isinstance(frontier, str) and frontier and frontier != "none"):
            # No open approved map has an eligible (AFK-typed, unblocked,
            # unclaimed) frontier ticket — nothing to work.
            return None
        # Saturation guard (issue #3354, ADR-0029 Decision 2/6). Global cap:
        # at most 2 wayfinder_orch workers may be in flight across ALL maps
        # simultaneously. The in-flight count is PRE-COMPUTED in collect-state.sh
        # (WF_INFLIGHT_GLOBAL — open + claimed AFK tickets); decide.py reads it
        # verbatim and calls no network (signal-seam discipline, AC #3). Per-map
        # single-flight is already enforced upstream: collect-state.sh yields no
        # frontier pick for a map that has an in-flight worker, so a non-`none`
        # frontier here implies the picked map is free — only the GLOBAL ceiling
        # remains to check.
        try:
            inflight_global = int(
                (signals.get("wayfinder_orch_inflight_global") if isinstance(signals, dict) else 0)
                or 0
            )
        except (TypeError, ValueError):
            inflight_global = 0
        if inflight_global >= 2:
            # Global concurrency ceiling hit — do not open a 3rd worker. The 1h
            # cooldown + this cap intentionally bound wayfinder throughput
            # (ADR-0029 Decision 2); the frontier ticket is worked on a later
            # tick once a worker clears.
            return None
        ticket_type = (
            signals.get("wayfinder_orch_ticket_type") if isinstance(signals, dict) else None
        )
        # Default to `research` when collect-state.sh didn't stamp a type — the
        # taxonomy default skill (hydra-issue-research) matches, so an unstamped
        # frontier ticket still dispatches safely rather than blocking the path.
        if ticket_type not in ("research", "task"):
            ticket_type = "research"
        return make_dispatch(
            sig,
            "hydra-issue-research",
            prompt_args={"ticket": frontier, "ticket_type": ticket_type},
            reason=(
                f"wayfinder map frontier ticket {frontier} ({ticket_type}) "
                "unblocked and unclaimed — work it"
            ),
        )
    return None


def _signal_present(state: dict, events: list[dict], signal: str) -> bool:
    """Look up a board/event signal by name. Events take precedence over state."""
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == signal:
            return bool(ev.get("value", True))
    # Fallback: signals stored on state.signals (filled by collect-state.sh)
    return bool((state.get("signals") or {}).get(signal))


def _research_force_allowed(state: dict, slot: str, now: int) -> bool:
    """Per-day cap on forced research dispatches (grilled decision 6, AC: capped at 4/day).

    Reads `state.research_force_counter[<UTC day>][<slot>]`. The counterpart
    WRITE is `_research_force_stamp` below (issue #1666) — before that fix
    nothing in the repo ever incremented the counter, so this guard always
    evaluated `0 < 4` and one run force-dispatched `research_target` 46 times
    in 52 turns (11x over the documented cap).
    """
    today = time.strftime("%Y-%m-%d", time.gmtime(now))
    counters = state.get("research_force_counter")
    if not isinstance(counters, dict):
        return True
    by_day = counters.get(today)
    if not isinstance(by_day, dict):
        return True
    try:
        used = int(by_day.get(slot, 0))
    except (TypeError, ValueError):
        used = 0
    return used < RESEARCH_FORCE_DAILY_CAP


def _research_force_stamp(state: dict, slot: str, now: int) -> None:
    """Mutates state: increment today's forced-research counter for `slot`.

    Issue #1666 — the write half of the daily force-research cap. Called at
    plan time, at the exact point `_select_for_slot` commits to the forced
    dispatch (every gate that could drop the action — burned class, scope,
    busy slot, usage shed — has already passed by then, so a stamp always
    corresponds to an emitted dispatch action). Stamping at plan time rather
    than reap time is deliberate: the motivating run left 49 dispatch records
    unreaped (run-interrupted), so a reap-side increment would have stayed
    dead in exactly the failure mode the cap exists to break.

    Prunes prior-day keys on every write: `_research_force_allowed` only ever
    reads today's UTC bucket, so the map never needs to carry more than one
    day key (this is the "counter resets across UTC days" semantics — a new
    day starts a fresh bucket and drops yesterday's).

    Persistence: decide() mutates the loaded dict in place (same pattern as
    the slot_history/failure_log telemetry writes); the CLI `decide`
    subcommand in main() detects the counter change and writes the state file
    back atomically. In-process callers (tests importing decide()) see the
    mutation directly on the dict they passed.
    """
    today = time.strftime("%Y-%m-%d", time.gmtime(now))
    counters = state.get("research_force_counter")
    if not isinstance(counters, dict):
        counters = {}
    by_day = counters.get(today)
    if not isinstance(by_day, dict):
        by_day = {}
    try:
        used = int(by_day.get(slot, 0))
    except (TypeError, ValueError):
        used = 0
    by_day[slot] = used + 1
    # Prune: keep only today's bucket (prior-day keys are never read again).
    state["research_force_counter"] = {today: by_day}


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


def dev_target_cost_cap_state(state: dict) -> dict:
    """Resolve the per-cycle dev_target cost-cap inputs from state (issue #1059).

    Reads (with sane fallbacks for legacy state shapes):
      - state.limits.per_cycle_cost_cap_usd   (default PER_CYCLE_COST_CAP_USD_DEFAULT)
      - state.dev_target_spend_usd_cycle       (default 0.0)

    Returns a dict with the resolved floats AND a boolean `enforced` flag.
    `enforced` is False when the resolved cap is <= 0 — the documented
    kill-for-the-gate value that disables the backstop entirely (a no-op,
    matching the scout gate's "rate not configured" degrade). When the cap is
    positive the gate compares cycle spend against it. Unlike the scout gate
    there is no kill-SWITCH semantics for 0 here: this is a HIGH backstop, not a
    throttle, so a 0 cap means "no backstop", never "suppress everything".

    Pure: no side effects.
    """
    limits = state.get("limits") or {}

    try:
        cap_usd = float(limits.get("per_cycle_cost_cap_usd", PER_CYCLE_COST_CAP_USD_DEFAULT))
    except (TypeError, ValueError):
        cap_usd = PER_CYCLE_COST_CAP_USD_DEFAULT
    if not (cap_usd >= 0.0):  # NaN-safe
        cap_usd = PER_CYCLE_COST_CAP_USD_DEFAULT

    try:
        spend = float(state.get("dev_target_spend_usd_cycle", 0.0) or 0.0)
    except (TypeError, ValueError):
        spend = 0.0
    if not (spend >= 0.0):
        spend = 0.0

    return {
        "cap_usd": cap_usd,
        "spend_usd": spend,
        "enforced": cap_usd > 0.0,
    }


def dev_target_cost_cap_exceeded(state: dict) -> bool:
    """True when the per-cycle dev_target cost-cap backstop should halt dispatch.

    Pure wrapper over `dev_target_cost_cap_state` — separated so callers can
    log either the bool decision or the full breakdown.
    """
    s = dev_target_cost_cap_state(state)
    if not s["enforced"]:
        return False
    return s["spend_usd"] >= s["cap_usd"]


def _check_termination(state: dict, now: int) -> dict | None:
    """Mirror of term-check.py logic, expressed as an action."""
    limits = state.get("limits") or {}
    cumulative = int(state.get("cumulative_tokens", 0))
    budget = int(limits.get("token_budget", 10_000_000))
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
    if t == "4":
        return "T4 (Verifier Core) non-mechanical change — operator review required"
    if t == "3" and has_scope_justif:
        return "Tier-3 with scope-justification block — explicit operator opt-in"
    return f"Tier-{t} PR queued for operator review"


def _queue_recommendation_for(tier: int | str, mechanical: bool | str | None, has_scope_justif: bool) -> str:
    t = str(tier)
    if t == "4":
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


def _post_run_end_for_terminate(actions: list, state: dict) -> None:
    """POST /api/autopilot/run-end when the plan carries a `terminate` action.

    Issue #1352: a decide-emitted `terminate` historically had NO clean
    run-end writer — `term-check.py` only POSTs when its own Phase-3 check
    trips (which runs BEFORE decide in the turn), and the playbook's
    terminate arm goes to `drain.sh`, which prints a summary but never POSTs.
    So every decide-side termination (the `_check_termination` mirror, the
    failure backstop, and the new wait-only idle drain) fell through to the
    ExecStopPost reap backstop and was stamped `interrupted` — starving the
    retro loop of clean terminal runs. This closes that gap: the cause the
    plan decided on is recorded BEFORE the print-mode session exits.

    Deliberately a CLI-side effect (like `_xadd_observability_events` /
    `_persist_state_writeback`) so `decide()` stays pure for tests. Skipped
    when state carries no `run_id` (test fixtures, isolated runs) or when
    `HYDRA_AUTOPILOT_RUN_END_POST` is an off-value (CLI-spawning tests set
    `off`; production needs no env change). The endpoint is idempotent — if
    term-check already recorded an end this turn, the first cause wins, and
    the later reap POST dedups to a no-op. Failure is loud but never fatal:
    the reap backstop still records a terminal status if this POST loses.
    """
    flag = os.environ.get("HYDRA_AUTOPILOT_RUN_END_POST", "").strip().lower()
    if flag in ("0", "off", "no", "false"):
        return
    term = next(
        (a for a in actions if isinstance(a, dict) and a.get("type") == "terminate"),
        None,
    )
    if term is None:
        return
    run_id = str(state.get("run_id") or "").strip()
    if not run_id:
        return
    import urllib.request
    import urllib.error

    api_base = os.environ.get("HYDRA_API_BASE", "http://localhost:4000")
    payload = json.dumps({
        "run_id": run_id,
        "cause": str(term.get("cause") or "idle"),
        "ended_epoch": int(time.time()),
    }).encode("utf-8")
    last_exc: Exception | None = None
    for attempt in (1, 2, 3):
        req = urllib.request.Request(
            f"{api_base}/api/autopilot/run-end",
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
            return
        except urllib.error.HTTPError as exc:
            if 400 <= exc.code < 500:
                # 404 unknown run / 409-class already-terminal — a
                # deterministic answer, not a transient fault.
                return
            last_exc = exc
        except (urllib.error.URLError, OSError) as exc:
            last_exc = exc
        if attempt < 3:
            time.sleep(float(attempt))
    print(
        f"decide.py: run-end POST failed after 3 attempts "
        f"(run_id={run_id} cause={term.get('cause')!r}): {last_exc}. "
        "The ExecStopPost reap backstop will record the terminal status.",
        file=sys.stderr,
    )


def _mirror_research_force_counter_to_redis(state: dict) -> None:
    """Mirror research_force_counter to Redis on a plan-time stamp (issue #2715).

    decide.py stamps the daily forced-research counter at plan time (not at reap
    time), so the Redis mirror needs a decide-side write too — otherwise a run
    that force-dispatches research but never reaps a matching completion would
    leave the counter only in the boot-wiped state file. This piggybacks on the
    SAME force-counter-changed branch that calls `_persist_state_writeback`, so
    it fires exactly once per stamping turn.

    ONLY research_force_counter is mirrored here (signal_last_fired is mirrored by
    reap.py's executor-side seam — decide.py's `stamp_signal` is not on the live
    stamp path). The seam is `docker exec hydra-redis-1 redis-cli`, matching
    reap.py / bootstrap.sh; `HYDRA_AUTOPILOT_REDIS_CLI` overrides the argv prefix
    for tests. Best-effort / fail-open: any error logs to stderr and never aborts
    the decision turn (design-concept #2715 Invariant 5). Gated OFF for CLI-
    spawning tests via the same `HYDRA_AUTOPILOT_RUN_END_POST` off-switch decide
    already honours, so isolated `decide` invocations stay pure emitters.
    """
    flag = os.environ.get("HYDRA_AUTOPILOT_RUN_END_POST", "").strip().lower()
    if flag in ("0", "off", "no", "false"):
        return
    rfc = state.get("research_force_counter")
    if not isinstance(rfc, dict):
        return
    override = os.environ.get("HYDRA_AUTOPILOT_REDIS_CLI", "").strip()
    if override:
        cmd = [*override.split(), "SET", "hydra:autopilot:research-force-counter",
               json.dumps(rfc, sort_keys=True)]
    else:
        cmd = ["docker", "exec", "hydra-redis-1", "redis-cli", "SET",
               "hydra:autopilot:research-force-counter", json.dumps(rfc, sort_keys=True)]
    import subprocess
    try:
        subprocess.run(
            cmd,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        print(
            f"decide.py: research_force_counter redis mirror failed ({exc}); "
            "state.json remains source of truth",
            file=sys.stderr,
        )


def _persist_state_writeback(
    path: str, state: dict, what: str = "research_force_counter increment",
) -> None:
    """Atomically write the state dict back to the state file.

    Issue #1666: the daily force-research counter is incremented in-memory by
    `_research_force_stamp` at plan time, but the `decide` CLI historically
    discarded the mutated dict after printing the plan — so the counter never
    survived to the next turn's read and the 4/day cap was dead code. The
    caller (main) invokes this ONLY when the counter actually changed this
    turn, so decide stays a pure JSON emitter on every other turn (the same
    conservatism as the env-gated XADD above).

    Issue #1769: also reused for the pre-decide turn-counter bump (see
    `main`), with `what` naming the mutation so the failure log stays
    specific.

    Write is tmp-file + os.replace in the state file's own directory so a
    crash mid-write can never leave a torn state.json (bootstrap/reap.py
    readers jq/json.load it). Failure is loud but non-fatal: losing one
    increment degrades back to the pre-fix behaviour for this turn only,
    which must never abort the autopilot's decision turn.
    """
    import tempfile
    dirname = os.path.dirname(os.path.abspath(path)) or "."
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(prefix=".decide-state-", dir=dirname)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2)
            fh.write("\n")
        os.replace(tmp_path, path)
        tmp_path = None
    except OSError as exc:
        print(
            f"decide.py: state write-back to {path} failed ({exc}); "
            f"{what} NOT persisted this turn",
            file=sys.stderr,
        )
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass  # intentional: tmp file may never have been created


# ---------------------------------------------------------------------------
# Per-class yield scoreboard — SHADOW MODE (issue #2943)
# ---------------------------------------------------------------------------
#
# decide.py is stateless for LEARNING: it re-decides every run from cooldowns +
# current candidate scores and never reads how a class has actually PERFORMED
# across runs. Issue #2943 closes that loop — but v1 actuates NOTHING. The
# scoreboard + the per-class cadence multiplier are computed ORCHESTRATOR-SIDE
# (src/autopilot/class-stats.ts, served at GET /api/autopilot/class-stats) and
# INJECTED into state.json as `state.class_stats` by collect-state.sh. This
# shadow path only READS that injected verdict and LOGS the multiplier decide.py
# WOULD apply — it changes NO dispatch decision.
#
# Two invariants this code guards (the #2943 grill 2026-07-06):
#   1. decide() stays a PURE function of state.json: it NEVER fetches dispatch
#      history itself; the verdict arrives via collect-state.sh injection only.
#      So the shadow read + log live HERE in main()'s side-effect region, never
#      inside decide().
#   2. decide() output (actions/events) is BYTE-IDENTICAL with the shadow
#      computation present vs absent. The shadow path runs AFTER the plan is
#      computed + printed and touches neither `plan` nor `state`.

# Where the shadow log lands. Env-overridable (tests point it at a tmp file);
# defaults alongside the autopilot run log so an operator can eyeball what the
# dampener WOULD have done during the >=2-week shadow-validation window that
# gates the flip to live (a documented, separate acceptance gate — issue #2943).
CLASS_STATS_SHADOW_LOG = os.environ.get(
    "HYDRA_CLASS_STATS_SHADOW_LOG", "/tmp/hydra-class-stats-shadow.log"
)


def compute_shadow_dampener_lines(state: dict, now: int | None = None) -> list[dict]:
    """Read the INJECTED class-stats verdict and return the shadow-log rows.

    PURE: reads only `state.class_stats` (the collect-state.sh injection) — it
    NEVER fetches dispatch history, never touches Redis/GitHub, never mutates
    `state`. Returns one dict per class whose shadow multiplier != 1.0 (the
    classes a future LIVE mode would dampen); an empty list when the scoreboard
    is absent / empty / all-healthy. This is the ONLY thing the shadow path
    computes — and its result is LOGGED, never applied.

    The multipliers are computed server-side (shadowDampener in
    src/autopilot/class-stats.ts) and arrive pre-computed under
    `class_stats.shadow.verdicts`; we re-emit them verbatim so the log records
    exactly what the orchestrator-side verdict said (no re-derivation drift).
    """
    if not isinstance(state, dict):
        return []
    cs = state.get("class_stats")
    if not isinstance(cs, dict):
        return []
    shadow = cs.get("shadow")
    if not isinstance(shadow, dict):
        return []
    verdicts = shadow.get("verdicts")
    if not isinstance(verdicts, list):
        return []
    stamp = int(time.time()) if now is None else int(now)
    turn = int(state.get("turn", 0) or 0)
    run_id = str(state.get("run_id") or "")
    rows: list[dict] = []
    for v in verdicts:
        if not isinstance(v, dict):
            continue
        try:
            mult = float(v.get("multiplier", 1.0) or 1.0)
        except (TypeError, ValueError):
            continue
        # Only log classes the dampener WOULD actually slow down (mult != 1.0):
        # a 1.0 multiplier is "no change", which is the vast majority of rows and
        # would drown the shadow log. The scoreboard itself (all classes) stays
        # available via the API for the full picture.
        if mult == 1.0:
            continue
        rows.append(
            {
                "ts": stamp,
                "run_id": run_id,
                "turn": turn,
                "class": str(v.get("className") or "?"),
                "would_apply_multiplier": mult,
                "verdict": str(v.get("verdict") or "?"),
                "reprobe_at": v.get("reprobeAt"),
                # Explicit marker: this is SHADOW mode — nothing was actuated.
                "actuated": False,
            }
        )
    return rows


def write_class_stats_shadow_log(state: dict, now: int | None = None) -> None:
    """Append the shadow-mode dampener rows to the shadow log (side-effect).

    A main()-side effect ONLY — decide() never calls this, so the plan output
    stays byte-identical with the shadow computation on/off (issue #2943
    invariant 1). Best-effort: an I/O error is logged loud but never aborts the
    turn (the autopilot must not wedge on a shadow-log write); an absent /
    empty / all-healthy scoreboard writes nothing.
    """
    try:
        rows = compute_shadow_dampener_lines(state, now=now)
        if not rows:
            return
        with open(CLASS_STATS_SHADOW_LOG, "a", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row, sort_keys=True) + "\n")
    except OSError as exc:
        print(
            f"decide.py: class-stats shadow-log write to "
            f"{CLASS_STATS_SHADOW_LOG} failed ({exc}); shadow verdict NOT logged "
            f"this turn (dispatch behavior unaffected — shadow mode)",
            file=sys.stderr,
        )


def main(argv: list[str]) -> int:
    # Issue #2713 — optional frozen decision clock for golden/regression
    # fixtures: `--now=<epoch>` (anywhere after the program name) pins the
    # `now` decide() receives so a captured production triple replays
    # deterministically. Absent → real wall clock (production behavior
    # unchanged). Parsed and stripped BEFORE positional handling so the
    # `decide <state> [cands] [events]` contract is untouched.
    frozen_now: int | None = None
    argv = [a for a in argv]
    for i, arg in enumerate(argv[1:], start=1):
        if arg.startswith("--now="):
            try:
                frozen_now = int(arg.split("=", 1)[1])
            except ValueError:
                print(f"decide.py: invalid --now value {arg!r}", file=sys.stderr)
                return 2
            del argv[i]
            break
    if len(argv) <= 1:
        print(
            "usage: decide.py [--now=<epoch>] decide <state.json> [candidates.json] [events.json]\n"
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
        # Issue #1769 — single-writer turn counter. The CLI (not the model
        # session, not heartbeat.py) owns `state.turn`: one bump per decide
        # invocation, persisted atomically BEFORE decide() runs so the bumped
        # value is the ONLY mutation this write carries (decide() mutates the
        # dict in-memory afterwards — slot_history, failure_log — and those
        # must not ride along). The plan stamp at the end of decide() then
        # reads the bumped value, so `plan.turn == state.json turn` holds by
        # construction and heartbeat.py's strict freshness equality can never
        # see a session-ordering off-by-one again (run 69442b4c zeroed turns
        # 2-9's action ledgers that way). A failed persist degrades to ONE
        # loud plan-stale-skipped turn record — never aborts the turn.
        # decide() itself stays pure (ADR-0007); the bump is a sanctioned
        # main() side-effect like _persist_state_writeback (#1666).
        state["turn"] = int(state.get("turn", 0) or 0) + 1
        _persist_state_writeback(argv[2], state, what="turn-counter bump (#1769)")
        candidates = _load_json(argv[3]) if len(argv) > 3 else None
        events = _load_json(argv[4]) if len(argv) > 4 else None
        # Issue #1666: snapshot the force-research counter so we can detect a
        # plan-time stamp and persist it. Serialised compare (not identity) —
        # _research_force_stamp replaces the nested dict in place.
        force_counter_before = json.dumps(
            state.get("research_force_counter"), sort_keys=True,
        )
        # Issue #2713 — main() owns the clock: real time in production, the
        # frozen --now epoch when replaying a captured fixture. decide()
        # itself never reads the wall clock when `now` is supplied.
        now_epoch = frozen_now if frozen_now is not None else int(time.time())
        plan = decide(state, candidates, events, now=now_epoch)
        _xadd_observability_events(plan.events)
        # Issue #1352: record a clean run-end for any decide-side terminate
        # BEFORE the print-mode session exits (reap would stamp `interrupted`).
        _post_run_end_for_terminate(plan.actions, state)
        force_counter_after = json.dumps(
            state.get("research_force_counter"), sort_keys=True,
        )
        if force_counter_after != force_counter_before:
            _persist_state_writeback(argv[2], state)
            # Issue #2715: mirror the just-stamped counter to Redis so a host
            # reboot (which wipes the /tmp state file) can reseed it. Same
            # force-counter-changed gate → fires once per stamping turn.
            _mirror_research_force_counter_to_redis(state)
        print(plan.to_json())
        # Issue #2943 — SHADOW MODE. AFTER the plan is computed + printed, log the
        # per-class cadence multiplier decide.py WOULD apply in a future live
        # mode. This is a main()-side effect that touches NEITHER `plan` NOR the
        # dispatch decision — the plan above is byte-identical whether or not the
        # scoreboard was injected (invariant: no dispatch behavior changes in this
        # issue). decide() itself never reads class_stats, so it stays a pure
        # function of state.json. Best-effort; a write failure never aborts.
        write_class_stats_shadow_log(state, now=now_epoch)
        return 0
    print(f"decide.py: unknown subcommand {sub!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
