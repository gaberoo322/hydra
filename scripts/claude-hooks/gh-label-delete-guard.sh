#!/usr/bin/env bash
# gh-label-delete-guard.sh — PreToolUse hook that blocks a Bash `gh api` /
# `curl` DELETE against the GitHub issue *labels collection* endpoint
# (`.../issues/<n>/labels`), which silently removes EVERY label on the issue.
# The single-label form puts the name in the URL PATH
# (`.../issues/<n>/labels/<name>`) and is always allowed.
#
# Background — issue #4654 (3 hits across 2 classes, 2026-09-04 / 2026-09-23).
# Agents removing one label keep reaching for
#   gh api repos/gaberoo322/hydra/issues/<n>/labels -X DELETE -f name=<label>
# That hits the COLLECTION endpoint — any method against
# `issues/<n>/labels` with no trailing `/<name>` segment removes ALL labels —
# instead of the path form. The wipe is silent (exit 0) and can drop routing
# labels (`glm-ab-control`, `design-concept-exempt`, `money-critical`)
# unnoticed. The sanctioned path is `gh issue edit --remove-label`
# (docs/operator-playbooks/_fragments/hydra-dev-parent-flow.md), but agents
# are also steered toward raw REST under GraphQL-quota pressure and guess the
# wrong endpoint shape.
#
# This hook fires on every Bash tool call. It DENIES a call when a single
# shell segment (the command text split on `&&`, `||`, `;`, `|`, newline)
# carries BOTH:
#   1. a DELETE HTTP method — `-X DELETE`, `-XDELETE`, `--method DELETE`,
#      `--method=DELETE` (case-insensitive), and
#   2. a reference to `issues/<n>/labels` with NO trailing `/<name>` segment
#      (bare `/labels`, or `/labels/` followed by whitespace/quote/`?`/`#`/EOL).
#
# Both `gh api` and raw `curl` forms are covered because the rule matches
# command TEXT, not the binary. The single-label PATH form
# (`issues/<n>/labels/<name>`, any spelling incl. `$VAR`/`${VAR}`) is ALWAYS
# allowed — docs/operator-playbooks/hydra-target-sweep.md L126 relies on it —
# as is `gh issue edit --remove-label`, GET/POST/PUT on the collection, and a
# repo-level `repos/o/r/labels/<name>` delete.
#
# Fail-open (issue #4654 design-concept INV-3): missing/malformed stdin JSON,
# a non-Bash tool_name, or an empty tool_input.command exits 0 silently —
# this hook must never wedge an unrelated Bash call.
#
# Deny payload format (per claude-code hook contract, matching
# worktree-write-fence.sh):
#   stderr: JSON with hookSpecificOutput.permissionDecision="deny"
#   exit:   2
#
# Performance budget: <10ms per call — pure string/regex work via one python3
# shell-out, no network/git/Redis IO, no dependency on cwd. PreToolUse hooks
# run synchronously and a slow hook stalls every Bash call.
#
# See issue #4654, docs/operator-playbooks/_fragments/hydra-dev-parent-flow.md
# (the sanctioned `gh issue edit --remove-label` path), and operator memory
# reference_gh_label_delete_endpoint_wipes_all_labels.

set -euo pipefail

# Read full stdin payload.
INPUT=$(cat)

# Extract tool_name. Fall back to empty on parse error so we fail open
# (allow the call) rather than blocking on a malformed payload.
TOOL=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_name",""))
except Exception:
  print("")' 2>/dev/null || true)

# Only this hook cares about Bash tool calls — gh api / curl only happen
# there.
if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

COMMAND=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception:
  print("")' 2>/dev/null || true)

# No command → nothing to inspect.
if [ -z "$COMMAND" ]; then
  exit 0
fi

# Run the segment-wise verdict in python3 (regex is far cleaner there than
# bash). The command text travels via an env var so we never have to shell-
# quote arbitrary agent-authored command text into a python -c string or a
# heredoc's substitution context.
export GH_LABEL_GUARD_CMD="$COMMAND"
VERDICT=$(python3 - <<'PY' 2>/dev/null || true
import os
import re

cmd = os.environ.get("GH_LABEL_GUARD_CMD", "")

# Split on shell segment separators — each segment is evaluated
# independently so a correct path-form delete chained with a collection GET
# is never false-denied.
SEP = re.compile(r"\s*(?:&&|\|\||;|\||\n)\s*")
METHOD = re.compile(r"(?:^|\s)(?:-X\s*|--method(?:=|\s+))[\"']?DELETE\b", re.I)
COLLECTION = re.compile(r"issues/([^/\s\"'#?]+)/labels/?(?=$|[\s\"'?#])")

offending_issue = None
for seg in SEP.split(cmd):
    if METHOD.search(seg):
        m = COLLECTION.search(seg)
        if m:
            offending_issue = m.group(1)
            break

if offending_issue is None:
    print("ALLOW")
else:
    print("DENY")
    print(offending_issue)
PY
)

VERDICT_LINE=$(printf '%s\n' "$VERDICT" | head -n1)

if [ "$VERDICT_LINE" != "DENY" ]; then
  exit 0
fi

ISSUE_NUM=$(printf '%s\n' "$VERDICT" | sed -n '2p')

REASON="gh-label-delete-guard: refusing this Bash command — it issues a DELETE against the issue labels COLLECTION endpoint ('issues/${ISSUE_NUM}/labels' with no trailing '/<name>' segment), which silently removes EVERY label on issue #${ISSUE_NUM} (issue #4654: 3 hits across 2 classes). Use the path form instead: 'gh issue edit ${ISSUE_NUM} --repo gaberoo322/hydra --remove-label <name>' (sanctioned) or 'DELETE repos/gaberoo322/hydra/issues/${ISSUE_NUM}/labels/<name>' (single-label REST form)."

# Emit the deny payload on stderr (per claude-code hook contract) and exit 2.
printf '%s\n' "$REASON" >&2
python3 -c "import json,sys
print(json.dumps({
  'hookSpecificOutput': {
    'hookEventName': 'PreToolUse',
    'permissionDecision': 'deny',
    'permissionDecisionReason': sys.argv[1]
  }
}))" "$REASON" >&2
exit 2
