#!/usr/bin/env bash
#
# Hydra entrypoint — starts the orchestrator and OpenAI proxy together.
# Used by systemd and for manual startup.
#
# Usage: ./bin/start.sh
#

set -euo pipefail

HYDRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HYDRA_DIR"

# Load .env if present
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Cleanup on exit
cleanup() {
  echo "[Hydra] Shutting down..."
  kill $PROXY_PID 2>/dev/null || true
  kill $HYDRA_PID 2>/dev/null || true
  wait
}
trap cleanup EXIT INT TERM

# Start OpenAI proxy in background
echo "[Hydra] Starting OpenAI proxy on port ${OPENAI_PROXY_PORT:-4001}..."
node src/openai-proxy.mjs &
PROXY_PID=$!

# Give proxy a moment to bind
sleep 1

# Start the orchestrator (foreground — systemd tracks this PID)
echo "[Hydra] Starting orchestrator on port ${HYDRA_PORT:-4000}..."
node src/index.mjs &
HYDRA_PID=$!

# Wait for either process to exit
wait -n
echo "[Hydra] A process exited — shutting down"
cleanup
