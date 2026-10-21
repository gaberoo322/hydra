#!/usr/bin/env bash
# agent-dispatch-prompt-guard.sh — PreToolUse hook (matcher `Agent`) that
# denies an unattended autopilot CLASS DISPATCH whose prompt is not the output
# of scripts/autopilot/render-dispatch.py.
#
# Background — issue #5143 (Refs #4839). The playbook's dispatch row tells the
# parent to run `render-dispatch.py <slot>` and pass its `prompt` field to the
# Agent tool verbatim. Over 434 Sonnet-parent trial runs, 25 class dispatches
# went out with a literal placeholder instead: `PLACEHOLDER`, `$(placeholder)`,
# `$(see below)`, or an unexpanded `$(cat /tmp/….json | jq -r .prompt)`. Two
# were never corrected. That is the pre-registered contract stop trigger ("a
# dispatch whose Agent prompt was hand-written (no `## Task` from the
# renderer)").
#
# Scope — BOTH must hold, otherwise exit 0 silently:
#   1. HYDRA_AUTOPILOT_TRIGGER is non-empty. scripts/autopilot/pace-gate.sh
#      exports it right before `exec claude … -p /hydra-autopilot`, so the
#      unattended parent and every hook process it spawns inherit it;
#      interactive operator sessions leave it unset. Same "unattended" test
#      scripts/autopilot/bootstrap.sh uses.
#   2. The payload has no `agent_id`. Claude Code adds `agent_id` only when a
#      hook fires inside a subagent (#4965), and the dispatched children
#      inherit the env var too. Children legitimately call Agent with
#      free-form prompts (hydra-qa reviewer fan-out, hydra-target-build
#      delegated mode), so only the parent's main thread is in scope. The
#      parent's main thread calls Agent only for class dispatches.
# The dispatch sentinel is NOT the scope signal: the failure mode is a prompt
# that dropped the renderer output, sentinel included.
#
# Deny (exit 2) when an in-scope prompt either:
#   (a) has no line that is exactly the `## Task` heading (render_prompt()
#       always emits one), or
#   (b) contains `PLACEHOLDER` (case-insensitive) or an unexpanded `$(`.
# No rendered class prompt contains either token; the test renders every
# class in scripts/autopilot/classes.json to keep it that way.
#
# Fail-open: malformed stdin JSON, a missing or non-string prompt, or a
# python3 failure exits 0 with a warning on stderr. A broken guard must never
# wedge the autopilot.
#
# Deny payload (same contract as gh-label-delete-guard.sh): the plain-text
# reason, then JSON with hookSpecificOutput.permissionDecision="deny", both on
# stderr, exit 2. Exit codes are limited to 0 and 2.
#
# Cost: out-of-scope sessions exit before python3 starts. In scope, one
# python3 run of string/regex work — no network, git or Redis.

set -uo pipefail

warn() {
  printf 'agent-dispatch-prompt-guard: WARN %s — failing open (exit 0)\n' "$*" >&2
}

INPUT=$(cat) || { warn "could not read stdin"; exit 0; }

# Scope arm 1: unattended pace-gate session only.
if [ -z "${HYDRA_AUTOPILOT_TRIGGER:-}" ]; then
  exit 0
fi

# The verdict is computed in python3 (JSON + regex). The payload travels via
# an env var, never interpolated into the script text. Output: first line is
# ALLOW, DENY or ERROR; for DENY the second line is the reason code, for
# ERROR it is the parse problem.
export AGENT_PROMPT_GUARD_INPUT="$INPUT"
VERDICT=$(python3 - <<'PY' 2>&1
import json
import os
import re

raw = os.environ.get("AGENT_PROMPT_GUARD_INPUT", "")
try:
    payload = json.loads(raw)
except Exception as exc:
    print("ERROR")
    print(f"stdin is not valid JSON ({type(exc).__name__})")
    raise SystemExit(0)
if not isinstance(payload, dict):
    print("ERROR")
    print("stdin JSON is not an object")
    raise SystemExit(0)

if payload.get("tool_name") not in ("Agent", "Task"):
    print("ALLOW")
    raise SystemExit(0)

# Scope arm 2: a subagent's own Agent call is out of scope.
if payload.get("agent_id"):
    print("ALLOW")
    raise SystemExit(0)

tool_input = payload.get("tool_input")
prompt = tool_input.get("prompt") if isinstance(tool_input, dict) else None
if not isinstance(prompt, str):
    print("ERROR")
    print("tool_input.prompt is missing or not a string")
    raise SystemExit(0)

if re.search(r"placeholder", prompt, re.I):
    print("DENY")
    print("placeholder")
elif "$(" in prompt:
    print("DENY")
    print("shell-substitution")
elif not re.search(r"^##[ \t]+Task[ \t]*$", prompt, re.M):
    print("DENY")
    print("no-task-heading")
else:
    print("ALLOW")
PY
)
PY_RC=$?

if [ "$PY_RC" -ne 0 ]; then
  warn "python3 exited $PY_RC: ${VERDICT:0:300}"
  exit 0
fi

VERDICT_LINE=${VERDICT%%$'\n'*}
DETAIL=""
if [[ "$VERDICT" == *$'\n'* ]]; then
  DETAIL=${VERDICT#*$'\n'}
  DETAIL=${DETAIL%%$'\n'*}
fi

case "$VERDICT_LINE" in
  ALLOW) exit 0 ;;
  DENY) ;;
  ERROR) warn "cannot inspect the Agent call: $DETAIL"; exit 0 ;;
  *) warn "unexpected verdict from python3: ${VERDICT:0:300}"; exit 0 ;;
esac

case "$DETAIL" in
  placeholder) WHY="it contains a PLACEHOLDER token" ;;
  shell-substitution) WHY="it contains an unexpanded \$( shell substitution — the Agent tool does not run a shell, so the text is sent literally" ;;
  no-task-heading) WHY="it has no '## Task' heading, so it is not render-dispatch.py output" ;;
  *) WHY="it does not look like render-dispatch.py output ($DETAIL)" ;;
esac

REASON="agent-dispatch-prompt-guard: refusing this autopilot class dispatch — ${WHY} (issue #5143). Re-run 'python3 scripts/autopilot/render-dispatch.py <slot> [--notes-file <md>]' and pass its 'prompt' field to the Agent tool VERBATIM, as literal text. Never hand-write the prompt, shorten it, point the child at a file, or pass a shell expression. Put session-only context in the --notes-file. If your notes themselves contain 'placeholder' or '\$(', reword them."

printf '%s\n' "$REASON" >&2
python3 -c "import json,sys
print(json.dumps({
  'hookSpecificOutput': {
    'hookEventName': 'PreToolUse',
    'permissionDecision': 'deny',
    'permissionDecisionReason': sys.argv[1]
  }
}))" "$REASON" >&2 || true
exit 2
