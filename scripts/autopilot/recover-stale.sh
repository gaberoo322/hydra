#!/usr/bin/env bash
#
# recover-stale.sh — Phase 1.5 of /hydra-autopilot.
#
# Auto-recover stale issues on the orchestrator board:
#   * stale in-progress (>90 min)   → re-queue as ready-for-agent
#   * stale blocked    (>12h, all blockers closed) → re-queue
#
# The caller passes the lists Phase 1 produced as positional args:
#
#   recover-stale.sh stale_in_progress <ISSUE...> -- stale_blocked <ISSUE...>
#
# Either list may be empty. The script never aborts on a single failed
# `gh` call — it logs and continues so one bad issue doesn't strand the
# whole turn.
#
# Behavior-preserving extraction of the Phase 1.5 heredocs (issue #409).

set -uo pipefail

REPO="${HYDRA_AUTOPILOT_REPO:-gaberoo322/hydra}"

# Directory of this script — pr-refs.py (the shared reference predicate) lives
# next to it (issue #3852). Resolved to an absolute path so the predicate is
# found regardless of how $0 was passed (relative invocation, worktree path).
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# Calendar guard (issue #838).
#
# Some stale `blocked` issues are calendar-blocked, not blocker-reference
# blocked — e.g. #664 ("Do not start before 2026-06-10"). All of its `#N`
# references are CLOSED, so the all-blockers-closed heuristic below would
# wrongly re-queue it before its promised start date.
#
# `calendar_block_future` scans the WHOLE issue body (case-insensitive) for a
# YYYY-MM-DD date adjacent to a calendar cue token, and echoes the LATEST date
# that is still in the FUTURE (UTC). Empty output ⇒ no future calendar block ⇒
# the issue stays eligible for normal blocker-reference recovery.
#
# Cue tokens (case-insensitive):
#   * "do not start before"   (inline body marker; #664 uses it bolded)
#   * "calendar:"             (a `## Blocked by` → `Calendar:` line)
#   * "blocked-until:"        (explicit machine marker)
#
# A date counts as "adjacent" to a cue if it appears anywhere from the cue
# token to the end of that same line. Markdown emphasis (`**`) and trailing
# punctuation around the date are tolerated because we extract the bare
# YYYY-MM-DD with a regex rather than word-splitting.
calendar_block_future() {
  local body="$1"
  local now_epoch latest_epoch="" latest_date="" line date_epoch d
  now_epoch=$(date -u +%s)

  # Iterate line-by-line so a cue and its date must share a line.
  while IFS= read -r line; do
    # Lowercase copy for cue detection only (dates have no letters).
    local lc="${line,,}"
    case "$lc" in
      *"do not start before"*|*"calendar:"*|*"blocked-until:"*) ;;
      *) continue ;;
    esac
    # Extract every YYYY-MM-DD on the cue line (grep -o; one per output line).
    while IFS= read -r d; do
      [ -z "$d" ] && continue
      # date -u rejects malformed dates (e.g. 2026-13-40) → skip them.
      if date_epoch=$(date -u -d "$d" +%s 2>/dev/null); then
        if [ "$date_epoch" -gt "$now_epoch" ]; then
          # Keep the latest future date (most conservative).
          if [ -z "$latest_epoch" ] || [ "$date_epoch" -gt "$latest_epoch" ]; then
            latest_epoch="$date_epoch"
            latest_date="$d"
          fi
        fi
      fi
    done < <(printf '%s\n' "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}')
  done < <(printf '%s\n' "$body")

  [ -n "$latest_date" ] && printf '%s\n' "$latest_date"
}

# Split args on the literal `--` separator. Defensive: missing separator
# means "all in-progress, no blocked".
STALE_IN_PROGRESS=()
STALE_BLOCKED=()
mode="in_progress"
saw_in_progress_header=0
saw_blocked_header=0
for arg in "$@"; do
  case "$arg" in
    stale_in_progress) mode="in_progress"; saw_in_progress_header=1 ;;
    stale_blocked)     mode="blocked";     saw_blocked_header=1 ;;
    --)                mode="blocked" ;;  # legacy separator
    *)
      if [ "$mode" = "in_progress" ]; then
        STALE_IN_PROGRESS+=("$arg")
      else
        STALE_BLOCKED+=("$arg")
      fi
      ;;
  esac
done

