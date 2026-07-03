#!/bin/bash
# Daily Redis backup for the Hydra orchestrator.
# Sibling of hydra-pg-backup.sh (see docs/reference.md "## Backups").
# Retention: 7 days. Stored on SATA SSD at /mnt/hydra-ssd/backups/redis/ —
# a device physically distinct from the hydra_redis-data docker volume, so a
# `docker volume rm` / compose-recreate / volume corruption no longer loses
# the audit trail (evidence, events, backlog, run ledger, attribution state).
#
# Off-BOX shipping (gaming PC via Tailscale, cloud object storage) is
# deliberately OUT of scope — that needs an external destination + credentials
# (ADR-0005 operator-escalation territory). This captures the volume-loss
# failure mode on-box today; off-box is a separate operator decision.

set -u

CONTAINER="hydra-redis-1"
BACKUP_DIR="/mnt/hydra-ssd/backups/redis"
TIMESTAMP=$(date +%Y-%m-%d_%H%M)
BACKUP_FILE="${BACKUP_DIR}/hydra-redis-${TIMESTAMP}.rdb.gz"
RETENTION_DAYS=7
# Bounded wait for BGSAVE to land (seconds). ~16MB dataset saves near-instantly;
# 30s is generous headroom before we fail loud rather than copy a stale/partial file.
BGSAVE_TIMEOUT=30

mkdir -p "${BACKUP_DIR}"

# Read a single field out of `redis-cli INFO persistence`. INFO returns
# CRLF-terminated `key:value` lines; strip the trailing CR so numeric
# comparisons don't choke.
redis_info_field() {
  docker exec "${CONTAINER}" redis-cli INFO persistence 2>/dev/null \
    | awk -F: -v k="$1" '$1==k {gsub(/\r/,"",$2); print $2}'
}

# Capture the pre-BGSAVE save timestamp so we can confirm a NEW save lands
# (rather than racing an auto-RDB or an already-in-flight save).
PRE_SAVE_TIME=$(redis_info_field rdb_last_save_time)
if [ -z "${PRE_SAVE_TIME}" ]; then
  echo "[redis-backup] FAILED: could not read rdb_last_save_time from ${CONTAINER}" >&2
  exit 1
fi

# Fire a fresh point-in-time snapshot. BGSAVE returns immediately ("Background
# saving started"); we poll for completion below rather than trust the return.
if ! docker exec "${CONTAINER}" redis-cli BGSAVE >/dev/null 2>&1; then
  echo "[redis-backup] FAILED: BGSAVE command errored on ${CONTAINER}" >&2
  exit 1
fi

# Poll until the save LANDED: rdb_last_save_time advanced past the pre-snapshot
# value AND no save is in progress AND the last save succeeded. Fail loud on
# timeout or a non-ok status — never copy a stale or partial dump.rdb.
DEADLINE=$(( $(date +%s) + BGSAVE_TIMEOUT ))
while :; do
  IN_PROGRESS=$(redis_info_field rdb_bgsave_in_progress)
  LAST_STATUS=$(redis_info_field rdb_last_bgsave_status)
  LAST_SAVE_TIME=$(redis_info_field rdb_last_save_time)

  if [ "${IN_PROGRESS}" = "0" ] \
     && [ "${LAST_STATUS}" = "ok" ] \
     && [ -n "${LAST_SAVE_TIME}" ] \
     && [ "${LAST_SAVE_TIME}" -gt "${PRE_SAVE_TIME}" ] 2>/dev/null; then
    break
  fi

  if [ "${LAST_STATUS}" = "err" ]; then
    echo "[redis-backup] FAILED: rdb_last_bgsave_status=err — BGSAVE failed inside ${CONTAINER}" >&2
    exit 1
  fi

  if [ "$(date +%s)" -ge "${DEADLINE}" ]; then
    echo "[redis-backup] FAILED: BGSAVE did not land within ${BGSAVE_TIMEOUT}s (in_progress=${IN_PROGRESS} status=${LAST_STATUS})" >&2
    exit 1
  fi
  sleep 1
done

# Copy the now-current dump.rdb out of the docker volume via `docker cp`
# (avoids sudo on /var/lib/docker) and gzip it to the off-volume SSD.
TMP_RDB=$(mktemp)
if ! docker cp "${CONTAINER}:/data/dump.rdb" "${TMP_RDB}" >/dev/null 2>&1; then
  echo "[redis-backup] FAILED: docker cp of ${CONTAINER}:/data/dump.rdb errored" >&2
  rm -f "${TMP_RDB}" "${BACKUP_FILE}"
  exit 1
fi
gzip -c "${TMP_RDB}" > "${BACKUP_FILE}"
GZIP_RC=$?
rm -f "${TMP_RDB}"

if [ "${GZIP_RC}" -eq 0 ] && [ -s "${BACKUP_FILE}" ]; then
  SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
  echo "[redis-backup] OK: ${BACKUP_FILE} (${SIZE})"
else
  echo "[redis-backup] FAILED: backup is empty or errored" >&2
  rm -f "${BACKUP_FILE}"
  exit 1
fi

# Prune old backups (7-day window) and report the retained count.
find "${BACKUP_DIR}" -name "hydra-redis-*.rdb.gz" -mtime +${RETENTION_DAYS} -delete
REMAINING=$(ls -1 "${BACKUP_DIR}"/hydra-redis-*.rdb.gz 2>/dev/null | wc -l)
echo "[redis-backup] Retention: ${REMAINING} backups kept (${RETENTION_DAYS}-day window)"
