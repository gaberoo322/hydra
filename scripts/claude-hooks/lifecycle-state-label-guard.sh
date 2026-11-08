#!/usr/bin/env bash
# lifecycle-state-label-guard.sh — PreToolUse hook that DENIES a Bash command
# which writes a lifecycle STATE label on a GitHub issue by hand (ADR-0047
# Decision 3 / Decision 7, issue #5322). State labels move only through the
# lifecycle writer seam:
#   npx tsx scripts/lifecycle.ts advance <issue> <to> [--evidence k=v] [--reason R --rationale T]
#
# This hook is the "deny hook" half of ADR-0047 D7 enforce precondition 2 (the
# other half is the lint baseline at zero). It is LIVE in BOTH shadow and
# enforce: it never reads the rollout switch.
#
# DENIES, in one shell segment (after the sibling gh-label-delete-guard.sh
# pipeline: heredoc-body stripping, backslash-continuation collapse, leading
# `NAME=value` / export / declare / local / printf -v / read <<< / set --
# resolution, and quote-aware shlex segmentation — copied verbatim, do not
# re-invent it):
#   (a) `gh issue edit` / `gh issue create` whose `--add-label` /
#       `--remove-label` / `--label` / `-l` operand (comma-split, quotes
#       stripped, `--flag=value` or `--flag value`) contains any of the 13
#       lifecycle states;
#   (b) a MUTATING `gh api` (POST/PUT/PATCH/DELETE, including the implicit
#       POST of -f/-F/--field/--raw-field/--input) against
#       `issues/<n>/labels` whose payload (`labels[]=`, `name=`, raw JSON)
#       names a state, or whose trailing `/labels/<name>` path segment is one.
# ALLOWS: every flag label (glm-eligible, needs-design-concept, enhancement,
# conflict-fix-attempted, provenance, keep-open, target-backlog, wayfinder:*),
# read verbs (`gh issue list --label ready-for-agent`, `gh issue view`),
# `gh pr edit` (PR labels are flags, ADR-0047 D2), an unresolvable `$VAR`
# operand (fail open — the doc lint owns docs), `gh issue edit|create --repo
# <anything other than gaberoo322/hydra>` (the Target board is outside the
# seam; an unresolved `--repo "$VAR"` fails open too), comments/echo mentions,
# `npx tsx scripts/lifecycle.ts ...`, and `bash scripts/autopilot/
# recover-stale.sh` (inner commands are not inspected; #5318 migrates them).
#
# Vocabulary: the embedded state list below is pinned to OPEN_STATES in
# src/lifecycle/transitions.ts by test/lifecycle-state-label-guard.test.mts
# (set-equality, regex-extracted between the BEGIN/END markers). The hook
# never imports TS: a Node startup per Bash call would blow the budget.
#
# Fail-open on malformed stdin / non-Bash tool / empty command. Fail-closed
# (exit 2) when the raw text mentions both a state name and "label" and the
# python machinery crashed (#4745 pattern). Exit codes: 0 and 2 only.
#
# Deny payload: stderr JSON hookSpecificOutput.permissionDecision="deny",
# exit 2. Performance: pure string/regex work, no network/git/Redis IO.

set -euo pipefail

INPUT=$(cat)

# LIFECYCLE_STATES_BEGIN
LIFECYCLE_STATES=(
  "needs-triage"
  "needs-info"
  "needs-research"
  "hitl-grill"
  "needs-tickets"
  "ready-for-agent"
  "blocked"
  "in-progress"
  "needs-dev-resume"
  "needs-qa"
  "qa-passed"
  "ready-for-human"
  "parked"
)
# LIFECYCLE_STATES_END

# Coarse SUSPECT flag (#4745): raw stdin mentions "label" and any state name.
# A deliberate superset of the precise verdict, used only to decide whether a
# machinery failure fails CLOSED.
SUSPECT=0
shopt -s nocasematch
if [[ "$INPUT" == *label* ]]; then
  for s in "${LIFECYCLE_STATES[@]}"; do
    if [[ "$INPUT" == *"$s"* ]]; then
      SUSPECT=1
      break
    fi
  done
fi
shopt -u nocasematch

fail_closed() {
  trap - ERR
  if [ "$SUSPECT" = 1 ]; then
    echo "lifecycle-state-label-guard: internal error while inspecting a command that looks like a lifecycle state-label write; failing closed (exit 2). Use: npx tsx scripts/lifecycle.ts advance <issue> <to> [--evidence k=v] [--reason R --rationale T]" >&2
    exit 2
  fi
  exit 0
}
trap fail_closed ERR

