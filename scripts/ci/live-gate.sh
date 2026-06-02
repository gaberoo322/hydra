#!/usr/bin/env bash
#
# live-gate.sh — the Live-Gate Invariant (issue #738, ADR-0015 §live-gate
# invariant) for the `tier-gate` CI job.
#
# ## The circularity hole this closes
#
# The `tier-gate` job classifies a PR by running `scripts/tier-classify.ts`
# *after* `actions/checkout@v4` has checked out the PR's merge ref — so it
# runs the PR's OWN copy of tier-classify.ts -> tier-classifier.ts ->
# untouchable.ts to judge the PR. A malicious or buggy PR that edits a
# Verifier Core file could ship a neutered classifier (e.g. one that returns
# T1 for ci.yml) and thereby verify its own admission. The proposed gate
# would be grading its own exam.
#
# ## The invariant
#
# A change to the Verifier Core is verified by the *currently-deployed*
# (base-ref / master) gate, never by the proposed (PR-head) one:
#
#   - Determine "is this a Verifier Core PR?" using the BASE-ref
#     isVerifierCore — so a PR cannot remove a path from the list on its
#     head and thereby dodge base-ref treatment.
#   - If YES -> classify the PR's changed-file LIST using the BASE-ref
#     classifier scripts (extracted from master into a temp dir). You judge
#     the PR's files using the OLD rules, not the PR's proposed rules.
#   - If NO  -> run the head-ref classifier exactly as today. Zero behavior
#     change for the ~95% common case (a normal src/dashboard/config PR).
#
# The changed-file LIST always comes from the PR diff (head vs base). Only
# the CLASSIFIER LOGIC moves from head to base when a Verifier Core file is
# in the diff. Only the SOURCE of the rules moves.
#
# Note (ADR-0020 Slice 2 / #743): the gate no longer blocks T4 on an
# `operator-approved` label. The T4 depth guarantee relocated to the base-ref
# `deep-qa-gate` required check (the SHA-bound Deep-QA PASS marker) + the
# mutation floor (#778) + this base-ref Live-Gate (#738). This script now just
# classifies (base-ref scripts for a Verifier-Core PR, head-ref otherwise) and
# reports the tier JSON; it never exits 2. The base-ref Live-Gate mechanism
# itself is unchanged — only the operator-approved policy was removed.
#
# Why a legitimate PR that ADDS a path is still correct: a PR that adds a
# new path to VERIFIER_CORE_PATHS is itself a Verifier Core PR (it edits
# src/untouchable.ts), so it gets base-ref treatment.
# Conversely a normal PR that adds a new T2/T3 mapping to tier-classifier.ts
# is also a Verifier Core PR and is judged by the old classifier — that is
# correct: the new mapping is the PR's proposal, not yet the live gate.
#
# ## DO NOT "simplify" this away
#
# DO NOT change the Verifier Core branch to run `scripts/tier-classify.ts`
# from the checked-out (head) tree. That re-opens the circularity hole the
# whole invariant exists to close — see ADR-0015 §live-gate invariant and
# issue #738. The base-ref extraction is load-bearing, not boilerplate.
#
# ## Why merge-base, not base.sha
#
# We source the base ref from `git merge-base origin/master HEAD`, not from
# `github.event.pull_request.base.sha`, because base.sha goes stale on
# rebased PRs (it can point at an old base that no longer matches the fork
# point). The mutation-test job already uses this proven, rebase-safe
# pattern; we reuse it for consistency.
#
# ## Mechanics
#
# The three verifier scripts are import-closed:
#   scripts/tier-classify.ts -> src/tier-classifier.ts -> src/untouchable.ts
# with no other repo imports. So they run standalone from a temp dir using
# the workspace's installed tsx (invoked at repo root, so node_modules
# resolves; relative ../src imports resolve inside the temp tree).
#
# ## Usage / contract (kept thin so test/live-gate.test.mts can drive it
# without a real GitHub PR — mirrors how grounding tests test pure
# functions instead of running real git):
#
#   live-gate.sh <base-ref> <changed-files-file>
#
#   <base-ref>            a git ref/sha for the trusted base (the CI caller
#                         passes the merge-base; tests pass a fixture sha).
#   <changed-files-file>  path to a newline-delimited file of the PR's
#                         changed files (the head diff).
#
# Output: the tier-classify JSON on stdout (same shape as tier-classify.ts).
# Exit codes: identical to tier-classify.ts —
#   0  any valid classification (the gate reports the tier; it no longer
#      blocks T4 on a label — ADR-0020 Slice 2 / #743)
#   1  usage / unexpected error
#
# A diagnostic line on stderr records which classifier (base vs head) won,
# for auditability in the CI log.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: live-gate.sh <base-ref> <changed-files-file>" >&2
  exit 1
fi

BASE_REF="$1"
CHANGED_FILES_FILE="$2"

if [ ! -f "$CHANGED_FILES_FILE" ]; then
  echo "live-gate: changed-files file not found: $CHANGED_FILES_FILE" >&2
  exit 1
fi

# The three import-closed verifier scripts, in dependency order. These are
# extracted from the base ref into a temp tree so the classifier LOGIC comes
# from the currently-deployed gate, not the PR head.
VERIFIER_SCRIPTS=(
  "src/untouchable.ts"
  "src/tier-classifier.ts"
  "scripts/tier-classify.ts"
)

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

mkdir -p "$TMP/src" "$TMP/scripts"
for f in "${VERIFIER_SCRIPTS[@]}"; do
  if ! git show "$BASE_REF:$f" > "$TMP/$f" 2>/dev/null; then
    echo "live-gate: failed to extract $f from base ref $BASE_REF" >&2
    exit 1
  fi
done

BASE_WRAPPER="$TMP/scripts/tier-classify.ts"

mapfile -t FILES < "$CHANGED_FILES_FILE"
# Drop blank lines so an empty/blank file list doesn't pass "" as a file.
CLEAN_FILES=()
for f in "${FILES[@]}"; do
  [ -n "$f" ] && CLEAN_FILES+=("$f")
done

# Decide "is this a Verifier Core PR?" using the BASE-ref isVerifierCore.
# A tiny probe (written into the temp tree so it can statically import the
# sibling base-ref untouchable.ts) prints "yes"/"no". Sourcing
# isVerifierCore from base (not head) is what stops a PR from removing its
# own path on the head to dodge base-ref treatment. A static-import .ts
# probe file (not `tsx -e`) is used because `tsx -e` eval transforms to CJS
# and a dynamic import() of a .ts module there does not expose named
# exports reliably.
cat > "$TMP/scripts/verifier-core-probe.ts" <<'PROBE_EOF'
import { isVerifierCore } from "../src/untouchable.ts";
const files = process.argv.slice(2);
process.stdout.write(files.some((f) => isVerifierCore(f)) ? "yes" : "no");
PROBE_EOF

IS_VERIFIER_CORE="$(npx tsx "$TMP/scripts/verifier-core-probe.ts" "${CLEAN_FILES[@]}")"

if [ "$IS_VERIFIER_CORE" = "yes" ]; then
  echo "live-gate: Verifier Core file in diff -> classifying with BASE-ref scripts (ref=$BASE_REF)" >&2
  set +e
  npx tsx "$BASE_WRAPPER" "${CLEAN_FILES[@]}"
  STATUS=$?
  set -e
  exit $STATUS
else
  echo "live-gate: no Verifier Core file in diff -> classifying with HEAD-ref scripts (unchanged path)" >&2
  set +e
  npx tsx scripts/tier-classify.ts "${CLEAN_FILES[@]}"
  STATUS=$?
  set -e
  exit $STATUS
fi
