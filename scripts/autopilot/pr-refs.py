#!/usr/bin/env python3
"""pr-refs.py — the ONE reference-detection predicate for autopilot open-PR
guards (issue #3852).

Reads `gh pr list --json headRefName,body` JSON from stdin and prints the
space-separated set of issue numbers that the open PRs reference, via EITHER:

  * the `issue-<N>-<slug>` head-branch convention (hydra-dev's branch name), OR
  * a keyword ref in the PR body — a GitHub closing verb (Closes / Fixes /
    Resolves, any tense) OR the non-closing `Refs #N` form.

This is the shared extractor issue #3852 asks for, and since #4334 it is the
ONLY copy: collect-state.sh computes all three of its in-flight exclusion
sets by piping its `gh pr list` payload through THIS script (no selector =
the union `ORCH_INFLIGHT_ISSUES`; `--source branch` / `--source body` = the
per-channel subsets its Candidate Exclusion telemetry attributes, #3964),
recover-stale.sh pipes its payload through the zero-arg union form, and
reap.py imports the narrower `closing_issues()` predicate. A change to the
reference-detection rule (a new closing verb, a branch-naming convention
change) is therefore made ONCE here.

`closing_issues()` (issue #4045) is a second, NARROWER predicate over the
same JSON shape: issue numbers an open PR actually CLOSES (body closing verb
only — never the branch-name convention, never the non-closing `Refs #N`
form). `reap.py` uses it to promote an issue from `ready-for-agent` to
`needs-qa` once a real closing PR exists, which is a stricter bar than
`referenced_issues()`'s "this PR is at least related to the issue".

`branch_issues()` / `bodyref_issues()` (issue #4334) expose the two evidence
CHANNELS of `referenced_issues()` separately, for the per-source attribution
collect-state.sh's Candidate Exclusion telemetry needs — which matcher
actually fired for a given anchor. They are strict subsets of the union by
construction (same regexes, one channel each).

Pure: stdin JSON in, stdout numbers out. It NEVER shells out to `gh` — the
callers (collect-state.sh, recover-stale.sh) own the `gh pr list` call and
the never-abort degradation contract. Any parse error prints nothing and
exits 0: an empty result is the caller's "no open PR" signal, which falls
through to today's behaviour (re-queue to ready-for-agent). An unknown
`--source` value is the one loud failure (exit 2): the bash call sites wrap
the invocation in `2>/dev/null || true`, so it degrades to the documented
empty-set no-op while staying diagnosable when run by hand.
"""

import json
import re
import sys

# `issue-<N>` head-branch prefix (the `-<slug>` tail is optional). `\b` after
# the digits stops `issue-385` matching branch `issue-3852-foo`. `re.match`
# anchors at the start of the head ref.
_BRANCH_RE = re.compile(r"issue-(\d+)\b")

# PR-body keyword refs: GitHub closing verbs (close / fix / resolve, any tense)
# PLUS the non-closing `Ref(s) #N` form (issue #3851). Case-insensitive.
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

def _prs(pr_json):
    """Parse a `gh pr list --json` payload into its PR dict rows.

    Anything unparsable — empty stdin (a failed `gh pr list`), non-JSON, a
    non-list top level — degrades to NO rows, which every selector then folds
    into the empty set: the fail-open contract the never-abort callers rely on.
    """
    try:
        prs = json.loads(pr_json)
    except Exception:
        return []
    if not isinstance(prs, list):
        return []
    return [p for p in prs if isinstance(p, dict)]


def _branch_refs(pr):
    """The issue numbers one PR row references via its head-branch name."""
    m = _BRANCH_RE.match(pr.get("headRefName") or "")
    return {int(m.group(1))} if m else set()


def _body_refs(pr):
    """The issue numbers one PR row references via body keyword refs."""
    return {int(m.group(1)) for m in _BODY_RE.finditer(pr.get("body") or "")}


def referenced_issues(pr_json):
    """Return the set of ints referenced by the open-PR JSON on stdin.

    The UNION of both evidence channels: the `issue-<N>` head-branch
    convention OR a body keyword ref (closing verb or `Refs #N`).
    """
    out = set()
    for pr in _prs(pr_json):
        out |= _branch_refs(pr)
        out |= _body_refs(pr)
    return out


def branch_issues(pr_json):
    """Return the set of ints referenced via the head-branch convention only.

    One channel of `referenced_issues()` in isolation (issue #4334), exposed
    for collect-state.sh's per-source Candidate Exclusion telemetry (#3964):
    distinguishing "the branch matcher fired" from "the body matcher fired".
    """
    out = set()
    for pr in _prs(pr_json):
        out |= _branch_refs(pr)
    return out


def bodyref_issues(pr_json):
    """Return the set of ints referenced via PR-body keyword refs only.

    The other channel of `referenced_issues()` in isolation (issue #4334),
    same telemetry rationale as `branch_issues()`.
    """
    out = set()
    for pr in _prs(pr_json):
        out |= _body_refs(pr)
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
    for pr in _prs(pr_json):
        for m in _CLOSE_RE.finditer(pr.get("body") or ""):
            out.add(int(m.group(1)))
    return out


def _selector_for(argv):
    """Map argv onto a predicate. Zero args = the union (the contract
    recover-stale.sh and the hydra-dev parent flow already depend on);
    `--source branch|body` picks one channel; anything else exits 2."""
    if not argv:
        return referenced_issues
    if len(argv) == 2 and argv[0] == "--source" and argv[1] in ("branch", "body"):
        return branch_issues if argv[1] == "branch" else bodyref_issues
    sys.stderr.write(
        "usage: pr-refs.py [--source branch|body] < gh-pr-list-JSON\n"
        f"unknown arguments: {' '.join(argv)}\n"
    )
    sys.exit(2)


def main():
    nums = _selector_for(sys.argv[1:])(sys.stdin.read())
    if nums:
        # Space-separated, sorted for determinism. No trailing newline needed —
        # callers word-split. An empty set prints nothing (= "no open PR").
        sys.stdout.write(" ".join(str(n) for n in sorted(nums)))


if __name__ == "__main__":
    main()
