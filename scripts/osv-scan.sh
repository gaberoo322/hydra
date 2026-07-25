#!/usr/bin/env bash
set -euo pipefail

# osv-scan.sh — advisory OSV vulnerability scan wrapper (tool-scout #3642).
#
# Downloads the pinned osv-scanner binary (Google's OSV database scanner),
# verifies its SHA256, and runs a scan over the repo lockfiles, emitting stable
# machine-readable JSON with OSV IDs (GHSA-*/CVE-*) to stdout.
#
# WHY OSV (complements `npm audit`, does NOT replace it): npm audit queries only
# the npm advisory registry — which, being a REQUIRED CI check, reddens repo-wide
# the instant a new CVE lands (operator memory
# reference_npm_audit_required_check_ambient_poison_pill). osv-scanner queries the
# broader OSV database (aggregates GitHub Advisory + NVD + OSS-Fuzz), so an agent
# can run it ADVISORY-mode and surface a CVE before it hits the npm advisory DB
# and wedges the merge queue. Its JSON carries stable, parseable OSV IDs — the
# structured signal agents act on without LLM interpretation.
#
# TOOL LANE (ADR-0005): pinned pre-built binary downloaded on demand — no npm
# distribution, no package.json entry, no install scripts, no lavamoat
# allow-scripts gate impact. Same lane as the comby binary / ast-grep npx pin.
# The SHA256 verification below is load-bearing: it defends against a
# supply-chain swap of the downloaded binary and MUST NOT be skipped.
#
# ADVISORY / SCAN-ONLY: this wrapper never invokes `osv-scanner fix` (which
# rewrites package-lock.json destructively) — that is an operator-confirmed
# action, never an autonomous write. Scan-only here by design.
#
# Usage:
#   scripts/osv-scan.sh [repo-root]   # default: git toplevel
# Output: OSV scan results as JSON on stdout. Exit status is osv-scanner's own
# (non-zero when vulnerabilities are found) so a caller can gate on it; the
# advisory CI workflow deliberately swallows that with `|| true`.
#
# We pass the lockfiles EXPLICITLY with -L rather than doing a directory walk:
# the gitignore-respecting directory walk (`scan source <dir>`) silently finds
# no package sources inside a git *worktree* (its .git is a file, not a dir, so
# the walk's git-root detection misbehaves), whereas explicit -L is deterministic
# in a worktree, a fresh checkout, and CI alike.

# Pinned release. Bump these three together (tag + linux_amd64 sha) to update.
OSV_VERSION="v2.4.0"
OSV_SHA256="15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0"
OSV_ASSET="osv-scanner_linux_amd64"

REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")}"

# Cache the verified binary per-version so repeat runs skip the download.
CACHE_DIR="${OSV_CACHE_DIR:-${TMPDIR:-/tmp}/hydra-osv-scanner}"
BIN="${CACHE_DIR}/osv-scanner-${OSV_VERSION}"

verify_sha() {
  # Portable SHA256 check: prefer sha256sum, fall back to shasum -a 256.
  local file="$1" expected="$2" actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    echo "osv-scan: no sha256sum/shasum available to verify the binary" >&2
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "osv-scan: SHA256 mismatch for $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    return 1
  fi
}

if [ ! -x "$BIN" ] || ! verify_sha "$BIN" "$OSV_SHA256" 2>/dev/null; then
  mkdir -p "$CACHE_DIR"
  TMP="$(mktemp "${CACHE_DIR}/osv-scanner.XXXXXX")"
  URL="https://github.com/google/osv-scanner/releases/download/${OSV_VERSION}/${OSV_ASSET}"
  echo "osv-scan: downloading ${OSV_ASSET} @ ${OSV_VERSION}" >&2
  if ! curl -sSL "$URL" -o "$TMP"; then
    echo "osv-scan: download failed from $URL" >&2
    rm -f "$TMP"
    exit 1
  fi
  # Verify BEFORE marking executable or moving into place — a mismatched binary
  # never becomes runnable.
  if ! verify_sha "$TMP" "$OSV_SHA256"; then
    rm -f "$TMP"
    exit 1
  fi
  chmod +x "$TMP"
  mv -f "$TMP" "$BIN"
fi

# scan source reads the lockfiles directly (no network install). --format json
# emits the stable OSV-ID schema documented in issue #3642. Pass every lockfile
# present under the repo root explicitly with -L (deterministic in a worktree).
LOCK_ARGS=()
for lock in "$REPO_ROOT/package-lock.json" "$REPO_ROOT/dashboard/package-lock.json"; do
  [ -f "$lock" ] && LOCK_ARGS+=(-L "$lock")
done

if [ "${#LOCK_ARGS[@]}" -eq 0 ]; then
  echo "osv-scan: no package-lock.json found under $REPO_ROOT" >&2
  exit 1
fi

exec "$BIN" scan source --format json "${LOCK_ARGS[@]}"
