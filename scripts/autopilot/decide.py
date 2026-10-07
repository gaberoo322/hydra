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
  auto-merge           Bash(gh pr review/merge)
  apply-operator-approved   Bash(gh pr edit --add-label operator-approved)
  update-branch        Bash(gh pr update-branch)
  surface-pr           Bash(gh api .../issues/N/labels + gh pr comment)
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
FILE LAYOUT (issue #4511) — three layers, imports point DOWN only
==================================================================

decide.py (this file)   The single entry point and composition root: the
                        rules, `_select_for_slot` / `_select_for_signal`,
                        the two selector registries (explicit dict
                        literals), `decide()` and the CLI.
decide_selectors/*.py   One module per dispatch family (qa, dev, sweep, …):
                        its `_select_slot_*` / `_select_signal_*` handlers
                        and the helpers only that family uses. Imports the
                        standard library and decide_base only.
decide_base.py          The leaf: the few names both sides need
                        (make_dispatch, the signal readers,
                        ESCALATION_POLICY, …). Standard library only.

decide.py imports both lower layers; nothing below it imports `decide`, and
no selector module imports another (pinned by test/taxonomy-classes.test.mts).

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
    # TWO distinct floors read these same timestamps with deliberately
    # OPPOSITE never-fired semantics — do not conflate them:
    #   - The backfill starvation floor (#2428, signal_starved) forces a
    #     backfill class through the intra-turn STAGGER if it has gone dark
    #     >24h; an absent/0 entry is NOT starved (normal cold-start).
    #   - The discover staleness floor (#4114, signal_dark_past_floor) fires
    #     discover_orch's selector when the class has been dark >7d; an
    #     absent/0 entry IS dark (a never-fired producer is exactly the dark
    #     state the floor exists to break).
  }

  # NEW IN #3729 — per-item verdict-stability stamps for sweep_target. Keyed by
  # the STRING Target issue number, valued by the unix epoch of the last
  # sweep_target dispatch that examined it. decide.py stamps every item in the
  # CURRENT needs-triage set on fire and prunes the rest, so this never grows
  # unbounded. Persisted via _persist_state_writeback (same pattern as
  # research_force_counter); an absent/empty map means every item is fresh.
  "target_triage_item_stamps": {
    "<target_issue_number>": unix-epoch
  }

  # NEW IN #3829 — per-issue attempt counter for the qa_orch busy-loop guard
  # (design-concept issue-3829). Keyed by the STRING orch issue number, valued
  # by the count of qa_orch dispatches that fired while that issue was the
  # HEAD of the needs-qa set (needs_qa_numbers[0] — the issue hydra-qa will
  # actually self-select via its own unsorted-default `gh issue list --label
  # needs-qa --jq '.[0]'` query). At most ONE entry exists at any time by
  # construction: on every qa_orch fire the map is rebuilt to hold only the
  # current head's (bumped) count, so a non-head issue merely present in the
  # needs-qa set is NEVER incremented (design-concept invariant 4 — a
  # multi-issue backlog must not falsely accumulate attempts against issues
  # that were never actually reviewed), and a former head that leaves the set
  # (verdict reached, or a new head takes over) is pruned, so a later re-open
  # under the same number starts fresh at 0 (invariant 5). An issue whose
  # count reaches QA_STALL_MAX_ATTEMPTS is no longer eligible for qa_orch
  # dispatch while it remains head — the busy-loop backstop issue #3829
  # diagnosed as missing. Persisted via _persist_state_writeback (invariant
  # 6, same pattern as research_force_counter / target_triage_item_stamps);
  # an absent/empty map means the current head is fresh (0 prior attempts).
  "qa_orch_item_attempts": {
    "<orch_issue_number>": int
  }

  # NEW IN #3867 — quota-percent budget baseline. Present ONLY on a run whose
  # `limits.quota_5h_max_pts` / `limits.quota_week_max_pts` is non-zero (the cap
  # is opt-in; unset = the key never appears at all, and a default run's state is
  # byte-identical to pre-#3867). Written ONCE by `_capture_quota_baseline` on the
  # first turn that sees a CALIBRATED `state.usage_eligibility.usage` payload, and
  # rebased DOWNWARD only on a mid-run 5h/weekly window reset (a current
  # percentage below the baseline = headroom returned, never negative spend).
  # `_quota_delta_exceeded` compares the current percentages against it and emits
  # `TERM:quota` once the delta crosses the cap. Persisted via
  # _persist_state_writeback (same pattern as research_force_counter);
  # bootstrap.sh deliberately does NOT seed it from prior state, which is what
  # re-arms the capture for each new run.
  "quota_baseline": {
    "percent_5h": float|null,     # usage.percentLast5h at capture
    "percent_week": float|null,   # usage.percentSinceReset at capture
    "captured_epoch": unix-epoch,
    "rebased_epoch": unix-epoch|null
  }

  # NEW IN #4161 — orch-realm weekly-share guard (the one LIVE budget split;
  # the USD gates are documented INERT). Two keys, both optional and absent on
  # a default run, so default state stays byte-identical:
  #   limits.orch_realm_weekly_share_cap   (operator ceiling, fraction 0..1;
  #                                  absent/0/unparseable/>1 = guard DISABLED
  #                                  — ADR-0021 D5: never a second governor
  #                                  switched on behind the operator's back)
  #   signals.orch_realm_weekly_share (pre-qualified fact folded by
  #                                  collect-state.sh from /api/usage
  #                                  bySkillByModel over the taxonomy scope
  #                                  column; a number OR numeric string in
  #                                  [0,1], or "unavailable"/absent = no
  #                                  usable reading = guard disabled — an
  #                                  unreadable meter never suppresses
  #                                  dispatch)
  # Suppression is ORCH-scope classes only (CLASS_SCOPE == "orch"), pipeline
  # AND signal loops — one-directional by design; target/both are untouched.

  # NEW IN #4795 — the #4739 dev_target resume record, read by the #4653
  # qa_target builder-in-flight hold's resume arm. A single dict — decide.py
  # is its ONLY writer: `_rule_pipeline_dispatch` stamps it at plan time
  # immediately after emitting a resume-pin dev_target dispatch (the same
  # post-gate position as the #4611 signal_last_fired stamp), binding the
  # dispatch's token to the PRIOR run's branch it pushes to. The hold then
  # matches `target_needs_qa_pr_head == branch` iff the record's `token` is
  # the LIVE dev_target slot's — proving by identity that the needs-qa PR was
  # resumed by the currently-running builder (a fresh build's head can never
  # equal feature/<token>). Overwritten wholesale by the next resume pin,
  # NEVER cleared or pruned — a stale record is inert by construction (tokens
  # are unique per run+turn). In-run state by design, like
  # glm_red_forward_fix_attempts: persisted via _persist_state_writeback's
  # snapshot/compare pair; a new run starts without it and the hold fails
  # open (the #3709 dead-arm class).
  "dev_target_resume_inflight": {
    "token":  "<run8>-t<N>-dev_target",  # the dispatch's own worktreeBranch token
    "branch": "<resume_branch>",         # the PRIOR run's branch (prompt_args)
    "pr":     <int>                      # the resumed Target PR number
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
  auto-merge            { type, pr_number, tier, reason }
  apply-operator-approved { type, pr_number, tier, reason, mechanical }
  update-branch         { type, pr_number, reason }
  surface-pr            { type, pr_number, cause, reason }
  reap                  { type, slot, task_id, total_tokens, skill }
  terminate             { type, cause, merged_prs, reason }
  wait                  { type, seconds, reason }
  wait-for-api          { type, url, retries, reason }

==================================================================
MERGE POLICY (policy collapse, issue #742 / ADR-0015)
==================================================================

`should_auto_merge(tier, mechanical, has_scope_justification, qa_verdict)`:

  qa_verdict != PASS    → hold      (INV-007 guard)
  stale-SHA PASS        → hold      (QA merge guard, issue #4737 — see below)
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

  Head-SHA binding (issue #4737, decision #4736 option 2): a `qa-verdict`
  event MAY carry `verdict_sha` (the `sha=` field of the PR's latest
  `QA-Verdict:` trailer, #4729) and `head_sha` (the PR's current head). When
  EITHER is present, a PASS auto-merges only if `verdict_sha` is a 7–40 hex
  prefix of `head_sha` — the Python twin of `qaVerdictShaMatches()` in
  scripts/ci/qa-verdict.ts, so `sha=unknown`, a blank head, or a missing
  counterpart NEVER match. A mismatch holds with reason
  `hold:#N:stale-verdict` (the #4380 shape: PASS armed, fix pushed, re-review
  FAILed, merged anyway). An event carrying neither field keeps the legacy
  INV-007-only behaviour. The same rule, read live from GitHub, is
  `scripts/ci/qa-merge-guard.ts` (`--pr N`, exit 0 = may merge).

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
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Iterable, Sequence

# ---------------------------------------------------------------------------
# Sibling brain modules (issue #4511) — imports point DOWN only
# ---------------------------------------------------------------------------
# decide.py -> decide_selectors/*.py -> decide_base.py; nothing below this file
# imports `decide` (see FILE LAYOUT in the module docstring). The guarded
# sys.path insert is the reap.py pattern (issue #4366): three test files load
# this module through importlib.util.spec_from_file_location with cwd at the
# repo root, where the script's own directory is not on sys.path and a bare
# `from decide_base import ...` would raise ModuleNotFoundError. Every other
# entry (the CLI, sys.path insert + `import decide`, heartbeat.py) already has
# the directory there, so the insert is a no-op. The imports are name-binding,
# so `decide.<name>` keeps resolving and ESCALATION_POLICY is ONE dict object
# shared by identity with decide_base and the selector modules.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
from decide_base import (
    ESCALATION_POLICY,
    GLM_RED_FORWARD_FIX_CAP,
    QA_STALL_MAX_ATTEMPTS,
    _dirty_surface_pairs,
    _glm_red_attempt_count,
    _glm_red_forward_fix_signal,
    _needs_qa_target_pr_ref,
    _normalize_target_risk_surface,
    _orch_board_read_degraded,
    _raw_signal,
    _signal_present,
    _target_dev_resume_pick_signal,
    make_dispatch,
)
from decide_selectors.architecture import _select_signal_architecture_orch
from decide_selectors.cleanup import (
    _select_signal_cleanup_orch,
    _select_signal_cleanup_target,
)
from decide_selectors.design_concept import _select_slot_design_concept_orch
from decide_selectors.design_qa import _select_signal_design_qa_target
from decide_selectors.dev import (
    _select_slot_dev_orch,
    _select_slot_dev_target,
)
from decide_selectors.discover import (
    _select_signal_discover_orch,
    _select_signal_discover_target,
)
from decide_selectors.health import _select_signal_health
from decide_selectors.qa import (
    _select_slot_qa_orch,
    _select_slot_qa_target,
)
from decide_selectors.research import (
    _select_slot_research_orch,
    _select_slot_research_target,
)
from decide_selectors.retro import _select_signal_retro_orch
from decide_selectors.scout import _select_signal_scout_orch
from decide_selectors.skill_prune import _select_signal_skill_prune
from decide_selectors.sweep import (
    _select_signal_sweep_orch,
    _select_signal_sweep_target,
)
from decide_selectors.tickets import _select_signal_tickets_orch
from decide_selectors.wayfinder import _select_signal_wayfinder_orch
from decide_selectors.wire_or_retire import _select_signal_wire_or_retire_target

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
# The table is only the ALPHABET (ADR-0012). Row order is the file/declaration
# order of the derived tuples and of the TS views (pinned by the parity tests)
# — it is NOT dispatch priority: _rule_pipeline_dispatch iterates the hardcoded
# pipeline_priority tuple (issue #466), which deliberately differs from row
# order, and _rule_signal_classes iterates a hardcoded signal tuple that today
# merely coincides with row order — nothing couples them (issue #4468).
# Dispatch priority is POLICY and stays here in the brain.

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

# Class -> taxonomy scope projection (issue #4161). The orch-realm share
# guard suppresses ORCH-scope dispatch only: classes whose taxonomy row
# carries scope "orch". "target" rows are never touched (the guard is
# one-directional by design — it exists to stop orchestrator self-work from
# crowding out Target work, not the reverse), and "both" rows (health) are
# realm-agnostic whole-system probes, so they are never suppressed either.
# Derived from the same validated alphabet as CLASS_SKILL so the guard can
# never disagree with the scope column collect-state.sh folds the usage
# share over.
CLASS_SCOPE = {r["name"]: r["scope"] for r in CLASS_TAXONOMY}

# Dispatch isolation policy (issue #4476, design-concept issue-4476 INV-1/INV-2).
#
# The harness's `Agent(isolation="worktree")` pins the session's git/write
# fence to the orchestrator repo. The Target workspace is a SIBLING repo, so a
# pinned session can READ it (Read, rg, git log, curl, gh) but is refused every
# git MUTATION / file write / build artifact inside it (#3889: dev_target's
# worktree add failed 2/2; cleanup_target hard-aborted on its fetch/ff-merge).
#
# Rule: a Target-scope class is "self" iff its playbook mutates the Target tree
# (git write, file write, build/test artifact); it then launches WITHOUT harness
# isolation and isolates itself in a Target worktree via the shared
# _fragments/target-self-isolation-preamble.md. Pure readers keep "worktree".
#
# LAYERING: POLICY lives here, not as a classes.json column — classes.json is
# the alphabet only (ADR-0012; same precedent as ESCALATION_POLICY and
# QA_STALL_MAX_ATTEMPTS). The dict must cover EXACTLY every target/both-scope
# row (validated below at import — no silent default for a Target-scope
# class). Classes absent from it (all scope=orch) are "worktree".
ISOLATION_MODES = ("worktree", "self")

TARGET_ISOLATION: dict[str, str] = {
    # self — mutates the Target tree
    "dev_target": "self",        # hydra-target-build Step 0.6 `git worktree add`
    "qa_target": "self",         # stash/checkout + e2e:smoke screenshots in the PR worktree
    "research_target": "self",   # writes direction docs + branch/commit/push
    "cleanup_target": "self",    # fetch + ff-merge in the Target, knip run (observed hard-abort)
    "design_qa_target": "self",  # route-smoke Playwright run builds/serves + writes artifacts
    # worktree — read-only against the Target tree
    "sweep_target": "worktree",           # GitHub REST only
    "discover_target": "worktree",        # curl/journalctl/manifest read + cached test run, no git mutation
    "wire_or_retire_target": "worktree",  # git log --follow + rg reads + gh issue edit only
    "health": "worktree",                 # orchestrator ops (scope both)
}


def _validate_target_isolation(
    policy: dict[str, str], taxonomy: tuple[dict, ...]
) -> None:
    """Fail loud at import unless `policy` covers EXACTLY the target/both rows."""
    names = {r["name"] for r in taxonomy}
    needs = {r["name"] for r in taxonomy if r["scope"] in ("target", "both")}
    unknown = sorted(set(policy) - names)
    if unknown:
        raise _taxonomy_fail(
            "TARGET_ISOLATION names class(es) that are not classes.json rows: "
            + ", ".join(unknown)
        )
    orch_keyed = sorted(set(policy) - needs)
    if orch_keyed:
        raise _taxonomy_fail(
            "TARGET_ISOLATION must only key target/both-scope classes; "
            "orch-scope class(es) present: " + ", ".join(orch_keyed)
        )
    unclassified = sorted(needs - set(policy))
    if unclassified:
        raise _taxonomy_fail(
            "target/both-scope class(es) missing a TARGET_ISOLATION verdict "
            "(no silent default for a Target-scope class, issue #4476): "
            + ", ".join(unclassified)
        )
    bad = sorted(k for k, v in policy.items() if v not in ISOLATION_MODES)
    if bad:
        raise _taxonomy_fail(
            f"TARGET_ISOLATION verdict(s) must be one of {ISOLATION_MODES}: "
            + ", ".join(bad)
        )


_validate_target_isolation(TARGET_ISOLATION, CLASS_TAXONOMY)


def class_isolation(slot: str) -> str:
    """Pure: the dispatch isolation mode for a class ("worktree" | "self")."""
    return TARGET_ISOLATION.get(slot, "worktree")

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

# Issue #4611 — minimum re-fire interval for the `research_target` pipeline
# slot. Its only trigger (`target_board_research_due` = the Target board has 0
# `ready-for-agent` items) is also true whenever the board is PR-SATURATED
# (every actionable item already has an open PR / operator hold), so without
# this the slot re-dispatched on every free decide turn (~124k tokens each)
# while research could not unblock anything. Default 6h (the operator's number
# via /hydra-hitl-grill 2026-09-23, matching the triage back-offs above);
# env-overridable, resolved once at import so decide() stays a pure function of
# (state, events, now). Deliberately NOT a classes.json `cooldownSeconds`:
# pipeline rows must carry `null` there (slots have no class cooldown) — this
# is a slot re-fire interval, read from `signal_last_fired[<cls>]` which
# decide.py stamps at plan time (see `_rule_pipeline_dispatch`).
RESEARCH_TARGET_REFIRE_SEC = int(
    os.environ.get("HYDRA_RESEARCH_TARGET_REFIRE_SEC") or (6 * 60 * 60)
)

# Issue #4611 — the pipeline classes carrying a re-fire interval. Keyed table so
# `_rule_pipeline_dispatch` stays class-agnostic (`.get(cls, 0)`); every class
# absent from it (dev_*, qa_*, research_orch, design_concept_orch) dispatches
# exactly as before.
PIPELINE_REFIRE_SEC: dict[str, int] = {
    "research_target": RESEARCH_TARGET_REFIRE_SEC,
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
        {"allow": bool, "shed": set[str], "reasons": dict, "usage": dict}

    Missing / malformed input → {"allow": True, "shed": set(),
    "reasons": {}, "usage": {}} so the tracker stays informational, not
    load-bearing.

    Issue #3867 added `usage` — the nested `usage` object of the eligibility
    payload (`percentLast5h` / `percentSinceReset` / `calibrated` /
    `usageSource`, from `EligibilityUsageInput`). It was previously extracted
    and DISCARDED here; the quota-percent budget reads it, which is why that cap
    needs zero new I/O (collect-state.sh already fetches the whole payload every
    turn). A missing / non-dict `usage` degrades to `{}`, and every reader below
    treats an absent percentage as "meter not usable this turn" — the same
    fail-open direction as `allow`.
    """
    if not isinstance(raw, dict):
        return {"allow": True, "shed": set(), "reasons": {}, "usage": {}}
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
    usage_raw = raw.get("usage")
    usage = usage_raw if isinstance(usage_raw, dict) else {}
    return {"allow": allow, "shed": shed, "reasons": reasons, "usage": usage}


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
#
# INERT ON THIS DEPLOYMENT (issue #4161): the scout gate below compares a
# USD spend counter that is structurally $0 — `HYDRA_TOKEN_USD_RATE` was
# never set post-ADR-0006 (see src/scheduler/heartbeat.ts) and #704 removed
# the dollar-conversion machinery (src/api/metrics-cost.ts: "structurally
# $0; no live dollar cap") — so no cap value can ever make it fire. Kept
# (its kill-switch semantics are pinned by tests); do NOT build a budget
# split on it. The live budget-split signal is the orch-realm weekly-share
# guard further down (`orch_realm_share_state`).
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
#
# INERT ON THIS DEPLOYMENT (issue #4161): same root cause as the scout gate
# above — the USD spend counter is structurally $0 (no live dollar rate post
# ADR-0006/#704), so this backstop can never fire here. See the orch-realm
# weekly-share guard (`orch_realm_share_state`) for the live budget split.
PER_CYCLE_COST_CAP_USD_DEFAULT = 25.0

# Periodic session-restart cadence (issue #3787, filed from research #3750):
# `hydra-autopilot` runs as one long-lived Claude Code session per run, and
# prompt caching re-reads the ENTIRE prior transcript on every turn — so
# `cache_read_input_tokens` grows roughly linearly with turn count within a
# run even though none of that growth is load-bearing: every turn's
# genuinely-new content (the small collect-state.sh / decide.py JSON outputs)
# is already externalized to state.json/Redis every turn (the cycle-record
# write), so the model is re-paying to re-read content it already acted on.
# A sampled run (245 API calls, ~85min) went 56,739 -> 214,414 cache-read
# tokens/call, ~3.8x growth, ~33M cache-read tokens total.
#
# `_check_termination` fires a NEW terminate cause (`context_compaction`)
# every N **Autopilot Turns** (one `decide.py decide` invocation = one
# `state.turn` increment, issue #1769), reusing the exact same terminate ->
# drain.sh -> Phase 7 -> pace-gate-relaunch path the `budget` / `wall_clock` /
# `idle` / `failure_backstop` causes already use — no new relaunch machinery,
# no new in-flight-dispatch bookkeeping: the next pace-gate-launched run
# already re-seeds occupied pipeline slots from the live
# `/api/autopilot/inflight-slots` ledger (issue #1352) regardless of which
# cause ended the prior run, so a periodic restart is exactly as safe for
# in-flight worktree agents (separately dispatched processes, not
# conversational turns) as every other terminate cause already is.
#
# UNIT CORRECTION vs the issue's literal figure (design-concept artifact for
# #3787): the issue's modeled-savings table ("restart every 30/50/80/120
# turns") was computed directly over the sampled transcript's 245 RAW
# Anthropic API calls, not over `state.turn` — no raw-API-call counter exists
# anywhere in state.json/decide.py's inputs, and that same sampled transcript
# shows only ~20 `decide.py decide` invocations across those 245 calls
# (~12.25 raw calls per Autopilot Turn). Copying "80-120" verbatim onto
# `state.turn` would almost never fire (~20 turns is the sampled run's ENTIRE
# 85-minute life). Rescaling the issue's own "toward the conservative
# (80-120) end" instruction by that ~12.25x ratio lands at ~6.5-10 Autopilot
# Turns; the shipped default is 8.
#
# Operators tune the cadence via `state.limits.context_compaction_turns`
# (mirrored by `HYDRA_AUTOPILOT_CONTEXT_COMPACTION_TURNS` at bootstrap); 0 (or
# any non-positive / unparseable value) disables the periodic restart
# entirely — budget/wall_clock/idle/failure_backstop still apply. Deliberately
# NOT gated on `slots_occupied == 0` (unlike `idle`): a busy, dispatch-heavy
# run is exactly the scenario accumulating the most cache-read growth, so
# gating on idle slots would make this cause fire only where `idle` already
# does.
CONTEXT_COMPACTION_TURNS_DEFAULT = 8

# ---------------------------------------------------------------------------
# Quota-percent budget (issue #3867)
# ---------------------------------------------------------------------------
#
# The autopilot's `token_budget` is denominated in the WRONG CURRENCY. It counts
# cumulative subagent-reported input/output tokens (`state.cumulative_tokens`,
# advanced by reap.py on each completion), but what the operator actually pays is
# cache-weighted ACCOUNT UTILIZATION. Measured on run 2bcba309 (2026-08-05): the
# run "spent" 801k of a 4,000,000 token budget — 20% — and would have kept
# dispatching, while the OAuth meter over the same window moved the 5h
# utilization window 2% -> 30% (~150M raw tokens). One QA dispatch (4-subagent
# adversarial fan-out) moved ~15M raw tokens; one dev dispatch ~40M. A
# "conservative" token budget therefore does not bound real spend at all.
#
# The fix is a SECOND per-run cap denominated in utilization POINTS accrued over
# this run's own run-start baseline, read from the SAME `state.usage_eligibility`
# payload collect-state.sh already fetches every turn (`hydra raw GET
# /usage/eligibility` -> the nested `usage` object) — so the cap costs zero new
# I/O. The token budget stays as a secondary bound; both remain hygiene caps.
#
# OPT-IN, DEFAULT DISABLED. `limits.quota_5h_max_pts` / `limits.quota_week_max_pts`
# default to 0 in bootstrap.sh and 0 (or absent, or unparseable) means the cap
# never fires, leaving every existing termination path byte-identical. There is no
# calibration data for a safe default, and ADR-0021 D5 keeps per-run limits
# "hygiene caps, subordinate to the [Pace] Gate, which is the real governor" — so
# this must never become a second load-bearing governor the operator didn't ask
# for. Accordingly this code reads raw `usage.percentLast5h` /
# `usage.percentSinceReset` ONLY: never `paceState` / `targetPercent`, which are
# weekly-CURVE-relative (ADR-0021 D2/D3) and answer a different question
# ("ahead/behind the target ramp") than this cap's ("did THIS run burn N points").
#
# `term-check.py` mirrors the READ half of this logic verbatim (the same
# literal-duplicate convention as CONTEXT_COMPACTION_TURNS_DEFAULT above, so
# Phase 3 stays a cheap dependency-free pre-check). Only decide.py performs the
# baseline CAPTURE — term-check.py is intentionally side-effect-free, so it skips
# the cap entirely until decide.py has written `state.quota_baseline`.
QUOTA_CAP_DISABLED = 0.0


def _quota_finite_pct(value) -> float | None:
    """Coerce a usage percentage to a usable float, or None.

    Rejects bools (`isinstance(True, int)` is True in Python, and a JSON `true`
    must never read as 1%), non-numerics, NaN/±inf (Python's json accepts NaN
    even though the spec forbids it), and negatives. `None` means "no usable
    reading this turn" and every caller treats that as fail-open (skip the cap),
    matching `_normalize_usage_eligibility`'s tolerance for a missing payload.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    if not math.isfinite(f) or f < 0:
        return None
    return f


def _quota_caps(limits: dict) -> tuple[float, float]:
    """Resolve `(cap_5h_pts, cap_week_pts)` from `state.limits`.

    `0.0` for either means DISABLED (the default). A negative / unparseable /
    absent value also resolves to disabled — the fail-safe direction, because the
    alternative (a tiny accidental cap) would terminate healthy runs instantly.
    """
    def _one(key: str) -> float:
        try:
            raw = limits.get(key, 0)
            v = float(raw if raw is not None else 0)
        except (TypeError, ValueError):
            return QUOTA_CAP_DISABLED
        if not math.isfinite(v) or v <= 0:
            return QUOTA_CAP_DISABLED
        return v

    return _one("quota_5h_max_pts"), _one("quota_week_max_pts")


def _quota_current_percents(state: dict) -> tuple[float | None, float | None]:
    """Current `(percentLast5h, percentSinceReset)` from `state.usage_eligibility`.

    Returns `(None, None)` when the meter is not usable this turn — an absent /
    malformed payload, or `usage.calibrated` anything other than `True`. An
    uncalibrated meter is a guess, and terminating a run on a guessed spend
    figure is strictly worse than letting the wall-clock / token bounds catch it.
    """
    usage = _normalize_usage_eligibility(state.get("usage_eligibility"))["usage"]
    if usage.get("calibrated") is not True:
        return (None, None)
    return (
        _quota_finite_pct(usage.get("percentLast5h")),
        _quota_finite_pct(usage.get("percentSinceReset")),
    )


def _capture_quota_baseline(state: dict, now: int) -> None:
    """Lazily capture (and reset-rebase) `state.quota_baseline`. MUTATES `state`.

    The ONE mutating half of the quota cap, and the reason the capture lives in
    decide.py rather than bootstrap.sh: bootstrap's Phase 0 side effects are
    enumerated in its own header docstring (heartbeat/log/state init only), and
    adding an HTTP dependency there risks failing Phase 0 on a transient
    orchestrator hiccup before any turn has run. Capturing lazily here reuses the
    payload collect-state.sh already injects every turn — zero new I/O — and
    inherits `_normalize_usage_eligibility`'s fail-open tolerance.

    Three behaviours, in order:

    1. **Cap disabled** → return immediately WITHOUT touching `state`. This is
       what keeps a default run byte-identical: no `quota_baseline` key ever
       appears, so main()'s change-detection never fires a write-back either.
    2. **First calibrated turn** → write the baseline once. `captured_epoch`
       records when, for operator forensics.
    3. **5h-window / weekly reset mid-run** → a CURRENT percentage BELOW the
       baseline means the window rolled over and headroom came back. That is good
       news, not a spend event: clamp the delta to zero (see
       `_quota_delta_exceeded`) AND rebase the baseline down to the new current
       value, so post-reset spend is measured fresh from the new window. A reset
       must never register as negative spend and must never itself terminate.

    Persistence is main()'s job via the existing `_persist_state_writeback`
    tmp-file + `os.replace` helper (the same mechanism proven for the
    force-research counter and the #1769 turn counter) — no new persistence
    machinery, and a crash mid-write can never tear state.json.
    """
    limits = state.get("limits") or {}
    cap_5h, cap_week = _quota_caps(limits)
    if cap_5h <= 0 and cap_week <= 0:
        return
    cur_5h, cur_week = _quota_current_percents(state)
    if cur_5h is None and cur_week is None:
        return

    base = state.get("quota_baseline")
    if not isinstance(base, dict):
        state["quota_baseline"] = {
            "percent_5h": cur_5h,
            "percent_week": cur_week,
            "captured_epoch": now,
            "rebased_epoch": None,
        }
        return

    rebased = False
    for key, cur in (("percent_5h", cur_5h), ("percent_week", cur_week)):
        if cur is None:
            continue
        prev = _quota_finite_pct(base.get(key))
        if prev is None:
            # The baseline never got a usable reading for this window (the meter
            # reported only one of the two on the capture turn) — fill it now.
            base[key] = cur
            rebased = True
        elif cur < prev:
            base[key] = cur
            rebased = True
    if rebased:
        base["rebased_epoch"] = now
        state["quota_baseline"] = base


def _quota_delta_exceeded(state: dict) -> tuple[str, str] | None:
    """PURE: has this run's utilization delta crossed its cap? `(window, detail)`.

    Mirrored verbatim by `term-check.py`. Returns `None` — keep iterating — for
    every fail-open condition: cap disabled, no baseline captured yet, no usable
    current reading. The 5h window is checked before the weekly one because it is
    the tighter, faster-moving bound (and the one the issue's acceptance criterion
    names).

    A NEGATIVE delta is clamped to zero rather than compared: a mid-run window
    reset must never read as spend, and must never itself force a termination
    (`_capture_quota_baseline` has already rebased the baseline for subsequent
    turns).
    """
    limits = state.get("limits") or {}
    cap_5h, cap_week = _quota_caps(limits)
    if cap_5h <= 0 and cap_week <= 0:
        return None
    base = state.get("quota_baseline")
    if not isinstance(base, dict):
        return None
    cur_5h, cur_week = _quota_current_percents(state)

    for window, cap, cur, base_key in (
        ("5h", cap_5h, cur_5h, "percent_5h"),
        ("week", cap_week, cur_week, "percent_week"),
    ):
        if cap <= 0 or cur is None:
            continue
        prev = _quota_finite_pct(base.get(base_key))
        if prev is None:
            continue
        delta = cur - prev
        if delta < 0:
            delta = 0.0
        if delta >= cap:
            return (
                window,
                f"{window} utilization +{delta:.1f}pts >= cap {cap:.1f}pts "
                f"(baseline={prev:.1f} current={cur:.1f})",
            )
    return None


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
    # tickets_orch (issue #3423, epic #3419, ADR-0030 Decision 2/5) turns a
    # resolved orchestrator plan/finding into one parent epic + N tracer-bullet
    # child issues on the ORCHESTRATOR GH board (via the vendored upstream
    # to-tickets skill + Hydra AFK overlay) — orch-scope by definition (ADR-0030
    # charted the orchestrator taxonomy only; Target mirrors were ruled out at
    # charting). Under `target-only` the autopilot stays out of orch work, so
    # tickets_orch is excluded, mirroring wayfinder_orch / scout_orch /
    # architecture_orch / retro_orch / cleanup_orch / skill_prune above.
    "tickets_orch",
)

# 5-retry escalation per pattern (issue #426 AC; failure modes section).
MAX_FAILURE_RETRIES = 5

# Default failure-log path consumed by self_heal.py when called from outside
# decide.py (e.g. the Bash hook around dispatch).
DEFAULT_FAILURE_LOG = "/tmp/hydra-autopilot-failures.jsonl"

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


def make_surface_pr(
    pr_number: int | str,
    cause: str,
    reason: str,
    closing_issue: int | None = None,
) -> dict:
    """Construct a `surface-pr` action (issues #4240, #4460).

    Routes ONE PR whose Pre-merge Gate state no PR-level action can fix —
    `cause: dirty` (a merge conflict `update-branch` cannot resolve),
    `cause: unchecked` (zero check-runs past the grace window on a healthy
    trigger arm — CI never started), or `cause: glm-red-forward-fix-exhausted`
    (#4460: a GLM-authored PR still red on a required check after the pinned
    forward-fix dispatch cap) — to the operator: the tool binding
    applies `ready-for-human` via `gh api repos/.../issues/N/labels` (never
    `gh pr edit`, which is broken per operator memory) and posts ONE comment
    naming the cause. The label on the PR is the idempotency key —
    collect-state.sh excludes already-labelled PRs from the dirty/unchecked
    buckets (and from the #4460 glm-red predicate, INV-3b) at read time, so
    decide.py never re-surfaces one (it keeps no memory). Per-PR on purpose:
    `route-prs-to-review` is brake-only, carries no PR list, and labels
    EVERY open PR — the wrong blast radius for one conflicting branch.

    `closing_issue` (issue #4807, optional) is the PR's single closing issue,
    pre-resolved by collect-state.sh (`orch_prs_dirty_surface`): when present
    the binding also hands the ISSUE off truthfully (`needs-dev-resume` ->
    `ready-for-human` + one comment). Omitted when the anchor is ambiguous or
    for causes that carry no issue handoff.
    """
    action = {
        "type": "surface-pr",
        "pr_number": pr_number,
        "cause": cause,
        "reason": reason,
    }
    if closing_issue is not None:
        action["closing_issue"] = closing_issue
    return action


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

    Emitted by `_rule_escalation` when a budget gate — the Subscription Usage
    Tracker hard-stop (`dispatch_blocked`), the usage-shed soft throttle
    (`usage_shed`, issue #4441), or the orch-realm weekly-share guard
    (`orch_realm_share_exceeded`, issue #4235) — suppresses an escalation the
    cascade reducer would OTHERWISE have fired. It answers the "is the gate too restrictive?" question
    the issue flags: without this event a throttled escalation is invisible and
    cannot be told apart from "cascading never triggered".

    `block_reason` is the gate verdict — `usage_dispatch_blocked` (the
    Subscription Usage Tracker hard stop), `usage_shed` (the class is in this
    turn's usage-eligibility shed set, issue #4441), or `orch_realm_share_exceeded`
    (the orch-realm weekly-share guard, issue #4235); `to_model` is the
    escalate-to tier the gate suppressed. `trigger_reason` is
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


def make_candidate_exclusion_event(
    state: dict,
    now: int,
    *,
    anchor: str,
    member: str,
    verdict: str,
    evidence: str,
) -> dict:
    """Construct one `candidate_exclusion` telemetry event (issue #3964).

    `collect-state.sh` already re-evaluates the four live Candidate Exclusion
    predicates (target-scope #2701, in-flight-dev #3711, mechanical #1230,
    trivial-anchor #1088) against every open `ready-for-agent` orchestrator
    issue and threads the verdicts into `state.candidate_exclusions` under
    `candidate_exclusions_json=` — this function just re-emits ONE evaluation
    of that pre-computed list as an observability event, identical mechanism
    to `make_cascade_blocked_event`.

    `anchor` is `issue-<N>` (never a bare number — matches the
    `orch_*_anchor` convention). `verdict` is `excluded` | `survived`;
    `evidence` is the exclusion reason (`pr-body-ref` / `target-backlog-label`
    / etc.) or `""` for a `survived` verdict. Rides
    `hydra:autopilot:slot-events` alongside the other decide.py observability
    events; the field-agnostic bridge forwards it verbatim. Every value is
    string-serialisable for XADD.
    """
    return {
        "event": "candidate_exclusion",
        "turn_n": str(int(state.get("turn", 0) or 0)),
        "run_id": str(state.get("run_id") or ""),
        "anchor": str(anchor),
        "member": str(member),
        "verdict": str(verdict),
        "evidence": str(evidence),
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
    # Issue #4240: surface ONE unfixable-gate PR (dirty / unchecked) to the
    # operator via the ready-for-human label + a cause-naming comment.
    "surface-pr",
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


def pipeline_refire_elapsed(state: dict, cls: str, now: int) -> bool:
    """True iff pipeline class `cls` is outside its re-fire interval (#4611).

    Reads `state.signal_last_fired[cls]` — the plan-time stamp
    `_rule_pipeline_dispatch` writes via `stamp_signal` when it emits a dispatch
    for a class in PIPELINE_REFIRE_SEC. An absent / null / 0 stamp means
    never-fired → eligible (the `signal_is_cooled` cold-start semantics). A
    class with no interval (absent from PIPELINE_REFIRE_SEC) is always eligible.
    """
    interval = PIPELINE_REFIRE_SEC.get(cls, 0)
    if interval <= 0:
        return True
    last = (state.get("signal_last_fired") or {}).get(cls) or 0
    try:
        last = int(last)
    except (TypeError, ValueError):
        # A malformed stamp must not wedge the slot forever — treat as
        # never-fired (fail-open), and say so.
        print(
            f"decide.py: signal_last_fired[{cls!r}]={last!r} is not an epoch — "
            "treating as never-fired (#4611)",
            file=sys.stderr,
        )
        return True
    return (now - last) >= interval


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


def _rule_termination(state: dict, now: int, events: list[dict] | None = None) -> _RuleOutput:
    """Step 1 — termination check (budget / wall-clock / idle / 5-failure backstop).

    Returns a `_RuleOutput` whose `terminate` is the lone `terminate` action
    when tripped (and an early `turn_end` event, since termination is a
    turn-ending decision in its own right), or an empty output otherwise.
    """
    out = _RuleOutput()
    term = _check_termination(state, now, events)
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


def _rule_candidate_exclusions(state: dict, now: int) -> _RuleOutput:
    """Step 1.1 — Candidate Exclusion telemetry (issue #3964).

    `collect-state.sh` already re-evaluates the four live Candidate Exclusion
    predicates (target-scope #2701, in-flight-dev #3711, mechanical #1230,
    trivial-anchor #1088) against every open `ready-for-agent` orchestrator
    issue and threads the pre-computed verdicts into
    `state.candidate_exclusions` under `candidate_exclusions_json=` (design
    decided on wayfinder #3954). This rule stays PURE — it does no
    enumeration, no network, no Redis; it just re-emits one
    `candidate_exclusion` event per evaluation, identical mechanism to
    `_rule_escalation`'s `make_cascade_blocked_event` calls.

    No dispatch decision reads `state.candidate_exclusions` — this rule
    exists solely so the slot-events bridge can persist each evaluation into
    the durable ring the `rollupCandidateExclusions` aggregator folds.
    `state.candidate_exclusions` absent/malformed (legacy state, or a
    collect-state.sh failure) degrades to zero events — never an error.
    """
    out = _RuleOutput()
    raw = state.get("candidate_exclusions")
    if not isinstance(raw, list):
        return out
    for ev in raw:
        if not isinstance(ev, dict):
            continue
        anchor = ev.get("anchor")
        member = ev.get("member")
        verdict = ev.get("verdict")
        if not anchor or not member or verdict not in ("excluded", "survived"):
            continue
        out.events.append(
            make_candidate_exclusion_event(
                state,
                now,
                anchor=str(anchor),
                member=str(member),
                verdict=str(verdict),
                evidence=str(ev.get("evidence") or ""),
            )
        )
    return out


class _EventsLoadError:
    """Marker `main()` hands `decide()` when the OPTIONAL events.json
    positional (argv[4]) cannot be read or parsed (issue #4213, INV-7).

    Carries the path + error text so `_normalise_events` can surface the
    failure as `plan.reasons` (`events-malformed-ignored`) and
    `plan.debug.events_load_error` instead of the turn dying with a
    traceback. state.json / candidates.json keep their fail-hard behaviour —
    a missing or garbled state is not a degradable input.
    """

    __slots__ = ("path", "error")

    def __init__(self, path: str, error: str) -> None:
        self.path = path
        self.error = error


def _unwrap_events_container(raw: object) -> list | None:
    """Shared dict-unwrap for BOTH event lanes (issue #4213, INV-3).

    Returns the entry list for every shape an events payload legitimately
    arrives in, or ``None`` when `raw` is not a recognisable container:

      * ``None`` / absent                              -> ``[]``
      * a bare list / tuple / other non-string iterable -> ``list(raw)``
      * collect-state.sh's ``{"events": [...], "last_id": ...}``
                                                       -> ``raw["events"]``
        (a dict whose ``events`` is absent or not a list -> ``[]``)
      * anything else (str, bytes, int, bool, ...)     -> ``None``

    `_rule_slot_events` and `_rule_escalation` (the ``state.slot_events``
    lane) and `_normalise_events` (the ``events.json`` lane) ALL go through
    this one definition, so the two lanes can never diverge in accepted shape
    again — the asymmetry #4213 reports (the wrapper dict tolerated on one
    seam, fatal on the other) is removed by construction.
    """
    if raw is None:
        return []
    if isinstance(raw, dict):
        inner = raw.get("events")
        return list(inner) if isinstance(inner, list) else []
    if isinstance(raw, (str, bytes)):
        return None
    if isinstance(raw, (list, tuple)):
        return list(raw)
    try:
        return list(raw)  # type: ignore[call-overload]  # any other iterable
    except TypeError:
        return None


def _normalise_events(raw: object) -> tuple[list[dict], list[str]]:
    """Normalise the `events` argument into a guaranteed ``list[dict]``
    (issue #4213, INV-1 / INV-2).

    Runs ONCE, as the first statement of `decide()`, ahead of EVERY consumer
    (`_orch_board_read_degraded`, `_rule_termination` -> `_signal_present`,
    `_rule_completion_reaps`, the qa-verdict auto-merge sweep, the
    wait_or_reap ``completed_task_ids`` fold, the signal readers, the scout
    ``alert_count`` read), so no downstream ``for ev in events`` loop needs
    its own ``isinstance`` guard.

    Returns ``(events, reasons)``:

      * ``events``  — every usable dict entry of the unwrapped container, in
                      order. Each is either TYPED (has a ``type`` key — the
                      shape the consumers read) or STREAM-SHAPED (has a
                      ``fields`` dict — a raw ``hydra:autopilot:slot-events``
                      row exactly as collect-state.sh emits it). `decide()`
                      re-homes the latter onto ``state.slot_events`` via
                      `_rehome_stream_entries` so the ONE existing projection
                      in `_rule_slot_events` handles them (issue #4213 INV-4). Entries
                      that are neither are dropped.
      * ``reasons`` — degradation markers for ``plan.reasons``:
                      ``events-malformed-ignored`` when `raw` is an
                      `_EventsLoadError` marker or an unrecognisable
                      container (the turn proceeds with ``[]``);
                      ``events-entry-skipped:<n>`` when ``<n>`` entries were
                      dropped.

    Pure: no IO, no state access. Never raises on shape.
    """
    if isinstance(raw, _EventsLoadError):
        return [], ["events-malformed-ignored"]
    entries = _unwrap_events_container(raw)
    if entries is None:
        return [], ["events-malformed-ignored"]
    events: list[dict] = []
    skipped = 0
    for ev in entries:
        if isinstance(ev, dict) and ("type" in ev or isinstance(ev.get("fields"), dict)):
            events.append(ev)
        else:
            skipped += 1
    reasons: list[str] = []
    if skipped:
        reasons.append(f"events-entry-skipped:{skipped}")
    return events, reasons


def _rehome_stream_entries(state: dict, events: list[dict]) -> tuple[list[dict], int]:
    """Move stream-shaped entries off the events lane onto
    ``state.slot_events`` (issue #4213, INV-4).

    `events` is the `_normalise_events` output. Entries carrying a ``fields``
    dict and no ``type`` are raw ``hydra:autopilot:slot-events`` rows. The
    consumers of `events` read ``ev["type"]`` and would silently ignore them
    (comment 2 on #4213: an unwrap-only fix turns the crash into a silent
    drop that frees no slots, with zero diagnostic). Rather than a SECOND
    projection, they are appended to ``state.slot_events`` — dedup by stream
    ``id`` against entries already there — so `_rule_slot_events` (and
    `_rule_escalation`, which reads the same list) translate them exactly as
    if collect-state.sh had put them there: a ``subagent_stop`` passed as
    events.json frees its slot.

    Mutates ``state["slot_events"]`` in memory only — the same telemetry
    class as the slot_history / failure_log mutations in `_rule_slot_events`
    (#4213 INV-8: `main()` adds no persist trigger for it). Preserves the
    container's shape: a ``{"events": [...], "last_id": ...}`` dict keeps its
    ``last_id``.

    Returns ``(typed_events, rehomed_count)``.
    """
    typed: list[dict] = []
    stream: list[dict] = []
    for ev in events:
        if "type" not in ev and isinstance(ev.get("fields"), dict):
            stream.append(ev)
        else:
            typed.append(ev)
    if not stream:
        return typed, 0
    container = state.get("slot_events")
    if isinstance(container, dict):
        existing = container.get("events")
        if not isinstance(existing, list):
            existing = []
            container["events"] = existing
    elif isinstance(container, list):
        existing = container
    else:
        existing = []
        state["slot_events"] = existing
    seen_ids = {
        ev.get("id") for ev in existing
        if isinstance(ev, dict) and ev.get("id") is not None
    }
    rehomed = 0
    for ev in stream:
        ev_id = ev.get("id")
        if ev_id is not None and ev_id in seen_ids:
            continue
        existing.append(ev)
        if ev_id is not None:
            seen_ids.add(ev_id)
        rehomed += 1
    return typed, rehomed


def _slot_event_time(raw_ev: dict) -> int | None:
    """Best-effort event time (epoch seconds) for one raw ``slot_events`` entry
    (issue #4441).

    Prefers ``fields.ts_epoch`` when it parses to a positive int (the hooks
    stamp this on every emit). Falls back to the millisecond prefix of the
    stream id — the digits before the ``-`` in a Redis stream id — divided by
    1000: both `hooks/on-subagent-stop.sh` and
    `hooks/on-subagent-permission-wait.sh` `XADD` with ``*``, so the id's ms
    prefix is an exact proxy for emit time when ``ts_epoch`` is absent.

    Returns ``None`` when NEITHER resolves — the caller (`_filter_stale_slot_events`)
    MUST fail open (treat as current) on a ``None`` result (issue #4441 INV-2): this
    function may only ever return a time it can prove, never guess one.
    """
    fields = raw_ev.get("fields") if isinstance(raw_ev.get("fields"), dict) else raw_ev
    if isinstance(fields, dict):
        try:
            ts_epoch = int(fields.get("ts_epoch"))
            if ts_epoch > 0:
                return ts_epoch
        except (TypeError, ValueError):
            pass
    stream_id = raw_ev.get("id")
    if isinstance(stream_id, str):
        ms_part = stream_id.split("-", 1)[0]
        if ms_part.isdigit():
            try:
                return int(ms_part) // 1000
            except (TypeError, ValueError):
                return None
    return None


def _filter_stale_slot_events(state: dict, now: int) -> int:
    """Drop ``state.slot_events`` entries that predate this autopilot run
    (issue #4441).

    Background: `collect-state.sh` reads its slot-events cursor from
    `HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID` (env, default ``0``) and never
    persists/reads a cursor in `state.json`. A fresh bootstrap (or any collect
    where the playbook forgot to export the running cursor) therefore replays
    historical `hydra:autopilot:slot-events` stream entries from a PRIOR run.
    Both `_rule_slot_events` (reap synthesis + slot_history/failure_log
    telemetry) and `_rule_escalation` (cascade re-dispatch) read
    `state.slot_events` INDEPENDENTLY, so filtering the container ONCE here —
    before either rule runs — is the single shared gate that keeps the two
    lanes from drifting apart (the #4213 shared-unwrap precedent: one helper,
    not two hand-rolled copies).

    SCOPED to the two kinds `_rule_slot_events` / `_rule_escalation` actually
    translate into a reap or a re-dispatch: `subagent_stop` and
    `slot_waiting_permission`. `state.slot_events` also carries OTHER kinds
    (e.g. `pr_lifecycle`) that neither rule reads — those pass through
    untouched and uncounted regardless of age, so this filter never reports a
    drop for an entry that was already inert. (Discovered via the
    `turn1-dev-in-flight` / `turn1-subagent-wedge` golden fixtures, which
    replay 100 real `pr_lifecycle` rows older than their `started_epoch`: an
    unscoped filter dropped all 100 and injected a spurious
    `slot-events-stale-skipped:100` reason into a plan that has nothing to do
    with subagent completions.)

    An entry is stale iff BOTH `_slot_event_time(entry)` and
    `state.started_epoch` resolve to a positive int AND the entry's time is
    STRICTLY EARLIER than `started_epoch`. Either side being absent, zero, or
    unparseable fails OPEN — the entry is kept (issue #4441 INV-2): this filter may only
    ever drop entries it can prove predate the run, never entries it merely
    can't place in time.

    Mutates `state["slot_events"]` in place, preserving the container's
    dict-vs-list shape (the same convention `_rehome_stream_entries` uses) so
    every existing consumer of `state.get("slot_events")` sees the pruned list
    with no shape change. Returns the count of entries dropped, so the caller
    can emit ONE `slot-events-stale-skipped:<n>` reason for the whole turn
    (issue #4441 INV-3) — never once per rule, since both rules now read the same
    already-filtered list.

    Pure: no IO, no clock read (the caller supplies `now`, unused here but
    kept for signature symmetry with the other rules) — only
    `state.started_epoch` and the entries themselves (issue #4441 INV-7).
    """
    try:
        started_epoch = int(state.get("started_epoch") or 0)
    except (TypeError, ValueError):
        started_epoch = 0
    if started_epoch <= 0:
        return 0
    container = state.get("slot_events")
    if isinstance(container, dict):
        entries = container.get("events")
        if not isinstance(entries, list):
            return 0
        is_dict_container = True
    elif isinstance(container, list):
        entries = container
        is_dict_container = False
    else:
        return 0
    kept: list = []
    dropped = 0
    for raw_ev in entries:
        if isinstance(raw_ev, dict):
            fields = raw_ev.get("fields") if isinstance(raw_ev.get("fields"), dict) else raw_ev
            kind = fields.get("event") if isinstance(fields, dict) else None
            if kind in ("subagent_stop", "slot_waiting_permission"):
                ev_time = _slot_event_time(raw_ev)
                if ev_time is not None and ev_time > 0 and ev_time < started_epoch:
                    dropped += 1
                    continue
        kept.append(raw_ev)
    if dropped:
        if is_dict_container:
            container["events"] = kept
        else:
            state["slot_events"] = kept
    return dropped


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
    # Shared unwrap (issue #4213, INV-3): tolerates the collect-state JSON
    # shape {"events": [...], "last_id": ...} via the SAME helper the
    # events.json lane uses, so the two lanes cannot drift.
    slot_events_raw = _unwrap_events_container(state.get("slot_events")) or []
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
    state: dict,
    events: list[dict],
    now: int,
    *,
    dispatch_blocked: bool = False,
    shed_classes: set[str] = frozenset(),
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

    `shed_classes` is the SAME soft-throttle set `_rule_usage_eligibility` hands
    `_rule_pipeline_dispatch` / `_rule_signal_classes` (issue #4441, INV-4):
    before this rule, an escalation for a shed class bypassed the usage tracker
    entirely because `_rule_escalation` consulted only `dispatch_blocked` (the
    HARD stop) and `orch_realm_share_exceeded` — the observed bug (issue #4441)
    was a `cleanup_orch` escalation firing while `cleanup_orch` sat in
    `usage_eligibility.shed`. When the reducer says escalate but `slot` is in
    `shed_classes`, this rule now emits exactly ONE `cascade_routing_blocked`
    event with `block_reason="usage_shed"` and dispatches nothing — same
    suppress-but-record contract as the `dispatch_blocked` / orch-realm-share
    branches below. Precedence (hardest guard first): `usage_dispatch_blocked`,
    then `usage_shed`, then `orch_realm_share_exceeded`.

    Pure w.r.t. fs/network/Redis; reads state.slot_events + state.slots + signals.
    """
    out = _RuleOutput()
    escalated_slots: set[str] = set()
    if dispatch_blocked:
        out.debug["escalation_usage_dispatch_blocked"] = True
    # Shared unwrap (issue #4213, INV-3) — same helper as _rule_slot_events.
    slot_events_raw = _unwrap_events_container(state.get("slot_events")) or []
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
        # Usage-shed parity (issue #4441, INV-4) — evaluated AFTER the hard
        # stop above (it wins when both fire) and BEFORE the orch-realm-share
        # guard below (precedence documented on the docstring). `slot` here is
        # the ESCALATION_POLICY class (e.g. cleanup_orch), the same key
        # `_rule_pipeline_dispatch` / `_rule_signal_classes` test against
        # `shed_classes` — no re-derivation, same set threaded from
        # `_rule_usage_eligibility` via decide().
        if slot in shed_classes:
            out.events.append(
                make_cascade_blocked_event(
                    state,
                    now,
                    cls=slot,
                    trigger_reason=trigger_reason,
                    to_model=decision["escalate_model"],
                    block_reason="usage_shed",
                )
            )
            continue
        # Orch-realm weekly-share guard (issue #4235) — the escalation-seam
        # twin of the pipeline (#4161) and signal-loop call sites: the SAME
        # verbatim predicate (`CLASS_SCOPE == "orch"` keeps it one-directional
        # so a future target/both-scope policy row is never throttled by the
        # orch share), the same default-disabled arming, and the same debug
        # breadcrumb. Evaluated strictly AFTER the usage hard stop above (the
        # harder limit wins the block_reason when both fire) and only once the
        # reducer has said escalate (a success / saturated no_op / attempt-capped
        # stop is not a routing decision and records nothing). Suppress-but-
        # record, never a silent drop: ONE `cascade_routing_blocked` event, no
        # dispatch, no escalation event, no escalated_slots entry, no attempt+1.
        # The stop event is consumed this turn either way — no deferral queue.
        if CLASS_SCOPE.get(slot) == "orch" and orch_realm_share_exceeded(state):
            cap = orch_realm_share_state(state)
            out.debug.setdefault("orch_realm_share_skipped", {
                "max_share": cap["max_share"],
                "share": cap["share"],
            })
            out.events.append(
                make_cascade_blocked_event(
                    state,
                    now,
                    cls=slot,
                    trigger_reason=trigger_reason,
                    to_model=decision["escalate_model"],
                    block_reason="orch_realm_share_exceeded",
                )
            )
            continue
        skill = CLASS_SKILL.get(slot, "")
        # Issue #4605, INV-4: an ESCALATION_POLICY row may carry an optional
        # static `prompt_args` dict (today only cleanup_orch's `apply:true`)
        # that must ride along on the escalation re-dispatch too — otherwise
        # the #3274 dedup keeps this escalation copy over the plain signal
        # copy and the apply stamp silently vanishes on exactly the turns a
        # signal-class and its escalation co-fire. Row-specific keys first,
        # then the escalation-machinery keys (which always win on collision;
        # no row uses those names). A row without `prompt_args` (e.g.
        # dev_orch) leaves this dispatch byte-identical to before.
        escalation_prompt_args = dict(ESCALATION_POLICY[slot].get("prompt_args") or {})
        escalation_prompt_args.update({
            "escalate_model": decision["escalate_model"],
            "attempt": prior_attempt + 1,
            "prior_attempt_status": status,
        })
        out.emit(
            make_dispatch(
                slot,
                skill,
                prompt_args=escalation_prompt_args,
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


def _pr_gate_numbers(state: dict, events: list[dict], key: str) -> list[int]:
    """Parse one PR-gate PR-number signal (issue #4240) into a sorted int list.

    collect-state.sh emits `orch_prs_dirty` / `orch_prs_unchecked` /
    `orch_prs_behind` as fresh per-turn facts (space-separated PR numbers,
    pre-classified — see its PR-gate block). The playbook merges them verbatim
    into `state.signals.<key>` (the same seam as `needs_qa_numbers`). Events
    take precedence over state, mirroring `_signal_present`. Returns a
    deduplicated list sorted ASCENDING (lowest PR number first) — INV-D's
    "oldest-first" update-branch cap is applied over this order. Absent /
    malformed signal → empty list (no bucket members; fail-open — the absence
    of a bucket is the pre-#4240 behaviour, never a hold).

    Pure: no side effects.
    """
    raw = _raw_signal(state, events, key)
    if raw is None:
        return []
    candidates = raw if isinstance(raw, (list, tuple)) else str(raw).split()
    seen: set[int] = set()
    for token in candidates:
        try:
            seen.add(int(str(token).strip()))
        except (TypeError, ValueError):
            continue
    return sorted(seen)


def _pr_gate_buckets(state: dict, events: list[dict]) -> dict:
    """The four PR-gate facts, pre-resolved by collect-state.sh (issue #4240).

    ADR-0007 division of labour: decide.py never calls `gh`, so EVERY
    per-PR fact (mergeStateStatus, statusCheckRollup emptiness, the grace /
    quiescence windows, the ready-for-human / no-rebase / draft filters)
    arrives pre-classified in `state.signals` — this function only parses
    them. `ci_trigger_stale` is the repo-wide discriminator: at least one
    unchecked PR is NEWER than the newest `push`/`pull_request` workflow run,
    i.e. direct evidence the trigger arm did not fire for it. Returns the
    INV-A debug shape: {dirty:[], unchecked:[], behind:[], ci_trigger_stale:bool}.
    """
    return {
        "dirty": _pr_gate_numbers(state, events, "orch_prs_dirty"),
        "unchecked": _pr_gate_numbers(state, events, "orch_prs_unchecked"),
        "behind": _pr_gate_numbers(state, events, "orch_prs_behind"),
        "ci_trigger_stale": _signal_present(state, events, "orch_ci_trigger_stale"),
    }


def _pr_gate_number_in(pr_number: object, bucket: list[int]) -> bool:
    """Membership test tolerant of a string-typed event `pr_number`."""
    try:
        return int(str(pr_number).strip()) in bucket
    except (TypeError, ValueError):
        return False


_QA_VERDICT_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")


def qa_verdict_sha_matches(verdict_sha: object, head_sha: object) -> bool:
    """True iff `verdict_sha` (a `QA-Verdict:` trailer's `sha=`) was rendered
    for `head_sha` — a 7–40 hex prefix of the full head SHA.

    Python twin of `qaVerdictShaMatches()` (scripts/ci/qa-verdict.ts, #4746):
    the `unknown` sentinel, a non-hex value, and a blank head NEVER match — an
    unknown SHA must never satisfy a merge guard. Pure; never raises.
    """
    head = str(head_sha if head_sha is not None else "").strip().lower()
    sha = str(verdict_sha if verdict_sha is not None else "").strip().lower()
    if not head or not _QA_VERDICT_SHA_RE.match(sha):
        return False
    return head.startswith(sha)


def _qa_verdict_is_stale(ev: dict) -> bool:
    """Issue #4737: True when a `qa-verdict` event carries SHA evidence
    (`verdict_sha` and/or `head_sha`) that does NOT bind the verdict to the
    PR's current head. An event with neither field is not judged stale
    (legacy producers; INV-007 alone applies)."""
    if "verdict_sha" not in ev and "head_sha" not in ev:
        return False
    return not qa_verdict_sha_matches(ev.get("verdict_sha"), ev.get("head_sha"))


def _rule_auto_merge_sweep(state: dict, events: list[dict]) -> _RuleOutput:
    """Step 3 — auto-merge sweep (before dispatch so freed PRs don't compete).

    Emergency-brake gate (issue #744): the operator-only brake overrides the
    ADR-0015 depth-gated verdict at THIS call site — NOT inside
    `should_auto_merge()`, which stays a pure depth-policy function. When the
    brake is engaged we emit ZERO `auto-merge` actions and exactly ONE
    `route-prs-to-review` action. `decide()` never reads/writes the brake from
    Redis — it arrives as the read-only `state.emergency_brake` field.

    PR-gate hold (issue #4240, INV-B): a qa-verdict PASS whose PR sits in the
    `dirty` or `unchecked` bucket NEVER yields an auto-merge this turn. An
    auto-merge on a DIRTY PR arms `--auto` on a branch that can never satisfy
    "branch up to date"; on an unchecked PR nothing can ever go green (PR
    #4236 sat permanently unmergeable and silent for 3h). The hold is named in
    the plan's reasons (hold:#N:dirty | hold:#N:unchecked) instead of being
    silence — the defect this issue filed was precisely that "no checks
    reported" produced no action, no reason, and no debug field.
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
    buckets = _pr_gate_buckets(state, events)
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
        if _pr_gate_number_in(pr_number, buckets["dirty"]):
            out.reasons.append(f"hold:#{pr_number}:dirty")
            continue
        if _pr_gate_number_in(pr_number, buckets["unchecked"]):
            out.reasons.append(f"hold:#{pr_number}:unchecked")
            continue
        # QA merge guard (issue #4737): a PASS reviewed at a head other than
        # the PR's current one must not arm auto-merge — alongside INV-007.
        if verdict == "PASS" and _qa_verdict_is_stale(ev):
            out.reasons.append(f"hold:#{pr_number}:stale-verdict")
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


# Cap on update-branch emissions per turn (issue #4240 INV-D): the behind
# bucket can hold many PRs after a merge wave; two per turn oldest-first
# (lowest PR number first) keeps each turn's GitHub mutations bounded and
# lets the next turn re-classify whatever remains.
PR_GATE_UPDATE_BRANCH_CAP = 2


def _rule_pr_gate(state: dict, events: list[dict]) -> _RuleOutput:
    """Step 3.5 — PR-gate surfacing and rebasing (issue #4240).

    Acts on the same four pre-resolved buckets `_rule_auto_merge_sweep` holds
    merges against:

      - dirty        → one `surface-pr {cause: dirty}` per PR. `update-branch`
                       422s on a conflicting PR (and neither close+reopen nor
                       an empty commit resolves a conflict — the issue's own
                       two failed remediation attempts), so the operator is
                       the only fixer; mirror scripts/ci/pr-rebase.ts's
                       DIRTY → surface split.
      - unchecked    → `surface-pr {cause: unchecked}` ONLY while the trigger
                       arm is healthy. While `ci_trigger_stale` is true, a
                       PR-level label fixes nothing (the outage is repo-wide),
                       and surfacing every PR would flood ready-for-human —
                       so the plan holds with a named reason instead
                       (#4240 INV-C). The hold NEVER suppresses a dispatch of any
                       class (INV-E): #4130's lesson is that a signal with a
                       false-positive path must not dead-arm a class.
      - behind       → `update-branch` for the two oldest quiescent PRs
                       (INV-D). The quiescence window, the no-rebase opt-out,
                       and cap enforcement live in collect-state's
                       classification; decide.py only honours the order.

    Pure: reads pre-resolved signals only, never calls gh.
    """
    out = _RuleOutput()
    buckets = _pr_gate_buckets(state, events)
    # ISSUE #4807 (INV-7): surface only the SUBSET collect-state pre-selected
    # (one conflict-fix attempt already spent, or anchor ambiguous) — NOT every
    # member of the dirty bucket, which stays whole for the sweep's
    # `hold:#N:dirty` and for the conflict-fix pin.
    for pr, closing in _dirty_surface_pairs(state, events):
        out.emit(
            make_surface_pr(
                pr,
                "dirty",
                "merge conflict — one automated conflict fix-forward already spent "
                "(or anchor ambiguous); operator review required",
                closing_issue=closing,
            ),
            reason=f"surface-pr:#{pr}:dirty",
        )
    if buckets["ci_trigger_stale"]:
        # Repo-wide outage: no PR-level action fixes an unchecked PR, so name
        # the hold instead of flooding the operator queue. Stated, never
        # dispatch-gating (#4240 INV-E).
        if buckets["unchecked"]:
            out.reasons.append("hold:ci-trigger-stale")
    else:
        for pr in buckets["unchecked"]:
            out.emit(
                make_surface_pr(
                    pr,
                    "unchecked",
                    "zero check-runs past the grace window with a healthy trigger arm — CI never started for this PR",
                ),
                reason=f"surface-pr:#{pr}:unchecked",
            )
    for pr in buckets["behind"][:PR_GATE_UPDATE_BRANCH_CAP]:
        out.emit(
            make_update_branch(
                pr,
                "BEHIND and quiescent — update-branch onto master (expected_head_sha guard)",
            ),
            reason=f"update-branch:#{pr}",
        )
    # ISSUE #4460 (INV-8): the dev_orch selector pins at most
    # GLM_RED_FORWARD_FIX_CAP forward-fix dispatches per stranded GLM PR.
    # When the cap is exhausted and collect-state STILL names that PR (the
    # predicate — which already excludes the ready-for-human label this
    # action applies — keeps qualifying it), no dispatch fires and this rule
    # is the only actor: surface the PR so the operator owns it. The applied
    # `ready-for-human` label is the TERMINAL exclusion — the next
    # collect-state pass drops the PR from the predicate (INV-3b), so this
    # emission self-extinguishes after one turn rather than repeating
    # forever. Exhaustion is surfaced, never silent.
    glm_fix = _glm_red_forward_fix_signal(state, events)
    if glm_fix is not None:
        _glm_issue, glm_pr, _glm_branch = glm_fix
        if _glm_red_attempt_count(state, glm_pr) >= GLM_RED_FORWARD_FIX_CAP:
            out.emit(
                make_surface_pr(
                    glm_pr,
                    "glm-red-forward-fix-exhausted",
                    "GLM-authored PR still red on a required check after the "
                    f"cap of {GLM_RED_FORWARD_FIX_CAP} pinned forward-fix dispatches — "
                    "operator review required (issue #4460)",
                ),
                reason=f"surface-pr:#{glm_pr}:glm-red-forward-fix-exhausted",
            )
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
        # Orch-realm weekly-share guard (issue #4161) — checked BEFORE the
        # selector, mirroring the cost-cap gates' "harder limit first"
        # placement. Suppresses ORCH-scope classes only (CLASS_SCOPE "orch"):
        # target-scope and realm-agnostic ("both") classes fall through, so
        # the guard is one-directional by construction. Default-disabled —
        # armed only by an explicit orch_realm_weekly_share_cap AND a usable share
        # reading, so on a default run this branch is inert.
        if CLASS_SCOPE.get(cls) == "orch" and orch_realm_share_exceeded(state):
            cap = orch_realm_share_state(state)
            out.debug.setdefault("orch_realm_share_skipped", {
                "max_share": cap["max_share"],
                "share": cap["share"],
            })
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="budget",
                    reason="orch realm weekly share exceeded",
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
        # Pipeline re-fire interval (issue #4611) — checked BEFORE the selector
        # (and after scope_excluded, so an excluded class neither emits a
        # cooldown event nor gets stamped), mirroring `_select_for_signal`'s
        # cooldown-first ordering: inside the window the outcome is "cooldown"
        # whether or not the trigger signal is present. Only classes in
        # PIPELINE_REFIRE_SEC (today: research_target) are affected.
        if not pipeline_refire_elapsed(state, cls, now):
            interval_h = PIPELINE_REFIRE_SEC.get(cls, 0) / 3600
            out.debug.setdefault("pipeline_refire_suppressed", {})[cls] = {
                "last_fired": (state.get("signal_last_fired") or {}).get(cls),
                "interval_sec": PIPELINE_REFIRE_SEC.get(cls, 0),
                "issue": 4611,
            }
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="cooldown",
                    reason=(
                        f"{cls} re-fire interval active "
                        f"({interval_h:g}h, issue #4611)"
                    ),
                )
            )
            out.skipped += 1
            continue
        # Target WIP-saturation guard (issue #4475, CSB swap prep, ex-#4241) —
        # checked BEFORE the selector, mirroring the cost-cap gate above, so it
        # suppresses dev_target for EITHER trigger (legacy
        # target_work_available or target_board_work_available). The boolean
        # is pre-resolved by collect-state.sh via scripts/autopilot/target-wip.py
        # — the ONE source of truth for the WIP limit and the liveness
        # predicate (an `in-progress` claim counts only when an open Target PR
        # references it; hydra-target-build Step 1 calls the same leaf).
        # Without this guard dev_target was dispatched straight into the
        # build's pre-flight WIP gate and bounced (~80k tokens for zero work).
        # Outcome stays "idle" (closed DISPATCH_DECISION_OUTCOMES set — the
        # #3829 precedent) with a distinct named reason + debug field.
        # A Target resume pin (issue #4739) is EXEMPT: the held PR already
        # exists and the resume issue carries needs-dev-resume, not
        # in-progress, so a resume is not new WIP (hydra-target-build Step
        # 0.7 skips its own WIP gate for the same reason).
        if (
            cls == "dev_target"
            and _signal_present(state, events, "target_wip_saturated")
            and _target_dev_resume_pick_signal(state, events) is None
        ):
            out.debug.setdefault("dev_target_wip_saturated", {
                "signal": "target_wip_saturated",
                "issue": 4475,
            })
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=cls, outcome="idle",
                    reason="Target WIP saturated (live in-progress claims at the WIP limit, #4475)",
                )
            )
            out.skipped += 1
            continue
        # qa_target builder-in-flight hold (issue #4653 + the #4795 resume
        # arm) — checked BEFORE the selector, mirroring the #4475
        # dev_target_wip_saturated guard just above: a PRE-SELECTOR
        # class-level suppression that leaves `_select_slot_qa_target`
        # byte-identical (design-concept INV-4). The needs-qa PR pre-resolved
        # by collect-state.sh (#4576) may have been opened OR resumed by the
        # dev_target dispatch that is STILL running — its builder can still
        # push fix-up commits, moving the head a QA review would otherwise
        # start against. `_qa_target_builder_hold` proves (by branch-token
        # identity, not inference) that the live dev_target slot IS that PR's
        # own builder, matching the head against EITHER `feature/<token>`
        # (a fresh #4653 build) OR `state.dev_target_resume_inflight.branch`
        # (a #4739 resume, which pushes to the PRIOR run's branch — recorded
        # at plan time on the dispatch turn); a null/malformed/mismatched
        # read returns None and this class dispatches exactly as it does
        # today (fail-open, the #3709 dead-arm class). Outcome stays "idle"
        # (closed DISPATCH_DECISION_OUTCOMES set) with a distinct named
        # reason + debug field, same shape as #4475's guard; the reason stays
        # byte-identical to the pre-#4795 text and still names #4653.
        if cls == "qa_target":
            held_pr_ref, held_resume_branch = _qa_target_builder_hold(state, events)
            if held_pr_ref:
                out.debug["qa_target_builder_inflight"] = {
                    "pr_ref": held_pr_ref,
                    "dev_target_task_id": ((state.get("slots") or {}).get("dev_target") or {}).get("task_id"),
                    "token": _qa_target_builder_token(((state.get("slots") or {}).get("dev_target") or {})),
                    "issue": 4653,
                    # #4795 INV-6: additive — the matched record's branch, or
                    # null when the #4653 (fresh-build) arm was the match.
                    "resume_branch": held_resume_branch,
                }
                out.events.append(
                    make_dispatch_decision_event(
                        state, now, cls=cls, outcome="idle",
                        reason=(
                            f"Target QA PR {held_pr_ref} — its dev_target "
                            "builder is still in flight (#4653)"
                        ),
                    )
                )
                out.skipped += 1
                continue
        action = _select_for_slot(cls, state, candidates, events, best, best_score, now)
        if action is None:
            # Issue #3829 (design-concept qaTrace: "How is the cap surfaced ...
            # satisfying the acceptance criterion's 'a label or signal'
            # wording?"): qa_orch's selector stamps a transient
            # `qa_orch_stalled_issue` on `state` when it suppresses dispatch
            # because the HEAD of the current needs-qa set exhausted its
            # attempt cap (as opposed to "no needs-qa issue at all", the
            # ordinary idle case). Surface the distinct reason + the stalled
            # issue number here instead of the generic "idle" one, then
            # consume the transient marker so it never leaks into the
            # persisted state.
            stalled_issue = state.pop("qa_orch_stalled_issue", None) if cls == "qa_orch" else None
            if stalled_issue is not None:
                # outcome stays "idle" (DISPATCH_DECISION_OUTCOMES is a closed
                # set, deliberately not extended here — no dispatch DID
                # happen, so "idle" is accurate) but the reason text + the
                # plan-level debug field name the stalled issue, giving this
                # suppression the "visible signal" the #3829 acceptance
                # criterion requires without adding a new outcome literal or a
                # GH-mutation side effect (design-concept invariant 1).
                out.debug["qa_orch_stalled_issue"] = stalled_issue
                out.events.append(
                    make_dispatch_decision_event(
                        state, now, cls=cls, outcome="idle",
                        reason=(
                            f"needs-qa issue #{stalled_issue} exhausted the "
                            f"{QA_STALL_MAX_ATTEMPTS}-attempt cap — "
                            "suppressed (issue #3829)"
                        ),
                    )
                )
            else:
                out.events.append(
                    make_dispatch_decision_event(
                        state, now, cls=cls, outcome="idle",
                        reason="selector found no eligible work",
                    )
                )
            out.skipped += 1
            continue
        out.emit(action, reason=f"dispatch:{cls}")
        # Issue #4611 — plan-time stamp for a class carrying a re-fire
        # interval. Every gate that could drop the action has passed here, so
        # the stamp corresponds 1:1 to an emitted dispatch (the #1666
        # `_research_force_stamp` precedent: a reap-/harness-side stamp is dead
        # when the run is interrupted or compaction-restarted). main() persists
        # it via the `signal_last_fired` snapshot/compare writeback pair.
        if cls in PIPELINE_REFIRE_SEC:
            stamp_signal(state, cls, now)
        # Issue #4795 — plan-time stamp of a #4739 dev_target RESUME
        # dispatch's branch, so the #4653 qa_target builder-in-flight hold can
        # join a RESUMED build's PR head one turn later. The resume pushes to
        # the PRIOR run's branch, so the head can never equal
        # `feature/<live token>`; the harness never stamps prompt_args onto
        # the slot, so decide.py — which knows both halves on THIS turn — is
        # the only writer that can bind them. Same post-gate position as the
        # #4611 stamp above: one stamp = one emitted dispatch. The record is
        # overwritten wholesale by the next resume pin and never cleared — a
        # stale one is inert (it can only match while the live slot carries
        # the exact token it names). main() persists it via the
        # `dev_target_resume_inflight` snapshot/compare writeback pair, and
        # the same dict is published on plan.debug for observability.
        if cls == "dev_target":
            resume_record = _dev_target_resume_record(action, state)
            if resume_record is not None:
                state["dev_target_resume_inflight"] = resume_record
                out.debug["dev_target_resume_inflight"] = dict(resume_record)
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
        # tickets_orch (issue #3423, epic #3419, ADR-0030 Decision 2/5 — one
        # autonomous Pocock skill lineage; the delta/contract slice). The
        # tickets-STAGE producer: turns a resolved plan/finding into one parent
        # epic + N tracer-bullet child issues by dispatching the vendored upstream
        # `to-tickets` skill + the thin Hydra AFK overlay (Option C compose,
        # alpha #3420; hydra-prd is demoted to the called PrdInput->issue renderer
        # library invoked BY that overlay). Structural sibling of wayfinder_orch
        # (the plan-stage producer, also signal, also 1h) — NOT a pipeline slot.
        # Fires on the precomputed `tickets_available` board signal (signal-seam
        # discipline: collect-state.sh owns the enumeration and emits the signal;
        # that emission is a follow-on, not this slice's Files-in-scope). 1h class
        # cooldown (SIGNAL_COOLDOWNS["tickets_orch"]) is the back-stop; board state
        # is the primary suppressor. NOT in BACKFILL_SIGNAL_CLASSES. Registered
        # last as a lowest-priority signal class — spare capacity only, never
        # preempting a pipeline dispatch.
        "tickets_orch",
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
        # Orch-realm weekly-share guard (issue #4161) — the signal-loop twin
        # of the pipeline guard above: same default-disabled arming, same
        # one-directional orch-only suppression (CLASS_SCOPE "orch"), same
        # budget-outcome skip event. Placed after the scope mask so the
        # emitted skip reason is the share guard, not a duplicate scope skip.
        if CLASS_SCOPE.get(sig) == "orch" and orch_realm_share_exceeded(state):
            cap = orch_realm_share_state(state)
            out.debug.setdefault("orch_realm_share_skipped", {
                "max_share": cap["max_share"],
                "share": cap["share"],
            })
            out.events.append(
                make_dispatch_decision_event(
                    state, now, cls=sig, outcome="budget",
                    reason="orch realm weekly share exceeded",
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
        # Target risk-surface fail-closed gate (issue #4411) — checked BEFORE
        # _select_for_signal, mirroring the scout cost-cap gate above, so an
        # unresolved risk surface is reported distinctly rather than folded
        # into a generic "no triggering signal" / cooldown outcome. Invariant
        # 3 of the design concept: `wire_or_retire_target` must NEVER dispatch
        # with an empty or fallback carve-out — when collect-state.sh could
        # not resolve `state.target_risk_surface` (absent, ok:false, or an
        # empty surface list), the dispatch is withheld even though the
        # `wire_or_retire_target_available` signal is present, and the reason
        # is recorded in `plan.debug.wire_or_retire_withheld` for operator
        # audit. Items stay needs-triage — over-routing to a human is safe,
        # under-routing is not.
        if sig == "wire_or_retire_target" and _signal_present(
            state, events, "wire_or_retire_target_available"
        ):
            risk_surface = _normalize_target_risk_surface(state.get("target_risk_surface"))
            if not risk_surface["ok"]:
                out.debug["wire_or_retire_withheld"] = (
                    "target risk surface unresolved: state.target_risk_surface "
                    "missing, ok:false, or empty"
                )
                out.events.append(
                    make_dispatch_decision_event(
                        state, now, cls=sig, outcome="budget",
                        reason="target risk surface unresolved",
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
    state: dict, *, dispatched_any: bool, plan_has_actions: bool, events: list[dict] | None = None
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

    Issue #4130 EXCEPTION: a wait-only turn decided against a DEGRADED orch
    board read (`orch_board_signals_degraded=true`) takes the heartbeat-wait
    shape instead of terminating — a board whose reads failed is blindness,
    not quiet, and must never be recorded as a clean idle drain. The wait's
    reason names the degraded read so the turn record carries it.

    Issue #4699 EXCEPTION: a wait-only turn decided under a usage hard-stop
    (`usage_eligibility.allow == false`) takes the same heartbeat-wait shape.
    The dispatch rules skip every class BEFORE its selector runs while the
    gate is closed, so the turn never looked for work — "nothing dispatched"
    is starvation, not a drained board. Terminating as `idle` would record the
    wrong cause AND make `endRun` stamp the workless-board backoff
    (`reasons.worklessUntil`) on top of the meter's own recovery window.

    Also records the `occupied_slots` debug hint.
    """
    out = _RuleOutput()
    slots = state.get("slots") or {}
    occupied = sum(1 for v in slots.values() if v is not None)
    wait_only_empty = not dispatched_any and occupied == 0 and not plan_has_actions
    # Issue #4130: a wait-only turn decided against a DEGRADED orch board
    # read must not terminate as `idle` — "no work was seen" is not "no work
    # exists" when the board read itself failed (the GraphQL-only 503 outage
    # rendered a 15-issue board as a clean idle drain). The degraded turn
    # takes the heartbeat-wait shape instead: the session still ends
    # physically (print mode exits on its final message, #1352) and the
    # pace-gate relaunch retries collect-state at the heartbeat cadence, but
    # the run is never RECORDED as a clean idle drain it did not earn, and
    # the wait's reason names the blindness in the turn record.
    if wait_only_empty and _orch_board_read_degraded(state, events):
        out.emit(
            make_wait(
                WALL_CLOCK_HEARTBEAT_SEC,
                "orch board read degraded — idle conclusion withheld (issue #4130)",
            ),
            reason="degraded-board-heartbeat",
        )
        out.debug["idle_fallback"] = "degraded-board-wait"
    elif wait_only_empty and _usage_dispatch_blocked(state):
        # Issue #4699: name the starvation in the turn record. A blind meter
        # (`reasons.meterUnavailable`, the #4165 fail-closed path) is called
        # out separately from a measured cap so a retro can tell them apart.
        reasons = _normalize_usage_eligibility(state.get("usage_eligibility"))["reasons"]
        blind = reasons.get("meterUnavailable") is True
        out.emit(
            make_wait(
                WALL_CLOCK_HEARTBEAT_SEC,
                "usage hard-stop — dispatch blocked, idle conclusion withheld (issue #4699)"
                + (" hold:usage-meter-unavailable" if blind else ""),
            ),
            reason="usage-blocked-heartbeat",
        )
        out.debug["idle_fallback"] = "usage-blocked-wait"
        out.debug["idle_withheld_usage_meter_unavailable"] = blind
    elif wait_only_empty:
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
    """Step 7 — stamp `worktreeBranch`, `isolation` + `dispatchSentinel` on dispatch actions.

    `isolation` (issue #4476) is `class_isolation(slot)` — "worktree" or
    "self" — read by the playbook's dispatch row to decide whether the Agent
    call carries harness `isolation="worktree"`.

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
        # Issue #4476 INV-3: the playbook passes isolation="worktree" iff this
        # is "worktree", omits it iff "self". Data only — no model/prompt text.
        action["isolation"] = class_isolation(slot)
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
    events: Iterable[dict] | dict | _EventsLoadError | None = None,
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

      0. Candidate Exclusion telemetry (issue #3964) — re-emits
         `state.candidate_exclusions` (pre-computed by collect-state.sh) as
         `candidate_exclusion` observability events. Contributes events only,
         never an action; runs unconditionally, even ahead of termination.

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
    emits a `wait` rather than a riskier action.
    """
    plan = Plan()
    if not isinstance(state, dict):
        raise TypeError("decide(): state must be a dict")
    # Issue #4213 — normalise the events argument ONCE, before ANY consumer
    # (the `_orch_board_read_degraded` stamp and step 1's `_signal_present`
    # both read it ahead of step 1.5). Every shape degrades to a plan, never
    # a traceback: `None`, a bare list, the collect-state wrapper
    # `{"events": [...], "last_id": ...}`, non-dict entries, or an
    # unreadable events.json (the `_EventsLoadError` marker from main()).
    # Raw stream rows (`{"id", "fields": {...}}`) that land on this lane are
    # re-homed onto state.slot_events so the ONE `subagent_stop` projection
    # in `_rule_slot_events` frees the slot — unwrap-only would silently
    # drop them (comment 2 on #4213). Degradation is visible ONLY as
    # plan.reasons markers + plan.debug; the #1769 turn bump in main() is
    # untouched, so a malformed file still consumes a Turn — one that now
    # carries a Plan.
    events_raw = events
    events, events_reasons = _normalise_events(events_raw)
    if isinstance(events_raw, _EventsLoadError):
        plan.debug["events_load_error"] = f"{events_raw.path}: {events_raw.error}"
    events, rehomed = _rehome_stream_entries(state, events)
    if rehomed:
        events_reasons.append(f"events-stream-entries-rehomed:{rehomed}")
    plan.reasons.extend(events_reasons)
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

    # Issue #4130 — a degraded orch board read must be visible in the turn
    # record rather than indistinguishable from a quiet board: this stamp
    # rides the plan JSON the turn persists, on EVERY turn decided against a
    # degraded snapshot (not just the ones whose dispatches were suppressed
    # by it). Pure: derived solely from the pre-resolved input signal.
    if _orch_board_read_degraded(state, events):
        plan.debug["orch_board_read_degraded"] = True

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

    # 1.05. PR-gate bucket stamp (issue #4240, INV-A) — every plan carries
    #      the four pre-merge-gate reachability facts as a debug field, even
    #      a terminating turn (the whole defect was that an unreadable gate
    #      presented as silence). Pure re-publication of collect-state's
    #      pre-classification; contributes no action, so it is safe BEFORE
    #      the termination short-circuit exactly like `turn_start` above.
    plan.debug["pr_gate"] = _pr_gate_buckets(state, events)

    # 1.1. Candidate Exclusion telemetry (issue #3964) — pure re-emission of
    #      collect-state.sh's pre-computed verdicts. Never contributes an
    #      action, so it is safe to fold unconditionally BEFORE the
    #      termination short-circuit below: the census is wanted even on a
    #      terminating turn, exactly like `turn_start` above.
    fold(_rule_candidate_exclusions(state, now))

    # 1. Termination — a turn-ending decision; short-circuit when tripped.
    term_out = _rule_termination(state, now, events)
    fold(term_out)
    if term_out.terminate is not None:
        return plan

    # 1.45. Stale slot-events filter (issue #4441) — drop any state.slot_events
    #      entry that predates this run (a fresh-bootstrap cursor-0 replay of
    #      hydra:autopilot:slot-events) BEFORE either consumer below reads the
    #      container, so _rule_slot_events (reap synthesis) and _rule_escalation
    #      (cascade re-dispatch) can never drift on what counts as stale. Fails
    #      open on any unresolvable time (INV-2); records one reason for the
    #      whole turn when it drops anything (INV-3).
    stale_dropped = _filter_stale_slot_events(state, now)
    if stale_dropped:
        plan.reasons.append(f"slot-events-stale-skipped:{stale_dropped}")

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
        state, events, now, dispatch_blocked=dispatch_blocked, shed_classes=shed_classes
    )
    fold(escalation_out)

    # 3. Auto-merge sweep — before dispatch so freed PRs don't compete with
    #    new work; emergency brake (issue #744) overrides the depth verdict.
    #    Holds qa-verdict PASSes for dirty/unchecked PRs (issue #4240, INV-B).
    fold(_rule_auto_merge_sweep(state, events))

    # 3.5. PR-gate surfacing / rebasing (issue #4240) — surface-pr for dirty
    #      and unchecked PRs (the operator is the only fixer for both),
    #      update-branch (≤2/turn oldest-first) for quiescent BEHIND ones.
    #      After the sweep so the two rules read one coherent gate snapshot.
    fold(_rule_pr_gate(state, events))

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
            events=events,
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
    handler = _SLOT_SELECTORS.get(cls)
    if handler is None:
        return None
    return handler(cls, state, candidates, events, best, best_score, now)


def _needs_qa_target_pr_head(state: dict, events: list[dict]) -> str | None:
    """Read the current turn's pre-resolved Target QA PR head ref (issue #4653).

    Same verbatim-string signal, and the SAME event-preferred-over-
    `state.signals` lookup order, as `_needs_qa_target_pr_ref` immediately
    above. collect-state.sh emits `target_needs_qa_pr_head` as the `head.ref`
    of the SAME PR whose `html_url` is `target_needs_qa_pr_ref`, projected
    from the already-fetched PR payload inside the #4576 resolver — no new
    network call (issue #4653). Returns `None` when the signal is ABSENT or
    EMPTY.

    Pure: no side effects.
    """
    raw = None
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == "target_needs_qa_pr_head":
            raw = ev.get("value")
            break
    if raw is None:
        raw = (state.get("signals") or {}).get("target_needs_qa_pr_head")
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


# Bare `<run8>-t<N>-dev_target` dispatch token, with an optional
# `worktree-agent-` prefix stripped (issue #4653). `run8` is the 8-hex-char
# run id `bootstrap.sh` mints; `N` is the pipeline slot's 1-based turn index.
_QA_TARGET_BUILDER_TOKEN_RE = re.compile(r"^(?:worktree-agent-)?([0-9a-f]{8}-t[0-9]+-dev_target)$")


def _qa_target_builder_token(slot: dict) -> str | None:
    """Resolve the live `dev_target` slot's dispatch token (issue #4653).

    Ordered chain `worktreeBranch` -> `dispatch_id` -> `task_id` — the slot's
    documented field set (this module's own STATE SCHEMA header + reap.py's
    `_snapshot_completion_slot` docstring: "the dispatch harness never stamps
    [an anchor]"; live state.json confirms the fields are
    task_id/skill/started/started_epoch/dispatch_id/worktreeBranch/attempt
    only). A slot re-seeded by `deriveInflightSlotSeed` on a successor run
    carries only `task_id` (== the harness dispatchId), so the chain must
    reach `task_id` to still resolve a token there.

    Returns the bare `<run8>-t<N>-dev_target` token — stripping an optional
    `worktree-agent-` prefix — ONLY when a field's value matches
    `_QA_TARGET_BUILDER_TOKEN_RE` exactly. A `claude-cycle-<date>` branch, a
    bare hex hash with no `-tN-dev_target` suffix, a `sessionId`-seeded slot,
    or any other non-token-shaped value returns `None` (fail-open: the caller
    dispatches exactly as it does today, the #3709 dead-arm class).
    """
    for field_name in ("worktreeBranch", "dispatch_id", "task_id"):
        value = slot.get(field_name)
        if not isinstance(value, str) or not value:
            continue
        m = _QA_TARGET_BUILDER_TOKEN_RE.match(value)
        if m:
            return m.group(1)
    return None


def _dev_target_resume_record(action: dict, state: dict) -> dict | None:
    """Build the `state.dev_target_resume_inflight` record (issue #4795, INV-2).

    Called in `_rule_pipeline_dispatch` immediately after `out.emit(action)`
    for `cls == "dev_target"` — the same post-gate position as the #4611
    `stamp_signal` call, so one stamp corresponds 1:1 to one emitted dispatch.
    Returns `{token, branch, pr}` iff the action is a #4739 resume pin
    (`prompt_args.resume` True + non-empty string `resume_branch` + int
    `resume_pr`); anything else returns None and nothing is stamped.

    `token` is the bare token of the SAME worktreeBranch the action carries —
    `action.worktreeBranch` if pre-set, else `_synthesize_worktree_branch`
    with the same state/turn `_stamp_dispatch_metadata` uses moments later —
    resolved through `_QA_TARGET_BUILDER_TOKEN_RE`. A state with no 8-hex
    `run_id` synthesises a non-token branch (`worktree-agent-local-…`), so no
    record is stamped — fail-open, never a crash (the #3709 dead-arm class).

    Pure: reads the passed-in dicts only, no I/O (ADR-0007).
    """
    prompt_args = action.get("prompt_args")
    if not isinstance(prompt_args, dict) or prompt_args.get("resume") is not True:
        return None
    branch = prompt_args.get("resume_branch")
    if not isinstance(branch, str) or not branch:
        return None
    pr = prompt_args.get("resume_pr")
    if isinstance(pr, bool) or not isinstance(pr, int):
        return None
    worktree_branch = action.get("worktreeBranch")
    if not (isinstance(worktree_branch, str) and worktree_branch):
        worktree_branch = _synthesize_worktree_branch(state, "dev_target")
    m = _QA_TARGET_BUILDER_TOKEN_RE.match(worktree_branch)
    if not m:
        return None
    return {"token": m.group(1), "branch": branch, "pr": pr}


def _qa_target_builder_hold(state: dict, events: list[dict]) -> tuple[str | None, str | None]:
    """Resolve the qa_target builder-in-flight hold (#4653 + the #4795 resume arm).

    Returns `(pr_ref, resume_branch)`:
      - `pr_ref` — the held `target_needs_qa_pr_ref` URL, or None when the
        hold does not fire;
      - `resume_branch` — the matched record's branch when the #4795 arm was
        the match, else None (the #4653 arm holds, or no hold at all).

    BOTH arms require a live `state.slots.dev_target` dict whose dispatch
    token T resolves via `_qa_target_builder_token` (worktreeBranch ->
    dispatch_id -> task_id) and a non-empty event-preferred
    `target_needs_qa_pr_head`; the head must then equal EITHER:

      - `feature/<T>` — the unchanged #4653 arm: the exact branch
        `hydra-target-build` Step 0.6 creates from the dispatch harness's own
        CYCLE_ID, so a fresh-worktree builder's own PR is recognised by
        branch-token identity; OR
      - the `branch` of `state.dev_target_resume_inflight` — the #4795 arm: a
        #4739 RESUME dispatch pushes to the PRIOR run's branch (recorded at
        plan time by `_dev_target_resume_record` on the dispatch turn), so
        its PR's head can never equal `feature/<T>`; the record's `token`
        must equal T, binding the join to the live dispatch by identity.

    A truthy hold proves BY CONSTRUCTION — not by inference — that the
    needs-qa PR was opened (or resumed) by the CURRENTLY-RUNNING dev_target
    dispatch: `target_needs_qa_pr_ref` already proves the PR CLOSES issue N
    (`pr-refs.py`'s `closing_issues()`, #4576); the head match proves the PR
    is that live dispatch's own branch, fresh or resumed. Hence N IS that
    builder's anchor — the operator's chosen join (2026-09-23 hitl-grill),
    achieved without the slot ever carrying an anchor field.

    Fail-open everywhere (the #3709 dead-arm class): a null/malformed slot, a
    slot with no token-shaped field, an empty head, a missing/non-dict
    record, a record whose token is missing/non-string or differs from the
    live slot's, or a record whose branch is missing/non-string/empty or
    differs from the head each return `(None, None)` — qa_target dispatches
    exactly as it does today. Nothing in the record arm raises.
    Pure: no file IO, no `gh`, no Redis (issue #3711 keeps decide.py a pure
    function of (state, events, now)).
    """
    slots = state.get("slots") if isinstance(state, dict) else None
    slot = slots.get("dev_target") if isinstance(slots, dict) else None
    if not isinstance(slot, dict):
        return None, None
    token = _qa_target_builder_token(slot)
    if not token:
        return None, None
    head = _needs_qa_target_pr_head(state, events)
    if not head:
        return None, None
    if head == f"feature/{token}":
        return _needs_qa_target_pr_ref(state, events), None
    record = state.get("dev_target_resume_inflight")
    if not isinstance(record, dict):
        return None, None
    if record.get("token") != token:
        return None, None
    branch = record.get("branch")
    if not isinstance(branch, str) or not branch or head != branch:
        return None, None
    return _needs_qa_target_pr_ref(state, events), branch


# Per-class pipeline-slot selector registry (issue #4265). A LOOKUP only — dispatch
# ORDER stays the hardcoded tuple in the rule loop, never this dict. An
# unregistered class idles (None). Completeness vs the taxonomy is a test
# invariant (test/taxonomy-classes.test.mts), not an import-time assertion.
_SLOT_SELECTORS: dict[str, Callable[..., dict | None]] = {
    "qa_orch": _select_slot_qa_orch,
    "qa_target": _select_slot_qa_target,
    "dev_orch": _select_slot_dev_orch,
    "dev_target": _select_slot_dev_target,
    "research_orch": _select_slot_research_orch,
    "research_target": _select_slot_research_target,
    "design_concept_orch": _select_slot_design_concept_orch,
}


def _select_for_signal(sig: str, state: dict, events: list[dict], now: int) -> dict | None:
    # The shared class-cooldown guard stays HERE, before the registry lookup
    # (#3729/#3939: cooldown is a necessary independent condition). Per-class
    # handlers in `_SIGNAL_SELECTORS` never re-check or bypass it (#4265).
    if not signal_is_cooled(state, sig, now):
        return None
    handler = _SIGNAL_SELECTORS.get(sig)
    if handler is None:
        return None
    return handler(sig, state, events, now)


# Per-class signal-class selector registry (issue #4265). A LOOKUP only — dispatch
# ORDER stays the hardcoded tuple in the rule loop, never this dict. An
# unregistered class idles (None). Completeness vs the taxonomy is a test
# invariant (test/taxonomy-classes.test.mts), not an import-time assertion.
_SIGNAL_SELECTORS: dict[str, Callable[..., dict | None]] = {
    "health": _select_signal_health,
    "sweep_orch": _select_signal_sweep_orch,
    "sweep_target": _select_signal_sweep_target,
    "discover_orch": _select_signal_discover_orch,
    "discover_target": _select_signal_discover_target,
    "scout_orch": _select_signal_scout_orch,
    "architecture_orch": _select_signal_architecture_orch,
    "retro_orch": _select_signal_retro_orch,
    "cleanup_orch": _select_signal_cleanup_orch,
    "cleanup_target": _select_signal_cleanup_target,
    "wire_or_retire_target": _select_signal_wire_or_retire_target,
    "design_qa_target": _select_signal_design_qa_target,
    "skill_prune": _select_signal_skill_prune,
    "wayfinder_orch": _select_signal_wayfinder_orch,
    "tickets_orch": _select_signal_tickets_orch,
}


def _usage_dispatch_blocked(state: dict) -> bool:
    """True when the Subscription Usage Tracker hard-stop is closed (issue #4699).

    The same verdict `_rule_usage_eligibility` threads into the dispatch rules
    as `dispatch_blocked`. While it holds, every class is skipped before its
    selector runs, so a wait-only turn has not observed an empty board and must
    not be recorded as a clean idle drain. Missing / malformed payloads
    normalize to `allow=True` (fail-open), so this is False on a snapshot
    without the field.
    """
    return not _normalize_usage_eligibility(state.get("usage_eligibility"))["allow"]


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


# ---------------------------------------------------------------------------
# Orch-realm weekly-share guard (issue #4161)
# ---------------------------------------------------------------------------
#
# Every USD-denominated cost gate above is structurally inert on this
# deployment: `HYDRA_TOKEN_USD_RATE` was never set post-ADR-0006
# (src/scheduler/heartbeat.ts documents the env var at its own line ~648) and
# #704 stripped the dollar-conversion machinery outright
# (src/api/metrics-cost.ts: "structurally $0; no live dollar cap"), so
# `scout_spend_usd_today` / `dev_target_spend_usd_cycle` are permanently 0.0
# and no cap value can ever make those gates fire. They are kept (their tests
# pin the kill-switch semantics) but documented INERT — do NOT re-derive a
# budget split from them.
#
# The one live budget-split signal is the orch-vs-target REALM share of the
# rolling weekly window. Signal-seam split (issue #4161 AC1/AC2, restored by
# the operator seam correction):
#
#   - ENUMERATION lives in collect-state.sh. It folds `/api/usage`
#     `bySkillByModel` (the only trustworthy per-skill surface — NOT
#     `costByClass`, which covers only ~13% of measured spend) over the
#     taxonomy `scope` column in scripts/autopilot/classes.json and emits ONE
#     pre-qualified line: `orch_realm_weekly_share=<0..1 | unavailable>`.
#     Best-effort on the sibling contract: the collect step never fails, and
#     an unreadable meter degrades to a value that leaves this guard
#     disabled — an unreadable meter must never suppress dispatch (the same
#     fail-open direction ADR-0032 chose for the drainer heartbeat, and the
#     opposite of the #4128 fabricated-certainty failure).
#   - POLICY lives here. This predicate reads that one signal verbatim from
#     `state.signals.orch_realm_weekly_share` and stays a pure function of
#     (state, events, now): no network, no FS, no Redis.
#
# The share is operator-configurable via `state.limits.orch_realm_weekly_share_cap`
# and DEFAULTS TO DISABLED (absent / 0 / unparseable / >1 = never fires),
# matching the ADR-0021 D5 rule: per-run limits stay subordinate to the Pace
# Gate and never become a second governor switched on behind the operator's
# back. The guard suppresses ORCH-scope dispatch only (see CLASS_SCOPE) —
# one-directional by design, so a Target-heavy week is never throttled by it.
ORCH_REALM_SHARE_CAP_DISABLED = 0.0


def _realm_share_finite(value) -> float | None:
    """Coerce a realm share to a usable float in [0, 1], or None.

    Accepts a number OR a numeric string — the playbook merges collect-state
    lines as strings (the same shape as `wayfinder_orch_inflight_global`).
    Rejects bools, non-numerics, NaN/±inf, and anything outside [0, 1]
    (a share is a fraction of the realm-attributed window, never >100%).
    `None` means "no usable reading this turn" and every caller treats that
    as fail-open (guard disabled) — the AC1 direction.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
    elif isinstance(value, str):
        try:
            f = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(f) or f < 0 or f > 1:
        return None
    return f


def orch_realm_share_state(state: dict) -> dict:
    """Resolve the orch-realm weekly-share guard inputs from state (issue #4161).

    Reads (with the same fail-open fallbacks as the sibling cost-cap gates):
      - state.limits.orch_realm_weekly_share_cap   (default 0 = DISABLED)
      - state.signals.orch_realm_weekly_share (folded by collect-state.sh)

    Returns `{max_share, share, enforced}`. `enforced` is False when the
    ceiling is not armed — absent / 0 / unparseable / negative / NaN / >1 all
    resolve to disabled, the fail-safe direction because the alternative (a
    tiny accidental ceiling) would suppress every orch dispatch instantly —
    and when the signal is not a usable reading this turn (absent key,
    "unavailable", out-of-range), which is the AC1 "unreadable meter never
    suppresses dispatch" rule.

    Pure: no side effects.
    """
    limits = state.get("limits") or {}

    try:
        max_share = float(
            limits.get("orch_realm_weekly_share_cap", ORCH_REALM_SHARE_CAP_DISABLED)
        )
    except (TypeError, ValueError):
        max_share = ORCH_REALM_SHARE_CAP_DISABLED
    if not math.isfinite(max_share) or max_share <= 0 or max_share > 1:
        max_share = ORCH_REALM_SHARE_CAP_DISABLED

    share = _realm_share_finite((state.get("signals") or {}).get("orch_realm_weekly_share"))

    return {
        "max_share": max_share,
        "share": share,
        "enforced": max_share > 0 and share is not None,
    }


def orch_realm_share_exceeded(state: dict) -> bool:
    """True when the orch-realm weekly-share guard should suppress ORCH-scope dispatch.

    Pure wrapper over `orch_realm_share_state` — separated so callers can
    log either the bool decision or the full breakdown. `>=` semantics,
    mirroring `scout_cost_cap_exceeded`.
    """
    s = orch_realm_share_state(state)
    if not s["enforced"]:
        return False
    return s["share"] >= s["max_share"]


def _check_termination(state: dict, now: int, events: list[dict] | None = None) -> dict | None:
    """Mirror of term-check.py logic, expressed as an action.

    NOT pure, by one narrow exception (issue #3867): `_capture_quota_baseline`
    mutates `state["quota_baseline"]` on the first calibrated turn of a
    quota-capped run, and rebases it on a mid-run window reset. That is the same
    sanctioned in-`decide()` mutation shape as `_research_force_stamp`'s counter
    bump — main() detects the change and persists it via the existing
    `_persist_state_writeback`. When the quota cap is disabled (the default) the
    call touches nothing, so `decide()` stays byte-for-byte pure on a default run.
    """
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

    # Quota-percent budget (issue #3867) — capture/rebase the baseline, then check
    # the delta. Checked FIRST because it is the cap denominated in the currency
    # the operator actually pays: when both it and the token budget trip on the
    # same turn, `quota` is the more diagnostic cause to report (the token figure
    # under-measures real spend by ~2 orders of magnitude). Disabled by default,
    # so on a default run this branch is inert and `budget` still wins exactly as
    # before.
    _capture_quota_baseline(state, now)
    quota_hit = _quota_delta_exceeded(state)
    if quota_hit is not None:
        _window, quota_detail = quota_hit
        return make_terminate("quota", merged_prs=merged_prs, reason=quota_detail)

    if cumulative >= budget:
        return make_terminate("budget", merged_prs=merged_prs, reason=f"tokens={cumulative}/{budget}")
    if elapsed >= wall_max:
        return make_terminate("wall_clock", merged_prs=merged_prs, reason=f"elapsed={elapsed}s")
    # Issue #4130: idle turns accumulated against a DEGRADED orch board read
    # are blindness, not quiet — a board whose reads all failed renders as
    # zero/none and would drain the run to a clean `terminate:idle` while
    # eligible work sits unseen (run 161d9642, 2026-08-17). The idle cause is
    # withheld while the snapshot is flagged degraded; budget / wall_clock /
    # quota are unaffected (they are measured independently of the board
    # read, so a genuinely exhausted run still ends under its own cause).
    # Issue #4699: idle turns accumulated under a usage hard-stop are
    # starvation, not quiet — withheld the same way.
    if (
        idle >= idle_max
        and occupied == 0
        and not _orch_board_read_degraded(state, events)
        and not _usage_dispatch_blocked(state)
    ):
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

    # Periodic session-restart (issue #3787) — checked LAST among the
    # terminate causes so a genuinely urgent condition above (budget /
    # wall_clock / idle / failure_backstop) is always reported under its own,
    # more diagnostic cause first; this is a soft, proactive cadence, not a
    # backstop. See CONTEXT_COMPACTION_TURNS_DEFAULT for the full rationale
    # (including the raw-API-call vs Autopilot-Turn unit correction). `turn`
    # is the CLI's #1769 single-writer counter (bumped before decide() runs),
    # so `turn=N` means this is exactly the Nth decide invocation of the
    # current run. Deliberately NOT gated on `occupied == 0` — see the
    # constant's docstring.
    try:
        compaction_turns = int(
            limits.get(
                "context_compaction_turns",
                CONTEXT_COMPACTION_TURNS_DEFAULT,
            )
        )
    except (TypeError, ValueError):
        compaction_turns = CONTEXT_COMPACTION_TURNS_DEFAULT
    turn = int(state.get("turn", 0) or 0)
    if compaction_turns > 0 and turn > 0 and turn % compaction_turns == 0:
        return make_terminate(
            "context_compaction",
            merged_prs=merged_prs,
            reason=f"turn={turn} (cadence={compaction_turns})",
        )

    return None


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

    Issue #4551: this POST is deliberately kept EARLY — it is the durable
    CAUSE of record (status / term_reason / exit_code), and only the TALLY
    (cumulative_tokens / ended_epoch) is late, because the playbook's Phase 7
    keeps reaping in-flight slots after this fires. The tally amendment is
    posted by the two deterministic session-tail writers instead: drain.sh's
    Phase 7 tail and `run_termination.py post-run-end`'s follow-up (both via
    POST /api/autopilot/run-tally, amend-only and monotone). Nothing changes
    here — this note records the division of labour so the early POST is not
    "fixed" into a later, cause-losing write.
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
        # Issue #4213 (INV-7) — the OPTIONAL events positional is the ONLY
        # input whose parse failure is caught: a garbled events file is
        # degradable (decide() proceeds with [] and a plan.reasons marker),
        # a garbled state/candidates file is not and keeps failing hard.
        # Fail-loud: one stderr line with the path + error, then hand
        # decide() the marker so the degradation lands in the plan too.
        events: object = None
        if len(argv) > 4:
            try:
                events = _load_json(argv[4])
            except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
                print(
                    f"decide.py: events file {argv[4]} unreadable ({exc}) — continuing with []",
                    file=sys.stderr,
                )
                events = _EventsLoadError(argv[4], str(exc))
        # Issue #1666: snapshot the force-research counter so we can detect a
        # plan-time stamp and persist it. Serialised compare (not identity) —
        # _research_force_stamp replaces the nested dict in place.
        force_counter_before = json.dumps(
            state.get("research_force_counter"), sort_keys=True,
        )
        # Issues #3729/#3939: change-detection for the per-item sweep stamp maps.
        # `_stamp_triage_items` rebuilds the stamp map in place (pruning absent
        # items) when a sweep fires with a present item set — for sweep_target
        # (`target_triage_item_stamps`, #3729) and sweep_orch
        # (`orch_triage_item_stamps`, #3939). snapshot-before/compare-after on BOTH
        # maps persists either via the SAME _persist_state_writeback helper, no new
        # persistence mechanism (INV-12).
        triage_stamps_before = json.dumps(
            {
                "target": state.get("target_triage_item_stamps"),
                "orch": state.get("orch_triage_item_stamps"),
            },
            sort_keys=True,
        )
        # Issue #3866: same change-detection for state.dev_resume_pending.
        # reap.py appends to this queue on a no-PR dev_orch stall; the
        # dev_orch selector in `_select_for_slot` pops its head in place when
        # it pins a resume dispatch. Snapshot-before/compare-after persists
        # the pop via the SAME `_persist_state_writeback` helper — no new
        # persistence mechanism, mirrors `triage_stamps_before` immediately
        # above.
        dev_resume_pending_before = json.dumps(
            state.get("dev_resume_pending"), sort_keys=True,
        )
        # Issue #3829: same change-detection for the qa_orch per-issue stall
        # tracker. `_bump_qa_orch_stall_tracker` rebuilds `qa_orch_item_
        # attempts` to hold only the current needs-qa head's bumped count
        # when qa_orch fires against a present needs-qa list; snapshot-before/
        # compare-after persists it via the SAME _persist_state_writeback
        # helper, no new persistence mechanism (design-concept invariant 6).
        qa_attempts_before = json.dumps(
            state.get("qa_orch_item_attempts"), sort_keys=True,
        )
        # Issue #3867: same change-detection for the quota-percent baseline.
        # `_capture_quota_baseline` (called from `_check_termination`) writes it
        # once on the first calibrated turn of a quota-capped run, and rebases it
        # on a mid-run 5h/weekly window reset. Snapshot-before/compare-after
        # persists it via the SAME `_persist_state_writeback` helper — no new
        # persistence mechanism, mirroring the four blocks above. On a run with
        # the cap disabled (the default) the key never appears, so this compare
        # never fires a write.
        quota_baseline_before = json.dumps(
            state.get("quota_baseline"), sort_keys=True,
        )
        # Issue #4460: same change-detection for the glm-red forward-fix
        # attempts tracker. The dev_orch selector bumps
        # `state.glm_red_forward_fix_attempts[<pr>]` in place when it pins a
        # forward-fix dispatch. Snapshot-before/compare-after persists it via
        # the SAME `_persist_state_writeback` helper — no new persistence
        # mechanism, mirroring the blocks above. In-run state by design
        # (INV-8): a new run starts from an empty tracker, exactly like
        # `burned_classes` / slot history.
        glm_red_attempts_before = json.dumps(
            state.get("glm_red_forward_fix_attempts"), sort_keys=True,
        )
        # Issue #4611: same change-detection for `signal_last_fired`.
        # `_rule_pipeline_dispatch` stamps `signal_last_fired.research_target`
        # at plan time when it emits that dispatch (nothing else in decide()
        # mutates the map), so this writes exactly on a research_target
        # dispatch turn — via the SAME `_persist_state_writeback` helper.
        signal_last_fired_before = json.dumps(
            state.get("signal_last_fired"), sort_keys=True,
        )
        # Issue #4795: same change-detection for the dev_target resume record.
        # `_rule_pipeline_dispatch` stamps `state.dev_target_resume_inflight`
        # at plan time when it emits a #4739 resume-pin dev_target dispatch,
        # so this writes exactly on a resume-dispatch turn — via the SAME
        # `_persist_state_writeback` helper, no new persistence mechanism
        # (invariant 3 of the issue-4795 design concept). In-run state by
        # design, like `glm_red_forward_fix_attempts`: a new run starts
        # without it and the hold fails open (the same degradation #4653
        # accepts for a non-resolvable slot).
        dev_target_resume_before = json.dumps(
            state.get("dev_target_resume_inflight"), sort_keys=True,
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
        triage_stamps_after = json.dumps(
            {
                "target": state.get("target_triage_item_stamps"),
                "orch": state.get("orch_triage_item_stamps"),
            },
            sort_keys=True,
        )
        if triage_stamps_after != triage_stamps_before:
            _persist_state_writeback(
                argv[2], state, what="triage_item_stamps stamp (#3729/#3939)",
            )
        dev_resume_pending_after = json.dumps(
            state.get("dev_resume_pending"), sort_keys=True,
        )
        if dev_resume_pending_after != dev_resume_pending_before:
            _persist_state_writeback(
                argv[2], state, what="dev_resume_pending drain (#3866)",
            )
        qa_attempts_after = json.dumps(
            state.get("qa_orch_item_attempts"), sort_keys=True,
        )
        if qa_attempts_after != qa_attempts_before:
            _persist_state_writeback(
                argv[2], state, what="qa_orch_item_attempts stamp (#3829)",
            )
        quota_baseline_after = json.dumps(
            state.get("quota_baseline"), sort_keys=True,
        )
        if quota_baseline_after != quota_baseline_before:
            _persist_state_writeback(
                argv[2], state, what="quota_baseline capture/rebase (#3867)",
            )
        glm_red_attempts_after = json.dumps(
            state.get("glm_red_forward_fix_attempts"), sort_keys=True,
        )
        if glm_red_attempts_after != glm_red_attempts_before:
            _persist_state_writeback(
                argv[2], state, what="glm_red_forward_fix_attempts bump (#4460)",
            )
        signal_last_fired_after = json.dumps(
            state.get("signal_last_fired"), sort_keys=True,
        )
        if signal_last_fired_after != signal_last_fired_before:
            _persist_state_writeback(
                argv[2], state, what="research_target re-fire stamp (#4611)",
            )
        dev_target_resume_after = json.dumps(
            state.get("dev_target_resume_inflight"), sort_keys=True,
        )
        if dev_target_resume_after != dev_target_resume_before:
            _persist_state_writeback(
                argv[2], state, what="dev_target_resume_inflight stamp (#4795)",
            )
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
