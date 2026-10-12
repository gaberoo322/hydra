#!/usr/bin/env bash
# git-remote-fence.sh — PreToolUse hook that DENIES a Bash command which
# mutates a git remote when the session cwd belongs to the orchestrator
# gitdir (/home/gabe/hydra/.git — the main checkout or any ~/hydra worktree).
#
# Background — issue #4939. Every ~/hydra worktree shares one .git/config. On
# 2026-10-07 a Target dispatch (cleanup_target, launched with pwd ==
# /home/gabe/hydra) ran `cd "$TARGET_WS" && git remote set-url origin
# <claw-street-bets>` with an empty $TARGET_WS: `cd ""` is a silent no-op, so
# the rewrite landed on the ORCHESTRATOR's origin. A pruning fetch then
# deleted refs/remotes/origin/master and recent-merges failed open for ~80
# minutes. Prose rules lower the odds; this hook is the deterministic fence
# (defense in depth behind the `${VAR:?}` playbook guards and the watchdog's
# run_origin_identity alarm).
#
# DENIES (statement-start `git`, optional -C/-c/--opt prefix) when the cwd's
# `git rev-parse --git-common-dir` resolves to the protected gitdir:
#   git remote set-url|add|remove|rm|rename ...
#   git config ... remote.<name>.<key> ...   (a WRITE: any form without a
#                                             read flag --get/--get-all/
#                                             --get-regexp/--list/-l)
# ALLOWS everything else — `git remote -v`, `git remote get-url`, `git remote
# show`, `git config --get remote.origin.url`, and any command from a cwd
# outside the protected gitdir (operator shells outside Claude Code are not
# hooked at all).
#
# The hook inspects the FULL command text, so a compound
# `cd "$X" && git remote set-url ...` is caught (the observed shape). A
# permission-rule prefix match would not reliably fire on a compound command.
# Heredoc bodies are ignored so a PR body that merely quotes the command text
# does not trip it.
#
# Fail-open: malformed stdin, a non-Bash tool, an empty command, a cwd that is
# not a git repo, or any python/git failure exits 0. Exit codes are 0 and 2.
#
# Deny payload (claude-code hook contract, same as worktree-write-fence.sh):
#   stderr: JSON hookSpecificOutput.permissionDecision="deny"
#   exit:   2
#
# Testability: HYDRA_REMOTE_FENCE_PROTECTED_GITDIR overrides the protected
# common-dir (default /home/gabe/hydra/.git).

set -uo pipefail

INPUT=$(cat)
export GIT_REMOTE_FENCE_INPUT="$INPUT"

VERDICT=$(python3 - <<'PY' 2>/dev/null
import json, os, re, subprocess

try:
    payload = json.loads(os.environ.get("GIT_REMOTE_FENCE_INPUT", ""))
except Exception:
    print("ALLOW")
    raise SystemExit(0)

if payload.get("tool_name") != "Bash":
    print("ALLOW")
    raise SystemExit(0)

cmd = (payload.get("tool_input") or {}).get("command", "") or ""
cwd = payload.get("cwd", "") or ""
if not cmd or not cwd:
    print("ALLOW")
    raise SystemExit(0)

# Drop heredoc bodies (keep the opener line): `<<'EOF' ... EOF`.
cmd = re.sub(
    r"(<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n).*?\n[ \t]*\2[ \t]*(?=\n|$)",
    r"\1",
    cmd,
    flags=re.S,
)
# Collapse backslash line-continuations.
cmd = re.sub(r"\\\n", " ", cmd)

START = (
    r"(?:^|[;&|(){`\n]|\$\(|\b(?:then|do|else)\b|-c\s+[\"']|\beval\s+[\"']?)"
    r"\s*(?:\w+=\S*\s+)*(?:(?:sudo|command|env|exec|xargs)\s+)*"
)
VAL = r"(?:\"[^\"]*\"|'[^']*'|\S+)"
GIT = (
    r"git(?:\s+(?:-[Cc]\s+" + VAL + r"|--[\w-]+(?:=\S+)?))*"
)
REMOTE_MUT = re.compile(
    START + GIT + r"\s+remote\s+(?:set-url|add|remove|rm|rename)\b", re.M
)
CONFIG = re.compile(START + GIT + r"\s+config\b([^;&|\n]*)", re.M)
READ_FLAG = re.compile(r"(?:^|\s)(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l)(?:\s|$)")
REMOTE_KEY = re.compile(r"(?:^|[\s\"'])remote\.[^\s\"']+")

hit = REMOTE_MUT.search(cmd) is not None
if not hit:
    for m in CONFIG.finditer(cmd):
        rest = m.group(1)
        if REMOTE_KEY.search(rest) and not READ_FLAG.search(rest):
            hit = True
            break

if not hit:
    print("ALLOW")
    raise SystemExit(0)

protected = os.environ.get("HYDRA_REMOTE_FENCE_PROTECTED_GITDIR", "/home/gabe/hydra/.git")
try:
    out = subprocess.run(
        ["git", "-C", cwd, "rev-parse", "--git-common-dir"],
        capture_output=True, text=True, timeout=5,
    )
    common = out.stdout.strip()
    if out.returncode != 0 or not common:
        print("ALLOW")
        raise SystemExit(0)
    if not os.path.isabs(common):
        common = os.path.join(cwd, common)
    if os.path.realpath(common) == os.path.realpath(protected):
        print("DENY")
    else:
        print("ALLOW")
except SystemExit:
    raise
except Exception:
    print("ALLOW")
PY
)

if [ "${VERDICT%%$'\n'*}" != "DENY" ]; then
  exit 0
fi

REASON="git-remote-fence: refusing this Bash command — it mutates a git remote (git remote set-url|add|remove|rm|rename, or git config remote.*) while the session cwd belongs to the orchestrator gitdir /home/gabe/hydra/.git, which every ~/hydra worktree shares (issue #4939: an empty \$TARGET_WS made 'cd \"\$TARGET_WS\" && git remote set-url origin <target>' rewrite ~/hydra's origin and prune origin/master). Never correct a remote. If 'git remote -v' / 'git fetch' shows the ORCHESTRATOR remote where the Target was expected, the seam var is empty: STOP and re-run the target-seam preamble in THIS Bash call. Reads (git remote -v, git remote get-url, git config --get remote.origin.url) are allowed."

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
