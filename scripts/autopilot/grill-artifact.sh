#!/usr/bin/env bash
#
# grill-artifact.sh — `/hydra-grill` helpers (Phase A of #437; sub-issue #439).
#
# Three subcommands. All keep `set -euo pipefail`-clean and emit machine-
# readable output on stdout so the calling skill (`hydra-grill`) can chain
# them inside the SKILL.md prose without inlining curl/jq spaghetti.
#
#   write <json-body-path>
#       POST the design-concept artifact body to
#       /api/design-concepts. Prints the JSON response on stdout. Exits
#       non-zero if the API returns a non-2xx. The body file must already
#       contain a valid {anchorRef, scope, ...} payload — this script does
#       not synthesise it.
#
#   approve <anchorRef> <by>
#       POST /api/design-concepts/:anchorRef/approve with the supplied
#       approver (must be "auto-gate" or "operator:<name>"). Prints the
#       full response (artifact + gate verdict) on stdout. Exits non-zero
#       on 4xx/5xx.
#
#   gate <anchorRef>
#       GET /api/design-concepts/:anchorRef and print just the `gate`
#       sub-object on stdout: {"ok": <bool>, "reasons": [...]}. Exit
#       code mirrors `.gate.ok`: 0 when ok, 1 when not. Use this from
#       the skill to decide auto-approve vs escalate.
#
# Environment:
#   HYDRA_API_BASE  defaults to http://localhost:4000
#
# Issue #439 ships this as a thin helper rather than inlining the curl
# calls in SKILL.md prose: bash is safer than free-form prose for the
# auto-approve/escalate gate decision, and a regression test can lock
# the contract once the skill is wired in Phase B.

set -euo pipefail

API="${HYDRA_API_BASE:-http://localhost:4000}"

usage() {
  cat <<'EOF' >&2
usage:
  grill-artifact.sh write <json-body-path>
  grill-artifact.sh approve <anchorRef> <by>
  grill-artifact.sh gate <anchorRef>
EOF
  exit 2
}

cmd="${1:-}"
shift || true

case "$cmd" in
  write)
    body_path="${1:-}"
    [ -z "$body_path" ] && usage
    [ -f "$body_path" ] || { echo "grill-artifact: body file '$body_path' not found" >&2; exit 2; }

    # --fail-with-body so 4xx/5xx bodies surface on stderr and the call
    # is non-zero. --max-time bounds the call so a wedged orchestrator
    # cannot stall the parent skill indefinitely.
    curl -sS --fail-with-body --max-time 10 \
      -X POST "$API/api/design-concepts" \
      -H 'content-type: application/json' \
      --data-binary "@$body_path"
    echo
    ;;

  approve)
    ref="${1:-}"
    by="${2:-}"
    [ -z "$ref" ] || [ -z "$by" ] && usage

    if [ "$by" != "auto-gate" ] && ! printf '%s' "$by" | grep -q '^operator:'; then
      echo "grill-artifact: 'by' must be 'auto-gate' or 'operator:<name>' (got '$by')" >&2
      exit 2
    fi

    payload=$(printf '{"by":%s}' "$(jq -n --arg by "$by" '$by')")
    curl -sS --fail-with-body --max-time 10 \
      -X POST "$API/api/design-concepts/$ref/approve" \
      -H 'content-type: application/json' \
      --data "$payload"
    echo
    ;;

  gate)
    ref="${1:-}"
    [ -z "$ref" ] && usage

    # 404 → propagate as exit 2 (no artifact) so the caller can
    # distinguish missing-artifact from gate-fail.
    response=$(curl -sS --max-time 10 -w '\n%{http_code}' \
      "$API/api/design-concepts/$ref")
    http_code=$(printf '%s' "$response" | tail -n1)
    body=$(printf '%s' "$response" | sed '$d')

    if [ "$http_code" = "404" ]; then
      echo "grill-artifact: no artifact for anchorRef '$ref'" >&2
      exit 2
    fi
    if [ "$http_code" != "200" ]; then
      echo "grill-artifact: API returned HTTP $http_code" >&2
      printf '%s\n' "$body" >&2
      exit 3
    fi

    gate=$(printf '%s' "$body" | jq -c '.gate')
    ok=$(printf '%s' "$gate" | jq -r '.ok')
    printf '%s\n' "$gate"

    [ "$ok" = "true" ] && exit 0 || exit 1
    ;;

  *)
    usage
    ;;
esac
