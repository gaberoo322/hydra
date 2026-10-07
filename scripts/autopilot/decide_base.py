"""decide_base.py — shared leaf of the decision brain (issue #4511).

Layer 1 of 3. The standard library is the ONLY thing this file imports: it
never imports `decide` or anything under `decide_selectors/`, so imports across
the brain point DOWN only (decide.py -> decide_selectors/*.py -> decide_base.py).

It holds exactly the names needed on both sides of the selector boundary — a
name lives here when decide.py AND at least one selector module use it, or when
two different selector families use it. A name used by one family only lives in
that family's module; a name no selector uses stays in decide.py.

Every definition below moved here verbatim from decide.py. Nothing in this file
performs I/O: decide() stays a pure function of (state, candidates, events, now).
"""

from __future__ import annotations


def _normalize_target_risk_surface(raw) -> dict:
    """Normalize the Target risk-surface payload (issue #4411).

    `state.target_risk_surface` is sourced from the
    `target_risk_surface_json=` line emitted by collect-state.sh, which in
    turn runs `npx tsx scripts/target/print-target-facts.ts` once per turn.
    That script resolves the risk surface from the Target Manifest
    (`<workspace>/.hydra/manifest.json`'s `riskCritical.surface`, ADR-0026)
    and joins it onto `verify.appSubdir` so the result is already
    repo-relative (`surfaceRepoRelative`) — decide.py performs NO path logic
    of its own (Invariant 2 of the design concept for #4411).

    UNLIKE `_normalize_usage_eligibility` / `_normalize_emergency_brake`,
    this normalizer is FAIL-CLOSED, not fail-open (Invariant 3): a missing,
    malformed, or ok:false payload returns `{"ok": False, "surface": None}` —
    the caller (the `wire_or_retire_target` dispatch) must WITHHOLD the
    dispatch rather than fall back to any hardcoded or empty carve-out. An
    empty-but-present surface list is likewise not-ok, since threading an
    empty carve-out would silently disable the risk/live-execution guard —
    exactly the ADR-0026 decision-7 failure mode this replaces.

    Returns `{"ok": True, "surface": list[str]}` only when collect-state.sh
    resolved a NON-EMPTY `surfaceRepoRelative` list; otherwise
    `{"ok": False, "surface": None}`.
    """
    if not isinstance(raw, dict):
        return {"ok": False, "surface": None}
    if raw.get("ok") is not True:
        return {"ok": False, "surface": None}
    surface_raw = raw.get("surfaceRepoRelative")
    if not isinstance(surface_raw, list) or not surface_raw:
        return {"ok": False, "surface": None}
    surface = [s for s in surface_raw if isinstance(s, str) and s]
    if not surface:
        return {"ok": False, "surface": None}
    return {"ok": True, "surface": surface}


