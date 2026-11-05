> *Automated QA failed (open PR)*

`FAIL` on PR #5374 - 6 blocking medium findings (round 2 of 3), worst: medium. Full review on the PR.

Relabelled `needs-dev-resume` (not `ready-for-agent`) - the PR is still open, so the autopilot's durable resume pin owns the retry. Fix list: pin the qa_orch dispatch to the unparked head (hydra-qa self-selects the unfiltered head); do not pop `dev_resume_pending` on a degraded parked read (dev.py drain); set `orch_parked_unreadable` true in `ALL_DEGRADED_SIGNALS`; check degraded before `if numbers:` in qa.py. Each with a test.

QA-Verdict: FAIL pr=5374 round=2 sha=8b69cc693e11 blockers=6 max_severity=medium
