#!/usr/bin/env bash
#
# dc-telemetry-snapshot.sh — Daily snapshot writer for design-concept
# Phase B telemetry (issue #465, sub of #437).
#
# Fetches the current telemetry view from `/api/design-concepts/telemetry`
# and writes a flattened status-only HASH to
#   hydra:dc:daily_snapshot:{YYYY-MM-DD}
# with a 30-day TTL.
#
# The snapshot is what the next day's rollup reads to compute
# `consecutive_green_days` for promotion eligibility. Keeping just the
# status (not the value) makes the consecutive-green check
# threshold-version-invariant.
#
# Idempotent — running it twice in the same UTC day overwrites the
# existing key rather than duplicating entries. The matching systemd
# timer fires once at 23:59 UTC.
#
# Required tools: curl, jq, redis-cli (via docker exec on hydra-redis-1).
#
# Environment:
#   HYDRA_API_BASE     defaults to http://localhost:4000
#   HYDRA_REDIS_EXEC   command prefix for redis-cli; defaults to
#                      "docker exec -i hydra-redis-1 redis-cli". Override
#                      with "redis-cli" for a local non-containerized run.

set -euo pipefail

API="${HYDRA_API_BASE:-http://localhost:4000}"
REDIS_EXEC="${HYDRA_REDIS_EXEC:-docker exec -i hydra-redis-1 redis-cli}"

# UTC date — match the JS computation in src/design-concept/telemetry.ts ymd().
day="$(date -u +%F)"
key="hydra:dc:daily_snapshot:${day}"

# Fetch the current rollup. `--fail-with-body` so 4xx/5xx surface non-zero
# and the systemd unit logs the failure.
telemetry_json="$(curl -sS --fail-with-body --max-time 10 \
  "$API/api/design-concepts/telemetry")"

# Build the HSET argv from the response. The HASH fields are the criterion
# names + min_sample + writtenAt; values are the status strings ("green" /
# "yellow" / "red"). jq emits "field value field value ..." in null-separated
# form so we can safely transport it through xargs.
hset_args="$(
  printf '%s' "$telemetry_json" \
  | jq -r '
      [
        (.criteria | to_entries[] | [.key, .value.status]),
        ["min_sample", .min_sample.status],
        ["writtenAt", (now | todateiso8601)]
      ]
      | .[]
      | @sh
    '
)"

if [ -z "$hset_args" ]; then
  echo "dc-telemetry-snapshot: jq returned no fields for $day — refusing to write empty snapshot" >&2
  exit 3
fi

# DEL+HSET in a transaction so idempotency holds: the second run for the
# same UTC day overwrites the prior key cleanly even if the criterion
# set has grown. Pipe through redis-cli on stdin to avoid quoting hell.
{
  echo "MULTI"
  echo "DEL $key"
  # Use eval to expand the jq @sh quoting safely — each pair becomes
  # 'field' 'value' on the HSET line.
  eval "echo HSET $key $hset_args"
  echo "EXPIRE $key 2592000"
  echo "EXEC"
} | $REDIS_EXEC

echo "dc-telemetry-snapshot: wrote $key"