# qa_orch per-issue stall cap (issue #3829, design-concept issue-3829,
# artifact d11fbcf45ed0...). This is a decide.py POLICY CONSTANT, not a
# classes.json field (design-concept invariant 2) — mirrors how
# ESCALATION_POLICY / ESCALATION_DEFAULT_MAX_ATTEMPTS already keep cap values
# out of classes.json, which stays the alphabet only (its own doc-field
# contract: "POLICY stays in decide.py").
#
# qa_orch has `cooldownSeconds: null` and is deliberately ABSENT from
# ESCALATION_POLICY (invariant 3, pinned by
# test/decide-cascade-escalation.test.mts's invariant 5) — this stall cap is a
# STRUCTURALLY SEPARATE mechanism (a cross-turn, per-issue counter) from the
# single-dispatch model-tier escalation cascade and must never be conflated
# with it: ESCALATION_POLICY governs a one-time stronger-tier retry
# immediately after a subagent STOP within one cascade, keyed on that
# dispatch's own `attempt` field — it has no concept of "this GitHub issue has
# been reviewed N times across many separate autopilot turns", and the
# motivating failure (a lost-reviewer race, docs/operator-playbooks/
# hydra-qa.md step 7.5) may not even set a `subagent_failure` stop status,
# since hydra-qa completes cleanly and just declines to emit a verdict.
# Without this SEPARATE, persistent per-issue counter, an issue that
# repeatably cannot reach a QA verdict (the motivating case: the hourly
# worktree-orphan-prune reaping the parent + reviewer worktrees mid-review)
# keeps `needs_qa_orch` true forever and qa_orch re-dispatches every turn at
# 30-65k tokens/turn (issue #3829 mechanism section).
#
# 3 bounds worst-case spend for one stuck issue to roughly 3 x 30-65k =~
# 90-195k tokens (versus unbounded today) while still tolerating one truly
# transient failure (#3789 is intended to make the motivating race rarer) that
# self-heals on a plain retry — the upper end of the issue's own suggested 2-3
# range, since unlike the escalation cascade a capped qa_orch retry has no
# stronger model to try, so slightly more slack before giving up is
# reasonable.
QA_STALL_MAX_ATTEMPTS = 3


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
# escalates (invariant 5).
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
        # Issue #4605, INV-4: the escalation re-dispatch is a SEPARATE
        # make_dispatch site from `_select_signal_cleanup_orch`'s (see
        # `_rule_escalation` below), and the #3274 dedup keeps the
        # escalation copy over the plain signal copy when both fire on the
        # same turn — so without this, the Sonnet retry silently drops the
        # apply:true stamp and re-runs as a dry run. `_rule_escalation`
        # merges this dict into the re-dispatch's prompt_args ahead of
        # escalate_model/attempt/prior_attempt_status. dev_orch's row omits
        # this key, so its escalation prompt_args stay byte-identical.
        "prompt_args": {"apply": True},
    },
    # dev_orch was demoted from the frontier tier to Sonnet on 2026-07-29 (see
    # the playbook's per-class routing table for the evidence: the GLM-5.2
    # beachhead cleared this repo's dev_orch bar from BELOW Sonnet). This row is
    # the safety net that makes the demotion reversible per-dispatch instead of
    # per-config — a real capability miss self-rescues at the frontier tier
    # rather than stalling the class until an operator notices.
    #
    # Triggers on "subagent_failure" ONLY, deliberately NOT "subagent_noop".
    # A dev_orch no_op is overwhelmingly board-driven, not capability-driven
    # (nothing labelled ready-for-agent, every candidate already has an open PR,
    # the glm-eligible partition subtracted the queue). Escalating those would
    # burn a frontier dispatch to re-discover an empty board — the same
    # saturation-vs-capability distinction cleanup_orch's row draws above, and
    # the reason that row gates its no_op on board freshness.
    #
    # max_attempts 2 = at most ONE frontier retry (invariant 4).
    "dev_orch": {
        "triggers": ("subagent_failure",),
        "model": "fable",
        "max_attempts": 2,
    },
}


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


def signal_dark_past_floor(
    state: dict, sig: str, now: int, floor_sec: int
) -> bool:
    """True iff `sig`'s last-fired timestamp is older than `floor_sec`, OR the
    class has never fired (last == 0 — maximally dark).

    Issue #4114's gate-level staleness floor. Reads ONLY
    `state.signal_last_fired[sig]` + `now` — no new I/O, no fs/network/Redis
    (design-concept #4114 INV-1; ADR-0007 purity), the same seam
    signal_is_cooled / signal_starved read.

    The never-fired semantics deliberately INVERT signal_starved's, and the
    contrast is the point: for the #2428 intra-turn stagger override, "never
    fired" is normal cold-start (treating every unseen class as starved would
    force them ALL through and defeat the stagger); for a gate-level PRODUCER
    trigger, "never fired" IS the dark state the floor exists to break — the
    #4114 finding was precisely a producer class at last==0 that the idle-only
    gate could never unlock (a floor that required last>0 would be a no-op on
    the exact state it was added to fix). Mirrors scout_orch's
    scout_walk_due ">=7d old OR EMPTY" calendar precedent.

    Pure: never mutates state and never touches fs/network/Redis.

    Class-parameterized (floor passed explicitly, no discover_orch default):
    #4114 wires it for discover_orch only, but the predicate itself is generic
    so the deferred architecture_orch / cleanup_orch follow-up reuses it
    verbatim (design-concept #4114 INV-3 + rejectedAlternatives).
    """
    last = (state.get("signal_last_fired") or {}).get(sig, 0) or 0
    try:
        last_i = int(last)
    except (TypeError, ValueError):
        last_i = 0
    if last_i <= 0:
        # Never fired → maximally stale: dark TODAY, which is exactly the
        # condition the floor exists to break (see the #4114 note above).
        return True
    return (now - last_i) >= floor_sec


