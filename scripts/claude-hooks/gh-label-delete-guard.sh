#!/usr/bin/env bash
# gh-label-delete-guard.sh — PreToolUse hook that blocks a Bash `gh api` /
# `curl` DELETE against the GitHub issue *labels collection* endpoint
# (`.../issues/<n>/labels`), which silently removes EVERY label on the issue.
# The single-label form puts the name in the URL PATH
# (`.../issues/<n>/labels/<name>`) and is always allowed.
#
# Background — issue #4654 (3 hits across 2 classes, 2026-09-04 / 2026-09-23).
# Agents removing one label keep reaching for
#   gh api repos/gaberoo322/hydra/issues/<n>/labels -X DELETE -f name=<label>
# That hits the COLLECTION endpoint — any method against
# `issues/<n>/labels` with no trailing `/<name>` segment removes ALL labels —
# instead of the path form. The wipe is silent (exit 0) and can drop routing
# labels (`glm-ab-control`, `design-concept-exempt`, `money-critical`)
# unnoticed. The sanctioned path is `gh issue edit --remove-label`
# (docs/operator-playbooks/_fragments/hydra-dev-parent-flow.md), but agents
# are also steered toward raw REST under GraphQL-quota pressure and guess the
# wrong endpoint shape.
#
# This hook fires on every Bash tool call. It DENIES a call when a single
# shell segment (the command text, quote-aware tokenized and split on `&&`,
# `||`, `;`, `|`, newline, after collapsing backslash line-continuations to
# a space and resolving simple `VAR=value` assignments — see below) carries
# BOTH:
#   1. a DELETE HTTP method — `-X DELETE`, `-XDELETE`, `--method DELETE`,
#      `--method=DELETE`, `--request DELETE`, `--request=DELETE`
#      (case-insensitive), and
#   2. a reference to `issues/<n>/labels` with NO trailing `/<name>` segment
#      (bare `/labels`, or `/labels/` followed by whitespace/quote/`?`/`#`/EOL).
#
# Both `gh api` (`-X`/`--method`) and raw `curl` (`-X`/`--request` — curl has
# no `--method` flag) forms are covered because the rule matches command
# TEXT, not the binary. The single-label PATH form
# (`issues/<n>/labels/<name>`, any spelling incl. `$VAR`/`${VAR}`) is ALWAYS
# allowed — docs/operator-playbooks/hydra-target-sweep.md L126 relies on it —
# as is `gh issue edit --remove-label`, GET/POST/PUT on the collection, and a
# repo-level `repos/o/r/labels/<name>` delete.
#
# A backslash-continued multi-line command (`gh api ... \` + newline +
# `-X DELETE ...`) is collapsed to a single line BEFORE segment-splitting —
# matching what the shell itself does before executing the command — so the
# URL and method flag still land in the same segment instead of being split
# apart by treating the bare `\n` as an independent separator.
#
# QA-4698 (second re-review, both independently-verified hard blockers):
# a raw-text split on `;`/`&&`/`||`/`|` has no shell-quote or variable
# awareness, so (a) assign-then-reference — `URL="…/labels"; gh api "$URL"
# -X DELETE` or `L=labels; gh api issues/42/$L -X DELETE` — puts the
# collection reference and the method flag in different segments, and
# (b) a quoted `;`/`|` inside an ordinary data flag — `curl -X DELETE -d
# 'note=a;b' .../labels` — gets treated as a real separator, splitting a
# genuine collection DELETE into fake "segments" that never co-occur. Both
# are closed the same way: (a) walk each top-level statement, peel off any
# LEADING `NAME=value` prefix assignment into an env map, and substitute
# `$NAME`/`${NAME}` throughout the command before segmenting; (b) segment
# with `shlex` in `punctuation_chars` mode instead of a raw-text regex
# split, so quoted text (including a `;`/`|` inside it) tokenizes as a
# single word instead of a false separator. An unparseable command
# (unbalanced quotes) fails open — no segments are inspected — rather than
# guessing.
#
# QA-4698 (third re-review, one Standards false-positive + one Spec
# false-negative, both independently confirmed by direct execution):
# (a) [false-positive DENY] `_segments()`'s shlex tokenizer never treated a
# bare newline as a separator (shlex's default `punctuation_chars=True` set
# doesn't include `\n`, and a bare `\n` is otherwise just whitespace to
# it), so a two-STATEMENT command with no `&&`/`;` between the lines —
# e.g. a sanctioned single-label path-form DELETE on line 1 followed by a
# benign collection GET on line 2 — merged into ONE segment, and the
# method flag from line 1 falsely co-occurred with the bare collection
# reference from line 2. Fixed by passing shlex an explicit
# `punctuation_chars` string with `\n` appended (and excluding `\n` from
# `lex.whitespace`) so a bare newline outside quotes tokenizes as its own
# separator token, matching `STMT_SPLIT`'s separator set used for the
# variable-resolution pass. (b) [false-negative ALLOW] two gaps in the
# variable-resolution pass: `LEADING_ASSIGN` required the statement to
# start directly with `NAME=`, so an `export NAME=value` prefix (at least
# as ordinary a habit as the bare form) was never captured; and the
# resolution was single-pass, so a two-hop chain (`BASE=...;
# URL="$BASE/labels"`) captured `URL`'s value as the raw, unresolved text
# `"$BASE/labels"` and substituted that unresolved text into the command
# rather than the fully-resolved path. Fixed by (i) making `LEADING_ASSIGN`
# tolerate an optional `export ` prefix, and (ii) resolving the `assigned`
# table against itself to a fixed point (bounded by `len(assigned) + 1`
# iterations so a reference cycle can't loop forever) before substituting
# into the command text.
#
# Issue #4728 (follow-up to PR #4698's round-4 QA, both reviewers, directly
# executed): the leading-assignment pass recognised only bare and
# `export`-prefixed `NAME=value` bindings, so equally ordinary declaration
# habits let a collection DELETE through as ALLOW — `declare [-x] URL=...`,
# `readonly URL=...`, `typeset URL=...`, `local URL=...` (incl. inside a
# `name() {` / `function name {` / `{` / `(` body opener), `printf -v URL
# '...'`, `read [-flags] URL <<< '...'` (here-string only), and `set --
# <args>` positional bindings (`$1`..`$n`). All of them now feed the SAME
# `assigned` table consumed by the existing fixed-point resolution +
# substitution — there is no second substitution path. Recognition stays
# anchored at the START of a top-level statement (after the optional
# compound-command opener), so a keyword appearing mid-statement (`echo
# local URL=x`) creates no binding and resolution cannot introduce new
# false-positive DENYs on unrelated commands. Only LITERAL values are
# captured (quoted or bare word): command substitution (`$(...)`,
# backticks), arithmetic `$((...))`, array `(...)` values, and a printf
# format carrying a % conversion bind nothing (fail open) — raw
# non-literal text is never substituted into the command. A keyword with
# no `=` assignment (`declare -p URL`, `local x`, `readonly URL`) is a
# no-op, not an error and not a binding.
#
# Out of scope (issue #4728 AC escape clause, operator decision
# 2026-09-28: the guard targets accidental misuse, not adversarial
# obfuscation): function-call positional args (`f() { gh api -X DELETE
# "$1"; }; f <url>` — the call site creates no binding the guard can
# attribute), the multi-name `read A B <<< v` form (only the single-name
# form is recognised), and the `read ... << EOF` heredoc form.
#
# Known gap: this hook is registered only in THIS repo's `.claude/settings.json`
# via the absolute path `/home/gabe/hydra/scripts/claude-hooks/gh-label-delete-guard.sh`,
# so it does not fire for a session whose cwd is `~/hydra-betting` (a separate
# repo with its own `.claude/settings.json`) even though the same collection-
# endpoint footgun applies there too.
#
# Fail-open (issue #4654 design-concept INV-3): missing/malformed stdin JSON,
# a non-Bash tool_name, or an empty tool_input.command exits 0 silently —
# this hook must never wedge an unrelated Bash call.
#
# Deny payload format (per claude-code hook contract, matching
# worktree-write-fence.sh):
#   stderr: JSON with hookSpecificOutput.permissionDecision="deny"
#   exit:   2
#
# Fail-closed (issue #4745): if python3 breaks (nonzero exit, garbled verdict)
# on a command whose raw text mentions both "delete" and "/labels", the hook
# exits 2 instead of silently allowing; other commands still fail open. Exit
# codes are limited to 0 and 2 (the old `printf|head` pipe could exit 141).
#
# Performance budget: typical cost is tens of ms per call; the "performance"
# test asserts a deliberately generous median-of-5 ceiling (1000ms) — pure string/regex work, no network/git/Redis IO, no
# dependency on cwd, but the bash wrapper shells out to python3 up to twice
# per invocation and a cold interpreter startup alone can cost 15-40ms on
# Linux, so a <10ms budget is not realistically achievable by this
# bash+python3 architecture. PreToolUse hooks run synchronously and a slow
# hook stalls every Bash call, so keep any future change on this same
# no-network, no-IO, string/regex-only footing.
#
# See issue #4654, docs/operator-playbooks/_fragments/hydra-dev-parent-flow.md
# (the sanctioned `gh issue edit --remove-label` path), and operator memory
# reference_gh_label_delete_endpoint_wipes_all_labels.

