#!/usr/bin/env bash
#
# drainer-loop.sh — the GLM dev-drainer tick launcher (issue #3689, ADR-0032 as
# amended by #3753/#3758; collapsed to flock + one driver call by #4688,
# ADR-0040 Decision 1).
#
# Fired every ~15 min by hydra-glm-drainer.timer (mirrors the pace-gate
# oneshot+timer shape — scripts/systemd/hydra-glm-drainer.{service,timer}).
# Bash keeps exactly two responsibilities; everything else is TypeScript:
#
#   1. flock (concurrency=1, kernel auto-release — NEVER a Redis lock;
#      ADR-0032 Decision 6 / invariant 5). A tick that FAILS to take the lock
#      (another tick's authoring run is still in progress — API_TIMEOUT_MS is
#      50 min, well past this timer's 15-min cadence) still refreshes the
#      heartbeat unconditionally (2026-07-27 AMENDMENTS #3: a run in progress
#      is positive liveness evidence) through the `heartbeat` driver mode, and
#      exits 0.
#   2. `run_driver tick` — ONE call into src/glm/drainer-driver.ts, which runs
#      the whole tick in-process, in order:
#        gate   (src/glm/gate.ts, #4682)   operator pause (Redis; Anthropic
#               emergencyStop/paceState are deliberately IGNORED — ADR-0032
#               Decision 6), daily PR cap, z.ai quota block; heartbeat only on
#               "able to author".
#        pick   (src/glm/pick.ts, #4686)   crash recovery of >90 min stale
#               in-progress claims, the grill-clear candidate pick, the
#               resumable-branch detection (#4337 INV-5).
#        claim  ready-for-agent -> in-progress; create the worktree (the three
#               fresh / resume-local / resume-remote arms); compose the prompt
#               (src/glm/prompt.ts, pure); run `hydra-dev` HEADLESS under the
#               GLM-fenced env + config/glm/drainer-settings.json
#               (src/glm/drainer-runner.ts) — which withholds `gh pr create`,
#               so the supervising loop opens the PR after preflight.
#        finish (src/glm/finish.ts, #4685) the post-author arms, the salvage
#               ladder, preflight (secret-scan + Verifier-Core/T4 diff gate),
#               PR open + adopt-on-collision, label writes, and the
#               cap/timeout/quota counters (a z.ai 429 records the
#               self-expiring quota block the next tick's gate reads).
#      It prints ONE `{gate,pick,finish}` JSON line on stdout and exits 0 for
#      every completed tick; non-zero means the driver ITSELF faulted. Journal
#      lines go to stderr with the `hydra-glm-drainer: ` prefix.
#
# Failure containment: every in-process failure after the claim reaches the
# finish phase, which never throws — so no bash-side claim release exists. A
# whole-process crash leaves the claim `in-progress`; recover-stale's 90-min
# requeue (run by the pick phase) covers it.
#
# The z.ai credential (`ANTHROPIC_AUTH_TOKEN`) arrives via a systemd
# `EnvironmentFile` this script never reads — `buildGlmEnv` in
# `src/glm/drainer-runner.ts` is the ONE place that resolves it, fail-closed
# (issue #3688 invariant 7): an absent/blank token aborts THAT authoring
# attempt (`glm-auth-token-missing`) rather than falling back to Anthropic
# quota.
#
# Style (mirrors scripts/autopilot/pace-gate.sh): `set -uo pipefail` (not
# `-e`), every exit path an explicit `exit 0` so a known skip/failure never
# marks the systemd unit "failed" — only a genuinely unexpected fault should
# alarm the watchdog.
#
# Testability hooks (off-by-default; exercised by test/glm-drainer-loop.test.mts):
#   HYDRA_GLM_DRAINER_DRY_RUN=1
#       Every mutating/network action logs "would-<action>" and no-ops. Each
#       phase honours it where it lives (src/glm/drainer-config.ts reads it).
#   HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL   design-concepts API base.
#   HYDRA_GLM_DRAINER_LOCKFILE / HYDRA_GLM_DRAINER_CAP_DIR
#       flock lockfile path / directory of the cap, timeout and quota files.
#   HYDRA_GLM_DRAINER_DAILY_CAP            daily PR cap (default 5).
#   HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP   per-issue timeout cap (default 2).
#   HYDRA_GLM_DRAINER_QUOTA_RESET_TZ_OFFSET  z.ai 429 reset-clause timezone.
#   HYDRA_GLM_DRAINER_WORKTREE_ROOT        where tick worktrees are created.
#   HYDRA_AUTOPILOT_REPO                   GitHub repo (default gaberoo322/hydra).
#   HYDRA_GLM_DRAINER_REPO_ROOT            the checkout whose scripts/, src/ and
#       worktree base the tick uses (defaults to this script's own repo).
#
# Source of truth: this file at scripts/glm/drainer-loop.sh, invoked in place
# by the systemd unit (WorkingDirectory anchors %h/hydra).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${HYDRA_GLM_DRAINER_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

