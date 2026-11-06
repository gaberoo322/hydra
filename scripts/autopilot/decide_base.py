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

import re
from dataclasses import dataclass, fields
from typing import ClassVar

import turn_snapshot as ts


def _normalize_target_risk_surface(raw) -> dict:
    """Normalize the Target risk-surface payload (issue #4411).

    `state.target_risk_surface` is sourced from the Turn Snapshot's
    `target_risk_surface` blob, which in turn reads the Target facts
    (`scripts/target/print-target-facts.ts`) once per turn.
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

    Returns `{"ok": True, "surface": list[str]}` only when the Turn Snapshot
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

# Issue #4999 — zero-yield back-off ladder for idle-board producer classes.
# discover_target's only trigger (`target_backfill_idle`) stays true whenever
# a dispatch finds nothing (the board stays idle, the signal stays true), so
# the 30m class cooldown was the ONLY gate — and bootstrap re-arms its
# signal_last_fired to 0 every run (ALWAYS_ON_REARMED, by design), so on the
# ~15-min pace-gate relaunch cadence the class re-fired ~every 30 minutes for
# as long as the Target board sat idle (measured 2026-10-13: 14 straight
# runs, 26 dispatches, 0 filed, ~73k tokens each ≈ 3.5M tokens/day). The
# ladder backs off the EFFECTIVE interval after consecutive zero-yield fires:
# streak 0-2 → base behaviour, 3-5 → 4h between fires, 6+ → 24h. The 24h top
# rung IS BACKFILL_STARVATION_FLOOR_SEC, so the #4302 never-dark property
# holds by construction (INV-2): the class never goes fully dark on an idle
# board, it just stops paying 73k tokens every 30 minutes to reconfirm it.
# Fixed constants, deliberately NOT env-tunable (the operator specified the
# three rungs via /hydra-hitl-grill; an exponential ladder was rejected).
ZERO_YIELD_BACKOFF_LADDER: tuple[tuple[int, int], ...] = (
    (3, 4 * 3600),  # 3-5 consecutive zero-yield fires → wait 4h since the last
    (6, BACKFILL_STARVATION_FLOOR_SEC),  # 6+ → 24h (the #4302 floor, INV-2)
)


# --- Dispatch Intent (issue #5381, epic #5380; ADR-0007 amendment 2026-11-05) -
# A bespoke pipeline slot's `dispatch` action carries a typed, closed-kind
# Dispatch Intent instead of the untyped `prompt_args` bag. Each kind holds only
# its own fields. On the wire the action stores `intent.to_dict()` (a plain
# `{kind, ...}` object, so the Plan stays json.dumps-able); readers
# reconstitute the dataclass through `dispatch_intent(action)`.


def _need_str(kind: str, name: str, value) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"dispatch intent {kind!r}: {name} must be a non-empty string, got {value!r}")


def _need_anchor(kind: str, value) -> None:
    """An anchor must be an `issue-<N>` ref: the renderer pins only that shape, so
    anything else would silently render UNPINNED (the fallback ADR-0007 forbids)."""
    if not isinstance(value, str) or not re.fullmatch(r"issue-\d+", value):
        raise ValueError(f"dispatch intent {kind!r}: anchor must match issue-<N>, got {value!r}")


def _need_pr(kind: str, value) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"dispatch intent {kind!r}: pr must be a positive int, got {value!r}")


@dataclass(frozen=True)
class Fresh:
    """Self-select the next ready-for-agent issue, or build a pinned `anchor` (#3711)."""

    kind: ClassVar[str] = "Fresh"
    anchor: str | None = None

    def __post_init__(self):
        if self.anchor is not None:
            _need_anchor(self.kind, self.anchor)

    def to_dict(self) -> dict:
        d: dict = {"kind": self.kind}
        if self.anchor is not None:
            d["anchor"] = self.anchor
        return d


@dataclass(frozen=True)
class ResumeBranch:
    """Resume a stalled no-PR run from its prior `branch` (#3866)."""

    kind: ClassVar[str] = "ResumeBranch"
    anchor: str
    branch: str

    def __post_init__(self):
        _need_anchor(self.kind, self.anchor)
        _need_str(self.kind, "branch", self.branch)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "anchor": self.anchor, "branch": self.branch}


