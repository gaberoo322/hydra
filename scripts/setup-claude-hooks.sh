#!/usr/bin/env bash
# setup-claude-hooks.sh — install opt-in Claude Code PreToolUse hooks.
#
# Mirrors scripts/setup-git-hooks.sh in spirit: an explicit operator step
# that copies in-repo hook scripts to ~/.claude/hooks/hydra/ and patches
# ~/.claude/settings.json to register them. Re-running is safe (idempotent):
# managed PreToolUse blocks are replaced, never duplicated; every other
# settings key is preserved; the settings write is atomic and skipped when
# nothing changed.
#
# scripts/deploy.sh runs this on EVERY deploy (issue #5064), so hook edits on
# master reach the live copies. The watchdog's ## CLAUDE HOOKS block reads the
# HOOKS array below via `--list`, so this file is the single source of truth.
#
# Currently installs:
#   - worktree-write-fence.sh — issue #549 ghost-write fence for the
#     Edit/Write/MultiEdit tools used by hydra-dev / hydra-target-build
#     subagents.
#   - git-remote-fence.sh — issue #4939 Bash fence denying git remote
#     mutation from the orchestrator gitdir.
#
# Usage:
#   bash scripts/setup-claude-hooks.sh           # install / refresh
#   bash scripts/setup-claude-hooks.sh --remove  # uninstall
#   bash scripts/setup-claude-hooks.sh --list    # print managed HOOKS entries
#                                                # (one "name|matcher" per line)
#   Any other argument prints usage and exits 2 (never a silent full install).
#   If settings.json is a symlink, the link is kept and its target is updated.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/scripts/claude-hooks"
DST_DIR="${CLAUDE_HOOKS_DIR:-$HOME/.claude/hooks/hydra}"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

# The list of (hook-file, matcher) pairs we manage. Matcher is a regex per
# Claude Code's PreToolUse matcher contract — multiple tool names piped.
# Read is fenced too (issue #1861): the fence steers Reads of a main-tree copy
# that has a worktree equivalent, so the agent never anchors on the path that
# later ghost-writes.
HOOKS=(
  "worktree-write-fence.sh|Edit|Write|MultiEdit|Read"
  # Issue #4939: deny `git remote set-url|add|remove|rm|rename` / `git config
  # remote.*` writes from a session whose cwd is in the orchestrator gitdir.
  # Registered on Bash, inspecting the full command text (no `if:` prefix
  # rule — it would not reliably fire on a compound `cd … && git remote …`).
  "git-remote-fence.sh|Bash"
)

usage() {
  echo "usage: bash scripts/setup-claude-hooks.sh [--remove|-r | --list | --help|-h]"
}

REMOVE=0
case "${1:-}" in
  "") ;;
  --remove|-r) REMOVE=1 ;;
  --list)
    # Issue #5064: read-only listing for the watchdog's ## CLAUDE HOOKS block.
    # Touches nothing on disk.
    printf '%s\n' "${HOOKS[@]}"
    exit 0
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    # An unknown flag must never fall through to a full install.
    echo "setup-claude-hooks: unknown argument '$1'" >&2
    usage >&2
    exit 2
    ;;
esac

command -v python3 >/dev/null || { echo "setup-claude-hooks: python3 required" >&2; exit 127; }

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
import json, sys, os, shutil, tempfile

mode, settings_path, dst_dir, *entries = sys.argv[1:]

# Operators commonly symlink ~/.claude/settings.json into a dotfiles repo.
# Resolve the link ONCE and do every read/write against the real file, so the
# atomic rename below replaces the TARGET and the symlink itself survives
# (renaming over the link path would swap it for a regular file).
real_path = os.path.realpath(settings_path)

with open(real_path, "r", encoding="utf-8") as f:
    original = f.read()
data = json.loads(original)

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
rendered = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
if rendered == original:
    print(f"  {settings_path} unchanged")
    sys.exit(0)

# Issue #5064: this now runs on every deploy while Claude Code sessions are
# live and reading the file, so never truncate-in-place — write a sibling temp
# file and rename it over the original (atomic on the same filesystem). The temp
# file lives in the REAL target's directory so the rename never crosses a
# filesystem and lands on the symlink's target, not the link.
settings_dir = os.path.dirname(real_path)
fd, tmp_path = tempfile.mkstemp(prefix=".settings.", suffix=".tmp", dir=settings_dir)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(rendered)
    shutil.copymode(real_path, tmp_path)
    os.replace(tmp_path, real_path)
except BaseException:
    try:
        os.unlink(tmp_path)
    except OSError:
        pass  # intentional: temp already renamed or never created
    raise
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
