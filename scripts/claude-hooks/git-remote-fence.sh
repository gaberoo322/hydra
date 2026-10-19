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
#   git config ... remote.<name>.<key> ...   (a WRITE: a value follows the key,
#                                             or --unset/--add/--edit/set/...;
#                                             a bare key or a read flag is a
#                                             READ — see config_is_write)
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
# Path expansion (issue #5026): only HOME (`~`, $HOME, ${HOME}) is expanded;
# any other $VAR / backtick / $(...) is UNRESOLVED (the hook cannot see the
# Bash tool's shell env) and falls back to the enclosing directory. A literal
# target that is not a repo falls back to the SESSION CWD (deny iff protected),
# never to ALLOW. `cd` inside a group that closed before the git is ignored.
#
# Fail-open ONLY on tooling failure: malformed stdin, a non-Bash tool, an empty
# command or cwd, a session cwd that is not a git repo, or any python/git
# crash exits 0. Exit codes are 0 and 2.
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

# A shell WORD is one or more adjacent fragments: "dq", 'sq', or bare text
# (INV-4: `"$HOME"/orch` is ONE word, not `"$HOME"` followed by junk).
WORD = r"(?:\"[^\"]*\"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|[^\s\"';&|()`])+"
START = (
    r"(?:^|[;&|(){`\n]|\$\(|\b(?:then|do|else)\b|-c\s+[\"']|\beval\s+[\"']?)"
    r"\s*(?:\w+=(?:" + WORD + r")?\s+)*(?:(?:sudo|command|env|exec|xargs)\s+)*"
)
VAL = WORD
GIT = (
    r"git(?:\s+(?:-[Cc]\s+" + VAL
    + r"|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)\s+" + VAL
    + r"|--[\w-]+(?:=\S+)?))*"
)
REMOTE_MUT = re.compile(
    START + GIT + r"\s+remote\s+(?:set-url|add|remove|rm|rename)\b", re.M
)
CONFIG = re.compile(START + GIT + r"\s+config\b([^;&|\n]*)", re.M)
CONFIG_READ_FLAGS = {"--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"}
CONFIG_WRITE_FLAGS = {
    "--unset", "--unset-all", "--add", "--replace-all", "--rename-section",
    "--remove-section", "-e", "--edit",
}
CONFIG_READ_SUBCMDS = {"get", "list"}
CONFIG_WRITE_SUBCMDS = {"set", "unset"}
SUBST = re.compile(r"\$\([^)]*\)|`[^`]*`")
REMOTE_KEY_TOKEN = re.compile(r"remote\.\S+")

def config_is_write(rest):
    """INV-6: classify the argument list of a `git config` invocation.
    Substitutions become one opaque VALUE token first, so a flag inside
    `$(...)` can never count as a read flag but the word still counts as a
    value. Returns True iff it names a remote.* key AND is a write."""
    rest = SUBST.sub(" VALUE ", rest)
    toks = [t.rstrip(")") for t in rest.split()]
    toks = [t for t in toks if t]
    key_idx = None
    for i, t in enumerate(toks):
        if REMOTE_KEY_TOKEN.fullmatch(t.strip("\"'")):
            key_idx = i
            break
    if key_idx is None:
        return False
    before, after = toks[:key_idx], toks[key_idx + 1:]
    if any(t in CONFIG_WRITE_FLAGS for t in toks) or any(t in CONFIG_WRITE_SUBCMDS for t in before):
        return True
    if any(t in CONFIG_READ_FLAGS for t in toks) or any(t in CONFIG_READ_SUBCMDS for t in before):
        return False
    return any(not t.startswith("-") for t in after)  # a value follows the key

# Every mutating invocation: (match start, GIT-prefix text).
mutations = [(m.start(), m.group(0)) for m in REMOTE_MUT.finditer(cmd)]
for m in CONFIG.finditer(cmd):
    if config_is_write(m.group(1)):
        mutations.append((m.start(), m.group(0)))
# Fail closed on $(...) nesting deeper than WORD's regex can balance: a loose
# `... remote <mutation>` match not covered by any strict match is still a
# mutation (its prefix resolves unparseably, so the session cwd decides).
DEEP_SUBST = re.compile(r"\$\([^()]*\([^()]*\([^()]*\(")
if DEEP_SUBST.search(cmd):
    for lm in re.finditer(r"\bgit\b[^\n]*?\bremote\s+(?:set-url|add|remove|rm|rename)\b", cmd):
        if not any(ms <= lm.start() <= ms + len(mt) for ms, mt in mutations):
            mutations.append((lm.start(), lm.group(0)))
hit = bool(mutations)

if not hit:
    print("ALLOW")
    raise SystemExit(0)

protected = os.environ.get("HYDRA_REMOTE_FENCE_PROTECTED_GITDIR", "/home/gabe/hydra/.git")
protected_real = os.path.realpath(protected)