@dataclass(frozen=True)
class ResumeSalvage:
    """Resume a stalled no-PR run with no known branch (#3866 / #4808)."""

    kind: ClassVar[str] = "ResumeSalvage"
    anchor: str

    def __post_init__(self):
        _need_anchor(self.kind, self.anchor)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "anchor": self.anchor}


@dataclass(frozen=True)
class ForwardFixRed:
    """Forward-fix an open PR: both arms of the #5058 `orch_dev_resume_pick`
    (needs-dev-resume, or red on a required check)."""

    kind: ClassVar[str] = "ForwardFixRed"
    anchor: str
    pr: int
    branch: str

    def __post_init__(self):
        _need_anchor(self.kind, self.anchor)
        _need_pr(self.kind, self.pr)
        _need_str(self.kind, "branch", self.branch)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "anchor": self.anchor, "pr": self.pr, "branch": self.branch}


@dataclass(frozen=True)
class ForwardFixConflict:
    """Conflict fix-forward of a DIRTY PR, no QA FAIL pending at head (#4807)."""

    kind: ClassVar[str] = "ForwardFixConflict"
    anchor: str
    pr: int
    branch: str

    def __post_init__(self):
        _need_anchor(self.kind, self.anchor)
        _need_pr(self.kind, self.pr)
        _need_str(self.kind, "branch", self.branch)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "anchor": self.anchor, "pr": self.pr, "branch": self.branch}


@dataclass(frozen=True)
class ForwardFixConflictWithFail:
    """Two-phase conflict fix-forward: a QA FAIL is pending at head (#5253)."""

    kind: ClassVar[str] = "ForwardFixConflictWithFail"
    anchor: str
    pr: int
    branch: str

    def __post_init__(self):
        _need_anchor(self.kind, self.anchor)
        _need_pr(self.kind, self.pr)
        _need_str(self.kind, "branch", self.branch)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "anchor": self.anchor, "pr": self.pr, "branch": self.branch}


@dataclass(frozen=True)
class ReviewLane:
    """Review the selector's parked-filtered needs-qa lane head `anchor`; `rest` is
    the remaining parked-filtered lane in order (issue #5382)."""

    kind: ClassVar[str] = "ReviewLane"
    anchor: str
    rest: tuple = ()

    def __post_init__(self):
        _need_anchor(self.kind, self.anchor)
        if not isinstance(self.rest, (list, tuple)):
            raise ValueError(f"dispatch intent {self.kind!r}: rest must be a list, got {self.rest!r}")
        rest = tuple(self.rest)
        for r in rest:
            _need_anchor(self.kind, r)
        if self.anchor in rest:
            raise ValueError(f"dispatch intent {self.kind!r}: rest must not contain the head {self.anchor!r}")
        object.__setattr__(self, "rest", rest)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "anchor": self.anchor, "rest": list(self.rest)}


@dataclass(frozen=True)
class ReviewSelfSelect:
    """No per-issue lane fact this turn (degraded board read): hydra-qa resolves the
    needs-qa lane head itself (#3709 fail-open on the coarse boolean)."""

    kind: ClassVar[str] = "ReviewSelfSelect"

    def to_dict(self) -> dict:
        return {"kind": self.kind}


@dataclass(frozen=True)
class TargetFresh:
    """Self-select the next ready-for-agent Target issue, or build a pinned `anchor`
    (issue #5383; the dev_target board arm, #458/#1129)."""

    kind: ClassVar[str] = "TargetFresh"
    anchor: str | None = None

    def __post_init__(self):
        if self.anchor is not None:
            _need_anchor(self.kind, self.anchor)

    def to_dict(self) -> dict:
        d: dict = {"kind": self.kind}
        if self.anchor is not None:
            d["anchor"] = self.anchor
        return d


@dataclass(frozen=True)
class TargetResume:
    """Resume a needs-dev-resume Target issue's open PR on its prior branch (#4739)."""

    kind: ClassVar[str] = "TargetResume"
    anchor: str
    pr: int
    branch: str

    def __post_init__(self):
        _need_anchor(self.kind, self.anchor)
        _need_pr(self.kind, self.pr)
        _need_str(self.kind, "branch", self.branch)

    def to_dict(self) -> dict:
        return {"kind": self.kind, "anchor": self.anchor, "pr": self.pr, "branch": self.branch}


