"""decide_selectors.dev — dev_orch / dev_target pipeline-slot selectors (issue #4511).

Layer 2 of 3 of the decision brain. Imports the standard library and
decide_base only — never `decide`, never another decide_selectors module.
decide.py binds the handlers below by name into `_SLOT_SELECTORS`.
Every definition here moved verbatim from decide.py.
"""

from __future__ import annotations

from decide_base import (
    GLM_RED_FORWARD_FIX_CAP,
    _glm_red_attempt_count,
    _glm_red_forward_fix_signal,
    _dirty_forward_fix_signal,
    _issue_pr_branch_signal,
    _orch_anchor_signal,
    _signal_present,
    _target_dev_resume_pick_signal,
    make_dispatch,
)


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


def _dev_resume_pick_signal(
    state: dict, events: list[dict]
) -> tuple[int, int, str] | None:
    """Parse the `orch_dev_resume_pick` signal (issue #4518, INV-2).

    collect-state.sh emits it as `issue-<N>:<pr>:<headRefName>` for the
    lowest-numbered open, non-draft, NON-GLM PR whose single closing issue
    carries `needs-dev-resume`, or the literal `none`. The label + the
    open-PR ledger are the source of truth; `state.dev_resume_pending` is
    only a cache that a Pace Gate relaunch or a quota-capped run can lose.
    Absent / `none` / malformed fails CLOSED to no pin (mirrors
    `_glm_red_forward_fix_signal`'s INV-5 stance).

    Pure: reads the passed-in dicts only, no I/O (ADR-0007).
    """
    return _issue_pr_branch_signal(state, events, "orch_dev_resume_pick")


