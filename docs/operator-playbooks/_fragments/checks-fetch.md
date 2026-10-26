# Shared fragment: checks-fetch (issue #4757, reduced to one CLI call in #5080).
# Included INSIDE a bash fence (verbatim, issue #2552) by hydra-qa.md step 5
# and hydra-autopilot.md's "Building qa-verdict events" section, so the two
# required-check call sites cannot drift (design-concept INV-2). This file is
# therefore fence body — bash comments only, no HTML header, and it must never
# itself pull in another fragment (the resolver is single-level by design).
# Expects $PR_NUMBER; leaves $CHECKS_JSON (the canonical {name, status,
# conclusion, required} array) and $ROLLUP_JSON (the raw rollup, reused by
# hydra-qa's INV-7 fallback). The fetch AND the rollup fold live in the
# qa-verdict CLI's `checks` phase (scripts/ci/qa-verdict.ts -> src/qa/phases.ts,
# which folds through the ONE pure helper buildCheckStates) — never
# re-implement either here. Pinned by test/qa-merge-guard-callsites.test.mts,
# which executes this block against a fake gh reproducing the live response
# shapes, and by test/hydra-qa-prompt-verdict.test.mts against the recorded
# live fixture test/fixtures/pr-4754-status-check-rollup.json.
# >>> checks-fetch
# ONE shared required-check fetch (issue #4757). Required-ness comes only from
# branch protection (inside the CLI), never from the rollup. Fail-closed
# (INV-7): CHECKS_JSON is kept ONLY for a branch-protection read; an
# unreadable contexts OR rollup read leaves it empty and the trailing
# [ -n ... ] makes the block return non-zero so a caller can branch on $?.
# Call sites degrade their own way: hydra-qa falls back to the legacy
# rollup-only mapping (every check optional — the verdict must still be
# produced; branch protection remains the real merge gate), the autopilot
# builder holds the verdict PENDING.
_CF_OUT=$(printf '{"pr":%s}' "$PR_NUMBER" \
  | node --no-warnings --experimental-strip-types scripts/ci/qa-verdict.ts checks) || _CF_OUT=""
CHECKS_JSON=$(printf '%s' "$_CF_OUT" \
  | jq -c 'if .source == "branch-protection" then .checks else empty end' 2>/dev/null) || CHECKS_JSON=""
ROLLUP_JSON=$(printf '%s' "$_CF_OUT" | jq -c '.rollup // empty' 2>/dev/null) || ROLLUP_JSON=""
if [ -z "$CHECKS_JSON" ]; then
  echo "WARN: checks-fetch failed (required-contexts or rollup unreadable) — CHECKS_JSON left empty (issue #4757 INV-7)" >&2
fi
[ -n "$CHECKS_JSON" ]
# <<< checks-fetch