@dataclass(frozen=True)
class TargetReviewPr:
    """Review the pre-resolved Target PR `pr_ref`; `head` is its head ref when the
    Turn Snapshot resolved one (issue #5383, #4576/#4653)."""

    kind: ClassVar[str] = "TargetReviewPr"
    pr_ref: str
    head: str | None = None

    def __post_init__(self):
        _need_str(self.kind, "pr_ref", self.pr_ref)
        if self.head is not None:
            _need_str(self.kind, "head", self.head)

    def to_dict(self) -> dict:
        d: dict = {"kind": self.kind, "pr_ref": self.pr_ref}
        if self.head is not None:
            d["head"] = self.head
        return d


@dataclass(frozen=True)
class TargetReviewSelfSelect:
    """No pre-resolved Target PR this turn: hydra-target-qa resolves it itself
    (#4576 INV-5 fail-open)."""

    kind: ClassVar[str] = "TargetReviewSelfSelect"

    def to_dict(self) -> dict:
        return {"kind": self.kind}


DEV_INTENT_CLASSES = (
    Fresh,
    ResumeBranch,
    ResumeSalvage,
    ForwardFixRed,
    ForwardFixConflict,
    ForwardFixConflictWithFail,
)
DEV_INTENT_KINDS: tuple[str, ...] = tuple(c.kind for c in DEV_INTENT_CLASSES)
QA_INTENT_CLASSES = (ReviewLane, ReviewSelfSelect)
QA_INTENT_KINDS: tuple[str, ...] = tuple(c.kind for c in QA_INTENT_CLASSES)
DEV_TARGET_INTENT_CLASSES = (TargetFresh, TargetResume)
DEV_TARGET_INTENT_KINDS: tuple[str, ...] = tuple(c.kind for c in DEV_TARGET_INTENT_CLASSES)
QA_TARGET_INTENT_CLASSES = (TargetReviewPr, TargetReviewSelfSelect)
QA_TARGET_INTENT_KINDS: tuple[str, ...] = tuple(c.kind for c in QA_TARGET_INTENT_CLASSES)
INTENT_KINDS_BY_SLOT: dict[str, tuple[str, ...]] = {
    "dev_orch": DEV_INTENT_KINDS,
    "qa_orch": QA_INTENT_KINDS,
    "dev_target": DEV_TARGET_INTENT_KINDS,
    "qa_target": QA_TARGET_INTENT_KINDS,
}
_ALL_INTENT_CLASSES = DEV_INTENT_CLASSES + QA_INTENT_CLASSES + DEV_TARGET_INTENT_CLASSES + QA_TARGET_INTENT_CLASSES
_INTENT_REGISTRY = {c.kind: c for c in _ALL_INTENT_CLASSES}
assert len(_INTENT_REGISTRY) == len(_ALL_INTENT_CLASSES), "intent kind names must be globally unique"

# prompt_args keys that may ride ALONGSIDE an intent: slot-generic dispatch
# machinery (cascade routing #3274), not the work shape.
ESCALATION_META_KEYS = frozenset({"escalate_model", "attempt", "prior_attempt_status"})


def intent_from_dict(raw):
    """Parse a wire `{kind, ...}` dict into its intent dataclass; raise on unknown kind."""
    if not isinstance(raw, dict):
        raise ValueError(f"dispatch intent must be an object, got {type(raw).__name__}")
    kind = raw.get("kind")
    cls = _INTENT_REGISTRY.get(kind)
    if cls is None:
        raise ValueError(f"unknown dispatch intent kind {kind!r}")
    try:
        return cls(**{f.name: raw[f.name] for f in fields(cls) if f.name in raw})
    except TypeError as exc:
        raise ValueError(f"malformed dispatch intent {kind!r}: {exc}") from exc


def escalation_intent(slot: str):
    """Intent for a slot's cascade-routing escalation re-dispatch (design-concept issue-5381).

    dev_orch re-dispatches as Fresh (self-select); every other slot is None in
    slice 1 (its dispatch still rides prompt_args)."""
    if slot == "dev_orch":
        return Fresh()
    return None


