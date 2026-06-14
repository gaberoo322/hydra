#!/usr/bin/env bash
# setup-claude-hooks.sh — install opt-in Claude Code PreToolUse hooks.
#
# Mirrors scripts/setup-git-hooks.sh in spirit: an explicit operator step
# that copies in-repo hook scripts to ~/.claude/hooks/hydra/ and patches
# ~/.claude/settings.json to register them. Re-running is safe (idempotent).
#
# Currently installs:
#   - worktree-write-fence.sh — issue #549 ghost-write fence for the
#     Edit/Write/MultiEdit tools used by hydra-dev / hydra-target-build
#     subagents.
#
# Usage:
#   bash scripts/setup-claude-hooks.sh           # install / refresh
#   bash scripts/setup-claude-hooks.sh --remove  # uninstall

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/scripts/claude-hooks"
DST_DIR="${CLAUDE_HOOKS_DIR:-$HOME/.claude/hooks/hydra}"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

REMOVE=0
if [ "${1:-}" = "--remove" ] || [ "${1:-}" = "-r" ]; then
  REMOVE=1
fi

command -v python3 >/dev/null || { echo "setup-claude-hooks: python3 required" >&2; exit 127; }

# The list of (hook-file, matcher) pairs we manage. Matcher is a regex per
# Claude Code's PreToolUse matcher contract — multiple tool names piped.
# Read is fenced too (issue #1861): the fence steers Reads of a main-tree copy
# that has a worktree equivalent, so the agent never anchors on the path that
# later ghost-writes.
HOOKS=(
  "worktree-write-fence.sh|Edit|Write|MultiEdit|Read"
)

install_hook() {
  local src="$1" dst="$2"
  if [ ! -f "$src" ]; then
    echo "setup-claude-hooks: missing source hook $src" >&2
    return 1
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  chmod +x "$dst"
  echo "  installed $dst"
}

remove_hook() {
  local dst="$1"
  if [ -f "$dst" ]; then
    rm -f "$dst"
    echo "  removed $dst"
  fi
}

# Settings patch is JSON; do it in python so we don't shell-quote ourselves
# into a corner. The patcher is idempotent: it removes any existing entry
# pointing at the same hook filename before re-adding the desired one (or
# just removes when --remove is passed).
patch_settings() {
  local mode="$1"   # install | remove
  shift
  if [ ! -f "$SETTINGS" ]; then
    if [ "$mode" = "remove" ]; then
      return 0
    fi
    echo "setup-claude-hooks: $SETTINGS not found — creating minimal scaffold" >&2
    mkdir -p "$(dirname "$SETTINGS")"
    printf '%s\n' '{ "hooks": {} }' > "$SETTINGS"
  fi

  python3 - "$mode" "$SETTINGS" "$DST_DIR" "$@" <<'PY'
import json, sys, os

mode, settings_path, dst_dir, *entries = sys.argv[1:]

with open(settings_path, "r") as f:
    data = json.load(f)

hooks = data.setdefault("hooks", {})
pre = hooks.setdefault("PreToolUse", [])

# Parse entries of the form "name.sh|Tool1|Tool2|..."
def parse(entry):
    parts = entry.split("|")
    return parts[0], parts[1:]

managed = {}
for e in entries:
    name, tools = parse(e)
    managed[name] = tools

# First, strip every PreToolUse block whose hooks reference one of our
# managed scripts. This way the patcher is idempotent across upgrades.
def block_is_managed(block):
    for h in block.get("hooks", []):
        cmd = h.get("command", "")
        for name in managed:
            if name in cmd and dst_dir in cmd:
                return True
    return False

pre[:] = [b for b in pre if not block_is_managed(b)]

if mode == "install":
    for name, tools in managed.items():
        cmd = f"bash {dst_dir}/{name}"
        block = {
            "matcher": "|".join(tools),
            "hooks": [
                {"type": "command", "command": cmd}
            ],
        }
        pre.append(block)
    print(f"  patched {settings_path} (added {len(managed)} PreToolUse block(s))")
elif mode == "remove":
    print(f"  patched {settings_path} (removed managed PreToolUse blocks)")

# Strip the PreToolUse list entirely if empty, to keep the file tidy.
if not pre:
    hooks.pop("PreToolUse", None)

# Pretty-print with stable key ordering — keep the diff small.
with open(settings_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

mkdir -p "$DST_DIR"

if [ "$REMOVE" = 1 ]; then
  echo "removing hydra claude hooks…"
  for entry in "${HOOKS[@]}"; do
    name="${entry%%|*}"
    remove_hook "$DST_DIR/$name"
  done
  patch_settings remove "${HOOKS[@]}"
  echo "done."
  exit 0
fi

echo "installing hydra claude hooks…"
for entry in "${HOOKS[@]}"; do
  name="${entry%%|*}"
  install_hook "$SRC_DIR/$name" "$DST_DIR/$name"
done
patch_settings install "${HOOKS[@]}"
echo "done. hooks active for new Claude Code sessions."
echo "to remove: bash scripts/setup-claude-hooks.sh --remove"
