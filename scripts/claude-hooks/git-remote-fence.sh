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
# minutes.
#
# THREAT MODEL (issue #5026). This hook is an ACCIDENT fence against agent
# MISFIRES — the #4939 empty-`$TARGET_WS` class, where a well-meaning command
# silently lands on the wrong repo. It is NOT a security boundary against a
# hostile agent and does not try to be. Explicitly OUT OF SCOPE:
#   - git reached through a variable or an alias (`$GIT remote add ...`,
#     a shell alias/function, a git alias in a gitconfig);
#   - direct writes to .git/config — sed / python / printf / tee on the file,
#     or `git config --file <path> ...`;
#   - non-git interpreters (python/node/perl git bindings, dulwich, ...);
#   - indirect remote rewrites that never touch remote.* (`git config
#     url.<base>.insteadOf <x>`, `--global`/`--system` url.* rewrites);
#   - `pushd`/`popd` directory changes (not modelled as a `cd`; the session
#     cwd / the git's own -C decides).
# The other layers of the defense:
#   - the playbooks' `${VAR:?}` guards, which abort the empty-seam-var shape
#     before any git runs;
#   - the watchdog's run_origin_identity check (scripts/hydra-watchdog.sh),
#     which alarms when ~/hydra's origin is not the orchestrator repo (an
#     auto-repair follow-up is filed separately);
#   - hook installation by deploy (filed separately) — today the hook is
#     registered by scripts/setup-claude-hooks.sh and the GLM drainer settings.
#
# Three layers (issue #5026):
#  1. STRICT parser (regex) — positively identifies a statement-start `git`
#     (optional VAR=/GIT_DIR= prefix, sudo/command/env/exec/xargs, -C/-c/--opt)
#     and resolves its effective repo (cd scope, -C chain, --git-dir/GIT_DIR=).
#     It DENIES when that repo's `git rev-parse --git-common-dir` is the
#     protected gitdir.
#  2. LOOSE tokenizer — runs UNCONDITIONALLY over the whole command (balanced
#     quotes and $(...) at any depth, shell -c / eval strings) and finds every
#     remote mutation however `git` is spelled (/usr/bin/git, "git", time /
#     nohup / timeout N / command -p ... git, git -p/-P/--no-pager ...). Any
#     loose hit the strict parser did not resolve is DENIED FAIL-CLOSED, from
#     ANY cwd ("unparseable remote mutation — run it by hand if intended").
#     Wrapper words (sudo/env/xargs/nice/timeout/...) are skipped WITH their
#     options, so the command word is the first non-option word after them
#     (`xargs -n1 echo git remote add` -> `echo`).
#  3. TOKEN-PAIR BACKSTOP (QA round 4, operator-directed) — a coarse,
#     grammar-free text scan. Strictly-parsed spans are blanked, `$'...'` is
#     decoded and quotes/backslashes dropped; then, case-insensitively over the
#     whole remaining text (heredoc bodies excluded), a `git` word followed
#     later by `remote <set-url|add|rename|rm|remove|set-head|set-branches|
#     prune>`, or by a `config` WRITE to a remote.* key, is DENIED FAIL-CLOSED
#     from ANY cwd ("remote-mutation phrase in command text"). It closes every
#     shape where git is not a command word without enumerating wrappers:
#     `echo "git remote set-url o x" | sh`, `bash -s`, `<(...)` text,
#     `find . -exec/-execdir/-ok git remote add ...`, `parallel`, `xargs`.
#     FALSE-POSITIVE TRADE-OFF (accepted): a command whose text merely
#     MENTIONS such a phrase outside a heredoc — a `--body "..."` / `-m "..."`
#     string, an `echo`, a `grep` pattern — is denied too. Agents put such
#     text in a file (`--body-file`, `git commit -F`) or a heredoc instead.
# Only REAL-shell heredocs (sh/bash/zsh/dash/ksh as the consumer) are scanned
# as programs; any other heredoc body is data and is dropped first.
# Mutations (all layers):
#   git remote set-url|add|remove|rm|rename|set-head|set-branches|prune ...
#   git config ... remote.<name>.<key> ...   (a WRITE: a value follows the key,
#                                             or --unset/--add/--edit/set/...;
#                                             a bare key or a read flag is a
#                                             READ — see config_is_write; the
#                                             key match is case-insensitive and
#                                             a quoted-empty "" is a value)
# ALLOWS everything else — `git remote -v`, `git remote get-url`, `git remote
# show`, `git config --get remote.origin.url` (with or without a redirect), and
# any STRICTLY-parsed mutation whose effective repo is not the protected gitdir
# (operator shells outside Claude Code are not hooked at all). Known limit (see
# THREAT MODEL): a git reached through a variable or an alias is not seen.
#
# The hook inspects the FULL command text, so a compound
# `cd "$X" && git remote set-url ...` is caught (the observed shape). A
# permission-rule prefix match would not reliably fire on a compound command.
# Heredoc bodies are ignored so a PR body that merely quotes the command text
# does not trip it.
#
# Path expansion (issue #5026): only HOME (`~`, $HOME, ${HOME}) is expanded;
# any other $VAR / backtick / $(...) is UNRESOLVED (the hook cannot see the
# Bash tool's shell env) and falls back to the enclosing directory; an
# unresolved target that is not a repo falls back to the SESSION CWD (deny iff
# protected), never to ALLOW. A LITERAL target that is not (yet) a repo — e.g.
# `git init /tmp/x && cd /tmp/x && git remote add ...` — is decided BY PATH:
# protected iff it lies under the protected gitdir's worktree roots (its parent
# plus `git worktree list`: ~/hydra, .claude/worktrees/*, /dev/shm/hydra-
# worktrees/*). Exception: an UNGUARDED `cd <missing dir>; git ...` (no `&&` /
# `|| exit`) runs git in the previous directory, so the session cwd is checked
# too. `cd` inside a group that closed before the git is ignored.
#
# Fail-open vs fail-closed (issue #5026, scoped deny-on-crash):
#   - Pure-bash PRE-FILTER: if the raw stdin text contains neither `remote` nor
#     `config`, exit 0 at once — python never starts. This is the fast path for
#     nearly every Bash call; a false "maybe" just falls through to python.
#   - Fail-OPEN (exit 0) only for legitimate early exits: a non-Bash tool, an
#     empty command, no mutation found, and a strictly-parsed mutation whose
#     effective repo (and fallback session cwd) is not the protected gitdir —
#     which includes a session cwd that is not a git repo, provided the loose
#     scan and the token-pair backstop found nothing unresolved.
#   - Fail-CLOSED (exit 2) once the input mentions remote/config: malformed
#     stdin JSON, a mutation with no session cwd, a python crash or missing
#     interpreter (no verdict), python's internal-error `ERROR` verdict, or any
#     unexpected verdict — "analysis failed on a command mentioning
#     remote/config — denied fail-closed; run it by hand if intended".
#   - No silent ALLOW after a positive identification (QA round 4): once a
#     mutation is identified, any exception yields ERROR (deny), and every
#     python except-path logs to stderr (python's stderr is not discarded).
# Exit codes are 0 and 2.
#
# Deny payload (claude-code hook contract, same as worktree-write-fence.sh):
#   stderr: JSON hookSpecificOutput.permissionDecision="deny"
#   exit:   2
#
# Testability: HYDRA_REMOTE_FENCE_PROTECTED_GITDIR overrides the protected
# common-dir (default /home/gabe/hydra/.git); HYDRA_REMOTE_FENCE_PYTHON
# overrides the python interpreter (default python3) so a test can force the
# analysis to fail.

