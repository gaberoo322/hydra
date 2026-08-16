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

`closing_issues()` (issue #4045) is a second, NARROWER predicate over the
same JSON shape: issue numbers an open PR actually CLOSES (body closing verb
only — never the branch-name convention, never the non-closing `Refs #N`
form). `reap.py` uses it to promote an issue from `ready-for-agent` to
`needs-qa` once a real closing PR exists, which is a stricter bar than
`referenced_issues()`'s "this PR is at least related to the issue".

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

# Closing-verb-only subset of _BODY_RE (issue #4045) — deliberately EXCLUDES
# the non-closing `Ref(s) #N` form and never matches on branch name alone.
# GitHub's own auto-close mechanism keys on exactly these verbs in a PR body,
# so this is the predicate for "this PR marks the issue done", not merely
# "this PR is related to the issue".
_CLOSE_RE = re.compile(
    r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b",
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


def closing_issues(pr_json):
    """Return the set of ints an open PR ACTUALLY CLOSES (issue #4045).

    Narrower than `referenced_issues()` on purpose: a bare `issue-<N>`
    branch-name match or a non-closing `Refs #N` body keyword both count as
    "referenced" (enough to say a dev_orch dispatch didn't stall — see
    `reap.py`'s `_dev_orch_pr_exists_for_anchor`), but neither means the PR
    is actually done and ready for review. Only a real GitHub closing verb
    in the PR body (Closes/Fixes/Resolves, any tense) counts here — this is
    the predicate `reap.py` uses to promote an issue from `ready-for-agent`
    to `needs-qa`, and promoting on a merely-related PR would move an issue
    into the review lane before it's reviewable.
    """
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
        for m in _CLOSE_RE.finditer(pr.get("body") or ""):
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
