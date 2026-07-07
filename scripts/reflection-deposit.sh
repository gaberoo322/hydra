#!/usr/bin/env bash
# reflection-deposit.sh — deterministic reflection/grounding telemetry deposit
# helper for hydra-dev / hydra-target-build worktree subagents (issue #2947,
# parent epic #2944).
#
# WHY THIS SCRIPT EXISTS
#   The reflection-source deposit, the per-anchor deposit, and the grounding
#   test-count deposit were three multi-hundred-word inline bash blobs carried
#   in the shared playbook fragments (docs/operator-playbooks/_fragments/
#   reflection-telemetry-deposit.md + grounding-tests-deposit.md), including
#   heavy bug-archaeology comments. #2947 lifts that logic into this ONE
#   deterministic helper so the key-derivation lives in a single testable place;
#   the fragments now just invoke this script. Behavior is preserved EXACTLY —
#   same deposit keys, same graceful no-op, same FAIL-LOUD-on-stderr semantics.
#
# BEHAVIOR CONTRACT (must stay byte-identical to the retired inline bash)
#   - reap.py reads the reflection-source deposit at
#       ${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-sources-<task_id>
#     the anchor deposit at
#       ${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-anchor-<task_id>
#     and the grounding test-count deposit at
#       ${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-grounding-tests-<task_id>
#   - <task_id> is the HARNESS task id. PRIMARY source: the `agent-<HASH>`
#     worktree-dir basename (12+ hex chars), which is the branch suffix
#     `worktree-agent-<HASH>` and the slot `task_id` reap reads (#1945 — env
#     vars alone are the WRONG key inside a worktree subagent). Fallback:
#     HYDRA_AUTOPILOT_TASK_ID then CLAUDE_CODE_SESSION_ID, only when cwd is not
#     an agent-<HASH> worktree.
#   - The anchor deposit is written UNCONDITIONALLY (even when zero reflections
#     were served) so a first-failure anchor is recoverable (#2112).
#   - Graceful no-op: this script MUST NOT run under `set -e` and MUST NEVER
#     abort its caller on an I/O error, a missing footer, or an unreachable
#     reflection API — best-effort with a FAIL-LOUD stderr WARN, exactly as the
#     inline fragment behaved.
#
# USAGE (invoked by the fragments; args, not caller shell vars, since a script
# is a separate process):
#   reflection-deposit.sh reflect  <skill_name> <anchor_ref> <refl_json>
#   reflection-deposit.sh grounding <skill_name>
#
#   reflect   — deposits refl-sources (mapped from <refl_json>.blocks) + the
#               unconditional anchor deposit. <refl_json> is the raw body from
#               GET /api/reflections (may be empty on an unreachable API).
#   grounding — runs `npm test`, parses the node:test footer, deposits the
#               post-implementation test counts.
#
# Deliberately NOT `set -euo pipefail`: this is best-effort telemetry that must
# never take down the build. Every branch handles its own failure loud-on-stderr.

TAG="${1:-reflection-deposit}"  # placeholder; real skill tag resolved below

# --- shared task_id derivation (identical to the retired inline logic) --------
derive_task_id() {
  # Echoes the harness task_id, or empty if none is derivable.
  local tid=""
  case "$(basename "$PWD")" in
    agent-*)
      local cand="${PWD##*/agent-}"
      case "$cand" in
        *[!0-9a-f]*) ;;                    # not pure hex → not the harness hash
        ?????????????*) tid="$cand" ;;     # 12+ hex chars → harness task id
      esac
      ;;
  esac
  # Fallbacks only if cwd was not an agent-<HASH> worktree (non-standard layout).
  printf '%s' "${tid:-${HYDRA_AUTOPILOT_TASK_ID:-${CLAUDE_CODE_SESSION_ID:-}}}"
}

deposit_dir() {
  printf '%s' "${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}"
}

