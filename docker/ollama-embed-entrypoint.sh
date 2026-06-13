#!/bin/sh
# Entrypoint for the local CPU Ollama that serves OpenViking's dense embedding
# model (nomic-embed-text, 768-dim) on the hydra-server. See issue #1795.
#
# The stock ollama/ollama image's entrypoint is just `ollama serve`, with no
# hook to pull a model on first boot. We need the embedding model present
# before OpenViking starts embedding, so this wrapper:
#   1. starts the server in the background,
#   2. waits for it to accept connections,
#   3. pulls nomic-embed-text (idempotent — a no-op once the volume has it),
#   4. then waits on the server process so the container stays up.
#
# The compose healthcheck (`ollama list | grep -q nomic-embed-text`) only goes
# healthy after step 3 lands, so openviking's `depends_on ... service_healthy`
# blocks until the model is actually available.
set -e

MODEL="nomic-embed-text"

echo "[ollama-embed] starting ollama serve in background..."
ollama serve &
SERVE_PID=$!

# Wait for the local API to come up (ollama listens on 11434 by default).
echo "[ollama-embed] waiting for ollama API..."
i=0
until ollama list >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[ollama-embed] ollama API did not come up within 60s" >&2
    exit 1
  fi
  sleep 1
done

echo "[ollama-embed] pulling ${MODEL} (idempotent)..."
ollama pull "${MODEL}"

echo "[ollama-embed] ${MODEL} ready; serving."
# Keep the container alive on the long-lived server process.
wait "$SERVE_PID"