set -uo pipefail

INPUT=$(cat)

# Pre-filter (pure bash, no python): a command that mentions neither `remote`
# nor `config` cannot carry a remote mutation. The text scanned is the JSON
# "command" string when a cheap regex can pull it out, else the RAW stdin (so
# malformed JSON is still scanned). Quotes and backslashes are dropped first,
# so `"re"mote` / `re\mote` still count. Deliberately loose: a false "maybe"
# only costs a python run.
SCAN="$INPUT"
CMD_RE='"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)"'
if [[ "$INPUT" =~ $CMD_RE ]]; then
  SCAN="${BASH_REMATCH[1]}"
fi
SCAN="${SCAN//[\"\'\\]/}"
# Case-insensitive, like the python backstop and git's config section names.
shopt -s nocasematch
case "$SCAN" in
  *remote*|*config*) ;;
  *) exit 0 ;;
esac

export GIT_REMOTE_FENCE_INPUT="$INPUT"
PYTHON_BIN="${HYDRA_REMOTE_FENCE_PYTHON:-python3}"

# Verdict protocol (stdout, first line): ALLOW | DENY + reason line | ERROR.
# Anything other than ALLOW/DENY — ERROR, empty stdout from a crash or a
# missing interpreter, garbage — is denied fail-closed below.
# python's stderr is NOT discarded: its internal-error paths log there (fail
# loud, QA round 4); the normal ALLOW/DENY paths write nothing to stderr.
VERDICT=$("$PYTHON_BIN" - <<'PY'

import json, os, re, subprocess

try:
    payload = json.loads(os.environ.get("GIT_REMOTE_FENCE_INPUT", ""))
    if not isinstance(payload, dict):
        raise ValueError("payload is not a JSON object")
except Exception as e:
    # Malformed stdin that passed the remote/config pre-filter: fail closed.
    import sys
    print(f"git-remote-fence: malformed hook stdin: {e}", file=sys.stderr)
    print("ERROR")
    raise SystemExit(0)

if payload.get("tool_name") != "Bash":
    print("ALLOW")
    raise SystemExit(0)

cmd = (payload.get("tool_input") or {}).get("command", "") or ""
cwd = payload.get("cwd", "") or ""
if not isinstance(cmd, str) or not isinstance(cwd, str):
    print("ERROR")
    raise SystemExit(0)
if not cmd:
    print("ALLOW")
    raise SystemExit(0)

# Drop heredoc bodies (keep the opener line) ONLY when the consumer is clearly
# not a shell: `bash <<'EOF' ... git remote set-url ... EOF` is a program, so
# its body must still be scanned. Delimiters must be identifiers (so `1<<3`
# arithmetic and `<<<` here-strings are not mistaken for heredocs).
# QA round 4: only REAL shells (sh, bash, zsh, dash, ksh — as a command word,
# optionally path-qualified) make a heredoc body a program. A data heredoc fed
# to python/node/perl/gh/... is ignored (non-git interpreters are out of scope).
SHELLISH = re.compile(r"(?:^|[\s|;&(/])(?:ba|z|da|k)?sh(?=[\s;&|)]|$)")

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
REMOTE_MUT_SUBCMDS = ("set-url", "add", "remove", "rm", "rename", "set-head", "set-branches", "prune")
REMOTE_MUT = re.compile(
    START + GIT + r"\s+remote\s+(?:" + "|".join(REMOTE_MUT_SUBCMDS) + r")(?![\w-])", re.M
)
CONFIG = re.compile(START + GIT + r"\s+config\b([^;&|\n]*)", re.M)
CONFIG_READ_FLAGS = {"--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"}
CONFIG_WRITE_FLAGS = {
    "--unset", "--unset-all", "--add", "--replace-all", "--rename-section",
    "--remove-section", "-e", "--edit",
}
CONFIG_READ_SUBCMDS = {"get", "list"}
CONFIG_WRITE_SUBCMDS = {"set", "unset"}
# Git section names are case-insensitive: `REMOTE.origin.url` is remote.* too.
REMOTE_KEY_TOKEN = re.compile(r"remote\.\S+", re.I)

REDIRECT = re.compile(r"^\d*(?:>>?|<<?<?|>&|<&|&>>?|>\|)")

def drop_redirects(words):
    """Remove redirection tokens (`2>/dev/null`, `> f`, `2>&1`) so a redirect
    target is never mistaken for a config VALUE."""
    out, skip = [], False
    for w in words:
        if skip:
            skip = False
            continue
        m = REDIRECT.match(w)
        if m:
            skip = m.end() == len(w)  # bare operator: its target is the next word
            continue
        out.append(w)
    return out

ANSI_C = re.compile(r"\$'((?:[^'\\]|\\.)*)'")

def decode_ansi_c(text):
    """Decode bash ANSI-C quoting (`$'add'` -> add, `$'\\x61dd'` -> add) and
    drop the `$` of locale quoting (`$"add"`), so a quoted subcommand cannot
    hide from the scans (QA round 4). Undecodable escapes keep their text."""
    def dec(m):
        try:
            return m.group(1).encode("latin-1", "backslashreplace").decode("unicode_escape")
        except Exception:  # intentional: keep the raw body; it is still scanned as text
            return m.group(1)
    return re.sub(r"\$\"", '"', ANSI_C.sub(dec, text))

def bare(w):
    """A shell word with its quoting removed (`"git"`, 'git', \\git, $'git' -> git)."""
    return re.sub(r"[\"'\\]", "", decode_ansi_c(w))

def config_words_is_write(words):
    """Classify the argument words of a `git config` invocation (#5026 INV-6:
    config read/write). A substitution word is one opaque VALUE, so a flag
    inside `$(...)` never counts as a read flag but the word still counts as a
    value; redirects are dropped. True iff it names a remote.* key AND writes."""
    # A quoted-empty word (`""`, `''`, `$''`) is still a VALUE: `git config
    # remote.origin.url ""` writes an empty url (QA round 4).
    toks = ["VALUE" if ("$(" in t or "`" in t or (t and not bare(t))) else bare(t)
            for t in drop_redirects(words)]
    toks = [t for t in toks if t]
    key_idx = None
    for i, t in enumerate(toks):
        if REMOTE_KEY_TOKEN.fullmatch(t):
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

def config_is_write(rest):
    cmds = split_commands(rest)
    return config_words_is_write([w for _o, w in cmds[0]] if cmds else [])

# ---------------------------------------------------------------------------
# Loose tokenizer: the fail-closed backstop (#5026, QA round 3). It splits the
# command into simple commands with balanced $(...) / backtick / quote handling
# at ANY nesting depth, recursing into substitutions and into the quoted
# arguments of a shell (`bash -c "..."`, `eval '...'`). It only FINDS remote
# mutations; resolving their target is the strict parser's job.
# ---------------------------------------------------------------------------
def match_paren(text, j):
    """Index of the `)` balancing the `(` at text[j] (len(text) if unbalanced)."""
    d, i, n = 0, j, len(text)
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "'":
            k = text.find("'", i + 1)
            i = n if k < 0 else k + 1
            continue
        if c == '"':
            i = scan_dq(text, i, [])
            continue
        if c == "(":
            d += 1
        elif c == ")":
            d -= 1
            if d == 0:
                return i
        i += 1
    return n

def scan_dq(text, i, subs):
    """text[i] is `"`: return the index after its closing quote, recording each
    $(...) / backtick body inside it in subs as (offset, body)."""
    i += 1
    n = len(text)
    while i < n and text[i] != '"':
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == "$" and text[i + 1:i + 2] == "(":
            end = match_paren(text, i + 1)
            subs.append((i + 2, text[i + 2:end]))
            i = end + 1
            continue
        if c == "`":
            k = text.find("`", i + 1)
            k = n if k < 0 else k
            subs.append((i + 1, text[i + 1:k]))
            i = k + 1
            continue
        i += 1
    return i + 1

WORD_END = set(" \t;&|\n()")

def split_commands(text, base=0):
    """[[(offset, raw_word), ...], ...]: every simple command in text, the
    top-level ones first, then those nested inside substitutions."""
    cmds, nested, cur = [], [], []
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch in " \t":
            i += 1
            continue
        if ch in ";&|\n()":
            if cur:
                cmds.append(cur)
            cur = []
            i += 1
            continue
        if ch == "#":
            k = text.find("\n", i)
            i = n if k < 0 else k
            continue
        start, subs = i, []
        while i < n and text[i] not in WORD_END:
            c = text[i]
            if c == "\\":
                i += 2
            elif c == "'":
                k = text.find("'", i + 1)
                i = n if k < 0 else k + 1
            elif c == '"':
                i = scan_dq(text, i, subs)
            elif c in "$<>" and text[i + 1:i + 2] == "(":
                end = match_paren(text, i + 1)
                subs.append((i + 2, text[i + 2:end]))
                i = end + 1
            elif c == "`":
                k = text.find("`", i + 1)
                k = n if k < 0 else k
                subs.append((i + 1, text[i + 1:k]))
                i = k + 1
            elif c in "<>" and text[i + 1:i + 2] in ("&", "|"):
                i += 2
            else:
                i += 1
        word = text[start:min(i, n)]
        if word in ("{", "}"):
            if cur:
                cmds.append(cur)
            cur = []
        else:
            cur.append((base + start, word))
        for off, body in subs:
            nested.extend(split_commands(body, base + off))
    if cur:
        cmds.append(cur)
    return cmds + nested

ASSIGN = re.compile(r"^[A-Za-z_]\w*=")
# Words that may precede the real command word. After one of these, the first
# git token anywhere later in the simple command is taken as the command (so
# `timeout 5 git`, `command -p git`, `env -i X=1 git`, `nice -n 5 git` all match).
WRAPPERS = {
    "sudo", "doas", "command", "builtin", "env", "exec", "xargs", "time", "nohup",
    "timeout", "nice", "ionice", "stdbuf", "chrt", "taskset", "setsid", "unbuffer",
    "flock", "watch", "strace", "ltrace", "eatmydata", "chronic", "runuser",
    "then", "do", "else", "elif", "if", "while", "until", "!",
}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish", "eval", "su"}
GIT_VALUE_OPTS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"}

# Wrapper options that consume the NEXT word as their value (QA round 4), so
# `nice -n 5 git` / `sudo -u x git` / `xargs -n 1 echo` skip the value.
WRAPPER_VALUE_OPTS = {
    "-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t", "-n", "-I", "-L", "-P", "-s",
    "-d", "-E", "-a", "-k", "-c", "-S", "-o", "-e", "--user", "--group",
    "--signal", "--kill-after", "--adjustment", "--max-args", "--max-procs",
    "--replace", "--delimiter", "--arg-file", "--chdir", "--split-string",
}
# Wrappers whose single-letter flags above do NOT take a value.
WRAPPER_FLAG_ONLY = {
    "env": {"-i", "-0"}, "time": {"-p"}, "command": {"-p", "-v", "-V"},
    "exec": {"-c", "-l"}, "setsid": {"-f", "-w"}, "stdbuf": set(),
}
NUMERIC_ARG = re.compile(r"^(?:\d+(?:\.\d+)?[smhd]?|0x[0-9a-fA-F]+|[\d,-]+)$")

def command_word(raw):
    """Index of the command word of a simple command (QA round 4): skip
    leading VAR= assignments, then for each wrapper word skip its options
    (and a value-taking option's value), its env assignments and numeric
    positionals (`timeout 5`, `taskset 0x3`, `chrt 10`); the next word is the
    command (`xargs -n1 echo git remote add` -> `echo`, not `git`)."""
    i, n = 0, len(raw)
    while i < n and ASSIGN.match(raw[i]):
        i += 1
    while i < n and bare(raw[i]) in WRAPPERS:
        wrapper = bare(raw[i])
        flag_only = WRAPPER_FLAG_ONLY.get(wrapper, set())
        i += 1
        while i < n:
            w = bare(raw[i])
            if w == "--":
                i += 1
                break
            if w.startswith("-") and len(w) > 1:
                takes_value = w in WRAPPER_VALUE_OPTS and w not in flag_only
                i += 2 if takes_value else 1
            elif ASSIGN.match(w) or NUMERIC_ARG.match(w):
                i += 1
            else:
                break
    return i

def is_git(w):
    return os.path.basename(bare(w)) == "git"

def loose_mutations(text):
    """Offsets of every git token that starts a remote MUTATION, whatever its
    spelling (`/usr/bin/git`, `"git"`, `time git`, `git -p`, nested $(...))."""
    hits = []
    todo = [(0, text)]
    while todo:
        base, chunk = todo.pop()
        for words in split_commands(chunk, base):
            raw = [w for _o, w in words]
            # Quoted arguments of a shell / eval are programs: scan them too.
            if any(os.path.basename(bare(w)) in SHELLS for w in raw):
                for off, w in words:
                    for fm in re.finditer(r"\"([^\"]*)\"|'([^']*)'", w):
                        g = 1 if fm.group(1) is not None else 2
                        if fm.group(g):
                            todo.append((off + fm.start(g), fm.group(g)))
            i = command_word(raw)
            if i >= len(raw) or not is_git(raw[i]):
                continue
            k = i + 1
            while k < len(raw) and bare(raw[k]).startswith("-"):
                k += 2 if bare(raw[k]) in GIT_VALUE_OPTS else 1
            if k >= len(raw):
                continue
            sub, rest = bare(raw[k]), drop_redirects(raw[k + 1:])
            if sub == "remote":
                pos = [bare(w) for w in rest if not bare(w).startswith("-")]
                if pos and pos[0] in REMOTE_MUT_SUBCMDS:
                    hits.append(words[i][0])
            elif sub == "config" and config_words_is_write(rest):
                hits.append(words[i][0])
    return hits

# Every mutating invocation: (match start, GIT-prefix text).
mutations = [(m.start(), m.group(0)) for m in REMOTE_MUT.finditer(cmd)]
for m in CONFIG.finditer(cmd):
    if config_is_write(m.group(1)):
        mutations.append((m.start(), m.group(0)))
# FAIL-CLOSED backstop (#5026, QA round 3): the loose tokenizer runs
# UNCONDITIONALLY. A loose remote mutation that no strict match covers is one
# the strict parser could not resolve (a git spelling, wrapper, global flag or
# nesting depth outside its grammar), so it is denied whatever the cwd.
try:
    loose = loose_mutations(cmd)
except Exception as e:
    import sys
    print(f"git-remote-fence: loose tokenizer failed ({e!r}); using the regex fallback", file=sys.stderr)
    loose = [lm.start() for lm in re.finditer(
        r"\bgit\b[^\n]*?\b(?:remote\s+(?:" + "|".join(REMOTE_MUT_SUBCMDS)
        + r")|config\b[^\n]*\bremote\.)", cmd)]
if any(not any(ms <= off <= ms + len(mt) for ms, mt in mutations) for off in loose):
    print("DENY\nunparseable")
    raise SystemExit(0)

# ---------------------------------------------------------------------------
# TOKEN-PAIR BACKSTOP (#5026, QA round 4, operator-directed). A coarse text
# scan that needs no grammar: blank out every span the STRICT parser resolved
# (those are decided by is_protected below), decode $'...', drop quotes and
# backslashes, then — case-insensitively, over the whole remaining text with
# heredoc bodies already removed — look for
#   (a) a `git` word followed later by `remote` + a mutation verb, or
#   (b) a `git` word followed later by `config ... <remote.* key> ...` that
#       config_words_is_write classifies as a write.
# Any such phrase is denied fail-closed. This closes every "the git is not a
# command word" shape at once — `echo "git remote set-url o x" | sh`,
# `bash -s`, `<(...)`, `find . -exec/-execdir/-ok git remote add ...`,
# `parallel git remote ...`, `xargs ... git remote ...` — without enumerating
# wrappers. FALSE-POSITIVE TRADE-OFF (accepted): a command whose text merely
# MENTIONS such a phrase outside a heredoc — a `--body "..."` / `-m "..."`
# string, an `echo`, a `grep` pattern — is denied. Put such text in a file
# (`--body-file`, `-F`) or a heredoc.
# ---------------------------------------------------------------------------
BACKSTOP_REMOTE = re.compile(
    r"\bgit\b.*?\bremote\s+(?:-\S+\s+)*(?:" + "|".join(REMOTE_MUT_SUBCMDS) + r")(?![\w-])",
    re.I | re.S,
)
BACKSTOP_CONFIG = re.compile(r"\bgit\b.*?\bconfig\b([^;&|\n]*)", re.I | re.S)

def backstop_hit(text):
    for m in BACKSTOP_CONFIG.finditer(text):
        if config_words_is_write(m.group(1).split()):
            return True
    return bool(BACKSTOP_REMOTE.search(text))

# Blank the strictly-parsed spans (a strict config match already spans its
# whole argument segment; a strict remote match spans `git ... remote <verb>`).
masked = list(cmd)
for ms, mt in mutations:
    for k_ in range(ms, min(ms + len(mt), len(masked))):
        masked[k_] = " "
backstop_text = re.sub(r"[\"'\\]", "", decode_ansi_c("".join(masked)))
if backstop_hit(backstop_text):
    print("DENY\nbackstop")
    raise SystemExit(0)
hit = bool(mutations)

if not hit:
    print("ALLOW")
    raise SystemExit(0)
if not cwd:
    # A mutation with no session cwd to resolve against: cannot decide.
    print("ERROR")
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
    """(target word, guarded) of the last `cd` before pos whose group is still
    open at pos, or (None, False). `guarded` means a failing cd stops the git
    (`cd X && git ...`, `cd X || exit 1; git ...`); an unguarded `cd X; git`
    runs git in the PREVIOUS directory when X does not exist."""
    last = None
    for cm in CD.finditer(cmd[:pos]):
        d = DEPTHS[cm.end()]
        # `cd X | git ...` / `cd X & git ...`: the cd runs in a pipeline stage
        # or background job, not the shell that runs git. `cd X || ...` is NOT
        # skipped: the guarded-cd idiom (`cd X || exit 1; git ...`) runs git in X.
        if re.match(r"[ \t]*(?:\|(?!\|)|&(?!&))", cmd[cm.end():]):
            continue
        if min(DEPTHS[cm.end():pos + 1]) >= d:
            last = cm
    if last is None:
        return None, False
    guarded = bool(re.match(r"[ \t]*(?:&&|\|\|[ \t]*(?:exit|return)\b)", cmd[last.end():]))
    return last.group(1), guarded

def resolves_protected(c, base):
    if c is None:
        return None
    if not os.path.isabs(c):
        c = os.path.join(base, c)
    return os.path.realpath(c) == protected_real

_roots = None

def protected_roots():
    """Real paths of the protected repo's worktree roots: the main worktree
    (the gitdir's parent) plus every `git worktree list` entry of the
    protected gitdir (~/hydra, its .claude/worktrees/*, /dev/shm/hydra-worktrees/*)."""
    global _roots
    if _roots is None:
        roots = {os.path.dirname(protected_real)}
        out = subprocess.run(
            ["git", "--git-dir", protected_real, "worktree", "list", "--porcelain"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0:
            for line in out.stdout.splitlines():
                if line.startswith("worktree "):
                    roots.add(os.path.realpath(line[len("worktree "):]))
        _roots = roots
    return _roots

def under_protected(path):
    """Path decision for a LITERAL target that is not (yet) a repo: is it the
    protected gitdir or inside one of its worktree roots?"""
    rp = os.path.realpath(path)
    if rp == protected_real or rp.startswith(protected_real + os.sep):
        return True
    return any(rp == r or rp.startswith(r + os.sep) for r in protected_roots())

def is_protected(pos, prefix):
    """Resolve the EFFECTIVE repo of one mutating git invocation: the last
    in-scope literal `cd <dir>`, then `git -C <dir>` chain, then --git-dir /
    GIT_DIR=. An UNRESOLVED value (`$VAR`, `$(...)`, backtick — the
    empty-seam-var incident shape) falls back to the previous directory,
    exactly as the shell does for an empty value, and an unresolved effective
    repo that is not a repo falls back to the SESSION CWD (INV-2: unresolvable
    never allows). A LITERAL target that is not (yet) a repo — `git init /tmp/x
    && cd /tmp/x && git remote add ...` — is decided BY PATH: protected iff it
    lies under the protected repo's worktree roots (QA round 4). Exception: an
    UNGUARDED `cd <missing dir>; git ...` runs git in the previous directory,
    so the session cwd is checked too."""
    eff = cwd
    literal_target = False
    cd_may_fail_open = False
    last_cd, guarded = effective_cd(pos)
    if last_cd and literal(last_cd):
        eff = os.path.join(eff, literal(last_cd))
        literal_target = True
        cd_may_fail_open = not guarded and not os.path.isdir(eff)
    for cm in OPT_C.finditer(prefix):
        v = literal(cm.group(1))
        if v:
            eff = os.path.join(eff, v)
            literal_target = True
    gd = OPT_GITDIR.search(prefix) or ENV_GITDIR.search(prefix)
    gd_val = literal(gd.group(1)) if gd else None
    if gd_val:
        target = os.path.join(eff, gd_val)
        literal_target = True
        res = resolves_protected(common_dir(["--git-dir", target]), target)
    else:
        target = eff
        res = resolves_protected(common_dir(["-C", eff]), eff)
    if res is not None:
        return res
    cwd_res = bool(resolves_protected(common_dir(["-C", cwd]), cwd))
    if not literal_target:
        return cwd_res
    return under_protected(target) or (cd_may_fail_open and cwd_res)

try:
    print("DENY\nprotected" if any(is_protected(p_, t_) for p_, t_ in mutations) else "ALLOW")
except SystemExit:
    raise
except Exception:
    # Internal analysis error AFTER a mutation was positively identified (git
    # missing, timeout, a bug): never ALLOW — fail closed AND fail loud.
    import sys, traceback
    print("git-remote-fence: internal error resolving a remote mutation:", file=sys.stderr)
    traceback.print_exc(file=sys.stderr)
    print("ERROR")
PY
)

case "${VERDICT%%$'\n'*}" in
  ALLOW) exit 0 ;;
  DENY) KIND="${VERDICT#*$'\n'}" ;;
  *) KIND="error" ;;  # ERROR, empty (python crashed / missing) or unexpected