def make_dispatch(
    slot: str,
    skill: str,
    *,
    prompt_args: dict | None = None,
    intent=None,
    reason: str = "",
    worktree_branch: str | None = None,
) -> dict:
    """Construct a `dispatch` action — the ONE writer of the action shape.

    With `intent` (issue #5381) the action carries `intent.to_dict()` and NO
    `prompt_args` key, plus a top-level `anchor` projection when the kind pins
    one (the legacy join field the dashboard/retro views fall back to). Passing
    both `intent` and prompt_args keys outside ESCALATION_META_KEYS raises.

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
    }
    if intent is None:
        action["prompt_args"] = prompt_args or {}
    else:
        extra = set(prompt_args or {}) - ESCALATION_META_KEYS
        if extra:
            raise ValueError(
                "make_dispatch: intent and prompt_args are mutually exclusive "
                f"(unexpected prompt_args keys {sorted(extra)})"
            )
        action["intent"] = intent.to_dict()
        if prompt_args:
            action["prompt_args"] = prompt_args
        anchor = getattr(intent, "anchor", None)
        if anchor:
            action["anchor"] = anchor
    action["reason"] = reason
    if worktree_branch:
        action["worktreeBranch"] = worktree_branch
    return action


def dispatch_intent(action):
    """The action's typed intent, or None when it carries none. Unknown kind raises."""
    raw = action.get("intent") if isinstance(action, dict) else None
    if raw is None:
        return None
    return intent_from_dict(raw)


def _legacy_pa(action) -> dict:
    pa = action.get("prompt_args") if isinstance(action, dict) else None
    return pa if isinstance(pa, dict) else {}


def dispatch_anchor(action):
    """Pinned anchor of a dispatch action (intent field wins, else prompt_args.anchor)."""
    intent = dispatch_intent(action)
    if intent is not None:
        return getattr(intent, "anchor", None)
    return _legacy_pa(action).get("anchor")


def dispatch_resume_branch(action):
    """Stalled-run branch to resume (the prompt_args form requires `resume is True`)."""
    intent = dispatch_intent(action)
    if intent is not None:
        return getattr(intent, "branch", None)
    pa = _legacy_pa(action)
    if pa.get("resume") is not True:
        return None
    return pa.get("resume_branch")


def dispatch_pr(action):
    """PR number a dispatch resumes/fixes (intent `pr` wins, else int `prompt_args.resume_pr`)."""
    intent = dispatch_intent(action)
    if intent is not None:
        return getattr(intent, "pr", None)
    pr = _legacy_pa(action).get("resume_pr")
    if isinstance(pr, bool) or not isinstance(pr, int):
        return None
    return pr


def dispatch_attempt(action) -> int:
    """Escalation attempt number (always prompt_args-borne); non-int -> 1."""
    try:
        return int(_legacy_pa(action).get("attempt") or 1)
    except (TypeError, ValueError):
        return 1


def dispatch_forced(action) -> bool:
    """True iff the dispatch was force-fired (`prompt_args.forced is True`)."""
    return _legacy_pa(action).get("forced") is True


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


# Cap on pinned RED-CI forward-fix dispatches per PR (issue #5058, ex-#4460
# INV-6/8, now provenance-agnostic): a PR the unified resume pick names ONLY
# because a required check is red (its closing issue is NOT `needs-dev-resume`
# — the Turn Snapshot's `orch_prs_red_resume` set) gets at most two
# autopilot-funded attempts before the operator owns it via `surface-pr`. The
# `needs-dev-resume` arm stays uncapped (#4518: the label is its idempotency
# key). In-run state (`state.red_forward_fix_attempts`), NOT persisted to the
# board — a new run re-arms the cap exactly like every other in-run tracker.
RED_FORWARD_FIX_CAP = 2


def _dev_resume_pick_signal(
    state: dict, events: list[dict]
) -> tuple[int, int, str] | None:
    """Parse the `orch_dev_resume_pick` signal (issues #4518, #5058).

    The Turn Snapshot carries it as an `{issue, pr, branch}` pin for the
    lowest-numbered open, non-draft, not-`ready-for-human`, quiescent PR — of
    ANY provenance (GLM, Claude, a future worker lane) — whose single closing
    issue carries `needs-dev-resume` OR that is red on a required check, or no
    pin. The label + the open-PR ledger are the source of truth;
    `state.dev_resume_pending` is only a cache that a Pace Gate relaunch or a
    quota-capped run can lose. Events take precedence over state (the
    `_signal_present` seam). Absent / `none` / malformed fails CLOSED to no
    pin — a bad signal means "no dispatch this turn", never a crash (#4130).

    Pure: reads the passed-in dicts only, no I/O (ADR-0007).
    """
    return _issue_pr_branch_signal(state, events, "orch_dev_resume_pick")


