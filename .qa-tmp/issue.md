> *Automated QA escalated - round cap reached*

`FAIL` on PR #5379 - 1 blocker, worst: medium. Full review on the PR. The issue is `parked`; no dev lane will pick it up until the operator un-parks it.

Blocker: scripts/qa/route.ts:461-489 - a failed disarm followed by a throwing seam advance exits 1 with no JSON, bypassing the playbook HARD STOP (hydra-qa.md:355/357 exit before :375), so a FAILed PR can stay auto-merge-armed. Rounds 1-4 blockers: 5, 2, 1, 1 (none high). Recommendation: one more forward-fix (best-effort re-disarm + loud stderr in route's failure path, one test), then `needs-dev-resume`; un-park by removing `parked`, adding `needs-dev-resume`, and posting `Hydra-Cap-Reset: by=<you> ts=<ISO-8601>`.

QA-Verdict: FAIL pr=5379 round=4 sha=447fc49d2e57 blockers=1 max_severity=medium
