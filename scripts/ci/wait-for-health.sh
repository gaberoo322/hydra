#!/usr/bin/env bash
set -euo pipefail

# scripts/ci/wait-for-health.sh — bounded post-deploy health poll (issue #4238).
#
# Replaces the `sleep 5` + single un-retried curl that used to sit in
# scripts/deploy.sh. That fixed window false-redded ~7.5% of master deploys
# (3 of the last 40): the service was healthy a few seconds later, but the job
# had already exited 1 — and, because the version stamp sits STRICTLY behind the
# health gate (#3655/#3733), each false red also left prod deployed but untagged.
# Journals show the usual shape is deploy.sh restarting the unit, systemd
# reporting Started ~4-6s later (ExecStartPre=npx tsc), the watchdog's Check 1
# ticking inside that boot window and restarting the service a SECOND time, and
# the single probe at T+5s landing ~1s before the second boot listens. The worst
# SINGLE boot observed was 18s, so a constant is unsafe even without the
# watchdog. A poll waits through any number of intervening boots and fails only
# when the service never reaches healthy by the deadline.
#
# CONTRACT
#   $1                              health URL (default http://localhost:4000/api/health)
#   HYDRA_DEPLOY_HEALTH_TIMEOUT_S   deadline in seconds (default 90)
#   HYDRA_DEPLOY_HEALTH_INTERVAL_S  seconds between probes (default 2)
#   exit 0  — first probe whose body contains BOTH "status":"ok" AND "redis":true.
#             This is the SAME predicate scripts/hydra-watchdog.sh Check 1 enforces,
#             so this script never reports healthy a service the watchdog would
#             immediately restart. Lateness (healthy after more than the legacy
#             5s window) is reported on stdout plus a ::notice:: annotation — it
#             is a diagnostic, NEVER a non-zero exit. CI sees only red/green, and
#             any non-zero exit on a healthy prod is exactly the false red this
#             script exists to remove.
#   exit 1  — the deadline passed with no healthy probe. The last probe's curl
#             exit code and the first 200 bytes of its body are printed so the
#             deploy log explains WHY (connection refused vs. redis:false vs.
#             status:killed). The caller adds host-specific diagnostics.
#
# HOST-AGNOSTIC BY DESIGN: bash, curl, grep and date only — no jq, no node, no
# systemctl, no journalctl — so test/wait-for-health.test.mts can run the real
# script against an ephemeral local HTTP server. Host diagnostics (the journal
# tail) stay in scripts/deploy.sh.
#
# Run as a CHILD PROCESS from deploy.sh (`bash scripts/ci/wait-for-health.sh ||
# HEALTH_RC=$?`), never sourced or inlined: under `set -euo pipefail` both
# `fn || handle` and `( … ) || handle` suppress errexit for the whole body, so a
# separate process is the only form that keeps this script's own `set -e` live
# (the #3733 lesson from scripts/ci/stamp-version.sh).

URL="${1:-http://localhost:4000/api/health}"
TIMEOUT_S="${HYDRA_DEPLOY_HEALTH_TIMEOUT_S:-90}"
INTERVAL_S="${HYDRA_DEPLOY_HEALTH_INTERVAL_S:-2}"
# The window the retired fixed sleep gave the service. Healthy-after-longer is
# what used to false-red, so it is worth a visible (non-red) annotation.
LEGACY_WINDOW_S=5

start="$(date +%s)"
deadline=$((start + TIMEOUT_S))
probes=0
last_rc=0
last_body=""

while :; do
  probes=$((probes + 1))
  last_rc=0
  # -sS: quiet on success, but error text lands in last_body for the diagnostic
  # line. --max-time bounds a hung socket so one probe can never eat the deadline.
  # No -f: a 503 body still gets inspected (it simply fails the predicate).
  last_body="$(curl -sS --max-time 3 "$URL" 2>&1)" || last_rc=$?

  if [ "$last_rc" -eq 0 ] \
     && printf '%s' "$last_body" | grep -q '"status":"ok"' \
     && printf '%s' "$last_body" | grep -q '"redis":true'; then
    now="$(date +%s)"
    elapsed=$((now - start))
    echo "==> healthy after ${elapsed}s (${probes} probes)"
    if [ "$elapsed" -gt "$LEGACY_WINDOW_S" ]; then
      echo "::notice::Service became healthy after ${elapsed}s (${probes} probes) — slower than the legacy ${LEGACY_WINDOW_S}s window that used to false-red this deploy. Healthy is healthy; this is informational (issue #4238)."
    fi
    exit 0
  fi

  now="$(date +%s)"
  if [ "$now" -ge "$deadline" ]; then
    elapsed=$((now - start))
    echo "==> not healthy after ${elapsed}s (${probes} probes; deadline ${TIMEOUT_S}s)"
    echo "==> last probe: curl exit ${last_rc}; body head: ${last_body:0:200}"
    exit 1
  fi

  sleep "$INTERVAL_S"
done
