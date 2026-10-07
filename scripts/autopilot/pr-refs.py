#!/usr/bin/env python3
"""pr-refs.py — the ONE reference-detection predicate for autopilot open-PR
guards (issue #3852).

Reads `gh pr list --json headRefName,body` JSON from stdin and prints the
space-separated set of issue numbers that the open PRs reference, via EITHER:

  * the `issue-<N>-<slug>` head-branch convention (hydra-dev's branch name), OR
  * a keyword ref in the PR body — a GitHub closing verb (Closes / Fixes /
    Resolves, any tense) OR the non-closing `Refs #N` form.

This is the shared extractor issue #3852 asks for, and since #4334 it is the
ONLY copy: collect-state.sh computes all three of its orch-lane in-flight
exclusion sets by piping its `gh pr list` payload through THIS script (no
selector = the union `ORCH_INFLIGHT_ISSUES`; `--source branch` / `--source
body` = the per-channel subsets its Candidate Exclusion telemetry attributes,
#3964), recover-stale.sh pipes its payload through the zero-arg union form,
and reap.py imports the narrower `closing_issues()` predicate. Since #4474
collect-state.sh's Target lane is a FOURTH caller (`collect_target_board`'s
`TARGET_INFLIGHT_ISSUES`, zero-arg union form): it feeds this script a REST
`gh api repos/<target-repo>/pulls` payload projected to the same
`{headRefName, body}` shape rather than a `gh pr list --json` one (ADR-0031
Decision 6 forbids GraphQL-backed `gh --json` reads on the Target hot path) —
this script itself stays PURE stdin-in/numbers-out and gains no repo argument;
the repo is parameterised entirely at the caller's fetch
(`$TARGET_GH_REPO` / `HYDRA_TARGET_GITHUB_REPO`). A change to the
reference-detection rule (a new closing verb, a branch-naming convention
change) is therefore made ONCE here, for every caller.

`closing_issues()` (issue #4045) is a second, NARROWER predicate over the
same JSON shape: issue numbers an open PR actually CLOSES (body closing verb
only — never the branch-name convention, never the non-closing `Refs #N`
form). `reap.py` uses it to promote an issue from `ready-for-agent` to
`needs-qa` once a real closing PR exists, which is a stricter bar than
`referenced_issues()`'s "this PR is at least related to the issue". Since
#4767 a closing verb preceded by a negation (`not` / `cannot` / `n't` /
`n’t` / `never` / `no longer`, optionally with one bounded filler adverb such
as `yet` / `fully`) does NOT count — "Does not close #N" is the companion-PR
idiom, not a close.

`branch_issues()` / `bodyref_issues()` (issue #4334) expose the two evidence
CHANNELS of `referenced_issues()` separately, for the per-source attribution
collect-state.sh's Candidate Exclusion telemetry needs — which matcher
actually fired for a given anchor. They are strict subsets of the union by
construction (same regexes, one channel each).

`merged_issues()` (issue #4690, ADR-0040 Decision 4 row 7) is the MERGED-PR
shipped-work rule the GLM drainer's `issue_has_merged_pr` already enforces,
adopted by the Claude lane: a closing verb over `title + body`, UNION a bare
`(#N)` title anchor (this repo's title convention names the issue even when
the body has no closing keyword). Selected via `--merged`; the caller
(collect-state.sh's dev-pin guard) feeds its `gh pr list --state merged`
payload and refuses to pin any issue in the result — the parity test pins
the regex literal byte-identical to src/github/pr-refs.ts's
`mergedPrReferences()` constants (the #4683 port).

`--closing` (issue #4694) selects the narrow `closing_issues()` predicate
(body closing verb only) from the CLI; hydra-target-build's shipped-anchor
preflight pipes a REST merged-pulls payload through it.

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
#
# Negation guard (issue #4767): a closing verb preceded by a negation is NOT
# a close. A CSB companion PR whose body said, word for word, "Does not close
# #26 — #63 does." was counted as CLOSING #26 here, so the qa_target resolver
# kept re-picking the already-PASSed companion while the real closing PR
# waited. The pattern is a two-arm alternation, NOT a lookbehind (Python re
# rejects variable-width lookbehind, and the guard needs variable width):
#
#   arm 1 (non-capturing) — a negation (`not` / `cannot` / `n't` / `n’t` /
#     `never` / `no longer`), whitespace, at most ONE bounded filler adverb
#     (yet / fully / actually / necessarily / really / entirely /
#     completely), then the verb + `#N`. It CONSUMES the negated ref without
#     capturing, so group(1) is None for that match and the caller skips it.
#   arm 2 (capturing) — the plain closing verb + `#N`.
#
# Leftmost-match semantics make arm 1 win whenever a negation precedes the
# verb (it starts earlier in the string), so "does not yet fix #5",
# "never closes #5", "doesn't fully resolve #5" all drop their number while
# "Closes #1, does not close #2" still yields 1. The parity test pins this
# source byte-identical to src/github/pr-refs.ts's CLOSE_RE. This
# deliberately DISAGREES with GitHub's own auto-close, which ignores
# negation: the authoring rule (hydra-dev child-flow fragment /
# hydra-target-build Step 6.5) makes companion PRs reference the anchor as
# `Refs #N`, removing the only case where the two would disagree. Accepted
# residuals, covered by that rule and pinned in the test table: a filler
# outside the bounded list or more than one filler ("does not quite close
# #N", "does not yet fully close #N") still counts as a close. The guard
# narrows ONLY this predicate: _BODY_RE still counts a negated ref as a
# reference, so the in-flight exclusion stays conservative.
_CLOSE_RE = re.compile(
    r"(?:\b(?:can)?not|n't|n’t|\bnever|\bno\s+longer)\s+(?:(?:yet|fully|actually|necessarily|really|entirely|completely)\s+)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#\d+\b|\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b",
    re.IGNORECASE,
)

# `(#N)` title anchor (issue #4690, ADR-0040 Decision 4 row 7) — the
# `fix(scope): subject (#4130) (#4236)` suffix shape this repo's PR-title
# convention carries even when the body has no closing keyword at all, so a
# merged PR whose work shipped still names its issue. Byte-identical to
# src/github/pr-refs.ts's TITLE_ANCHOR_RE (pinned by the parity test); the
# drainer's `issue_has_merged_pr` jq rule recognises the same shape.
_TITLE_ANCHOR_RE = re.compile(r"\(#(\d+)\)")

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
    """Return the set of ints a PR ACTUALLY CLOSES (issue #4045).

    Consumers: `reap.py` (open PRs) and the hydra-target-build Step 2.1
    shipped-anchor preflight (merged PRs, via `--closing`, issue #4694).

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
            if m.group(1) is not None:  # None = the negated arm (#4767)
                out.add(int(m.group(1)))
    return out


def merged_issues(pr_json):
    """Return the set of ints a (typically MERGED) PR references via the
    drainer's shipped-work rule (issue #4690, ADR-0040 Decision 4 row 7):
    a closing verb over `title + "\\n" + body`, UNION a bare `(#N)` title
    anchor. Mirrors src/github/pr-refs.ts's `mergedPrReferences()` — the
    TS side is the canonical port and this function is kept in lockstep by
    the CLI-parity test in test/github-pr-refs.test.mts.

    Deliberately WIDER than `closing_issues()` and deliberately WITHOUT the
    branch channel of `referenced_issues()`: a MERGED PR answers "did work
    for this issue already ship", and this repo's title convention names
    the issue as a `(#N)` suffix even when the body carries no closing
    keyword — the exact shape that left #4130 open after PR #4236 merged
    (2026-08-27 incident) and got it re-dispatched every tick. The caller
    (collect-state.sh's dev-pin guard) only refuses to PIN the issue;
    closing or re-scoping it stays a human call.
    """
    out = set()
    for pr in _prs(pr_json):
        combined = "{}\n{}".format(pr.get("title") or "", pr.get("body") or "")
        for m in _CLOSE_RE.finditer(combined):
            if m.group(1) is not None:  # None = the negated arm (#4767)
                out.add(int(m.group(1)))
        for m in _TITLE_ANCHOR_RE.finditer(pr.get("title") or ""):
            out.add(int(m.group(1)))
    return out


def _selector_for(argv):
    """Map argv onto a predicate. Zero args = the union (the contract
    recover-stale.sh and the hydra-dev parent flow already depend on);
    `--source branch|body` picks one channel; `--closing` selects the
    closing-verb-only predicate (issue #4767 — exposed so the parity test
    can exercise `closing_issues()` behaviourally through the CLI, the same
    way `--merged` is); `--merged` selects the merged-PR shipped-work rule
    (issue #4690); anything else exits 2."""
    if not argv:
        return referenced_issues
    if len(argv) == 1 and argv[0] == "--merged":
        return merged_issues
    if len(argv) == 1 and argv[0] == "--closing":
        return closing_issues
    if len(argv) == 2 and argv[0] == "--source" and argv[1] in ("branch", "body"):
        return branch_issues if argv[1] == "branch" else bodyref_issues
    sys.stderr.write(
        "usage: pr-refs.py [--source branch|body] [--merged] [--closing] < gh-pr-list-JSON\n"
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
