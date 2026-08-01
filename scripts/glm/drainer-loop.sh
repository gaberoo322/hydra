#!/usr/bin/env bash
#
# drainer-loop.sh — the GLM dev-drainer loop (issue #3689, ADR-0032 as amended
# by #3753).
#
# What this is
# ------------
# A dumb, fenced systemd Type=oneshot service (hydra-glm-drainer.service,
# fired every ~15 min by hydra-glm-drainer.timer) that drains the backlog of
# `glm-eligible` `dev_orch` issues by authoring them with GLM on z.ai's
# independent quota, mirroring hydra-pace-gate.sh's oneshot+timer shape.
#
# The loop, in order:
#
#   1. Kill-switch — honor ONLY the operator `paused` flag
#      (GET /api/autopilot/paused). Anthropic emergencyStop / paceState /
#      weeklyEmergencyStop are DELIBERATELY ignored (ADR-0032 Decision 6 /
#      invariant 6, rejected-alternatives #3670): GLM runs on z.ai's own
#      quota, so pausing on Anthropic exhaustion would sleep the drainer
#      exactly when it is most needed. Unreachable/unparseable => fail SAFE
#      (do not author; heartbeat NOT refreshed this tick — mirrors
#      pace-gate.sh's fail-safe-on-unreachable-eligibility stance).
#
#   2. Daily PR cap — a date-stamped counter file bounds GLM's blast radius
#      (concurrency=1 + identical QA + CI already bound the rest). Cap
#      reached => skip (heartbeat NOT refreshed) so the Opus dev_orch lane
#      sees the glm-eligible backlog again rather than the board idling
#      until midnight (ADR-0032 #3753 amendment point 18 / heartbeat
#      semantics: "hitting the cap ... hands the dev_orch lane back to Opus").
#
#   3. Heartbeat refresh — written via `scripts/glm/drainer-cli.ts heartbeat`
#      (which calls `setGlmDrainerHeartbeat` in `src/redis/autopilot.ts`)
#      ONLY when steps 1-2 did not skip, and BEFORE the flock attempt below —
#      so a tick that is itself blocked on the lock (another tick's ~50-min
#      authoring run still in flight) still refreshes the heartbeat. A run in
#      progress is positive liveness evidence, not silence (ADR-0032 #3753
#      amendment point 3).
#
#   4. flock (concurrency=1, kernel auto-release — NOT a Redis lock; ADR-0032
#      Decision 6 / rejected-alternatives #3667). Lock held by another tick =>
#      skip (heartbeat already refreshed in step 3).
#
#   5. Pick the oldest open `ready-for-agent` + `glm-eligible` issue, claim it
#      via an in-progress label swap (mirrors recover-stale.sh's claim style),
#      author it with a base-URL-overridden `claude` process pinned to the
#      drainer `--settings` file (config/glm/drainer-settings.json) and an
#      explicit `glm-*` model name (ADR-0032 Decision 2, #3758 amendment —
#      an Anthropic slot alias silently routes first-party), running inside a
#      fresh worktree under a WORKTREE_ROOTS-recognised path (see that
#      settings file's mechanism-2 note) so the worktree-write-fence hook
#      fences the main checkouts.
#
#   6. Preflight — `scripts/glm/drainer-cli.ts preflight <changed paths...>`
#      (which calls `preflightBeforePr` in `src/glm/drainer-runner.ts`) runs
#      the Verifier-Core/T4 diff scan + secret-scan over the authored diff.
#      BLOCKED => the loop does NOT open a PR; the issue is handed back to
#      ready-for-agent for a human/Opus retry, and NOT counted against the
#      daily cap. This loop — not the authoring session — opens the PR
#      (`config/glm/drainer-settings.json` deliberately withholds
#      `gh pr create` from the authoring session for exactly this ordering
#      guarantee), and only on a clean preflight does the cap counter
#      increment and the `glm-authored` label get applied.
#
# Crash recovery is NOT reimplemented here: a claimed issue whose authoring
# run dies mid-flight is just another stale `in-progress` issue, and the
# existing /hydra-autopilot Phase 1.5 `recover-stale.sh` (>90 min re-queue)
# already re-queues any stale in-progress issue back to `ready-for-agent`
# regardless of which lane claimed it.
#
# Testability hooks (off-by-default; for the regression test only)
# ------------------------------------------------------------------
#   HYDRA_GLM_DRAINER_PAUSED_URL       Override the operator-pause endpoint
#                                      (default http://localhost:4000/api/autopilot/paused).
#   HYDRA_GLM_DRAINER_CAP_DIR          Override the daily-cap counter directory
#                                      (default /tmp).
#   HYDRA_GLM_DRAINER_DAILY_CAP        Override the daily PR cap (default 5).
#   HYDRA_GLM_DRAINER_LOCK             Override the flock lockfile path
#                                      (default /tmp/hydra-glm-drainer.lock).
#   HYDRA_GLM_DRAINER_HEARTBEAT_CMD    Override the heartbeat-write command
#                                      (word-split; default
#                                      "node --experimental-strip-types
#                                      $REPO_ROOT/scripts/glm/drainer-cli.ts
#                                      heartbeat"). Lets the test substitute a
#                                      marker-writing stub instead of touching
#                                      live Redis.
#   HYDRA_GLM_DRAINER_DRY_RUN=1        Stop immediately after the flock is
#                                      acquired (heartbeat already refreshed,
#                                      lock already taken) and log
#                                      "would-author", instead of listing
#                                      candidates / claiming / spawning
#                                      claude. Lets the test pin the gating
#                                      order (kill-switch -> cap ->
#                                      heartbeat-before-flock ->
#                                      flock-blocked-still-refreshes) without
#                                      any live gh/claude call.
#   HYDRA_GLM_DRAINER_REPO             Override the GitHub repo slug
#                                      (default gaberoo322/hydra).
#
# Source of truth: this file in the repo at scripts/glm/drainer-loop.sh.
# Deployed to %h/hydra/scripts/glm/drainer-loop.sh (systemd ExecStart runs it
# in place — see hydra-glm-drainer.service — mirroring the other scripts/
# systemd units that exec the repo copy directly, not a ~/.local/bin mirror).

