"""decide_selectors.dev — dev_orch / dev_target pipeline-slot selectors (issue #4511).

Layer 2 of 3 of the decision brain. Imports the standard library and
decide_base only — never `decide`, never another decide_selectors module.
decide.py binds the handlers below by name into `_SLOT_SELECTORS`.
Every definition here moved verbatim from decide.py.
"""

from __future__ import annotations

from decide_base import (
    RED_FORWARD_FIX_CAP,
    _dev_resume_pick_signal,
    _issue_pr_branch_signal,
    _orch_anchor_signal,
    _red_forward_fix_attempt_count,
    _red_resume_prs,
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


def _dirty_forward_fix_signal(
    state: dict, events: list[dict]
) -> tuple[int, int, str] | None:
    """Parse the `orch_dirty_forward_fix` signal (issue #4807, INV-2).

    The Turn Snapshot carries an `{issue, pr, branch}` pin for the
    lowest-numbered quiescent, unattempted DIRTY PR with exactly one closing
    issue, or `none` (incl. the fail-closed INV-4 path). Same wire shape and
    parser as `orch_dev_resume_pick`. Pure (ADR-0007).
    """
    return _issue_pr_branch_signal(state, events, "orch_dirty_forward_fix")


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
                prompt_args=prompt_args,
                reason=(
                    f"resuming stalled dev_orch anchor {entry['anchor']} "
                    f"— prior completion opened no PR (issue #3866)"
                ),
            )
        # Malformed entry (no anchor) — drop it rather than looping on it
        # forever; still counts as a state mutation main() will persist.
        resume_pending.pop(0)

    # ISSUE #4808: the no-PR durable resume pin. The drain above only owns
    # records the CURRENT state.json still holds; an issue bounced to
    # `needs-dev-resume` by a run that then restarted (or reaped by a session
    # whose state was rebuilt) has no in-state entry, the #4518 pin below keys
    # off an OPEN PR (there is none — that is the point). The Turn Snapshot's
    # `orch_dev_resume_nopr_anchor` closes that gap from what the loop owns
    # durably: the `needs-dev-resume` label plus the open-PR ledger — the
    # LOWEST-numbered such issue that NO open PR references (head-branch or
    # body, drafts included), not in-progress/ready-for-human, and quiescent
    # for the pr-gate window (default 5400s), all resolved upstream in the
    # collector. This selector only reads the signal — no gh, no per-PR I/O
    # (ADR-0007).
    #
    # SEQUENCING (#4808 INV-5): AFTER the #3866 drain above (an in-state
    # record carries the stalled branch this label-derived pin structurally
    # cannot — no PR, no headRefName; and the drain returning first is what
    # keeps the two from dispatching twice in one turn), BEFORE the #4807 /
    # #4518 PR-keyed pins — an issue referenced by ANY open PR is excluded
    # from the signal upstream, so the three picks are disjoint.
    # Like those pins it ignores `orch_work_available` (the anchor is
    # `needs-dev-resume`, not `ready-for-agent`, so the board gate reads
    # false precisely when this pin matters) and the `orch_pending_grill_
    # anchor` yield (the anchor's lifecycle is past grilling — it already
    # had a dispatch).
    #
    # NO state key and NO in-run tracker: the durable cap is enforced at
    # REAP time (#4808 INV-8/9) — `_handle_dev_orch_stall` counts prior
    # no-PR stall comments on the issue and hands it to `ready-for-human`
    # at the third, instead of queueing another resume.
    nopr_anchor = _orch_anchor_signal(state, "orch_dev_resume_nopr_anchor")
    if nopr_anchor is not None:
        return make_dispatch(
            cls,
            "hydra-dev",
            prompt_args={"anchor": nopr_anchor, "resume": True},
            reason=(
                f"no-PR durable dev resume: {nopr_anchor} is needs-dev-resume "
                "with no open PR referencing it — label-derived pin, "
                "quiescent and in-flight-excluded upstream "
                "(issue #4808)"
            ),
        )

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

    # ISSUES #4518 + #5058: the DURABLE, provenance-agnostic resume pick. The
    # drain above only sees records the CURRENT state.json still holds — a
    # record queued by a run that then hit its quota cap, or an anchor bounced
    # to `needs-dev-resume` by QA, has no in-state entry at all. The Turn
    # Snapshot's `orch_dev_resume_pick` derives the pin from what the loop
    # owns durably: the `needs-dev-resume` label, the PR's required-check
    # verdict, and the open-PR ledger (the pr-refs.py predicate). This
    # selector only parses a triple — no gh, no per-PR I/O (ADR-0007).
    #
    # ONE pick, ANY provenance (#5058): the retired GLM-only #4460 forward-fix
    # arm (a PR red on a required check) is folded in, so a GLM, Claude or
    # future worker-lane PR stranded red OR bounced to needs-dev-resume is
    # resumed the same way. The strand #4460 closed still holds for any lane:
    # QA's #3815 admission gate short-circuits a red PR without a FAIL, and
    # the lane below keys off `orch_work_available` — every actor sees
    # "someone is on it"; nobody is.
    #
    # SEQUENCING: AFTER the in-state drain (which can carry a branch for a
    # NO-PR stall this ledger-derived pick structurally cannot — no PR, no
    # headRefName), BEFORE the `orch_work_available` gate. Placement IS the
    # bypass: the anchor is labelled `needs-dev-resume` (or is a red PR's
    # closing issue), not `ready-for-agent`, so `orch_work_available` may be
    # false; and its design-concept artifact already exists (a PR is open),
    # so the grill yield does not apply.
    #
    # CAP — RED-CI ARM ONLY (#5058, ex-#4460 INV-8): when the pick's PR is in
    # `orch_prs_red_resume` (it qualified ONLY because a required check is
    # red), `state.red_forward_fix_attempts[<pr>]` counts pinned dispatches
    # per PR, in-run state only. At RED_FORWARD_FIX_CAP the pin declines and
    # falls through to the normal selector path below (a healthy board may
    # still pin fresh work); `_rule_pr_gate` surfaces the PR the SAME turn.
    # The tracker bump happens ONLY on an actual dispatch, so the surface-pr
    # rule (which runs earlier in decide() and reads the pre-bump value) and
    # this gate agree on the boundary: attempts==CAP-1 dispatches and bumps
    # to CAP; attempts==CAP declines and surfaces. The `needs-dev-resume`
    # arm is uncapped (#4518): idempotency is the label itself — reap's
    # needs-qa promotion (#4460 INV-9) relabels it away once the closing PR
    # is confirmed, and the quiescence window keeps an actively-pushed PR
    # from being re-pinned. `forward_fix_pr` reuses the playbook's
    # forward-fix dispatch contract (continue the PR's head, push to the
    # SAME branch, NEVER `gh pr create`).
    resume_pick = _dev_resume_pick_signal(state, events)
    if resume_pick is not None:
        pick_issue, pick_pr, pick_branch = resume_pick
        prompt_args = {
            "anchor": f"issue-{pick_issue}",
            "resume": True,
            "resume_branch": pick_branch,
            "forward_fix_pr": pick_pr,
        }
        if pick_pr not in _red_resume_prs(state, events):
            return make_dispatch(
                cls,
                "hydra-dev",
                prompt_args=prompt_args,
                reason=(
                    f"durable dev resume: issue #{pick_issue} is needs-dev-resume "
                    f"with open PR {pick_pr} on {pick_branch} — label + PR ledger "
                    "pin, independent of state.dev_resume_pending (issue #4518)"
                ),
            )
        red_attempts = _red_forward_fix_attempt_count(state, pick_pr)
        if red_attempts < RED_FORWARD_FIX_CAP:
            tracker = state.get("red_forward_fix_attempts")
            if not isinstance(tracker, dict):
                tracker = {}
                state["red_forward_fix_attempts"] = tracker
            tracker[str(pick_pr)] = red_attempts + 1
            return make_dispatch(
                cls,
                "hydra-dev",
                prompt_args=prompt_args,
                reason=(
                    f"red PR forward-fix: PR {pick_pr} "
                    f"(issue #{pick_issue}) red on a required check, "
                    f"attempt {red_attempts + 1}/{RED_FORWARD_FIX_CAP} "
                    "(issue #5058)"
                ),
            )
        # Cap exhausted — NO dispatch; _rule_pr_gate's surface-pr owns the
        # operator handoff for THIS PR. Fall through.

    # ISSUE #458: dev_orch must consume the orchestrator GH `ready-for-agent`
    # board, NOT /api/anchor/candidates. The unified candidates feed is
    # dominated by target-product work in this deployment (item-26x are all
    # Target-product tasks), and routing them to dev_orch caused hydra-dev
    # to receive target-only anchors and either escalate or misroute.
    #
    # New contract: dev_orch fires iff `orch_work_available` is set
    # (the Turn Snapshot sets this when `ready_for_agent > 0`). hydra-dev
    # picks its own issue from `gh issue list --label ready-for-agent`
    # on `gaberoo322/hydra` — no anchor is passed through prompt_args
    # because the candidate feed is structurally the wrong source.
    # (Post-#3711 there is ONE exception, below: when a grill is pending on
    # a different anchor we pin dev_orch to the pre-resolved grill-clear
    # `orch_dev_ready_anchor`. That anchor comes from the orch GH board via
    # the Turn Snapshot — NOT from /api/anchor/candidates — so the #458
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
    # The Turn Snapshot now pre-resolves a SECOND signal in the same loop
    # pass: `orch_dev_ready_anchor`, the first board anchor that is already
    # GRILL-CLEAR (fresh artifact, or the mechanical #1230 / trivial #1088
    # exemption). This selector stays a PURE function of
    # (state, events, now) — it reads two pre-qualified strings and does no
    # I/O, exactly like `wayfinder_orch_frontier` /
    # `wire_or_retire_target_available`. decide.py cannot compute artifact
    # freshness itself (that needs the design-concepts API), which is why the
    # pre-resolution lives in the Turn Snapshot.
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
    orch_anchor = _orch_anchor_signal(state, "orch_pending_grill_anchor")
    dev_ready_anchor = _orch_anchor_signal(state, "orch_dev_ready_anchor")
    if orch_anchor is not None:
        if dev_ready_anchor is None or dev_ready_anchor == orch_anchor:
            # Nothing grill-clear to build this turn — yield exactly as the
            # pre-#3711 gate did. This is the correct fallback, and it is
            # also the degraded-signal path: the Turn Snapshot emits `none`
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
            prompt_args={"anchor": dev_ready_anchor},
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
    # Target repo. `target_board_work_available` is the Turn Snapshot signal
    # for "the scope=target board has ≥1 ready-for-agent, unblocked issue"
    # (the Turn Snapshot sets it from `target_ready_for_agent > 0`, which is
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
