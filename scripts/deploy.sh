#!/usr/bin/env bash
set -euo pipefail

# Deploy Hydra orchestrator + dashboard.
# Called by GitHub Actions self-hosted runner on merge to master,
# or manually: ./scripts/deploy.sh

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