# Cap on pinned glm-red forward-fix dispatches per PR (issue #4460 INV-6/8):
# a stranded GLM-authored PR red on one required check gets at most two
# autopilot-funded attempts before the operator owns it via `surface-pr`.
# In-run state (`state.glm_red_forward_fix_attempts`), NOT persisted to the
# board — a new run re-arms the cap exactly like every other in-run tracker.
GLM_RED_FORWARD_FIX_CAP = 2


def _glm_red_forward_fix_signal(
    state: dict, events: list[dict]
) -> tuple[int, int, str] | None:
    """Parse the `orch_glm_red_forward_fix` signal (issue #4460, INV-2/6).

    collect-state.sh emits it as `issue-<N>:<pr>:<headRefName>` for the
    lowest-numbered qualifying GLM PR, or the literal `none` (no qualifier,
    or the fail-closed INV-5 path where a supporting read failed). Events
    take precedence over state, mirroring `_pr_gate_numbers` /
    `_signal_present` — the same turn-local override seam.

    Absent / "none" / malformed → None. Malformed NEVER raises: a bad signal
    means "no dispatch this turn" (fail-closed), never a crash — the same
    #4130 discipline as `_orch_anchor_signal`'s non-string collapse.

    Pure: reads the passed-in dicts only, no I/O (ADR-0007).
    """
    return _issue_pr_branch_signal(state, events, "orch_glm_red_forward_fix")


def _target_dev_resume_pick_signal(
    state: dict, events: list[dict]
) -> tuple[int, int, str] | None:
    """Parse the `target_dev_resume_pick` signal (issue #4739, INV-1/INV-5).

    collect-state.sh emits it as `issue-<N>:<pr>:<headRefName>` for the
    lowest-numbered open Target issue labelled `needs-dev-resume` that is the
    single closing issue of an open non-draft Target PR, or the literal
    `none` — the same wire shape as `orch_dev_resume_pick` (#4518), parsed by
    the same helper. The label + the open-PR ledger are the durable source of
    truth: a Target fix-forward decision (QA FAIL + operator "fix forward on
    PR #N") relabels the issue `needs-dev-resume`, which the #4474 in-flight
    exclusion deliberately does NOT count into `target_ready_for_agent`, so
    without this pin dev_target never dispatches the resume. Absent / `none` /
    malformed fails CLOSED to no pin (same #4130 discipline).

    Pure: reads the passed-in dicts only, no I/O (ADR-0007).
    """
    return _issue_pr_branch_signal(state, events, "target_dev_resume_pick")


def _raw_signal(state: dict, events: list[dict], name: str) -> object:
    """Raw value of signal `name`: the first matching `signal` event wins,
    else `state.signals[name]`, else None. The one event-then-state lookup
    the PR-gate / pinned-PR parsers share (the `_signal_present` precedence). Pure.
    """
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == name:
            return ev.get("value")
    return (state.get("signals") or {}).get(name)