def _parked_issues(state: dict, events: list[dict]) -> set[int]:
    """The `orch_parked_issues` set (issue #5319, ADR-0047 Decision 6): open
    issues carrying the `parked` human-hold label. decide.py's belt filter on
    every PR-keyed dispatch source (defence in depth behind the pr-gate
    collector, and the only guard for sources that bypass it). Absent /
    malformed -> empty set (the collector already failed its own dispatch
    outputs closed on a degraded read). Pure; never calls gh (ADR-0007)."""
    return ts.item_set(state, events, "orch_parked_issues") or set()


def _anchor_issue_number(anchor: object) -> int | None:
    """`issue-N` (or a bare positive int / digit string) -> N, else None."""
    if isinstance(anchor, bool):
        return None
    if isinstance(anchor, int):
        return anchor if anchor > 0 else None
    if not isinstance(anchor, str):
        return None
    text = anchor.strip()
    if text.startswith("issue-"):
        text = text[len("issue-"):]
    return int(text) if text.isdigit() and int(text) > 0 else None


def _parked_prs(state: dict, events: list[dict]) -> set[int]:
    """The `orch_parked_prs` set (issue #5319 QA round 1): open PR numbers whose
    closing issue is parked. PR-keyed, so the in-session `qa-verdict` event
    (which carries only `pr_number`) can be held without a closing-issue field."""
    return ts.item_set(state, events, "orch_parked_prs") or set()


def _parked_read_degraded(state: dict, events: list[dict]) -> bool:
    """True when the collector's parked read was unreadable (INV-4): the empty
    `orch_parked_issues` is then NOT a healthy empty set, so the belt fails
    closed on every dispatch-shaped path."""
    return _signal_present(state, events, "orch_parked_unreadable")


def _is_parked_anchor(state: dict, events: list[dict], anchor: object) -> bool:
    """True when `anchor` names a parked issue (issue #5319). Fails CLOSED
    (True for any well-formed anchor) while the parked read is degraded."""
    number = _anchor_issue_number(anchor)
    if number is None:
        return False
    return _parked_read_degraded(state, events) or number in _parked_issues(state, events)


def _dirty_fix_fail_pr(state: dict, events: list[dict]) -> int | None:
    """The `orch_dirty_forward_fix_fail_pr` signal (issue #5253): the dirty
    pick's PR number iff a QA FAIL is pending at its pre-merge head (the
    two-phase arm), else None. Absent / malformed -> None (conflict-only).
    Pure (ADR-0007)."""
    return ts.pr_number(state, events, "orch_dirty_forward_fix_fail_pr")


def _red_resume_prs(state: dict, events: list[dict]) -> set[int]:
    """The `orch_prs_red_resume` set (issue #5058): resume-pick candidates that
    qualified ONLY through the red-CI arm — the scope of RED_FORWARD_FIX_CAP.
    Absent / malformed -> empty (fail toward the uncapped label arm, never a
    phantom exhausted cap). Pure."""
    return set(ts.pr_numbers(state, events, "orch_prs_red_resume"))


def _target_dev_resume_pick_signal(
    state: dict, events: list[dict]
) -> tuple[int, int, str] | None:
    """Parse the `target_dev_resume_pick` signal (issue #4739, INV-1/INV-5).

    The Turn Snapshot carries it as an `{issue, pr, branch}` pin for the
    lowest-numbered open Target issue labelled `needs-dev-resume` that is the
    single closing issue of an open non-draft Target PR, or no pin
    — the same shape as `orch_dev_resume_pick` (#4518), parsed by
    the same helper. The label + the open-PR ledger are the durable source of
    truth: a Target fix-forward decision (QA FAIL + operator "fix forward on
    PR #N") relabels the issue `needs-dev-resume`, which the #4474 in-flight
    exclusion deliberately does NOT count into `target_ready_for_agent`, so
    without this pin dev_target never dispatches the resume. Absent / `none` /
    malformed fails CLOSED to no pin (same #4130 discipline).

    Pure: reads the passed-in dicts only, no I/O (ADR-0007).
    """
    return _issue_pr_branch_signal(state, events, "target_dev_resume_pick")


