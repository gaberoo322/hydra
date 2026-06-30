```bash
# Map each served block (count>0) to its bucket token, comma-join.
REFL_SOURCES=$(printf '%s' "$REFL_JSON" | jq -r '
  [ (.blocks // [])[]
    | select((.count // 0) > 0)
    | (.source // "")
    | if test("per-anchor") then "per-anchor"
      elif test("by-file") then "by-file"
      elif test("global") then "global"
      else empty end ]
  | unique | join(",")')
# Derive the harness task_id reap keys on. PRIMARY source: the `agent-<HASH>`
# worktree dir basename (the harness embeds its task id there); the same HASH
# is the branch suffix `worktree-agent-<HASH>` and the slot `task_id` reap reads.
# Match a 12+ hex-char suffix so we don't pick up the synthesized
# `worktree-agent-<run>-t<turn>-<slot>` dispatchId (which is NOT the read key).
REFL_TASK_ID=""
case "$(basename "$PWD")" in
  agent-*)
    CAND="${PWD##*/agent-}"
    case "$CAND" in
      *[!0-9a-f]*) ;;                       # not pure hex → not the harness hash
      ?????????????*) REFL_TASK_ID="$CAND" ;; # 12+ hex chars → harness task id
    esac
    ;;
esac
# Fallbacks only if cwd was not an agent-<HASH> worktree (non-standard layout).
REFL_TASK_ID="${REFL_TASK_ID:-${HYDRA_AUTOPILOT_TASK_ID:-$CLAUDE_CODE_SESSION_ID}}"

if [ -n "$REFL_SOURCES" ]; then
  if [ -z "$REFL_TASK_ID" ]; then
    # FAIL LOUD (repo "fail loud" convention): reflections WERE served but we
    # cannot determine the key reap reads, so the telemetry would silently
    # vanish. Surface it on stderr AND in the Friction Report
    # (cue: refl-deposit-no-task-id) so the silent-'none' regression is visible.
    printf '[{{SKILL_NAME}}] WARN refl-deposit-no-task-id: served %s but no harness task_id derivable from cwd=%s — reflectionMatchSource will read none\n' \
      "$REFL_SOURCES" "$PWD" >&2
  else
    REFL_DEPOSIT_PATH="${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-sources-${REFL_TASK_ID}"
    if printf '%s' "$REFL_SOURCES" > "$REFL_DEPOSIT_PATH" 2>/dev/null; then
      printf '[{{SKILL_NAME}}] refl-deposit ok: %s -> %s\n' "$REFL_SOURCES" "$REFL_DEPOSIT_PATH" >&2
    else
      # FAIL LOUD on I/O error — best-effort for the build (never blocks work)
      # but the failure must be visible, not swallowed by `|| true`.
      printf '[{{SKILL_NAME}}] WARN refl-deposit-write-failed: could not write %s (cue: refl-deposit-write-failed)\n' \
        "$REFL_DEPOSIT_PATH" >&2
    fi
  fi
fi
# Empty REFL_SOURCES (served nothing) → no deposit → reap omits the field →
# the cycle truthfully buckets to 'none'. This distinguishes "served nothing"
# from the #1945 "served but deposited under the wrong key" false 'none'.

# Issue #2112: ALSO deposit the per-cycle ANCHOR reference so reap can fire the
# per-anchor reflection PRODUCER on a non-merged failure. The dispatch harness
# never stamps `slot["anchor"]` (the live slot carries only
# task_id/skill/started_epoch/branch) and dev_orch passes no prompt_args anchor
# (#458), so reap's `slot.get("anchor")` was always None and
# recordAnchorReflection was NEVER called — the per-anchor reflection store
# stayed empty and `reflectionMatchSource` was permanently 'none'. The subagent
# is the only actor that reliably knows the anchor (it is `issue-<N>` for the
# issue being worked), so deposit it to a task-scoped file keyed on the SAME
# REFL_TASK_ID as the reflection-source deposit above. reap reads it via
# `_read_anchor_deposit`. ALWAYS deposit (unconditional on REFL_SOURCES — a
# failed dispatch that served NO reflections still needs its anchor recoverable
# so reap can write the FIRST reflection for this anchor). $ANCHOR_REF is the
# same anchor.reference (e.g. "issue-841") established at the step-4 reflection
# fetch above — reuse it, never hardcode a literal issue ref.
if [ -n "$REFL_TASK_ID" ] && [ -n "$ANCHOR_REF" ]; then
  REFL_ANCHOR_PATH="${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-anchor-${REFL_TASK_ID}"
  if printf '%s' "$ANCHOR_REF" > "$REFL_ANCHOR_PATH" 2>/dev/null; then
    printf '[{{SKILL_NAME}}] refl-anchor-deposit ok: %s -> %s\n' "$ANCHOR_REF" "$REFL_ANCHOR_PATH" >&2
  else
    # FAIL LOUD on I/O error (cue: refl-anchor-deposit-write-failed) — best-effort
    # for the build but never silently swallowed.
    printf '[{{SKILL_NAME}}] WARN refl-anchor-deposit-write-failed: could not write %s (cue: refl-anchor-deposit-write-failed)\n' \
      "$REFL_ANCHOR_PATH" >&2
  fi
elif [ -z "$REFL_TASK_ID" ]; then
  printf '[{{SKILL_NAME}}] WARN refl-anchor-deposit-no-task-id: no harness task_id derivable from cwd=%s — reflection producer cannot key on this anchor\n' \
    "$PWD" >&2
fi
```