def _issue_pr_branch_signal(
    state: dict, events: list[dict], name: str
) -> tuple[int, int, str] | None:
    """Parse an `issue-<N>:<pr>:<headRefName>` pinned-PR signal by name.

    The shared wire shape of collect-state.sh's pre-resolved dev pins:
    `orch_glm_red_forward_fix` (#4460), `orch_dev_resume_pick` (#4518), and
    `target_dev_resume_pick` (#4739). Events take precedence over state (the
    `_signal_present` seam). Absent / "none" / malformed -> None; NEVER
    raises.
    """
    raw = _raw_signal(state, events, name)
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw or raw == "none":
        return None
    parts = raw.split(":")
    if len(parts) != 3:
        return None
    issue_part, pr_part, branch_part = parts
    if not issue_part.startswith("issue-"):
        return None
    try:
        issue_num = int(issue_part[len("issue-"):])
        pr_num = int(pr_part)
    except (TypeError, ValueError):
        return None
    branch = branch_part.strip()
    if issue_num <= 0 or pr_num <= 0 or not branch:
        return None
    return issue_num, pr_num, branch


def _dirty_forward_fix_signal(
    state: dict, events: list[dict]
) -> tuple[int, int, str] | None:
    """Parse the `orch_dirty_forward_fix` signal (issue #4807, INV-2).

    collect-state.sh emits `issue-<N>:<pr>:<headRefName>` for the
    lowest-numbered quiescent, unattempted DIRTY PR with exactly one closing
    issue, or `none` (incl. the fail-closed INV-4 path). Same wire shape and
    parser as `orch_dev_resume_pick`. Pure (ADR-0007).
    """
    return _issue_pr_branch_signal(state, events, "orch_dirty_forward_fix")


def _dirty_surface_pairs(
    state: dict, events: list[dict]
) -> list[tuple[int, int | None]]:
    """Parse `orch_prs_dirty_surface` (issue #4807, INV-2/7) into
    `[(pr, closing_issue|None)]`, ascending by PR number.

    Wire shape: space-separated `<pr>:<issue|none>` pairs — the DIRTY PRs to
    surface THIS turn (the bucket `orch_prs_dirty` stays whole for the sweep's
    hold). Absent / malformed tokens are dropped (fail-closed: surfacing is
    terminal, so a bad token waits rather than surfaces). Pure.
    """
    raw = _raw_signal(state, events, "orch_prs_dirty_surface")
    if raw is None:
        return []
    tokens = raw if isinstance(raw, (list, tuple)) else str(raw).split()
    pairs: dict[int, int | None] = {}
    for token in tokens:
        parts = str(token).strip().split(":")
        if len(parts) != 2:
            continue
        try:
            pr_num = int(parts[0])
        except (TypeError, ValueError):
            continue
        if pr_num <= 0:
            continue
        issue_num: int | None = None
        if parts[1] != "none":
            try:
                issue_num = int(parts[1])
            except (TypeError, ValueError):
                continue
            if issue_num <= 0:
                continue
        pairs[pr_num] = issue_num
    return sorted(pairs.items())


def _glm_red_attempt_count(state: dict, pr_number: int) -> int:
    """Forward-fix attempts already spent on one GLM red PR (issue #4460).

    `state.glm_red_forward_fix_attempts` maps the PR number (string key —
    JSON round-trips collapse int keys) to the count of pinned dispatches
    the dev_orch selector has already burned on it. Missing map, missing
    key, or a non-int value → 0 (a malformed tracker must never strand a PR
    by masquerading as an exhausted cap).

    Pure: reads the passed-in dict only.
    """
    tracker = state.get("glm_red_forward_fix_attempts")
    if not isinstance(tracker, dict):
        return 0
    try:
        return int(tracker.get(str(pr_number), 0))
    except (TypeError, ValueError):
        return 0


