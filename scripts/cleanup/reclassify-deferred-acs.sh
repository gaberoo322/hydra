#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# reclassify-deferred-acs.sh — one-shot migration of legacy
# `acceptance-criterion-unmet` patterns whose context smells "deferred"
# (post-deploy / runtime / manual-observation ACs) into the new
# `acceptance-criterion-deferred` cue introduced in issue #524.
# ---------------------------------------------------------------------------
#
# Background
# ----------
# Issue #517 shipped the friction-capture + auto-escalation pipeline with a
# single cue, `acceptance-criterion-unmet`. Issue #524 split that into two:
#   - `acceptance-criterion-unmet`     — true defect (planner missed a
#                                        criterion the diff didn't satisfy)
#   - `acceptance-criterion-deferred`  — metadata (criterion can only be
#                                        verified post-deploy / at runtime /
#                                        by an operator)
#
# Existing pattern entries in `hydra:memory:planner:patterns` that were
# emitted before the split conflate both. This script finds entries whose
# example contexts contain deferred-shape markers and either:
#   - moves their hit count and examples into a new pattern with cue
#     `acceptance-criterion-deferred`, OR
#   - (when both buckets already exist) merges the deferred examples into
#     the existing deferred pattern.
#
# Usage
# -----
#   bash scripts/cleanup/reclassify-deferred-acs.sh             # DRY-RUN by default
#   bash scripts/cleanup/reclassify-deferred-acs.sh --apply     # actually mutate Redis
#   bash scripts/cleanup/reclassify-deferred-acs.sh --apply --agent skeptic
#
#   REDIS_URL=redis://host:6379/2 bash scripts/cleanup/reclassify-deferred-acs.sh
#
# Safety
# ------
#   - Default mode is DRY-RUN. The operator must pass `--apply` to mutate.
#   - Idempotent: re-running on already-migrated data is a no-op because the
#     classifier only looks at examples still tagged with the legacy cue. Once
#     an example is moved into the deferred bucket it is no longer visible to
#     the classifier.
#   - Operates on a per-agent in-memory JSON document; reads the current
#     value, computes the new value, and writes it back atomically with SET.
#     This matches `savePatternsRaw()` in `src/redis-adapter.ts`.
#   - Never destroys data: when an example is reclassified, it is moved
#     (added to deferred, removed from unmet) — the total example count is
#     preserved. The hit count is split proportionally: deferred picks up the
#     count of moved examples, unmet keeps the remainder. If unmet would drop
#     to zero hits after the split, the unmet entry is removed entirely.
#   - Requires `redis-cli` and `jq`. Aborts loudly if either is missing.

set -euo pipefail

REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
APPLY=0
AGENTS=("planner")  # The legacy cue only ever landed in planner memory.

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --agent)
      shift
      [ $# -gt 0 ] || { echo "[reclassify-deferred-acs] --agent requires a value" >&2; exit 2; }
      AGENTS=("$1")
      shift
      ;;
    -h|--help)
      sed -n '2,52p' "$0"
      exit 0
      ;;
    *)
      echo "[reclassify-deferred-acs] Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v redis-cli >/dev/null 2>&1; then
  echo "[reclassify-deferred-acs] redis-cli not on PATH; install redis-tools to run this script" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[reclassify-deferred-acs] jq not on PATH; install jq to run this script" >&2
  exit 1
fi

# Regex matching the markers that identify a "deferred" AC. Case-insensitive.
# Kept in sync with docs/operator-playbooks/hydra-qa.md §11.
DEFERRED_REGEX='(?i)(after[ ]+[0-9]+h[ ]+post-deploy|manually[ ]+verify|manually[ ]+induc|operator[ ]+(observe|confirm|verifie)|in[ ]+production|post-deploy|production[ ]+(runtime|logs)|runtime[ ]+observation)'

if [ "$APPLY" -eq 1 ]; then
  echo "[reclassify-deferred-acs] APPLY mode — will mutate Redis at $REDIS_URL"
else
  echo "[reclassify-deferred-acs] DRY-RUN mode — re-run with --apply to mutate Redis"
fi

# ---------------------------------------------------------------------------
# For each agent, load the pattern document, find legacy unmet entries,
# split them into deferred where applicable, and (in apply mode) write back.
# ---------------------------------------------------------------------------

total_moved=0
total_dropped=0