def _issue_pr_branch_signal(
    state: dict, events: list[dict], name: str
) -> tuple[int, int, str] | None:
    """Read an `{issue, pr, branch}` pinned-PR signal by name.

    The shared shape of the Turn Snapshot's pre-resolved dev pins:
    `orch_dev_resume_pick` (#4518/#5058), `orch_dirty_forward_fix` (#4807),
    and `target_dev_resume_pick` (#4739). Events take precedence over state (the
    `_signal_present` seam). Absent / "none" / malformed -> None; NEVER
    raises. The Turn Snapshot accessor owns the shapes (the snapshot's
    `{issue, pr, branch}` object, and the packed `issue-<N>:<pr>:<branch>`
    string a signal EVENT carries).
    """
    return ts.pin(state, events, name)


def _red_forward_fix_attempt_count(state: dict, pr_number: int) -> int:
    """Red-CI forward-fix attempts already spent on one PR (issue #5058).

    `state.red_forward_fix_attempts` maps the PR number (string key — JSON
    round-trips collapse int keys) to the count of pinned red-arm dispatches
    the dev_orch selector has already burned on it. Missing map, missing key,
    or a non-int value → 0 (a malformed tracker must never strand a PR by
    masquerading as an exhausted cap).

    Pure: reads the passed-in dict only.
    """
    tracker = state.get("red_forward_fix_attempts")
    if not isinstance(tracker, dict):
        return 0
    try:
        return int(tracker.get(str(pr_number), 0))
    except (TypeError, ValueError):
        return 0


def _orch_anchor_signal(state: dict | None, key: str) -> str | None:
    """Read a Turn Snapshot anchor-ref signal, normalising "absent" spellings.

    The Turn Snapshot emits the orch anchor signals (`orch_pending_grill_anchor`
    and, post-#3711, `orch_dev_ready_anchor`) as a single string that is either
    an `issue-<N>` ref or the literal `"none"` when there is no such anchor —
    including the degraded case where the board read failed. The signal may also
    be omitted from the snapshot entirely by an older autopilot turn.

    All three "no anchor" spellings (absent key, empty string, literal "none")
    collapse to None here so callers branch on one condition instead of
    re-deriving the triple. Anything non-string is also None: a malformed signal
    must never be mistaken for a real anchor ref.

    Pure: reads the passed-in dict only. No I/O (issue #3711 keeps decide.py a
    pure function of (state, events, now)).
    """
    if not isinstance(state, dict):
        return None
    raw = ts.anchor_ref(state, key)
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw or raw == "none":
        return None
    return raw


def _needs_qa_target_pr_ref(state: dict, events: list[dict]) -> str | None:
    """Read the current turn's pre-resolved Target QA PR ref (issue #4576).

    The Turn Snapshot carries `target_needs_qa_pr_ref` as a fresh per-turn
    fact (the html_url of the open Target PR that closes the first open
    needs-qa Target issue, or an empty string when none resolves) on
    `state.turn_snapshot.signals`, read through the accessor like
    `needs_qa_numbers` / `target_needs_triage_items`. Event value preferred
    over the snapshot, the same lookup order as
    `_triage_item_set`. Returns `None` when the signal is ABSENT or EMPTY —
    the fail-open sentinel: the qa_target dispatch still fires, and
    hydra-target-qa's own step 1 resolves the PR when `pr_ref` is absent
    (#4576 INV-5 — an unreadable pre-resolution never dead-arms the class,
    the #3709 defect class).

    Pure: no side effects.
    """
    return ts.text(state, events, "target_needs_qa_pr_ref")


def _needs_qa_target_pr_head(state: dict, events: list[dict]) -> str | None:
    """Read the current turn's pre-resolved Target QA PR head ref (issue #4653).

    Same string signal, and the SAME event-preferred-over-snapshot lookup
    order, as `_needs_qa_target_pr_ref` above: the `head.ref` of the SAME PR
    whose `html_url` is `target_needs_qa_pr_ref`. Returns `None` when ABSENT or
    EMPTY. Moved here from decide.py (issue #5383) so the qa selector can put
    it in the TargetReviewPr intent.

    Pure: no side effects.
    """
    return ts.text(state, events, "target_needs_qa_pr_head")


