#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# retire-specs.sh — one-shot cleanup of orphaned Specs subsystem state
# ---------------------------------------------------------------------------
#
# Issue #513. The Specs subsystem was deleted in code; the residual
# `hydra:specs:*` keys in Redis are no longer read or written. This script
# removes them. Safe to run repeatedly — exits 0 when nothing matches.
#
# Usage:
#   bash scripts/cleanup/retire-specs.sh             # uses REDIS_URL or
#                                                    # redis://localhost:6379
#   REDIS_URL=redis://host:6379/2 bash scripts/cleanup/retire-specs.sh
#   bash scripts/cleanup/retire-specs.sh --dry-run   # list keys, don't delete

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
  echo "[retire-specs] redis-cli not on PATH; install redis-tools to run this script" >&2
  exit 1
fi

PATTERNS=(
  "hydra:specs:*"
)

total_seen=0
total_deleted=0

for pattern in "${PATTERNS[@]}"; do
  # Use SCAN to avoid blocking Redis on large keyspaces. Build the key list
  # one cursor at a time, then DEL in batches.
  cursor=0
  batch=()
  while :; do
    out=$(redis-cli -u "$REDIS_URL" --no-raw SCAN "$cursor" MATCH "$pattern" COUNT 200)
    cursor=$(printf '%s\n' "$out" | head -n1)
    # The remaining lines are the matched keys for this cursor step.
    while IFS= read -r key; do
      [ -z "$key" ] && continue
      # redis-cli wraps keys in quotes in --no-raw mode — strip them.
      key="${key%\"}"
      key="${key#\"}"
      batch+=("$key")
      total_seen=$((total_seen + 1))
    done < <(printf '%s\n' "$out" | tail -n +2)
    if [ "$cursor" = "0" ]; then
      break
    fi
  done

  if [ "${#batch[@]}" -eq 0 ]; then
    echo "[retire-specs] No keys match $pattern"
    continue
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[retire-specs] DRY-RUN: would delete ${#batch[@]} key(s) matching $pattern:"
    printf '  %s\n' "${batch[@]}"
  else
    # Delete in chunks of 100 to avoid blowing argv limits.
    chunk_size=100
    i=0
    while [ "$i" -lt "${#batch[@]}" ]; do
      chunk=("${batch[@]:i:chunk_size}")
      redis-cli -u "$REDIS_URL" DEL "${chunk[@]}" >/dev/null
      total_deleted=$((total_deleted + ${#chunk[@]}))
      i=$((i + chunk_size))
    done
    echo "[retire-specs] Deleted ${#batch[@]} key(s) matching $pattern"
  fi
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[retire-specs] DRY-RUN complete; ${total_seen} key(s) would be deleted."
else
  echo "[retire-specs] Done; ${total_deleted} key(s) deleted."
fi