# Space-separated membership over the pr-refs.py output (e.g. "123 456 789").
# Empty haystack ⇒ no open PR references the issue ⇒ keep today's behaviour.
inflight_contains() {
  local haystack="$1" needle="$2" x
  [ -z "$haystack" ] && return 1
  [ -z "$needle" ] && return 1
  for x in $haystack; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

# Stale in-progress: re-queue — guarded by an open-PR check (issue #3852).
#
# A stale `in-progress` issue may be idle because it is FINISHED and waiting on
# review, not because dev stalled — an open PR already implements it. Demoting
# such an issue straight to `ready-for-agent` hands it back to dev_orch as fresh
# work and manufactures a DUPLICATE implementation of an already-open PR
# (observed: #3689 was demoted while its PR #3836 sat open and clean). So before
# demoting, check for an open PR that references the issue; on a hit, route to
# `needs-qa` (it is awaiting review, not stalled in dev) and comment.
#
# The reference predicate lives in ONE place — scripts/autopilot/pr-refs.py
# (branch-prefix + keyword-in-body regex, INCLUDING the non-closing `Refs #N`
# form). The Turn Snapshot computes its in-flight exclusion sets with the
# TypeScript twin, src/github/pr-refs.ts (issue #4334; ADR-0043) — a rule
# change must land in both.
#
# Never-abort contract (mirrors the rest of this script): a failed `gh pr list`
# or a pr-refs.py parse error yields an EMPTY referenced-issue set, so every
# issue falls through to today's ready-for-agent relabel. A transient gh outage
# never strands the turn.
INFLIGHT_PR_ISSUES=""
# PR_LIST_OK=1 only when the open-PR list was actually read. The stale-blocked
# pass below REQUIRES it (issue #4806: an unreadable list promotes nothing),
# while the in-progress pass degrades to today's ready-for-agent relabel.
PR_LIST_OK=0
INFLIGHT_PR_PAIRS=""
if [ "${#STALE_IN_PROGRESS[@]}" -gt 0 ] || [ "${#STALE_BLOCKED[@]}" -gt 0 ]; then
  # intentional: empty PR_JSON fails the array validation below, so PR_LIST_OK stays 0 and the run fails closed
  if ! PR_JSON=$(gh pr list --repo "$REPO" --state open --limit "${GH_ISSUE_LIST_LIMIT:-100}" \
    --json number,headRefName,body 2>/dev/null); then
    PR_JSON=""
  fi
  # PR_LIST_OK=1 only once the payload is a JSON array AND pr-refs.py exited 0
  # (QA #4869 finding 1): pr-refs.py swallows parse errors into an empty set, so
  # an unvalidated payload would read as "no open PR" and mis-route a
  # PR-referenced cleared issue to ready-for-agent (duplicate dev pick).
  if [ -n "$PR_JSON" ] \
    && printf '%s' "$PR_JSON" | python3 -c 'import json,sys; assert isinstance(json.load(sys.stdin), list)' 2>/dev/null; then
    if PR_REFS_OUT=$(printf '%s' "$PR_JSON" | python3 "$SCRIPT_DIR/pr-refs.py" 2>/dev/null); then
      PR_LIST_OK=1
      INFLIGHT_PR_ISSUES="$PR_REFS_OUT"
      # `<issue> <pr>` lines (same predicate, first PR wins) for the seam's
      # `--evidence pr=<N>` on the needs-qa promotions (issue #5318 INV-10).
      INFLIGHT_PR_PAIRS=$(printf '%s' "$PR_JSON" | python3 "$SCRIPT_DIR/pr-refs.py" --pairs 2>/dev/null) || {
        echo "[autopilot] recover-stale: WARN pr-refs.py --pairs failed; needs-qa routes will carry no pr= evidence"
        INFLIGHT_PR_PAIRS=""
      }
      PR_COUNT=$(printf '%s' "$PR_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)
      if [ "$PR_COUNT" -ge "${GH_ISSUE_LIST_LIMIT:-100}" ]; then
        echo "[autopilot] recover-stale: WARN open-PR list hit the ${GH_ISSUE_LIST_LIMIT:-100} cap; PR-referenced issues beyond it may be missed"
      fi
    fi
  fi
fi

# State writes go ONLY through the lifecycle seam (ADR-0047 D3, issue #5318).
# The issue-#5317 live-state guard that lived here (a re-read plus a mirrored
# copy of the state-label vocabulary) is gone: the stale lists come from a Turn
# Snapshot read one turn after it was stored, so each advance passes
# `--from <listed state>` and the seam's compare-and-set refuses `from-mismatch`
# (in shadow AND enforce, before any write) when the issue has since moved on,
# notably QA PASS landing it in `qa-passed`. ANY non-zero exit (a refusal code,
# `from-mismatch`, `parked:*`, `write-failed:*`) skips the issue: there is NO
# fallback to a direct label write.
#
# HYDRA_LIFECYCLE_BIN overrides the CLI (tests inject a stub; production leaves
# it unset and runs the repo's lifecycle CLI through npx tsx from the repo root).
lifecycle() {
  if [ -n "${HYDRA_LIFECYCLE_BIN:-}" ]; then
    "$HYDRA_LIFECYCLE_BIN" "$@"
  else
    (cd "$SCRIPT_DIR/../.." && npx tsx scripts/lifecycle.ts "$@")
  fi
}

# pr_for_issue ISSUE: the first open PR number referencing it (empty = unknown).
pr_for_issue() {
  local i p
  while read -r i p; do
    if [ "$i" = "$1" ]; then printf '%s' "$p"; return 0; fi
  done <<< "$INFLIGHT_PR_PAIRS"
  return 0
}

# seam_advance ISSUE TO FROM: exit 0 only when the seam performed the move.
seam_advance() {
  local issue="$1" to="$2" from="$3" pr args
  args=(advance "$issue" "$to" --from "$from" --actor recover-stale)
  if [ "$to" = needs-qa ]; then
    pr=$(pr_for_issue "$issue")
    [ -n "$pr" ] && args+=(--evidence "pr=$pr")
  fi
  lifecycle "${args[@]}" >/dev/null 2>&1
}

# stale_claim_verdict ISSUE: prints `none` | `fresh` | `stale <dispatchId>`;
# returns 1 (prints nothing) when the claim could not be read. A held claim
# younger than the stale threshold means a fresh dispatch exists: never touch it.
STALE_CLAIM_MIN="${HYDRA_RECOVER_STALE_CLAIM_MIN:-90}"
stale_claim_verdict() {
  local raw
  raw=$(lifecycle claim-show "$1" 2>/dev/null) || return 1
  printf '%s' "$raw" | python3 -c '
import json, sys, time
try:
    claim = json.loads(sys.stdin.read()).get("claim")
except Exception:
    sys.exit(1)
if not claim:
    print("none")
else:
    age_min = (time.time() * 1000 - float(claim.get("openedAt", 0))) / 60000.0
    print("fresh" if age_min < float(sys.argv[1]) else "stale " + str(claim.get("dispatchId", "")))
' "$STALE_CLAIM_MIN" 2>/dev/null
}

for ISSUE in "${STALE_IN_PROGRESS[@]:-}"; do
  [ -z "$ISSUE" ] && continue
  # Release the held claim BEFORE the flip (#5318 INV-6): a claim opened after
  # the flip belongs to a fresh dispatcher and must never be released here.
  if ! verdict=$(stale_claim_verdict "$ISSUE"); then
    echo "[autopilot] recover-stale: skip issue=$ISSUE (claim read failed)"
    continue
  fi
  case "$verdict" in
    fresh)
      echo "[autopilot] recover-stale: skip issue=$ISSUE (claim younger than ${STALE_CLAIM_MIN} min: a fresh dispatch exists)"
      continue ;;
    "stale "*)
      if ! lifecycle release "$ISSUE" --dispatch "${verdict#stale }" --outcome stale --actor recover-stale >/dev/null 2>&1; then
        echo "[autopilot] recover-stale: skip issue=$ISSUE (claim release refused)"
        continue
      fi ;;
  esac
  if inflight_contains "$INFLIGHT_PR_ISSUES" "$ISSUE"; then
    # An open PR already references this issue: awaiting review, not stalled.
    if seam_advance "$ISSUE" needs-qa in-progress; then
      gh issue comment "$ISSUE" --repo "$REPO" --body "> *Autopilot:* Routed to needs-qa — an open PR already references this issue (recover-stale open-PR guard, #3852)." 2>/dev/null || true
      echo "[autopilot] recover-stale: routed in-progress→needs-qa issue=$ISSUE (open PR references it)"
    else
      echo "[autopilot] recover-stale: skip issue=$ISSUE (seam refused or failed)"
    fi
  else
    if seam_advance "$ISSUE" ready-for-agent in-progress; then
      gh issue comment "$ISSUE" --repo "$REPO" --body "> *Autopilot:* Re-queued. >90 min idle in in-progress." 2>/dev/null || true
      echo "[autopilot] recover-stale: re-queued in-progress issue=$ISSUE"
    else
      echo "[autopilot] recover-stale: skip issue=$ISSUE (seam refused or failed)"
    fi
  fi