esac

if [ "$KIND" = "error" ]; then
  REASON="git-remote-fence: analysis failed on a command mentioning remote/config — denied fail-closed; run it by hand if intended. (The fence's python analysis crashed, was unavailable, or returned no usable verdict, so it cannot prove this command leaves the remotes of the orchestrator gitdir /home/gabe/hydra/.git alone — issues #4939/#5026.)"
elif [ "$KIND" = "backstop" ]; then
  REASON="git-remote-fence: remote-mutation phrase in command text — denied fail-closed; run it by hand if intended. Outside a heredoc, this Bash command's text contains a 'git ... remote set-url|add|remove|rm|rename|set-head|set-branches|prune' phrase or a 'git ... config' write to a remote.* key that the fence could not resolve to a plain 'git [-C <literal dir>] remote ...' invocation of a non-orchestrator repo (e.g. it is piped to a shell, run via find -exec / xargs / parallel / bash -s / <(...), or quoted inside another command), so it cannot prove the target is not the orchestrator gitdir /home/gabe/hydra/.git (issues #4939/#5026). If the phrase is only TEXT (a --body / -m string, an echo, a grep pattern), move it into a file (--body-file, -F) or a heredoc; if it is a real command for another repo, run it as a plain 'git -C <literal dir> remote ...'."
