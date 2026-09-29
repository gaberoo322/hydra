# Shared fragment: checks-fetch (issue #4757). Included INSIDE a bash fence
# (verbatim, issue #2552) by hydra-qa.md step 5 AND hydra-autopilot.md's
# "Building qa-verdict events" section, so the two required-check call sites
# cannot drift (design-concept INV-2). This file is therefore fence body —
# bash comments only, no HTML header, and it must never itself pull in another
# fragment (the resolver is single-level by design). Expects $PR_NUMBER;
# leaves $CHECKS_JSON (the canonical {name, status, conclusion, required}
# array) and $ROLLUP_JSON (the raw rollup, reused by hydra-qa's INV-7
# fallback). All rollup folding lives in the ONE pure helper buildCheckStates
# (scripts/ci/qa-verdict.ts) — never re-implement it here. Pinned by
# test/qa-merge-guard-callsites.test.mts, which executes this block against a
# fake gh reproducing the live response shapes, and by
# test/hydra-qa-prompt-verdict.test.mts against the recorded live fixture
# test/fixtures/pr-4754-status-check-rollup.json.
# >>> checks-fetch
# ONE shared required-check fetch (issue #4757). Required-ness NEVER comes
# from the rollup — its entries carry no required-ness field (verified live
# on PRs #4754/#4764) — only from branch protection, the same ONE gh api read
# collect-state.sh's glm-red classifier makes (#4460 INV-4). A well-formed
# contexts=null payload is a KNOWN EMPTY set ([]), not a failure.
REQUIRED_CONTEXTS=$(gh api 'repos/gaberoo322/hydra/branches/master/protection/required_status_checks' \
  --jq '.contexts' 2>/dev/null || true)
REQUIRED_CONTEXTS=$(printf '%s' "$REQUIRED_CONTEXTS" | jq '
  if . == null then [] elif type == "array" then . else error("contexts payload is not an array") end' 2>/dev/null) \
  || REQUIRED_CONTEXTS=""
ROLLUP_JSON=$(gh pr view "$PR_NUMBER" --repo gaberoo322/hydra --json statusCheckRollup \
  --jq '.statusCheckRollup
    | if . == null then [] elif type == "array" then . else error("rollup payload is not an array") end' 2>/dev/null) \
  || ROLLUP_JSON=""
if [ -z "$REQUIRED_CONTEXTS" ] || [ -z "$ROLLUP_JSON" ]; then
  # Fail-closed (INV-7): an unreadable contexts OR rollup read leaves
  # CHECKS_JSON empty; the trailing [ -n ... ] makes the block return
  # non-zero so a caller can branch on $?. Call sites degrade their own way:
  # hydra-qa falls back to the legacy rollup-only mapping (every check
  # optional — the verdict must still be produced; branch protection remains
  # the real merge gate), the autopilot builder's ci-state read fails to
  # CI_JSON=null -> verdict PENDING.
  echo "WARN: checks-fetch failed (required-contexts or rollup unreadable) — CHECKS_JSON left empty (issue #4757 INV-7)" >&2
  CHECKS_JSON=""
else
  CHECKS_JSON=$(ROLLUP_JSON="$ROLLUP_JSON" REQUIRED_CONTEXTS="$REQUIRED_CONTEXTS" \
    node --no-warnings --experimental-strip-types -e "
    import('./scripts/ci/qa-verdict.ts').then(({buildCheckStates}) => {
      const rollup = JSON.parse(process.env.ROLLUP_JSON);
      const contexts = JSON.parse(process.env.REQUIRED_CONTEXTS);
      process.stdout.write(JSON.stringify(buildCheckStates(rollup, contexts)));
    }).catch((err) => {
      console.error('[checks-fetch] buildCheckStates failed:', err);
      process.exit(1);
    });
  ") || CHECKS_JSON=""
fi
[ -n "$CHECKS_JSON" ]
# <<< checks-fetch