DRY_RUN="${HYDRA_GLM_DRAINER_DRY_RUN:-0}"
LOCKFILE="${HYDRA_GLM_DRAINER_LOCKFILE:-/tmp/hydra-glm-drainer.lock}"
# bash's one remaining responsibility for CAP_DIR is making it exist; the gate
# (read side) and finish (write side) phases own every counter file in it.
CAP_DIR="${HYDRA_GLM_DRAINER_CAP_DIR:-/tmp}"
# The operator off switch (src/glm/disabled.ts owns the rule; same path here):
# while this file exists the lane does nothing — not even the lock-held
# heartbeat — so the heartbeat lapses and the Claude lane takes the work back.
DISABLED_FILE="${HYDRA_GLM_DISABLED_FILE:-${HOME:+$HOME/.config/hydra-glm/disabled}}"

log() {
  echo "hydra-glm-drainer: $*" >&2
}

# Bash cannot import a TS module: logic lives in src/glm/drainer-driver.ts
# (runDriverMode), the thin CLI entrypoint in scripts/glm/drainer-driver.ts.
# Every mode prints exactly one JSON line to stdout; a non-zero exit means the
# DRIVER ITSELF faulted (bad argv, unknown mode, a rejecting dependency).
run_driver() {
  local mode="$1"
  shift || true
  node --experimental-strip-types "$REPO_ROOT/scripts/glm/drainer-driver.ts" "$mode" "$@"
}

# flock stays in bash (ADR-0032 invariant 5). The lock-held path refreshes the
# heartbeat through the `heartbeat` driver mode — the one DRY_RUN read bash
# keeps — and exits 0.
acquire_lock_or_heartbeat_and_exit() {
  exec 9>"$LOCKFILE"
  if ! flock -n 9; then
    log "flock blocked (another drainer tick is still authoring) — refreshing heartbeat (AMENDMENTS #3) and exiting"
    if [[ "$DRY_RUN" == "1" ]]; then
      log "would-heartbeat (reason=blocked, DRY_RUN=1)"
    else
      local out rc=0
      out="$(run_driver heartbeat 2>&1)" || rc=$?
      if [[ $rc -ne 0 ]]; then
        log "WARN heartbeat write failed (reason=blocked): $out"
      else
        log "heartbeat written (reason=blocked)"
      fi
    fi
    exit 0
  fi
}

main() {
  if [[ -n "$DISABLED_FILE" && -e "$DISABLED_FILE" ]]; then
    log "lane disabled by operator (sentinel $DISABLED_FILE present) — skip (no heartbeat)"
    exit 0
  fi

  mkdir -p "$CAP_DIR" 2>/dev/null || true

  acquire_lock_or_heartbeat_and_exit

  local rc=0
  run_driver tick || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    log "ERROR tick driver faulted (rc=$rc)"
  fi
  exit 0
}

# Sourceable for tests (test/glm-drainer-loop.test.mts) without running main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
