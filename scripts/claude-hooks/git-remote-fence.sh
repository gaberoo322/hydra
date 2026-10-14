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

# Drop heredoc bodies (keep the opener line) ONLY when the consumer is clearly
# not a shell: `bash <<'EOF' ... git remote set-url ... EOF` is a program, so
# its body must still be scanned. Delimiters must be identifiers (so `1<<3`
# arithmetic and `<<<` here-strings are not mistaken for heredocs).
SHELLISH = re.compile(
    r"\b(?:ba|z|da|k|c)?sh\b|\bsource\b|\beval\b|\bpython\d?\b|\bnode\b|\bperl\b|\bxargs\b|\bssh\b|\bsu\b|\bsudo\b"
)

def _strip_heredoc(m):
    line_start = cmd_before_strip.rfind("\n", 0, m.start()) + 1
    if SHELLISH.search(cmd_before_strip[line_start:m.end(1)]):
        return m.group(0)
    return m.group(1)

cmd_before_strip = cmd
cmd = re.sub(
    r"(?<!<)(<<-?\s*['\"]?([A-Za-z_]\w*)['\"]?[^\n]*\n).*?\n[ \t]*\2[ \t]*(?=\n|$)",
    _strip_heredoc,
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
    r"git(?:\s+(?:-[Cc]\s+" + VAL
    + r"|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)\s+" + VAL
    + r"|--[\w-]+(?:=\S+)?))*"
)
REMOTE_MUT = re.compile(
    START + GIT + r"\s+remote\s+(?:set-url|add|remove|rm|rename)\b", re.M
)
CONFIG = re.compile(START + GIT + r"\s+config\b([^;&|\n]*)", re.M)
READ_FLAG = re.compile(r"(?:^|\s)(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l)(?:\s|$)")
REMOTE_KEY = re.compile(r"(?:^|[\s\"'])remote\.[^\s\"']+")

# Every mutating invocation: (match start, GIT-prefix text).
mutations = [(m.start(), m.group(0)) for m in REMOTE_MUT.finditer(cmd)]
for m in CONFIG.finditer(cmd):
    rest = m.group(1)
    if REMOTE_KEY.search(rest) and not READ_FLAG.search(rest):
        mutations.append((m.start(), m.group(0)))
hit = bool(mutations)

if not hit:
    print("ALLOW")
    raise SystemExit(0)

protected = os.environ.get("HYDRA_REMOTE_FENCE_PROTECTED_GITDIR", "/home/gabe/hydra/.git")
protected_real = os.path.realpath(protected)

UNRESOLVED = re.compile(r"[$`]|^~")  # checked AFTER ~/$HOME expansion: only still-unset vars remain
CD = re.compile(START + r"cd\s+(" + VAL + r")", re.M)
OPT_C = re.compile(r"(?:^|\s)-C\s+(" + VAL + r")")
OPT_GITDIR = re.compile(r"--git-dir(?:=|\s+)(" + VAL + r")")

def unquote(v):
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v

def literal(v):
    v = os.path.expandvars(os.path.expanduser(unquote(v)))
    return None if (not v or UNRESOLVED.search(v)) else v

def common_dir(args):
    out = subprocess.run(
        ["git"] + args + ["rev-parse", "--git-common-dir"],
        capture_output=True, text=True, timeout=5,
    )
    c = out.stdout.strip()
    if out.returncode != 0 or not c:
        return None
    return c

def is_protected(pos, prefix):
    """Resolve the EFFECTIVE repo of one mutating git invocation: --git-dir,
    else the last literal `cd <dir>` before it, then `git -C <dir>` chain, else
    the session cwd. An unresolvable value (a `$VAR` / backtick / `~`, the
    empty-seam-var incident shape) falls back to the previous directory, which
    is exactly what the shell does for an empty value."""
    gd = OPT_GITDIR.search(prefix)
    if gd and literal(gd.group(1)):
        base = cwd
        c = common_dir(["--git-dir", os.path.join(base, literal(gd.group(1)))])
        if c is None:
            return False
        c = c if os.path.isabs(c) else os.path.join(base, literal(gd.group(1)), c)
        return os.path.realpath(c) == protected_real
    eff = cwd
    last_cd = None
    for cm in CD.finditer(cmd[:pos]):
        last_cd = cm.group(1)
    if last_cd and literal(last_cd):
        eff = os.path.join(eff, literal(last_cd))
    for cm in OPT_C.finditer(prefix):
        v = literal(cm.group(1))
        if v:
            eff = os.path.join(eff, v)
    c = common_dir(["-C", eff])
    if c is None:
        return False
    if not os.path.isabs(c):
        c = os.path.join(eff, c)
    return os.path.realpath(c) == protected_real

try:
    print("DENY" if any(is_protected(p_, t_) for p_, t_ in mutations) else "ALLOW")
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
