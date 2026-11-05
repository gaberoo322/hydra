> *Automated QA - two-axis review (T3, 2 adversarial reviewers, round 2)*

### Findings

| Severity | Axis | Reviewer | File:line | Finding | Fix |
|---|---|---|---|---|---|
| medium | standards | reviewer-A-standards, reviewer-B-spec | scripts/autopilot/decide_selectors/dev.py:122 | Under a degraded parked read _is_parked_anchor is True for every anchor, so the drain falls through to resume_pending.pop(0) and permanently deletes the queued dev_resume_pending entry and its resume_branch on a transient gh failure. | On a degraded read skip the drain without popping; drop an entry only when positively parked on a healthy read; test that dev_resume_pending is unchanged after a degraded turn. |
| medium | standards | reviewer-A-standards, reviewer-B-standards | scripts/autopilot/decide_selectors/qa.py:63 | The parked filter only changes the local head; the dispatch carries only scope=orch and hydra-qa self-selects its own unfiltered .[0], so with needs-qa=[parked, unparked] the parked head can still be reviewed (round-1 finding 1 only partly fixed). | Pin the filtered head in prompt_args and honour it in hydra-qa, or exclude parked in hydra-qa's query; add a mixed-list test. |
| medium | spec | reviewer-A-spec | scripts/autopilot/decide_selectors/qa.py:58 | Round-1 finding 1 only partly fixed: filtered head is not passed to hydra-qa, which self-selects the unfiltered .[0]. | Pin the chosen issue in prompt_args and honour it in the skill; mixed-list test. |
| medium | spec | reviewer-A-spec | scripts/autopilot/decide_selectors/qa.py:57 | INV-4 fail-closed on a degraded parked read only runs inside 'if numbers:'; absent/empty needs_qa_numbers dispatches qa_orch while orch_parked_unreadable is true. | Check _parked_read_degraded before the if-numbers branch; add test. |
| medium | standards | reviewer-B-standards | src/schemas/turn-snapshot.ts:231 | ALL_DEGRADED_SIGNALS sets orch_parked_unreadable false, so on an all-degraded marker turn the belt fails open for dev_resume_pending and in-session qa-verdict events, contradicting INV-4 and prGateFallbackSnapshot (which emits unreadable=true). | Set orch_parked_unreadable true in ALL_DEGRADED_SIGNALS and test an all-degraded snapshot with a queued resume and a qa-verdict event. |
| medium | spec | reviewer-B-spec | src/schemas/turn-snapshot.ts:231 | ALL_DEGRADED_SIGNALS orch_parked_unreadable false makes a wholly degraded snapshot look like a healthy empty parked set to the auto-merge sweep, so a parked PR can be armed from a session qa-verdict event. | Set it true (also json-snapshot.ts per-key degrade) and test all-degraded plus qa-verdict event expects a hold. |

### Follow-ups (non-blocking)

| Severity | Axis | Reviewer | File:line | Finding | Fix |
|---|---|---|---|---|---|
| low | standards | reviewer-A-standards, reviewer-B-standards | scripts/autopilot/decide_selectors/qa.py:58 | The degraded fail-closed check sits inside 'if numbers:', so an absent needs_qa_numbers falls through to the fail-open boolean dispatch while orch_parked_unreadable is true. | Evaluate _parked_read_degraded before the if-numbers branch. |
| low | standards | reviewer-A-standards | scripts/autopilot/decide_selectors/dev.py:691 | Duplicated Code: the not _is_parked_anchor belt is hand-pasted at several dev.py sites plus the decide.py sweep. | One helper in decide_base or filter once at pick extraction. |
| low | standards | reviewer-A-standards | scripts/autopilot/decide.py:2887 | Reason string parked:#N means issue number or PR number depending on branch. | Distinct prefixes parked:issue#N / parked:pr#N. |
| low | standards | reviewer-A-standards | src/autopilot/turn-snapshot/json-snapshot.ts:306 | orch_parked_unreadable duplicates the collector degraded marker and orch_parked_issues stays ambiguous for consumers ignoring the flag. | Document the flag as mandatory alongside orch_parked_issues. |
| low | spec | reviewer-A-spec | src/autopilot/turn-snapshot/pr-gate.ts:1255 | The dirty/behind/unchecked skip uses parkedPrs, empty on an unreadable read, so those PR-gate arms stay open on degrade. | Document as exempt from INV-4 or hold them when !parkedIssues.ok; add a test. |
| low | spec | reviewer-B-spec | src/autopilot/turn-snapshot/pr-gate.ts:471 | parkedPrNumbers skips on ANY parked closing ref while INV-2 says ambiguous refs are never skipped; no test pins the choice. | Amend INV-2 or require all refs parked; add a multi-ref test. |
| low | spec | reviewer-B-spec | docs/operator-playbooks/hydra-review.md:98 | Bucket 4 overstates that every arm skips parked PRs given the degraded-read gaps. | Soften or fix the mediums first. |

## Standards

A and B re-reviewed the full diff; round-1 findings 2 and 3 fixed, finding 1 (qa_orch) only partly; new degraded-read fail-open and destructive-pop gaps.

## Spec

Spec: AC1 not fully met (qa_orch mixed pin, degraded paths); AC2 met.

Severity-gated fold (T3): 6 blocking finding(s) — medium or higher.
Review fan-out: adversarial (T3, 2 reviewers, code change)

---

**Verdict:** `FAIL` - 6 blocking medium findings (4 distinct defects). Round-1 findings 2 (auto-merge belt now PR-keyed) and 3 (orch_parked_unreadable flag) fixed; finding 1 (qa_orch) only partly. CI: all required checks green (advisory-checks red is ambient, non-required).

QA-Verdict: FAIL pr=5374 round=2 sha=8b69cc693e11 blockers=6 max_severity=medium
