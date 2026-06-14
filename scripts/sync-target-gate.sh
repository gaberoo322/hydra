#!/usr/bin/env bash
# sync-target-gate.sh — mirror the Target (hydra-betting) SDLC gate scripts and
# their orchestrator src-dependency closure into a betting worktree so the
# money-critical mutation gate, design-concept artifact, and post-merge-health
# checks actually run from the worktree where a Target build happens
# (issue #1451).
#
# THE PROBLEM (issue #1451):
#   scripts/target/{mutation-check,target-design-concept,post-merge-health}.ts
#   are authored in THIS repo (~/hydra, the orchestrator) and import from
#   ../../src/ (mutation.ts, exec-with-timeout.ts, target/money-critical.ts).
#   A hydra-target-build runs in a hydra-betting worktree where neither the
#   scripts nor src/ exist, so:
#     - running the gate from the worktree → ERR_MODULE_NOT_FOUND,
#     - running it from ~/hydra (orchestrator main tree) is path-fragile and was
#       the recurring friction the agents worked around by hand-rolling the
#       money-critical classification (re-introducing the web/-prefix bug that
#       classifyTargetRisk() already strips, #1235).
#   The fix is purely deployment/mirroring: make the scripts + their small,
#   self-contained src closure present INSIDE the betting worktree so the gate
#   runs locally with classifyTargetRisk() doing the web/ normalization.
#
# THE MECHANISM (chosen — sync at worktree-setup time):
#   Copy the gate scripts + src closure into a self-contained `.hydra-gate/`
#   directory at the root of the betting worktree, preserving the
#   `scripts/target/` + `src/` layout so the scripts' `../../src/...` relative
#   imports resolve unchanged. Register `.hydra-gate/` in the worktree's
#   `.git/info/exclude` so the mirror never pollutes the Target PR diff.
#
#   Why not a vendored copy committed into hydra-betting, or a hydra-betting CI
#   step? Both require editing the SEPARATE hydra-betting repo and create a
#   perpetual drift-sync burden between two repos. Syncing at worktree setup
#   keeps a SINGLE source of truth (this repo's HEAD), is always fresh (copies
#   the current scripts every build), is self-cleaning (branch-prune.sh GCs the
#   worktree), and keeps classifyTargetRisk()'s normalization authoritative.
#
# USAGE:
#   scripts/sync-target-gate.sh <target-worktree-dir>
#
#   Run from the orchestrator repo (~/hydra) — the script resolves its own
#   source files relative to this file's location, so cwd does not matter.
#   <target-worktree-dir> is the hydra-betting worktree created by Step 0.6 of
#   the hydra-target-build playbook (e.g. $TARGET_WT).
#
# AFTER SYNC, run the gate from inside the worktree, e.g.:
#   CHANGED_FILES="..." TARGET_PROJECT_DIR="$TARGET_WT/web" \
#     npx tsx "$TARGET_WT/.hydra-gate/scripts/target/mutation-check.ts"
#
# The script is idempotent — re-running overwrites the mirror with the current
# source. It fails loud (set -euo pipefail) so a broken mirror aborts the build
# rather than silently skipping the money-critical gate (the #1451 root cause).

set -euo pipefail

# The orchestrator repo root that owns the source-of-truth scripts. Resolved
# from this file's own location so the script works regardless of cwd.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Name of the self-contained mirror dir at the betting worktree root. Kept as a
# dot-dir + git-excluded so it never shows up in the Target PR diff.
GATE_DIR_NAME=".hydra-gate"

# The exact dependency closure (verified for issue #1451):
#   scripts/target/mutation-check.ts        → src/mutation.ts, src/target/money-critical.ts
#   scripts/target/target-design-concept.ts → src/target/money-critical.ts
#   scripts/target/post-merge-health.ts     → (stdlib only)
#   src/mutation.ts                         → src/exec-with-timeout.ts
#   src/exec-with-timeout.ts                → (stdlib only)
#   src/target/money-critical.ts            → (no imports)
# Paths are repo-relative; the layout is preserved under $GATE_DIR_NAME so the
# scripts' `../../src/...` relative imports resolve unchanged.
GATE_FILES=(
  "scripts/target/mutation-check.ts"
  "scripts/target/target-design-concept.ts"
  "scripts/target/post-merge-health.ts"
  "src/mutation.ts"
  "src/exec-with-timeout.ts"
  "src/target/money-critical.ts"
)

