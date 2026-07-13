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
#     the grounding test-count deposit at
#       ${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-grounding-tests-<task_id>
#     and the cascade-routing escalation-provenance deposit at
#       ${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-escalation-<task_id>   (issue #3284)
#   - <task_id> is the HARNESS task id. For the reflect/grounding modes the
#     PRIMARY source is the `agent-<HASH>` worktree-dir basename (12+ hex chars),
#     which is the branch suffix `worktree-agent-<HASH>` and the slot `task_id`
#     reap reads (#1945 — env vars alone are the WRONG key inside a worktree
#     subagent). Fallback: HYDRA_AUTOPILOT_TASK_ID then CLAUDE_CODE_SESSION_ID,
#     only when cwd is not an agent-<HASH> worktree.
#   - The `escalation` mode is DIFFERENT (issue #3284): it is invoked by the
#     autopilot HARNESS at escalation-dispatch time, NOT by a worktree subagent,
#     so the harness is not inside the escalated worktree and cwd carries no
#     agent-<HASH> hash. The escalated dispatch's task_id is therefore passed as
#     an EXPLICIT argument (the harness knows it — it is the slot task_id it just
#     allocated / the branch suffix it synthesised) rather than derived from cwd.
#   - The anchor deposit is written UNCONDITIONALLY (even when zero reflections
#     were served) so a first-failure anchor is recoverable (#2112).
#   - The escalation deposit carries ONLY the cascade-routing provenance JSON
#     ({"escalationAttempt":N,"escalatedModel":"sonnet","priorAttemptStatus":"no_op"})
#     that reap.py's `_read_escalation_deposit` reads back verbatim and forwards
#     on the single cycle-record write, so the durable per-dispatch outcome
#     record (#2942) tags the escalated attempt and /metrics/cascade-routing can
#     measure cost-delta + postEscalationMergeRate off ACTUAL tokens (#3284).
#   - Graceful no-op: this script MUST NOT run under `set -e` and MUST NEVER
#     abort its caller on an I/O error, a missing footer, or an unreachable
#     reflection API — best-effort with a FAIL-LOUD stderr WARN, exactly as the
#     inline fragment behaved.
#
# USAGE (invoked by the fragments; args, not caller shell vars, since a script
# is a separate process):
#   reflection-deposit.sh reflect    <skill_name> <anchor_ref> <refl_json>
#   reflection-deposit.sh grounding  <skill_name>
#   reflection-deposit.sh escalation <skill_name> <task_id> <escalated_model> <attempt> [prior_attempt_status]
#
#   reflect    — deposits refl-sources (mapped from <refl_json>.blocks) + the
#                unconditional anchor deposit. <refl_json> is the raw body from
#                GET /api/reflections (may be empty on an unreachable API).
#   grounding  — runs `npm test`, parses the node:test footer, deposits the
#                post-implementation test counts.
#   escalation — deposits the cascade-routing escalation provenance for the
#                EXPLICITLY-passed <task_id> (issue #3284). Invoked by the
#                autopilot harness the moment a `dispatch` action carrying
#                `prompt_args.escalate_model` is executed — writes
#                {"escalationAttempt":<attempt>,"escalatedModel":<model>,
#                 "priorAttemptStatus":<status>} so reap.py reads it back.
#                Non-escalated dispatches never invoke this mode → no deposit →
#                reap omits the fields (truthful null, the vast majority).
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

# --- mode: escalation ---------------------------------------------------------
# escalation <skill_name> <task_id> <escalated_model> <attempt> [prior_attempt_status]
# Deposits the cascade-routing escalation provenance (issue #3284) for the
# EXPLICITLY-passed task_id. Invoked by the autopilot HARNESS at
# escalation-dispatch time (not a worktree subagent), so task_id is an argument,
# NOT derived from cwd. Best-effort: a missing task_id / non-positive attempt /
# empty model / underivable JSON yields no deposit → reap omits the fields
# (truthful null). Writes ONLY when the provenance is well-formed so a malformed
# invocation can never fabricate a bogus escalation marker.
do_escalation() {
  local skill="$1" task_id="$2" model="$3" attempt="$4" prior_status="$5"
  local dir
  dir="$(deposit_dir)"

  if [ -z "$task_id" ]; then
    printf '[%s] WARN escalation-deposit-no-task-id: harness passed no task_id — escalationAttempt will stay null (cue: escalation-deposit-no-task-id)\n' \
      "$skill" >&2
    return
  fi

  # Build the provenance JSON with python3 (validates attempt is a positive int
  # and model is non-empty; the reader — dispatch.sh — enforces the SAME shape,
  # so keep them consistent). A malformed/insufficient invocation yields "" and
  # deposits nothing (no fabricated marker).
  local json
  json="$(python3 -c '
import json, sys
model = sys.argv[1].strip()
attempt_raw = sys.argv[2].strip()
prior = sys.argv[3].strip()
body = {}
# escalationAttempt: a POSITIVE integer (>= 2 in practice — the cheap tier ran
# attempt 1). Anything non-positive/unparseable → omit (truthful null).
try:
    n = int(attempt_raw)
    if n > 0:
        body["escalationAttempt"] = n
except (TypeError, ValueError):
    pass
if model:
    body["escalatedModel"] = model
if prior:
    body["priorAttemptStatus"] = prior
# Only a deposit that carries the load-bearing escalationAttempt is worth
# writing — reap keys the whole cascade fold on its NON-null presence.
if "escalationAttempt" not in body:
    sys.exit(0)
print(json.dumps(body))
' "$model" "$attempt" "$prior_status" 2>/dev/null || printf '')"

  if [ -n "$json" ]; then
    local path="${dir}/hydra-escalation-${task_id}"
    if printf '%s' "$json" > "$path" 2>/dev/null; then
      printf '[%s] escalation-deposit ok: %s -> %s\n' "$skill" "$json" "$path" >&2
    else
      printf '[%s] WARN escalation-deposit-write-failed: could not write %s (cue: escalation-deposit-write-failed)\n' \
        "$skill" "$path" >&2
    fi
  else
    printf '[%s] WARN escalation-deposit-malformed: model=%s attempt=%s — no positive escalationAttempt, nothing deposited (cue: escalation-deposit-malformed)\n' \
      "$skill" "$model" "$attempt" >&2
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
  escalation)
    # escalation <skill_name> <task_id> <escalated_model> <attempt> [prior_attempt_status]
    do_escalation "${2:-reflection-deposit}" "${3:-}" "${4:-}" "${5:-}" "${6:-}"
    ;;
  *)
    printf '[reflection-deposit] WARN unknown-mode: %s (expected reflect|grounding|escalation) — no-op\n' "$mode" >&2
    ;;
esac

# ALWAYS exit 0 — best-effort telemetry must never fail the caller.
exit 0