TOOL=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_name",""))
except Exception:
  print("")' 2>/dev/null)

if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

COMMAND=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception:
  print("")' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

export LIFECYCLE_GUARD_CMD="$COMMAND"
export LIFECYCLE_GUARD_STATES="${LIFECYCLE_STATES[*]}"
VERDICT=$(python3 - <<'PY' 2>/dev/null
import os
import re
import shlex

cmd = os.environ.get("LIFECYCLE_GUARD_CMD", "")
STATES = set(os.environ.get("LIFECYCLE_GUARD_STATES", "").split())

# Issue #5401: a heredoc BODY is data, not shell, but its quote characters
# would still drive shlex's quote state below and can merge two later
# statements into one segment (false DENY of the #5058 label hand-back
# recipe). Strip every body (operator line kept verbatim, body lines through
# the terminator line removed) BEFORE the continuation collapse, variable
# resolution and shlex segmentation. `<<<` here-strings are never heredocs
# (#4728 `read NAME <<< value`). An unterminated heredoc returns the text
# unchanged (fail open to the pre-#5401 pipeline). A heredoc fed to an
# interpreter (bash/sh/python/ssh/eval/source/xargs) is NOT stripped. Known gaps (out of scope,
# #4728 "accidental misuse, not obfuscation"): a `<<WORD` inside a quoted
# string on an operator line plus a later bare `WORD` line; `$(gh api -X
# DELETE ...)` inside an unquoted body.
HEREDOC_OP = re.compile(r"(?<!<)<<(?!<)(-)?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_.-]*)\2")
# A body fed to an interpreter (bash <<'EOF', python <<EOF, ssh host <<EOF,
# xargs sh -c, eval, source) is EXECUTED code, not data: never strip it, so a
# collection DELETE inside it is still inspected (QA round 1, high finding).
_INTERP = r"(?:bash|sh|zsh|dash|ksh|python[0-9.]*|node|perl|ruby|ssh|eval|source|xargs)"
# Receiver BEFORE the operator; a path prefix (/bin/bash) counts (QA round 2).
INTERP_RECV = re.compile(r"(?:^|[\s;&|(/])" + _INTERP + r"(?:\s|$)")
# Receiver AFTER the operator: `cat <<'EOF' | bash` pipes the body into an
# interpreter, so it is executed code too (QA round 2, high finding).
# Inverted, fail-toward-not-stripping (QA round 4): ANY interpreter word after
# the pipe, before the next `;`/`&`/`|`, keeps the body -- so `| sudo bash`,
# `| (bash)`, `| { bash; }`, `| nohup/timeout/exec/command bash` all count.
# A non-interpreter sink (`| tee f`, `| tee bash.log`) is still stripped.
INTERP_PIPE = re.compile(r"\|&?[^\n;&|]*?(?<![\w.-])" + _INTERP + r"(?![\w.-])")


def _strip_heredoc_bodies(text):
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        for m in HEREDOC_OP.finditer(line):
            if INTERP_RECV.search(line[: m.start()]) or INTERP_PIPE.search(line[m.end():]):
                break  # executed body: keep it for segmentation
            dash, word = m.group(1), m.group(3)
            while True:
                if i >= len(lines):
                    return text  # unterminated: fail open, unchanged
                body = lines[i]
                i += 1
                if (body.lstrip("\t") if dash else body) == word:
                    break
    return "\n".join(out)


cmd = _strip_heredoc_bodies(cmd)

# Collapse shell line-continuations (a backslash immediately followed by a
# newline) to a single space BEFORE segment-splitting — this is what the
# shell itself does before executing the command. Without this, a
# perfectly ordinary backslash-continued multi-line `gh api` call
# ("gh api .../labels \" + newline + "-X DELETE ...") would split the URL
# and the method flag into two separate segments below (the bare `\n`
# alone is still a segment separator, matching `;`/`&&`/`|`), and METHOD +
# COLLECTION would never be seen co-occurring in the same segment.
cmd = re.sub(r"\\\n", " ", cmd)

# --- Resolve simple `VAR=value` assignments (assign-then-reference) ---
# QA-4698 second re-review: an ordinary shell habit —
#   URL="repos/o/r/issues/42/labels"; gh api "$URL" -X DELETE
#   L=labels; gh api issues/42/$L -X DELETE
# — puts the assignment and the reference in different top-level
# statements. A pure per-segment text match never sees METHOD and
# COLLECTION co-occur because the literal `/labels` text sits in the
# assignment's segment, not the `-X DELETE` segment. Fix: walk each
# top-level statement (split the same way the shell parses simple-command
# lists) and peel off any LEADING `NAME=value` prefix assignments — the
# only shell construct that actually creates a variable binding for the
# rest of the command — into an env map, then substitute `$NAME`/`${NAME}`
# references throughout the whole command text before segmenting for the
# METHOD/COLLECTION check below. This only recognizes literal values (a
# quoted or bare word with no shell operators in it); it does not attempt
# command substitution or evaluate anything.
STMT_SPLIT = re.compile(r"(?:&&|\|\||;|\||\n)")
# QA-4698 third re-review (Spec false-negative): `export ` is at least as
# ordinary a habit as the bare `NAME=value` form already handled below, so
# the leading-assignment match must tolerate an optional `export ` prefix
# (the statement still creates the same variable binding for the rest of
# the command either way).
#
# Issue #4728 extends the SAME recognition point to every other ordinary
# declaration habit — each creates the same kind of binding for the rest of
# the command, so each must feed the ONE `assigned` table below (no second
# substitution path):
#   - the declaration keywords export/declare/readonly/typeset/local, each
#     with any flags (`declare -x URL=...`), optionally preceded by a
#     compound-command body opener (`name() {`, `function name {`, `{`,
#     `(`) so a one-line function/subshell/brace body binds too;
#   - `printf -v NAME <fmt>` (a fmt carrying a % conversion writes something
#     other than its own text, so it binds nothing — except an exact `%s`
#     fmt, which binds its first argument);
#   - `read [-flags] NAME <<< <value>` (here-string only);
#   - `set -- <args>` (positional parameters `$1`..`$n` and `$@`/`$*`, #4877).
# Recognition stays anchored at the START of a top-level statement (after
# the optional opener), so a keyword appearing mid-statement (`echo local
# URL=x`) matches nothing and creates no binding.
ASSIGN_OPENER = (
    r"(?:(?:function\s+)?[\w.-]+\s*\(\s*\)\s*\{|function\s+[\w.-]+\s*\{|\{|\()"
)
ASSIGN_KEYWORD = r"(?:export|declare|readonly|typeset|local)\s+(?:-\w+\s+)*"
ASSIGN_VALUE = r"(\"[^\"\n]*\"|'[^'\n]*'|[^\s]*)"
LEADING_ASSIGN = re.compile(
    r"^\s*(?:" + ASSIGN_OPENER + r"\s*)?(?:" + ASSIGN_KEYWORD + r")?"
    r"([A-Za-z_][A-Za-z0-9_]*)=" + ASSIGN_VALUE + r"\s*"
)
LEADING_PRINTF = re.compile(
    r"^\s*(?:" + ASSIGN_OPENER + r"\s*)?printf\s+(?:-\w+\s+)*-v\s+"
    r"([A-Za-z_][A-Za-z0-9_]*)\s" + ASSIGN_VALUE + r"(?:\s+" + ASSIGN_VALUE + r")?"
)
LEADING_READ = re.compile(
    r"^\s*(?:" + ASSIGN_OPENER + r"\s*)?read\s+(?:-\w+\s+)*"
    r"([A-Za-z_][A-Za-z0-9_]*)\s*<<<\s*(\"[^\"\n]*\"|'[^'\n]*'|[^\s;&|]+)"
)
# `set -- a b c` rebinds the positional parameters from scratch, so a later
# `set --` (or a bare `set --`) replaces any earlier positional bindings:
# the numeric and `@`/`*` keys are dropped before the new words are recorded.
LEADING_SET_ARGS = re.compile(
    r"^\s*(?:" + ASSIGN_OPENER + r"\s*)?set\s+--\s*(.*)$", re.S
)
VAR_REF = re.compile(r"\$\{(\w+|[@*])\}|\$(\w+|[@*])")


def _strip_quotes(s):
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


def _is_literal(value):
    # Issue #4728: only LITERAL values feed `assigned`. Command substitution
    # (`$(...)`, backticks), arithmetic `$((...))` (a `$(` superset) and
    # array `(...)` values are not literals — their raw text is never
    # substituted into the command; the binding is skipped (fail open),
    # matching this hook's never-wedge contract.
    return not (value.startswith("(") or "$(" in value or "`" in value)


def _split_words(text):
    # Quote-aware whitespace split for `set --` args. Returns None on
    # unbalanced quotes: no positional bindings at all, rather than a
    # partial mapping that would shift `$2` onto the wrong word.
    words, cur, quote = [], [], None
    for ch in text:
        if quote:
            if ch == quote:
                quote = None
            else:
                cur.append(ch)
        elif ch in "\"'":
            quote = ch
        elif ch.isspace():
            if cur:
                words.append("".join(cur))
                cur = []
        else:
            cur.append(ch)
    if quote is not None:
        return None
    if cur:
        words.append("".join(cur))
    return words


assigned = {}
for stmt in STMT_SPLIT.split(cmd):
    rest = stmt
    while True:
        # Each recognised form CONSUMES its match (rest strictly shrinks —
        # every alternative requires at least `keyword` or `NAME=`), so the
        # peel loop always terminates; an unrecognised statement breaks out.
        m = LEADING_SET_ARGS.match(rest)
        if m:
            for k in [k for k in assigned if k.isdigit() or k in ("@", "*")]:
                del assigned[k]
            words = _split_words(m.group(1))
            if words is not None and all(_is_literal(w) for w in words):
                for i, w in enumerate(words):
                    assigned[str(i + 1)] = w
                if words:
                    # Issue #4877: `$@`/`$*` (bare, quoted or braced) resolve
                    # to the space-joined words through the same table.
                    assigned["@"] = assigned["*"] = " ".join(words)
            rest = rest[m.end():]
            continue
        m = LEADING_PRINTF.match(rest)
        if m:
            value = _strip_quotes(m.group(2))
            # A format carrying a % conversion does not write its own text
            # into NAME, so it binds nothing (fail open).
            if "%" not in value and _is_literal(value):
                assigned[m.group(1)] = value
            elif value == "%s" and m.group(3) is not None:
                # The canonical `printf -v NAME '%s' <path>` form: an exact
                # `%s` format writes its first argument verbatim.
                arg = _strip_quotes(m.group(3))
                if _is_literal(arg):
                    assigned[m.group(1)] = arg
            rest = rest[m.end():]
            continue
        m = LEADING_READ.match(rest)
        if m:
            value = _strip_quotes(m.group(2))
            if _is_literal(value):
                assigned[m.group(1)] = value
            rest = rest[m.end():]
            continue
        m = LEADING_ASSIGN.match(rest)
        if not m:
            break
        value = _strip_quotes(m.group(2))
        if _is_literal(value):
            assigned[m.group(1)] = value
        rest = rest[m.end():]

# QA-4698 third re-review (Spec false-negative): the pass above captures
# each variable's RAW, unresolved value (e.g. `URL` bound to the literal
# text `"$BASE/labels"`), so a single substitution pass over `cmd` below
# would replace `$URL` with that still-unresolved text instead of the
# fully-resolved path. Resolve `assigned` against itself to a fixed point
# first — bounded to `len(assigned) + 1` iterations so a reference cycle
# (`A=$B; B=$A`) can't loop forever — so a two-hop (or deeper) chain like
# `BASE=...; URL="$BASE/labels"` sees `$BASE` substituted into `URL`'s
# value before `cmd` itself is substituted.
if assigned:
    for _ in range(len(assigned) + 1):
        changed = False
        next_assigned = {}
        for name, val in assigned.items():
            new_val = VAR_REF.sub(
                lambda m: assigned.get(m.group(1) or m.group(2), m.group(0)),
                val,
            )
            if new_val != val:
                changed = True
            next_assigned[name] = new_val
        assigned = next_assigned
        if not changed:
            break

    cmd = VAR_REF.sub(
        lambda m: assigned.get(m.group(1) or m.group(2), m.group(0)),
        cmd,
    )


# --- Segment the (variable-resolved) command into TOKEN LISTS, quote-aware.
# Same shlex punctuation_chars configuration as the sibling (newline is its
# own separator token); returns [] on unbalanced quotes (fail open).
def _segments(text):
    try:
        lex = shlex.shlex(text, posix=True, punctuation_chars="();<>|&\n")
        lex.whitespace = lex.whitespace.replace("\n", "")
        lex.whitespace_split = True
        tokens = list(lex)
    except ValueError:
        return []
    sep_tokens = {"&&", "||", ";", "|", "&", "\n"}
    segments = []
    current = []
    for tok in tokens:
        if tok in sep_tokens:
            segments.append(current)
            current = []
        else:
            current.append(tok)
    segments.append(current)
    return segments


STATE_WORD = re.compile(
    r"(?<![\w-])(" + "|".join(re.escape(s) for s in sorted(STATES, key=len, reverse=True)) + r")(?![\w-])"
) if STATES else None
ASSIGN_TOKEN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
LABEL_FLAGS = ("--add-label", "--remove-label", "--label", "-l")
BODY_FLAGS = ("-f", "-F", "--field", "--raw-field", "--input")
MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


def _state_in_operand(operand):
    for part in operand.split(","):
        if part.strip().strip("\"'") in STATES:
            return part.strip().strip("\"'")
    return None


HYDRA_REPO = "gaberoo322/hydra"


def _other_repo(args):
    # A `--repo`/`-R` operand naming something other than the Orchestrator repo
    # (the Target board, or an unresolvable $VAR) is outside the lifecycle seam:
    # allow (fail open). A bare command defaults to this repo and is inspected.
    for i, tok in enumerate(args):
        val = None
        if tok in ("--repo", "-R") and i + 1 < len(args):
            val = args[i + 1]
        elif tok.startswith("--repo="):
            val = tok[len("--repo="):]
        if val is not None:
            return val.strip("\"'") != HYDRA_REPO
    return False


def _issue_label_state(args):
    # `gh issue edit|create`: scan label-flag operands.
    if _other_repo(args):
        return None
    for i, tok in enumerate(args):
        for flag in LABEL_FLAGS:
            operand = None
            if tok == flag and i + 1 < len(args):
                operand = args[i + 1]
            elif tok.startswith(flag + "="):
                operand = tok[len(flag) + 1:]
            elif flag == "-l" and tok.startswith("-l") and len(tok) > 2 and not tok.startswith("--"):
                operand = tok[2:]
            if operand is not None:
                hit = _state_in_operand(operand)
                if hit:
                    return hit
    return None


def _api_label_state(args):
    # `gh api`: mutating call against issues/<n>/labels naming a state.
    path = None
    for tok in args:
        if re.search(r"issues/[^/\s]+/labels", tok):
            path = tok
            break
    if path is None:
        return None
    method = None
    implicit_post = False
    for i, tok in enumerate(args):
        if tok in ("-X", "--method", "--request") and i + 1 < len(args):
            method = args[i + 1].upper()
        elif tok.startswith("--method=") or tok.startswith("--request="):
            method = tok.split("=", 1)[1].upper()
        elif tok.startswith("-X") and len(tok) > 2:
            method = tok[2:].upper()
        elif tok in BODY_FLAGS or any(tok.startswith(f + "=") for f in BODY_FLAGS if f.startswith("--")):
            implicit_post = True
    if method is None:
        method = "POST" if implicit_post else "GET"
    if method not in MUTATING:
        return None
    m = re.search(r"issues/[^/\s]+/labels/([^/\s?#]+)", path)
    if m:
        from urllib.parse import unquote
        name = unquote(m.group(1))
        if name in STATES:
            return name
    if STATE_WORD is not None:
        for tok in args:
            if tok is path:
                continue
            hit = STATE_WORD.search(tok)
            if hit:
                return hit.group(1)
    return None


offending = None
for seg in _segments(cmd):
    toks = list(seg)
    while toks and ASSIGN_TOKEN.match(toks[0]):
        toks.pop(0)
    if len(toks) < 3 or toks[0] != "gh":
        continue
    if toks[1] == "issue" and toks[2] in ("edit", "create"):
        offending = _issue_label_state(toks[3:])
    elif toks[1] == "api":
        offending = _api_label_state(toks[2:])
    if offending:
        break

if offending is None:
    print("ALLOW")
else:
    print("DENY")
    print(offending)
PY
)

VERDICT_LINE=${VERDICT%%$'\n'*}

case "$VERDICT_LINE" in
  ALLOW) exit 0 ;;
  DENY) ;;
  *) fail_closed ;;
esac

STATE_NAME="unknown"
if [[ "$VERDICT" == *$'\n'* ]]; then
  REST=${VERDICT#*$'\n'}
  STATE_NAME=${REST%%$'\n'*}
fi

REASON="lifecycle-state-label-guard: refusing this Bash command — it writes the lifecycle STATE label '${STATE_NAME}' directly on a GitHub issue. State labels move only through the lifecycle writer seam (ADR-0047 D3), which journals the transition and enforces the table: npx tsx scripts/lifecycle.ts advance <issue> <to> [--evidence k=v] [--reason R --rationale T]. A refusal from the CLI is final — do not fall back to gh. Flag labels (glm-eligible, needs-design-concept, enhancement, provenance, ...) and 'gh pr edit' labels are unaffected."

trap - ERR
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
