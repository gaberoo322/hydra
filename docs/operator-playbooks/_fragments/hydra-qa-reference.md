# hydra-qa — on-demand reference

The reference bucket of `hydra-qa.md` (issue #5269): tier-aware depth, the severity-gated fold and convergent review, the `deep-qa-gate` StatusContext vs CheckRun note, Phase A shadow mode, the verdict tiers, the INV-A..INV-G definitions, the Post-merge Regression Check A/B, the invariants and the slot-lifecycle hook. Moved verbatim from the playbook body; read it on demand, it is not needed to run a QA pass.

## Tier-aware verification depth (issue #739, ADR-0015)

QA depth ascends with the **Modification Tier** of the PR (`GET /api/tier`, the single tier authority — never self-classified by path):

- **T1 / T2** — exactly **one standard QA pass**: the single parallel Standards + Spec fan-out described below. Behaviour-preserving; nothing in this section changes the T1/T2 path.
- **T3** (core `src/` + demoted infra) — an **adversarial depth gate**: run `hydra-qa` in **refutation framing** (reviewers are prompted to actively *find a reason this change is wrong / regresses something*, not to confirm it), fanned out to **2 independent reviewers**. The verdict comes from the **severity-gated fold** below: any medium-or-higher finding from **either** reviewer is a FAIL; a low finding is always a non-blocking follow-up, even when both reviewers raised it.
- **T4** (Verifier Core — `.github/workflows/ci.yml`, `.github/workflows/deploy.yml` [file removed; list entry persists], `.github/workflows/deep-qa-gate.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`) — the **Deep-QA Remediation Loop**: T4 **inherits the full T3 adversarial depth** (the same 2-reviewer refutation fan-out, unchanged) and **adds** on top (a) a **Verifier-Core checklist** the reviewers must run, and (b) the **block-and-escalate teeth** no other tier has. It never weakens or replaces the T3 gate — it is strictly additive. See step 10's T4 branch.

This is **additive verification depth, not a policy change**: the emitted verdict literal (`PASS` / `FAIL` / `PASS-pending-CI` / `FAIL-pending-CI`) is unchanged, and `decide.py`'s `should_auto_merge()` (and INV-007: `qa_verdict != PASS ⇒ hold`) are untouched. Only *how a review verdict is computed* changes — the severity-gated fold `foldReviewFindings()` in `scripts/ci/qa-verdict.ts` for T1–T3, and for T4 the unchanged any-blocker AND over two refutation reviewers (`aggregateAdversarialReview()`). T4's block-and-escalate is likewise **not** a new verdict literal — it routes through the existing `ready-for-human` pickup set (see below).

A T3 FAIL **bounces** the PR back to a dev agent via the universal remediation loop (re-label `needs-dev-resume` while the PR is open, `ready-for-agent` once it is not — step 10's FAIL routing), **not** block-and-escalate-to-operator (the Deep-QA Remediation Loop reserves block-and-escalate teeth for T4).

### Severity-gated fold for T1–T3 (issue #4734)

Every reviewer finding carries a `severity`, a `file:line` and a concrete fix (the findings contract at step 7). The rubric:

- `high` — behaviour regression, data or work loss, or a weakened safety gate.
- `medium` — a spec criterion unmet, or a real bug on a non-critical path.
- `low` — wording, comments, citations, style.

The T1–T3 fold (`foldReviewFindings()`) FAILs when **any** finding is `medium` or `high`. A `low` finding never blocks, whatever the reviewer count: when both independent reviewers (A and B of the T3 fan-out) raise the same `low`, it is listed once as a merged row, still non-blocking (issue #4916). Otherwise the verdict is PASS, and all low findings are listed under **Follow-ups (non-blocking)** in the comment. A finding with a missing or unknown severity counts as `high`, so a malformed row can never downgrade a verdict. The reason: in a 150-PR audit, 46 of 67 FAIL rounds were low-severity nits, and under the old any-blocker AND a single reviewer's nit cost a full dev bounce (~350k tokens). Two reviewers agreeing on a nit does not raise its severity — the class-sweep rule makes both scan the same defect classes, so they routinely converge on the same low.

**T4 is unchanged.** A T4 PR (and a PR whose tier is unknown, fail-closed) keeps the any-blocker semantics: every finding blocks, whatever its severity, and the Verifier-Core checklist and Deep-QA Remediation Loop below apply as before.

### Convergent review for T1–T3 (issue #4735)

In the same audit, 17 of 67 FAIL rounds raised a blocker that already existed at an earlier round, and single PRs bounced up to 7 times. Three rules make review converge. All of them read the `QA-Verdict:` trailers on the PR (step 9.5); there is no other counter.

- **Class sweep** (every reviewer, every round, step 7): when you raise a finding, list every instance of that defect class in the diff and the touched files in the same round. At 3+ instances, or on adversarial inputs, recommend the structural fix.
- **Re-review context** (step 7.0a, prompt only): after a FAIL, the prior findings table is appended to the review packet, plus `git diff <prior sha>..HEAD` when the prior `sha=` is still an ancestor of HEAD. Reviewers still get the FULL diff and changed files, first state fixed/not-fixed for each prior finding, and justify anything new. Nothing in code filters or demotes a finding: `foldReviewFindings()` alone decides the verdict (operator decision on #4735).
- **Round cap** (step 10): the 3rd reviewed FAIL round on a T1–T3 PR escalates instead of bouncing (`decideQaRoundAction()`). A CI-only round (the step-6.6 admission-gate skip) reviewed nothing and does not count; a round whose findings fold failed does count (its comment still carries a `### Findings` heading). The issue loses every dev-lane label and gains `ready-for-human`. The PR gains `ready-for-human` too, and the issue gets a round-by-round summary plus a recommendation. T4 keeps its 2nd-fail rule below.


### `deep-qa-gate` — authoritative commit StatusContext vs advisory CheckRun mirror (issue #868)

The `deep-qa-gate` required CI check (`.github/workflows/deep-qa-gate.yml`) reports its verdict through **two** GitHub primitives that share the name `deep-qa-gate`, and the distinction between them is **load-bearing**:

- **Commit StatusContext** — the SINGLE authoritative enforcement primitive. The workflow POSTs it on every arm (`POST /repos/{owner}/{repo}/statuses/{sha}`, `statuses: write` scope) against the resolved head SHA. This is the check the operator adds to branch protection; it is the one merge automation must read as the source of truth. A tier-conditional **status** is the right primitive (ADR-0020 Decision 4): it can be set `success` for non-T4 PRs immediately, whereas a branch-protection-required *CheckRun* this workflow never produces for non-T4 PRs would block ~95% of PRs forever.
- **CheckRun** — an **advisory rollup mirror** only. The `issue_comment` arm ALSO creates a CheckRun named `deep-qa-gate` on the same resolved head SHA (`POST /repos/{owner}/{repo}/check-runs`, `checks: write` scope), reporting the **same state** as the status. It exists solely so the PR checks **rollup** (`statusCheckRollup`) shows an unambiguous latest result for the name: at PR-open the `pull_request` arm emits its own like-named CheckRun (initially red for a T4 PR with no marker), which the shared concurrency group then CANCELS when the PASS marker fires — leaving a stale/cancelled CheckRun as the rollup's latest entry for the name even though the commit status is green (the #859 dogfood, memory note `reference_deep_qa_gate_checkrun_vs_status`). The `issue_comment` arm's CheckRun concludes AFTER that cancelled one, so it supersedes it and the rollup entry is clear.

**Invariant — the CheckRun never contradicts the status, and never becomes a second required check.** The advisory CheckRun always mirrors the commit status's state; if the two ever disagreed, the commit status wins (it is the authoritative primitive). The CheckRun is deliberately **not** added to branch protection: two required checks of the same name is ambiguous, and a required CheckRun that the workflow never produces for non-T4 PRs re-introduces the non-T4-blocked-forever failure ADR-0020 Decision 4 rejected. When auditing a `deep-qa-gate` verdict, read the **commit status** as the truth; the CheckRun is a UI/rollup convenience that should always agree with it.

## Phase A — shadow mode (current)

The design-concept gate is in **Phase A — shadow mode** (epic #437). The artifact does not yet exist for PRs whose parent issues pre-date the design-concept system. To avoid blocking the entire merge queue during cut-over, this skill is configurable:

- **Phase A (default, `DESIGN_CONCEPT_MODE=warn`)** — missing artifact logs a warning, the Spec axis is skipped (reports "no artifact (Phase A shadow mode)"), and QA proceeds with the Standards axis only.
- **Phase B/C (`DESIGN_CONCEPT_MODE=enforce`)** — missing artifact fails the PR with the message: `design-concept artifact required; run hydra-grill on the parent issue or attach 'design-concept-exempt' label (operator-only)`.

The mode is read from the shell variable `$DESIGN_CONCEPT_MODE` (default: `warn`). In both modes, an explicit `design-concept-exempt` label on the PR (operator-only) bypasses the Spec axis with an audit-log comment, regardless of whether the artifact exists.

The Tier-1 auto-bypass (PR diff entirely prompt paths per `isPromptOnlyChange()` — step 6 — and no associated artifact) also remains in both modes — prompt-only changes never require the artifact.

## Verdict tiers (issue #405)

The skill **never loops waiting on CI**. After the two-axis review it emits exactly one of four verdicts and returns:

| Verdict | Meaning | Autopilot behaviour |
|---|---|---|
| `PASS` | The review fold found no blocking finding (T1–T3: lone low findings become follow-ups) AND every required CI check has concluded successfully. | Approve and merge immediately. |
| `FAIL` | The review fold found a blocking finding (T1–T3: any medium/high — a low never blocks; T4: any finding), OR a required check has already failed/errored/timed-out. | Comment failing criteria and re-label via step 3's bounce-label helper: `needs-dev-resume` while the linked PR is still open — any provenance (issue #4766) — `ready-for-agent` only when no open PR remains. See step 10. |
| `PASS-pending-CI` | Both axes pass, no required check has failed, but at least one check (required or optional) is still `queued` / `in_progress` / `pending`. | Re-poll CI on the autopilot tick; merge once green or downgrade to `FAIL` if a required check later fails. The `hydra-qa` subagent has already exited. |
| `FAIL-pending-CI` | Reserved tier — currently unused by the classifier. Documented so operators / future playbooks can route a "review passed but a non-required check is in a soft-failure tier that we want to surface" case without re-running QA. | Treat as `PASS-pending-CI` for merge gating; surface in the verdict body. |

Pure helpers backing the classifier live in `scripts/ci/qa-verdict.ts`. The regression test `test/hydra-qa-prompt-verdict.test.mts` locks in the smoking-gun case: `mutation-test: QUEUED` + everything-else-green → `PASS-pending-CI` (not a wait).

**An incomplete reviewer fan-out is not a fifth verdict — it is a pre-verdict exit.** If step 7.5 finds a spawned reviewer missing (e.g. its worktree was reaped mid-review), the skill exits before reaching step 8/9 with none of the four verdicts above and `needs-qa` left in place for automatic retry — see step 7.5.


**Invariants referenced above, formally defined (issue #3815).** Step 6.6's
prose above cites INV-A through INV-G by tag, but until now those tags were
defined only in the issue's (uncommitted, expiring) design-concept artifact —
a dangling reference from any reviewer or future editor's point of view who
has only this file. This closes that gap, called out as a Standards finding on
PR #3874's adversarial-QA FAIL round and carried forward unresolved through
PR #3881:

- **INV-A** — any admission/short-circuit lever added under issue #3815 is a
  derivation of `aggregateAdversarialReview()` / `classifyVerdict()` in
  `scripts/ci/qa-verdict.ts`, never an independent policy.
- **INV-B** — T3/T4 reviews may only be **deferred**, never depth-reduced, by
  any such lever — Verifier-Core verification depth is never cut.
- **INV-C** — every PR that reaches auto-merge has been reviewed at the full
  depth its tier requires: a deferred or pre-spawn-skipped PR never merges
  without a real review having run on a later pass.
- **INV-D** — the emitted verdict literals (`PASS` / `FAIL` / `PASS-pending-CI`
  / `FAIL-pending-CI`), `aggregateAdversarialReview()`, `classifyVerdict()`,
  and `decide.py`'s `should_auto_merge()` (`INV-007`) stay byte-unchanged by
  any lever addressed under issue #3815.
- **INV-E** — every unknown input (an unreachable tier classifier, an
  unknown/absent `mergeStateStatus`, or the gate script's own runtime error,
  per the `.catch()` fallbacks above) fails closed to FULL review depth, never
  to a skip.
- **INV-F** — the Target's Risk-Critical Surface classification
  (`classifyTargetQaPath`, `hydra-target-qa`'s sibling gate) is untouched by
  any orchestrator-side QA-cost lever under issue #3815 — these levers edit
  only orchestrator files, zero Target files.
- **INV-G** — no new Redis key, label, CI check, or API endpoint is introduced
  by any lever under issue #3815 (`mergeStateStatus` rides the existing step-3
  `gh pr view` call).

## Post-merge Regression Check — the Outcome Holdback producer (issue #786, ADR-0004 step 4)

Pre-merge QA (sections 1–11) is the **Pre-merge Gate**. This section is the
**Post-merge Regression Check**: the *producer* of the Outcome Holdback events
(`holdback.reverted` / `holdback.cap-reached` / `holdback.revert_failed`) that
the notification consumer (now the Operator Channel router, `src/operator-channel/route-event.ts`;
formerly the deleted `src/digest.ts`) has long consumed but nothing produced since the in-process
`src/holdback.ts` watcher was deleted in the ADR-0006 cut-over. Without this,
no enrolled merge (T2/T3/T4 — see "carries up the ladder" below) is actually
watched for Target-Outcome regression — the holdback is a no-op.

**This is NOT a resurrected in-process watcher.** It is request-scoped work
the autopilot poll loop dispatches *after* a merge. There is no timer, no
sampler, no long-lived loop — re-introducing one reintroduces the
orphaned-recorder failure mode that retired the stuckness detector (ADR-0010)
and violates the autopilot-only execution model (ADR-0006/0012). The producer
logic lives behind the orchestrator service (`src/holdback.ts` +
`src/api/holdback.ts`); this skill only drives it over HTTP and performs the
`git revert` when told to.

**Holdback is read-only with respect to merge.** Enrollment and checks run
strictly AFTER a merge; a merge is never blocked or delayed. The only action a
holdback can take is to open a revert PR.

### A. Enroll at merge time — owned by the autopilot, NOT hydra-qa (issue #2055)

**Enrollment does not happen here.** `hydra-qa` runs strictly **pre-merge** —
it computes a verdict, posts it as a comment, and **never merges** (CI required
checks are the merge gate; ADR-0006/0012, `feedback_qa_fail_cannot_block_automerge`).
So a "snapshot the baseline immediately after a PASS merge" step in this skill
could **never fire** — by the time a PR squash-merges, the `hydra-qa` subagent
has already exited (single-pass exit, section "PASS-pending-CI"). The orphaned
enroll-at-merge block that used to live here was dead code; #2055 removed it.

The **only** point that runs AFTER a confirmed merge with the `prNumber` + `tier`
in hand is the autopilot's `auto-merge` action handler, so enrollment lives
there now — see **"Phase 6 holdback enrollment on auto-merge"** in
`docs/operator-playbooks/hydra-autopilot.md`. It POSTs the merge SHA + tier to
`/api/holdback/enroll` unconditionally; the server (`enrollHoldback` in
`src/holdback.ts`) enforces the carry-up exemption — Outcome Holdback **carries
up** the monotonic tier ladder (#741, ADR-0015), so **T2/T3/T4 merges enroll**
while **T1 (prompt-shaped) and unknown-tier merges are exempt** (a no-op
`{enrolled:false}`). A merge whose leading-outcome adapters return no data at
merge time also sits as "no signal" rather than a false holdback.

The **check** mechanism below (section B) DOES legitimately stay in `hydra-qa` /
the autopilot poll loop — it watches each already-enrolled merge SHA on every
tick. Only the *enroll-at-merge* step moved out, because that is the one step
that needs the confirmed merge SHA + tier the auto-merge handler alone holds.

### B. Check enrolled merges each poll (the watch)

On each autopilot poll tick, for every still-enrolled merge SHA, call `check`.
The service re-samples the leading outcomes, compares against the persisted
baseline, enforces the per-day revert cap, and emits the holdback.* events the
digest reads. It returns a `decision`:

```bash
RESP=$(curl -fsS -X POST http://localhost:4000/api/holdback/check \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg sha "$merge_sha" '{commitSha:$sha}')")
DECISION=$(printf '%s' "$RESP" | jq -r '.decision')
case "$DECISION" in
  revert)
    # A leading outcome regressed past its noise_epsilon AND the per-day cap is
    # not yet reached. The service already emitted holdback.reverted and cleared
    # the baseline + counted the revert. Perform the actual revert PR now.
    REGRESSED=$(printf '%s' "$RESP" | jq -r '.regressedOutcomes | join(", ")')
    if git -C <worktree> revert --no-edit "$merge_sha" && \
       gh pr create --title "revert: holdback regression on ${merge_sha:0:7}" \
         --body "Outcome Holdback auto-revert (ADR-0004 step 4). Leading outcomes regressed past noise_epsilon vs the pre-merge baseline: ${REGRESSED}."; then
      : # revert PR opened; CI is still the merge gate for the revert itself
    else
      # Revert/PR-open failed — surface through the Operator Channel (a
      # holdback.revert_failed Page, ADR-0045) so the operator sees a
      # warranted revert did not land.
      curl -fsS -X POST http://localhost:4000/api/holdback/revert-failed \
        -H 'content-type: application/json' \
        -d "$(jq -n --arg sha "$merge_sha" --arg r "git revert/PR-open failed" \
              '{commitSha:$sha, reason:$r}')" || true
    fi
    ;;
  cap-reached)
    # Per-day revert cap hit — revert SUPPRESSED, holdback.cap-reached emitted.
    # Do NOT revert; the Morning Brief surfaces the suppressed regression. A runaway
    # revert loop is far more expensive than missing one revert.
    ;;
  passed)
    : # Window elapsed clean — baseline already cleared. Stop watching this SHA.
    ;;
  watching)
    : # No regression yet — keep watching on the next poll.
    ;;
  no-enrollment)
    : # Expired or never enrolled — nothing to do.
    ;;
esac
```

### Invariants (must hold)

- **Carry-up enrollment (T2/T3/T4 only).** Outcome Holdback carries up the
  monotonic ladder (#741, ADR-0015): T2, T3, and T4 merges enroll; **T1 never
  enrolls** (prompt-shaped, too low signal-to-noise — ADR-0004). The producer
  enforces this server-side (`enrollHoldback` rejects T1/unknown), so a missing
  client-side guard cannot enroll a T1 merge.
- **Tier-aware, monotonic window.** The watch window length grows with blast
  radius: `window(T4) >= window(T3) >= window(T2)`, with the 5-cycle T2 value
  as the floor. The window is derived server-side from the enrolled `tier`
  (`windowCyclesForTier` in `src/redis/holdback.ts`), clamped so an env
  override can never invert the order. Only the window varies by tier — the
  regression threshold and revert logic are identical across enrolled tiers.
- **Leading outcomes only.** A revert fires only when a `kind: leading` outcome
  regresses in the **unfavorable** direction by **more than** its
  `noise_epsilon`. Terminal outcomes are too slow for the window and never
  drive a revert (`outcomes.yaml` schema comment; CONTEXT.md).
- **Adapter outage is no-data, not a regression.** A null reading on either
  side of the comparison never counts as a regression ("no false revert").
- **Fixed event names + payloads.** The producer emits exactly
  `holdback.reverted` (`payload.commitSha`, `payload.regressedOutcomes`),
  `holdback.cap-reached`, and `holdback.revert_failed` — the three names
  the Operator Channel router (`src/operator-channel/route-event.ts`) consumes:
  `holdback.revert_failed` is a Page, the other two are Morning Brief items
  (ADR-0045). Renaming any leaves the consumer orphaned.
- **Per-day cap precedes any revert.** Once `HYDRA_HOLDBACK_MAX_REVERTS_PER_DAY`
  (default 3) is reached, the producer emits `holdback.cap-reached` and
  suppresses further reverts for the UTC day.
- **No new runtime dependency** (ADR-0005). Events publish via the orchestrator
  event bus; the skill only shells `curl`/`gh`/`git`. Window/cap/TTL are named,
  env-overridable config (defaults in `src/redis/holdback.ts`, documented in
  `config/direction/outcomes.yaml`), never magic literals.

## Slot lifecycle events — PostToolUse hook (issue #671)

Every tool call inside this skill emits a `subagent_tool_call` event onto the
Redis stream `hydra:autopilot:slot-events`. The classification is done at
emit-time so the /now-pixel dashboard can route on `category` without
re-deriving it from the tool name:

- `milestone` — Write, Edit, MultiEdit, NotebookEdit, MCP write surfaces, and
  Bash matching `^(git commit|gh pr|npm test|npm run build|npm run typecheck)`
- `io` — other Bash, WebFetch, WebSearch, MCP read surfaces
- `background` — Read, Grep, Glob

**Hook script:** `scripts/autopilot/hooks/on-subagent-tool-call.sh`
**Hook registration:** sibling `<this-playbook>.settings.json` →
`~/.claude/skills/<this-skill>/.claude/settings.json` (propagated by
`scripts/sync-skills.sh`)

The hook MUST NEVER propagate errors back to this skill's session — a Redis
outage, a malformed payload, or a missing `jq` all result in a stderr
warning and `exit 0`. See `test/on-subagent-tool-call.test.mts` for the
pinned behavior.
