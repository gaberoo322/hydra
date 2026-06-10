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
import urllib.request
from pathlib import Path

STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))
LOG_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_LOG", "/tmp/hydra-autopilot-nightly.log"))
REPO = os.environ.get("HYDRA_AUTOPILOT_REPO", "gaberoo322/hydra")
HYDRA_API_BASE = os.environ.get("HYDRA_API_BASE", "http://localhost:4000")

REAPED_TASK_IDS_CAP = 1000

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


def _read_reflection_sources(task_id: str) -> str:
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
    """
    if not task_id:
        return ""
    try:
        path = REFL_SOURCES_DIR / f"hydra-refl-sources-{task_id}"
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        _append_log(f"refl_sources_read_skipped task_id={task_id} err={exc}")
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
    """
    if not skill or skill not in CYCLE_RECORD_SKILLS:
        return
    if not CYCLE_RECORD_SCRIPT.exists():
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
                "",  # task_title
                "",  # anchor_ref
                str(duration_ms or 0),  # issue #1591: wall-clock cycle span (ms)
                reflection_sources or "",  # issue #1136: served reflection buckets
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
    # (class, skill, partial_tokens, task_id) — capture task_id before we
    # null the slot so the cycle-record post can dedup on it (issue #430).
    runaways: list[tuple[str, str, int, str]] = []
    for cls, slot in list(s["slots"].items()):
        if slot is None:
            continue
        partial = slot.get("partial_tokens") or 0
        if partial >= hard:
            # Hard-cap trip: abandon slot, file diagnostic issue, mark class burned.
            task_id = slot.get("task_id") or f"hardcap-{cls}-{partial}"
            runaways.append((cls, slot.get("skill", "?"), partial, task_id))
            s["slots"][cls] = None
            if cls not in s.get("burned_classes", []):
                s.setdefault("burned_classes", []).append(cls)
    _save_state(s)
    for cls, skill, tokens, task_id in runaways:
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
    if slot is not None:
        slot["tokens"] = total_tokens
        s["slots"][cls] = None  # release the pipeline slot

    _save_state(s)

    line = (
        f"slot_complete class={cls} skill={skill or '?'} task_id={task_id} "
        f"tokens={total_tokens} cumulative={s['cumulative_tokens']} "
        f"duration_ms={duration_ms}"
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
    # Issue #1136 (Slice 2 of #1119): forward the planning-time reflection
    # buckets the dispatch deposited for this task_id so the cycle metric
    # records what was actually injected (instead of always 'none'). Missing
    # deposit (the common case) → "" → field omitted downstream.
    reflection_sources = _read_reflection_sources(task_id)
    _fire_cycle_record(
        task_id, skill, status, total_tokens, reflection_sources, duration_ms
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
