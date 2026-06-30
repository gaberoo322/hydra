#!/usr/bin/env bash
# footer.sh — the canonical `Source: <skill> | <ISO ts>` gh-issue provenance
# footer, extracted once (issue #2556).
#
# The same footer block was hand-copied into hydra-incident, hydra-research,
# hydra-discover (x3), and hydra-target-discover. Downstream parsers key on the
# exact string shape — classes.json provenance labels and the retro/reconciler
# footer matching both split on `Source: <skill> |` — so this helper emits a
# BYTE-IDENTICAL line: `Source: <label> | <RFC3339 UTC timestamp>`.
#
# Usage (source the lib, then call the function):
#
#     . ~/hydra/scripts/hydra/footer.sh
#     BODY="$(cat <<'EOF'
#     ## Problem
#     ## Evidence
#     EOF
#     )
#     $(hydra_issue_footer hydra-discover 'tier N')"
#     gh issue create --title "..." --body "$BODY"
#
# IMPORTANT (CLAUDE.md single-quoted-heredoc pitfall): the issue-body heredocs
# in the playbooks use `<<'EOF'` precisely so NO `$var` / `$(...)` expansion
# happens inside the body (a shell-injection-safety measure). That means you
# CANNOT call this helper from *inside* a `<<'EOF'` heredoc — it would land
# literally. Compose the footer OUTSIDE the quoted heredoc and concatenate it,
# exactly as the usage example above shows (the heredoc stays single-quoted;
# the footer is appended after the closing `EOF`). Do NOT switch the heredoc to
# an unquoted `<<EOF` to "make the helper expand" — that re-opens the injection
# hole the single-quoting exists to close.
#
# The output is exactly one line, no trailing leading whitespace beyond the
# single space delimiters, matching the historical hand-written footer
# byte-for-byte:
#   - `hydra_issue_footer hydra-incident`        -> `Source: hydra-incident | 2026-...Z`
#   - `hydra_issue_footer hydra-discover 'tier N'` -> `Source: hydra-discover (tier N) | 2026-...Z`

# hydra_issue_footer <skill-label> [suffix]
#
# <skill-label> : the producing skill name, e.g. hydra-incident.
# [suffix]      : optional parenthetical that the discover-family footers carry
#                 verbatim, e.g. `tier N` -> rendered as ` (tier N)`. Omit for
#                 the plain `Source: <skill> | <ts>` form.
hydra_issue_footer() {
  local label="$1"
  local suffix="${2:-}"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ -n "$suffix" ]; then
    printf 'Source: %s (%s) | %s\n' "$label" "$suffix" "$ts"
  else
    printf 'Source: %s | %s\n' "$label" "$ts"
  fi
}

# Allow direct invocation as a script too (so a playbook can call it without
# sourcing): `bash ~/hydra/scripts/hydra/footer.sh hydra-discover 'tier N'`.
# When sourced (BASH_SOURCE[0] != $0) this block is skipped.
if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  hydra_issue_footer "$@"
fi
