#!/usr/bin/env python3
"""
reap.py — Phase 2 of /hydra-autopilot, in-flight hard-cap enforcement.

For each occupied class slot in /tmp/hydra-autopilot-state.json whose
harness exposes a partial token count via `slot.partial_tokens`,
compare against `limits.subagent_hard_max_tokens` (issue #395):

  * If partial_tokens >= hard cap, ABANDON the slot:
      - clear slots[<class>]
      - append <class> to burned_classes (suppresses re-dispatch this session)
      - file a `needs-triage` issue documenting the runaway

The completion-reap loop (Phase 2 step 2) and soft-cap evaluation
remain in the playbook prose because they depend on TaskNotification
results not present in state.json.

This script writes back to /tmp/hydra-autopilot-state.json in place.
It is idempotent: re-running with no new partial-token updates is a
no-op. Exit code is always 0 — failure to file a GitHub issue is
logged but not fatal.

Behavior-preserving extraction of the Phase 2 in-flight-poll heredoc
(issue #409).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

STATE_PATH = Path(os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json"))
REPO = os.environ.get("HYDRA_AUTOPILOT_REPO", "gaberoo322/hydra")


def main() -> int:
    if not STATE_PATH.exists():
        print(f"[autopilot] reap: state file missing at {STATE_PATH}; skipping", file=sys.stderr)
        return 0
    s = json.loads(STATE_PATH.read_text())
    hard = s["limits"]["subagent_hard_max_tokens"]
    soft = s["limits"]["subagent_max_tokens"]
    runaways: list[tuple[str, str, int]] = []
    for cls, slot in list(s["slots"].items()):
        if slot is None:
            continue
        partial = slot.get("partial_tokens") or 0
        if partial >= hard:
            # Hard-cap trip: abandon slot, file diagnostic issue, mark class burned.
            runaways.append((cls, slot.get("skill", "?"), partial))
            s["slots"][cls] = None
            if cls not in s.get("burned_classes", []):
                s.setdefault("burned_classes", []).append(cls)
    STATE_PATH.write_text(json.dumps(s))
    for cls, skill, tokens in runaways:
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