elif [ "$KIND" = "unparseable" ]; then
  REASON="git-remote-fence: unparseable remote mutation — denied fail-closed; run it by hand if intended. This Bash command mutates a git remote (git remote set-url|add|remove|rm|rename|set-head|set-branches|prune, or a git config write to remote.*) in a form the fence cannot resolve to a target repo (a git path/quoting/wrapper such as /usr/bin/git, \"git\", time/nohup/timeout/command -p, a global flag such as -p/-P/--no-pager, or deeply nested \$(...)), so it cannot prove the target is not the orchestrator gitdir /home/gabe/hydra/.git (issue #4939). Rewrite it as a plain 'git [-C <literal dir>] remote ...' if it is meant for another repo. Reads (git remote -v, git remote get-url, git config --get remote.origin.url) are allowed."
else
REASON="git-remote-fence: refusing this Bash command — it mutates a git remote (git remote set-url|add|remove|rm|rename|set-head|set-branches|prune, or git config remote.*) while the session cwd belongs to the orchestrator gitdir /home/gabe/hydra/.git, which every ~/hydra worktree shares (issue #4939: an empty \$TARGET_WS made 'cd \"\$TARGET_WS\" && git remote set-url origin <target>' rewrite ~/hydra's origin and prune origin/master). Never correct a remote. If 'git remote -v' / 'git fetch' shows the ORCHESTRATOR remote where the Target was expected, the seam var is empty: STOP and re-run the target-seam preamble in THIS Bash call. Reads (git remote -v, git remote get-url, git config --get remote.origin.url) are allowed."
fi

printf '%s\n' "$REASON" >&2
# The deny JSON must not depend on python (it may be what just failed): escape
# backslashes, then double quotes, in pure bash. REASON holds no control chars.
ESC=${REASON//\\/\\\\}
ESC=${ESC//\"/\\\"}
printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "%s"}}\n' "$ESC" >&2
exit 2
