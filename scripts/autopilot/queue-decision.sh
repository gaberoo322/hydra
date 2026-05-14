#!/usr/bin/env bash
#
# queue-decision.sh — Append an operator-decision row to today's rolling
# `Operator decision queue YYYY-MM-DD` issue in gaberoo322/hydra. Used by
# /hydra-autopilot when running in unattended mode (issue #413) as a
# non-blocking replacement for AskUserQuestion.
#
# Each invocation is idempotent at the issue-creation layer: if today's
# queue issue already exists, the row is appended to its body. If it
# doesn't, a fresh issue is opened with a header row + the new row.
#
# Usage:
#   queue-decision.sh <pr_number> <tier> <reason> <recommendation> [link]
#
# Args:
#   pr_number       e.g. 402 (PR or issue number the decision is about)
#   tier            e.g. 0 / 1 / 2 / 3 (per /api/tier classification)
#   reason          one-line "why is operator being asked" string
#   recommendation  one-line autopilot suggestion (merge / hold / revert / etc.)
#   link            optional PR / issue URL (defaults to gaberoo322/hydra PR url)
#
# Output (stdout): the queue-issue URL (one line). Run-log emission goes
# to $HYDRA_AUTOPILOT_LOG if set.
#
# Environment:
#   HYDRA_AUTOPILOT_REPO     repo slug (default gaberoo322/hydra)
#   HYDRA_AUTOPILOT_LOG      run-log path (optional)
#   HYDRA_AUTOPILOT_QUEUE_DATE  override the date stamp (testing hook)
#
# Failure modes are non-fatal to the caller: gh errors print to stderr
# and we exit 1, but the caller (autopilot Phase 4/5) should continue.
# The whole point of the queue is to NEVER block the loop.

set -uo pipefail

REPO="${HYDRA_AUTOPILOT_REPO:-gaberoo322/hydra}"
LOG="${HYDRA_AUTOPILOT_LOG:-}"
DATE_STAMP="${HYDRA_AUTOPILOT_QUEUE_DATE:-$(date -u +%Y-%m-%d)}"

if [ $# -lt 4 ]; then
  cat >&2 <<USAGE
Usage: queue-decision.sh <pr_number> <tier> <reason> <recommendation> [link]

Appends a row to today's "Operator decision queue ${DATE_STAMP}" issue in
${REPO}. Creates the issue on first invocation of the day; reuses it
otherwise (idempotent rolling daily issue).
USAGE
  exit 2
fi

PR_NUMBER="$1"
TIER="$2"
REASON="$3"
RECOMMENDATION="$4"
LINK="${5:-https://github.com/${REPO}/pull/${PR_NUMBER}}"

TITLE="Operator decision queue ${DATE_STAMP}"
TABLE_HEADER='| PR # | tier | reason | recommendation | link |
| --- | --- | --- | --- | --- |'

# Escape pipe and newline characters in free-form fields so the markdown
# table doesn't break.
sanitize() {
  printf '%s' "$1" | tr '\n' ' ' | sed 's/|/\\|/g'
}
SAFE_REASON=$(sanitize "$REASON")
SAFE_RECOMMENDATION=$(sanitize "$RECOMMENDATION")

NEW_ROW="| #${PR_NUMBER} | ${TIER} | ${SAFE_REASON} | ${SAFE_RECOMMENDATION} | ${LINK} |"

log() {
  if [ -n "$LOG" ]; then
    printf '[autopilot] queue-decision %s pr=%s tier=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PR_NUMBER" "$TIER" >> "$LOG"
  fi
}

# Look up today's queue issue (state OPEN). Match by exact title so we
# don't accidentally reuse an unrelated issue that happens to mention
# the date.
existing_number=$(gh issue list \
  --repo "$REPO" \
  --state open \
  --search "in:title \"${TITLE}\"" \
  --json number,title \
  --jq "[.[] | select(.title == \"${TITLE}\")] | first | .number // empty" \
  2>/dev/null) || existing_number=""

if [ -n "$existing_number" ]; then
  # Idempotent append. Read current body, add the new row before any
  # trailing content. We just concatenate — the table grows downward.
  current_body=$(gh issue view "$existing_number" --repo "$REPO" --json body --jq '.body' 2>/dev/null) || {
    echo "[autopilot] queue-decision: failed to read issue #${existing_number}" >&2
    log
    exit 1
  }
  # If body somehow lost the header (manual edit), re-seed it.
  if ! printf '%s' "$current_body" | grep -q '| PR # | tier |'; then
    new_body="${current_body}

${TABLE_HEADER}
${NEW_ROW}"
  else
    new_body="${current_body}
${NEW_ROW}"
  fi
  if ! gh issue edit "$existing_number" --repo "$REPO" --body "$new_body" >/dev/null 2>&1; then
    echo "[autopilot] queue-decision: failed to append to issue #${existing_number}" >&2
    log
    exit 1
  fi
  echo "https://github.com/${REPO}/issues/${existing_number}"
  log
  exit 0
fi

# First decision of the day — open a fresh issue.
INTRO="This issue is auto-maintained by \`/hydra-autopilot\` running in unattended mode.
Each row below is a decision the autopilot deferred to the operator (in
attended mode it would have been an \`AskUserQuestion\`).

Resolve via \`/hydra-review\` in the morning: the review skill reads
this issue first, walks the rows one by one, and closes the issue once
every row has been actioned. If only some rows are resolved, the
review skill re-opens the issue with the remaining rows.
"

BODY="${INTRO}
${TABLE_HEADER}
${NEW_ROW}"

create_out=$(gh issue create \
  --repo "$REPO" \
  --title "$TITLE" \
  --label "needs-triage" \
  --body "$BODY" 2>&1) || {
  echo "[autopilot] queue-decision: failed to create issue: ${create_out}" >&2
  log
  exit 1
}

# `gh issue create` prints the URL on success.
echo "$create_out" | tail -1
log
exit 0
