```bash
# Issue #2754: deposit the grounding test-suite counts so reap.py can stamp
# `testsAfter` on the cycle-record write. Before this deposit, reap had no test
# count to forward, so `testsAfter` recorded 0 on EVERY cycle — the coverage-
# trend observability regression the 2026-07-02 architecture review flagged.
#
# Run this AFTER `npm test` passes in the worktree. The count is the `# tests N`
# / `# pass N` footer node:test emits — captured here from a fresh `npm test`
# footer (the worktree's post-implementation test count) written to the SAME
# task-scoped deposit dir + harness-task-id key as the reflection deposit.
#
# `testsAfter` = total tests declared, `testsPassingAfter` = passing subset. We
# only reliably know the AFTER state (the suite as it stands post-implementation)
# — the BEFORE snapshot would require a pre-change run the child does not do, so
# we deposit only the AFTER pair and reap forwards them; recordCycle omits the
# absent BEFORE fields (truthful "unknown"). This still fixes the always-0
# `testsAfter` symptom the issue names.
#
# Best-effort and fully non-fatal: a missing footer, an underivable task_id, or
# any I/O error yields no deposit → reap omits the four tests fields → truthful
# "unknown". NEVER blocks the build.

# Re-derive the harness task_id reap keys on — identical logic to the reflection
# deposit (the `agent-<HASH>` worktree-dir basename is authoritative).
GT_TASK_ID=""
case "$(basename "$PWD")" in
  agent-*)
    CAND="${PWD##*/agent-}"
    case "$CAND" in
      *[!0-9a-f]*) ;;
      ?????????????*) GT_TASK_ID="$CAND" ;;
    esac
    ;;
esac
GT_TASK_ID="${GT_TASK_ID:-${HYDRA_AUTOPILOT_TASK_ID:-$CLAUDE_CODE_SESSION_ID}}"

# Capture the node:test footer from a fresh (already-green) run. `npm test`
# prints `# tests N` (total) and `# pass N` (passing). Parse both; a footer that
# doesn't match leaves the value empty and that field is omitted.
GT_FOOTER="$(npm test 2>&1 | grep -E '^# (tests|pass) ' || true)"
GT_TOTAL="$(printf '%s\n' "$GT_FOOTER" | sed -n 's/^# tests \([0-9][0-9]*\).*/\1/p' | head -1)"
GT_PASS="$(printf '%s\n' "$GT_FOOTER" | sed -n 's/^# pass \([0-9][0-9]*\).*/\1/p' | head -1)"

if [ -n "$GT_TASK_ID" ] && { [ -n "$GT_TOTAL" ] || [ -n "$GT_PASS" ]; }; then
  GT_JSON="$(python3 -c '
import json, sys
total, passing = sys.argv[1], sys.argv[2]
body = {}
if total:
    body["testsAfter"] = int(total)
if passing:
    body["testsPassingAfter"] = int(passing)
print(json.dumps(body))
' "$GT_TOTAL" "$GT_PASS")"
  GT_DEPOSIT_PATH="${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-grounding-tests-${GT_TASK_ID}"
  if printf '%s' "$GT_JSON" > "$GT_DEPOSIT_PATH" 2>/dev/null; then
    printf '[{{SKILL_NAME}}] grounding-tests-deposit ok: %s -> %s\n' "$GT_JSON" "$GT_DEPOSIT_PATH" >&2
  else
    # FAIL LOUD on I/O error (cue: grounding-tests-deposit-write-failed) —
    # best-effort for the build but never silently swallowed.
    printf '[{{SKILL_NAME}}] WARN grounding-tests-deposit-write-failed: could not write %s (cue: grounding-tests-deposit-write-failed)\n' \
      "$GT_DEPOSIT_PATH" >&2
  fi
elif [ -z "$GT_TASK_ID" ]; then
  printf '[{{SKILL_NAME}}] WARN grounding-tests-deposit-no-task-id: no harness task_id derivable from cwd=%s — testsAfter will stay 0\n' \
    "$PWD" >&2
fi
```
