#!/usr/bin/env bash
# setup-git-hooks.sh — install opt-in git hooks for Hydra operators.
#
# Currently installs a `post-merge` hook that auto-runs scripts/sync-skills.sh
# whenever `git pull` (or any merge) brings in changes to
# docs/operator-playbooks/*.md. This prevents the 2026-05-15 silent-wedge
# failure mode where an operator pulled a new playbook but forgot to sync the
# ~/.claude/skills/ mirror, leaving autopilot wedged against a stale prompt.
#
# This script is OPT-IN. The operator must run it explicitly — we never
# touch .git/hooks/ automatically. Re-running is safe (idempotent).
#
# Usage:
#   bash scripts/setup-git-hooks.sh           # install
#   bash scripts/setup-git-hooks.sh --remove  # uninstall

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
HOOK_PATH="$HOOKS_DIR/post-merge"
MARKER="# hydra-setup-git-hooks: post-merge"

REMOVE=0
if [ "${1:-}" = "--remove" ] || [ "${1:-}" = "-r" ]; then
  REMOVE=1
fi

if [ ! -d "$REPO_ROOT/.git" ] && [ ! -f "$REPO_ROOT/.git" ]; then
  echo "setup-git-hooks: $REPO_ROOT is not a git repo (no .git)" >&2
  exit 1
fi

# Resolve real hooks dir (handles worktrees where .git is a file pointing to
# .git/worktrees/<name>).
if [ -f "$REPO_ROOT/.git" ]; then
  GITDIR=$(git -C "$REPO_ROOT" rev-parse --git-common-dir)
  HOOKS_DIR="$GITDIR/hooks"
  HOOK_PATH="$HOOKS_DIR/post-merge"
fi

mkdir -p "$HOOKS_DIR"

if [ "$REMOVE" = 1 ]; then
  if [ -f "$HOOK_PATH" ] && grep -q "$MARKER" "$HOOK_PATH"; then
    rm -f "$HOOK_PATH"
    echo "removed hydra post-merge hook at $HOOK_PATH"
  else
    echo "no hydra post-merge hook to remove (none installed at $HOOK_PATH)"
  fi
  exit 0
fi

if [ -f "$HOOK_PATH" ] && ! grep -q "$MARKER" "$HOOK_PATH"; then
  echo "setup-git-hooks: $HOOK_PATH exists but was not installed by this script" >&2
  echo "setup-git-hooks: refusing to overwrite — inspect the file and remove it manually if you want this hook" >&2
  exit 2
fi

cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# hydra-setup-git-hooks: post-merge
#
# Re-syncs ~/.claude/skills/ and ~/.codex/skills/ when any operator playbook
# changed in the merge. Installed by scripts/setup-git-hooks.sh.
set -eu

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$REPO_ROOT" ] && exit 0

# ORIG_HEAD points at the pre-merge ref; HEAD is the post-merge tip.
# If ORIG_HEAD is missing (first clone, fast-forward edge cases), skip.
PRE="$(git rev-parse --verify --quiet ORIG_HEAD || true)"
POST="$(git rev-parse --verify --quiet HEAD || true)"
[ -z "$PRE" ] && exit 0
[ -z "$POST" ] && exit 0

CHANGED="$(git diff --name-only "$PRE" "$POST" -- 'docs/operator-playbooks/*.md' 2>/dev/null || true)"
if [ -z "$CHANGED" ]; then
  exit 0
fi

echo "[hydra post-merge] playbook changes detected, running scripts/sync-skills.sh..."
if [ -x "$REPO_ROOT/scripts/sync-skills.sh" ] || [ -f "$REPO_ROOT/scripts/sync-skills.sh" ]; then
  bash "$REPO_ROOT/scripts/sync-skills.sh" || {
    echo "[hydra post-merge] sync-skills.sh failed; operator should investigate" >&2
    exit 0  # don't break the merge — surface to operator instead
  }
fi
HOOK

chmod +x "$HOOK_PATH"
echo "installed hydra post-merge hook at $HOOK_PATH"
echo "  trigger: any merge that touches docs/operator-playbooks/*.md"
echo "  action:  bash scripts/sync-skills.sh"
echo "to remove: bash scripts/setup-git-hooks.sh --remove"