set -euo pipefail

# Read full stdin payload.
INPUT=$(cat)

# Coarse, bash-only SUSPECT flag (issue #4745): the raw stdin mentions both
# "delete" (any case) and "/labels". A deliberate SUPERSET of the precise
# python verdict, used only to decide whether a machinery failure fails CLOSED.
SUSPECT=0
shopt -s nocasematch
if [[ "$INPUT" == *delete* && "$INPUT" == */labels* ]]; then
  SUSPECT=1
fi
shopt -u nocasematch

# Single failure exit (issue #4745): the only exit codes this hook may produce
# are 0 and 2. A suspect command whose machinery broke is denied (exit 2); any
# other command fails open (exit 0) so the guard never wedges unrelated calls.
fail_closed() {
  trap - ERR
  if [ "$SUSPECT" = 1 ]; then
    echo "gh-label-delete-guard: internal error while inspecting a command that looks like an issue-labels DELETE; failing closed (exit 2). Use 'gh issue edit <n> --remove-label <name>' instead." >&2
    exit 2
  fi
  exit 0
}
trap fail_closed ERR

# Extract tool_name. The python snippet prints "" on a JSON parse error (exit
# 0 = "not applicable", fail open); a NONZERO python exit is a machinery
# failure and reaches fail_closed via the ERR trap.
TOOL=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_name",""))
except Exception:
  print("")' 2>/dev/null)

