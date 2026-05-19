#!/usr/bin/env bash
set -euo pipefail

# Deploy Hydra orchestrator + dashboard.
# Called by GitHub Actions self-hosted runner on merge to master,
# or manually: ./scripts/deploy.sh

HYDRA_ROOT="${HYDRA_ROOT:-/home/gabe/hydra}"
cd "$HYDRA_ROOT"

echo "==> Pulling latest..."
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

echo "==> Installing autopilot watchdog (issue #508)..."
# External liveness watchdog for the hydra-autopilot Claude Code session.
# The autopilot can wedge while the parent process stays "active" — systemd
# doesn't restart it because by its accounting nothing has failed. The
# watchdog reads the heartbeat file (scripts/autopilot/heartbeat.py) and
# kills the wedged PID; the unit's Restart=on-failure then brings it back.
install -D -m 0755 scripts/hydra-autopilot-watchdog.sh "$HOME/.local/bin/hydra-autopilot-watchdog.sh"
install -D -m 0644 scripts/systemd/hydra-autopilot-watchdog.service "$HOME/.config/systemd/user/hydra-autopilot-watchdog.service"
install -D -m 0644 scripts/systemd/hydra-autopilot-watchdog.timer "$HOME/.config/systemd/user/hydra-autopilot-watchdog.timer"
systemctl --user daemon-reload
systemctl --user enable --now hydra-autopilot-watchdog.timer

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
