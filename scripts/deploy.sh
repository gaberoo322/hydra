#!/usr/bin/env bash
set -euo pipefail

# Deploy Hydra orchestrator + dashboard.
# Called by GitHub Actions self-hosted runner on merge to master,
# or manually: ./scripts/deploy.sh

# Serialize deploys (issue #871). The CI runner pool grew from 1 → 4 self-hosted
# runners to parallelize the independent PR CI jobs. But the `deploy` job runs
# THIS script against the shared real tree ($HYDRA_ROOT, an absolute path — not
# the runner's _work checkout), so two master merges landing within a deploy's
# runtime could now run two deploy.sh against /home/gabe/hydra at once, with
# `git checkout/pull`, `npm ci`, and the dashboard build stomping on each other.
# A single runner used to guarantee this serialization implicitly (ci.yml #712).
# Re-exec under an flock so concurrent invocations serialize — the 2nd waits for
# the 1st. This also protects a manual ./scripts/deploy.sh against a concurrent
# auto-deploy. `-w 1200` bounds the wait (20min) so a wedged lock fails loud
# instead of pinning a runner forever; whichever deploy ran already pulled the
# master tip, so a timed-out 2nd deploy leaves prod at tip, not an old commit.
LOCK_FILE="${HYDRA_DEPLOY_LOCK:-/tmp/hydra-deploy.lock}"
if [ -z "${_HYDRA_DEPLOY_LOCKED:-}" ]; then
  exec env _HYDRA_DEPLOY_LOCKED=1 flock -w 1200 "$LOCK_FILE" "$0" "$@"
fi

HYDRA_ROOT="${HYDRA_ROOT:-/home/gabe/hydra}"
cd "$HYDRA_ROOT"

echo "==> Syncing to master..."
# Self-healing: this deploy path runs from $HYDRA_ROOT, which may be sitting on
# a feature branch from an interactive operator session. A direct
# `git pull --ff-only origin master` aborts in that state (diverged refs).
# Switch to master first, but never silently clobber operator WIP — fail loud
# if there are uncommitted tracked changes.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "ERROR: $HYDRA_ROOT has uncommitted tracked changes — refusing to deploy."
  echo "       Stash or commit them, then re-run."
  git status
  exit 1
fi
git fetch --quiet origin master
git checkout master
git pull --ff-only origin master

echo "==> Installing orchestrator deps..."
npm ci

echo "==> Syncing operator skills from playbooks..."
# Regenerate ~/.claude/skills/ and ~/.codex/skills/ so the deployed orchestrator
# state matches docs/operator-playbooks/. Fail fast on non-zero exit — a half-
# synced state caused the 2026-05-15 silent-wedge incident (PR #429 merged a new
# autopilot playbook but the operator's mirror stayed at the stale version).
# `set -euo pipefail` at the top of this script means a non-zero exit here will
# abort the deploy before the service is restarted.
bash scripts/sync-skills.sh

echo "==> Building dashboard..."
cd dashboard && npm ci && npm run build && cd ..

echo "==> Installing consolidated watchdog (issue #705, cutover #727)..."
# Consolidated watchdog (issue #705) — one script with two clearly-labelled
# blocks: ## SERVICE LIVENESS (former hydra-orchestrator-watchdog.sh) and
# ## AUTOPILOT WEDGE (former hydra-autopilot-watchdog.sh). Per-block stale
# thresholds (service 15min, autopilot 25min). Issue #727 is the cutover:
# this single timer is now the live recovery mechanism, running at the
# 2-minute cadence the consolidated script was written for. The two legacy
# watchdogs are retired (see convergence step below).
install -D -m 0755 scripts/hydra-watchdog.sh "$HOME/.local/bin/hydra-watchdog.sh"

# Defensive convergence (issue #727): retire the two legacy watchdog timers so
# every deploy lands on EXACTLY ONE watchdog. The orchestrator-watchdog units
# were host-only (never deploy-managed); the autopilot-watchdog units WERE
# deploy-managed (former block here), so we also rm their unit files. Errors
# are tolerated — a fresh host won't have these units, and that's fine.
systemctl --user disable --now hydra-autopilot-watchdog.timer hydra-orchestrator-watchdog.timer 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/hydra-autopilot-watchdog.service" \
      "$HOME/.config/systemd/user/hydra-autopilot-watchdog.timer"

install -D -m 0644 scripts/systemd/hydra-watchdog.service "$HOME/.config/systemd/user/hydra-watchdog.service"
install -D -m 0644 scripts/systemd/hydra-watchdog.timer "$HOME/.config/systemd/user/hydra-watchdog.timer"
systemctl --user daemon-reload
systemctl --user enable --now hydra-watchdog.timer

echo "==> Installing housekeeping timer (issue #723)..."
# Scheduler fold PR-3/4 (issue #723): the five time-boxed housekeeping chores
# (blocked re-escalation, done-lane pruning, weekly digest, memory
# consolidation, design-concept snapshot) moved out of the 2-minute scheduler
# tick into an hourly timer that POSTs the idempotent
# /api/maintenance/housekeeping endpoint. This deploy step only STAGES the
# binary + units (mirroring the autopilot-watchdog block above). Enabling the
# timer is a deliberate HOST follow-up the operator performs post-merge:
#   systemctl --user daemon-reload && systemctl --user enable --now hydra-housekeeping.timer
install -D -m 0755 scripts/housekeeping.sh "$HOME/.local/bin/hydra-housekeeping.sh"
install -D -m 0644 scripts/systemd/hydra-housekeeping.service "$HOME/.config/systemd/user/hydra-housekeeping.service"
install -D -m 0644 scripts/systemd/hydra-housekeeping.timer "$HOME/.config/systemd/user/hydra-housekeeping.timer"