# Only this hook cares about Bash tool calls — gh api / curl only happen
# there.
if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

COMMAND=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception:
  print("")' 2>/dev/null)

# No command → nothing to inspect.
if [ -z "$COMMAND" ]; then
  exit 0
fi

# Run the segment-wise verdict in python3 (regex + shlex are far cleaner
# there than bash). The command text travels via an env var so we never
# have to shell-quote arbitrary agent-authored command text into a
# python -c string or a heredoc's substitution context.
export GH_LABEL_GUARD_CMD="$COMMAND"
VERDICT=$(python3 - <<'PY' 2>/dev/null
import os
import re
import shlex

cmd = os.environ.get("GH_LABEL_GUARD_CMD", "")

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
#     other than its own text, so it binds nothing);
#   - `read [-flags] NAME <<< <value>` (here-string only);
#   - `set -- <args>` (positional parameters `$1`..`$n`).
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
    r"([A-Za-z_][A-Za-z0-9_]*)\s" + ASSIGN_VALUE
)
LEADING_READ = re.compile(
    r"^\s*(?:" + ASSIGN_OPENER + r"\s*)?read\s+(?:-\w+\s+)*"
    r"([A-Za-z_][A-Za-z0-9_]*)\s*<<<\s*(\"[^\"\n]*\"|'[^'\n]*'|[^\s;&|]+)"
)
# `set -- a b c` rebinds the positional parameters from scratch, so a later
# `set --` (or a bare `set --`) replaces any earlier positional bindings:
# the numeric keys are dropped before the new words are recorded.
LEADING_SET_ARGS = re.compile(
    r"^\s*(?:" + ASSIGN_OPENER + r"\s*)?set\s+--\s*(.*)$", re.S
)
VAR_REF = re.compile(r"\$\{(\w+)\}|\$(\w+)")


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
            for k in [k for k in assigned if k.isdigit()]:
                del assigned[k]
            words = _split_words(m.group(1))
            if words is not None and all(_is_literal(w) for w in words):
                for i, w in enumerate(words):
                    assigned[str(i + 1)] = w
            rest = rest[m.end():]
            continue
        m = LEADING_PRINTF.match(rest)
        if m:
            value = _strip_quotes(m.group(2))
            # A format carrying a % conversion does not write its own text
            # into NAME, so it binds nothing (fail open).
            if "%" not in value and _is_literal(value):
                assigned[m.group(1)] = value
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

