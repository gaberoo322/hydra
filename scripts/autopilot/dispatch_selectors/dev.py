"""`dispatch_selectors.dev` — pipeline-slot selectors for dev_orch / dev_target.

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
    ESCALATION_POLICY,
    GLM_RED_FORWARD_FIX_CAP,
    _glm_red_attempt_count,
    _glm_red_forward_fix_signal,
    _orch_anchor_signal,
    _orch_dev_ready_design_concept_status,
    _signal_present,
    design_concept_permits_frontier,
    make_dispatch,
    research_recommended,
)


def _select_slot_dev_orch(
    cls: str,
    state: dict,
    candidates: dict | None,
    events: list[dict],
    best: dict | None,
    best_score: float,
    now: int,
) -> dict | None:
    """`dev_orch` pipeline-slot selector (provenance: #3866, #458, #3711, #751, #628, #1230, #1088, #3798, #3795, #1093)."""
    # ISSUE #3866: drain state.dev_resume_pending BEFORE the fresh-pick
    # gate below. reap.py appends a resume record here when a PRIOR
    # dev_orch completion opened no PR (a stall, not a finished cycle) —
    # it also relabels that anchor's issue away from `ready-for-agent`
    # (to `needs-dev-resume`), so `orch_work_available` may well be False
    # even though there is real, already-started work waiting to resume.
    # Checking this queue first — independent of `orch_work_available` —
    # is what stops the stalled anchor from being starved by an otherwise
    # empty board. `prompt_args.anchor` reuses the SAME pinned-anchor
    # contract `orch_dev_ready_anchor` already established below (the
    # dispatch preamble names the anchor verbatim); `resume`/
    # `resume_branch` are additive hints so the dispatch prompt can tell
    # the fresh subagent to check for and continue the stalled branch
    # instead of reimplementing from zero. Pop (not peek) so this exact
    # anchor is only pinned once per queued stall — decide() mutates
    # `state` in place here, the same sanctioned pattern `main()` already
    # persists via change-detection for `research_force_counter` /
    # `target_triage_item_stamps`.
    resume_pending = state.get("dev_resume_pending") if isinstance(state, dict) else None
    if isinstance(resume_pending, list) and resume_pending:
        entry = resume_pending[0]
        if isinstance(entry, dict) and entry.get("anchor"):
            resume_pending.pop(0)
            prompt_args: dict = {"anchor": entry["anchor"], "resume": True}
            if entry.get("branch"):
                prompt_args["resume_branch"] = entry["branch"]
            return make_dispatch(
                cls,
                "hydra-dev",
                prompt_args=prompt_args,
                reason=(
                    f"resuming stalled dev_orch anchor {entry['anchor']} "
                    f"— prior completion opened no PR (issue #3866)"
                ),
            )
        # Malformed entry (no anchor) — drop it rather than looping on it
        # forever; still counts as a state mutation main() will persist.
        resume_pending.pop(0)

    # ISSUE #4460: pinned forward-fix for a stranded GLM-authored PR that
    # is red on one required check. The strand: the drainer skips it
    # (`issue_has_open_pr`, ADR-0032's dumb-drainer decisions are intact —
    # INV-1), QA's #3815 admission gate short-circuits `skip-required-
    # failed` without a FAIL, and the Claude lane below keys off
    # `orch_work_available` — which the #3754 GLM partition keeps FALSE
    # while the stranded anchor is glm-eligible. Every actor sees "someone
    # is on it"; nobody is. collect-state.sh's `orch_glm_red_forward_fix`
    # (INV-2/3) pre-resolves the LOWEST-numbered qualifying PR, so this
    # selector only parses a triple — no gh, no per-PR I/O (ADR-0007).
    #
    # SEQUENCING (INV-6): AFTER the #3866 dev_resume_pending drain above
    # (a resume of a stalled-NO-PR completion outranks a forward-fix — it
    # is the same anchor's earlier lifecycle state), BEFORE the
    # `orch_work_available` gate below. Placement IS the bypass: this one
    # pin deliberately ignores `orch_work_available` (the GLM partition
    # would otherwise veto the exact PR the signal names), the
    # `orch_pending_grill_anchor` yield (the artifact already exists —
    # the PR is open), and the pool-sizing that starves a one-PR board.
    # Honouring the partition here would re-create the zero-owner strand
    # this issue exists to close.
    #
    # CAP (INV-8): `state.glm_red_forward_fix_attempts[<pr>]` counts
    # pinned dispatches per PR, in-run state only. At
    # GLM_RED_FORWARD_FIX_CAP the pin declines (returns None below) and
    # `_rule_pr_gate` surfaces the PR the SAME turn — the tracker bump
    # below happens ONLY on an actual dispatch, so the surface-pr rule
    # (which runs earlier in decide() but reads the pre-bump value) and
    # this gate agree on the boundary: attempts==CAP-1 dispatches and
    # bumps to CAP; attempts==CAP declines and surfaces.
    glm_fix = _glm_red_forward_fix_signal(state, events)
    if glm_fix is not None:
        glm_issue, glm_pr, glm_branch = glm_fix
        glm_attempts = _glm_red_attempt_count(state, glm_pr)
        if glm_attempts >= GLM_RED_FORWARD_FIX_CAP:
            # Cap exhausted — NO dispatch. Deliberately fall through to
            # the normal selector path below (a healthy board may still
            # pin fresh work); _rule_pr_gate's surface-pr owns the
            # operator handoff for THIS PR.
            pass
        else:
            tracker = state.get("glm_red_forward_fix_attempts")
            if not isinstance(tracker, dict):
                tracker = {}
                state["glm_red_forward_fix_attempts"] = tracker
            tracker[str(glm_pr)] = glm_attempts + 1
            return make_dispatch(
                cls,
                "hydra-dev",
                prompt_args={
                    "anchor": f"issue-{glm_issue}",
                    "resume": True,
                    "resume_branch": glm_branch,
                    "forward_fix_pr": glm_pr,
                },
                reason=(
                    f"glm red PR forward-fix: PR {glm_pr} "
                    f"(issue #{glm_issue}) red on a required check, "
                    f"attempt {glm_attempts + 1}/{GLM_RED_FORWARD_FIX_CAP} "
                    "(issue #4460)"
                ),
            )

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
    # (Post-#3711 there is ONE exception, below: when a grill is pending on
    # a different anchor we pin dev_orch to the pre-resolved grill-clear
    # `orch_dev_ready_anchor`. That anchor comes from the orch GH board via
    # collect-state.sh — NOT from /api/anchor/candidates — so the #458
    # contract holds.)
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
    #
    # ISSUE #3711 — THE YIELD IS NOW PER-ANCHOR, NOT GLOBAL. The pre-#3711
    # gate yielded whenever `orch_pending_grill_anchor` was set to ANYTHING,
    # so one un-grilled issue anywhere on the board blocked dev_orch from
    # building EVERY issue — including ones whose artifacts were already
    # approved. Grills are serial (one pipeline slot, ~3-10 min each) while
    # the board grows from several independent producers, so a growing board
    # starved orchestrator development for a whole run (run a1c24124: 15
    # `ready-for-agent` issues gated behind one un-grilled anchor, zero dev
    # PRs).
    #
    # `collect-state.sh` now pre-resolves a SECOND signal in the same loop
    # pass: `orch_dev_ready_anchor`, the first board anchor that is already
    # GRILL-CLEAR (fresh artifact, or the mechanical #1230 / trivial #1088
    # exemption). This selector stays a PURE function of
    # (state, events, now) — it reads two pre-qualified strings and does no
    # I/O, exactly like `wayfinder_orch_frontier` /
    # `wire_or_retire_target_available`. decide.py cannot compute artifact
    # freshness itself (that needs the design-concepts API), which is why the
    # pre-resolution lives in collect-state.sh.
    #
    # When a grill is pending AND a DIFFERENT grill-clear anchor exists, we
    # PIN dev_orch to it via `prompt_args.anchor` rather than yielding.
    # Pinning is load-bearing, not a nicety: hydra-dev otherwise self-selects
    # via its own unguarded `gh issue list --label ready-for-agent | .[0]`,
    # which could land on the very anchor being grilled. Pinning closes that
    # gap — a per-anchor gate that only relaxed the boolean would open it.
    #
    # THE GATE IS NOT WEAKENED. `orch_dev_ready_anchor` is only ever set to
    # an already-grill-clear anchor, and we still yield when (a) there is no
    # grill-clear anchor, or (b) the only grill-clear anchor IS the one
    # pending grill. An un-grilled anchor still gets its design concept; it
    # just no longer blocks unrelated work.
    signals = state.get("signals") if isinstance(state, dict) else None
    orch_anchor = _orch_anchor_signal(signals, "orch_pending_grill_anchor")
    dev_ready_anchor = _orch_anchor_signal(signals, "orch_dev_ready_anchor")
    if orch_anchor is not None:
        if dev_ready_anchor is None or dev_ready_anchor == orch_anchor:
            # Nothing grill-clear to build this turn — yield exactly as the
            # pre-#3711 gate did. This is the correct fallback, and it is
            # also the degraded-signal path: collect-state.sh emits `none`
            # when the board read fails, so a gh outage fails CLOSED onto
            # today's behaviour rather than dispatching onto an un-grilled
            # anchor.
            return None
        # ISSUE #3798 (#3795 follow-up): a pinned dev_orch anchor whose
        # grill-clearness came from a genuine, APPROVED design-concept
        # artifact — not the mechanical (#1230) or trivial (#1088)
        # exemption — is architecturally consequential enough to route to
        # the frontier tier for THIS dispatch. Emit ONLY a `route_model`
        # HINT (never a concrete `model` field — #1093 purity); the
        # playbook resolves it to the Agent model kwarg, sourced live from
        # ESCALATION_POLICY so the two channels never drift apart. This is
        # a DISTINCT prompt_args key from `escalate_model` — that one is a
        # retry-after-failure hint stamped with attempt/prior_attempt_status
        # that cascade-routing telemetry (reap.py, /metrics/cascade-routing)
        # keys on; `route_model` fires on a first-attempt, dispatch-time
        # decision with neither field, so reusing `escalate_model` would
        # corrupt that telemetry with a phantom escalation record. The
        # `subagent_failure` escalation path above (`decide_escalation`,
        # `ESCALATION_POLICY["dev_orch"]`) is untouched and still applies
        # on top of whichever model this hint (or its absence) resolves.
        prompt_args: dict = {"anchor": dev_ready_anchor}
        design_concept_status = _orch_dev_ready_design_concept_status(signals)
        if design_concept_permits_frontier(design_concept_status):
            prompt_args["route_model"] = ESCALATION_POLICY["dev_orch"]["model"]
        return make_dispatch(
            cls,
            "hydra-dev",
            prompt_args=prompt_args,
            reason=(
                f"orch board has a grill-clear ready-for-agent anchor "
                f"({dev_ready_anchor}) while {orch_anchor} awaits a design "
                f"concept (per-anchor gate, #3711)"
            ),
        )
    return make_dispatch(cls, "hydra-dev", reason="orch board has ready-for-agent issues")

def _select_slot_dev_target(
    cls: str,
    state: dict,
    candidates: dict | None,
    events: list[dict],
    best: dict | None,
    best_score: float,
    now: int,
) -> dict | None:
    """`dev_target` pipeline-slot selector (provenance: #458, #3435, #3432, #3059, #1129)."""
    # Use board signal (work_queue / target backlog) — dev_target dispatches
    # are driven by the target-side queue. AFTER #458 it ALSO surfaces the
    # best /api/anchor/candidates entry as an anchor hint, because the
    # unified candidates feed IS target-product work in this deployment.
    #
    # GITHUB-BOARD BRANCH (issue #3435, spec #3432, ADR-0031). The Target's
    # tracking substrate is migrating from Redis to GitHub Issues on the
    # Target repo. `target_board_work_available` is the collect-state signal
    # for "the scope=target board has ≥1 ready-for-agent, unblocked issue"
    # (collect-state.sh sets it from `target_ready_for_agent > 0`, which is
    # already open-blocker-excluded via the inherited #3059 filter — ADR-0031
    # Decision 5). This is the orch-style Target dispatch decision:
    # ready-for-agent present → dev_target. EXPAND PHASE (ADR-0030): fire on
    # EITHER the legacy Redis `target_work_available` OR the new GitHub-board
    # `target_board_work_available` — both live in parallel during cutover;
    # nothing Redis-side is deleted here.
    if (
        _signal_present(state, events, "target_work_available")
        or _signal_present(state, events, "target_board_work_available")
    ):
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
