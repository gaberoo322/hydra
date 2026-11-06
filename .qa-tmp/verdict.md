> *Automated QA - two-axis review (T3 adversarial, 2 reviewers x Standards+Spec) - round 4*

Round-3 findings: all verified FIXED (playbook HARD STOP block now consumes `disarm-failed`; "NOTHING posted" wording reworded; redundant `isRecord` retest removed). The lifecycle-seam port merged from master is the new surface.

### Findings

| Severity | Axis | Reviewer | File:line | Finding | Fix |
|---|---|---|---|---|---|
| medium | standards, spec | reviewer-A-standards, reviewer-A-spec, reviewer-B-spec | scripts/qa/route.ts:461 | `disarmChecked()` (lines 461, 477) records `disarm-failed` in `degraded`, but the later `advanceOrThrow` calls (464, 471, 485, 489) can throw. A throw exits 1 with no result JSON and `effectsStarted` already true, so no error comment either. The playbook stub exits at `|| { ...; exit 1; }` (hydra-qa.md:355) and at `jq -er '.nextStep' || exit 1` (:357), both before the HARD STOP block at :375. Case: a FAIL where the disarm fails twice, then the seam refuses the bounce: auto-merge stays armed on a FAILed PR and nothing signals it. | In `runRoute`'s catch (or on a throw after `disarmChecked`) re-attempt `gh pr merge --disable-auto` and print a LOUD stderr line; or run the HARD STOP check (`autoMergeRequest` read + `--disable-auto`) in the playbook's route-failed branch before `exit 1`. Add a test: failing disarm plus refused bounce advance still surfaces the signal. |

### Follow-ups (non-blocking)

| Severity | Axis | Reviewer | File:line | Finding | Fix |
|---|---|---|---|---|---|
| low | spec | reviewer-A-spec, reviewer-B-spec | docs/operator-playbooks/hydra-qa.md:375 | HARD STOP text says "after every route call, before anything else" but sits after the `arm-auto-merge` fence and the `|| exit 1` lines. | Move above the `NEXT` fence, or reword. |
| low | standards | reviewer-A-standards | docs/operator-playbooks/hydra-qa.md:154 | `--defer` bullet still says "bounces the issue (not leaving needs-qa)", ambiguous after the seam port. | Reword to "moves the issue off needs-qa through the seam". |
| low | standards | reviewer-A-standards | scripts/qa/route.ts:132 | STD-ERROR-TYPED-CODE: `PrMergedStop` and bare `new Error` at 143, 250, 338, 395 have no `code`. | Typed subclasses in src/errors.ts. |
| low | standards | reviewer-A-standards | scripts/qa/route.ts:105 | Duplicated Code: `capPark` body copies the seam's `parkForCap` template, nothing pins equality. | Import the renderer or add an equality test. |
| low | standards | reviewer-A-standards | scripts/qa/_lib.ts:105 | `ports.advance` execFile has no timeout (http has 5s). | Add a timeout, treat as rc 1. |
| low | standards | reviewer-A-standards | scripts/qa/route.ts:320 | Repeated Switches on `bounceLabel() === 'needs-dev-resume'` in three paths. | One helper picking the body. |
| low | standards | reviewer-B-standards | scripts/qa/route.ts:237 | Dry-run `advance` stub always returns `wouldPark: ""`, so the shadow-park path is absent from the "identical" dry-run plan. | Echo a configurable wouldPark or soften wording. |
| low | standards | reviewer-B-standards | scripts/qa/route.ts:485 | A non-park seam refusal after the FAIL comment exits 1 with the comment posted; a redispatch may double-count the round. | Document idempotency or test it. |
| low | standards | reviewer-B-standards | scripts/qa/_lib.ts:149 | `isEntrypoint` compares against un-encoded `file://${argv[1]}`. | Use `pathToFileURL`. |
| low | spec | reviewer-B-spec | PR body | Deviations 3 and 5 are stale: route.ts does post a best-effort `QA-Verdict-Error`, and has no direct state-label writes (all via `ports.advance`). | Rewrite both deviations. |

## Standards

A: round-3 fixes verified; the one medium is the exit-1 path losing `disarm-failed`; typed-error and duplication lows. B: lows only.

## Spec

A and B: INV-1..12 hold on a read; the seam port and INV-6/12 "nothing posted" relaxation are acceptable documented deviations. A and B(spec) independently raise the same disarm-failed exit-1 gap as a medium.

Severity-gated fold (T3): 1 blocking finding(s) - medium or higher; three of four reviewers independently raised it, and I verified route.ts:461-489 and hydra-qa.md:355-375 directly.
Review fan-out: adversarial (T3 code)

---

**Verdict:** `FAIL` - 1 blocking medium: a FAILed PR can stay auto-merge-armed when the disarm fails and a later seam advance throws, because the exit-1 path bypasses the playbook HARD STOP. Cheap fix: handle `disarm-failed` on the route-failure path (best-effort re-disarm plus loud stderr) and add one test. All 8 required checks green.

**CI:** all 8 required checks green.

QA-Verdict: FAIL pr=5379 round=4 sha=447fc49d2e57 blockers=1 max_severity=medium
