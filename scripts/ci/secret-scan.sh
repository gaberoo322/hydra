#!/usr/bin/env bash
# secret-scan.sh — block credential-like strings from entering the repo.
#
# The repo went public on 2026-05-28 (issue #698). A leaked secret in a public
# repo is an irreversible incident, so this scanner runs in two places:
#   - pre-commit hook (opt-in, via scripts/setup-git-hooks.sh) — local guard
#   - CI `secret-scan` job (.github/workflows/ci.yml) — the enforced gate
#
# It only matches HIGH-SIGNAL, structurally-distinctive credential formats to
# keep false positives near zero. It deliberately does NOT print the matched
# value — only the file and line numbers — because CI logs on a public repo are
# themselves public; echoing the secret would re-leak it.
#
# Usage:
#   scripts/ci/secret-scan.sh                  # scan staged files   (pre-commit)
#   scripts/ci/secret-scan.sh --all            # scan all tracked    (CI fallback)
#   scripts/ci/secret-scan.sh <file> [file...] # scan explicit files (CI on diff)
#
# Exit codes: 0 = clean, 1 = secret-like string found, 2 = usage error.

set -euo pipefail

# High-signal secret patterns. Each is specific enough that a match is almost
# certainly a real credential, not prose. Add new vendor formats here.
PATTERN='sk-ant-[a-zA-Z0-9_-]{20,}'              # Anthropic API keys
PATTERN+='|sk-[a-zA-Z0-9]{20,}'                  # OpenAI-style keys
PATTERN+='|AKIA[0-9A-Z]{16}'                     # AWS access key IDs
PATTERN+='|ghp_[a-zA-Z0-9]{36}'                  # GitHub personal access token
PATTERN+='|gho_[a-zA-Z0-9]{36}'                  # GitHub OAuth token
PATTERN+='|github_pat_[a-zA-Z0-9_]{50,}'         # GitHub fine-grained PAT
PATTERN+='|xox[baprs]-[a-zA-Z0-9-]{10,}'         # Slack tokens
PATTERN+='|AIza[0-9A-Za-z_-]{35}'                # Google API keys
PATTERN+='|-----BEGIN (RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----'  # private keys

# Files we never scan: example/template files (placeholders by design), this
# script (it contains the patterns above), lockfiles, and binary assets.
SKIP_RE='(\.env\.example$|\.example$|^scripts/ci/secret-scan\.sh$|package-lock\.json$|\.(png|jpe?g|gif|ico|woff2?|ttf|pdf)$)'

# Resolve the file list by invocation mode.
files=()
case "${1:-}" in
  --all)
    mapfile -t files < <(git ls-files)
    ;;
  "")
    mapfile -t files < <(git diff --cached --name-only --diff-filter=ACM)
    ;;
  *)
    files=("$@")
    ;;
esac

found=0
checked=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  [[ "$f" =~ $SKIP_RE ]] && continue
  checked=$((checked + 1))
  # -I skips binary files; -n gives line numbers. We capture line numbers ONLY
  # (field 1) so the credential value itself is never echoed to a public log.
  if lines=$(grep -nIE "$PATTERN" "$f" 2>/dev/null | cut -d: -f1 | paste -sd, -); then
    if [ -n "$lines" ]; then
      echo "secret-scan: credential-like string in $f (line(s): $lines)" >&2
      found=1
    fi
  fi
done

if [ "$found" -ne 0 ]; then
  {
    echo ""
    echo "secret-scan: BLOCKED — credential-like strings found above."
    echo "  • If it is a real secret: remove it, rotate the credential, and use an env var."
    echo "  • If it is a false positive: scrub the value or extend SKIP_RE in scripts/ci/secret-scan.sh."
  } >&2
  exit 1
fi

echo "secret-scan: clean ($checked files checked)."