usage() {
  sed -n '2,46p' "$0"
  exit "${1:-0}"
}

case "${1:-}" in
  -h|--help) usage 0 ;;
  "") echo "sync-target-gate: missing <target-worktree-dir> argument" >&2; usage 2 ;;
esac

TARGET_WT="$1"

if [ ! -d "$TARGET_WT" ]; then
  echo "sync-target-gate: target worktree '$TARGET_WT' does not exist" >&2
  exit 2
fi

GATE_ROOT="$TARGET_WT/$GATE_DIR_NAME"

# Verify every source file exists BEFORE we copy anything — a missing source
# file means the closure drifted and the mirror would be incomplete (a silent
# gate no-op is exactly what #1451 is fixing). Fail loud instead.
missing=0
for f in "${GATE_FILES[@]}"; do
  if [ ! -f "$REPO_ROOT/$f" ]; then
    echo "sync-target-gate: source file missing in orchestrator repo: $f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "sync-target-gate: aborting — dependency closure incomplete (see above)." >&2
  exit 2
fi

# Fresh mirror each run (idempotent). Remove a stale mirror first so a removed
# source file does not linger in the worktree.
rm -rf "$GATE_ROOT"

copied=0
for f in "${GATE_FILES[@]}"; do
  dest="$GATE_ROOT/$f"
  mkdir -p "$(dirname "$dest")"
  cp "$REPO_ROOT/$f" "$dest"
  copied=$((copied + 1))
done

# Declare the mirror as an ESM package (issue #1883). The mirrored gate scripts
# and their src closure are authored as ES modules (import/export). Running them
# from a betting worktree leaves node unable to determine the module type of
# these .ts files from a package.json, so every gate invocation prints a
# MODULE_TYPELESS_PACKAGE_JSON warning + "Reparsing" notice on stderr —
# recurring noise that buries the real gate status line (agents grep it out by
# hand, friction cue recurrence 7x). A minimal package.json with "type":"module"
# at the mirror root makes node treat the whole .hydra-gate/ tree as ESM,
# silencing the warning. It is git-excluded with the rest of the mirror (the
# /$GATE_DIR_NAME/ exclude line below covers it), so it never pollutes the
# Target PR diff.
printf '%s\n' '{ "type": "module" }' > "$GATE_ROOT/package.json"

# Exclude the mirror from the betting worktree's git so it never pollutes the
# Target PR diff. `.git/info/exclude` is local to this worktree's checkout and
# is not committed. Use the worktree-aware git-dir so the exclude lands in the
# right place for a linked worktree (.git/worktrees/<name>/info/exclude when the
# main shared exclude is not writable from here is handled by git itself).
GIT_DIR="$(git -C "$TARGET_WT" rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "$GIT_DIR" ]; then
  # rev-parse may return a relative path; anchor it to the worktree.
  case "$GIT_DIR" in
    /*) ;;
    *) GIT_DIR="$TARGET_WT/$GIT_DIR" ;;
  esac
  EXCLUDE_FILE="$GIT_DIR/info/exclude"
  mkdir -p "$(dirname "$EXCLUDE_FILE")"
  EXCLUDE_LINE="/$GATE_DIR_NAME/"
  if [ ! -f "$EXCLUDE_FILE" ] || ! grep -qxF "$EXCLUDE_LINE" "$EXCLUDE_FILE" 2>/dev/null; then
    printf '%s\n' "$EXCLUDE_LINE" >> "$EXCLUDE_FILE"
  fi
else
  echo "sync-target-gate: WARN — '$TARGET_WT' is not a git worktree; skipping" \
       "git-exclude registration (mirror may show as untracked)." >&2
fi

echo "sync-target-gate: mirrored $copied gate file(s) into $GATE_ROOT"
echo "sync-target-gate: run the gate via $GATE_DIR_NAME/scripts/target/<name>.ts from $TARGET_WT"