done

# Stale blocked: promote only when the ONE blocker-clearance predicate says so
# (issue #4806). The predicate lives in scripts/autopilot/blockers-cleared.ts
# (strict blocker refs from src/github/blockers.ts; a blocker counts as cleared
# when it is a closed issue or a merged PR; no strict ref => never cleared; a
# `## Files in scope` precondition; any lookup failure => nothing cleared). It is
# READ-ONLY — every mutation below is performed here.
#
# Per-issue calendar guard (issue #838) runs first and holds regardless of
# blocker state.
CANDIDATES=()
for ISSUE in "${STALE_BLOCKED[@]:-}"; do
  [ -z "$ISSUE" ] && continue
  BODY=$(gh issue view "$ISSUE" --repo "$REPO" --json body --jq '.body' 2>/dev/null)
  FUTURE_DATE=$(calendar_block_future "$BODY")
  if [ -n "$FUTURE_DATE" ]; then
    echo "[autopilot] recover-stale: skip issue=$ISSUE (calendar-blocked until $FUTURE_DATE)"
    continue
  fi
  CANDIDATES+=("$ISSUE")
done

if [ "${#CANDIDATES[@]}" -gt 0 ]; then
  if [ "$PR_LIST_OK" != 1 ]; then
    echo "[autopilot] recover-stale: skip stale_blocked (open-PR list unreadable; promoting nothing)"
  else
    CLEARED_ERR_FILE=$(mktemp)
    CLEARED_LINES=""
    CLEARED_RC=0
    if cd "$SCRIPT_DIR/../.." 2>"$CLEARED_ERR_FILE"; then
      CLEARED_LINES=$(npx tsx scripts/autopilot/blockers-cleared.ts \
        --repo "$REPO" "${CANDIDATES[@]}" 2>"$CLEARED_ERR_FILE") || CLEARED_RC=$?
    else
      CLEARED_RC=1
    fi
    if [ "$CLEARED_RC" -ne 0 ]; then
      echo "[autopilot] recover-stale: skip stale_blocked (blockers-cleared exited $CLEARED_RC; promoting nothing): $(head -n 3 "$CLEARED_ERR_FILE" | tr '\n' ' ')"
      CLEARED_LINES=""
    elif [ -z "$CLEARED_LINES" ]; then
      # Previously silent arm (issue #5393): rc 0 but nothing cleared. Name it so a
      # flaky "not unblocked" outcome is attributable from the captured stdout.
      echo "[autopilot] recover-stale: skip stale_blocked (blockers-cleared cleared nothing for ${#CANDIDATES[@]} candidate(s)): $(head -n 3 "$CLEARED_ERR_FILE" | tr '\n' ' ')"
    fi
    if [ "${HYDRA_RECOVER_STALE_DEBUG:-}" = 1 ]; then
      # Full child stderr (e.g. ghJson failure codes), read BEFORE the rm below.
      echo "[autopilot] recover-stale: DEBUG blockers-cleared rc=$CLEARED_RC stderr:"
      sed 's/^/[autopilot] recover-stale: DEBUG | /' "$CLEARED_ERR_FILE"
    fi
    rm -f "$CLEARED_ERR_FILE"
    while read -r ISSUE CLEARED; do
      [ -z "$ISSUE" ] && continue
      if ! [[ "$ISSUE" =~ ^[0-9]+$ ]] || ! [[ "$CLEARED" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
        echo "[autopilot] recover-stale: skip malformed blockers-cleared line (issue='$ISSUE')"
        continue
      fi
      if inflight_contains "$INFLIGHT_PR_ISSUES" "$ISSUE"; then
        # An open PR already references it: awaiting review, never ready-for-agent.
        if seam_advance "$ISSUE" needs-qa blocked; then
          gh issue comment "$ISSUE" --repo "$REPO" --body "> *Autopilot:* Blockers cleared (#${CLEARED//,/, #}); routed to needs-qa — an open PR already references this issue (#4806)." 2>/dev/null || true
          echo "[autopilot] recover-stale: unblocked issue=$ISSUE -> needs-qa (open PR references it)"
        else
          echo "[autopilot] recover-stale: skip issue=$ISSUE (seam refused or failed)"
        fi
      elif seam_advance "$ISSUE" ready-for-agent blocked; then
        gh issue comment "$ISSUE" --repo "$REPO" --body "> *Autopilot:* Unblocked — blockers cleared (#${CLEARED//,/, #})." 2>/dev/null || true
        echo "[autopilot] recover-stale: unblocked issue=$ISSUE (all blockers closed: $CLEARED)"
      else
        echo "[autopilot] recover-stale: skip issue=$ISSUE (seam refused or failed)"
      fi
    done <<< "$CLEARED_LINES"
  fi
fi
