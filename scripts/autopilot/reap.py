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

WARNING (issue #3895): the default state path is a SHARED, unlocked file —
every process on the box, including a dispatched agent correctly isolated
in its own git worktree, writes the SAME /tmp/hydra-autopilot-state.json
unless it exports HYDRA_AUTOPILOT_STATE. Never invoke `reap.py` ad-hoc
(manual exploration/testing of the autopilot's own mechanics) against the
default path — a live control-loop run may be depending on it right now.
Always pass an explicit `HYDRA_AUTOPILOT_STATE=/tmp/some-scratch-path.json`
when experimenting. `run_completion`'s `task_id` cross-check (below) is a
backstop against a mismatched completion corrupting an occupied slot, but
it cannot protect fields a stray call is allowed to touch legitimately
(e.g. a genuinely-matching task_id) — isolation via the env override is
the real fix.

Exit code is always 0 — failure to file a GitHub issue is logged but
not fatal.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))
LOG_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_LOG", "/tmp/hydra-autopilot-nightly.log"))
REPO = os.environ.get("HYDRA_AUTOPILOT_REPO", "gaberoo322/hydra")
HYDRA_API_BASE = os.environ.get("HYDRA_API_BASE", "http://localhost:4000")

REAPED_TASK_IDS_CAP = 1000

# Issue #3866: argv prefix for `gh` calls made by the dev_orch no-PR-stall
# check below. Mirrors the HYDRA_AUTOPILOT_REDIS_CLI override pattern for
# _redis_cli — tests inject a stub `gh` recorder here instead of shelling out
# to the real CLI / network. Whitespace-split so a multi-word override works.
GH_CLI_OVERRIDE = os.environ.get("HYDRA_AUTOPILOT_GH_CLI", "").strip()

# Issue #3866: cap on state.dev_resume_pending so a run with many distinct
# stalling anchors can't grow the list unboundedly across a long session —
# mirrors REAPED_TASK_IDS_CAP's FIFO-bound rationale, just a much smaller
# ceiling since this list drains via dispatch, not just accumulates.
DEV_RESUME_PENDING_CAP = 20

# The `needs-dev-resume` label already exists on gaberoo322/hydra (created
# for this issue) — reap never attempts to create it, only to apply it.
DEV_RESUME_LABEL = "needs-dev-resume"

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


def _gh_argv(*args: str) -> list[str]:
    """Build a `gh` CLI argv, honouring HYDRA_AUTOPILOT_GH_CLI (issue #3866).

    Mirrors `_redis_cli`'s override pattern: default prefix is the single
    token `gh`; a test/operator override is whitespace-split so a stub
    recorder script (or a `gh --hostname ...` prefix) can stand in.
    """
    prefix = GH_CLI_OVERRIDE.split() if GH_CLI_OVERRIDE else ["gh"]
    return [*prefix, *args]


