#!/usr/bin/env bash
# worktree-write-fence.sh — PreToolUse hook that blocks Edit/Write/MultiEdit
# tool calls whose `file_path` resolves outside the current worktree namespace.
#
# Background — issue #549. The Claude Code `Edit`/`Write`/`MultiEdit` tools
# resolve absolute paths against the filesystem, not the worktree namespace.
# `isolation: "worktree"` changes the agent's cwd, but does NOT make those
# tools worktree-aware. The known failure mode (observed on the PR #548
# dispatch): cwd is the worktree, but an Edit call with `file_path:
# /home/gabe/hydra/...` lands in the main checkout's working tree, leaving
# ghost M-files for the operator to discover.
#
# This hook is the harness-layer fence. It fires before every Edit/Write/
# MultiEdit tool call, and denies the call when:
#
#   1. cwd is under a recognised hydra worktree namespace
#      (/home/gabe/hydra/.claude/worktrees/, /dev/shm/hydra-worktrees/,
#       /home/gabe/hydra-worktrees/), AND
#   2. file_path resolves to a path under /home/gabe/hydra/ or
#      /home/gabe/hydra-betting/ but NOT under that cwd.
#
# If cwd is not a worktree namespace, the hook no-ops and exits 0 — operator
# sessions outside the autopilot are unaffected.
#
# Performance budget: <10ms per call (pure string manipulation, no I/O
# beyond reading stdin). PreToolUse hooks run synchronously and any slow
# hook would stall every Edit call.
#
# Deny payload format (per claude-code hook contract):
#   stderr: JSON with hookSpecificOutput.permissionDecision="deny"
#   exit:   2
#
# See docs/operator-playbooks/hydra-autopilot.md and operator memory
# feedback_bg_agent_worktree_hygiene.md for the broader context.

set -euo pipefail

# Read full stdin payload.
INPUT=$(cat)

# Extract cwd, tool name, file_path. Fall back to empty on parse error so we
# fail open (allow the call) rather than blocking on a malformed payload.
CWD=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("cwd",""))
except Exception:
  print("")' 2>/dev/null || true)

TOOL=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_name",""))
except Exception:
  print("")' 2>/dev/null || true)

FILE_PATH=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))
except Exception:
  print("")' 2>/dev/null || true)

# No file_path → nothing to fence (Edit/Write always send one; MultiEdit too).
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only fence when cwd is a recognised hydra worktree namespace. This keeps
# operator-driven sessions (cwd == ~/hydra) unaffected — the existing
# skill-level "ABORT not fall back" rule and the main-tree post-flight in
# hydra-dev step 7 handle that case.
WORKTREE_ROOTS=(
  "/home/gabe/hydra/.claude/worktrees/"
  "/dev/shm/hydra-worktrees/"
  "/home/gabe/hydra-worktrees/"
)

is_worktree_cwd=0
for root in "${WORKTREE_ROOTS[@]}"; do
  case "$CWD/" in
    "$root"*) is_worktree_cwd=1; break ;;
  esac
done

if [ "$is_worktree_cwd" = 0 ]; then
  exit 0
fi

# Canonical absolute paths. realpath -m so it works even if file_path doesn't
# exist yet (Write of a brand-new file).
CWD_REAL=$(realpath -m -- "$CWD" 2>/dev/null || printf '%s' "$CWD")
FILE_REAL=$(realpath -m -- "$FILE_PATH" 2>/dev/null || printf '%s' "$FILE_PATH")

# Only fence writes that target one of the two known main-tree namespaces.
# Writes to /tmp, /dev/shm (other than worktrees), the user's home, etc. are
# allowed — agents legitimately stage artefacts there.
MAIN_TREE_ROOTS=(
  "/home/gabe/hydra/"
  "/home/gabe/hydra-betting/"
)

targets_main_tree=0
for root in "${MAIN_TREE_ROOTS[@]}"; do
  case "$FILE_REAL/" in
    "$root"*) targets_main_tree=1; break ;;
  esac
done

if [ "$targets_main_tree" = 0 ]; then
  exit 0
fi

# If the file_path is inside the cwd worktree, it's fine — that's the
# whole point of the worktree.
case "$FILE_REAL/" in
  "$CWD_REAL/"*) exit 0 ;;
esac

# Ghost-write detected: cwd is a worktree, file_path is in a main-tree
# namespace, but file_path is NOT under cwd. Deny.
REASON="worktree-write-fence: refusing to ${TOOL:-Edit} '$FILE_PATH' — cwd is worktree '$CWD' but file_path resolves outside it ('$FILE_REAL'). This is the issue #549 ghost-write failure mode. Re-issue the call with a path inside the worktree, or use Bash(cd) to leave the worktree explicitly if that was intended."

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