# --- mode: reflect ------------------------------------------------------------
# reflect <skill_name> <anchor_ref> <refl_json>
do_reflect() {
  local skill="$1" anchor_ref="$2" refl_json="$3"
  local task_id dir
  task_id="$(derive_task_id)"
  dir="$(deposit_dir)"

  # Map each served block (count>0) to its bare bucket token, comma-join. The
  # API emits per-anchor-reflections / by-file-reflections but
  # deriveReflectionMatchSource matches the BARE tokens per-anchor / by-file
  # (#1945 — raw API strings mis-bucket to mixed/none).
  local refl_sources=""
  if [ -n "$refl_json" ]; then
    refl_sources=$(printf '%s' "$refl_json" | jq -r '
      [ (.blocks // [])[]
        | select((.count // 0) > 0)
        | (.source // "")
        | if test("per-anchor") then "per-anchor"
          elif test("by-file") then "by-file"
          elif test("global") then "global"
          else empty end ]
      | unique | join(",")' 2>/dev/null || printf '')
  fi

  # Reflection-source deposit — only when reflections were actually served.
  # Empty refl_sources → no deposit → reap omits the field → the cycle
  # truthfully buckets to 'none' (distinguishes served-nothing from the #1945
  # served-but-wrong-key false 'none').
  if [ -n "$refl_sources" ]; then
    if [ -z "$task_id" ]; then
      printf '[%s] WARN refl-deposit-no-task-id: served %s but no harness task_id derivable from cwd=%s — reflectionMatchSource will read none\n' \
        "$skill" "$refl_sources" "$PWD" >&2
    else
      local path="${dir}/hydra-refl-sources-${task_id}"
      if printf '%s' "$refl_sources" > "$path" 2>/dev/null; then
        printf '[%s] refl-deposit ok: %s -> %s\n' "$skill" "$refl_sources" "$path" >&2
      else
        printf '[%s] WARN refl-deposit-write-failed: could not write %s (cue: refl-deposit-write-failed)\n' \
          "$skill" "$path" >&2
      fi
    fi
  fi

  # Anchor deposit — UNCONDITIONAL (#2112): even a served-nothing cycle deposits
  # its anchor so reap can fire the FIRST reflection PRODUCER for this anchor.
  if [ -n "$task_id" ] && [ -n "$anchor_ref" ]; then
    local apath="${dir}/hydra-refl-anchor-${task_id}"
    if printf '%s' "$anchor_ref" > "$apath" 2>/dev/null; then
      printf '[%s] refl-anchor-deposit ok: %s -> %s\n' "$skill" "$anchor_ref" "$apath" >&2
    else
      printf '[%s] WARN refl-anchor-deposit-write-failed: could not write %s (cue: refl-anchor-deposit-write-failed)\n' \
        "$skill" "$apath" >&2
    fi
  elif [ -z "$task_id" ]; then
    printf '[%s] WARN refl-anchor-deposit-no-task-id: no harness task_id derivable from cwd=%s — reflection producer cannot key on this anchor\n' \
      "$skill" "$PWD" >&2
  fi
}

# --- mode: grounding ----------------------------------------------------------
# grounding <skill_name>
# Runs `npm test`, parses the node:test footer, deposits testsAfter /
# testsPassingAfter (#2754). Best-effort: a missing footer / underivable task_id
# / I/O error yields no deposit → reap omits the fields → truthful "unknown".
do_grounding() {
  local skill="$1"
  local task_id dir
  task_id="$(derive_task_id)"
  dir="$(deposit_dir)"

  local footer total pass
  footer="$(npm test 2>&1 | grep -E '^# (tests|pass) ' || true)"
  total="$(printf '%s\n' "$footer" | sed -n 's/^# tests \([0-9][0-9]*\).*/\1/p' | head -1)"
  pass="$(printf '%s\n' "$footer" | sed -n 's/^# pass \([0-9][0-9]*\).*/\1/p' | head -1)"

  if [ -n "$task_id" ] && { [ -n "$total" ] || [ -n "$pass" ]; }; then
    local json
    json="$(python3 -c '
import json, sys
total, passing = sys.argv[1], sys.argv[2]
body = {}
if total:
    body["testsAfter"] = int(total)
if passing:
    body["testsPassingAfter"] = int(passing)
print(json.dumps(body))
' "$total" "$pass" 2>/dev/null || printf '')"
    if [ -n "$json" ]; then
      local path="${dir}/hydra-grounding-tests-${task_id}"
      if printf '%s' "$json" > "$path" 2>/dev/null; then
        printf '[%s] grounding-tests-deposit ok: %s -> %s\n' "$skill" "$json" "$path" >&2
      else
        printf '[%s] WARN grounding-tests-deposit-write-failed: could not write %s (cue: grounding-tests-deposit-write-failed)\n' \
          "$skill" "$path" >&2
      fi
    fi
  elif [ -z "$task_id" ]; then
    printf '[%s] WARN grounding-tests-deposit-no-task-id: no harness task_id derivable from cwd=%s — testsAfter will stay 0\n' \
      "$skill" "$PWD" >&2
  fi
}

# --- dispatch -----------------------------------------------------------------
mode="${1:-}"
case "$mode" in
  reflect)
    # reflect <skill_name> <anchor_ref> <refl_json>
    do_reflect "${2:-reflection-deposit}" "${3:-}" "${4:-}"
    ;;
  grounding)
    # grounding <skill_name>
    do_grounding "${2:-reflection-deposit}"
    ;;
  *)
    printf '[reflection-deposit] WARN unknown-mode: %s (expected reflect|grounding) — no-op\n' "$mode" >&2
    ;;
esac

# ALWAYS exit 0 — best-effort telemetry must never fail the caller.
exit 0
