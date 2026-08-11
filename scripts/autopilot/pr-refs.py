#!/usr/bin/env python3
"""pr-refs.py — the ONE reference-detection predicate for autopilot open-PR
guards (issue #3852).

Reads `gh pr list --json headRefName,body` JSON from stdin and prints the
space-separated set of issue numbers that the open PRs reference, via EITHER:

  * the `issue-<N>-<slug>` head-branch convention (hydra-dev's branch name), OR
  * a keyword ref in the PR body — a GitHub closing verb (Closes / Fixes /
    Resolves, any tense) OR the non-closing `Refs #N` form.

This is the shared extractor issue #3852 asks for. collect-state.sh's in-flight
exclusion (lines ~491-507) carries the SAME branch-prefix + closing-keyword
shape but MISSES the `Refs #N` form (a separately-filed gap). Once that gap is
closed, collect-state.sh should call THIS script instead of its inline copy, so
the two predicates can never drift; until then this is the BROADER of the two
(it never under-detects relative to collect-state.sh).

Pure: stdin JSON in, stdout numbers out. It NEVER shells out to `gh` — the
caller (recover-stale.sh) owns the `gh pr list` call and the never-abort
degradation contract. Any parse error prints nothing and exits 0: an empty
result is the caller's "no open PR" signal, which falls through to today's
behaviour (re-queue to ready-for-agent).
"""

import json
import re
import sys

# `issue-<N>` head-branch prefix (the `-<slug>` tail is optional). `\b` after
# the digits stops `issue-385` matching branch `issue-3852-foo`. `re.match`
# anchors at the start of the head ref, matching collect-state.sh's extractor.
_BRANCH_RE = re.compile(r"issue-(\d+)\b")

# PR-body keyword refs: GitHub closing verbs (close / fix / resolve, any tense)
# PLUS the non-closing `Ref(s) #N` form. Mirrors collect-state.sh's in-flight
# body regex, broadened with `refs?`. Case-insensitive.
_BODY_RE = re.compile(
    r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s*:?\s+#(\d+)\b",
    re.IGNORECASE,
)


def referenced_issues(pr_json):
    """Return the set of ints referenced by the open-PR JSON on stdin."""
    out = set()
    try:
        prs = json.loads(pr_json)
    except Exception:
        return out
    if not isinstance(prs, list):
        return out
    for pr in prs:
        if not isinstance(pr, dict):
            continue
        m = _BRANCH_RE.match(pr.get("headRefName") or "")
        if m:
            out.add(int(m.group(1)))
        for m in _BODY_RE.finditer(pr.get("body") or ""):
            out.add(int(m.group(1)))
    return out


def main():
    nums = referenced_issues(sys.stdin.read())
    if nums:
        # Space-separated, sorted for determinism. No trailing newline needed —
        # callers word-split. An empty set prints nothing (= "no open PR").
        sys.stdout.write(" ".join(str(n) for n in sorted(nums)))


if __name__ == "__main__":
    main()
