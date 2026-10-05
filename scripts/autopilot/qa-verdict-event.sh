#!/usr/bin/env bash
#
# qa-verdict-event.sh — build ONE `qa-verdict` event for events.json (issue #4831).
#
#   bash scripts/autopilot/qa-verdict-event.sh <PR> <TIER>     → one JSON object on stdout
#
# This is the playbook's "Building `qa-verdict` events" recipe (issues #4737,
# #4738, #4757), verbatim, as a script: the QA merge guard for the verdict and
# its SHAs, the SHARED checks-fetch fragment for required-check state, the
# ci-state fold, and the jq that maps them onto {verdict, verdict_sha,
# head_sha}. The fragment is `source`d from docs/operator-playbooks/_fragments/
# checks-fetch.md rather than copied, so this file, hydra-qa.md step 5 and
# the playbook recipe keep the ONE fetch (#4757 INV-2). The ci-state and
# qa-verdict-event blocks below are pinned byte-for-byte against the
# playbook's marker-delimited blocks by test/autopilot-turn-runner.test.mts.
#
# Fail-closed: an unreadable guard or CI read yields verdict PENDING (the
# guard JSON falls to null, CI_JSON to null). Exit is always 0 once the event
# is printed — the event itself carries the degraded verdict.

set -uo pipefail

if [ $# -ne 2 ]; then
  echo "usage: qa-verdict-event.sh <PR> <TIER>" >&2
  exit 2
fi
PR="$1"; TIER="$2"
case "$PR$TIER" in ''|*[!0-9]*) echo "qa-verdict-event.sh: PR and TIER must be integers" >&2; exit 2 ;; esac

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$REPO_ROOT" || exit 2

# Guard exit: 0 allowed, 1 denied, 2 bad args. The JSON is on stdout for 0/1.
GUARD_JSON=$(node --experimental-strip-types scripts/ci/qa-merge-guard.ts --pr "$PR" --repo gaberoo322/hydra 2>/dev/null)
GUARD_RC=$?
GUARD_JSON=${GUARD_JSON:-null}
printf '%s' "$GUARD_JSON" | jq -e . >/dev/null 2>&1 || GUARD_JSON=null

# Required-check state via the SAME shared fetch hydra-qa's verdict uses
# (step 5) — one fragment, so the call sites cannot drift (issue #4757
# INV-2). A failed read leaves CHECKS_JSON empty, the ci-state block below
# fails to CI_JSON=null, and the event's verdict holds PENDING (fail-closed).
PR_NUMBER="$PR"
CHECKS_JSON=""
# shellcheck source=docs/operator-playbooks/_fragments/checks-fetch.md
source "$REPO_ROOT/docs/operator-playbooks/_fragments/checks-fetch.md" || true

if [ -n "$CHECKS_JSON" ]; then
# >>> ci-state
CI_JSON=$(CHECKS_JSON="$CHECKS_JSON" node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({redRequiredChecks, classifyVerdict}) => {
    const checks = JSON.parse(process.env.CHECKS_JSON);
    process.stdout.write(JSON.stringify({red: redRequiredChecks(checks), requiredPending: classifyVerdict('PASS', checks).summary.requiredPending}));
  }).catch((err) => { console.error('[autopilot] required-check read failed:', err); process.exit(1); });
") || CI_JSON=null
# <<< ci-state
else
  CI_JSON=null
fi
printf '%s' "$CI_JSON" | jq -e . >/dev/null 2>&1 || CI_JSON=null

echo "[qa-verdict-event] pr=$PR tier=$TIER guard_rc=$GUARD_RC guard=$(printf '%s' "$GUARD_JSON" | jq -c '{verdict, verdictSha, headSha, allowed, reason}' 2>/dev/null) ci=$CI_JSON" >&2

# >>> qa-verdict-event
jq -nc --argjson pr "$PR" --argjson tier "$TIER" --argjson guard "$GUARD_JSON" --argjson ci "$CI_JSON" '
  ($guard.verdict // "") as $v
  | {type: "qa-verdict", pr_number: $pr, tier: $tier,
     verdict: (if ($v | startswith("FAIL")) then "FAIL"
               elif ($v == "PASS" or $v == "PASS-pending-CI") and $ci != null then
                 (if ($ci.red | length) > 0 then "FAIL"
                  elif $ci.requiredPending > 0 then "PENDING"
                  else "PASS" end)
               else "PENDING" end),
     verdict_sha: ($guard.verdictSha // "unknown"), head_sha: ($guard.headSha // "")}'
# <<< qa-verdict-event
