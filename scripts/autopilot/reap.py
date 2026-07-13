#!/usr/bin/env python3
"""
reap.py — Phase 2 of /hydra-autopilot.

FALLBACK PATH (issue #509)
--------------------------
As of issue #509, primary slot accounting is hook-driven: Claude Code's
`SubagentStop` hook XADDs `subagent_stop` events onto the Redis stream
`hydra:autopilot:slot-events`, which `collect-state.sh` surfaces as
`state.slot_events` and `decide.py` consumes to free slots automatically.

This CLI survives as the FALLBACK path. Use it only when a slot is
provably silent-wedged — no `SubagentStop` event has arrived within
`subagent_max_wall_seconds` (default 3600s, env override
`HYDRA_AUTOPILOT_SUBAGENT_MAX_WALL_SECONDS`). `decide.py` emits a
`wait_or_reap` action for exactly that case; the harness translates
that into a `reap.py completion ...` invocation here.

The default-mode (no-subcommand) hard-cap sweep remains useful for
runaway-token detection (`partial_tokens >= subagent_hard_max_tokens`)
because hooks don't fire for in-flight token cap trips.

Two modes:

  (default)   — In-flight hard-cap enforcement (issue #395).
                For each occupied class slot in state.json whose harness
                exposed a `partial_tokens >= limits.subagent_hard_max_tokens`,
                abandon the slot, mark the class burned, and file a
                `needs-triage` runaway issue. Idempotent.

  completion  — Idempotent completion reap (issue #411).
                Records the dispatched subagent's final token count once
                per task ID. If the same TaskNotification fires twice
                (observed: task `a153eb193e1b05209` fired 3 completion
                notifications for hydra-qa on PR #402), only the FIRST
                call mutates `cumulative_tokens` / `slots[<class>].tokens`
                / `burned_classes`. Subsequent calls with the same
                `task_id` emit `dup_skip task_id=<X>` to the run log and
                exit 0 without any token accounting.

The `reaped_task_ids` array on state.json is the dedup ledger. It is
bounded to the most-recent 1000 IDs (FIFO) to keep state.json bounded
across long autopilot sessions. Older state.json files that lack the
field are tolerated: missing field defaults to `[]`.

State writes happen in place to /tmp/hydra-autopilot-state.json (override
via HYDRA_AUTOPILOT_STATE). Run-log writes go to
/tmp/hydra-autopilot-nightly.log (override via HYDRA_AUTOPILOT_LOG).

Exit code is always 0 — failure to file a GitHub issue is logged but
not fatal.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))
LOG_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_LOG", "/tmp/hydra-autopilot-nightly.log"))
REPO = os.environ.get("HYDRA_AUTOPILOT_REPO", "gaberoo322/hydra")
HYDRA_API_BASE = os.environ.get("HYDRA_API_BASE", "http://localhost:4000")

REAPED_TASK_IDS_CAP = 1000

# Issue #2715 — Redis mirror of the cross-run cooldown subset.
#
# /tmp/hydra-autopilot-state.json is boot-wiped, so `signal_last_fired` /
# `research_force_counter` are lost on host reboot and the long-cooldown classes
# reset to epoch 0 (a per-reboot recurrence of the #2575 churn). Redis survives
# reboot (AOF + docker volume), so reap mirrors the cross-run subset to Redis on
# EVERY completion — the reliable executor-side "a class fired" seam (reap runs on
# every terminal dispatch, including signal-class completions). bootstrap.sh reads
# these keys back as a seed tier behind the prior file (prior-file → Redis → 0).
#
# The bash→Redis seam is `docker exec hydra-redis-1 redis-cli` — the exact pattern
# collect-state.sh uses — not a typed accessor / HTTP route (design-concept #2715).
# `HYDRA_AUTOPILOT_REDIS_CLI` overrides the argv prefix so tests inject a stub and
# exercise the mirror hermetically. Every write is best-effort / fail-open: any
# error logs to stderr and NEVER aborts the reap (design-concept #2715 Invariant 5).
REDIS_SIGNAL_LAST_FIRED_KEY = "hydra:autopilot:signal-last-fired"
REDIS_RESEARCH_FORCE_KEY = "hydra:autopilot:research-force-counter"

# Issue #1136 (Slice 2 of #1119): directory the code-writing dispatch deposits
# its planning-time reflection-bucket string into, keyed by task_id, so reap can
# forward it on the SINGLE authoritative cycle-record write. Overridable via
# HYDRA_AUTOPILOT_REFL_DIR (mirrors the path the dispatch skills write to).
REFL_SOURCES_DIR = Path(os.environ.get("HYDRA_AUTOPILOT_REFL_DIR", "/tmp"))

# Code-writing skills whose completions trip a cycle-record write
# (issue #430). QA, research, and discover dispatches are subagent work but
# don't fit the "cycle" semantic — a cycle here is one autopilot turn that
# dispatched a code-writing class (ADR-0006). Sweeping/research dispatches
# stay observable via the run log and the existing capacity writeback.
#
# Issue #466 (Phase B of #437) adds `hydra-grill` to this set. Grilling is
# not code-writing, but it IS the artifact-producing predecessor to a
# code-writing dispatch, and recording its outcome (completed / failed /
# timed-out) is what feeds the counters consumed by B-4's dashboard:
# `hydra:dc:grill_timeout_count`, `hydra:dc:grill_crash_count`,
# `hydra:dc:artifact_warn_count`. The cycle-record write itself is
# idempotent on cycleId (the autopilot task_id), so retries from
# self_heal.py double-write safely. Per the issue's retry policy,
# warn-only artifacts (case 2) are NOT retried — reap.py records the
# completion outcome; the counters are incremented by saveDesignConcept()
# / grill-artifact.sh at write time.
CYCLE_RECORD_SKILLS = {"hydra-dev", "hydra-target-build", "hydra-grill"}
CYCLE_RECORD_SCRIPT = Path(__file__).parent / "dispatch.sh"

# Issue #2450: subset of CYCLE_RECORD_SKILLS that actually run the planning-time
# reflection-source deposit recipe. hydra-grill writes a design-concept artifact,
# not a reflection-source deposit, so it is NOT in this set — adding it would
# produce a false-positive WARN on every grill completion.
REFLECTION_DEPOSIT_SKILLS: frozenset[str] = frozenset({"hydra-dev", "hydra-target-build"})

# Worktree-orphan GC trigger (issue #911).
#
# Every code-writing / QA dispatch runs inside a `git worktree`, but the
# worktree is created and named by the Claude harness (`Agent(isolation:
# "worktree")`), NOT by dispatch.sh — so reap.py never learns the worktree
# path and cannot tear it down by path. The structural fix is the age+liveness
# worktree-orphan GC in `scripts/ci/branch-prune.ts`, driven by
# `scripts/branch-prune.sh`. That sweep reclaims a worktree on its OWN safety
# rails (dead lock PID, not an open-PR head, past the age floor) regardless of
# HOW it leaked — so it covers clean reaps AND crash-leaks (#898) uniformly.
#
# Rather than duplicate those rails here, a completion reap fires the same
# sweep in --apply mode as a best-effort post-step, so a just-freed worktree is
# reclaimed at reap time instead of waiting for the next daily timer. It is
# fully non-fatal: a missing script, a non-zero exit, or a timeout is logged
# and swallowed — exactly like `_fire_cycle_record`. Skipped entirely unless
# the dispatch was a worktree-bearing class, and suppressible via
# HYDRA_REAP_WORKTREE_GC=0 for operators who prefer the timer alone.
WORKTREE_GC_SKILLS = {"hydra-dev", "hydra-target-build", "hydra-qa"}
WORKTREE_GC_SCRIPT = Path(__file__).resolve().parents[1] / "branch-prune.sh"

def _append_log(line: str) -> None:
    """Append one line to the run log, best-effort. Never raises."""
    try:
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(line.rstrip("\n") + "\n")
    except OSError as exc:
        # Log failure is non-fatal — the model still sees stdout.
        print(f"[autopilot] reap: log append failed: {exc}", file=sys.stderr)


def _load_state() -> dict | None:
    if not STATE_PATH.exists():
        print(f"[autopilot] reap: state file missing at {STATE_PATH}; skipping", file=sys.stderr)
        return None
    return json.loads(STATE_PATH.read_text())


def _save_state(s: dict) -> None:
    STATE_PATH.write_text(json.dumps(s))


def _redis_cli(*args: str) -> None:
    """Run one redis-cli command best-effort (issue #2715). Never raises.

    Mirrors the docker-exec redis-cli seam collect-state.sh uses. The argv prefix
    is `docker exec hydra-redis-1 redis-cli` unless HYDRA_AUTOPILOT_REDIS_CLI
    overrides it (whitespace-split — a trusted test/override prefix, e.g.
    `redis-cli -h 127.0.0.1 -p 6390`, or a stub recorder). Any failure (redis
    down, docker absent, timeout) is logged to stderr and swallowed: the state
    file is already the source of truth, so a missed mirror only costs one extra
    post-reboot fire, never a crash.
    """
    override = os.environ.get("HYDRA_AUTOPILOT_REDIS_CLI", "").strip()
    if override:
        cmd = [*override.split(), *args]
    else:
        cmd = ["docker", "exec", "hydra-redis-1", "redis-cli", *args]
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
            f"[autopilot] reap: redis mirror {args[:2]} failed ({exc}); "
            "state.json remains source of truth",
            file=sys.stderr,
        )


def _mirror_cross_run_state_to_redis(s: dict) -> None:
    """Mirror the cross-run durable subset of state to Redis (issue #2715).

    ONLY the reboot-survival subset is mirrored — `signal_last_fired` (the 10
    signal classes) and `research_force_counter`. Run-scoped fields
    (pid/turn/dispatches/slots/idle_turns/burned_classes) are NEVER mirrored:
    they legitimately die with the run and the concurrent-run PID guard + #1352
    slot re-seeding DEPEND on them resetting (design-concept #2715 Invariant 4).

    Called after `_save_state` in `run_completion`, so a Redis hiccup can never
    lose the local write. Best-effort throughout — no exception escapes.
    """
    try:
        slf = s.get("signal_last_fired")
        if isinstance(slf, dict) and slf:
            # HSET the hash field-by-field; each value is an epoch int (or 0).
            # Skip non-int-coercible values rather than corrupting the field.
            hset_args: list[str] = ["HSET", REDIS_SIGNAL_LAST_FIRED_KEY]
            for cls, ts in slf.items():
                try:
                    hset_args.extend([str(cls), str(int(ts))])
                except (TypeError, ValueError):
                    continue
            # Only issue the HSET when at least one field pair was collected.
            if len(hset_args) > 2:
                _redis_cli(*hset_args)

        rfc = s.get("research_force_counter")
        if isinstance(rfc, dict):
            # Store as one canonical-JSON string (a date-keyed nested object) so
            # bootstrap can prune it to today's key on read, mirroring the
            # prior-file path. An empty {} is still written — it faithfully
            # records "no forced-research today" and never resurrects a stale day.
            _redis_cli(
                "SET",
                REDIS_RESEARCH_FORCE_KEY,
                json.dumps(rfc, sort_keys=True),
            )
    except Exception as exc:  # pragma: no cover - defensive belt-and-braces
        # The subset mirror is a pure best-effort side-effect; never let it
        # bubble up and abort a reap that already persisted state locally.
        print(
            f"[autopilot] reap: cross-run redis mirror failed ({exc}); "
            "state.json remains source of truth",
            file=sys.stderr,
        )


def _ensure_reaped_list(s: dict) -> list[str]:
    """Read `reaped_task_ids` from state, defaulting to []. Tolerates older
    state.json files written before issue #411 that lack the field."""
    ids = s.get("reaped_task_ids")
    if not isinstance(ids, list):
        ids = []
        s["reaped_task_ids"] = ids
    return ids


def _bound_reaped(ids: list[str]) -> list[str]:
    """FIFO-bound the dedup ledger to the most-recent 1000 entries."""
    if len(ids) > REAPED_TASK_IDS_CAP:
        return ids[-REAPED_TASK_IDS_CAP:]
    return ids


# Issue #2020: a reflection-deposit presence diagnostic. `_read_reflection_sources`
# returns one of these alongside the (possibly empty) bucket string so the reap
# log can distinguish an HONEST 'none' (the dispatch served no reflections, so it
# correctly wrote no deposit) from a FALSE 'none' (a deposit was attempted but is
# unreadable / landed empty / under the wrong key). Without this signal both
# collapse to the same empty string, and an operator cannot tell "nothing to
# learn from" apart from "the deposit dropped" (the #1945-shaped hazard the issue
# names) without manually reproducing the Redis/fs scan.
#
#   no-task-id     — no task_id to key on; cannot even look (degrades to 'none').
#   deposit-absent — no deposit file exists. The COMMON honest case: most
#                    dispatches serve no reflections so they write nothing, and
#                    the cycle truthfully buckets to 'none'.
#   deposit-empty  — the deposit file exists but is empty/whitespace. Ambiguous:
#                    the dispatch ran the deposit step but had nothing to write
#                    (still honest 'none'); surfaced distinctly so a future
#                    false-empty deposit bug is visible rather than silent.
#   deposit-present — the deposit file exists and carries a non-empty bucket
#                    string (a genuinely non-'none' cycle).
#   read-error     — the deposit file exists but could not be read (a FALSE
#                    'none' candidate worth an operator's eye).
REFL_PRESENCE_NO_TASK_ID = "no-task-id"
REFL_PRESENCE_ABSENT = "deposit-absent"
REFL_PRESENCE_EMPTY = "deposit-empty"
REFL_PRESENCE_PRESENT = "deposit-present"
REFL_PRESENCE_READ_ERROR = "read-error"


def _read_reflection_sources(task_id: str) -> tuple[str, str]:
    """Read the planning-time reflection-bucket deposit for `task_id` (issue #1136).

    The code-writing dispatch (hydra-dev / hydra-target-build) is the ONLY actor
    that knows what `GET /api/reflections` served it at planning time — reap runs
    after the subagent exits and has no access to that. So the dispatch deposits
    the MAPPED, comma-separated bucket tokens (`per-anchor` / `by-file` / ...)
    to a task-scoped file, and reap reads it here to forward as the cycle metric
    (Slice 2 of #1119). This keeps reap the SOLE cycle-record writer (no race
    with a competing skill-side POST) while still stamping what was injected.

    Deterministic path: ${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-sources-<task_id>.
    Best-effort and fully non-fatal: a missing file (the common case — most
    dispatches serve no reflections), an empty file, or any read error all
    yield "" so the cycle truthfully buckets to 'none'. Never blocks the reap.

    Issue #2020: returns `(sources, presence)`. `sources` is the bucket string
    (unchanged contract — empty on miss, so the cycle-record POST body shape and
    its truthful-'none' behaviour are preserved). `presence` is one of the
    `REFL_PRESENCE_*` diagnostic tokens above so the caller can log an
    honest-none-vs-false-none signal WITHOUT changing what is forwarded to
    cycle-record.
    """
    if not task_id:
        return "", REFL_PRESENCE_NO_TASK_ID
    try:
        path = REFL_SOURCES_DIR / f"hydra-refl-sources-{task_id}"
        if not path.exists():
            return "", REFL_PRESENCE_ABSENT
        sources = path.read_text(encoding="utf-8").strip()
        if not sources:
            return "", REFL_PRESENCE_EMPTY
        return sources, REFL_PRESENCE_PRESENT
    except OSError as exc:
        _append_log(f"refl_sources_read_skipped task_id={task_id} err={exc}")
        return "", REFL_PRESENCE_READ_ERROR


def _read_anchor_deposit(task_id: str) -> str | None:
    """Read the planning-time anchor deposit for `task_id` (issue #2112).

    The reflection PRODUCER (`_fire_reflection_for_completion` →
    `recordAnchorReflection`) keys every per-anchor reflection on the cycle's
    anchor reference (e.g. "issue-2112"). reap previously recovered that anchor
    ONLY from `slot["anchor"]`, but the dispatch harness never stamps an
    `anchor` field on the slot (the live slot carries only
    `task_id`/`skill`/`started_epoch`/`branch`), and for `dev_orch` the dispatch
    action carries no anchor in `prompt_args` at all (the #458 contract). So
    `slot.get("anchor")` was `None` on 100% of cycles, `_fire_reflection_for_completion`
    early-returned on its `if not anchor_ref` guard, and the per-anchor
    reflection store stayed structurally empty — the dead-producer bug #2112
    names (the #1119 fix wired the chain but left this final link severed).

    The code-writing dispatch (hydra-dev / hydra-target-build) is the only actor
    that reliably knows the per-cycle anchor, so — exactly like the
    reflection-source deposit (`_read_reflection_sources`) — it deposits the
    anchor reference to a task-scoped file at planning time and reap reads it
    here. Same directory + task_id keying as the reflection-source deposit, so
    the two travel together.

    Deterministic path: ${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-anchor-<task_id>.
    Best-effort and fully non-fatal: a missing file, an empty file, or any read
    error all yield None so the caller falls back to `slot.get("anchor")` and,
    failing that, degrades to the prior no-op. Never blocks the reap.
    """
    if not task_id:
        return None
    try:
        path = REFL_SOURCES_DIR / f"hydra-refl-anchor-{task_id}"
        if not path.exists():
            return None
        anchor = path.read_text(encoding="utf-8").strip()
        return anchor or None
    except OSError as exc:
        _append_log(f"refl_anchor_read_skipped task_id={task_id} err={exc}")
        return None


def _read_grounding_tests(task_id: str) -> dict[str, int]:
    """Read the grounding test-count deposit for `task_id` (issue #2754).

    `testsAfter` was recorded as 0 on every cycle because reap — the SOLE
    cycle-record writer — never carried a test count: the orchestrator service
    doesn't run the suite, and the numbers exist only inside the code-writing
    dispatch's grounding pass. So, exactly like the reflection-source deposit
    (`_read_reflection_sources`), the dispatch deposits its parsed grounding
    counts to a task-scoped JSON file and reap reads them here to forward on the
    single cycle-record write.

    Deterministic path: ${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-grounding-tests-<task_id>
    (same dir + task_id keying as the reflection deposit, so they travel together).
    Expected JSON shape (any subset; each key optional):
        {"testsBefore": N, "testsAfter": N,
         "testsPassingBefore": N, "testsPassingAfter": N}

    Returns a dict of the non-negative-integer values it could read. Best-effort
    and fully non-fatal: a missing file (the common case for non-grounding
    classes), an empty/garbage file, or any read/parse error all yield {} so the
    cycle-record body simply omits the fields (truthful "unknown/never-written").
    Never blocks the reap.
    """
    if not task_id:
        return {}
    try:
        path = REFL_SOURCES_DIR / f"hydra-grounding-tests-{task_id}"
        if not path.exists():
            return {}
        raw = path.read_text(encoding="utf-8").strip()
        if not raw:
            return {}
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            return {}
        out: dict[str, int] = {}
        for key in (
            "testsBefore",
            "testsAfter",
            "testsPassingBefore",
            "testsPassingAfter",
        ):
            val = parsed.get(key)
            if isinstance(val, bool):
                continue  # bool is an int subclass — reject it explicitly
            if isinstance(val, int) and val >= 0:
                out[key] = val
            elif isinstance(val, (str, float)):
                try:
                    n = int(val)
                    if n >= 0:
                        out[key] = n
                except (TypeError, ValueError):
                    pass
        return out
    except (OSError, ValueError, TypeError) as exc:
        _append_log(f"grounding_tests_read_skipped task_id={task_id} err={exc}")
        return {}


def _read_escalation_deposit(task_id: str) -> str:
    """Read the cascade-routing escalation deposit for `task_id` (issue #3284).

    A dispatch that decide.py's `_rule_escalation` re-dispatched at a stronger
    model is the only actor that knows its own escalation provenance (decide.py
    surfaced `escalate_model` / `attempt` as prompt_args; the harness stamps a
    task-scoped deposit at dispatch time). Exactly like the grounding-tests
    deposit (`_read_grounding_tests`), the escalated dispatch deposits a compact
    JSON blob and reap reads it here to forward on the single cycle-record write
    so the durable per-dispatch outcome record (#2942) tags the escalated
    attempt. That marker lets /metrics/cascade-routing derive cost-delta from the
    dispatch's ACTUAL recorded tokens (design-concept invariant 7) and report
    postEscalationMergeRate (invariant 8) — no static token estimator.

    Deterministic path: ${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-escalation-<task_id>
    (same dir + task_id keying as the other deposits, so they travel together).
    Expected JSON shape (any subset): {"escalationAttempt": N, "escalatedModel": "sonnet"}.

    Returns the RAW deposit string verbatim (dispatch.sh does the JSON parse +
    field validation), or "" when the file is absent/empty/unreadable — the
    overwhelming non-escalation majority. Best-effort and fully non-fatal: never
    blocks the reap.
    """
    if not task_id:
        return ""
    try:
        path = REFL_SOURCES_DIR / f"hydra-escalation-{task_id}"
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        _append_log(f"escalation_read_skipped task_id={task_id} err={exc}")
        return ""


def _slot_started_epoch(slot: dict | None) -> int | None:
    """Best-effort dispatch-start epoch (seconds) for an occupied pipeline slot.

    Issue #1591: the per-slot `started_epoch` / `started` (ISO8601) field is
    stamped by the dispatch harness when a code-writing class is dispatched —
    it is the documented slot contract (see `decide.py`'s state docstring and
    the wall-clock watchdog at `decide.py::_reap_stale_claims`). reap reads it
    to compute the cycle's wall-clock duration so the `totalDurationMs` cycle
    metric is non-zero for BOTH orchestrator (`hydra-dev`) AND target/betting
    (`hydra-target-build`) cycles — previously reap hardcoded `0`, so every
    target cycle dropped its duration (the 46% dropout in #1591); only the
    model-fired auto-merge follow-up (orchestrator-only in practice) ever
    populated a non-zero value.

    Mirrors `decide.py`'s defensive read EXACTLY: prefer the int
    `started_epoch`, fall back to parsing a legacy `started` ISO8601 string,
    tolerate anything unparseable by returning None (the caller then records a
    0 duration → dispatch.sh's 0-default applies, the correct truthful
    fallback).
    """
    if not isinstance(slot, dict):
        return None
    started_epoch = slot.get("started_epoch")
    if started_epoch is None:
        started_iso = slot.get("started")
        if isinstance(started_iso, str):
            try:
                from datetime import datetime

                started_epoch = int(
                    datetime.fromisoformat(started_iso.replace("Z", "+00:00")).timestamp()
                )
            except (ValueError, TypeError):
                started_epoch = None
    try:
        return int(started_epoch) if started_epoch is not None else None
    except (TypeError, ValueError):
        return None


def _compute_duration_ms(slot: dict | None) -> int:
    """Wall-clock cycle duration in ms from a slot's start stamp (issue #1591).

    Returns 0 when the start stamp is missing/unparseable or the computed span
    is negative (clock skew) — 0 is the truthful "unknown" sentinel, identical
    to the pre-#1591 hardcoded fallback, so the metric never goes backwards.
    """
    started_epoch = _slot_started_epoch(slot)
    if started_epoch is None:
        # Issue #2364: a missing start stamp records a truthful 0, but on a
        # code-writing completion that 0 is the false-zero the issue tracks
        # (the slot was occupied but its `started_epoch` was lost), so surface
        # it on the run log rather than swallowing it silently. The downstream
        # cycle-record write is monotonic on duration (src/metrics/record.ts), so
        # a later non-zero follow-up still upgrades this — but the log makes a
        # persistent 0 attributable to "no start stamp" vs "clobbered".
        _append_log("compute_duration_missing_start_stamp")
        return 0
    import time

    duration_ms = int(time.time() * 1000) - started_epoch * 1000
    return duration_ms if duration_ms > 0 else 0


def _fire_cycle_record(
    task_id: str,
    skill: str | None,
    status: str,
    total_tokens: int,
    reflection_sources: str = "",
    duration_ms: int = 0,
    task_title: str = "",
    anchor_ref: str = "",
    grounding_tests: dict[str, int] | None = None,
    worktree_branch: str = "",
    escalation: str = "",
) -> None:
    """Best-effort POST to /api/autopilot/cycle-record (issue #430).

    Only fires for code-writing dispatches (hydra-dev / hydra-target-build) —
    that's the post-PR-3 definition of an autopilot "cycle". Failures are
    swallowed: cycle-record writes are observability, not correctness, and
    must never block the reap path. The cycle-record endpoint is itself
    idempotent on cycleId, so retries are safe.

    The cycleId we send is the autopilot task_id, which the harness allocates
    once per dispatch — that gives natural dedup across retries.

    `reflection_sources` (issue #1136): the comma-separated reflection bucket
    tokens the dispatch served itself at planning time, forwarded as the 8th
    positional `cycle-record` arg so the metric records what was injected.
    Empty (the default + the common no-reflections case) → dispatch.sh omits
    the field from the POST body → truthful 'none'.

    `duration_ms` (issue #1591): the cycle's wall-clock span in ms, computed by
    the caller from the slot's dispatch-start stamp (`_compute_duration_ms`).
    Forwarded as the 7th positional `cycle-record` arg so `totalDurationMs` is
    non-zero for target/betting cycles too — not just orchestrator cycles that
    happened to get a model-fired auto-merge follow-up. 0 (the default) keeps
    the prior truthful "unknown" behaviour when no start stamp is available.

    `grounding_tests` (issue #2754): the code-writing dispatch's grounding
    test-suite counts (`testsBefore`/`testsAfter`/`testsPassingBefore`/
    `testsPassingAfter`), read from a task-scoped deposit by
    `_read_grounding_tests`. Forwarded as the 10th positional `cycle-record` arg
    — a compact JSON object (or "" when the deposit was absent) — so `testsAfter`
    stops recording 0 on every cycle. dispatch.sh merges the parsed integers into
    the POST body; an empty/absent value omits all four fields (truthful
    "unknown"), an explicit 0 records a measured zero-test cycle.

    `total_tokens` (issue #2942): reap's authoritative per-dispatch token
    figure (already a parameter here since #430, previously unforwarded).
    Passed as the 11th positional `cycle-record` arg so the durable
    per-dispatch outcome record (`recordCycle` →
    `src/redis/dispatch-outcomes.ts`) carries a cost figure. dispatch.sh
    emits it only when POSITIVE — 0 means "no usage parsed" (unknown), and
    recordCycle then falls back to the per-cycle token hash before recording
    a truthful null.

    `task_title` / `anchor_ref` (issue #2012): the per-cycle anchor reference
    recovered from the slot before it was nulled (e.g. "issue-2012"). reap is
    the SOLE cycle-record writer, but it previously hardcoded both to "" — so
    a successful hydra-dev / hydra-grill merge stored `taskTitle == null`,
    which naive no-task counters (the #1832 hydra-discover false alarm)
    mistook for a no-op cycle. Forwarding the resolvable anchor as `task_title`
    (positional 5) and `anchor_ref` (positional 6) closes that metadata gap.
    Both default to "" — dispatch.sh omits an empty field, so a genuinely
    task-less dispatch stays null (the correct truthful behaviour).

    `worktree_branch` (issue #3252): the slot's synthesised worktree branch
    (`worktree-agent-<runToken>-t<N>-<slot>`). Forwarded as the 12th positional
    `cycle-record` arg so `recordCycleMetrics` can mirror the grounding test
    counts (which arrive keyed on THIS write's bare worktree-hash cycleId) onto
    the SEPARATE branch-keyed record the merge-watch enrichment + dashboards
    read — the two keys are otherwise un-joinable, so `testsAfter` recorded 0 on
    the sampled record every cycle. Empty (signal class / cleared slot) →
    dispatch.sh omits the field → no mirror (the prior behaviour).

    `escalation` (issue #3284): the raw cascade-routing escalation-provenance
    deposit blob ({"escalationAttempt":N,"escalatedModel":"sonnet"}) read by
    `_read_escalation_deposit`, present ONLY on a dispatch decide.py escalated to
    a stronger model. Forwarded as the 13th positional `cycle-record` arg so the
    durable per-dispatch outcome record (#2942) tags the escalated attempt —
    letting /metrics/cascade-routing derive cost-delta from ACTUAL recorded
    tokens (invariant 7) and report postEscalationMergeRate (invariant 8). Empty
    (the non-escalation majority) → dispatch.sh omits both fields (truthful null).

    Cycle-record fire gate (issue #3284): normally only CYCLE_RECORD_SKILLS
    (code-writing classes) trip a cycle-record write. But the ONLY class that
    cascade-escalates today is `cleanup_orch` (skill `hydra-cleanup`), a SIGNAL
    class NOT in CYCLE_RECORD_SKILLS — so without an escalation-scoped exception,
    an escalated cleanup dispatch would deposit its provenance, reap would read
    it, and then `_fire_cycle_record` would early-return and DISCARD it, leaving
    the outcome record (and thus the whole cascade rollup, which filters on a
    non-null `escalationAttempt`) permanently empty. So when a non-empty
    `escalation` blob is present we STILL fire the cycle-record write even for a
    non-CYCLE_RECORD skill — the escalated attempt's durable outcome record is
    exactly what the cascade metrics need. Non-escalated signal completions are
    unaffected (empty escalation → the original CYCLE_RECORD_SKILLS-only gate).
    """
    if not CYCLE_RECORD_SCRIPT.exists():
        return
    # Fire for code-writing classes (the #430 semantic) OR whenever a cascade
    # escalation provenance blob rode in (issue #3284) — the escalating class
    # (`cleanup_orch`/`hydra-cleanup`) is a signal class outside
    # CYCLE_RECORD_SKILLS, so gating purely on the skill would silently drop the
    # escalated attempt's outcome record and structurally zero the cascade fold.
    if not skill:
        return
    if skill not in CYCLE_RECORD_SKILLS and not escalation:
        return
    try:
        subprocess.run(
            [
                "bash",
                str(CYCLE_RECORD_SCRIPT),
                "cycle-record",
                task_id,
                status,
                skill,
                "",  # pr_number — not known at reap time; capacity-writeback
                     # carries the PR number on the merged path.
                task_title or "",  # issue #2012: resolvable anchor as task title
                anchor_ref or "",  # issue #2012: per-cycle anchor reference
                str(duration_ms or 0),  # issue #1591: wall-clock cycle span (ms)
                reflection_sources or "",  # issue #1136: served reflection buckets
                "",  # files_changed — not known at reap time (merged-path enrich)
                json.dumps(grounding_tests) if grounding_tests else "",  # issue #2754
                # Issue #2942: forward reap's authoritative total_tokens as the
                # 11th positional so the durable per-dispatch outcome record
                # carries a cost figure. dispatch.sh only emits a POSITIVE
                # integer (0 = "no usage parsed" = unknown, omitted so
                # recordCycle's per-cycle-token-hash fallback gets its chance).
                str(total_tokens or 0),
                # Issue #3252: the synthesised worktree branch as the 12th
                # positional so recordCycleMetrics mirrors the grounding test
                # counts onto the branch-keyed record dashboards read. Empty →
                # dispatch.sh omits it → no mirror.
                worktree_branch or "",
                # Issue #3284: the cascade-routing escalation provenance blob as
                # the 13th positional so the durable outcome record tags the
                # escalated attempt. Empty (non-escalation majority) →
                # dispatch.sh omits both fields (truthful null).
                escalation or "",
            ],
            check=False,
            capture_output=True,
            timeout=10,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        _append_log(f"cycle_record_skipped task_id={task_id} err={exc}")


def _fire_worktree_gc(skill: str | None) -> None:
    """Best-effort worktree-orphan GC after a worktree-bearing completion (issue #911).

    Fires `scripts/branch-prune.sh --apply`, which classifies + reclaims
    local-only orphan worktrees on the age+liveness rails in
    `scripts/ci/branch-prune.ts`. This shortens the lag between a dispatch
    reaping and its worktree being reclaimed (otherwise the daily systemd timer
    is the only sweep). The script carries ALL the safety rails — it refuses to
    run from inside a worktree, never touches a live-PID worktree, never deletes
    the current branch, and caps deletions per run — so reap.py does not
    re-implement any of them.

    Strictly best-effort and non-fatal, matching `_fire_cycle_record`:
      - Skipped unless the dispatch was a worktree-bearing class.
      - Skipped if HYDRA_REAP_WORKTREE_GC=0 (operator opt-out; timer still runs).
      - Skipped if the script is missing.
      - A non-zero exit, a timeout, or any OS error is logged and swallowed.

    The GC is idempotent (git worktree remove / branch -D no-op once the dir/
    branch is gone), so overlapping invocations across rapid reaps converge
    harmlessly on the same reclaimed set.
    """
    if not skill or skill not in WORKTREE_GC_SKILLS:
        return
    if os.environ.get("HYDRA_REAP_WORKTREE_GC", "1") == "0":
        return
    if not WORKTREE_GC_SCRIPT.exists():
        return
    try:
        proc = subprocess.run(
            ["bash", str(WORKTREE_GC_SCRIPT), "--apply"],
            check=False,
            capture_output=True,
            timeout=120,
        )
        if proc.returncode != 0:
            _append_log(
                f"worktree_gc_nonzero rc={proc.returncode} "
                f"stderr={proc.stderr.decode('utf-8', 'replace')[:200]!r}"
            )
        else:
            _append_log("worktree_gc_ok")
    except (subprocess.SubprocessError, OSError) as exc:
        _append_log(f"worktree_gc_skipped err={exc}")


# Self-heal pattern IDs that are NOT learning-worthy reflection writes
# (issue #1119). `worktree-isolation-broken` is an INFRA abort, not a
# model-fixable failure (self_heal.py tags it "never auto-retry; surface to
# operator"), so recording a prior-attempt narrative for it would pollute the
# retry-correctness signal with noise. Every other pattern (verification-
# failure / no-diff / rollback / scope-violation / test-timeout / ci-flake /
# ratelimit / unknown) IS a non-merged terminal outcome whose narrative the
# next attempt should read.
REFLECTION_RECORD_SKIP_PATTERNS = {"worktree-isolation-broken"}


def _fire_reflection_record(
    anchor_ref: str | None,
    outcome: str,
    reason: str,
    *,
    task_id: str | None = None,
    task_title: str | None = None,
) -> None:
    """Best-effort POST to /api/autopilot/reflection-record (issue #1119).

    The WRITE-gap fix for the severed episodic-reflection learning loop. Fires
    when a dispatch terminalises on a NON-MERGED outcome so the per-anchor
    reflection store becomes non-empty — restoring the #841 live injection path
    that hydra-dev/target read at planning time (the #193 retry-correctness
    invariant). Mirrors `_fire_cycle_record` exactly:

      - Skipped when there is no anchor to key on (`anchor_ref` empty), or for a
        non-learning-worthy pattern (`worktree-isolation-broken` — an infra
        abort, not a model bug).
      - A non-2xx, an unreachable orchestrator, a malformed response, or any
        network error is logged to the run-log and SWALLOWED. Reflection writes
        are learning, NOT correctness — they must never block or fail the reap
        path.
      - The endpoint (and its `recordAnchorReflection` producer) is idempotent
        on `cycleId`/the capped per-anchor ring, so retries and overlapping
        reaps converge harmlessly.

    `outcome` is the classified self-heal pattern ID; `reason` is the cue/note
    digest. A merged PR must NEVER reach here — reflections are prior-FAILURE
    narratives, not success logs.
    """
    if not anchor_ref:
        return
    if outcome in REFLECTION_RECORD_SKIP_PATTERNS:
        return
    payload: dict = {
        "anchorRef": anchor_ref,
        "outcome": outcome,
        "reason": reason or outcome,
    }
    if task_title:
        payload["taskTitle"] = task_title
    if task_id:
        payload["cycleId"] = task_id
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{HYDRA_API_BASE}/api/autopilot/reflection-record",
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        msg = f"reflection_record_skipped anchor={anchor_ref} outcome={outcome} err={exc}"
        print(f"[autopilot] reap: {msg}", file=sys.stderr)
        _append_log(msg)


def _recover_tokens_from_transcript(task_id: str) -> int:
    """Recover a completed dispatch's REAL token count from its transcript (issue #3250).

    The autopilot's `cumulative_tokens` run field was permanently 0. The primary
    reap path takes its count from the SubagentStop hook, but the Claude Code
    SubagentStop payload does not expose the subagent's token usage
    (on-subagent-stop.sh forwards event/slot/status/task_id/subagent_type/
    summary only), so `total_tokens` arrives here as 0. The authoritative count
    already lives inside the completed dispatch's JSONL transcript; the
    orchestrator's `GET /api/metrics/session-tokens?session=<id>` route sums it
    via the `tokensForSession` transcript-scan seam.

    The join key is the dispatch's sessionId — the same UUID the hook derives
    into `task_id` from `.session_id` (see on-subagent-stop.sh's
    `.task.id // .task_id // .session_id // .id`). So `task_id` IS the sessionId
    on the hook-driven path; we pass it straight through as `?session=`.

    Best-effort and total (design invariants 3 + 4): an empty task_id, an
    unresolvable transcript, a non-2xx, an unreachable orchestrator, or any
    network error all return 0 — the honest "usage-not-parsed / unknown"
    sentinel, NEVER a fabricated nonzero. Never raises into the reap path: token
    accounting is observability, the reap is correctness. Called ONCE per
    task_id (after the `reaped_task_ids` dup-guard), so it cannot double-count.
    """
    if not task_id:
        return 0
    url = (
        f"{HYDRA_API_BASE}/api/metrics/session-tokens"
        f"?session={urllib.parse.quote(task_id, safe='')}"
    )
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as exc:
        msg = f"token_recover_skipped task_id={task_id} err={exc}"
        print(f"[autopilot] reap: {msg}", file=sys.stderr)
        _append_log(msg)
        return 0
    if not isinstance(body, dict):
        return 0
    recovered = body.get("tokens")
    if isinstance(recovered, bool):  # bool is an int subclass — reject it
        return 0
    if isinstance(recovered, int) and recovered > 0:
        return recovered
    if isinstance(recovered, (str, float)):
        try:
            n = int(recovered)
            if n > 0:
                return n
        except (TypeError, ValueError):
            return 0
    return 0


def _post_token_record(cycle_id: str, skill: str, total_tokens: int) -> None:
    """POST a single per-cycle token record for `cycle_id`. Best-effort; swallows all errors.

    Extracted from `_fire_token_record` so the same POST can fire under BOTH the
    task_id key and the branch-keyed id (issue #3187) without duplicating the
    request/error-handling boilerplate. Callers guard `skill`/`total_tokens`.
    """
    payload = {"skill": skill, "tokens": int(total_tokens), "cycleId": cycle_id}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{HYDRA_API_BASE}/api/metrics/tokens",
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        msg = f"token_record_skipped cycleId={cycle_id} skill={skill} tokens={total_tokens} err={exc}"
        print(f"[autopilot] reap: {msg}", file=sys.stderr)
        _append_log(msg)


def _fire_token_record(
    task_id: str,
    skill: str | None,
    total_tokens: int,
    worktree_branch: str | None = None,
) -> None:
    """Best-effort POST to /api/metrics/tokens — the per-CYCLE token producer (issue #2952).

    THE producer for the `hydra:metrics:tokens:by-cycle:<id>` hash (written by
    `recordSubagentTokens`, read by `getCycleTokensRaw`). Before this, that key
    family was near-empty: `recordSubagentTokens` had exactly one caller (the
    POST /api/metrics/tokens handler) and NOTHING posted to it — so the #2930
    read-time cycle-trend join (#2964) read null for almost every cycle, and the
    #2942 per-dispatch outcome record's per-cycle-token FALLBACK (`resolveDispatchTokens`
    → `getCycleTokensRaw`) never had data to fall back to.

    reap already holds its authoritative `total_tokens` at completion and is the
    SINGLE subprocess that runs on EVERY terminal dispatch, so it is the right
    producer. Fires ONCE per task_id: it runs after `run_completion`'s
    `reaped_task_ids` dup-guard, so a retried reap for the same task_id short-
    circuits before reaching here — this matters because the underlying write is
    an `hincrby` (a second post would double-count).

    Fired for EVERY completed class (not just code-writing) — the per-cycle key
    is keyed on the harness task_id, which the #2964 trend join and the #2942
    fallback both key on regardless of class.

    Issue #3187 — branch-keyed mirror: `getMetricsTrend` (src/metrics/trend.ts)
    iterates the metrics INDEX cycleIds and reads `getCycleTokensRaw(cycleId)`
    with the BRANCH-keyed id (`worktree-agent-XXX-tN-dev_orch`), because the
    metrics record itself is keyed on the synthesised worktree branch — NOT the
    bare worktree-hash `task_id`. So a token record keyed only on `task_id` is
    un-joinable for every pipeline class that has a branch-keyed metrics record
    (the same key split that required the `TEST_COUNT_MIRROR_FIELDS` patch in
    #3252 / #3255): signal classes whose cycleId IS the task_id got their tokens;
    pipeline classes did NOT (only 56% of cycles carried `tokenCost`). Fix: when
    a `worktree_branch` is known AND differs from `task_id`, ALSO post a token
    record keyed on the branch so the trend's branch-keyed lookup resolves. The
    two writes hit DISTINCT keys (`by-cycle:<task_id>` vs `by-cycle:<branch>`),
    so this never double-counts within a key — mirrors the additive cross-key
    copy `recordCycleMetrics` does for the test counts.

    Posted ONLY when `total_tokens > 0` — mirrors `_fire_cycle_record`'s
    "0 == no usage parsed == unknown" semantics: a 0 write would fabricate a
    zero-token key where the truthful state is "unattributed" (null). The
    consumers (#2964 join, #2942 fallback) treat an absent key as a truthful null.

    Best-effort: a non-2xx, an unreachable orchestrator, or any network error is
    logged to the run-log and SWALLOWED. Token accounting is observability, NOT
    correctness — it must never block or fail the reap path. `date` is omitted so
    the handler defaults to the server's UTC today (matches the daily-rollup
    semantics `recordSubagentTokens` already uses).
    """
    if not skill:
        return
    if total_tokens <= 0:
        return
    _post_token_record(task_id, skill, total_tokens)
    # Issue #3187: mirror onto the branch-keyed id the trend reader joins on.
    # Distinct key, so no double-count; only when the branch is known and is a
    # DIFFERENT id from task_id (a signal-class cycleId that equals task_id needs
    # no second write).
    if worktree_branch and worktree_branch != task_id:
        _post_token_record(worktree_branch, skill, total_tokens)


def _classify_failure_pattern(cue: str) -> str:
    """Map a free-form failure cue to a stable self-heal pattern ID (issue #1820).

    Delegates to `self_heal.classify` so reap and self_heal agree on the
    pattern taxonomy (the single source of truth lives in self_heal). The
    import is LAZY + guarded so reap stays importable/usable even if self_heal
    is unavailable (partial checkout / test harness) — on any failure we fall
    back to the conservative `unknown` pattern, which `_fire_reflection_record`
    still records (only `worktree-isolation-broken` is skipped).
    """
    try:
        from self_heal import classify  # lazy: keep reap importable standalone
        return classify(cue)
    except Exception:  # noqa: BLE001 — best-effort; classification is not correctness
        return "unknown"


def _find_failure_log_entry(state: dict, task_id: str) -> dict | None:
    """Return the most-recent failure_log row matching `task_id`, or None.

    decide.py's `_rule_reap_subagent_stops` appends a failure_log row (carrying
    `task_id`, `pattern`, `note`) when a `subagent_stop` arrives with a
    failure/budget_exceeded status — that row is the live signal that THIS
    completion was a non-merged failure rather than a clean success. reap reads
    it here to decide whether a reflection-record fire is warranted (issue
    #1820). Tolerates a missing/malformed failure_log (returns None).
    """
    if not task_id:
        return None
    flog = state.get("failure_log")
    if not isinstance(flog, list):
        return None
    for entry in reversed(flog):
        if isinstance(entry, dict) and entry.get("task_id") == task_id:
            return entry
    return None


def _fire_reflection_for_completion(
    state: dict,
    anchor_ref: str | None,
    task_id: str,
    soft_cap_hit: bool,
    *,
    task_title: str | None = None,
) -> None:
    """Fire a per-anchor failure reflection from the reap-completion path (issue #1820).

    This is the live-path WRITE producer that #1119 Slice 1 INTENDED but never
    achieved: `self_heal.append_failure → _fire_reflection_record` was wired but
    `append_failure` is never called on today's hook-driven reap path, so the
    reflection store stayed empty and `reflectionMatchSource` was permanently
    'none'. `run_completion` is the one subprocess that runs on every terminal
    dispatch AND holds the anchor (recovered from the slot before it is nulled),
    so it is the correct chokepoint.

    Fires ONLY for a non-merged FAILURE — never a clean success (reflections are
    prior-FAILURE narratives, not success logs). A completion is treated as a
    failure when EITHER:
      - the soft token cap was hit (a token-runaway terminal), OR
      - decide.py recorded a `failure_log` row for this task_id (a subagent_stop
        with failure/budget_exceeded status).

    The pattern is classified from the failure cue (self_heal taxonomy); the
    soft-cap case has no decide.py cue, so it is tagged `ratelimit`-adjacent via
    its own synthetic cue. Everything is best-effort and non-fatal: no anchor,
    no failure signal, or any downstream error degrades to a clean no-op — the
    reap path is correctness, reflection writes are learning.
    """
    if not anchor_ref:
        return
    failure_entry = _find_failure_log_entry(state, task_id)
    if not soft_cap_hit and failure_entry is None:
        # Clean (or merge-pending) completion — nothing to reflect on.
        return
    if failure_entry is not None:
        # Prefer the decide.py-recorded cue/pattern. The note is the subagent
        # summary; the recorded pattern (e.g. "subagent_failure") feeds classify.
        cue = (
            failure_entry.get("note")
            or failure_entry.get("pattern")
            or "verification-failure"
        )
    else:
        # Soft-cap runaway: no decide.py row. Synthesise a cue so the taxonomy
        # buckets it (token runaways are a rate/limit-shaped terminal).
        cue = "token budget hard limit exceeded — dispatch abandoned"
    pattern = _classify_failure_pattern(cue)
    _fire_reflection_record(
        anchor_ref,
        pattern,
        cue,
        task_id=task_id,
        task_title=task_title,
    )


def _reap_stale_claims() -> None:
    """Best-effort POST to /api/backlog/stale-claims/reap (issue #721).

    Scheduler fold PR-2/4: the stale-claim reaper used to run on every
    in-process scheduler tick (every 2 min). It now runs once per autopilot
    Phase 2 — before each dispatch decision — which is the correct cadence:
    stale `inProgress` claims only matter when the autopilot wants to dispatch
    into those slots.

    Mirrors the file's best-effort POST convention (`_fire_cycle_record`,
    `term-check.py::post_run_end`): a non-200, an unreachable orchestrator, a
    malformed response, or any network error is logged to stderr/run-log and
    swallowed. Reaping is opportunistic cleanup, NOT correctness — it must
    never block or fail the Phase 2 reap path. The endpoint itself reads the
    threshold from `HYDRA_CLAIM_MAX_AGE_MS` (default 2h) and is idempotent, so
    we send an empty body and let the server pick the threshold.
    """
    req = urllib.request.Request(
        f"{HYDRA_API_BASE}/api/backlog/stale-claims/reap",
        data=b"{}",
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        msg = f"stale_claims_reap_skipped err={exc}"
        print(f"[autopilot] reap: {msg}", file=sys.stderr)
        _append_log(msg)


def run_hardcap() -> int:
    """Default mode: hard-cap enforcement against `partial_tokens`."""
    # Issue #721 (scheduler fold PR-2/4): release stale `inProgress` claims
    # before the hard-cap sweep. Best-effort — never blocks the reap path.
    _reap_stale_claims()

    s = _load_state()
    if s is None:
        return 0
    hard = s["limits"]["subagent_hard_max_tokens"]
    soft = s["limits"]["subagent_max_tokens"]
    # (class, skill, partial_tokens, task_id, anchor) — capture task_id AND the
    # anchor before we null the slot so the cycle-record post can dedup on the
    # task_id (issue #430) and the failure reflection-record can key on the
    # anchor (issue #1820). The anchor is the only per-cycle reference that
    # survives to reap, and the slot is about to be cleared.
    runaways: list[tuple[str, str, int, str, str | None]] = []
    for cls, slot in list(s["slots"].items()):
        if slot is None:
            continue
        partial = slot.get("partial_tokens") or 0
        if partial >= hard:
            # Hard-cap trip: abandon slot, file diagnostic issue, mark class burned.
            task_id = slot.get("task_id") or f"hardcap-{cls}-{partial}"
            # Issue #2112: slots never carry an `anchor` field — recover it from
            # the planning-time deposit (keyed on task_id) so the hard-cap
            # reflection fire below is not a guaranteed no-op.
            anchor_ref = slot.get("anchor") or _read_anchor_deposit(task_id)
            runaways.append((cls, slot.get("skill", "?"), partial, task_id, anchor_ref))
            s["slots"][cls] = None
            if cls not in s.get("burned_classes", []):
                s.setdefault("burned_classes", []).append(cls)
    _save_state(s)
    for cls, skill, tokens, task_id, anchor_ref in runaways:
        title = f"Subagent token-runaway: {skill} burned {tokens} tokens"
        body = (
            f"Autopilot abandoned a `{cls}` slot running `{skill}` at "
            f"`{tokens}` tokens (hard cap: `{hard}`, soft cap: `{soft}`).\n\n"
            f"Class `{cls}` is suppressed for the rest of this autopilot session.\n\n"
            f"Run log: `/tmp/hydra-autopilot-nightly.log`\n\n"
            f"---\nSource: hydra-autopilot Phase 2 hard-cap enforcement (issue #395)"
        )
        subprocess.run(
            [
                "gh", "issue", "create", "--repo", REPO,
                "--title", title, "--body", body, "--label", "needs-triage",
            ],
            check=False,
        )
        print(f"[autopilot] HARD-CAP TRIP class={cls} skill={skill} tokens={tokens} -> issue filed, slot cleared")
        # Issue #430: hard-cap is a definitive failure — record it so the
        # cycles-failed counter advances and discover/digest see the signal.
        # task_id was captured before the slot was cleared so dedup holds
        # across re-runs of the hard-cap pass.
        _fire_cycle_record(task_id, skill, "failed", tokens)
        # Issue #1820: a hard-cap trip is an unambiguous non-merged failure —
        # fire a reflection so the next attempt on this anchor reads why the
        # prior one was abandoned. Best-effort, keyed on the anchor captured
        # before the slot was cleared; a no-op when no anchor was stamped.
        if anchor_ref:
            cue = f"token hard cap exceeded — {skill} burned {tokens} tokens, slot abandoned"
            _fire_reflection_record(
                anchor_ref,
                _classify_failure_pattern(cue),
                cue,
                task_id=task_id,
                task_title=skill,
            )
    return 0


def run_completion(cls: str, task_id: str, total_tokens: int, skill: str | None) -> int:
    """`completion` mode: idempotent token accounting keyed by task_id.

    Applies uniformly to BOTH kinds of dispatched class (issue #432):

      pipeline classes  (dev_orch / qa_orch / research_orch + _target peers)
        — occupy a slot under state.slots[<cls>]. Reap clears the slot.

      signal classes    (health / sweep_orch / sweep_target / discover_orch
                         / discover_target)
        — do NOT occupy a slot; they only track signal_last_fired. Reap
          still increments cumulative_tokens and appends to
          reaped_task_ids, and still applies the soft-cap burn if the
          subagent ran hot. The "no slot to clear" case is the design,
          not a special-case skip.

    First call for a given task_id (either kind):
      - Appends task_id to state.reaped_task_ids (FIFO, bounded to 1000).
      - Adds total_tokens to state.cumulative_tokens.
      - If total_tokens >= limits.subagent_max_tokens, appends <cls> to
        state.burned_classes (soft-cap, suppresses re-dispatch this
        session) — for both pipeline AND signal classes.
      - For pipeline classes: records slots[<cls>].tokens = total_tokens,
        then clears slots[<cls>] = null.
      - For signal classes: no slot mutation. The signal cooldown lives
        in signal_last_fired and is stamped by the dispatcher, not here.
      - Appends a slot_complete line to the run log.

    Subsequent calls with the same task_id:
      - Emit `dup_skip task_id=<X>` to the run log + stdout. No token
        accounting, no slot mutation, no burned_classes mutation. This
        idempotency holds for both pipeline and signal completions.

    Bug history: until issue #432 the soft-cap burn was nested inside the
    `if slot is not None:` branch, so a runaway hydra-discover (signal
    class) would never get its class burned. Token accounting incremented
    correctly, but the cap on re-dispatching the runaway didn't fire. The
    accounting is now unconditional and the slot-clearing is the only
    pipeline-specific step. Regression-tested in
    `test/autopilot-decide.test.mts` (signal-completion suite) and
    `test/autopilot-dedup-reap.test.mts` (signal-class burn case).
    """
    s = _load_state()
    if s is None:
        # No state file — nothing to accumulate against. Treat as no-op.
        print(f"[autopilot] reap completion: state missing, skipping task_id={task_id}", file=sys.stderr)
        return 0

    reaped = _ensure_reaped_list(s)
    if task_id in reaped:
        msg = f"dup_skip task_id={task_id} class={cls} skill={skill or '?'} tokens={total_tokens}"
        print(f"[autopilot] {msg}")
        _append_log(msg)
        # No state mutation on dup.
        return 0

    # First reap for this task_id. Append BEFORE token accounting so a
    # crash mid-update doesn't leave us double-counting on retry.
    reaped.append(task_id)
    s["reaped_task_ids"] = _bound_reaped(reaped)

    # Issue #3250: recover the REAL token count when the hook floor is 0. The
    # SubagentStop hook cannot carry the subagent's usage, so `total_tokens`
    # arrives 0 on the primary path — leaving `cumulative_tokens` permanently 0
    # and cost attribution dark. Join the completing dispatch back to its
    # transcript by sessionId (== task_id on the hook path) and sum its usage via
    # the orchestrator's session-tokens route. The recovered value REPLACES the 0
    # so it flows through the cumulative increment, the slot mirror, the
    # slot_complete log, AND `_fire_token_record` below unchanged. Only kicks in
    # when the incoming count is non-positive: a real hook/CLI count (the
    # runaway hard-cap path, tests) is authoritative and never overridden.
    # Best-effort + total: a miss returns 0 (honest "unknown" sentinel — never a
    # fabricated nonzero, invariant 3) and never raises into the reap path
    # (invariant 4). Runs ONCE per task_id (after the dup-guard) so it can't
    # double-count.
    if int(total_tokens) <= 0:
        recovered = _recover_tokens_from_transcript(task_id)
        if recovered > 0:
            total_tokens = recovered
            msg = f"token_recovered task_id={task_id} tokens={recovered} source=transcript-scan"
            print(f"[autopilot] {msg}")
            _append_log(msg)

    s["cumulative_tokens"] = int(s.get("cumulative_tokens", 0)) + int(total_tokens)

    # Soft-cap burn — unconditional, applies to both pipeline AND signal
    # classes (issue #432). Use `.get` on limits so older state.json files
    # written before subagent_max_tokens existed don't crash the reap.
    limits = s.get("limits") or {}
    soft = int(limits.get("subagent_max_tokens", 0)) or None
    if soft is not None and total_tokens >= soft and cls not in s.get("burned_classes", []):
        s.setdefault("burned_classes", []).append(cls)

    # Pipeline-only slot bookkeeping. The slot may already be cleared
    # (e.g. hard-cap already fired) or absent (signal classes) — both
    # are tolerated. `s["slots"]` only contains pipeline keys.
    #
    # Issue #1591: compute the wall-clock cycle duration from the slot's
    # dispatch-start stamp BEFORE the slot is nulled, so the cycle-record
    # write carries a non-zero `totalDurationMs` for target/betting cycles
    # (not just orchestrator cycles that got a model-fired auto-merge
    # follow-up). 0 when the slot is absent/cleared or carries no start stamp.
    slots = s.get("slots") or {}
    slot = slots.get(cls)
    duration_ms = _compute_duration_ms(slot)
    # Issue #1820: recover the anchor reference from the slot BEFORE it is
    # nulled. The dispatcher stamps `slot["anchor"]` (e.g. "issue-1820") at
    # dispatch time — it is the only place the per-cycle anchor survives to
    # reap. Captured here so a failure reflection-record fire below can key on
    # it (see `_fire_reflection_for_completion`). None when the slot is absent
    # (signal class / already-cleared) or carries no anchor.
    #
    # Issue #2112: the dispatch harness never stamps `slot["anchor"]` (the live
    # slot carries only task_id/skill/started_epoch/branch) and dev_orch passes
    # no prompt_args anchor (#458), so `slot.get("anchor")` was always None and
    # the reflection producer below was a permanent no-op. Recover the anchor
    # from the planning-time deposit the code-writing dispatch leaves (keyed on
    # the same task_id as the reflection-source deposit). The deposit is the
    # authoritative source; the slot field is a (never-populated today) fallback.
    anchor_ref = slot.get("anchor") if isinstance(slot, dict) else None
    if not anchor_ref:
        anchor_ref = _read_anchor_deposit(task_id)
    # Issue #3252: capture the slot's synthesised worktree branch BEFORE the slot
    # is nulled below. reap's cycle-record is keyed on the bare worktree-hash
    # task_id (the deposit key it reads the grounding test counts from), but the
    # record the merge-watch enrichment + dashboards read is keyed on THIS branch
    # (an un-joinable run-token-shaped id). Forwarding it lets recordCycleMetrics
    # mirror the test counts onto the branch record so `testsAfter` stops
    # recording 0 there. None when the slot is absent (signal class / cleared).
    worktree_branch = slot.get("branch") if isinstance(slot, dict) else None
    if slot is not None:
        slot["tokens"] = total_tokens
        s["slots"][cls] = None  # release the pipeline slot

    _save_state(s)

    # Issue #2715: mirror the cross-run durable subset (signal_last_fired +
    # research_force_counter) to Redis so a host reboot (which wipes /tmp) can
    # reseed the long-cooldown timestamps instead of resetting them to epoch 0.
    # AFTER _save_state so the local write is never at risk from a Redis hiccup.
    _mirror_cross_run_state_to_redis(s)

    # Issue #1136 (Slice 2 of #1119): forward the planning-time reflection
    # buckets the dispatch deposited for this task_id so the cycle metric
    # records what was actually injected (instead of always 'none'). Missing
    # deposit (the common case) → "" → field omitted downstream.
    #
    # Issue #2020: read it BEFORE the slot_complete log line so the deposit
    # PRESENCE diagnostic can be stamped into that line. `reflection_presence`
    # distinguishes an honest 'none' (deposit-absent / deposit-empty — the
    # dispatch served nothing, so it correctly wrote nothing) from a false
    # 'none' (read-error — a deposit existed but could not be read). The
    # forwarded `reflection_sources` string is unchanged, so the cycle-record
    # POST body and its truthful-'none' behaviour are untouched.
    reflection_sources, reflection_presence = _read_reflection_sources(task_id)

    # Issue #2754: read the dispatch's grounding test-count deposit so the
    # cycle-record write carries `testsAfter` (recorded as 0 on every cycle
    # before this, because reap never had a test count to forward). Absent
    # deposit (non-grounding classes, or the recipe not run) → {} → the four
    # tests fields are omitted from the POST body (truthful "unknown").
    grounding_tests = _read_grounding_tests(task_id)

    # Issue #3284: read the cascade-routing escalation-provenance deposit so a
    # dispatch decide.py escalated to a stronger model tags its outcome record
    # (#2942) with escalationAttempt/escalatedModel. Absent deposit (the
    # non-escalation majority) → "" → both fields omitted from the POST body.
    escalation = _read_escalation_deposit(task_id)

    # Issue #2450: warn when a code-writing class completes with no deposit file
    # at all — deposit-absent on a REFLECTION_DEPOSIT_SKILLS slot means the
    # deposit recipe either did not run or deposited under a miskeyed path. This
    # distinguishes broken deposit plumbing (false-none) from an honest
    # empty-reflection case where the store had nothing to serve.
    # deposit-empty is the HONEST variant (recipe ran, served nothing, wrote an
    # empty deposit) — only deposit-absent is the suspicious case.
    # hydra-grill is excluded: it writes a design-concept artifact, not a
    # reflection-source deposit, so a deposit-absent on grill is NOT a bug.
    # Best-effort: print to stderr (operator-visible) AND append to the run log.
    if (skill in REFLECTION_DEPOSIT_SKILLS and
            reflection_presence == REFL_PRESENCE_ABSENT):
        warn_msg = (
            f"refl_deposit_absent skill={skill} task_id={task_id} "
            f"anchor={anchor_ref or ''} — deposit recipe may not have run; "
            f"check for refl-deposit-no-task-id / refl-deposit-write-failed "
            f"in the child's stderr (cue: refl-deposit-absent-on-code-write)"
        )
        print(f"[autopilot] WARN {warn_msg}", file=sys.stderr)
        _append_log(f"WARN {warn_msg}")

    line = (
        f"slot_complete class={cls} skill={skill or '?'} task_id={task_id} "
        f"tokens={total_tokens} cumulative={s['cumulative_tokens']} "
        f"duration_ms={duration_ms} task_title={anchor_ref or ''} "
        f"refl_sources={reflection_sources or ''} refl_presence={reflection_presence}"
    )
    print(f"[autopilot] {line}")
    _append_log(line)

    # Issue #430: fire a cycle-record write for code-writing classes so
    # /api/cycle/history and /api/metrics reflect post-PR-3 reality. Status
    # at reap time is "completed" — the autopilot doesn't know merge vs
    # abandon until later (the auto-merge action handler bumps it via the
    # idempotent endpoint with status=merged). For runaway/burned reaps
    # we tag the cycle as "failed" so the cycles-failed counter ticks.
    soft_cap_hit = soft is not None and total_tokens >= soft
    status = "failed" if soft_cap_hit else "completed"
    # Issue #2012: forward the anchor reference recovered from the slot (e.g.
    # "issue-2012") as the cycle's task_title + anchor_ref. Before this, reap
    # hardcoded both to "" on every merge, so successful named-issue cycles
    # stored taskTitle == null and naive no-task counters (the #1832 false
    # alarm) mistook them for no-op cycles. None / signal-class dispatches with
    # no slot anchor stay "" → dispatch.sh omits the field → truthful null.
    _fire_cycle_record(
        task_id,
        skill,
        status,
        total_tokens,
        reflection_sources,
        duration_ms,
        task_title=anchor_ref or "",
        anchor_ref=anchor_ref or "",
        grounding_tests=grounding_tests,
        worktree_branch=worktree_branch or "",
        escalation=escalation or "",
    )

    # Issue #2952: fire the per-CYCLE token record so the near-empty
    # `hydra:metrics:tokens:by-cycle:<id>` key family gets a producer. Unlike
    # the cycle-record above (code-writing classes only), this fires for EVERY
    # completed class — the per-cycle key is keyed on the harness task_id, which
    # the #2964 cycle-trend join and the #2942 outcome-record fallback both key
    # on regardless of class. The helper is best-effort, guards tokens>0, and
    # runs after the `reaped_task_ids` dup-guard so the underlying hincrby fires
    # exactly once per task_id.
    #
    # Issue #3187: forward the synthesised worktree branch (captured above before
    # the slot was nulled) so the record ALSO lands under the branch-keyed id the
    # #2964 trend join reads by — closing the ~56% tokenCost coverage gap for
    # pipeline classes whose metrics record is branch-keyed, not task_id-keyed.
    _fire_token_record(task_id, skill, total_tokens, worktree_branch=worktree_branch)

    # Issue #1820: the reflection-record WRITE producer wired in #1119 Slice 1
    # (self_heal.append_failure → _fire_reflection_record) was dead on the live
    # path — nothing calls append_failure, so every failed dispatch lost its
    # prior-attempt narrative and `reflectionMatchSource` stayed locked to
    # 'none'. reap.run_completion IS the single authoritative subprocess that
    # runs on EVERY terminal dispatch, and it now holds the anchor (captured
    # above). Fire the reflection here on a NON-MERGED failure so the next
    # attempt on this anchor reads why the prior one failed (the #193 retry-
    # correctness invariant). Fully best-effort — see the helper.
    _fire_reflection_for_completion(
        s, anchor_ref, task_id, soft_cap_hit, task_title=skill
    )

    # Issue #911: reclaim the just-freed worktree (and any other orphans) at
    # reap time rather than waiting for the daily timer. Best-effort, fully
    # non-fatal, and only for worktree-bearing classes — see _fire_worktree_gc.
    _fire_worktree_gc(skill)

    return 0


def run_grill_crash(task_id: str) -> int:
    """Issue #466 (Phase B of #437): record a `hydra-grill` crash outcome.

    The harness calls this when a `design_concept_orch` slot dispatches
    `hydra-grill` but the subagent exits without writing any artifact to
    Redis (case 3 of the retry policy — distinct from case 1 timeout
    handled in `run_hardcap`, and case 2 warn-only handled in
    saveDesignConcept). Increments the daily `grill_crash_count` and
    fires a `failed` cycle-record for parity with other failure paths.

    Idempotent on `task_id` via the same `reaped_task_ids` ledger as
    `run_completion` — re-invocations for the same task_id are no-ops on
    the counter as well as the cycle-record (which is itself idempotent
    on cycleId).
    """
    s = _load_state()
    if s is not None:
        reaped = _ensure_reaped_list(s)
        if task_id in reaped:
            msg = f"dup_skip_grill_crash task_id={task_id}"
            print(f"[autopilot] {msg}")
            _append_log(msg)
            return 0
        reaped.append(task_id)
        s["reaped_task_ids"] = _bound_reaped(reaped)
        _save_state(s)
    _fire_cycle_record(task_id, "hydra-grill", "failed", 0)
    line = f"grill_crash task_id={task_id}"
    print(f"[autopilot] {line}")
    _append_log(line)
    return 0


def main(argv: list[str]) -> int:
    # Default (no subcommand): hard-cap enforcement, behavior-preserving
    # for /hydra-autopilot Phase 2 step 1.
    if len(argv) <= 1:
        return run_hardcap()

    sub = argv[1]
    if sub == "completion":
        # Usage: reap.py completion <class> <task_id> <total_tokens> [skill]
        if len(argv) < 5:
            print(
                "[autopilot] reap completion usage: completion <class> <task_id> <total_tokens> [skill]",
                file=sys.stderr,
            )
            return 0
        cls = argv[2]
        task_id = argv[3]
        try:
            total_tokens = int(argv[4])
        except ValueError:
            print(f"[autopilot] reap completion: invalid total_tokens={argv[4]!r}", file=sys.stderr)
            return 0
        skill = argv[5] if len(argv) > 5 else None
        return run_completion(cls, task_id, total_tokens, skill)

    if sub == "grill-crash":
        # Usage: reap.py grill-crash <task_id>
        # Issue #466 (Phase B of #437): record case-3 grill crash —
        # `hydra-grill` exited without writing an artifact. The harness
        # detects this and invokes this subcommand once per crashed task.
        if len(argv) < 3:
            print(
                "[autopilot] reap grill-crash usage: grill-crash <task_id>",
                file=sys.stderr,
            )
            return 0
        return run_grill_crash(argv[2])

    print(f"[autopilot] reap: unknown subcommand {sub!r}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
