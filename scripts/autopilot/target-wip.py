#!/usr/bin/env python3
"""target-wip.py — the ONE source of truth for the Target WIP limit and the
liveness predicate that decides which `in-progress` claims count toward it
(issue #4475, CSB swap prep, ex-#4241; design-concept issue-4475).

Two callers share this leaf so their gates can never disagree:

  * `collect-state.sh` (`collect_target_board`) pipes the Target lane's open
    `in-progress` issue numbers + open-PR REST payload through it and emits
    the four `target_wip_*` / `target_in_progress` keys; the autopilot
    promotes `target_wip_saturated` into `state.signals`, and `decide.py`
    suppresses `dev_target` while it is true.
  * `hydra-target-build` Step 1's pre-flight WIP gate calls it with the same
    inputs instead of a hard-coded raw `label:in-progress` total_count vs 3.

Before this leaf the limit lived only inside the build playbook, AFTER the
dispatch was already paid for (~80k tokens per bounce), and a bare label
count re-introduces the orphaned-claim false positive: a crashed build
leaves `in-progress` on an issue nobody is working.

LIVENESS PREDICATE. A Target issue carrying `in-progress` counts toward WIP
iff it is referenced by an OPEN Target PR (drafts included). "Referenced" is
decided ONLY by pr-refs.py's `referenced_issues()` (loaded via importlib, the
reap_ghrefs.py pattern) — this file adds no issue-reference regex.

    live      = |InProgress ∩ P|
    saturated = live >= TARGET_WIP_LIMIT

Why no dev_target slot lookup is needed: `dev_target` is a single pipeline
slot, so decide.py only reaches its selector when that slot is null — no live
dev_target dispatch exists in the run. A no-PR claim at that moment is
orphaned. A live build that opens a PR becomes PR-backed; one that ends
without a PR is released to `ready-for-agent` by
`reap_stall._handle_dev_target_stall` (#4195). Recency (label, comment,
commit) is never used as liveness evidence.

CONTRACT (pure — never shells out to `gh`):
  default   stdin JSON `{"in_progress": [int, ...], "prs": [{headRefName, body}, ...]}`
            stdout exactly four lines, in order:
              target_wip_limit=<int>
              target_in_progress=<raw in-progress count>
              target_wip_live=<int>
              target_wip_saturated=true|false
            Malformed / non-JSON stdin → the four keys with live 0 and
            saturated=false plus a stderr note (FAIL OPEN), exit 0.
  --limit   stdout the integer limit only.
  anything else → usage on stderr, exit 2.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

# The Target WIP limit (ADR-0031 Decision 4). The ONLY place this literal
# lives — collect-state.sh and hydra-target-build both read it through this
# script.
TARGET_WIP_LIMIT = 3


def _load_pr_refs_module():
    """Load the hyphenated sibling pr-refs.py via importlib (reap_ghrefs.py pattern)."""
    spec = importlib.util.spec_from_file_location(
        "hydra_autopilot_pr_refs", Path(__file__).resolve().parent / "pr-refs.py"
    )
    if spec is None or spec.loader is None:
        raise ImportError("cannot load pr-refs.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def wip_status(in_progress, prs, limit: int = TARGET_WIP_LIMIT) -> dict:
    """Pure liveness computation over already-fetched inputs."""
    ip = {int(n) for n in (in_progress or []) if isinstance(n, int) and not isinstance(n, bool)}
    rows = [p for p in (prs or []) if isinstance(p, dict)]
    referenced = _load_pr_refs_module().referenced_issues(json.dumps(rows))
    live = len(ip & referenced)
    return {
        "limit": limit,
        "in_progress": len(ip),
        "live": live,
        "saturated": live >= limit,
    }


def _format(status: dict) -> str:
    return (
        f"target_wip_limit={status['limit']}\n"
        f"target_in_progress={status['in_progress']}\n"
        f"target_wip_live={status['live']}\n"
        f"target_wip_saturated={'true' if status['saturated'] else 'false'}\n"
    )


def _fail_open(reason: str) -> str:
    sys.stderr.write(
        f"target-wip.py: {reason} — failing OPEN (target_wip_saturated=false, issue #4475)\n"
    )
    return _format({"limit": TARGET_WIP_LIMIT, "in_progress": 0, "live": 0, "saturated": False})


def compute_from_stdin(raw: str) -> str:
    try:
        payload = json.loads(raw)
    except Exception:
        return _fail_open("stdin is not JSON")
    if not isinstance(payload, dict):
        return _fail_open("stdin JSON is not an object")
    in_progress = payload.get("in_progress")
    prs = payload.get("prs")
    if not isinstance(in_progress, list) or not isinstance(prs, list):
        return _fail_open("stdin JSON lacks list-valued in_progress/prs")
    try:
        return _format(wip_status(in_progress, prs))
    except Exception as exc:  # pr-refs.py load failure etc.
        return _fail_open(f"liveness computation failed ({exc})")


def main(argv: list[str]) -> int:
    args = argv[1:]
    if args == ["--limit"]:
        sys.stdout.write(f"{TARGET_WIP_LIMIT}\n")
        return 0
    if args:
        sys.stderr.write(
            "usage: target-wip.py [--limit] < {\"in_progress\": [...], \"prs\": [...]}\n"
            f"unknown arguments: {' '.join(args)}\n"
        )
        return 2
    sys.stdout.write(compute_from_stdin(sys.stdin.read()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
