#!/usr/bin/env python3
"""
self_heal.py — Failure-pattern → retry-strategy table for /hydra-autopilot
(issue #426).

When a dispatched subagent (hydra-dev, hydra-qa, hydra-target-build, ...)
fails, the autopilot appends a one-line JSON record to
`/tmp/hydra-autopilot-failures.jsonl` and also to
`state.failure_log`. The next decide() tick reads those records to
pick a retry strategy: re-dispatch with a tweaked prompt, requeue
the issue, escalate to operator, or give up.

==================================================================
FAILURE-MODE SELF-HEAL TABLE (single source of truth)
==================================================================

Each pattern is matched against the failure record's `cue` field
(produced by the dispatching wrapper). The table is checked in order;
first match wins. Patterns are conservative: an unmatched failure
falls through to `unknown`, which simply re-queues `ready-for-agent`
and stays out of the autopilot's way.

  pattern                       retry strategy (label changes / re-dispatch)
  -------                       --------------------------------------------
  worktree-isolation-broken     ABORT — never auto-retry; surface to operator.
                                Isolation breaches are infra bugs, not
                                model bugs. Tagged feedback_bg_agent_worktree_hygiene
                                in operator memory.
  verification-failure          Re-queue ready-for-agent + comment with prior
                                stderr digest so next subagent reads it.
                                Cap at 3 retries per issue.
  no-diff                       Re-queue ready-for-agent + comment "previous
                                attempt made zero changes — re-investigate
                                scope".
  rollback                      Open a needs-research issue with the
                                rollback SHA; escalate to operator at retry=3.
  scope-violation               Re-queue with a stricter scope-justification
                                requirement.
  test-timeout                  Re-dispatch with reduced scope (single
                                test file) on the same issue.
  ci-flake                      Re-dispatch unchanged after 5min wait.
                                Cap at 5 retries.
  ratelimit                     Sleep 10min then re-dispatch unchanged.
  unknown                       Re-queue ready-for-agent + needs-triage.

After `MAX_RETRIES_PER_PATTERN` retries on the SAME pattern in a row
for the SAME issue, the autopilot terminates with cause="failure_backstop"
and writes a digest of the prior attempts to /tmp/hydra-autopilot-
failure-digest-<ts>.md. The operator reads the digest at morning review.

==================================================================
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any


# Greppable pattern IDs — keep stable; tests assert on these strings.
PATTERN_WORKTREE_ISOLATION = "worktree-isolation-broken"
PATTERN_VERIFICATION_FAILURE = "verification-failure"
PATTERN_NO_DIFF = "no-diff"
PATTERN_ROLLBACK = "rollback"
PATTERN_SCOPE_VIOLATION = "scope-violation"
PATTERN_TEST_TIMEOUT = "test-timeout"
PATTERN_CI_FLAKE = "ci-flake"
PATTERN_RATELIMIT = "ratelimit"
PATTERN_UNKNOWN = "unknown"

ALL_PATTERNS = (
    PATTERN_WORKTREE_ISOLATION,
    PATTERN_VERIFICATION_FAILURE,
    PATTERN_NO_DIFF,
    PATTERN_ROLLBACK,
    PATTERN_SCOPE_VIOLATION,
    PATTERN_TEST_TIMEOUT,
    PATTERN_CI_FLAKE,
    PATTERN_RATELIMIT,
    PATTERN_UNKNOWN,
)

MAX_RETRIES_PER_PATTERN = 5  # AC: 5-retry escalation per pattern

DEFAULT_FAILURE_LOG = Path(os.environ.get(
    "HYDRA_AUTOPILOT_FAILURE_LOG",
    "/tmp/hydra-autopilot-failures.jsonl",
))


@dataclass
class FailureRecord:
    """One line of /tmp/hydra-autopilot-failures.jsonl."""
    ts: float
    pattern: str
    cue: str
    slot: str
    issue: str | None = None
    note: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class HealStrategy:
    """What decide.py should do about a given failure."""
    pattern: str
    action: str  # "re-dispatch" | "re-queue" | "escalate" | "abort" | "sleep"
    seconds: int = 0
    label_add: tuple[str, ...] = ()
    label_remove: tuple[str, ...] = ()
    comment: str | None = None
    note: str = ""


def classify(cue: str) -> str:
    """Map a free-form cue string to a stable pattern ID.

    `cue` is whatever the dispatching wrapper captured: the first error
    line, a stderr digest, or a stage tag ("verification-failure",
    "no-diff", "rollback"). Matching is case-insensitive substring on a
    short, deterministic list.
    """
    if not cue:
        return PATTERN_UNKNOWN
    c = cue.lower()
    if "worktree" in c and ("main" in c or "isolation" in c or "abort" in c):
        return PATTERN_WORKTREE_ISOLATION
    if "scope" in c and ("violation" in c or "out-of-scope" in c):
        return PATTERN_SCOPE_VIOLATION
    if "verification-failure" in c or "npm test" in c or "tsc" in c or "typecheck" in c:
        return PATTERN_VERIFICATION_FAILURE
    if "no-diff" in c or "zero file changes" in c or "no changes" in c:
        return PATTERN_NO_DIFF
    if "rollback" in c or "auto-reverted" in c:
        return PATTERN_ROLLBACK
    if "timeout" in c and "test" in c:
        return PATTERN_TEST_TIMEOUT
    if "flake" in c or "intermittent" in c:
        return PATTERN_CI_FLAKE
    if "rate" in c and "limit" in c:
        return PATTERN_RATELIMIT
    return PATTERN_UNKNOWN


# Conservative healing strategies. Tests pin the exact action verbs.
_STRATEGY_TABLE: dict[str, HealStrategy] = {
    PATTERN_WORKTREE_ISOLATION: HealStrategy(
        pattern=PATTERN_WORKTREE_ISOLATION,
        action="abort",
        note="Isolation breach — infra bug, never auto-retry. Surface to operator.",
    ),
    PATTERN_VERIFICATION_FAILURE: HealStrategy(
        pattern=PATTERN_VERIFICATION_FAILURE,
        action="re-queue",
        label_add=("ready-for-agent",),
        label_remove=("in-progress",),
        comment="Previous attempt failed verification (npm test / tsc / build). "
                "Re-investigate: read the stderr digest before re-writing.",
        note="Cap at 3 retries per issue (handled by retry-count check).",
    ),
    PATTERN_NO_DIFF: HealStrategy(
        pattern=PATTERN_NO_DIFF,
        action="re-queue",
        label_add=("ready-for-agent",),
        label_remove=("in-progress",),
        comment="Previous attempt made zero file changes. Re-investigate scope.",
    ),
    PATTERN_ROLLBACK: HealStrategy(
        pattern=PATTERN_ROLLBACK,
        action="escalate",
        label_add=("needs-research", "needs-triage"),
        comment="PR merged but auto-rolled-back. Needs human investigation.",
    ),
    PATTERN_SCOPE_VIOLATION: HealStrategy(
        pattern=PATTERN_SCOPE_VIOLATION,
        action="re-queue",
        label_add=("ready-for-agent",),
        label_remove=("in-progress",),
        comment="Previous attempt violated scope. Re-investigate scope-justification.",
    ),
    PATTERN_TEST_TIMEOUT: HealStrategy(
        pattern=PATTERN_TEST_TIMEOUT,
        action="re-dispatch",
        note="Reduce scope: single test file at a time.",
    ),
    PATTERN_CI_FLAKE: HealStrategy(
        pattern=PATTERN_CI_FLAKE,
        action="sleep",
        seconds=300,
        note="CI flake — re-dispatch unchanged after 5 minutes.",
    ),
    PATTERN_RATELIMIT: HealStrategy(
        pattern=PATTERN_RATELIMIT,
        action="sleep",
        seconds=600,
        note="Rate-limit — wait 10 minutes before re-dispatch.",
    ),
    PATTERN_UNKNOWN: HealStrategy(
        pattern=PATTERN_UNKNOWN,
        action="re-queue",
        label_add=("ready-for-agent", "needs-triage"),
        comment="Unrecognised failure cue — back to triage.",
    ),
}


def strategy_for(pattern: str) -> HealStrategy:
    """Return the heal strategy for a given pattern ID. Defaults to UNKNOWN."""
    return _STRATEGY_TABLE.get(pattern, _STRATEGY_TABLE[PATTERN_UNKNOWN])


def consecutive_for_issue(failure_log: list[dict], issue: str | None, pattern: str) -> int:
    """Count the trailing run of (issue, pattern) failures in the log."""
    if not failure_log:
        return 0
    n = 0
    for entry in reversed(failure_log):
        if entry.get("pattern") != pattern:
            break
        if issue and entry.get("issue") != issue:
            break
        n += 1
    return n


def should_escalate(failure_log: list[dict], issue: str | None, pattern: str) -> bool:
    """True iff the retry-cap has been reached for this (issue, pattern) pair."""
    return consecutive_for_issue(failure_log, issue, pattern) >= MAX_RETRIES_PER_PATTERN


# ---------------------------------------------------------------------------
# Failure-log append (best-effort, never raises)
# ---------------------------------------------------------------------------

def append_failure(
    pattern: str,
    cue: str,
    slot: str,
    *,
    issue: str | None = None,
    note: str = "",
    extra: dict[str, Any] | None = None,
    path: Path | str | None = None,
) -> FailureRecord:
    """Append a structured failure record to the rolling JSONL.

    Best-effort: a failed write logs to stderr but never raises, so a
    disk-full condition can't take down the autopilot loop.
    """
    record = FailureRecord(
        ts=time.time(),
        pattern=pattern,
        cue=cue,
        slot=slot,
        issue=issue,
        note=note,
        extra=extra or {},
    )
    p = Path(path) if path is not None else DEFAULT_FAILURE_LOG
    try:
        with p.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(asdict(record)) + "\n")
    except OSError as exc:
        print(f"[autopilot] self_heal: append_failure to {p} failed: {exc}", file=sys.stderr)

    # Issue #1119: re-wire a reflection PRODUCER onto the live path. This is the
    # single chokepoint where a NON-MERGED terminal outcome is decided WITH the
    # anchor (`issue`) + classified pattern (`outcome`) + cue/note (`reason`)
    # all known — exactly the shape `recordAnchorReflection` needs. Fire a
    # best-effort reflection-record POST so the next attempt on this anchor
    # reads its own prior-failure narrative (the #193 retry-correctness
    # invariant the #841 consumers were silently starved of). Fully non-fatal:
    # a missing/uninstalled reap module, an unreachable orchestrator, or any
    # error is swallowed and never propagates back into the self-heal path.
    _fire_reflection_for_failure(record)

    return record


def _fire_reflection_for_failure(record: FailureRecord) -> None:
    """Best-effort reflection-record fire for a non-merged failure (issue #1119).

    Delegates the actual HTTP POST to `reap._fire_reflection_record`, which owns
    the orchestrator-endpoint convention (mirroring `_fire_cycle_record`). The
    import is LAZY + guarded so self_heal stays importable/usable even if reap
    is unavailable (a test harness, a partial checkout), and so a circular-
    import or any runtime error degrades to a no-op rather than breaking the
    failure-log append. Skips when there is no anchor (`issue`) to key on; the
    reap helper additionally skips non-learning-worthy patterns (e.g.
    worktree-isolation-broken).
    """
    if not record.issue:
        return
    try:
        from reap import _fire_reflection_record  # lazy: avoid import coupling
        _fire_reflection_record(
            record.issue,
            record.pattern,
            record.cue or record.note,
            task_title=record.note or None,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort; never break the append
        # Reflection writes are learning, not correctness. A failure here must
        # not propagate into the autopilot self-heal path.
        print(
            f"[autopilot] self_heal: reflection fire skipped issue={record.issue} "
            f"pattern={record.pattern} err={exc}",
            file=sys.stderr,
        )


def read_failure_log(path: Path | str | None = None, *, limit: int = 200) -> list[dict]:
    """Read the most-recent `limit` rows from the JSONL log."""
    p = Path(path) if path is not None else DEFAULT_FAILURE_LOG
    if not p.exists():
        return []
    rows: list[dict] = []
    try:
        with p.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError as exc:
        print(f"[autopilot] self_heal: read_failure_log {p} failed: {exc}", file=sys.stderr)
        return []
    return rows[-limit:]


def digest_for(records: list[dict]) -> str:
    """Render a markdown digest of the latest failure run (one block per row).

    Used by Phase 7 termination when the failure-backstop fires — the
    digest path is referenced in the final hydra-digest summary.
    """
    if not records:
        return "_no failures recorded_\n"
    lines = ["# Autopilot failure digest", ""]
    for rec in records:
        ts = rec.get("ts", 0)
        when = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)) if ts else "?"
        lines.append(f"- **{rec.get('pattern','?')}** at {when} slot=`{rec.get('slot','?')}` issue=`{rec.get('issue','?')}`")
        if rec.get("cue"):
            cue = str(rec["cue"]).replace("\n", " ")[:160]
            lines.append(f"  - cue: {cue}")
        if rec.get("note"):
            lines.append(f"  - note: {rec['note']}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    if len(argv) <= 1:
        print(
            "usage: self_heal.py classify <cue>\n"
            "       self_heal.py strategy <pattern>\n"
            "       self_heal.py append <pattern> <slot> [--issue=N] [--cue=...] [--note=...]\n"
            "       self_heal.py digest",
            file=sys.stderr,
        )
        return 2
    sub = argv[1]
    if sub == "classify":
        if len(argv) < 3:
            print("self_heal.py classify <cue>", file=sys.stderr)
            return 2
        print(classify(argv[2]))
        return 0
    if sub == "strategy":
        if len(argv) < 3:
            print("self_heal.py strategy <pattern>", file=sys.stderr)
            return 2
        s = strategy_for(argv[2])
        print(json.dumps(asdict(s)))
        return 0
    if sub == "append":
        if len(argv) < 4:
            print("self_heal.py append <pattern> <slot> [--issue=N] [--cue=...] [--note=...]", file=sys.stderr)
            return 2
        pattern = argv[2]
        slot = argv[3]
        issue = None
        cue = ""
        note = ""
        for arg in argv[4:]:
            if arg.startswith("--issue="):
                issue = arg[len("--issue="):]
            elif arg.startswith("--cue="):
                cue = arg[len("--cue="):]
            elif arg.startswith("--note="):
                note = arg[len("--note="):]
        rec = append_failure(pattern, cue, slot, issue=issue, note=note)
        print(json.dumps(asdict(rec)))
        return 0
    if sub == "digest":
        print(digest_for(read_failure_log()))
        return 0
    print(f"self_heal.py: unknown subcommand {sub!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
