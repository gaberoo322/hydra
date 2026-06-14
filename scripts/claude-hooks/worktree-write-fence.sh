#!/usr/bin/env bash
# worktree-write-fence.sh — PreToolUse hook that blocks Edit/Write/MultiEdit
# (and steers Read) tool calls whose `file_path` resolves outside the current
# worktree namespace.
#
# Background — issue #549 (write fence) + issue #1861 (the same root cause kept
# recurring after #542 was closed-not-fixed, ~27 combined cross-run hits under
# six different friction cues). The Claude Code `Edit`/`Write`/`MultiEdit`/
# `Read` tools resolve absolute paths against the filesystem, not the worktree
# namespace. `isolation: "worktree"` changes the agent's cwd, but does NOT make
# those tools worktree-aware. The known failure mode (observed on the PR #548
# dispatch and again across the 2026-06-13/14 cycles): cwd is the worktree, but
# an Edit call with `file_path: /home/gabe/hydra/...` lands in the main
# checkout's working tree, leaving ghost M-files for the operator to discover —
# or the agent first *reads* the main-tree copy of a file, anchors on that
# absolute path, then re-uses it for the Edit that gets denied, burning turns.
#
# This hook is the harness-layer fence. It fires before every Edit/Write/
# MultiEdit/Read tool call, and:
#
#   1. DENIES Edit/Write/MultiEdit when cwd is under a recognised hydra
#      worktree namespace AND file_path resolves under /home/gabe/hydra/ or
#      /home/gabe/hydra-betting/ but NOT under that cwd.
#   2. DENIES a Read of a main-tree path *only when an equivalent copy exists
#      inside the worktree* (so the agent reads its own copy, never the stale
#      main-tree one that plants the bad absolute path for a later Edit). A
#      Read of a main-tree-only file (no worktree equivalent) is ALLOWED —
#      that's a legitimate cross-reference, not a ghost-write precursor.
#
# Every deny reason now SUGGESTS the corrected worktree-anchored path (issue
# #1861), so the agent self-corrects in one turn instead of recomputing the
# mapping itself. PreToolUse hooks can only allow/deny (not rewrite tool
# input), so the surfaced path is the closest thing to the "rewrite" the issue
# asked for.
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
matched_main_root=""
for root in "${MAIN_TREE_ROOTS[@]}"; do
  case "$FILE_REAL/" in
    "$root"*) targets_main_tree=1; matched_main_root="$root"; break ;;
  esac
done

if [ "$targets_main_tree" = 0 ]; then
  exit 0
fi

# If the file_path is inside the cwd worktree, it's fine — that's the
# whole point of the worktree. (A worktree under /home/gabe/hydra/.claude/
# worktrees/ also matches the /home/gabe/hydra/ main-tree root above, so this
# in-cwd short-circuit must come AFTER the main-tree match but BEFORE the deny.)
case "$FILE_REAL/" in
  "$CWD_REAL/"*) exit 0 ;;
esac

# --- Issue #1861: compute the corrected worktree-anchored path to SUGGEST. ---
# The main-tree path /home/gabe/hydra-betting/web/x.ts dispatched from a worktree
# whose target is hydra-betting maps to <cwd>/web/x.ts; a /home/gabe/hydra/...
# path maps to <cwd>/<rest>. We strip the matched main-tree root and re-anchor
# the remainder under cwd. This is best-effort: if the mapping is ambiguous the
# agent still gets a precise diagnosis, just without a one-line fix.
REL_PATH="${FILE_REAL#"$matched_main_root"}"
SUGGESTED_PATH="$CWD_REAL/$REL_PATH"

# Read steering (issue #1861): a Read of a main-tree copy is only a ghost-write
# *precursor* when the worktree has its own copy of that file. If only the
# main-tree copy exists (no worktree equivalent), the Read is a legitimate
# cross-reference (shared config the worktree never checked out, an adjacent
# project's file) — allow it. Edit/Write/MultiEdit are always fenced regardless,
# because a write to the main tree is a ghost-write whether or not a worktree
# copy exists.
if [ "$TOOL" = "Read" ]; then
  if [ ! -e "$SUGGESTED_PATH" ]; then
    # No worktree equivalent — legitimate cross-reference read. Allow.
    exit 0
  fi
  REASON="worktree-write-fence: refusing to Read '$FILE_PATH' — cwd is worktree '$CWD' and this main-tree copy has a worktree equivalent. Reading the main-tree copy anchors you on a path your later Edit/Write would ghost-write into the main checkout (issue #1861). Read your worktree copy instead: '$SUGGESTED_PATH'."
else
  # Ghost-write detected: cwd is a worktree, file_path is in a main-tree
  # namespace, but file_path is NOT under cwd. Deny with the corrected path.
  REASON="worktree-write-fence: refusing to ${TOOL:-Edit} '$FILE_PATH' — cwd is worktree '$CWD' but file_path resolves outside it ('$FILE_REAL'). This is the issue #549/#1861 ghost-write failure mode. Re-issue the call against the worktree copy instead: '$SUGGESTED_PATH' (or use Bash(cd) to leave the worktree explicitly if that was intended)."
fi

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
