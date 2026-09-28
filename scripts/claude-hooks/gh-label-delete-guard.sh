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
# Performance budget: sub-250ms per call (measured, see the "performance"
# test case) — pure string/regex work, no network/git/Redis IO, no
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

# Extract tool_name. Fall back to empty on parse error so we fail open
# (allow the call) rather than blocking on a malformed payload.
TOOL=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_name",""))
except Exception:
  print("")' 2>/dev/null || true)

# Only this hook cares about Bash tool calls — gh api / curl only happen
# there.
if [ "$TOOL" != "Bash" ]; then
  exit 0
fi

COMMAND=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception:
  print("")' 2>/dev/null || true)

# No command → nothing to inspect.
if [ -z "$COMMAND" ]; then
  exit 0
fi

# Run the segment-wise verdict in python3 (regex + shlex are far cleaner
# there than bash). The command text travels via an env var so we never
# have to shell-quote arbitrary agent-authored command text into a
# python -c string or a heredoc's substitution context.
export GH_LABEL_GUARD_CMD="$COMMAND"
VERDICT=$(python3 - <<'PY' 2>/dev/null || true
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
LEADING_ASSIGN = re.compile(
    r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|\'[^\']*\'|[^\s]*)\s*'
)
VAR_REF = re.compile(r"\$\{(\w+)\}|\$(\w+)")


def _strip_quotes(s):
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


assigned = {}
for stmt in STMT_SPLIT.split(cmd):
    rest = stmt
    while True:
        m = LEADING_ASSIGN.match(rest)
        if not m:
            break
        assigned[m.group(1)] = _strip_quotes(m.group(2))
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

VERDICT_LINE=$(printf '%s\n' "$VERDICT" | head -n1)

if [ "$VERDICT_LINE" != "DENY" ]; then
  exit 0
fi

ISSUE_NUM=$(printf '%s\n' "$VERDICT" | sed -n '2p')

REASON="gh-label-delete-guard: refusing this Bash command — it issues a DELETE against the issue labels COLLECTION endpoint ('issues/${ISSUE_NUM}/labels' with no trailing '/<name>' segment), which silently removes EVERY label on issue #${ISSUE_NUM} (issue #4654: 3 hits across 2 classes). Use the path form instead: 'gh issue edit ${ISSUE_NUM} --repo gaberoo322/hydra --remove-label <name>' (sanctioned) or 'DELETE repos/gaberoo322/hydra/issues/${ISSUE_NUM}/labels/<name>' (single-label REST form)."

# Emit the deny payload on stderr (per claude-code hook contract) and exit 2.
printf '%s\n' "$REASON" >&2
python3 -c "import json,sys
print(json.dumps({
  'hookSpecificOutput': {
    'hookEventName': 'PreToolUse',
    'permissionDecision': 'deny',
    'permissionDecisionReason': sys.argv[1]
  }
}))" "$REASON" >&2
exit 2