def _orch_anchor_signal(signals: dict | None, key: str) -> str | None:
    """Read a collect-state anchor-ref signal, normalising "absent" spellings.

    `collect-state.sh` emits the orch anchor signals (`orch_pending_grill_anchor`
    and, post-#3711, `orch_dev_ready_anchor`) as a single string that is either
    an `issue-<N>` ref or the literal `"none"` when there is no such anchor —
    including the degraded case where the board read failed. The signal may also
    be omitted from `state.signals` entirely by an older autopilot turn.

    All three "no anchor" spellings (absent key, empty string, literal "none")
    collapse to None here so callers branch on one condition instead of
    re-deriving the triple. Anything non-string is also None: a malformed signal
    must never be mistaken for a real anchor ref.

    Pure: reads the passed-in dict only. No I/O (issue #3711 keeps decide.py a
    pure function of (state, events, now)).
    """
    if not isinstance(signals, dict):
        return None
    raw = signals.get(key)
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw or raw == "none":
        return None
    return raw


def _needs_qa_target_pr_ref(state: dict, events: list[dict]) -> str | None:
    """Read the current turn's pre-resolved Target QA PR ref (issue #4576).

    collect-state.sh emits `target_needs_qa_pr_ref` as a fresh per-turn fact
    (the html_url of the open Target PR that closes the first open needs-qa
    Target issue, or an empty string when none resolves), which the playbook
    merges verbatim into `state.signals.target_needs_qa_pr_ref` — the same
    verbatim-string seam as `needs_qa_numbers` / `target_needs_triage_items`.
    Event value preferred over state.signals, the same lookup order as
    `_triage_item_set`. Returns `None` when the signal is ABSENT or EMPTY —
    the fail-open sentinel: the qa_target dispatch still fires, and
    hydra-target-qa's own step 1 resolves the PR when `pr_ref` is absent
    (#4576 INV-5 — an unreadable pre-resolution never dead-arms the class,
    the #3709 defect class).

    Pure: no side effects.
    """
    raw = None
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == "target_needs_qa_pr_ref":
            raw = ev.get("value")
            break
    if raw is None:
        raw = (state.get("signals") or {}).get("target_needs_qa_pr_ref")
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _signal_present(state: dict, events: list[dict], signal: str) -> bool:
    """Look up a board/event signal by name. Events take precedence over state."""
    for ev in events:
        if ev.get("type") == "signal" and ev.get("name") == signal:
            return bool(ev.get("value", True))
    # Fallback: signals stored on state.signals (filled by collect-state.sh)
    return bool((state.get("signals") or {}).get(signal))


def _orch_board_read_degraded(state: dict, events: list[dict] | None = None) -> bool:
    """True when collect-state.sh flagged the orch board read as degraded (issue #4130).

    collect-state.sh emits `orch_board_signals_degraded=true` when ANY of the
    orch-lane GitHub board reads that this loop's idle conclusion depends on
    failed (the board-counts read, the grill/dev-ready candidate enumeration,
    or the backfill-idle board read). A genuinely empty board emits `false` —
    the flag distinguishes "the read failed" from "the board is empty", which
    the zero/none-rendering of a failed read never could (the GraphQL-only
    503 outage of 2026-08-17 drained a run to a clean `terminate:idle` with 15
    eligible issues on the board). decide.py stays pure: it reads the
    pre-resolved flag, exactly like every other collect-state-owned signal.
    """
    return _signal_present(state, events or [], "orch_board_signals_degraded")


def _orch_backfill_idle_present(state: dict, events: list[dict]) -> bool:
    """`orch_backfill_idle`, suppressed on a degraded orch board read (issue #4130).

    The board-empty conjunction must never be satisfied by failed reads
    rendering as zeros: a degraded snapshot that happens to carry a stale
    `orch_backfill_idle=true` (or a collect-state emission bug) must not fire
    discover/architecture/cleanup/skill-prune backfill against a board that
    may actually be full. Belt-and-braces on top of collect-state.sh's own
    fail-closed emission (`orch_backfill_idle=false` on a failed read).
    """
    return _signal_present(state, events, "orch_backfill_idle") and not _orch_board_read_degraded(
        state, events
    )
