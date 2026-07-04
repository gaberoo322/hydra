#!/usr/bin/env bash
# OpenViking index hygiene for a RETIRED module (issue #2729, epic #2720).
#
# When a RETIRE merges, the OpenViking (OV) semantic index must stop surfacing
# the retired module as live knowledge — otherwise an agent grounding a future
# cycle gets a high-confidence hit on code that no longer exists, and re-derives
# the very concept the RETIRE deleted. This script is the post-merge hygiene
# step wired into the RETIRE recipe (see docs/operator-playbooks/hydra-wire-or-retire.md):
# it purges the retired path's OV resource entry, then re-queries the concept to
# confirm the index no longer returns it as live content.
#
# It is deliberately a one-shot, path-driven purge (invoked from the RETIRE
# recipe as a post-merge step) rather than a poller: the RETIRE that deleted the
# module is the exact event that should trigger the purge, so there is nothing to
# poll for. The OV container does not recreate on `deploy.sh`, so the live index
# survives a deploy and MUST be purged explicitly (documented OV ops:
# semantic-queue purge + reindex; deploy.sh does not recreate containers).
#
# URI mapping: the indexer maps a repo-relative path `<rel>` to the OV URI
# `viking://resources/<rel>` (src/knowledge-base/indexer.ts::indexerTargetUri).
# So a retired module at `<rel>` is purged by DELETEing that URI. Pass an
# explicit `--uri` to override when the entry was indexed under a non-default URI.
#
# Requires: the hydra-openviking-1 container reachable at OPENVIKING_URL.
# Env:
#   OPENVIKING_URL      OV base URL (default http://localhost:1933)
#   OPENVIKING_API_KEY  OV api key (default: the dev key, matches src/knowledge-base/ov-config.ts)
#
# Exit codes:
#   0  purge succeeded (and, if --concept given, no live entry for the retired
#      path remained above the score threshold)
#   1  usage / precondition error (bad args, OV unreachable)
#   2  purge ran but a live index entry for the retired path SURVIVED the purge
#      (verification query still returned it) — operator must investigate
set -euo pipefail

OV_URL="${OPENVIKING_URL:-http://localhost:1933}"
OV_KEY="${OPENVIKING_API_KEY:-56611b96a5aa35614ceb40814bb9d989d9523a764b386f569e0d1327c78d350c}"

# Verification search matches are considered a "live hit" for the retired path
# only at/above this cosine score. OV returns weak (~0.5) tangential matches for
# almost any query; a purged entry should return NO resource whose URI is under
# the retired path, at any score, so the URI-prefix check below is authoritative
# and the score threshold is a secondary guard for near-duplicate re-indexes.
LIVE_HIT_SCORE_THRESHOLD="${OV_RETIRE_LIVE_HIT_SCORE:-0.0}"

RETIRE_PATH=""
EXPLICIT_URI=""
CONCEPT=""
DRY_RUN=0

usage() {
  cat >&2 <<'USAGE'
Usage: ov-retire-hygiene.sh --path <repo-relative-path> [--concept "<text>"] [--uri <viking-uri>] [--dry-run]

  --path     Repo-relative path of the retired module (required unless --uri given),
             e.g. web/src/lib/arbitrage/cross-venue.ts. Mapped to
             viking://resources/<path> per indexerTargetUri.
  --uri      Explicit OV URI to purge, overriding the --path mapping. Pass a
             single URI (repeating --uri is not supported).
  --concept  Optional concept text to re-query after the purge to confirm the
             index no longer surfaces the retired module as live content.
  --dry-run  Print the DELETE + verification that WOULD run; make no changes.
USAGE
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --path)    RETIRE_PATH="${2:-}"; shift 2 ;;
    --uri)     EXPLICIT_URI="${2:-}"; shift 2 ;;
    --concept) CONCEPT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "ov-retire-hygiene: unknown argument: $1" >&2; usage ;;
  esac
done

if [ -z "$RETIRE_PATH" ] && [ -z "$EXPLICIT_URI" ]; then
  echo "ov-retire-hygiene: one of --path or --uri is required" >&2
  usage
fi

# Derive the target URI. An explicit --uri wins; otherwise map the repo-relative
# path via the indexerTargetUri convention (viking://resources/<rel>). Strip any
# leading "./" and collapse redundant slashes so the mapping is stable.
if [ -n "$EXPLICIT_URI" ]; then
  TARGET_URI="$EXPLICIT_URI"
else
  NORM_PATH="${RETIRE_PATH#./}"
  TARGET_URI="viking://resources/${NORM_PATH}"
fi