UNRESOLVED = re.compile(r"[$`]|^~")  # checked AFTER ~/$HOME expansion: only unresolvable tokens remain
CD = re.compile(START + r"cd\s+(" + VAL + r")", re.M)
OPT_C = re.compile(r"(?:^|\s)-C\s+(" + VAL + r")")
OPT_GITDIR = re.compile(r"--git-dir(?:=|\s+)(" + VAL + r")")
ENV_GITDIR = re.compile(r"(?<![\w])GIT_DIR=(" + VAL + r")")
FRAGMENT = re.compile(r"\"[^\"]*\"|'[^']*'|[^\"']+")

def unquote(v):
    """Strip quotes per adjacent fragment (INV-4). `$` inside single quotes is
    literal, so it is masked from the HOME expansion below."""
    out = []
    for f in FRAGMENT.findall(v):
        if f[0] == "'" and f[-1] == "'" and len(f) >= 2:
            out.append(f[1:-1].replace("$", "\x01"))
        elif f[0] == '"' and f[-1] == '"' and len(f) >= 2:
            out.append(f[1:-1])
        else:
            out.append(f)
    return "".join(out)

def literal(v):
    """INV-1: the hook consults ONLY HOME (`~`, $HOME, ${HOME}); every other
    variable is unresolved because the hook cannot see the Bash tool's env."""
    v = os.path.expanduser(unquote(v))
    home = os.environ.get("HOME", "")
    if home:
        v = re.sub(r"\$\{HOME\}|\$HOME(?![A-Za-z0-9_])", lambda _m: home, v)
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

def paren_depths(text):
    """depth[i] = shell group depth before text[i] (INV-3). `(` and `$(` open a
    group, `)` closes it; quoted spans are skipped."""
    depth = [0] * (len(text) + 1)
    d = 0
    bt = False
    quote = None
    i = 0
    while i < len(text):
        depth[i] = d
        ch = text[i]
        if quote:
            if quote == '"' and ch == "\\":
                i += 1
                if i < len(text):
                    depth[i] = d
            elif ch == quote:
                quote = None
        elif ch == "\\":
            i += 1
            if i < len(text):
                depth[i] = d
        elif ch in "\"'":
            quote = ch
        elif ch == "`":
            # Backtick substitution is a group too: open on the first, close on the next.
            if bt:
                d = max(0, d - 1)
                bt = False
            else:
                d += 1
                bt = True
        elif ch == "(":
            d += 1
        elif ch == ")":
            d = max(0, d - 1)
        i += 1
    depth[len(text)] = d
    return depth

DEPTHS = paren_depths(cmd)

def effective_cd(pos):
    """The last literal `cd` before pos whose group is still open at pos."""
    last = None
    for cm in CD.finditer(cmd[:pos]):
        d = DEPTHS[cm.end()]
        # `cd X | git ...` / `cd X & git ...`: the cd runs in a pipeline stage
        # or background job, not the shell that runs git. `cd X || ...` is NOT
        # skipped: the guarded-cd idiom (`cd X || exit 1; git ...`) runs git in X.
        if re.match(r"[ \t]*(?:\|(?!\|)|&(?!&))", cmd[cm.end():]):
            continue
        if min(DEPTHS[cm.end():pos + 1]) >= d:
            last = cm.group(1)
    return last

def resolves_protected(c, base):
    if c is None:
        return None
    if not os.path.isabs(c):
        c = os.path.join(base, c)
    return os.path.realpath(c) == protected_real

def is_protected(pos, prefix):
    """Resolve the EFFECTIVE repo of one mutating git invocation: the last
    in-scope literal `cd <dir>`, then `git -C <dir>` chain, then --git-dir /
    GIT_DIR=. An unresolvable value (`$VAR`, backtick, the empty-seam-var
    incident shape) falls back to the previous directory, exactly as the shell
    does for an empty value. If the effective repo cannot be resolved at all
    (nonexistent dir, not a repo) the SESSION CWD is the effective repo
    (INV-2): unresolvable never allows."""
    eff = cwd
    last_cd = effective_cd(pos)
    if last_cd and literal(last_cd):
        eff = os.path.join(eff, literal(last_cd))
    for cm in OPT_C.finditer(prefix):
        v = literal(cm.group(1))
        if v:
            eff = os.path.join(eff, v)
    gd = OPT_GITDIR.search(prefix) or ENV_GITDIR.search(prefix)
    gd_val = literal(gd.group(1)) if gd else None
    res = None
    if gd_val:
        gpath = os.path.join(eff, gd_val)
        res = resolves_protected(common_dir(["--git-dir", gpath]), gpath)
    else:
        res = resolves_protected(common_dir(["-C", eff]), eff)
    if res is None:
        res = resolves_protected(common_dir(["-C", cwd]), cwd)
    return bool(res)

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