def _pr_refs_referenced_issues(pr_list_json: str) -> set[int]:
    """Load pr-refs.py's shared reference predicate and apply it (issue #3866).

    `pr-refs.py` (issue #3852) is THE reference-detection predicate for "does
    an open PR reference issue N" — recover-stale.sh already shells out to it
    for the analogous stale_in_progress/stale_blocked recovery. reap.py is
    pure Python already, so it loads the sibling module directly via
    importlib (the file is not import-friendly by name — it lives next to
    this script, not on sys.path, and its hyphenated filename isn't a valid
    module name) rather than round-tripping through a second subprocess.
    Mirrors the lazy-import-for-standalone-usability pattern
    `_classify_failure_pattern` already uses for `self_heal`.
    """
    spec = importlib.util.spec_from_file_location(
        "hydra_autopilot_pr_refs", Path(__file__).parent / "pr-refs.py"
    )
    if spec is None or spec.loader is None:
        raise ImportError("cannot load pr-refs.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.referenced_issues(pr_list_json)


def _dev_orch_pr_exists_for_anchor(anchor_ref: str) -> bool | None:
    """Does an OPEN PR on REPO reference `anchor_ref`? (issue #3866)

    `anchor_ref` is the "issue-<N>" shape `_read_anchor_deposit` returns.
    Returns:
      True  — `gh pr list` succeeded and at least one open PR's head branch
              or body references the issue (pr-refs.py's predicate).
      False — `gh pr list` succeeded and NO open PR references it. This is
              the "dev_orch completed with no PR" stall signal the issue is
              about.
      None  — the check could not be completed (malformed anchor, `gh`
              failure/timeout, unparseable output). Callers MUST treat this
              as "unknown" and take no action — never as a false `False`.
              Fail-open, matching every other best-effort `gh`/network call
              in this module (e.g. `_recover_tokens_from_transcript`).
    """
    m = re.match(r"^issue-(\d+)$", (anchor_ref or "").strip())
    if not m:
        return None
    issue_num = int(m.group(1))
    try:
        proc = subprocess.run(
            _gh_argv(
                "pr", "list", "--repo", REPO, "--state", "open",
                "--json", "headRefName,body", "--limit", "200",
            ),
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        print(
            f"[autopilot] reap: gh pr list failed for anchor={anchor_ref} "
            f"({exc}); PR-existence unknown, no relabel this reap",
            file=sys.stderr,
        )
        return None
    if proc.returncode != 0:
        print(
            f"[autopilot] reap: gh pr list exited {proc.returncode} for "
            f"anchor={anchor_ref}; PR-existence unknown, no relabel this reap",
            file=sys.stderr,
        )
        return None
    try:
        referenced = _pr_refs_referenced_issues(proc.stdout)
    except Exception as exc:  # noqa: BLE001 — best-effort, never abort the reap
        print(
            f"[autopilot] reap: pr-refs parse failed for anchor={anchor_ref} "
            f"({exc}); PR-existence unknown, no relabel this reap",
            file=sys.stderr,
        )
        return None
    return issue_num in referenced


def _handle_dev_orch_stall(
    s: dict,
    cls: str,
    skill: str | None,
    anchor_ref: str | None,
    task_id: str,
    worktree_branch: str | None,
) -> None:
    """Detect + relabel a dev_orch completion that opened no PR (issue #3866).

    Motivating incident: dev_orch on #3726 did ~9.5 min of implementation,
    backgrounded `npm test`, then ended its turn waiting on the test run
    instead of finishing the PR. reap.py's completion accounting treated
    that as a normal `completed` cycle, the source issue stayed labelled
    `ready-for-agent` (or whatever the child left it as), and the NEXT
    autopilot turn re-dispatched the same anchor from a brand-new worktree —
    silently re-paying the ~165k tokens already spent, because nothing in
    the reap/decide path ever checked "did a PR actually get opened?"

    Only applies to `dev_orch` completions carrying a resolved anchor — a
    signal-class completion, a pinned-anchor miss, or a genuine no_op (no
    anchor deposit) all skip this by construction (the `not anchor_ref`
    guard). The PR-existence check fails OPEN (returns None) on any `gh`
    hiccup, so a transient network/auth failure never mislabels a healthy
    in-flight/merged anchor — see `_dev_orch_pr_exists_for_anchor`.

    On a confirmed stall (PR-existence == False):
      - relabel the issue away from ready-for-agent/in-progress to
        `needs-dev-resume` (label pre-created for this issue) so hydra-dev's
        own `gh issue list --label ready-for-agent | .[0]` self-selection can
        never re-pick it for a from-scratch redo.
      - post an explanatory comment (best-effort).
      - append a resume record to `state.dev_resume_pending` — the queue
        `decide.py`'s dev_orch selector drains ahead of a fresh
        ready-for-agent pick, pinning the NEXT dev_orch dispatch back to
        this anchor (with the stalled branch name, when known) instead of
        leaving it to rot under a label nothing else consumes.

    Every step here is best-effort and non-fatal — a relabel/comment/gh
    failure logs to stderr and the reap still returns normally, exactly like
    the other post-accounting side effects in `run_completion` (reflection
    fire, worktree GC).
    """
    if cls != "dev_orch" or not anchor_ref:
        return
    pr_exists = _dev_orch_pr_exists_for_anchor(anchor_ref)
    if pr_exists is not False:
        # True (PR found) or None (unknown/gh unreachable) — no action. A
        # found PR means the anchor is legitimately progressing (needs-qa
        # transition, if any, is the child/QA path's job, not reap's); an
        # unknown result fails open rather than risking a false stall label.
        return

    m = re.match(r"^issue-(\d+)$", anchor_ref)
    issue_num = m.group(1) if m else None
    if issue_num is None:
        return

    relabelled = False
    try:
        edit = subprocess.run(
            _gh_argv(
                "issue", "edit", issue_num, "--repo", REPO,
                "--remove-label", "ready-for-agent",
                "--remove-label", "in-progress",
                "--add-label", DEV_RESUME_LABEL,
            ),
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
        relabelled = edit.returncode == 0
        if not relabelled:
            print(
                f"[autopilot] reap: WARN failed to relabel issue #{issue_num} "
                f"to {DEV_RESUME_LABEL} (non-fatal): {edit.stderr.strip()}",
                file=sys.stderr,
            )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        print(
            f"[autopilot] reap: WARN gh issue edit failed for #{issue_num} "
            f"(non-fatal): {exc}",
            file=sys.stderr,
        )

    try:
        branch_note = f"\n**Branch:** `{worktree_branch}`" if worktree_branch else ""
        subprocess.run(
            _gh_argv(
                "issue", "comment", issue_num, "--repo", REPO, "--body",
                "> *Automated reap — dev_orch stalled with no PR (issue #3866)*\n\n"
                "The `dev_orch` dispatch for this anchor ended its session "
                "without opening a PR (no open PR currently references this "
                f"issue).{branch_note}\n\n"
                f"Relabelled `{DEV_RESUME_LABEL}` so the next autopilot turn "
                "resumes this anchor instead of re-dispatching a fresh "
                "implementation from scratch.",
            ),
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        print(
            f"[autopilot] reap: WARN gh issue comment failed for #{issue_num} "
            f"(non-fatal): {exc}",
            file=sys.stderr,
        )

    # Append/replace the resume record — dedup by anchor so a repeated stall
    # on the SAME anchor keeps only its latest attempt, then FIFO-bound the
    # whole queue (issue #3866).
    pending = s.get("dev_resume_pending")
    if not isinstance(pending, list):
        pending = []
    pending = [e for e in pending if not (isinstance(e, dict) and e.get("anchor") == anchor_ref)]
    pending.append({
        "anchor": anchor_ref,
        "task_id": task_id,
        "branch": worktree_branch or "",
        "stalled_epoch": int(time.time()),
    })
    if len(pending) > DEV_RESUME_PENDING_CAP:
        pending = pending[-DEV_RESUME_PENDING_CAP:]
    s["dev_resume_pending"] = pending
    _save_state(s)

    line = (
        f"dev_stall_no_pr anchor={anchor_ref} task_id={task_id} "
        f"branch={worktree_branch or ''} relabelled={relabelled}"
    )
    print(f"[autopilot] {line}")
    _append_log(line)


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


# Issue #3675: the deposit READ key and the deposit WRITE key are derived by two
# different actors from two different identifiers, and they do not agree.
#
#   WRITE side — `scripts/reflection-deposit.sh derive_task_id()` runs INSIDE the
#   worktree subagent and keys on the `agent-<HASH>` worktree-dir basename with
#   the `agent-` prefix STRIPPED. Every deposit on disk is therefore a bare hex
#   hash (or, on a non-worktree layout, the CLAUDE_CODE_SESSION_ID UUID).
#
#   READ side — reap keys on the autopilot slot `task_id`, which is whatever the
#   dispatch harness stamped. Measured live (2026-07-27) that value carries a
#   prefix the deposits do not: the occupied slots read
#   `task_id: "worktree-agent-<HASH>"` (the synthesised branch name), and older
#   cycle records show an `agent-<HASH>` generation too. Both miss the bare-hash
#   file by exactly one prefix, so `_read_grounding_tests` returned {} on every
#   pipeline dispatch and `testsAfter` recorded null on 0/50 sampled trend rows
#   while 90 fully-populated grounding deposits sat unread in /tmp.
#
# Fix: resolve the read key against an ORDERED candidate list — the verbatim
# `task_id` first (so any already-aligned generation keeps its exact-match
# behaviour), then the prefix-stripped forms. Read-side rather than write-side
# because it retroactively joins the ~300 deposits already on disk and needs no
# skill re-sync. This does NOT touch the cycle-record WRITE key: `_fire_cycle_record`
# still keys on `worktree_branch or task_id` per #3391, so the test-count write and
# the merge-watch enrichment still land on ONE indexed record. The deposit read key
# and the record write key are deliberately different identifiers; only the former
# changes here.
DEPOSIT_KEY_STRIP_PREFIXES = ("worktree-agent-", "agent-")


def _deposit_key_candidates(task_id: str) -> list[str]:
    """Ordered read-key candidates for a task-scoped deposit (issue #3675).

    The verbatim `task_id` is always tried FIRST so an already-aligned key keeps
    its exact-match resolution; the `worktree-agent-` / `agent-` prefix-stripped
    forms follow, recovering the bare worktree hash the writer actually used.
    Order is significant and the list is de-duplicated, so a `task_id` that is
    already bare yields exactly one candidate.

    Candidates containing a path separator or a NUL are dropped: the key is
    interpolated into a filename, and a separator would escape REFL_SOURCES_DIR.
    """
    if not task_id:
        return []
    out: list[str] = []
    for cand in (task_id, *(
        task_id[len(p):] for p in DEPOSIT_KEY_STRIP_PREFIXES if task_id.startswith(p)
    )):
        if not cand or "/" in cand or "\\" in cand or "\0" in cand:
            continue
        if cand not in out:
            out.append(cand)
    return out


def _resolve_deposit_path(kind: str, task_id: str) -> Path | None:
    """First existing `${REFL_SOURCES_DIR}/<kind>-<candidate>` path, or None (issue #3675).

    `kind` is the deposit filename stem (`hydra-grounding-tests`,
    `hydra-refl-anchor`, ...). Best-effort and fully non-fatal, matching every
    caller's contract: an unprobeable candidate is logged and skipped, and an
    exhausted candidate list yields None so the caller degrades to its existing
    truthful-absence behaviour (never a throw, never a recorded 0).

    A resolution that needed a FALLBACK candidate is logged — the read-key drift
    this fixes was invisible for months precisely because every miss was silent.
    """
    for idx, key in enumerate(_deposit_key_candidates(task_id)):
        path = REFL_SOURCES_DIR / f"{kind}-{key}"
        try:
            found = path.exists()
        except OSError as exc:
            _append_log(f"deposit_probe_skipped kind={kind} key={key} err={exc}")
            continue
        if found:
            if idx > 0:
                _append_log(
                    f"deposit_key_fallback kind={kind} task_id={task_id} "
                    f"resolved_key={key}"
                )
            return path
    return None


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
        # Issue #3675: resolve through the shared read-key resolver so a
        # prefixed slot task_id still finds the bare-hash file the writer left.
        path = _resolve_deposit_path("hydra-refl-sources", task_id)
        if path is None:
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
        # Issue #3675: shared read-key resolver — see `_resolve_deposit_path`.
        path = _resolve_deposit_path("hydra-refl-anchor", task_id)
        if path is None:
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
        # Issue #3675: shared read-key resolver — see `_resolve_deposit_path`.
        path = _resolve_deposit_path("hydra-grounding-tests", task_id)
        if path is None:
            # Issue #3675: this branch was SILENT, which is why a months-long
            # read-key drift went unnoticed. Log the exhausted candidate list so
            # a future divergence is one grep away. Still returns {} — the
            # truthful-absence contract is unchanged (never a recorded 0).
            _append_log(
                f"grounding_tests_deposit_absent task_id={task_id} "
                f"tried={','.join(_deposit_key_candidates(task_id)) or '-'}"
            )
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
        # Issue #3675: log the RESOLVED counts. The cycle-record POST itself is
        # fired through dispatch.sh and cannot be inspected, so this line is the
        # only observable proof that a deposit was read and forwarded — it is
        # what the regression test asserts on, and what an operator greps to
        # confirm the post-deploy `testsAfter` acceptance criterion.
        _append_log(
            f"grounding_tests_resolved task_id={task_id} path={path.name} "
            f"fields={','.join(f'{k}={v}' for k, v in sorted(out.items())) or '-'}"
        )
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
        # Issue #3675: shared read-key resolver. This deposit is written with an
        # EXPLICITLY-passed task_id (the harness slot id), so the verbatim
        # first candidate already resolves it today — routing it through the same
        # resolver keeps all four deposit reads on ONE key-derivation seam so the
        # two ends cannot drift apart again per-reader.
        path = _resolve_deposit_path("hydra-escalation", task_id)
        if path is None:
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

    `worktree_branch` (issue #3391, superseding #3252): the slot's synthesised
    worktree branch (`worktree-agent-<runToken>-t<N>-<slot>`). When present, it
    becomes THE `cycleId` this cycle-record is POSTed under — NOT the bare
    worktree-hash `task_id` — so the test-count-bearing write lands on the SAME
    indexed record the merge-watch enrichment (holdback-merge-watch.ts) later
    adds `prNumber`/`filesChanged` to. Before #3391 reap keyed this write on
    `task_id` and forwarded the branch only so a cross-key TS mirror in
    `src/metrics/record.ts` could copy the four test-count fields onto the
    branch record; that mirror is retired here because unifying the cycleId at
    the write means one indexed record per dispatch carries BOTH `testsAfter`
    and the merge fields — no un-joinable twin, no phantom-index hazard, and
    the `!raw.cycleId` trend-read guard is satisfied because the record IS
    indexed under a cycleId. Empty (signal class / cleared slot) → the
    cycle-record keys on `task_id` as before (the signal-class cycleId IS the
    task_id). It is still forwarded as the 12th positional so dispatch.sh stamps
    `worktreeBranch` as record metadata (== cycleId in the pipeline case).

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
    # Issue #3391: key the cycle-record on the synthesised worktree branch when
    # one is known, so the test-count-bearing write lands on the SAME indexed
    # record the merge-watch enrichment adds prNumber/filesChanged to (they were
    # previously un-joinable twins — the bare worktree-hash task_id here vs the
    # run-token-shaped branch there — so `testsAfter` recorded 0 on the sampled
    # record every cycle). A signal-class / cleared-slot completion has no branch,
    # so it keeps keying on task_id (its cycleId IS the task_id). Logged so the
    # chosen key is observable in the run log (asserted by the reap harness — the
    # POST itself goes to dispatch.sh and cannot be inspected from a test).
    effective_cycle_id = worktree_branch or task_id
    _append_log(
        f"cycle_record_fired cycleId={effective_cycle_id} task_id={task_id} "
        f"skill={skill} status={status}"
    )
    try:
        subprocess.run(
            [
                "bash",
                str(CYCLE_RECORD_SCRIPT),
                "cycle-record",
                effective_cycle_id,
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
                # Issue #3391 (superseding #3252): the synthesised worktree branch
                # as the 12th positional. It is now ALSO the cycleId above, so
                # dispatch.sh stamps `worktreeBranch` as record metadata that
                # equals the cycleId (the retired cross-key mirror is gone). Empty
                # → dispatch.sh omits the metadata field (signal-class case).
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
        _append_log(
            f"cycle_record_skipped cycleId={effective_cycle_id} "
            f"task_id={task_id} err={exc}"
        )


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


def run_hardcap() -> int:
    """Default mode: hard-cap enforcement against `partial_tokens`."""
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


def run_completion(cls: str, task_id: str, total_tokens: int, skill: str | None, last_segment_tokens: int | None = None) -> int:
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
      - If the soft-cap comparison value >= limits.subagent_max_tokens,
        appends <cls> to state.burned_classes (soft-cap, suppresses
        re-dispatch this session) — for both pipeline AND signal classes.
        The comparison value is last_segment_tokens when supplied (issue
        #3839 — a resumed dispatch sums its segments into one call, but the
        cap bounds ONE subagent, so it is measured against the LATEST
        segment, not the summed cumulative total), else total_tokens (the
        legacy single-segment path — byte-for-byte for every call site that
        omits the new argument). Cost accounting always uses the true sum
        total_tokens; only the CAP COMPARISON honours last_segment_tokens.
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

    Issue #3895: BEFORE any of the above mutation happens, a pipeline
    class's OCCUPIED slot is cross-checked against the passed `task_id`. If
    the slot's stamped `task_id` disagrees, the entire completion is
    refused (zero state mutation, zero downstream fires) and a
    `task_id_mismatch_refused` line is logged — see the guard immediately
    after the dup-check below. This closes the corruption path a stray/
    manual invocation against the shared default state path exploited: an
    unrelated fabricated task_id previously cleared the REAL occupant's
    slot, inflated `cumulative_tokens`, and could falsely burn the class.
    Regression-tested in `test/autopilot-reap-task-id-mismatch.test.mts`.
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

    # Issue #3895: refuse the ENTIRE completion — before any state mutation —
    # when the passed task_id disagrees with an OCCUPIED pipeline slot's
    # stamped occupant. `state.slots[<cls>]` is the single source of truth
    # for "which dispatch owns this class right now" (task_id/skill/
    # started_epoch/branch, stamped by the dispatch harness at dispatch
    # time). Before this guard, a stray/manual/mistyped `reap.py completion`
    # invocation against the SHARED default state path (no isolation, no
    # locking) was trusted at face value: it cleared a genuinely in-flight
    # dev_orch slot, inflated cumulative_tokens by a fabricated tokens
    # figure, and could falsely soft-cap-burn the class for the rest of the
    # run — all from a task_id that never corresponded to a real dispatch
    # (the incident this issue documents: run 8f86ef9b, 2026-08-06).
    #
    # Only pipeline classes have a slot to protect — `slots.get(cls)` is
    # always None/absent for signal classes (health/sweep_orch/discover_*/
    # ...), so this check is a no-op for them, matching the existing
    # "no slot to clear" design. An EMPTY slot (None — already cleared, or
    # never occupied) has no occupant to protect either: that is the
    # legitimate "hard-cap already fired" / late-arriving-completion case
    # the docstring above already documents, so it is NOT refused here.
    # Only an OCCUPIED slot (a dict) whose stamped `task_id` DISAGREES with
    # the passed task_id is refused. A slot with no stamped task_id (older/
    # partial state) fails OPEN — a missing field can't prove a mismatch, so
    # we never block a legitimate completion on absent metadata.
    slots_probe = s.get("slots") or {}
    slot_probe = slots_probe.get(cls)
    if isinstance(slot_probe, dict):
        occupant_task_id = slot_probe.get("task_id")
        if occupant_task_id and occupant_task_id != task_id:
            msg = (
                f"task_id_mismatch_refused class={cls} skill={skill or '?'} "
                f"passed_task_id={task_id} slot_task_id={occupant_task_id} "
                f"tokens={total_tokens} — refusing to mutate state; the "
                f"slot's real occupant does not match the passed task_id "
                f"(cue: reap-task-id-mismatch)"
            )
            print(f"[autopilot] WARN {msg}", file=sys.stderr)
            _append_log(msg)
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
    # Issue #3839: the soft cap bounds ONE subagent — "a single misbehaving
    # subagent", per this function's own framing. A RESUMED dispatch (the
    # prescribed recovery for the documented stall-on-backgrounded-tests mode)
    # sums its per-segment counts into this one call, so capping the SUM would
    # punish the correct recovery and invert the incentive: resuming preserves
    # committed work but risks burning the class, while re-dispatching
    # duplicates work yet starts a fresh token budget. When the caller supplies
    # the LATEST segment's token count (last_segment_tokens), cap against THAT
    # segment (the faithful "one subagent" bound — the most recent unit of
    # work); otherwise cap against total_tokens as before, so a genuine
    # single-segment runaway still burns exactly as today.
    #
    # The `is not None` check is load-bearing (design-concept #3839 INV-4): a
    # legitimately zero-token final segment (0) is a real value that must
    # compare as 0 >= soft (False), NOT silently fall back to the cumulative
    # sum — a bare truthiness check (`if last_segment_tokens:`) would treat 0
    # as falsy and wrongly compare the full total instead.
    #
    # `soft_cap_hit` is computed ONCE here and threaded into the burn append,
    # the cycle-record status, and `_fire_reflection_for_completion` below — so
    # correcting this single comparison fixes class-burn, cycle status, and
    # reflection classification together (design-concept #3839 INV-6). Cost
    # accounting — cumulative_tokens above, slot.tokens below, and the
    # cycle/token records downstream — ALWAYS uses the true sum total_tokens;
    # this is the CAP COMPARISON only, never spend under-reporting (criterion 4).
    cap_check_value = last_segment_tokens if last_segment_tokens is not None else total_tokens
    soft_cap_hit = soft is not None and cap_check_value >= soft
    status = "failed" if soft_cap_hit else "completed"
    if soft_cap_hit and cls not in s.get("burned_classes", []):
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
    # Issue #3391 (superseding #3252): capture the slot's synthesised worktree
    # branch BEFORE the slot is nulled below. It is now THE cycleId reap's
    # cycle-record write is keyed on (see `_fire_cycle_record`), so the
    # test-count-bearing write and the merge-watch enrichment land on ONE indexed
    # record instead of un-joinable twins — `testsAfter` therefore stops recording
    # 0 on the sampled record. None when the slot is absent (signal class /
    # cleared): those keep keying on task_id (their cycleId IS the task_id).
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

    # Issue #2450 originally warned on deposit-ABSENT — but issue #3734
    # established that's backwards for this bucket: `do_reflect()` in
    # reflection-deposit.sh only ever WRITES hydra-refl-sources-<task_id> when it
    # has a non-empty bucket to report. When `GET /api/reflections` serves
    # nothing — still true for the large majority of anchors while the
    # reflection store itself is thin — the file is never created at all, so
    # deposit-absent is the STRUCTURAL, honest common case, not a plumbing
    # signal. Gating the WARN on ABSENT therefore fired on (almost) every
    # code-writing reap regardless of whether the deposit recipe was healthy:
    # zero signal value (confirmed live: 208 anchor deposits recorded, 0
    # refl-sources deposits, fully explained by an empty reflection store rather
    # than a broken deposit — see #3734).
    #
    # The genuinely suspicious presence states are the ones that mean the recipe
    # ran (or should have) and produced something OTHER than a clean "nothing to
    # report":
    #   - no-task-id    — the deposit script could not derive a task_id at all
    #                     (cwd wasn't a recognised worktree layout); it can never
    #                     have written anything, and every other task-keyed
    #                     deposit degrades the same way.
    #   - deposit-empty — a deposit file exists but is blank. `do_reflect()`
    #                     never intentionally writes an empty file (it skips the
    #                     write entirely when there is nothing to report), so
    #                     this shape only happens on a truncated/corrupt write.
    #   - read-error    — the deposit file exists but reap could not read it.
    # deposit-absent no longer warns — it is the honest majority baseline, and
    # deposit-present obviously never warns either.
    # hydra-grill is excluded regardless: it writes a design-concept artifact,
    # not a reflection-source deposit, so it never runs this recipe at all.
    # Best-effort: print to stderr (operator-visible) AND append to the run log.
    if (skill in REFLECTION_DEPOSIT_SKILLS and
            reflection_presence in (
                REFL_PRESENCE_EMPTY, REFL_PRESENCE_READ_ERROR, REFL_PRESENCE_NO_TASK_ID,
            )):
        warn_msg = (
            f"refl_deposit_broken skill={skill} task_id={task_id} "
            f"anchor={anchor_ref or ''} presence={reflection_presence} — the "
            f"deposit recipe ran but the reflection-source file is unkeyable, "
            f"unreadable, or blank; check for refl-deposit-no-task-id / "
            f"refl-deposit-write-failed in the child's stderr "
            f"(cue: refl-deposit-broken-on-code-write)"
        )
        print(f"[autopilot] WARN {warn_msg}", file=sys.stderr)
        _append_log(f"WARN {warn_msg}")

    # Issue #3839: stamp the classified outcome onto the run-log line, and —
    # when the caller supplied a latest-segment count — that value, so an
    # operator reading the log can distinguish a per-segment cap applied to a
    # (healthy) resumed dispatch from a genuine single-segment runaway. Both
    # fields are appended (the line grew additively over prior issues);
    # existing key=value parsers tolerate the trailing fields.
    last_seg_field = f" last_seg={last_segment_tokens}" if last_segment_tokens is not None else ""
    line = (
        f"slot_complete class={cls} skill={skill or '?'} task_id={task_id} "
        f"tokens={total_tokens} cumulative={s['cumulative_tokens']} "
        f"duration_ms={duration_ms} task_title={anchor_ref or ''} "
        f"refl_sources={reflection_sources or ''} "
        f"refl_presence={reflection_presence} status={status}{last_seg_field}"
    )
    print(f"[autopilot] {line}")
    _append_log(line)

    # Issue #430: fire a cycle-record write for code-writing classes so
    # /api/cycle/history and /api/metrics reflect post-PR-3 reality. Status
    # at reap time is "completed" — the autopilot doesn't know merge vs
    # abandon until later (the auto-merge action handler bumps it via the
    # idempotent endpoint with status=merged). For runaway/burned reaps
    # we tag the cycle as "failed" so the cycles-failed counter ticks.
    # `soft_cap_hit` / `status` are computed once, above, from cap_check_value
    # (last_segment_tokens when supplied, else total_tokens) so the burn
    # decision and this cycle-record status stay in lock-step (issue #3839).
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

    # Issue #3866: a dev_orch completion that opened no PR is a STALL, not a
    # finished cycle — relabel the anchor away from ready-for-agent (so it
    # can never re-surface for a from-scratch redo) and queue it for a
    # pinned resume dispatch. Fully best-effort/non-fatal; runs after the
    # reflection fire above so a `gh` hiccup here can never affect the
    # accounting/reflection writes that already landed.
    _handle_dev_orch_stall(s, cls, skill, anchor_ref, task_id, worktree_branch)

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
        #                            [last_segment_tokens]
        # Issue #3839: last_segment_tokens is an OPTIONAL trailing positional
        # carrying the LATEST segment's token count for a RESUMED dispatch
        # (whose per-segment counts are summed into total_tokens for this one
        # call). When supplied, the soft cap is applied to that single latest
        # segment rather than the summed cumulative total — the cap bounds ONE
        # subagent (the most recent unit of work), not one dispatch's recovery
        # history. Omitted → the legacy cap-against-total path, byte-for-byte.
        # Trailing after [skill], so every existing ≤5-arg invocation parses
        # and behaves identically (a pure additive extend — design-concept #3839).
        args = argv[2:]
        if len(args) < 3:
            print(
                "[autopilot] reap completion usage: completion <class> <task_id> "
                "<total_tokens> [skill] [last_segment_tokens]",
                file=sys.stderr,
            )
            return 0
        cls = args[0]
        task_id = args[1]
        try:
            total_tokens = int(args[2])
        except ValueError:
            print(f"[autopilot] reap completion: invalid total_tokens={args[2]!r}", file=sys.stderr)
            return 0
        skill = args[3] if len(args) > 3 else None
        last_segment_tokens: int | None = None
        if len(args) > 4:
            try:
                last_segment_tokens = int(args[4])
            except ValueError:
                # FAIL-SAFE: a non-numeric latest-segment value cannot be
                # trusted, so treat it as omitted (cap falls back to the
                # cumulative total) rather than risking a silent under-cap.
                print(
                    f"[autopilot] reap completion: invalid "
                    f"last_segment_tokens={args[4]!r}; capping against total_tokens",
                    file=sys.stderr,
                )
                last_segment_tokens = None
        return run_completion(cls, task_id, total_tokens, skill, last_segment_tokens=last_segment_tokens)

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
