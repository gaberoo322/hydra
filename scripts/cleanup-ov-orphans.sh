#!/usr/bin/env bash
# Clean up orphan top-level OV resources that were created when the indexer
# omitted the `to:` parameter (fixed in src/learning/ov-upload.ts via this PR).
#
# Run once after deploying the indexer fix. Safe to re-run; missing entries
# are reported as no-ops. The proper nested entries
# (viking://resources/direction/*) are not touched.
#
# Requires: hydra-openviking-1 container running.
# Env: OPENVIKING_API_KEY (defaults to the dev key in src/learning/ov-upload.ts).

set -euo pipefail

OV_URL="${OPENVIKING_URL:-http://localhost:1933}"
OV_KEY="${OPENVIKING_API_KEY:-56611b96a5aa35614ceb40814bb9d989d9523a764b386f569e0d1327c78d350c}"

# Top-level orphans observed on the production instance. These all have a
# corresponding properly-nested entry under viking://resources/direction/ or
# under their canonical agent-config directory, so the top-level entry is
# pure pollution — search would surface duplicates and renames into them
# fail with "file exists".
ORPHAN_URIS=(
  "viking://resources/priorities"
  "viking://resources/roadmap"
  "viking://resources/goals"
  "viking://resources/vision"
  "viking://resources/north-star"
  "viking://resources/research-journal"
  "viking://resources/tech-preferences"
  "viking://resources/proposal-policy"
  "viking://resources/to-executor"
  "viking://resources/to-planner"
  "viking://resources/to-skeptic"
)

echo "==> Deleting orphan top-level resources"
for uri in "${ORPHAN_URIS[@]}"; do
  printf "  %-60s " "$uri"
  code=$(/usr/bin/curl -s -o /tmp/ov-cleanup.out -w "%{http_code}" \
    -X DELETE "$OV_URL/api/v1/fs?uri=${uri}&recursive=true" \
    -H "X-Api-Key: $OV_KEY")
  case "$code" in
    200) echo "deleted" ;;
    404) echo "not found (ok)" ;;
    *)   echo "HTTP $code: $(head -c 200 /tmp/ov-cleanup.out)" ;;
  esac
done

echo
echo "==> Cleaning abandoned temp directories"
# Each failed rename leaves behind a /app/workspace/viking/hydra/temp/<ts>/
# directory. They accumulate indefinitely. Anything older than 1 hour is
# guaranteed-abandoned (no in-flight indexing operation lasts that long).
docker exec hydra-openviking-1 sh -c '
  find /app/workspace/viking/hydra/temp -mindepth 1 -maxdepth 1 -type d -mmin +60 \
    -exec rm -rf {} + 2>/dev/null
  echo "  remaining temp dirs: $(ls /app/workspace/viking/hydra/temp 2>/dev/null | wc -l)"
'

echo
echo "==> Triggering re-index of direction/ docs into proper nested paths"
for f in priorities.md roadmap.md research-journal.md goals.md vision.md; do
  uri="viking://resources/direction/$f"
  printf "  %-60s " "$uri"
  code=$(/usr/bin/curl -s -o /tmp/ov-cleanup.out -w "%{http_code}" \
    -X POST "$OV_URL/api/v1/resources" \
    -H "X-Api-Key: $OV_KEY" -H "Content-Type: application/json" \
    -d "{\"path\":\"/config/direction/$f\",\"to\":\"$uri\",\"wait\":false}")
  case "$code" in
    200) echo "queued" ;;
    *)   echo "HTTP $code: $(head -c 200 /tmp/ov-cleanup.out)" ;;
  esac
done

rm -f /tmp/ov-cleanup.out
echo
echo "Done. The indexer fix in src/learning/ov-upload.ts will keep these clean going forward."