def _select_slot_dev_orch(
    cls: str,
    state: dict,
    candidates: dict | None,
    events: list[dict],
    best: dict | None,
    best_score: float,
    now: int,
) -> dict | None:
    """`dev_orch` pipeline-slot selector (provenance: #3866, #458, #3711, #751, #628, #1230, #1088, #3798, #4821, #3795, #1093)."""
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
                prompt_args={"anchor": dev_ready_anchor},
                reason=(
                    f"resuming stalled dev_orch anchor {entry['anchor']} "
                    f"— prior completion opened no PR (issue #3866)"
                ),
            )
        # Malformed entry (no anchor) — drop it rather than looping on it
        # forever; still counts as a state mutation main() will persist.
        resume_pending.pop(0)

    # ISSUE #4807 (INV-5): one conflict fix-forward per DIRTY PR. A DIRTY PR
    # fails both sibling pins below (#4518 / #4460 reject DIRTY), so the three
    # picks are disjoint; placement before them only fixes determinism, and —
    # like them — it ignores `orch_work_available` and the grill yield. The
    # `conflict-fix-attempted` PR label (applied by the dispatch binding
    # BEFORE the spawn) IS the durable cap: no tracker, no state key.
    dirty_fix = _dirty_forward_fix_signal(state, events)
    if dirty_fix is not None:
        fix_issue, fix_pr, fix_branch = dirty_fix
        return make_dispatch(
            cls,
            "hydra-dev",
            prompt_args={
                "anchor": f"issue-{fix_issue}",
                "resume": True,
                "resume_branch": fix_branch,
                "forward_fix_pr": fix_pr,
                "conflict_fix": True,
            },
            reason=(
                f"dirty PR conflict fix-forward: PR {fix_pr} (issue #{fix_issue}) "
                f"on {fix_branch} — merge origin/master, one attempt per PR "
                "(issue #4807)"
            ),
        )

    # ISSUE #4518 (INV-2): the DURABLE Claude-lane resume pick. The drain
    # above only sees records the CURRENT state.json still holds — a record
    # queued by a run that then hit its quota cap, or an anchor bounced to
    # `needs-dev-resume` by QA, has no in-state entry at all, and the #4460
    # arm below owns only GLM-provenance PRs. collect-state.sh's
    # `orch_dev_resume_pick` derives the same pin from what the loop owns
    # durably: the `needs-dev-resume` label + the open-PR ledger (the
    # pr-refs.py predicate). This selector only parses a triple — no gh, no
    # per-PR I/O (ADR-0007).
    #
    # SEQUENCING: AFTER the in-state drain (which can carry a branch for a
    # NO-PR stall this label-derived pick structurally cannot — no PR, no
    # headRefName), BEFORE the #4460 GLM forward-fix pin and the
    # `orch_work_available` gate. Placement IS the bypass, exactly as for
    # #4460: the anchor is labelled `needs-dev-resume`, not
    # `ready-for-agent`, so `orch_work_available` may be false; and its
    # design-concept artifact already exists (a PR is open), so the grill
    # yield does not apply.
    #
    # NO new state key and NO new cap: idempotency is the label itself —
    # reap's needs-qa promotion (#4460 INV-9) relabels `needs-dev-resume`
    # away once the closing PR is confirmed, and collect-state's quiescence
    # window keeps an actively-pushed PR from being re-pinned.
    # `forward_fix_pr` reuses the playbook's forward-fix dispatch contract
    # (continue the PR's head, push to the SAME branch, NEVER
    # `gh pr create`). The #4460 tracker `glm_red_forward_fix_attempts` is
    # deliberately NOT touched here.
    resume_pick = _dev_resume_pick_signal(state, events)
    if resume_pick is not None:
        pick_issue, pick_pr, pick_branch = resume_pick
        return make_dispatch(
            cls,
            "hydra-dev",
            prompt_args={
                "anchor": f"issue-{pick_issue}",
                "resume": True,
                "resume_branch": pick_branch,
                "forward_fix_pr": pick_pr,
            },
            reason=(
                f"durable dev resume: issue #{pick_issue} is needs-dev-resume "
                f"with open PR {pick_pr} on {pick_branch} — label + PR ledger "
                "pin, independent of state.dev_resume_pending (issue #4518)"
            ),
        )

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
    # SEQUENCING (#4460 INV-6): AFTER the #3866 dev_resume_pending drain above
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
    # CAP (#4460 INV-8): `state.glm_red_forward_fix_attempts[<pr>]` counts
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
        # ISSUE #4821: the pin carries the anchor and NOTHING else. #3798 used
        # to attach a first-attempt frontier-tier hint here whenever the
        # anchor's grill-clearness came from an approved design-concept
        # artifact, sized on a board sample where 24% of anchors had one. In
        # steady state every non-exempt anchor is grilled before it can be
        # pinned, so that test was true of every pinned dispatch (11 of 22
        # first attempts, 36% of dev_orch tokens, no better first-pass QA
        # rate). A first-attempt dispatch now always resolves its model from
        # the playbook's static per-class map; the ONE path to the frontier
        # tier is the `subagent_failure` retry (`decide_escalation`,
        # `ESCALATION_POLICY["dev_orch"]`), untouched.
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
    """`dev_target` pipeline-slot selector (provenance: #458, #3435, #3432, #3059, #1129, #4739)."""
    # TARGET DEV RESUME PIN (issue #4739, INV-5) — checked FIRST, before and
    # independent of the board signals below. The resume issue carries
    # `needs-dev-resume`, NOT `ready-for-agent`, so both board signals may be
    # false while a held fix-forward PR (QA FAIL + operator "fix forward on
    # PR #N, push to its existing branch") waits: the #4474 in-flight
    # exclusion subtracts every ready-for-agent issue referenced by an open
    # Target PR, and the resume issue deliberately isn't one. Without this
    # pin the resume is invisible to dev_target forever. Idempotency is the
    # label: hydra-target-build's resume arm relabels needs-dev-resume →
    # needs-qa after the push, so the pin clears itself on success and the
    # next turn re-pins after class cooldown if nothing could be pushed.
    # Pure: the pick comes off state/events only (ADR-0007) — no gh, no I/O,
    # no new state key, no cap.
    resume_pick = _target_dev_resume_pick_signal(state, events)
    if resume_pick is not None:
        pick_issue, pick_pr, pick_branch = resume_pick
        return make_dispatch(
            cls,
            "hydra-target-build",
            prompt_args={
                "anchor": f"issue-{pick_issue}",
                "resume": True,
                "resume_issue": pick_issue,
                "resume_pr": pick_pr,
                "resume_branch": pick_branch,
            },
            reason=(
                "target dev resume pin: needs-dev-resume issue-"
                f"{pick_issue} held by open PR #{pick_pr} "
                f"(branch {pick_branch}) — fix-forward resume (issue #4739)"
            ),
        )
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