echo "==> Installing Pace Gate (ADR-0021, issue #858)..."
# The Pace Gate (scripts/autopilot/pace-gate.sh) is the usage-paced admission
# controller and the SOLE launcher of hydra-autopilot.service. It replaces the
# retired morning (10:00) / evening (22:00) autopilot timers: a ~15-min timer
# consults the Pacing Curve via /api/usage/eligibility and launches a run only
# when on/behind the curve and not in a 5h emergencyStop.
install -D -m 0755 scripts/autopilot/pace-gate.sh "$HOME/.local/bin/hydra-pace-gate.sh"

# Defensive convergence: retire the two legacy launch timers so every deploy
# lands on EXACTLY ONE launcher (the Pace Gate). Errors are tolerated — a fresh
# host won't have these units.
systemctl --user disable --now hydra-autopilot-morning.timer hydra-autopilot.timer 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/hydra-autopilot-morning.timer" \
      "$HOME/.config/systemd/user/hydra-autopilot.timer"

install -D -m 0644 scripts/systemd/hydra-pace-gate.service "$HOME/.config/systemd/user/hydra-pace-gate.service"
install -D -m 0644 scripts/systemd/hydra-pace-gate.timer "$HOME/.config/systemd/user/hydra-pace-gate.timer"

# Issue #1089 (recurrence): hydra-autopilot.service's ExecStart now routes
# through the pace-gate wrapper (`--exec-autopilot`) so systemd's
# Restart=on-failure relaunch passes the same admission check as the timer
# path (a session-limit exit used to storm: relaunch every 180s into the
# exhausted quota). The unit was previously host-managed; install it here so
# unit-file fixes actually deploy. NOT enabled/started — the Pace Gate timer
# remains the sole launcher, and installing the file does not disturb a
# running session (takes effect on the next start after daemon-reload).
# Host-local drop-ins (hydra-autopilot.service.d/) are preserved by design.
install -D -m 0644 scripts/systemd/hydra-autopilot.service "$HOME/.config/systemd/user/hydra-autopilot.service"

systemctl --user daemon-reload
systemctl --user enable --now hydra-pace-gate.timer

echo "==> Restarting service..."
systemctl --user restart hydra-orchestrator.service

echo "==> Waiting for health..."
sleep 5
if curl -sf http://localhost:4000/api/health | grep -q '"status":"ok"'; then
  echo "==> Deploy complete, service healthy."
else
  echo "==> WARNING: Health check failed after deploy!"
  exit 1
fi

echo "==> Stamping semver version tag (issue #3677)..."
# STRICTLY AFTER the health gate: a failed deploy never mints a version, so the
# tag always equals deployed-AND-healthy reality (#3655). We are still inside the
# flock re-exec'd at the top, so concurrent deploys serialize and there is no
# tag race. This step creates a git REF (`git tag`) and pushes it — it does NOT
# stage, commit, or checkout any tracked file, so it does NOT dirty the working
# tree and does NOT trip the line-34 dirty-tree guard (the #2663 stale-prod
# hazard). deploy.sh's changelog role is exactly zero (#3656 computed-join): the
# dashboard computes per-version notes from the .changelog/ tag-window diff.
#
# IDEMPOTENT: if HEAD already carries an exact tag, skip. This is mandatory (not
# cosmetic) — a bare 2nd `git tag <existing>` errors under `set -e`, and it makes
# the step safe under the ci.yml cancel-in-progress hazard: a cancelled-then-
# reran deploy on the same SHA sees the exact-match tag and no-ops.
if git describe --tags --exact-match HEAD >/dev/null 2>&1; then
  echo "    HEAD already tagged $(git describe --tags --exact-match HEAD) — skipping (idempotent)."
else
  # Previous tag (empty on a fresh repo => derive-version-bump baselines v1.0.0).
  PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
  # Commit range since the previous tag (whole history when no prior tag). The
  # NUL-subject / RS-record framing keeps multi-line bodies intact for
  # BREAKING-CHANGE detection; derive-version-bump.ts parses this exact shape.
  if [ -n "$PREV_TAG" ]; then
    GIT_LOG="$(git log "${PREV_TAG}..HEAD" --format='%s%x00%b%x1e')"
  else
    GIT_LOG="$(git log HEAD --format='%s%x00%b%x1e')"
  fi
  NEW_TAG="$(PREV_TAG="$PREV_TAG" GIT_LOG="$GIT_LOG" \
    node --experimental-strip-types scripts/ci/derive-version-bump.ts)"
  if [ -z "$NEW_TAG" ]; then
    echo "    WARNING: could not derive a version tag — skipping (deploy already healthy)."
  else
    COMMIT_COUNT="$(git rev-list "${PREV_TAG:+${PREV_TAG}..}HEAD" --count 2>/dev/null || echo '?')"
    # Annotated tag (#3655): carries author/date/message, preferred by
    # `git describe --tags`, and makes the version's provenance auditable.
    git tag -a "$NEW_TAG" -m "release ${NEW_TAG} (${COMMIT_COUNT} commits since ${PREV_TAG:-baseline})"
    echo "    Tagged ${NEW_TAG} on $(git rev-parse --short HEAD)."
    # Push the tag so `git describe --tags` is stable across fresh checkouts and
    # the /api/versions read (#3680) sees it. Tolerate a push failure (no remote
    # write, offline) — the local tag already reflects deployed reality and the
    # deploy itself succeeded; a failed tag push must not fail a healthy deploy.
    if git push origin "$NEW_TAG"; then
      echo "    Pushed ${NEW_TAG} to origin."
    else
      echo "    WARNING: failed to push ${NEW_TAG} to origin (local tag stands)."
    fi
  fi
fi