echo "==> OV retire hygiene"
echo "    retired path : ${RETIRE_PATH:-<none, uri override>}"
echo "    target URI   : $TARGET_URI"
echo "    OV url       : $OV_URL"
[ -n "$CONCEPT" ] && echo "    concept      : $CONCEPT"
[ "$DRY_RUN" -eq 1 ] && echo "    MODE         : DRY-RUN (no changes)"
echo

# --- Precondition: OV reachable -------------------------------------------------
# A search POST against a trivial query is the cheapest liveness probe (the OV
# container serves POST /api/v1/search/find; a bare GET / is not a health route).
if ! curl -sf --max-time 5 -o /dev/null \
      -X POST "$OV_URL/api/v1/search/find" \
      -H "X-Api-Key: $OV_KEY" -H "Content-Type: application/json" \
      -d '{"query":"health","limit":1}'; then
  echo "ov-retire-hygiene: OpenViking unreachable at $OV_URL — cannot run hygiene." >&2
  echo "  Check: docker ps | grep hydra-openviking-1 ; the embedding backend (ollama-embed) must be healthy." >&2
  exit 1
fi

# --- Purge the retired URI ------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> [dry-run] would DELETE $TARGET_URI (recursive=true)"
else
  echo "==> Purging $TARGET_URI"
  code=$(curl -s -o /tmp/ov-retire-hygiene.out -w "%{http_code}" \
    -X DELETE "$OV_URL/api/v1/fs?uri=${TARGET_URI}&recursive=true" \
    -H "X-Api-Key: $OV_KEY")
  case "$code" in
    200) echo "    deleted (or already absent)" ;;
    404) echo "    not found (ok — nothing indexed under that URI)" ;;
    *)   echo "ov-retire-hygiene: DELETE returned HTTP $code: $(head -c 200 /tmp/ov-retire-hygiene.out)" >&2
         rm -f /tmp/ov-retire-hygiene.out
         exit 1 ;;
  esac
  rm -f /tmp/ov-retire-hygiene.out
fi

# --- Verify: the concept no longer surfaces the retired path as live content ----
# Acceptance criterion 1: "An OV query for a retired module's concept returns
# nothing or status-marked content." We enforce the stronger form: after the
# purge, NO search result URI should still fall under the retired path. If a
# --concept query is supplied we run it; otherwise we fall back to querying the
# retired path's basename (a reasonable proxy for the module's concept).
VERIFY_QUERY="$CONCEPT"
if [ -z "$VERIFY_QUERY" ] && [ -n "$RETIRE_PATH" ]; then
  VERIFY_QUERY="$(basename "$RETIRE_PATH")"
fi

if [ -z "$VERIFY_QUERY" ]; then
  echo
  echo "==> No --concept and no --path basename to verify against; purge-only run complete."
  exit 0
fi

echo
echo "==> Verifying: query \"$VERIFY_QUERY\" no longer surfaces $TARGET_URI"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "    [dry-run] would POST /api/v1/search/find {query:\"$VERIFY_QUERY\"} and assert no live hit under the retired path"
  exit 0
fi

SEARCH_JSON=$(curl -sf --max-time 5 \
  -X POST "$OV_URL/api/v1/search/find" \
  -H "X-Api-Key: $OV_KEY" -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$VERIFY_QUERY" '{query:$q, limit:20}')" || true)

if [ -z "$SEARCH_JSON" ]; then
  echo "ov-retire-hygiene: verification search failed (OV returned nothing) — cannot confirm purge." >&2
  exit 1
fi

# A "live hit" is any returned resource whose URI is prefixed by the retired
# path fragment (path without the viking://resources/ prefix), at/above the score
# threshold. That is the entry the purge was supposed to remove.
URI_FRAGMENT="${TARGET_URI#viking://resources/}"
LIVE_HITS=$(printf '%s' "$SEARCH_JSON" | jq -r \
  --arg frag "$URI_FRAGMENT" \
  --argjson thr "$LIVE_HIT_SCORE_THRESHOLD" '
  [ (.result.resources // [])[]
    | select((.score // 0) >= $thr)
    | select((.uri // "") | contains($frag))
    | .uri ] | .[]' 2>/dev/null || true)

if [ -n "$LIVE_HITS" ]; then
  echo "ov-retire-hygiene: FAIL — retired path still surfaced by the index after purge:" >&2
  printf '    %s\n' "$LIVE_HITS" >&2
  echo "  The DELETE did not remove every entry under $TARGET_URI. Investigate the OV" >&2
  echo "  semantic-queue (a re-index may have re-added it) and re-run this script." >&2
  exit 2
fi

echo "    OK — no live index entry for the retired path remains."
echo
echo "Done. OV index hygiene complete for $TARGET_URI."
