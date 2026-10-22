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
#   2. The payload has no `agent_id`. Claude Code sets `agent_id` only when a
#      hook fires inside a subagent, and the dispatched children inherit the
#      env var too. Children legitimately call Agent with free-form prompts
#      (hydra-qa reviewer fan-out, hydra-target-build delegated mode), so only
#      the parent's main thread is in scope. The parent's main thread calls
#      Agent only for class dispatches.
#      Evidence that the field is real and child-only (#5145 QA round 1):
#        - The CLI's own hook-input schema (claude-code 2.1.306) documents
#          `agent_id` as "Present only when the hook fires from within a
#          subagent ... Absent for the main thread, even in --agent sessions.
#          Use this field (not agent_type) to distinguish subagent calls from
#          main-thread calls." `agent_type` is ALSO set on the main thread of
#          an --agent session, so it is deliberately not a second signal here;
#          nor is `transcript_path`, which inside a child is the PARENT's.
#        - scripts/autopilot/hooks/on-subagent-tool-call.sh (#4965) exits when
#          `agent_id` is absent and keys the dispatch registry on it; the live
#          registry holds `hydra:dispatches:subagent:<agent_id>` rows written by
#          that hook (e.g. af4747e1d5a62cae0, a qa_orch child, whose
#          parentSessionId is the autopilot parent's session_id). The test
#          replays that real payload shape.
# The dispatch sentinel is NOT the scope signal: the failure mode is a prompt
# that dropped the renderer output, sentinel included.
#
# Deny (exit 2) when an in-scope prompt:
#   (a) after trimming IS or STARTS WITH a bare placeholder token
#       (`PLACEHOLDER`, any case, optionally bracketed) or an unexpanded `$(`;
#   (b) has no line that is exactly `## Task` (render_prompt() always emits
#       one) — covers "read your prompt from <file>" hand-offs; or
#   (c) has a `## Task` section (up to the next `## ` heading) that is empty
#       or whose body itself starts with a placeholder / `$(` token.
# A prompt that passes all three is rendered output, and its CONTENT is never
# scanned: issue bodies and dispatcher notes routinely quote `$(...)` shell
# snippets or the word "placeholder", and the renderer embeds them verbatim
# after the skeleton's first sentence. The test renders every class in
# scripts/autopilot/classes.json (plus the prompt_args variants) to keep the
# rendered shape inside (a)-(c).
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
# an env var, never interpolated into the script text. Output: one line,
# `ALLOW`, `DENY <reason-code>` or `ERROR <parse problem>`. Python's stderr is
# NOT captured (it goes to the hook's own stderr), and only the LAST
# ALLOW/DENY/ERROR line of stdout is read, so interpreter noise can never turn
# a verdict into the fail-open "unexpected verdict" arm.
export AGENT_PROMPT_GUARD_INPUT="$INPUT"
OUT=$(python3 - <<'PY'
import json
import os
import re

raw = os.environ.get("AGENT_PROMPT_GUARD_INPUT", "")
try:
    payload = json.loads(raw)
except Exception as exc:
    print(f"ERROR stdin is not valid JSON ({type(exc).__name__})")
    raise SystemExit(0)
if not isinstance(payload, dict):
    print("ERROR stdin JSON is not an object")
    raise SystemExit(0)

if payload.get("tool_name") != "Agent":
    print("ALLOW")
    raise SystemExit(0)

# Scope arm 2: a subagent's own Agent call is out of scope.
if payload.get("agent_id"):
    print("ALLOW")
    raise SystemExit(0)

tool_input = payload.get("tool_input")
prompt = tool_input.get("prompt") if isinstance(tool_input, dict) else None
if not isinstance(prompt, str):
    print("ERROR tool_input.prompt is missing or not a string")
    raise SystemExit(0)

# A bare placeholder (`PLACEHOLDER`, `<placeholder>`, `(placeholder)` ...) or
# an unexpanded shell substitution, anchored at the START of the text.
LEADING_TOKEN = re.compile(r"(?:[\[<{(]\s*)?placeholder\b|\$\(", re.I)


def leading_token(text: str) -> str | None:
    m = LEADING_TOKEN.match(text.strip())
    if not m:
        return None
    return "shell-substitution" if m.group(0).startswith("$(") else "placeholder"


verdict = leading_token(prompt)
if verdict is None:
    heading = re.search(r"^## Task\r?$", prompt, re.M)
    if heading is None:
        verdict = "no-task-heading"
    else:
        body = prompt[heading.end():]
        nxt = re.search(r"^## ", body, re.M)
        if nxt is not None:
            body = body[: nxt.start()]
        if not body.strip():
            verdict = "empty-task"
        else:
            verdict = leading_token(body)
print("ALLOW" if verdict is None else f"DENY {verdict}")
PY
)
PY_RC=$?

if [ "$PY_RC" -ne 0 ]; then
  warn "python3 exited $PY_RC"
  exit 0
fi

LINE=""
while IFS= read -r l; do
  case "$l" in ALLOW|ALLOW\ *|DENY|DENY\ *|ERROR|ERROR\ *) LINE=$l ;; esac
done <<<"$OUT"
VERDICT_LINE=${LINE%% *}
DETAIL=""
if [[ "$LINE" == *" "* ]]; then
  DETAIL=${LINE#* }
fi

case "$VERDICT_LINE" in
  ALLOW) exit 0 ;;
  DENY) ;;
  ERROR) warn "cannot inspect the Agent call: $DETAIL"; exit 0 ;;
  *) warn "unexpected verdict from python3: ${OUT:0:300}"; exit 0 ;;
esac

case "$DETAIL" in
  placeholder) WHY="it is (or its '## Task' section starts with) a bare PLACEHOLDER token" ;;
  shell-substitution) WHY="it is (or its '## Task' section starts with) an unexpanded \$( shell substitution — the Agent tool does not run a shell, so the text is sent literally" ;;
  no-task-heading) WHY="it has no '## Task' heading line, so it is not render-dispatch.py output" ;;
  empty-task) WHY="its '## Task' section is empty, so the class skeleton render-dispatch.py emits is missing" ;;
  *) WHY="it does not look like render-dispatch.py output ($DETAIL)" ;;
esac

REASON="agent-dispatch-prompt-guard: refusing this autopilot class dispatch — ${WHY} (issue #5143). Re-run 'python3 scripts/autopilot/render-dispatch.py <slot> [--notes-file <md>]' and pass its 'prompt' field to the Agent tool VERBATIM, as literal text. Never hand-write the prompt, shorten it, point the child at a file, or pass a shell expression. Put session-only context in the --notes-file."

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
