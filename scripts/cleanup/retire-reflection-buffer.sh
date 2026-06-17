#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# retire-reflection-buffer.sh — one-shot cleanup of the dead global reflection
#                               buffer Redis key
# ---------------------------------------------------------------------------
#
# Issue #2020 (cleanup half). ADR-0023 retired the global/type-level reflection
# buffer: all of its code accessors (`pushReflection`, `getReflectionBuffer`,
# `replaceReflectionBuffer`, `recordReflection`, `loadRelevantReflections`, ...)
# and the `hydra:reflections:buffer` key were removed from `src/` in the #1454
# code-removal PR. Nothing reads or writes the buffer anymore.
#
# What was NOT removed is the residual *runtime* key in Redis: a stale,
# codex-era list (newest entry 2026-05-13, failureMode no-task / no-work /
# no-diff / verification-failed from the retired planner/executor loop). It is
# never read by `GET /api/reflections` (which is anchor-scoped only, per
# ADR-0023), so it does NOT affect the `reflectionMatchSource` metric — but it
# IS a diagnosis trap: an operator inspecting the reflection store sees ~20
# entries and falsely concludes the store is populated, when the live per-anchor
# / by-file surfaces are empty (the honest-'none' condition #2020 documents).
#
# This script removes that one residual key. Mirrors `retire-specs.sh` exactly
# (the established one-shot runtime-Redis prune precedent). Safe to run
# repeatedly — exits 0 when the key is already gone.
#
# Usage:
#   bash scripts/cleanup/retire-reflection-buffer.sh            # uses REDIS_URL or
#                                                               # redis://localhost:6379
#   REDIS_URL=redis://host:6379/2 bash scripts/cleanup/retire-reflection-buffer.sh
#   bash scripts/cleanup/retire-reflection-buffer.sh --dry-run  # report, don't delete

set -euo pipefail

REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v redis-cli >/dev/null 2>&1; then
  echo "[retire-reflection-buffer] redis-cli not on PATH; install redis-tools to run this script" >&2
  exit 1
fi

# The dead global reflection buffer is a single fixed-name list key, not a
# pattern family — so an EXISTS/LLEN check is enough; no SCAN needed.
KEY="hydra:reflections:buffer"

exists=$(redis-cli -u "$REDIS_URL" EXISTS "$KEY")
if [ "$exists" != "1" ]; then
  echo "[retire-reflection-buffer] $KEY does not exist; nothing to prune."
  exit 0
fi

entries=$(redis-cli -u "$REDIS_URL" LLEN "$KEY" 2>/dev/null || echo "?")

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[retire-reflection-buffer] DRY-RUN: would delete $KEY (${entries} entr$( [ "$entries" = "1" ] && echo y || echo ies ))."
  exit 0
fi

redis-cli -u "$REDIS_URL" DEL "$KEY" >/dev/null
echo "[retire-reflection-buffer] Deleted $KEY (${entries} stale entr$( [ "$entries" = "1" ] && echo y || echo ies )); the dead global buffer is pruned."