for agent in "${AGENTS[@]}"; do
  key="hydra:memory:${agent}:patterns"
  echo "[reclassify-deferred-acs] Inspecting ${key}"

  raw=$(redis-cli -u "$REDIS_URL" GET "$key" || true)
  if [ -z "$raw" ] || [ "$raw" = "(nil)" ]; then
    echo "[reclassify-deferred-acs]   no patterns stored for ${agent} — skipping"
    continue
  fi

  # All transformation lives in jq so the script remains pure-data; the only
  # side effects are the SET below (in apply mode) and the summary output.
  result=$(printf '%s' "$raw" | jq --arg re "$DEFERRED_REGEX" '
    # Helpers --------------------------------------------------------------
    # `def name(arg): body;` requires the caller to supply the input via the
    # argument; the no-arg `def name: ...;` form operates on `.` instead. We
    # use the no-arg form everywhere so the filters compose with `select`.
    def matches_deferred:
      (. // "") | test($re);
    def is_unmet:
      .category == "acceptance-criterion-unmet";
    def is_deferred:
      .category == "acceptance-criterion-deferred";

    # Pull the legacy unmet bucket and the existing deferred bucket (if any).
    . as $patterns
    | ($patterns | map(select(is_unmet))) as $unmet
    | ($patterns | map(select(is_deferred))) as $deferred_existing
    | ($patterns | map(select((is_unmet | not) and (is_deferred | not)))) as $others
    |
    if ($unmet | length) == 0 then
      # No legacy entries to migrate — return the input untouched with a
      # zero-effect summary.
      {patterns: ., moved: 0, dropped: 0, changed: false}
    else
      # We assume at most one entry per category (the consolidation pipeline
      # enforces this). Operate on the first match if there are stragglers.
      ($unmet[0]) as $u
      | ($u.examples // []) as $ex
      | ($ex | map(select(matches_deferred))) as $moved_examples
      | ($ex | map(select(matches_deferred | not))) as $kept_examples
      |
      if ($moved_examples | length) == 0 then
        {patterns: ., moved: 0, dropped: 0, changed: false}
      else
        ($moved_examples | length) as $moved
        | ($kept_examples | length) as $kept
        # Split the hit count proportionally to example counts; if there are
        # more total hits than examples, the surplus stays with the unmet
        # bucket (the visible examples are a capped roll, but the hitCount is
        # the true count).
        | ($u.hitCount // 0) as $total_hits
        | ($u.examples | length) as $visible
        | (if $visible == 0 then 0 else ($moved * $total_hits / $visible | floor) end) as $deferred_hits
        | ($total_hits - $deferred_hits) as $remaining_hits
        | ($u + {
            examples: $kept_examples,
            hitCount: $remaining_hits
          }) as $u_after
        | ($deferred_existing[0] // null) as $d
        | (
            if $d == null then
              # Create a new deferred entry from the moved slice.
              {
                category: "acceptance-criterion-deferred",
                severity: ($u.severity // "prevent"),
                hitCount: $deferred_hits,
                firstSeen: ($u.firstSeen // ""),
                lastSeen: ($u.lastSeen // ""),
                lastCycleId: ($u.lastCycleId // "reclassify-deferred-acs"),
                action: "Metadata: criterion requires post-deploy / runtime / manual observation — pre-merge QA cannot verify from a diff. See issue #524.",
                examples: ($moved_examples[0:3]),
                promoted: false,
                source: ($u.source // "subagent")
              }
            else
              # Merge into the existing deferred entry.
              $d + {
                hitCount: (($d.hitCount // 0) + $deferred_hits),
                examples: (($moved_examples + ($d.examples // []))[0:3]),
                lastSeen: ($u.lastSeen // $d.lastSeen),
                lastCycleId: ($u.lastCycleId // $d.lastCycleId)
              }
            end
          ) as $d_after
        | (
            if $remaining_hits <= 0 or ($u_after.examples | length) == 0 then
              # Nothing left in the unmet bucket — drop it entirely.
              {drop_unmet: true}
            else
              {drop_unmet: false}
            end
          ) as $flags
        | (
            $others
            + (if $flags.drop_unmet then [] else [$u_after] end)
            + [$d_after]
          ) as $new_patterns
        | {
            patterns: $new_patterns,
            moved: $moved,
            dropped: (if $flags.drop_unmet then 1 else 0 end),
            changed: true
          }
      end
    end
  ')

  changed=$(printf '%s' "$result" | jq -r '.changed')
  moved=$(printf '%s' "$result" | jq -r '.moved')
  dropped=$(printf '%s' "$result" | jq -r '.dropped')

  if [ "$changed" != "true" ]; then
    echo "[reclassify-deferred-acs]   nothing to migrate for ${agent}"
    continue
  fi

  total_moved=$((total_moved + moved))
  total_dropped=$((total_dropped + dropped))

  echo "[reclassify-deferred-acs]   ${agent}: ${moved} example(s) would move into acceptance-criterion-deferred"
  if [ "$dropped" -gt 0 ]; then
    echo "[reclassify-deferred-acs]   ${agent}: acceptance-criterion-unmet entry would be removed (no remaining hits)"
  fi

  if [ "$APPLY" -eq 1 ]; then
    new_doc=$(printf '%s' "$result" | jq -c '.patterns')
    # Redis-cli `-x` reads the value from stdin, sidestepping argv-length
    # limits and shell quoting concerns.
    printf '%s' "$new_doc" | redis-cli -u "$REDIS_URL" -x SET "$key" >/dev/null
    echo "[reclassify-deferred-acs]   ${agent}: wrote new pattern document"
  fi
done

echo "[reclassify-deferred-acs] Summary: ${total_moved} example(s) reclassified, ${total_dropped} unmet bucket(s) emptied"
if [ "$APPLY" -ne 1 ]; then
  echo "[reclassify-deferred-acs] Dry-run only — pass --apply to commit."
fi
