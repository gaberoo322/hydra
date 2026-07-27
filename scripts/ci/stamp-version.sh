#!/usr/bin/env bash
set -euo pipefail

# scripts/ci/stamp-version.sh — mint (and push) the semver version tag for the
# commit that was just deployed. Extracted from scripts/deploy.sh by issue #3733;
# the tagging behaviour itself is issue #3677 (wayfinder decisions #3655/#3656).
#
# Invoked by deploy.sh STRICTLY AFTER the health gate passes, as a SEPARATE
# PROCESS under `|| STAMP_RC=$?` so a stamping failure can never redden a healthy
# deploy. The separate-process form is load-bearing, NOT style: under
# `set -euo pipefail`, both `stamp_fn || warn` and `( set -e; … ) || warn` suppress
# errexit for the ENTIRE body (the ignored-status context is inherited, and
# re-setting an already-set flag is a no-op). Under either of those forms a failed
# derivation would fall through to `git tag` / `git push` with an empty or wrong
# tag. Only `bash child.sh || warn` keeps errexit live inside the child. Do NOT
# inline this back into deploy.sh as a function or a subshell.
#
# Runs against $PWD — deploy.sh has already cd'd to $HYDRA_ROOT and fast-forwarded
# to master. This creates a git REF only; it never stages, commits, or checks out
# a tracked file, so it cannot dirty the working tree and cannot trip deploy.sh's
# dirty-tree guard (the #2663 stale-prod hazard). deploy.sh's changelog role is
# exactly zero (#3656 computed-join): the dashboard computes per-version notes
# from the .changelog/ tag-window diff.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DERIVE="$SCRIPT_DIR/derive-version-bump.ts"

# IDEMPOTENT: if HEAD already carries an exact tag, skip. This is mandatory (not
# cosmetic) — a bare 2nd `git tag <existing>` errors under `set -e`, and it makes
# the step safe under the ci.yml cancel-in-progress hazard: a cancelled-then-
# reran deploy on the same SHA sees the exact-match tag and no-ops.
if git describe --tags --exact-match HEAD >/dev/null 2>&1; then
  echo "    HEAD already tagged $(git describe --tags --exact-match HEAD) — skipping (idempotent)."
  exit 0
fi

# Previous tag (empty on a fresh repo => derive-version-bump baselines v1.0.0).
PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"

# TRANSPORT (#3733): the commit range goes to derive-version-bump.ts on STDIN,
# never in the environment. The old `GIT_LOG="$(git log …)"` + env route carried
# two bugs at once, and a pipe kills both — see the CLI docblock in
# derive-version-bump.ts for the full write-up:
#   1. E2BIG — Linux caps a SINGLE argv/environ string at MAX_ARG_STRLEN
#      (32 pages = 131,072 bytes), independent of the far larger ARG_MAX.
#   2. Bash command substitution silently STRIPS NUL bytes, destroying the %x00
#      subject/body framing before the parser ever sees it.
# PREV_TAG stays in the environment on purpose: a ref name is a bounded scalar
# with no E2BIG exposure, so moving it would be diff for nothing.
#
# NUL TRIPWIRE — keep `%x00` as the subject/body separator; do NOT "harden" it to
# a printable separator such as %x1f. If this ever regresses to environment
# transport, a small (post-fix) range would sit comfortably under MAX_ARG_STRLEN
# and would corrupt BREAKING-CHANGE detection SILENTLY. With %x00, the same
# regression re-emits bash's "ignored null byte in input" warning. The NUL is a
# free tripwire and keeping it is the fail-loud choice.
#
# BASELINE — with no prior tag the range is not read AT ALL. nextTag(null, …)
# returns v1.0.0 and never inspects the commits ("the baseline IS the first
# release"), so the old code computed, transported and then discarded the entire
# history. Skipping the read removes the unbounded branch BY CONSTRUCTION rather
# than by a magic commit cap that can be tuned wrong. Never reintroduce a
# `git log HEAD` (whole-history) read here.
if [ -n "$PREV_TAG" ]; then
  NEW_TAG="$(git log "${PREV_TAG}..HEAD" --format='%s%x00%b%x1e' \
    | PREV_TAG="$PREV_TAG" node --experimental-strip-types "$DERIVE")"
else
  NEW_TAG="$(PREV_TAG='' node --experimental-strip-types "$DERIVE" </dev/null)"
fi

if [ -z "$NEW_TAG" ]; then
  echo "    WARNING: could not derive a version tag — skipping (deploy already healthy)."
  exit 0
fi

COMMIT_COUNT="$(git rev-list "${PREV_TAG:+${PREV_TAG}..}HEAD" --count 2>/dev/null || echo '?')"
# Annotated tag (#3655): carries author/date/message, preferred by
# `git describe --tags`, and makes the version's provenance auditable.
git tag -a "$NEW_TAG" -m "release ${NEW_TAG} (${COMMIT_COUNT} commits since ${PREV_TAG:-baseline})"
echo "    Tagged ${NEW_TAG} on $(git rev-parse --short HEAD)."

# Push the tag so `git describe --tags` is stable across fresh checkouts and the
# /api/versions read (#3680) sees it. Tolerate a push failure (no remote write,
# offline) — the local tag already reflects deployed reality and the deploy itself
# succeeded; a failed tag push must not fail a healthy deploy.
if git push origin "$NEW_TAG"; then
  echo "    Pushed ${NEW_TAG} to origin."
else
  echo "    WARNING: failed to push ${NEW_TAG} to origin (local tag stands)."
fi
