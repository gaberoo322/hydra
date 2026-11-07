#!/usr/bin/env bash
set -euo pipefail

# zizmor-scan.sh — advisory GitHub Actions workflow static analysis (tool-scout #5368).
#
# Downloads the pinned zizmor release (zizmorcore/zizmor), verifies its SHA256
# before extraction, and scans .github/workflows offline, emitting machine-readable
# JSON (json-v1: ident, determinations.severity, locations, fixes) to stdout.
#
# SCAN-ONLY: this wrapper never rewrites workflow YAML. zizmor's auto-rewrite
# mode would touch Verifier Core workflows (ci.yml / deep-qa-gate.yml); that is an
# operator-confirmed action, never an autonomous write.
#
# TOOL LANE (ADR-0005): pinned pre-built binary, no package.json entry, no
# install scripts. Mirrors scripts/osv-scan.sh.
#
# Usage:
#   scripts/zizmor-scan.sh [repo-root]   # default: git toplevel
# Exit status is zizmor's own (non-zero when findings exist); the advisory CI
# step swallows it with `|| true`. Callers can gate on it without parsing JSON.
#
# The scan target is the explicit .github/workflows path (deterministic in a
# worktree, a fresh checkout, and CI alike).

# Pinned release. Bump the version and both hashes together.
ZIZMOR_VERSION="v1.32.0"
ZIZMOR_ASSET="zizmor-x86_64-unknown-linux-gnu.tar.gz"
ZIZMOR_TARBALL_SHA256="bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b"
ZIZMOR_BIN_SHA256="04d55fb88e582a8e9a9ce6b4753df723fc44c35e0d1a8e8771db9e017066c6df"

REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")}"

CACHE_DIR="${ZIZMOR_CACHE_DIR:-${TMPDIR:-/tmp}/hydra-zizmor}"
BIN="${CACHE_DIR}/zizmor-${ZIZMOR_VERSION}"

verify_sha() {
  local file="$1" expected="$2" actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    echo "zizmor-scan: no sha256sum/shasum available to verify the artifact" >&2
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "zizmor-scan: SHA256 mismatch for $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    return 1
  fi
}

if [ ! -x "$BIN" ] || ! verify_sha "$BIN" "$ZIZMOR_BIN_SHA256" 2>/dev/null; then
  mkdir -p "$CACHE_DIR"
  WORK="$(mktemp -d "${CACHE_DIR}/dl.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
  URL="https://github.com/zizmorcore/zizmor/releases/download/${ZIZMOR_VERSION}/${ZIZMOR_ASSET}"
  echo "zizmor-scan: downloading ${ZIZMOR_ASSET} @ ${ZIZMOR_VERSION}" >&2
  if ! curl -fsSL --retry 3 --max-time 120 "$URL" -o "$WORK/zizmor.tgz"; then
    echo "zizmor-scan: download failed from $URL" >&2
    rm -rf "$WORK"
    exit 1
  fi
  # Verify the tarball BEFORE extraction — a mismatched artifact never runs.
  if ! verify_sha "$WORK/zizmor.tgz" "$ZIZMOR_TARBALL_SHA256"; then
    rm -rf "$WORK"
    exit 1
  fi
  tar -xzf "$WORK/zizmor.tgz" -C "$WORK" zizmor
  if ! verify_sha "$WORK/zizmor" "$ZIZMOR_BIN_SHA256"; then
    rm -rf "$WORK"
    exit 1
  fi
  chmod +x "$WORK/zizmor"
  mv -f "$WORK/zizmor" "$BIN"
  rm -rf "$WORK"
fi

if [ ! -d "$REPO_ROOT/.github/workflows" ]; then
  echo "zizmor-scan.sh: no .github/workflows found under $REPO_ROOT" >&2
  exit 1
fi

exec "$BIN" --offline --format json --no-progress "$REPO_ROOT/.github/workflows"
