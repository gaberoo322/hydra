#!/usr/bin/env bash
# Shared backfill dedup baseline: the titles of every OPEN issue plus every issue
# CLOSED inside the dedup window, one title per line on stdout. Feed it to
# scripts/ci/issue-dedup.ts as the baseline (hydra-architecture-scan,
# hydra-discover and hydra-research all call this one script).
#
# The window and limit live ONLY here. The limit is explicit because `gh issue
# list` silently defaults to 30 rows, which dropped most of the closed half.
# Fails loud: a failed `gh` call exits non-zero, never a silently-empty baseline
# (an empty baseline makes every candidate look novel).
set -euo pipefail

BASELINE_LIMIT="${BASELINE_LIMIT:-1000}"
DEDUP_WINDOW_DAYS=14
REPO="gaberoo322/hydra"

since="$(date -u -d "${DEDUP_WINDOW_DAYS} days ago" +%F)"

gh issue list --repo "$REPO" --state open --limit "$BASELINE_LIMIT" \
  --json title --jq '.[].title'
gh issue list --repo "$REPO" --state closed --limit "$BASELINE_LIMIT" \
  --search "closed:>=${since}" --json title --jq '.[].title'