METHOD = re.compile(
    r"(?:^|\s)(?:-X\s*|--method(?:=|\s+)|--request(?:=|\s+))[\"']?DELETE\b",
    re.I,
)
COLLECTION = re.compile(r"issues/([^/\s\"'#?]+)/labels/?(?=$|[\s\"'?#])")

# --- Segment the (variable-resolved) command the way the shell would,
# respecting quotes — QA-4698 second re-review's other hard blocker: a
# raw-text split on `;`/`|` treats a QUOTED `;`/`|` inside a data flag
# (`curl -X DELETE -d 'note=a;b' .../labels`) as a real separator, so the
# method flag and the collection URL land in fake "segments" that never
# co-occur. shlex's punctuation_chars mode tokenizes shell operators as
# their own tokens while keeping quoted text — including a `;`/`|` inside
# it — as a single word, matching what the shell itself would do.
def _segments(text):
    try:
        # QA-4698 third re-review (Standards false-positive): shlex's
        # default `punctuation_chars=True` set ('();<>|&') does NOT include
        # a bare newline — shlex treats "\n" as ordinary whitespace and
        # never emits it as its own token, so a plain two-line command
        # (no `&&`/`;`) tokenized straight through with no separator
        # between the lines, merging them into ONE segment. That let a
        # DELETE flag on line 1 and a bare collection-URL reference on
        # line 2 falsely co-occur in the merged segment even when line 1
        # was itself the sanctioned single-label path form. Passing an
        # explicit punctuation_chars string with "\n" appended — and
        # excluding "\n" from `lex.whitespace` so it's tokenized as
        # punctuation instead of swallowed as whitespace — makes shlex
        # emit a bare newline as its own token (quote-aware: a literal
        # newline inside a quoted value stays part of that word), which
        # `sep_tokens` below now also recognizes as a boundary — matching
        # STMT_SPLIT's separator set used for the variable-resolution pass
        # above.
        lex = shlex.shlex(text, posix=True, punctuation_chars="();<>|&\n")
        lex.whitespace = lex.whitespace.replace("\n", "")
        lex.whitespace_split = True
        tokens = list(lex)
    except ValueError:
        # Unbalanced quotes or similar — can't safely tokenize. Fail open
        # (no segments to inspect) rather than guessing, matching this
        # hook's existing "never wedge an unrelated Bash call" contract.
        return []

    sep_tokens = {"&&", "||", ";", "|", "&", "\n"}
    segments = []
    current = []
    for tok in tokens:
        if tok in sep_tokens:
            segments.append(" ".join(current))
            current = []
        else:
            current.append(tok)
    segments.append(" ".join(current))
    return segments


offending_issue = None
for seg in _segments(cmd):
    if METHOD.search(seg):
        m = COLLECTION.search(seg)
        if m:
            offending_issue = m.group(1)
            break

if offending_issue is None:
    print("ALLOW")
else:
    print("DENY")
    print(offending_issue)
PY
)

# First-line / second-line extraction by parameter expansion: no pipe, so no
# SIGPIPE (exit 141 under pipefail) however large the verdict is (#4745).
VERDICT_LINE=${VERDICT%%$'\n'*}

case "$VERDICT_LINE" in
  ALLOW) exit 0 ;;
  DENY) ;;
  *) fail_closed ;;
esac

ISSUE_NUM="unknown"
if [[ "$VERDICT" == *$'\n'* ]]; then
  REST=${VERDICT#*$'\n'}
  ISSUE_NUM=${REST%%$'\n'*}
fi

REASON="gh-label-delete-guard: refusing this Bash command — it issues a DELETE against the issue labels COLLECTION endpoint ('issues/${ISSUE_NUM}/labels' with no trailing '/<name>' segment), which silently removes EVERY label on issue #${ISSUE_NUM} (issue #4654: 3 hits across 2 classes). Use the path form instead: 'gh issue edit ${ISSUE_NUM} --repo gaberoo322/hydra --remove-label <name>' (sanctioned) or 'DELETE repos/gaberoo322/hydra/issues/${ISSUE_NUM}/labels/<name>' (single-label REST form)."

# Emit the deny payload on stderr (per claude-code hook contract) and exit 2.
# The plain-text REASON goes first and the JSON build is best-effort, so a
# failure here still ends in exit 2 (never open).
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
