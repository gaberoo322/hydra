#!/usr/bin/env python3
"""audit-ghost-writes.py — one-off (or periodic) audit probe for issue #549.

Walks the Claude Code subagent JSONL transcripts and flags any historical
dispatch that wrote outside its worktree namespace via the Edit/Write/
MultiEdit tools. Useful BEFORE shipping the PreToolUse fence (to size the
problem) and AFTER (to confirm the rate goes to zero).

Transcript layout (per the hydra-dev hook + research in issue #549):

    ~/.claude/projects/-home-gabe-hydra/<session-uuid>/subagents/agent-<task-id>.jsonl
    ~/.claude/projects/-home-gabe-hydra-betting/<session-uuid>/subagents/agent-<task-id>.jsonl

Each line is a JSON object representing a turn or tool event. Format
observed:

    - The first user message has top-level "cwd" and "gitBranch" — that's the
      per-dispatch worktree root.
    - Tool calls appear as messages with role=assistant and
      message.content[].type == "tool_use", containing:
        name in {"Edit","Write","MultiEdit"}
        input.file_path (absolute string)

A ghost-write is any tool_use whose file_path is under the "main tree" for
the project (/home/gabe/hydra/ or /home/gabe/hydra-betting/) but NOT under
the dispatch cwd, where cwd itself is a recognised worktree namespace.

Output: a JSON report on stdout summarising rate and per-dispatch detail.
Exit 0 always — this is a probe, not a gate. The CI gate is the
PreToolUse fence at ~/.claude/hooks/hydra/worktree-write-fence.sh.

Usage:
    python3 scripts/audit-ghost-writes.py
    python3 scripts/audit-ghost-writes.py --since 2026-04-01
    python3 scripts/audit-ghost-writes.py --root ~/.claude/projects/-home-gabe-hydra
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Iterable

WORKTREE_PREFIXES = (
    "/home/gabe/hydra/.claude/worktrees/",
    "/dev/shm/hydra-worktrees/",
    "/home/gabe/hydra-worktrees/",
)

MAIN_TREE_PREFIXES = (
    "/home/gabe/hydra/",
    "/home/gabe/hydra-betting/",
)

WRITE_TOOLS = {"Edit", "Write", "MultiEdit"}

DEFAULT_PROJECT_ROOTS = (
    Path.home() / ".claude" / "projects" / "-home-gabe-hydra",
    Path.home() / ".claude" / "projects" / "-home-gabe-hydra-betting",
)


def is_worktree(path: str) -> bool:
    if not path:
        return False
    return any(path.startswith(p) for p in WORKTREE_PREFIXES)


def under_main_tree(path: str) -> str | None:
    """Return the matching main-tree prefix if path is under one."""
    for p in MAIN_TREE_PREFIXES:
        if path.startswith(p):
            return p
    return None


def iter_transcripts(roots: Iterable[Path]) -> Iterable[Path]:
    for root in roots:
        if not root.exists():
            continue
        # Layout: <root>/<session-uuid>/subagents/agent-<task-id>.jsonl
        yield from root.glob("*/subagents/agent-*.jsonl")


def extract_writes(transcript: Path) -> list[dict]:
    """Yield {tool, file_path, ts?} for every Edit/Write/MultiEdit call."""
    out = []
    try:
        with transcript.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = obj.get("message")
                if not isinstance(msg, dict):
                    continue
                content = msg.get("content")
                if not isinstance(content, list):
                    continue
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") != "tool_use":
                        continue
                    name = item.get("name")
                    if name not in WRITE_TOOLS:
                        continue
                    file_path = (item.get("input") or {}).get("file_path") or ""
                    if not file_path:
                        # MultiEdit may carry a list of edits; tolerate.
                        edits = (item.get("input") or {}).get("edits") or []
                        if isinstance(edits, list) and edits:
                            file_path = (edits[0] or {}).get("file_path") or ""
                    if not file_path:
                        continue
                    out.append({
                        "tool": name,
                        "file_path": file_path,
                        "ts": obj.get("timestamp"),
                    })
    except OSError:
        pass
    return out


def extract_cwd(transcript: Path) -> str | None:
    """Read the dispatch cwd from the first turn that carries it."""
    try:
        with transcript.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                cwd = obj.get("cwd")
                if isinstance(cwd, str) and cwd:
                    return cwd
    except OSError:
        return None
    return None


def parse_timestamp(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        # ISO-8601 with Z suffix is the harness convention.
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def audit(roots: list[Path], since: datetime | None) -> dict:
    total_dispatches = 0
    worktree_dispatches = 0
    ghost_dispatches = 0
    ghost_writes = 0
    total_writes_in_worktree_dispatches = 0
    offenders: list[dict] = []

    for transcript in iter_transcripts(roots):
        total_dispatches += 1
        cwd = extract_cwd(transcript)
        if not is_worktree(cwd or ""):
            continue
        worktree_dispatches += 1
        writes = extract_writes(transcript)
        if not writes:
            continue
        ghost_for_dispatch = []
        for w in writes:
            ts = parse_timestamp(w.get("ts"))
            if since and ts and ts < since:
                continue
            total_writes_in_worktree_dispatches += 1
            mt = under_main_tree(w["file_path"])
            if not mt:
                continue
            # If file_path is under cwd, it's expected. Otherwise it's a ghost.
            if w["file_path"].startswith(cwd.rstrip("/") + "/"):
                continue
            ghost_for_dispatch.append(w)
            ghost_writes += 1
        if ghost_for_dispatch:
            ghost_dispatches += 1
            offenders.append({
                "transcript": str(transcript),
                "cwd": cwd,
                "ghost_writes": ghost_for_dispatch,
            })

    return {
        "total_dispatches_scanned": total_dispatches,
        "worktree_dispatches": worktree_dispatches,
        "writes_in_worktree_dispatches": total_writes_in_worktree_dispatches,
        "ghost_dispatches": ghost_dispatches,
        "ghost_writes": ghost_writes,
        "ghost_dispatch_rate": (
            round(ghost_dispatches / worktree_dispatches, 4)
            if worktree_dispatches
            else 0.0
        ),
        "ghost_write_rate": (
            round(ghost_writes / total_writes_in_worktree_dispatches, 4)
            if total_writes_in_worktree_dispatches
            else 0.0
        ),
        "offenders": offenders,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "")
    parser.add_argument("--root", action="append", default=None,
                        help="JSONL transcript root (repeatable). "
                             "Defaults to the standard hydra + hydra-betting roots.")
    parser.add_argument("--since", default=None,
                        help="Filter writes to those at or after this ISO-8601 date.")
    parser.add_argument("--indent", type=int, default=2)
    args = parser.parse_args()

    roots = [Path(r).expanduser() for r in args.root] if args.root else list(DEFAULT_PROJECT_ROOTS)
    since = None
    if args.since:
        try:
            since = datetime.fromisoformat(args.since)
        except ValueError:
            print(f"audit-ghost-writes: bad --since value '{args.since}'", file=sys.stderr)
            return 1

    report = audit(roots, since)
    json.dump(report, sys.stdout, indent=args.indent, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