set -uo pipefail

REPO="${HYDRA_GLM_DRAINER_REPO:-gaberoo322/hydra}"
REPO_ROOT="${HYDRA_ROOT:-/home/gabe/hydra}"
LOCK_FILE="${HYDRA_GLM_DRAINER_LOCK:-/tmp/hydra-glm-drainer.lock}"
DAILY_CAP="${HYDRA_GLM_DRAINER_DAILY_CAP:-5}"
CAP_DIR="${HYDRA_GLM_DRAINER_CAP_DIR:-/tmp}"
PAUSED_URL="${HYDRA_GLM_DRAINER_PAUSED_URL:-http://localhost:4000/api/autopilot/paused}"
SETTINGS_PATH="${HYDRA_GLM_DRAINER_SETTINGS:-$REPO_ROOT/config/glm/drainer-settings.json}"
WORKTREE_ROOT="${HYDRA_GLM_DRAINER_WORKTREE_ROOT:-$REPO_ROOT/.claude/worktrees}"
HEARTBEAT_CMD="${HYDRA_GLM_DRAINER_HEARTBEAT_CMD:-node --experimental-strip-types $REPO_ROOT/scripts/glm/drainer-cli.ts heartbeat}"

# GLM mechanism constants (ADR-0032 Decision 2, #3758 amendment). Duplicated
# here rather than sourced from src/glm/drainer-runner.ts because bash cannot
# import a TS module's exported constant; the values are simple and their
# single source of truth for the *TypeScript* callers of the same mechanism
# stays that file (GLM_ANTHROPIC_BASE_URL / GLM_MODEL). Any change to either
# constant must be made in both places.
GLM_ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
GLM_MODEL="${HYDRA_GLM_DRAINER_MODEL:-glm-5.2}"

log() {
  echo "hydra-glm-drainer: $*"
}

TODAY="$(date -u +%F)"
CAP_FILE="$CAP_DIR/hydra-glm-drainer-daily-$TODAY.count"

# --- Step 1: kill-switch — operator `paused` ONLY (ADR-0032 invariant 6) ---

if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  log "WARN curl/jq not found; cannot consult the pause flag — failing safe (not authoring)"
  exit 0
fi

PAUSED_JSON=""
if ! PAUSED_JSON=$(curl -fsS --max-time 10 "$PAUSED_URL" 2>/dev/null); then
  log "WARN operator-pause endpoint unreachable ($PAUSED_URL) — failing safe (not authoring, heartbeat not refreshed)"
  exit 0
fi

PAUSED=$(jq -r '.paused' <<<"$PAUSED_JSON" 2>/dev/null || echo "parse-error")
if [[ "$PAUSED" != "true" && "$PAUSED" != "false" ]]; then
  log "WARN pause-flag response unparseable — failing safe (not authoring, heartbeat not refreshed)"
  exit 0
