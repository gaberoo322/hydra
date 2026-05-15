#!/usr/bin/env python3
"""
reap.py — Phase 2 of /hydra-autopilot.

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
from pathlib import Path

STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))
LOG_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_LOG", "/tmp/hydra-autopilot-nightly.log"))
REPO = os.environ.get("HYDRA_AUTOPILOT_REPO", "gaberoo322/hydra")

REAPED_TASK_IDS_CAP = 1000

# Code-writing skills whose completions trip a cycle-record write
# (issue #430). QA, research, and discover dispatches are subagent work but
# don't fit the "cycle" semantic — a cycle here is one autopilot turn that
# dispatched a code-writing class (ADR-0006). Sweeping/research dispatches
# stay observable via the run log and the existing capacity writeback.
CYCLE_RECORD_SKILLS = {"hydra-dev", "hydra-target-build"}
CYCLE_RECORD_SCRIPT = Path(__file__).parent / "dispatch.sh"


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


def _fire_cycle_record(
    task_id: str,
    skill: str | None,
    status: str,
    total_tokens: int,
) -> None:
    """Best-effort POST to /api/autopilot/cycle-record (issue #430).

    Only fires for code-writing dispatches (hydra-dev / hydra-target-build) —
    that's the post-PR-3 definition of an autopilot "cycle". Failures are
    swallowed: cycle-record writes are observability, not correctness, and
    must never block the reap path. The cycle-record endpoint is itself
    idempotent on cycleId, so retries are safe.

    The cycleId we send is the autopilot task_id, which the harness allocates
    once per dispatch — that gives natural dedup across retries.
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
                "0",  # duration_ms — reap doesn't track wall-clock per task
            ],
            check=False,
            capture_output=True,
            timeout=10,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        _append_log(f"cycle_record_skipped task_id={task_id} err={exc}")


def run_hardcap() -> int:
    """Default mode: hard-cap enforcement against `partial_tokens`."""
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
    slots = s.get("slots") or {}
    slot = slots.get(cls)
    if slot is not None:
        slot["tokens"] = total_tokens
        s["slots"][cls] = None  # release the pipeline slot

    _save_state(s)

    line = (
        f"slot_complete class={cls} skill={skill or '?'} task_id={task_id} "
        f"tokens={total_tokens} cumulative={s['cumulative_tokens']}"
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
    _fire_cycle_record(task_id, skill, status, total_tokens)

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

    print(f"[autopilot] reap: unknown subcommand {sub!r}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