def _signal_present(state: dict, events: list[dict], signal: str) -> bool:
    """Look up a board/event signal by name. Events take precedence over state
    (the Turn Snapshot accessor reads whichever snapshot form is present)."""
    return ts.signal_present(state, events, signal)


def _orch_board_read_degraded(state: dict, events: list[dict] | None = None) -> bool:
    """True when the Turn Snapshot flagged the orch board read as degraded (issue #4130).

    The Turn Snapshot sets `orch_board_signals_degraded` true when ANY of the
    orch-lane GitHub board reads that this loop's idle conclusion depends on
    failed (the board-counts read, the grill/dev-ready candidate enumeration,
    or the backfill-idle board read). A genuinely empty board emits `false` —
    the flag distinguishes "the read failed" from "the board is empty", which
    the zero/none-rendering of a failed read never could (the GraphQL-only
    503 outage of 2026-08-17 drained a run to a clean `terminate:idle` with 15
    eligible issues on the board). decide.py stays pure: it reads the
    pre-resolved flag, exactly like every other Turn-Snapshot-owned signal.
    """
    return _signal_present(state, events or [], "orch_board_signals_degraded")


def _orch_backfill_idle_present(state: dict, events: list[dict]) -> bool:
    """`orch_backfill_idle`, suppressed on a degraded orch board read (issue #4130).

    The board-empty conjunction must never be satisfied by failed reads
    rendering as zeros: a degraded snapshot that happens to carry a stale
    `orch_backfill_idle=true` (or a Turn Snapshot emission bug) must not fire
    discover/architecture/cleanup/skill-prune backfill against a board that
    may actually be full. Belt-and-braces on top of the Turn Snapshot's own
    fail-closed emission (`orch_backfill_idle=false` on a failed read).
    """
    return _signal_present(state, events, "orch_backfill_idle") and not _orch_board_read_degraded(
        state, events
    )


def _zero_yield_entry(state: dict, cls: str) -> dict:
    """`cls`'s zero-yield back-off entry, degrading to the streak-0 identity
    (issue #4999, INV-9).

    Any malformed shape — a non-map `zero_yield_backoff`, a non-map entry, or
    a non-int `streak` / `last_fired` (bools are ints in Python, hence the
    explicit exclusion) — reads as `{"streak": 0, "last_fired": 0}`, exactly
    the absent-entry behaviour: streak 0 means "no back-off", so a corrupt
    state file can never wedge the class dark.
    """
    container = state.get("zero_yield_backoff")
    entry = container.get(cls) if isinstance(container, dict) else None
    if not isinstance(entry, dict):
        return {"streak": 0, "last_fired": 0}
    streak = entry.get("streak")
    last_fired = entry.get("last_fired")
    for v in (streak, last_fired):
        if not isinstance(v, int) or isinstance(v, bool):
            return {"streak": 0, "last_fired": 0}
    return {"streak": streak, "last_fired": last_fired}


def _stamp_zero_yield(state: dict, cls: str, now: int) -> None:
    """Bump `cls`'s zero-yield streak + last_fired at plan time (INV-4, #4999).

    The same sanctioned in-selector state mutation as `_stamp_triage_items`
    (#3729) / `_research_force_stamp` (#1666); main() persists a changed
    `zero_yield_backoff` via the snapshot-before/compare-after writeback.
    Called ONLY from the selector, on the exact line it returns a dispatch —
    nothing else increments.

    Known, accepted semantics: this is a PLAN-time stamp (the #3729 pattern),
    so a planned dispatch that a LATER gate drops or whose launch fails still
    counts as one fire on the ladder. That errs toward fewer idle-board
    dispatches and is bounded by the 24h never-dark floor (INV-2), so it can
    never wedge the class dark."""
    entry = _zero_yield_entry(state, cls)
    stamped = dict(state.get("zero_yield_backoff") or {}) \
        if isinstance(state.get("zero_yield_backoff"), dict) else {}
    stamped[cls] = {"streak": entry["streak"] + 1, "last_fired": now}
    state["zero_yield_backoff"] = stamped