fi

if [[ "$PAUSED" == "true" ]]; then
  log "operator paused — skip (heartbeat not refreshed)"
  exit 0
fi

# --- Step 2: daily PR cap ---

CAP_COUNT=0
if [[ -f "$CAP_FILE" ]]; then
  CAP_COUNT=$(cat "$CAP_FILE" 2>/dev/null || echo "")
  [[ "$CAP_COUNT" =~ ^[0-9]+$ ]] || CAP_COUNT=0
fi

if [[ "$CAP_COUNT" -ge "$DAILY_CAP" ]]; then
  log "daily cap reached ($CAP_COUNT/$DAILY_CAP) — skip (heartbeat not refreshed); dev_orch lane is Opus's for the rest of today"
  exit 0
fi

# --- Step 3: refresh the heartbeat FIRST, before the flock attempt ---
#
# Neither paused nor cap-exhausted => this tick is "able to author", so the
# heartbeat is written now regardless of whether the flock below is free —
# a tick blocked on the lock is still positive liveness evidence.
# shellcheck disable=SC2086
if $HEARTBEAT_CMD >/tmp/hydra-glm-drainer-heartbeat.log 2>&1; then
  log "heartbeat refreshed"
else
  log "WARN heartbeat write failed (non-fatal; continuing tick) — see /tmp/hydra-glm-drainer-heartbeat.log"
fi

# --- Step 4: acquire the flock (concurrency=1, kernel auto-release) ---

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another tick holds the lock (authoring run in flight) — skip (heartbeat already refreshed above)"
  exit 0
fi

if [[ "${HYDRA_GLM_DRAINER_DRY_RUN:-0}" == "1" ]]; then
  log "would-author (DRY_RUN=1, test mode; lock held, heartbeat refreshed)"
  exit 0
fi

# --- Step 5: pick a glm-eligible issue, claim it, author it ---

if ! command -v gh >/dev/null 2>&1; then
  log "WARN gh CLI not found — cannot pick a candidate; skip"
  exit 0
fi

CANDIDATES_JSON=$(gh issue list --repo "$REPO" --label ready-for-agent --label glm-eligible \
  --state open --json number,title --limit 20 2>/dev/null)
if [[ -z "$CANDIDATES_JSON" || "$CANDIDATES_JSON" == "[]" ]]; then
  log "no glm-eligible ready-for-agent issue — nothing to drain this tick"
  exit 0
fi

ISSUE=$(jq -r '(sort_by(.number) | .[0].number) // empty' <<<"$CANDIDATES_JSON" 2>/dev/null)
TITLE=$(jq -r '(sort_by(.number) | .[0].title) // empty' <<<"$CANDIDATES_JSON" 2>/dev/null)
if [[ -z "$ISSUE" ]]; then
  log "WARN could not parse a candidate issue number from gh output — skip"
  exit 0
fi

log "selected issue #$ISSUE ($TITLE)"

if ! gh issue edit "$ISSUE" --repo "$REPO" --remove-label ready-for-agent --add-label in-progress 2>/dev/null; then
  log "WARN failed to claim issue #$ISSUE (label edit failed) — skip this tick, leave it ready-for-agent"
  exit 0
fi

# Fail-closed credentials (ADR-0032 invariant 7): no default, no fallback.
RAW_TOKEN="${ANTHROPIC_AUTH_TOKEN:-}"
if [[ -z "$RAW_TOKEN" ]]; then
  log "ERROR ANTHROPIC_AUTH_TOKEN unset or blank — refusing to author (fail-closed, invariant 7)"
  gh issue edit "$ISSUE" --repo "$REPO" --remove-label in-progress --add-label ready-for-agent 2>/dev/null \
    || log "WARN could not restore ready-for-agent on issue #$ISSUE after aborting"
  exit 0
fi

if ! command -v claude >/dev/null 2>&1; then
  log "ERROR claude CLI not found — cannot author; restoring issue #$ISSUE to ready-for-agent"
  gh issue edit "$ISSUE" --repo "$REPO" --remove-label in-progress --add-label ready-for-agent 2>/dev/null \
    || log "WARN could not restore ready-for-agent on issue #$ISSUE"
  exit 0
fi

TS="$(date +%s)"
BRANCH="worktree-agent-glm-${ISSUE}-${TS}"
WORKTREE_DIR="$WORKTREE_ROOT/glm-agent-${ISSUE}-${TS}"

