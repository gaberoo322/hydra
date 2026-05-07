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

echo "==> Building dashboard..."
cd dashboard && npm ci && npm run build && cd ..

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