git -C "$REPO_ROOT" fetch origin --quiet
if ! git -C "$REPO_ROOT" worktree add -q "$WORKTREE_DIR" -b "$BRANCH" origin/master; then
  log "ERROR could not create worktree for issue #$ISSUE — restoring ready-for-agent"
  gh issue edit "$ISSUE" --repo "$REPO" --remove-label in-progress --add-label ready-for-agent 2>/dev/null \
    || log "WARN could not restore ready-for-agent on issue #$ISSUE"
  exit 0
fi
ln -sfn "$REPO_ROOT/node_modules" "$WORKTREE_DIR/node_modules"

# Only a BASE-URL override on a first-party `claude` process reaches z.ai
# (ADR-0032 Decision 2); the token travels via the environment ONLY, never an
# argv entry (world-readable /proc/<pid>/cmdline).
export ANTHROPIC_BASE_URL="$GLM_ANTHROPIC_BASE_URL"
export ANTHROPIC_AUTH_TOKEN="$RAW_TOKEN"
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN_FILE

# The authoring session must NOT open the PR itself — `gh pr create` is
# deliberately withheld from config/glm/drainer-settings.json's allow-list so
# it cannot route around the preflight gate below. It commits and pushes its
# branch; this loop opens the PR after a clean preflight.
PROMPT="Invoke the hydra-dev skill. Implement issue #${ISSUE} in this worktree, per its scope. Run npm test and npm run typecheck:test in the foreground before finishing. Commit your work and 'git push -u origin ${BRANCH}'. Do NOT run 'gh pr create' — a separate process opens the PR after a preflight check. Stop once your branch is pushed."

log "authoring issue #$ISSUE (branch $BRANCH, worktree $WORKTREE_DIR)"
(
  cd "$WORKTREE_DIR" \
    && claude --settings "$SETTINGS_PATH" --model "$GLM_MODEL" -p "$PROMPT"
)
CLAUDE_EXIT=$?
log "authoring session for issue #$ISSUE exited $CLAUDE_EXIT"

# --- Step 6: preflight the diff, then (only if clean) open the PR ---

CHANGED_PATHS_STR=$(git -C "$WORKTREE_DIR" diff --name-only "origin/master...${BRANCH}" 2>/dev/null)
# shellcheck disable=SC2086
readarray -t CHANGED_PATHS <<<"$CHANGED_PATHS_STR"

if [[ ${#CHANGED_PATHS[@]} -eq 0 || -z "${CHANGED_PATHS[0]}" ]]; then
  log "no diff produced for issue #$ISSUE — restoring ready-for-agent, not counted against the daily cap"
  gh issue edit "$ISSUE" --repo "$REPO" --remove-label in-progress --add-label ready-for-agent 2>/dev/null \
    || log "WARN could not restore ready-for-agent on issue #$ISSUE"
  exit 0
fi

# shellcheck disable=SC2086
if ! (cd "$REPO_ROOT" && node --experimental-strip-types scripts/glm/drainer-cli.ts preflight "${CHANGED_PATHS[@]}"); then
  log "PREFLIGHT BLOCKED for issue #$ISSUE — NOT opening a PR; restoring ready-for-agent, not counted against the daily cap"
  gh issue edit "$ISSUE" --repo "$REPO" --remove-label in-progress --add-label ready-for-agent 2>/dev/null \
    || log "WARN could not restore ready-for-agent on issue #$ISSUE"
  exit 0
fi

log "preflight clean for issue #$ISSUE — opening PR"
if (cd "$WORKTREE_DIR" && gh pr create --repo "$REPO" --label glm-authored \
  --title "GLM: issue #${ISSUE}" \
  --body "Authored by the GLM dev-drainer (ADR-0032, issue #3689).

Closes #${ISSUE}"); then
  # Only a successfully-opened PR counts against the daily cap.
  echo "$((CAP_COUNT + 1))" >"$CAP_FILE"
  log "opened PR for issue #$ISSUE; daily cap now $((CAP_COUNT + 1))/$DAILY_CAP"
else
  log "ERROR gh pr create failed for issue #$ISSUE — restoring ready-for-agent, not counted against the daily cap"
  gh issue edit "$ISSUE" --repo "$REPO" --remove-label in-progress --add-label ready-for-agent 2>/dev/null \
    || log "WARN could not restore ready-for-agent on issue #$ISSUE"
fi

exit 0
