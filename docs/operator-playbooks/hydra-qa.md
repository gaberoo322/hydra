---
name: hydra-qa
description: Automated QA verification for Hydra orchestrator PRs — thin wrapper over the upstream `code-review` skill that runs Standards + Spec sub-agents in parallel against the design-concept artifact.
when_to_use: "When the user says 'QA issue #N', 'verify', 'check the PR', or an issue has the needs-qa label."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [issue_number]
claude_only: true
compose_base: _vendor/code-review.md
supersedes:
  - "### 1. Pin the fixed point"
  - "### 2. Identify the spec source"
  - "### 4. Spawn both sub-agents in parallel"
  - "### 5. Aggregate"
---

# Hydra QA

> **Structural supersession (#3990, replacing the #3818 prose note).** The base
> sections named in `supersedes:` are **excised at compose time** — absent from
> the generated skill, so there is nothing to "skip over". Base steps 1, 2, 4, 5
> are owned here by steps 3, 4, 7, 8. Base step 3 is **kept**: step 7.0 imports
> its Fowler smell baseline by name.
>
> Base steps 1 and 2 each end by telling the reviewer to **ask the user** — for
> the fixed point, and for the spec. An AFK `qa_orch` dispatch has no user to
> ask; ADR-0030 Decision 3 binds both to artifacts. That excision is what makes
> this skill safe to dispatch unattended.

> **Blocking-dispatch mandate (issue #3880 — a #3789/#3827 recurrence).** When
> step 7's fan-out runs, **every** `Agent` call that spawns a reviewer sub-agent
> MUST pass `run_in_background: false`. The `Agent` tool defaults to background
> dispatch — a spawn without this flag returns immediately, and the parent turn
> (and this session) can end with no verdict posted while reviewers are still
> running. This is not a new rule; it already lives at step 7 below. It failed to
> hold on 2026-08-05 even though step 7 carried it: the mandate was true but sat
> ~250 lines past this preface, *after the base's entire unconstrained "spawn in
> parallel" body*, so a dispatch could reach and act on a spawn instruction well
> before ever reading it. That body is now excised outright (#3990), so the only
> spawn instruction in this skill is step 7's — but the mandate stays hoisted
> here, because a top-down read must hit it before any spawn happens. Step 7.5's
> reviewer-completeness check is equally mandatory: never aggregate or emit a
> verdict for a fan-out where any spawned reviewer did not return a real
> result — see step 7.5 below.

<!-- compose-seam-supersede -->

> **Composed skill (ADR-0030 Decision 4 / Option C, issue #3420).** This playbook is the thin Hydra **AFK overlay** on top of the vendored upstream `code-review` base (`docs/operator-playbooks/_vendor/code-review.md`). `scripts/sync-skills.sh` emits `~/.claude/skills/hydra-qa/SKILL.md` as **[upstream code-review base] + [this overlay]**, with the vendored base's `disable-model-invocation: true` **stripped** (it hard-errors under Skill-tool dispatch). The review stage dispatches the *same* upstream `code-review` skill the operator runs, in AFK mode. The Hydra-specific verification depth, verdict classification, and remediation-loop routing below ride on that shared base. The dispatch-class → stage table lives in `hydra-autopilot.md`. **Contract complete (ADR-0030 Decision 5, epsilon #3424):** the standalone `hydra-qa` *fork identity* is retired — it is no longer a bespoke reviewer fork, it **is** the composed `review` stage. The `qa_orch` dispatch *class* and its `decide.py` `make_dispatch(…, "hydra-qa")` string literals (orch + target scope) stay live — they select this composed stage.

Automated QA verification for PRs against the Hydra orchestrator. This skill is a **thin wrapper over the upstream `code-review` skill** (mattpocock/skills; renamed from `review` in v1.1) — it runs two **parallel sub-agents** (Standards + Spec), aggregates their reports verbatim, classifies the verdict in one pass, and exits.

The Spec axis reads the **design-concept artifact** for the issue (Phase A of #437) — produced by `hydra-grill` and persisted at `GET /api/design-concepts/:anchorRef`. The Standards axis reads `CLAUDE.md`, `CONTEXT.md`, `docs/adr/`, and lint configs. The two axes deliberately do not share context.

> **Retired prompt artifact (issue #2556).** A standalone single-agent "Reality Checker" prompt (`AGENT-PROMPT.md`) used to be bundled alongside this skill. It predates the current parallel Standards/Spec fan-out and is **no longer injected by any flow** — the live reviewer prompts are embedded in this playbook (the `code-review`-skill sub-agents above). The stale artifact has been removed; it is not referenced anywhere. Do not re-introduce a separate prompt file: the reviewer prompts live here, in the playbook that `scripts/sync-skills.sh` regenerates the skill from.

> **NEVER end your session waiting on CI, a monitor, or a background process
> (issue #3866).** The full rule lives ONCE, canonically, in
> `hydra-autopilot.md`'s "Worktree-guard preamble" section — as of issue #4272
> the block prepended verbatim to every `qa_orch` dispatch prompt is the
> **qa_orch blocking-fan-out variant**, not the shared `dev_orch` block, so you
> receive it at dispatch time regardless of this pointer. The variant permits
> exactly the blocking (`run_in_background: false`) reviewer spawns step 7
> below directs — never a background spawn, and never ending your turn with
> any child still running. Restated here only as a cross-reference (not
> duplicated, to avoid drift): this skill already never loops waiting on CI by
> design (the four-verdict system below exists exactly to avoid that), but the
> design was violated in practice — a `qa_orch` T4 re-check on PR #3853 posted
> the Deep-QA PASS marker and then ended its turn waiting for the
> `deep-qa-gate` re-check to complete instead of returning. Once you have
> computed a verdict and executed its step-10 routing, you are DONE — return
> immediately.

## Tier-aware verification depth (issue #739, ADR-0015)

QA depth ascends with the **Modification Tier** of the PR (`GET /api/tier`, the single tier authority — never self-classified by path):

- **T1 / T2** — exactly **one standard QA pass**: the single parallel Standards + Spec fan-out described below. Behaviour-preserving; nothing in this section changes the T1/T2 path.
- **T3** (core `src/` + demoted infra) — an **adversarial depth gate**: run `hydra-qa` in **refutation framing** (reviewers are prompted to actively *find a reason this change is wrong / regresses something*, not to confirm it), fanned out to **2 independent reviewers**. The verdict comes from the **severity-gated fold** below: any medium-or-higher finding from **either** reviewer is a FAIL, and so is a low finding **both** reviewers raised independently; a lone low finding is a non-blocking follow-up.
- **T4** (Verifier Core — `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `.github/workflows/deep-qa-gate.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`) — the **Deep-QA Remediation Loop**: T4 **inherits the full T3 adversarial depth** (the same 2-reviewer refutation fan-out, unchanged) and **adds** on top (a) a **Verifier-Core checklist** the reviewers must run, and (b) the **block-and-escalate teeth** no other tier has. It never weakens or replaces the T3 gate — it is strictly additive. See step 10's T4 branch.

This is **additive verification depth, not a policy change**: the emitted verdict literal (`PASS` / `FAIL` / `PASS-pending-CI` / `FAIL-pending-CI`) is unchanged, and `decide.py`'s `should_auto_merge()` (and INV-007: `qa_verdict != PASS ⇒ hold`) are untouched. Only *how a review verdict is computed* changes — the severity-gated fold `foldReviewFindings()` in `scripts/ci/qa-verdict.ts` for T1–T3, and for T4 the unchanged any-blocker AND over two refutation reviewers (`aggregateAdversarialReview()`). T4's block-and-escalate is likewise **not** a new verdict literal — it routes through the existing `ready-for-human` pickup set (see below).

A T3 FAIL **bounces** the PR back to a dev agent via the universal remediation loop (re-label `needs-dev-resume` while the PR is open, `ready-for-agent` once it is not — step 10's FAIL routing), **not** block-and-escalate-to-operator (the Deep-QA Remediation Loop reserves block-and-escalate teeth for T4).

### Severity-gated fold for T1–T3 (issue #4734)

Every reviewer finding carries a `severity`, a `file:line` and a concrete fix (the findings contract at step 7). The rubric:

- `high` — behaviour regression, data or work loss, or a weakened safety gate.
- `medium` — a spec criterion unmet, or a real bug on a non-critical path.
- `low` — wording, comments, citations, style.

The T1–T3 fold (`foldReviewFindings()`) FAILs when **any** finding is `medium` or `high`, **or** when **both** independent reviewers (A and B of the T3 fan-out) raise the same `low` finding. Otherwise the verdict is PASS, and the lone low findings are listed under **Follow-ups (non-blocking)** in the comment. A finding with a missing or unknown severity counts as `high`, so a malformed row can never downgrade a verdict. The reason: in a 150-PR audit, 46 of 67 FAIL rounds were low-severity nits, and under the old any-blocker AND a single reviewer's nit cost a full dev bounce (~350k tokens).

**T4 is unchanged.** A T4 PR (and a PR whose tier is unknown, fail-closed) keeps the any-blocker semantics: every finding blocks, whatever its severity, and the Verifier-Core checklist and Deep-QA Remediation Loop below apply as before.

### Convergent review for T1–T3 (issue #4735)

In the same audit, 17 of 67 FAIL rounds raised a blocker that already existed at an earlier round, and single PRs bounced up to 7 times. Three rules make review converge. All of them read the `QA-Verdict:` trailers on the PR (step 9.5); there is no other counter.

- **Class sweep** (every reviewer, every round, step 7): when you raise a finding, list every instance of that defect class in the diff and the touched files in the same round. At 3+ instances, or on adversarial inputs, recommend the structural fix.
- **Re-review context** (step 7.0a, prompt only): after a FAIL, the prior findings table is appended to the review packet, plus `git diff <prior sha>..HEAD` when the prior `sha=` is still an ancestor of HEAD. Reviewers still get the FULL diff and changed files, first state fixed/not-fixed for each prior finding, and justify anything new. Nothing in code filters or demotes a finding: `foldReviewFindings()` alone decides the verdict (operator decision on #4735).
- **Round cap** (step 10): the 3rd reviewed FAIL round on a T1–T3 PR escalates instead of bouncing (`decideQaRoundAction()`). A CI-only round (the step-6.6 admission-gate skip) reviewed nothing and does not count; a round whose findings fold failed does count (its comment still carries a `### Findings` heading). The issue loses every dev-lane label and gains `ready-for-human`. The PR gains `ready-for-human` too, and the issue gets a round-by-round summary plus a recommendation. T4 keeps its 2nd-fail rule below.

### T4 Verifier-Core checklist + Deep-QA Remediation Loop (issue #740)

A T4 PR edits the **Verifier Core** — the 6 self-referential paths whose change alters *how every other change is verified*. The adversarial reviewers (the same A/B refutation pair as T3) MUST run this checklist in addition to the standard Standards + Spec axes; any item firing is a **hard blocker** (reviewer FAIL):

1. **Live-Gate Invariant (#738 / ADR-0015).** A Verifier-Core change is verified by the **currently-deployed** gate against the diff, **never** by the *proposed* gate. Concretely: the classifier **file LIST** = the PR diff (head-vs-base merge-base), the classifier **LOGIC** = the **BASE ref** (the import-closed `scripts/tier-classify.ts` / `src/tier-classifier.ts` / `src/untouchable.ts` as they exist on the merge base). "Is this a Verifier-Core PR?" is decided with the **BASE-ref** `isVerifierCore` so a PR cannot strip its own path on head to escape classification. A diff that re-routes Verifier-Core PRs back through the **head-tree** classifier is a hard blocker.
2. **No self-admitting gate.** No path in the diff lets the *proposed* gate verify its own admission: e.g. a `ci.yml` job that always exits 0 / is `continue-on-error` for the verification it claims to perform, a tier-classify edit that downgrades the PR's own files, or an `isVerifierCore` change that removes a path the diff itself touches. If the proposed gate would have admitted this very diff *only because of this diff's own change*, FAIL.
3. **`untouchable.ts` path set integrity.** Any edit to `VERIFIER_CORE_PATHS` is justified in the artifact and does not silently shrink the protected set.
4. **Operator-approval intact.** T4 still merges operator-only (`operator-approved` label); the diff must not weaken that requirement (branch protection, auto-merge enablement on T4).

The fired checklist items become the **findings** in the FAIL comment.

**Block-and-escalate on the 2nd consecutive fail.** T4 FAIL routing differs from T3 only at the 2nd fail:

- **1st deep-QA FAIL** → identical to the universal loop: comment findings + bounce the PR to a dev agent (re-label `needs-dev-resume` while the PR is open). It never escalates on the first fail.
- **2nd consecutive deep-QA FAIL on the same PR** → **block** the PR (FAIL comment + `ready-for-human`, do not re-bounce) and add the **source issue** to the `/hydra-review` pickup set: `ready-for-human` label + a structured comment (PR ref, both failing summaries, the fired Verifier-Core checklist items). This is the **existing** operator surface — no new channel, no new verdict literal. (`#745`'s phone-notify hook fires orthogonally when the pickup set goes non-empty.)

**How the fail number is counted.** The bounce path is stateless on the issue (step 10 strips `needs-qa` and adds the bounce label — `needs-dev-resume` while the PR is open, `ready-for-agent` otherwise (issue #4766) — resetting any label-carried counter on every bounce). So the count is derived **live** from the **PR** — the durable per-attempt ledger: every T4 deep-QA FAIL comment carries the machine-greppable marker line `Verifier-Core deep-QA: FAIL`. The next pass counts prior markers: `failNumber = priorMarkers + 1`; `failNumber >= 2` ⇒ block-and-escalate, else bounce. There is **no** new Redis key and **no** issue-label counter. "Consecutive" and "total fails on this PR" coincide because a PASS merges the PR and ends the loop. The pure decision rule is `decideDeepQaAction()` in `scripts/ci/qa-verdict.ts`.

### `deep-qa-gate` — authoritative commit StatusContext vs advisory CheckRun mirror (issue #868)

The `deep-qa-gate` required CI check (`.github/workflows/deep-qa-gate.yml`) reports its verdict through **two** GitHub primitives that share the name `deep-qa-gate`, and the distinction between them is **load-bearing**:

- **Commit StatusContext** — the SINGLE authoritative enforcement primitive. The workflow POSTs it on every arm (`POST /repos/{owner}/{repo}/statuses/{sha}`, `statuses: write` scope) against the resolved head SHA. This is the check the operator adds to branch protection; it is the one merge automation must read as the source of truth. A tier-conditional **status** is the right primitive (ADR-0020 Decision 4): it can be set `success` for non-T4 PRs immediately, whereas a branch-protection-required *CheckRun* this workflow never produces for non-T4 PRs would block ~95% of PRs forever.
- **CheckRun** — an **advisory rollup mirror** only. The `issue_comment` arm ALSO creates a CheckRun named `deep-qa-gate` on the same resolved head SHA (`POST /repos/{owner}/{repo}/check-runs`, `checks: write` scope), reporting the **same state** as the status. It exists solely so the PR checks **rollup** (`statusCheckRollup`) shows an unambiguous latest result for the name: at PR-open the `pull_request` arm emits its own like-named CheckRun (initially red for a T4 PR with no marker), which the shared concurrency group then CANCELS when the PASS marker fires — leaving a stale/cancelled CheckRun as the rollup's latest entry for the name even though the commit status is green (the #859 dogfood, memory note `reference_deep_qa_gate_checkrun_vs_status`). The `issue_comment` arm's CheckRun concludes AFTER that cancelled one, so it supersedes it and the rollup entry is clear.

**Invariant — the CheckRun never contradicts the status, and never becomes a second required check.** The advisory CheckRun always mirrors the commit status's state; if the two ever disagreed, the commit status wins (it is the authoritative primitive). The CheckRun is deliberately **not** added to branch protection: two required checks of the same name is ambiguous, and a required CheckRun that the workflow never produces for non-T4 PRs re-introduces the non-T4-blocked-forever failure ADR-0020 Decision 4 rejected. When auditing a `deep-qa-gate` verdict, read the **commit status** as the truth; the CheckRun is a UI/rollup convenience that should always agree with it.

## Phase A — shadow mode (current)

The design-concept gate is in **Phase A — shadow mode** (epic #437). The artifact does not yet exist for PRs whose parent issues pre-date the design-concept system. To avoid blocking the entire merge queue during cut-over, this skill is configurable:

- **Phase A (default, `DESIGN_CONCEPT_MODE=warn`)** — missing artifact logs a warning, the Spec axis is skipped (reports "no artifact (Phase A shadow mode)"), and QA proceeds with the Standards axis only.
- **Phase B/C (`DESIGN_CONCEPT_MODE=enforce`)** — missing artifact fails the PR with the message: `design-concept artifact required; run hydra-grill on the parent issue or attach 'design-concept-exempt' label (operator-only)`.

The mode is read from the env var `DESIGN_CONCEPT_MODE` (default: `warn`). In both modes, an explicit `design-concept-exempt` label on the PR (operator-only) bypasses the Spec axis with an audit-log comment, regardless of whether the artifact exists.

The Tier-1 auto-bypass (PR diff entirely prompt paths per `isPromptOnlyChange()` — step 6 — and no associated artifact) also remains in both modes — prompt-only changes never require the artifact.

## Verdict tiers (issue #405)

The skill **never loops waiting on CI**. After the two-axis review it emits exactly one of four verdicts and returns:

| Verdict | Meaning | Autopilot behaviour |
|---|---|---|
| `PASS` | The review fold found no blocking finding (T1–T3: lone low findings become follow-ups) AND every required CI check has concluded successfully. | Approve and merge immediately. |
| `FAIL` | The review fold found a blocking finding (T1–T3: any medium/high, or a low both reviewers raised; T4: any finding), OR a required check has already failed/errored/timed-out. | Comment failing criteria and re-label via step 3's bounce-label helper: `needs-dev-resume` while the linked PR is still open — any provenance (issue #4766) — `ready-for-agent` only when no open PR remains. See step 10. |
| `PASS-pending-CI` | Both axes pass, no required check has failed, but at least one check (required or optional) is still `queued` / `in_progress` / `pending`. | Re-poll CI on the autopilot tick; merge once green or downgrade to `FAIL` if a required check later fails. The `hydra-qa` subagent has already exited. |
| `FAIL-pending-CI` | Reserved tier — currently unused by the classifier. Documented so operators / future playbooks can route a "review passed but a non-required check is in a soft-failure tier that we want to surface" case without re-running QA. | Treat as `PASS-pending-CI` for merge gating; surface in the verdict body. |

**Why single-pass exit matters:** before #405 the subagent looped on `mutation-test: QUEUED` for hours. PR #403 auto-merged before a (correct) `FAIL` verdict landed. Autopilot polls CI; this skill does not.

Pure helpers backing the classifier live in `scripts/ci/qa-verdict.ts`. The regression test `test/hydra-qa-prompt-verdict.test.mts` locks in the smoking-gun case: `mutation-test: QUEUED` + everything-else-green → `PASS-pending-CI` (not a wait).

**An incomplete reviewer fan-out is not a fifth verdict — it is a pre-verdict exit.** If step 7.5 finds a spawned reviewer missing (e.g. its worktree was reaped mid-review), the skill exits before reaching step 8/9 with none of the four verdicts above and `needs-qa` left in place for automatic retry — see step 7.5.

## Measuring the QA catch rate (AC1, issue #3815)

Issue #3815's own acceptance criterion 1 gates every further fan-out-reducing
lever (in particular the RC2 mid-fan-out short-circuit) on measuring the
**true** QA catch rate — counting a FAIL wherever it is recorded (PR review
state, a verdict comment, or the `ready-for-agent` bounce path), not just
`CHANGES_REQUESTED` on closed PRs, which is the issue's own flawed original
0/36 methodology (a FAILed-then-fixed-then-PASSed PR shows no lasting
`CHANGES_REQUESTED`, and the `skip-required-failed` admission-gate branch at
step 6.6 computes a FAIL without ever spawning a reviewer, so it leaves no
review-state trace either).

`npm run qa:catch-rate -- --repo gaberoo322/hydra --limit 60` (implemented in
`scripts/ci/qa-catch-rate.ts`, pure classifier tested in
`test/qa-catch-rate.test.mts`) reproduces this number on demand: it fetches a
window of PRs, resolves each PR's linked issue for the bounce-path signal,
classifies every PR as `caught` / `clean-pass` / `not-reviewed` against the
three signals above, and prints the aggregate catch rate as JSON. Since issue
#4729 it parses the step-9.5 `QA-Verdict:` trailer FIRST and attributes it only
to the PR its `pr=` names (a shared linked issue no longer leaks a sibling PR's
bounce); the three legacy signals are the fallback for trailer-less historical
comments. This is the *instrument*, not the *lever* — it imports only the
read-only trailer parser from `qa-verdict.ts` and ships no change to `aggregateAdversarialReview()`, `classifyVerdict()`, or any
verdict literal (INV-A/INV-D); running it neither ships nor gates RC2, it only
produces the number RC2's own sequencing gate is waiting on.

**Measured baseline (2026-08-10, 60-PR window): 41% catch rate — 16 caught / 39
reviewed (21 not-reviewed, excluded from the denominator).** This is the number
the AC1 sequencing gate was waiting on; it is materially different from the
issue's original 0/36 figure and is direct evidence the
`CHANGES_REQUESTED`-only method undercounted, since several of the 16 catches
are FAILs recorded only as an `Automated QA failed` bounce comment on the linked
issue — structurally invisible to that method. Re-run `npm run qa:catch-rate
-- --limit 60` after any further fan-out change to refresh this baseline; AC6's
post-lever 5h share scan is the complementary measurement.

## Never end a turn on a pending wait (issue #3953)

A backgrounded wait is **structurally unrecoverable**: end the turn while a
result is still pending and the result is delivered to a session that has
already exited — the only path back is an external `SendMessage` resume. In
autopilot run `028f420d` (2026-08-11) a `qa_orch` dispatch said *"I'll wait for
the monitor to report settlement, then post final verdicts"* and stopped;
**7 completed PR reviews were never posted as verdicts** until an operator
resumed it.

This skill's single-pass-exit design already obeys this rule for CI: it checks
CI state **once**, emits `PASS-pending-CI` / `FAIL-pending-CI`, and **exits**
(issue #405 — it deliberately does NOT loop on CI; an earlier version looped on
`mutation-test: QUEUED` for hours and let PR #403 auto-merge before a correct
`FAIL` landed). That design is **unchanged**. The contract below generalises the
existing **Blocking-dispatch mandate** (`run_in_background: false` on every
reviewer `Agent` spawn, issue #3880) to *every* backgrounding mechanism a QA
dispatch can reach — a `Monitor`, a backgrounded bash, a reviewer spawn missing
the flag.

**The rule: a turn ends only when every spawned reviewer has returned a real
result (step 7.5) and the verdict is posted.** If something you need is not
ready, either block on it in the FOREGROUND (bounded poll below) or post the
verdict you can stand behind now. Do not background a wait and stop.

**Foreground bounded poll.** For pending CI specifically, do NOT poll — check
once, emit `PASS-pending-CI`, and exit; the autopilot re-polls CI on its tick
(the single-pass-exit design above). Reach for the bounded loop below only when
the dispatch must observe some other process to completion in-turn and cannot
exit partial. It is a BOUNDED poll (one fixed budget, expiry → post the
verdict below) — NOT the unbounded CI re-poll that issue #405 retired; do not
confuse the two:

```bash
# BOUNDED FOREGROUND POLL — block in THIS turn until the observed $PR settles.
# This is the foreground alternative to backgrounding a Monitor/wait and ending
# the turn.
#
# zsh $status pitfall: name the state variable `run_state` (or `st`), never
# `status` — zsh aliases `$status` to `$?`, so assigning a value to a variable
# named `status` silently fails and the loop exits 1. `status` is the natural
# spelling of this variable; that is exactly why the loop breaks. (Documented
# CLAUDE.md pitfall.)
deadline=$((SECONDS + 600))            # 10-min budget; size to your slowest check
while [ "$SECONDS" -lt "$deadline" ]; do
  run_state=$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
    --jq 'if ([.statusCheckRollup[]?.status]
           | any(IN("QUEUED","IN_PROGRESS","PENDING","WAITING")))
          then "pending" else "settled" end' 2>/dev/null)
  [ "$run_state" = "settled" ] && break
  sleep 15
done
# run_state == "settled"  => every check is terminal: read conclusions and post
#                            the final verdict.
# still "pending" past the deadline => budget expired: fall through to the
#                            partial-but-posted branch below — post the verdict
#                            you can stand behind now, with state as of the last
#                            poll. NEVER re-arm the loop; one bounded budget.
```

**Prefer a partial-but-posted verdict over a pending one.** If the budget
expires, post the verdict the review supports now — `PASS-pending-CI` for a
review-PASS awaiting CI, or the review report with the un-settled state
recorded as of the last poll — never a prose *"I'll wait and post later"*. A
verdict the autopilot can act on beats one only an external resume can finish.

## Process

### 1. Select issue

If `$issue_number` provided, use it. Otherwise:
```bash
gh issue list --repo gaberoo322/hydra --label "needs-qa" --state open \
  --json number,title --jq '.[0]'
```
None → report and stop.

### 2. Find linked PR

```bash
gh pr list --repo gaberoo322/hydra --state open --json number,title,body,headRefOid,baseRefName,labels \
  --jq '.[] | select(.body | test("closes #'$issue_number'|Closes #'$issue_number'|fixes #'$issue_number'|Fixes #'$issue_number'"; "i"))'
```

If no PR, check linked branches:
```bash
gh issue develop --list $issue_number --repo gaberoo322/hydra
```

If still no PR → comment on issue and stop.

### 3. Pin the fixed point (upstream `review` step 1)

The fixed point for the diff is **the PR's base ref at the time QA runs** — typically `origin/master`. Pin it explicitly so both sub-agents diff against the same commit:

```bash
PR_VIEW_JSON=$(gh pr view $pr_number --repo gaberoo322/hydra \
  --json baseRefName,mergeStateStatus,headRefName,labels)
FIXED_POINT=$(printf '%s' "$PR_VIEW_JSON" | jq -r '.baseRefName')
# mergeStateStatus (DIRTY ⇒ defer) is read by the reviewer admission gate at
# step 6.6 — fetched here in the SAME gh pr view call, so the gate adds no new
# state surface (INV-G: no new Redis key / label / CI check / API endpoint).
MERGE_STATE_STATUS=$(printf '%s' "$PR_VIEW_JSON" | jq -r '.mergeStateStatus // ""')
# GLM provenance (issue #4460 INV-7): headRefName and labels ride the SAME
# step-3 call. The OR-predicate below is byte-identical to collect-state.sh's
# #4460 classifier (INV-3a) and #4048's lane predicate — `glm-authored` label
# OR a `worktree-agent-glm-` head-branch prefix. Since #4766 GLM_AUTHORED
# selects COMMENT WORDING only, never the bounce label (see qa_bounce_label
# below): the GLM drainer skips open-PR anchors, so a GLM-authored PR's
# bounce comment still explains why the resume lane owns the retry.
GLM_AUTHORED=0
if printf '%s' "$PR_VIEW_JSON" | jq -r '.headRefName // ""' | grep -q '^worktree-agent-glm-'; then
  GLM_AUTHORED=1
elif printf '%s' "$PR_VIEW_JSON" | jq -r '.labels[].name' | grep -Fxq 'glm-authored'; then
  GLM_AUTHORED=1
fi
# Bounce-label helper (issue #4766) — THE one definition of which lane a QA
# bounce (step 6.6 defer, step-10 T1/T2/T3 FAIL — also the landing zone of
# the skip-required-failed short-circuit — and step-10 T4 1st deep-QA FAIL)
# writes. Keys on whether the PR is STILL OPEN at bounce time, not on GLM
# provenance: any open PR goes to `needs-dev-resume`, the label
# collect-state.sh's orch_dev_resume_pick (#4518, non-GLM) and
# orch_glm_red_forward_fix (#4460, GLM) both consume, because
# `ready-for-agent` on an open PR is a FRESH dev pick — it opens a duplicate
# PR while the branch waits for its resume. `ready-for-agent` only when a
# LIVE read confirms the PR is no longer open (CLOSED/MERGED); any failed or
# empty read defaults to `needs-dev-resume` (step 2 only admits open PRs, so
# OPEN is the prior — a false needs-dev-resume on a closed PR is recoverable
# by hand; a false ready-for-agent on an open PR is not). The read is
# per-CALL, deliberately not step 3's PR_VIEW_JSON snapshot: step 10 runs
# after a multi-minute reviewer fan-out, exactly the window in which a
# close/merge could make the snapshot stale.
qa_bounce_label() {
  QA_PR_STATE=$(gh pr view "$pr_number" --repo gaberoo322/hydra \
    --json state --jq '.state // ""' 2>/dev/null || echo "")
  if [ "$QA_PR_STATE" = "CLOSED" ] || [ "$QA_PR_STATE" = "MERGED" ]; then
    echo "ready-for-agent"
  else
    echo "needs-dev-resume"
  fi
}
# Resolve to a SHA so a concurrent push to master doesn't shift the diff under us.
git fetch origin "$FIXED_POINT"
FIXED_SHA=$(git rev-parse "origin/${FIXED_POINT}")
DIFF_CMD="git diff ${FIXED_SHA}...HEAD"
LOG_CMD="git log ${FIXED_SHA}..HEAD --oneline"
```

Pass `FIXED_SHA`, `DIFF_CMD`, and `LOG_CMD` to both sub-agents verbatim.

### 4. Resolve the spec source — design-concept artifact

The PR body must reference an issue via `Closes #N` / `Fixes #N` / `Refs #N`. Extract the parent issue number, then resolve the **persisted** artifact through the QA-time resolve endpoint (issue #1450):

```bash
PARENT_ISSUE=$(gh pr view $pr_number --repo gaberoo322/hydra --json body \
  --jq '.body' | grep -oiP '(?:closes|fixes|refs)\s*#\K\d+' | head -1)

# /resolve is the single retrievability path: it reads the DURABLE Redis
# artifact via its stable canonical handle and discriminates found vs missing.
# 200 → {found:true, handle, concept:{...flat artifact..., gate}}.
# 404 → {found:false, handle, reason}  (a loud, structured miss — never a bare
#        null and never an ephemeral grill artifact).
# anchorRef may be the issue number ("1450") or canonical ("issue-1450"); the
# seam canonicalizes either, so the handle a producer persisted under and the
# handle we read from always agree.
RESOLVE_JSON=$(curl -sS --max-time 5 \
  "http://localhost:4000/api/design-concepts/${PARENT_ISSUE}/resolve" \
  2>/dev/null || echo "")
RESOLVE_FOUND=$(printf '%s' "$RESOLVE_JSON" | jq -r '.found // false' 2>/dev/null || echo false)
```

**Resolve-envelope shape.** `RESOLVE_JSON` is the discriminated result —
`.found` (bool) and `.handle` (`{anchorRef, redisKey, apiPath}`) are ALWAYS
present. On a hit the artifact nests under `.concept`; on a miss `.reason`
carries the loud, handle-named explanation.

**The Spec sub-agent input stays FLAT (ADR-0008).** Extract the inner artifact
once with `jq '.concept'` and hand THAT to the Spec sub-agent — it still reads
`.anchorRef`, `.scope`, `.invariants`, `.qaTrace`, `.modulesTouched`, `.gate`,
etc. at the top level (the `.concept` envelope is the resolve route's wrapper,
not part of the artifact the sub-agent consumes — `.concept.invariants` is the
WRAPPED path, `.invariants` is the path INSIDE `SPEC_INPUT_JSON`).

Decide what to do with the result:

```bash
MODE="${DESIGN_CONCEPT_MODE:-warn}"   # warn (Phase A) | enforce (Phase B/C)
# Check the PR label first (operator-only override path — design-concept-exempt
# ONLY; a cleanup-scan label on the PR itself never bypasses Spec), then fall
# back to the parent issue label. On the parent-issue arm accept EITHER
# design-concept-exempt OR cleanup-scan: cleanup-scan is now the load-bearing
# exemption key for cleanup-filed issues (some filing paths other than
# hydra-cleanup-emit.ts skip the exempt label — issue #4431), so QA skips the
# Spec axis cleanly instead of logging a resolve MISS and falling through to
# Phase A shadow mode (issue #3013).
HAS_PR_EXEMPT_LABEL=$(
  gh pr view $pr_number --repo gaberoo322/hydra \
    --json labels --jq '.labels[].name' | grep -Fxq 'design-concept-exempt' \
  && echo 1 || echo 0
)
HAS_ISSUE_EXEMPT_LABEL=0
HAS_ISSUE_CLEANUP_SCAN_LABEL=0
HAS_ISSUE_DESIGN_CONCEPT_EXEMPT_LABEL=0
if [ -n "$PARENT_ISSUE" ]; then
  ISSUE_LABELS=$(
    gh issue view $PARENT_ISSUE --repo gaberoo322/hydra \
      --json labels --jq '.labels[].name'
  )
  printf '%s\n' "$ISSUE_LABELS" | grep -Fxq 'cleanup-scan' \
    && HAS_ISSUE_CLEANUP_SCAN_LABEL=1 || HAS_ISSUE_CLEANUP_SCAN_LABEL=0
  printf '%s\n' "$ISSUE_LABELS" | grep -Fxq 'design-concept-exempt' \
    && HAS_ISSUE_DESIGN_CONCEPT_EXEMPT_LABEL=1 || HAS_ISSUE_DESIGN_CONCEPT_EXEMPT_LABEL=0
  if [ "$HAS_ISSUE_CLEANUP_SCAN_LABEL" = "1" ] || [ "$HAS_ISSUE_DESIGN_CONCEPT_EXEMPT_LABEL" = "1" ]; then
    HAS_ISSUE_EXEMPT_LABEL=1
  fi
fi
SPEC_SKIPPED_REASON=""

if [ "$RESOLVE_FOUND" = "true" ]; then
  # Have a real PERSISTED artifact — unwrap the flat artifact for the Spec
  # sub-agent (unless exempt-labelled).
  SPEC_INPUT_JSON=$(printf '%s' "$RESOLVE_JSON" | jq -c '.concept')
elif [ "$HAS_PR_EXEMPT_LABEL" = "1" ]; then
  # Operator override (PR label). Skip Spec axis with audit log.
  SPEC_SKIPPED_REASON="design-concept-exempt label present (operator override)"
elif [ "$HAS_ISSUE_EXEMPT_LABEL" = "1" ]; then
  # Deterministic-exempt class (parent issue label — cleanup-scan or
  # design-concept-exempt; cleanup-scan is the load-bearing key, #4431).
  # Skip Spec axis with audit log, naming the SPECIFIC key that fired so the
  # audit trail can tell the two apart (INV-4, #4431 review fix): prefer
  # cleanup-scan when both are present since it is the load-bearing key.
  if [ "$HAS_ISSUE_CLEANUP_SCAN_LABEL" = "1" ]; then
    SPEC_SKIPPED_REASON="cleanup-scan label present on parent issue (deterministic-exempt class)"
  else
    SPEC_SKIPPED_REASON="design-concept-exempt label present on parent issue (deterministic-exempt class)"
  fi
elif [ "$MODE" = "enforce" ]; then
  # Phase B/C — hard fail. Surface the resolver's loud, handle-named reason so
  # the operator sees exactly WHERE the artifact was looked for (issue #1450).
  MISS_REASON=$(printf '%s' "$RESOLVE_JSON" | jq -r '.reason // "design-concept artifact missing"' 2>/dev/null || echo "design-concept artifact missing")
  MISS_HANDLE=$(printf '%s' "$RESOLVE_JSON" | jq -r '.handle.redisKey // "(handle unknown)"' 2>/dev/null || echo "(handle unknown)")
  gh pr comment $pr_number --repo gaberoo322/hydra --body \
    "> *Automated QA — design-concept artifact required*

This PR cannot be reviewed because the design-concept artifact for issue #${PARENT_ISSUE} is not persisted/retrievable.

**Resolver reason:** ${MISS_REASON}
**Stable handle probed:** \`${MISS_HANDLE}\`

**To unblock:**
1. Run \`hydra-grill\` on issue #${PARENT_ISSUE} to produce the artifact, OR
2. Apply the \`design-concept-exempt\` label (operator-only — audit-logged) to bypass the Spec axis.

QA mode: \`${MODE}\`. See [epic #437](https://github.com/gaberoo322/hydra/issues/437) for the design-concept gate rollout plan."
  exit 0
else
  # Phase A warn — log the resolver's LOUD reason (handle named) and skip the
  # Spec axis. Issue #1450: a missing artifact is logged loud with its handle,
  # never silently worked around (no recordAnchorReflection fallback).
  MISS_REASON=$(printf '%s' "$RESOLVE_JSON" | jq -r '.reason // "design-concept artifact missing (resolve unreachable)"' 2>/dev/null || echo "design-concept artifact missing (resolve unreachable)")
  echo "WARN: ${MISS_REASON} — proceeding in Phase A shadow mode (Standards axis only)." >&2
  SPEC_SKIPPED_REASON="no persisted artifact (Phase A shadow mode — DESIGN_CONCEPT_MODE=${MODE}): ${MISS_REASON}"
fi
```

The `design-concept-exempt` bypass MUST emit an audit comment so operators can review usage. Append to the eventual PR comment:

```
> _Spec axis skipped: ${SPEC_SKIPPED_REASON}_
```

### 5. Collect current CI state (two reads, no polling)

`statusCheckRollup` carries **no required-ness** — the rollup entries expose only
`__typename, completedAt, conclusion, detailsUrl, name, startedAt, status,
workflowName` (plus `context`/`state` on commit-status rows), so the pre-#4757
fetch, which read the rollup's absent required-ness flag, always yielded `false`
and every required-check gate downstream (`skip-required-failed`,
`RED_REQUIRED_LIST`) saw zero required checks. Required-ness is sourced from
**branch protection** instead — the same ONE `gh api
.../required_status_checks` read collect-state.sh's glm-red classifier makes
(#4460 INV-4) — and the whole rollup fold (normalisation, de-duplication by
name keeping the latest, StatusContext folding, absent-required synthesis,
required-marking) lives in the ONE pure helper `buildCheckStates`
(`scripts/ci/qa-verdict.ts`), reached through the ONE shared fetch fragment so
the two call sites (here and the autopilot's `qa-verdict` builder) cannot
drift (issue #4757):

```bash
PR_NUMBER="$pr_number"
@include _fragments/checks-fetch.md
# INV-7 fallback: the shared fetch failed (contexts or rollup unreadable) —
# the QA verdict must still be produced, so fall back to the legacy
# rollup-only mapping with every check optional (today's behaviour; branch
# protection remains the real merge gate, and the autopilot builder
# independently holds PENDING on its own failed read).
if [ -z "$CHECKS_JSON" ]; then
  echo "WARN: checks-fetch failed — falling back to the legacy rollup-only mapping (every check optional, issue #4757 INV-7)" >&2
  [ -n "$ROLLUP_JSON" ] || ROLLUP_JSON=$(gh pr view $pr_number --repo gaberoo322/hydra \
    --json statusCheckRollup --jq '.statusCheckRollup' 2>/dev/null || true)
  CHECKS_JSON=$(printf '%s' "$ROLLUP_JSON" | jq -c \
    'map({name: (.name // .context), status: ((.status // "completed") | ascii_downcase), conclusion: (.conclusion | if . == null then null else ascii_downcase end), required: false})' 2>/dev/null) \
    || CHECKS_JSON=""
fi
```

GitHub returns `status`/`conclusion` as UPPERCASE enums (`QUEUED`, `COMPLETED`, `SUCCESS`). `buildCheckStates` folds them to the lowercase-canonical tokens the classifier's `PENDING_STATUSES` / `SUCCESS_CONCLUSIONS` sets match (issue #761; the fallback's `ascii_downcase` does the same). The classifier ALSO folds casing internally as defense in depth, so this is belt-and-braces — but keeping the emitted JSON lowercase-canonical makes `CHECKS_JSON` self-describing and matches the documented `CheckStatus` union.

Pass `CHECKS_JSON` to the verdict classifier at the end — not to the sub-agents.

### 6. Tier-1 auto-bypass check

Inspect the diff. If every changed file is a prompt path per `isPromptOnlyChange()` (the ONE prompt-path list in `scripts/ci/qa-verdict.ts`, shared with step 6.7's change shape — playbook/skill `.md`, `config/agents/`, `config/feedback/`) AND no artifact is present AND no `design-concept-exempt` label, the Spec axis is auto-bypassed (per issue #440 — prompt-only PRs never require the artifact). This is the **only** auto-bypass; Tier ≥ 2 PRs always run the Spec axis (or fail in `enforce` mode).

```bash
CHANGED=$(git diff --no-renames --name-only "${FIXED_SHA}...HEAD")
# Fail-closed: a helper failure prints nothing, so TIER1_ONLY stays 0 (no bypass).
TIER1_ONLY=$(CHANGED="$CHANGED" node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({isPromptOnlyChange}) => {
    process.stdout.write(isPromptOnlyChange(process.env.CHANGED.split('\n')) ? '1' : '0');
  }).catch((e) => { console.error('WARN: isPromptOnlyChange failed:', e); });
")
[ "$TIER1_ONLY" = "1" ] || TIER1_ONLY=0

if [ "$TIER1_ONLY" = "1" ] && [ -z "$SPEC_INPUT_JSON" ] && [ -z "$SPEC_SKIPPED_REASON" ]; then
  SPEC_SKIPPED_REASON="Tier-1 auto-bypass (diff is prompt-only and no artifact present)"
fi
```

### 6.5 Resolve the PR's Modification Tier (issue #739)

Classify the diff via the live tier API — the single tier authority. Never infer tier from path patterns.

```bash
CHANGED=$(git diff --no-renames --name-only "${FIXED_SHA}...HEAD" | paste -sd, -)
TIER_JSON=$(curl -fsS --max-time 5 \
  "http://localhost:4000/api/tier?files=$(printf '%s' "$CHANGED" | jq -sRr @uri)" \
  2>/dev/null || echo "")
PR_TIER=$(printf '%s' "$TIER_JSON" | jq -r '.tier // empty' 2>/dev/null)
# Unreachable classifier → default to the deeper (adversarial) path: safer to
# over-verify than to silently downgrade a core change to a single pass.
ADVERSARIAL=0
if [ -z "$PR_TIER" ]; then
  echo "WARN: tier classifier unreachable — defaulting to T3 adversarial QA (over-verify)."
  ADVERSARIAL=1
elif [ "$PR_TIER" -ge 3 ] 2>/dev/null; then
  ADVERSARIAL=1   # T3 (and T4, which inherits T3 depth)
fi
```

- `ADVERSARIAL=0` → T1/T2: one standard pass (the single Standards + Spec fan-out, step 7 as written).
- `ADVERSARIAL=1` → T3/T4: the two-reviewer refutation fan-out (step 7's T3 branch).

### 6.6 Reviewer admission gate — skip the fan-out when no reviewer can change the verdict (issue #3815)

Before spawning any reviewer, ask the one question that justifies the fan-out's
cost: **can a reviewer's output still change the emitted verdict on this pass?**
If not, the entire 2-4-agent fan-out (the second-largest token consumer in the
system) is dead work. The gate is a **derivation of the verdict fold in
`scripts/ci/qa-verdict.ts`, never an independent policy** (INV-A): it skips
reviewers ONLY where `classifyVerdict` / `aggregateAdversarialReview` provably
make their output moot. It changes no verdict literal, no merge semantic, and
`decide.py`'s `should_auto_merge()` (INV-D); it never reduces T4 depth (INV-B);
it fail-closes to full depth on every unknown (INV-E).

The gate reads only data already in hand — `CHECKS_JSON` (step 5), the tier
(step 6.5), and `MERGE_STATE_STATUS` (the one field added to step 3's existing
`gh pr view` call — no new Redis key, label, CI check, or API endpoint, INV-G) —
and returns one of three actions:

- **`admit`** → run the full fan-out at step 7 (the common path: every clean,
  green PR).
- **`defer`** → a non-reviewable blocker makes the verdict moot this pass:
  `mergeStateStatus == DIRTY` (a merge conflict — the diff under review is not
  the diff that will merge), OR a T4 PR with a required check already failed
  (T4 may only be deferred, never depth-reduced — INV-B). **No verdict emitted.**
- **`skip-required-failed`** → a required CI check has already concluded failure
  on a T1/T2/T3 PR; `classifyVerdict` returns `FAIL` regardless of the review, so
  the review is moot. The gate carries the `FAIL` verdict the fold already
  determined (a skipped review never yields PASS — INV-D).

```bash
# PR_TIER is the string from step 6.5 ("" when the classifier was unreachable).
# The predicate fail-closes to admit on a null tier / unknown mergeState (INV-E).
PR_TIER_NUM=$(printf '%s' "$PR_TIER" | jq -r 'tonumber? // empty' 2>/dev/null || true)
GATE_JSON=$(CHECKS_JSON="$CHECKS_JSON" MERGE_STATE_STATUS="$MERGE_STATE_STATUS" \
  PR_TIER_NUM="$PR_TIER_NUM" node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({decideReviewAdmission}) => {
    const tier = process.env.PR_TIER_NUM === '' ? null : Number(process.env.PR_TIER_NUM);
    const d = decideReviewAdmission({
      checks: JSON.parse(process.env.CHECKS_JSON),
      mergeStateStatus: process.env.MERGE_STATE_STATUS,
      tier,
    });
    process.stdout.write(JSON.stringify(d));
  }).catch((e) => {
    // Fail-closed on the gate SCRIPT's own runtime error (malformed
    // CHECKS_JSON with no upstream fallback, a throw inside
    // decideReviewAdmission, a dynamic-import failure) — distinct from bad
    // *inputs* to decideReviewAdmission, which the 13-case regression suite
    // already covers as fail-closed-to-admit. Without this .catch(), Node's
    // unhandled-rejection default crashes the process before GATE_JSON is
    // ever written, leaving nothing for the bash fallback below to read
    // (issue #3815, PR #3874 adversarial-QA FAIL finding).
    process.stdout.write(JSON.stringify({ action: 'admit', reason: 'gate script runtime error, fail-closed to full review: ' + (e && e.message ? e.message : String(e)) }));
  });
" 2>/dev/null || echo "")
GATE_ACTION=$(printf '%s' "$GATE_JSON" | jq -r '.action // empty' 2>/dev/null)
GATE_REASON=$(printf '%s' "$GATE_JSON" | jq -r '.reason // empty' 2>/dev/null)
# Belt-and-braces else-branch (previously undocumented — same FAIL finding):
# an empty/malformed GATE_JSON (the node process itself failed to start, the
# subshell failed, or jq couldn't parse the output) still fails closed to the
# full fan-out, mirroring step 6.5's "unreachable classifier -> deeper path"
# default (INV-E).
if [ -z "$GATE_ACTION" ]; then
  echo "WARN: reviewer admission gate produced no action — fail-closed to admit (full fan-out)."
  GATE_ACTION="admit"
  GATE_REASON="gate script produced no output; fail-closed to full review"
fi

# Red REQUIRED checks (issue #4460 INV-7; one definition since #4746) —
# `redRequiredChecks()` is the SAME helper classifyVerdict counts, so
# RED_REQUIRED_LIST (quoted in bounce comments + the worst-finding summary)
# and the skip path's BLOCKERS can never disagree with the verdict. Empty when
# every required check is green/pending. No new fetch — step 5's CHECKS_JSON.
# >>> red-required-checks
RED_REQUIRED_JSON=$(CHECKS_JSON="$CHECKS_JSON" node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({redRequiredChecks}) => {
    process.stdout.write(JSON.stringify(redRequiredChecks(JSON.parse(process.env.CHECKS_JSON || '[]'))));
  }).catch((err) => { console.error('[hydra-qa] redRequiredChecks failed:', err); process.exit(1); });
") || RED_REQUIRED_JSON=""
RED_REQUIRED_LIST=$(printf '%s' "$RED_REQUIRED_JSON" | jq -r 'join(", ")' 2>/dev/null || echo "")
# <<< red-required-checks
```

**Route on `GATE_ACTION`:**

- **`admit`** — proceed to step 7 (the full fan-out). Nothing is skipped. This
  is also the fail-closed default when the gate script itself errors or
  produces no output (see the `.catch()` and the empty-`GATE_ACTION` fallback
  above) — an unrecognized/empty action is never treated as `defer` or
  `skip-required-failed`.

- **`defer`** — the PR cannot merge on this pass. Post a comment and bounce to a
  dev agent via the universal remediation loop. **Do NOT leave `needs-qa` in
  place** — that busy-loops `hydra-qa` every autopilot tick, 30-65k tokens each
  (issue #974); the bounce label (a dev-lane label either way) is the bridging
  label that also avoids the label-less orphan gap (issue #3788). A deferred
  PR is, by construction, one that cannot merge on this pass, so INV-C holds:
  every PR that reaches auto-merge has been reviewed at full depth.
  **Open-PR bounce (issue #4766):** the bounce target comes from step 3's
  `qa_bounce_label` — `needs-dev-resume` while the PR is open, regardless of
  provenance; `ready-for-agent` only when the helper's live read confirms the
  PR is no longer open. Before #4518 `ready-for-agent` was the right lane for
  a non-GLM open PR; since #4518 the durable resume pin (collect-state.sh's
  orch_dev_resume_pick → decide.py's pinned forward-fix, #4460 for the GLM
  variant) owns ANY open PR, so `ready-for-agent` on an open PR just opens a
  duplicate. A GLM-authored PR keeps its own comment wording
  (`$GLM_AUTHORED`) — the GLM drainer skips open-PR anchors — but the label
  is the same. Name the red required check(s) (`$RED_REQUIRED_LIST`) in the
  issue comment when the defer was CI-driven.
  ```bash
  gh pr comment $pr_number --repo gaberoo322/hydra --body "> *Automated QA — review deferred*

  ${GATE_REASON}

  No verdict is being emitted — the PR cannot merge on this pass. The full review (including the Verifier-Core fan-out for a T4 PR) runs once the PR is rebased / CI is green. QA has exited; the autopilot re-queues it when the PR is ready."
  BOUNCE_LABEL=$(qa_bounce_label)
  if [ "$BOUNCE_LABEL" = "needs-dev-resume" ]; then
    gh issue edit $issue_number --repo gaberoo322/hydra \
      --remove-label "needs-qa" --add-label "needs-dev-resume" 2>/dev/null \
      || echo "WARN: failed to re-label issue #$issue_number on defer (non-fatal)"
    if [ "$GLM_AUTHORED" = "1" ]; then
      gh issue comment $issue_number --repo gaberoo322/hydra --body \
        "> *Automated QA — review deferred (GLM-authored PR)*

  ${GATE_REASON}${RED_REQUIRED_LIST:+

  Red required check(s): ${RED_REQUIRED_LIST}}

  Relabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — this PR is GLM-authored with an open PR, which the GLM drainer skips; the autopilot's pinned forward-fix (issue #4460) owns the next attempt on this branch." \
        2>/dev/null || true
    else
      gh issue comment $issue_number --repo gaberoo322/hydra --body \
        "> *Automated QA — review deferred (open PR)*

  ${GATE_REASON}${RED_REQUIRED_LIST:+

  Red required check(s): ${RED_REQUIRED_LIST}}

  Relabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the next attempt on this branch." \
        2>/dev/null || true
    fi
  else
    # Not-open fallback (#4766): live read confirmed CLOSED/MERGED — no open
    # PR remains, so a fresh dev pick is the right lane.
    gh issue edit $issue_number --repo gaberoo322/hydra \
      --remove-label "needs-qa" --add-label "ready-for-agent" 2>/dev/null \
      || echo "WARN: failed to re-label issue #$issue_number on defer (non-fatal)"
  fi
  exit 0
  ```

- **`skip-required-failed`** (T1/T2/T3 only — T4 routes to `defer`) — the review
  is moot because a required check already failed. Compute the FAIL verdict the
  fold already determines and follow the normal step-10 FAIL routing, spawning
  **zero** reviewers. Set a nominal review verdict (the classifier ignores it
  when `requiredFailed > 0`) and compute `VERDICT` / `VERDICT_REASON` /
  `CHECKS_BLOCK` here, then run step 9.5 (the trailer) and jump to step 10's
  FAIL routing for T1/T2/T3 — skip step 7 (no spawn), 7.5, 8, and 9 entirely:
  ```bash
  REVIEW_VERDICT="PASS"   # nominal — classifyVerdict ignores it when requiredFailed > 0
  REVIEW_REPORT="_Review skipped by the admission gate (issue #3815): a required CI check already failed, so the review verdict cannot change the FAIL \`classifyVerdict\` returns regardless of the reviewers' finding._"
  node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({classifyVerdict, renderCiSummary}) => {
    const r = classifyVerdict(process.env.REVIEW_VERDICT, JSON.parse(process.env.CHECKS_JSON));
    process.stdout.write(JSON.stringify({verdict: r.verdict, reason: r.reason, checks: renderCiSummary(r)}));
  }).catch((e) => {
    // Same fail-closed rationale as step 6.6's decideReviewAdmission call
    // above: this branch is only reached because GATE_ACTION already told us
    // a required check failed, so the safe default on the script's OWN
    // runtime error is the FAIL this path was always going to emit — never a
    // crash, never a silent PASS (issue #3815, PR #3874 finding).
    process.stdout.write(JSON.stringify({ verdict: 'FAIL', reason: 'gate re-derivation script runtime error, fail-closed to FAIL: ' + (e && e.message ? e.message : String(e)), checks: '_(checks block unavailable — gate script error)_' }));
  });
  " > /tmp/qa-verdict.json 2>/dev/null || echo '{"verdict":"FAIL","reason":"gate re-derivation script failed to run, fail-closed to FAIL","checks":"_(checks block unavailable — gate script error)_"}' > /tmp/qa-verdict.json
  VERDICT=$(jq -r '.verdict' /tmp/qa-verdict.json)
  VERDICT_REASON=$(jq -r '.reason' /tmp/qa-verdict.json)
  CHECKS_BLOCK=$(jq -r '.checks' /tmp/qa-verdict.json)
  # VERDICT is FAIL (by classifyVerdict on the happy path, or by the fail-closed
  # fallback above on a script error). Each red required check is one high
  # blocker for the QA-Verdict trailer (issue #4729). Run step 9.5, then skip
  # to step 10's FAIL routing for T1/T2/T3 — do not spawn reviewers.
  BLOCKERS=$(printf '%s' "$RED_REQUIRED_JSON" | jq 'length' 2>/dev/null || echo 1)
  [ "${BLOCKERS:-0}" -ge 1 ] 2>/dev/null || BLOCKERS=1
  MAX_SEVERITY=high
  WORST_FINDING="required CI check(s) red: ${RED_REQUIRED_LIST:-see checks block}"
  ```
  This reuses the existing classifier and FAIL routing unchanged — the gate only
  declines to spawn the reviewers whose output is provably moot (INV-A/INV-D).

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

### 6.7 Size the reviewer fan-out by change shape (issue #4733)

Only on `admit`. The tier classifier (Verifier Core) lands most PRs at T3, so a docs-only PR used to pay the 4-sub-agent T3 fan-out. `decideReviewerFanout()` sizes it from the tier plus the changed-file shape (`docs-only | tests-only | prompt-only | code`; any `src/`, `scripts/`, `dashboard/src/`, `.github/` or other non-doc/test/prompt path makes the diff `code`). The tier classifier is not touched.

```bash
FANOUT_JSON=$(PR_TIER_NUM="$PR_TIER_NUM" CHANGED="$CHANGED" node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({decideReviewerFanout}) => {
    const tier = process.env.PR_TIER_NUM === '' ? null : Number(process.env.PR_TIER_NUM);
    process.stdout.write(JSON.stringify(decideReviewerFanout(tier, process.env.CHANGED.split(','))));
  }).catch((e) => { console.error('WARN: decideReviewerFanout failed:', e); });
" || echo "")
FANOUT_MODE=$(printf '%s' "$FANOUT_JSON" | jq -r '.mode // empty' 2>/dev/null)
FANOUT_REVIEWERS=$(printf '%s' "$FANOUT_JSON" | jq -r '.reviewers | join(",")' 2>/dev/null)
FANOUT_REASON=$(printf '%s' "$FANOUT_JSON" | jq -r '.reason // empty' 2>/dev/null)
if [ -z "$FANOUT_MODE" ]; then
  # Fail-closed: keep step 6.5's tier path, never shrink review on a helper failure.
  echo "WARN: fan-out sizing failed — keeping the tier fan-out."
  if [ "$ADVERSARIAL" = "1" ]; then
    FANOUT_MODE=adversarial
    FANOUT_REVIEWERS="reviewer-A-standards,reviewer-A-spec,reviewer-B-standards,reviewer-B-spec"
  else
    FANOUT_MODE=standard
    FANOUT_REVIEWERS="standards,spec"
  fi
  FANOUT_REASON="Review fan-out: ${FANOUT_MODE} — change-shape sizing unavailable, kept the tier path."
fi
[ "$FANOUT_MODE" = "single" ] && ADVERSARIAL=0   # step 9 folds one reviewer's verdict
```

- `FANOUT_MODE=single` → step 7c (one reviewer, both axes). Only T1–T3 PRs whose shape is not `code`.
- `FANOUT_MODE=standard` → step 7a; `FANOUT_MODE=adversarial` → step 7b. A T4 PR or a `code` PR always gets the full fan-out for its tier, and so does an unknown tier.

### 7. Spawn the review sub-agents in parallel (single message, all Agent calls)

**This is the critical step — all `Agent` tool calls MUST be in the same assistant message** so they execute in parallel and do not pollute each other's context. The upstream `code-review` skill (`~/.claude/skills/code-review/SKILL.md`) is the contract; do not re-implement its logic — invoke its process pattern.

**Every `Agent` call in this step MUST pass `run_in_background: false` (issue #3789).** The `Agent` tool defaults to background dispatch, so the spawning call returns immediately and the turn can end while reviewers are still running — a prose instruction to "wait for every reviewer" does not prevent this (a `qa_orch` dispatch said exactly that and exited anyway, four times in one autopilot run — #3789). `run_in_background: false` makes each spawn itself a **blocking** call, so the message containing all N spawns cannot return control — and the turn cannot end — until every reviewer has produced a result. Never substitute `run_in_background: true` plus a promise to wait; that is the pattern that stalled.

#### 7.0 Build the shared review packet once (issue #3815, root cause 3)

Before spawning any reviewer, assemble the **review packet** once and pass it
inline to every sub-agent. Root cause 3 (the issue's headline recommendation):
each reviewer was independently re-running `git diff`, `git show`-ing every
changed file, and re-reading the standards docs — the same exploration 4–6
times per PR. The 5h scan found ~86% of reviewer tokens were `cacheRead` from
this duplicated loop (~1.46M tokens / ~21 API calls per reviewer, ~5.9 reviewer
sessions per PR). The parent already holds the diff and the changed-file list;
building the packet once and forbidding the exploratory tool loop converts each
reviewer from a multi-turn explorer into a single-shot reviewer.

**This changes only HOW reviewers acquire context — never WHAT they judge, how
many run, or the verdict fold.** The emitted verdict literals, the per-reviewer
axis fold (step 9), `aggregateAdversarialReview()`, and the full T3/T4 fan-out
count (2 reviewers / 4 sub-agents) are byte-untouched (issue #3815 AC4/AC5;
design-concept INV-D). It is sequenced as its own PR, distinct from the
admission-gate lever (Lever A, PR #3874) which gates *whether* the fan-out runs
at all; this lever assumes the fan-out runs and makes each reviewer cheaper.

```bash
# The diff the parent already pinned in step 3, captured ONCE (not re-run by
# every reviewer).
DIFF_TEXT=$(git diff "${FIXED_SHA}...HEAD")
# Full contents of every changed file at HEAD, captured ONCE. Each reviewer was
# git-show'ing these individually; inlining them removes that per-reviewer loop.
CHANGED_FILES_PACKET=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  body=$(git show "HEAD:${f}" 2>/dev/null) || body="(file deleted or absent at HEAD — see the diff above)"
  CHANGED_FILES_PACKET+="===== ${f} @ HEAD =====
${body}

"
done <<< "$(git diff --name-only "${FIXED_SHA}...HEAD")"
REVIEW_PACKET="Diff (${FIXED_SHA:0:12}…HEAD):

${DIFF_TEXT}

Full contents of every changed file at HEAD:

${CHANGED_FILES_PACKET}"
# The resolved design-concept artifact ($SPEC_INPUT_JSON from step 4) rides in
# the same packet for the Spec axis rather than being re-fetched per reviewer.
```

**Shared packet discipline (applies to EVERY reviewer sub-agent — both axes,
both tiers, T1 through T4).** Embed `$REVIEW_PACKET` inline at the top of each
reviewer's prompt, then instruct the reviewer:

> *The diff and the full contents of every changed file are in the packet above
> — do NOT reconstruct them. Do NOT run an exploratory tool loop: no `git diff`,
> no `git show`, no repo-wide `grep`/`glob` to "understand the change", and do
> not read `CLAUDE.md` / `CONTEXT.md` / `docs/adr/` end-to-end. Judge straight
> off the packet. You MAY (a) open ONE specific standards doc or ADR by name to
> check a rule you intend to cite, and (b) do at most ONE targeted `read`/`grep`
> to resolve a single named question the packet leaves ambiguous — in each case
> state exactly what you are looking for and why the packet did not answer it.
> If the packet is sufficient, do ZERO tool calls and report directly.*

The packet is the same factual material (diff, file contents, artifact) handed
to every reviewer — it is NOT the other reviewer's findings, so the "neither
reviewer is told the other exists" independence rule (step 7b) is preserved.
The refutation framing (step 7b), the twelve-smell battery, the Hydra-specific
checks, and the T4 Verifier-Core checklist all still apply unchanged — they are
judged against the packet instead of against a self-assembled view of the repo.

#### 7.0a Re-review context after a FAIL (issue #4735)

On a T1–T3 PR whose latest QA verdict was a FAIL with a findings table, give the reviewers the prior findings as extra context. This is prompt context only: reviewers still review the FULL diff and changed files, and `foldReviewFindings()` alone decides the verdict. Nothing is filtered or demoted. The incremental diff since the prior verdict is added only when the prior `sha=` is a commit that is still an ancestor of HEAD with commits since (`decideReReviewScope()`); otherwise it is simply left out. Every unreadable input (a failed `gh` read, a failed `node` call) means no context: a plain first-pass review.

```bash
PRIOR_QA_FILE=$(mktemp)
# >>> rereview-context
PRIOR_FINDINGS=""
REREVIEW_DIFF_BASE=""
PRIOR_QA_JSON=""
if gh pr view "$pr_number" --repo gaberoo322/hydra --json comments,reviews \
     --jq '[.comments[].body, .reviews[].body]' > "$PRIOR_QA_FILE"; then
  PRIOR_QA_JSON=$(PRIOR_QA_FILE="$PRIOR_QA_FILE" PR="$pr_number" node --no-warnings --experimental-strip-types -e "
    Promise.all([import('node:fs'), import('./scripts/ci/qa-verdict.ts')]).then(([fs, q]) => {
      const bodies = JSON.parse(fs.readFileSync(process.env.PRIOR_QA_FILE, 'utf8').trim() || '[]');
      const pr = Number(process.env.PR);
      const prior = q.qaVerdictHistory(bodies, pr).at(-1) ?? null;
      process.stdout.write(JSON.stringify({ prior, findings: prior ? q.priorFindingsSection(bodies, pr, prior.round) : '' }));
    }).catch((err) => { console.error('[hydra-qa] prior QA verdict read failed:', err); process.exit(1); });
  ") || PRIOR_QA_JSON=""
else
  echo "[hydra-qa] WARN: prior QA verdicts unreadable — no re-review context" >&2
fi
PREV_SHA=$(printf '%s' "$PRIOR_QA_JSON" | jq -r '.prior.sha // empty' 2>/dev/null)
ANCESTOR=null
CHANGED_SINCE_JSON=null
if printf '%s' "$PREV_SHA" | grep -Eq '^[0-9a-f]{7,40}$' && git cat-file -e "${PREV_SHA}^{commit}" 2>/dev/null; then
  if git merge-base --is-ancestor "$PREV_SHA" HEAD 2>/dev/null; then
    ANCESTOR=true
    CHANGED_SINCE_JSON=$(git diff --no-renames --name-only "$PREV_SHA" HEAD | jq -Rsc 'split("\n") | map(select(length > 0))') \
      || CHANGED_SINCE_JSON=null
  else
    ANCESTOR=false
  fi
fi
if [ -n "$PRIOR_QA_JSON" ]; then
  CONTEXT_JSON=$(PRIOR_QA_JSON="$PRIOR_QA_JSON" HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)" ANCESTOR="$ANCESTOR" \
    CHANGED_SINCE_JSON="$CHANGED_SINCE_JSON" PR_TIER_NUM="$PR_TIER_NUM" node --no-warnings --experimental-strip-types -e "
    import('./scripts/ci/qa-verdict.ts').then((q) => {
      const e = process.env;
      const p = JSON.parse(e.PRIOR_QA_JSON);
      const tier = e.PR_TIER_NUM === '' || e.PR_TIER_NUM === undefined ? null : Number(e.PR_TIER_NUM);
      // Context only for a T1–T3 PR whose latest prior round FAILed with a findings table.
      const reviewedFail = (tier === 1 || tier === 2 || tier === 3) && p.prior !== null
        && q.isFailVerdict(p.prior.verdict) && String(p.findings).includes('### Findings');
      const scope = q.decideReReviewScope({ tier, prior: p.prior, headSha: e.HEAD_SHA,
        priorShaIsAncestor: JSON.parse(e.ANCESTOR), changedSince: JSON.parse(e.CHANGED_SINCE_JSON), priorFindings: p.findings });
      process.stdout.write(JSON.stringify({
        findings: reviewedFail ? p.findings : '',
        base: reviewedFail && scope.mode === 'incremental' ? scope.baseSha : '',
      }));
    }).catch((err) => { console.error('[hydra-qa] re-review context failed — none added:', err); process.exit(1); });
  ") || CONTEXT_JSON=""
  if [ -n "$CONTEXT_JSON" ]; then
    PRIOR_FINDINGS=$(printf '%s' "$CONTEXT_JSON" | jq -r '.findings // ""') \
      && REREVIEW_DIFF_BASE=$(printf '%s' "$CONTEXT_JSON" | jq -r '.base // ""') \
      || { echo "[hydra-qa] WARN: re-review context unparseable — none added" >&2; PRIOR_FINDINGS=""; REREVIEW_DIFF_BASE=""; }
  fi
fi
# <<< rereview-context
rm -f "$PRIOR_QA_FILE"
```

When `PRIOR_FINDINGS` is non-empty, APPEND the context to the packet. The full diff and changed-file list stay first and are still what the reviewers review:

```bash
if [ -n "$PRIOR_FINDINGS" ]; then
  REVIEW_PACKET="${REVIEW_PACKET}

RE-REVIEW CONTEXT — the previous QA round FAILed with the findings below. Review the FULL change above as usual. In your report, first state fixed/not-fixed for each prior finding; for anything new, prefer medium+ and say why it wasn't visible before.

${PRIOR_FINDINGS}"
  if [ -n "$REREVIEW_DIFF_BASE" ]; then
    REVIEW_PACKET="${REVIEW_PACKET}

Changes since the prior verdict (${REREVIEW_DIFF_BASE}..HEAD), context only:

$(git diff --no-renames "$REREVIEW_DIFF_BASE" HEAD)"
  fi
fi
```

With re-review context, add this **re-review brief** to every reviewer prompt, after the findings contract:

> *This is a re-review after a FAIL. You still review the FULL diff and changed files. First state fixed/not-fixed for each prior finding; for anything new, prefer medium+ and say why it wasn't visible before. Report every finding in the normal `findings` block and grade it honestly: the verdict comes from the normal findings fold, never from this brief.*

#### 7a. T1/T2 — single standard pass (`FANOUT_MODE=standard`)

Spawn exactly two parallel sub-agents — the **Standards** and **Spec** axes described below. This is the unchanged pre-#739 behaviour.

#### 7b. T3/T4 — adversarial fan-out (`FANOUT_MODE=adversarial`)

Run the review in **refutation framing** across **2 independent reviewers**. Each reviewer is its own Standards + Spec pair (the same two-axis contract below), so a T3 fan-out spawns **four** `general-purpose` sub-agents in one message: `reviewer-A-standards`, `reviewer-A-spec`, `reviewer-B-standards`, `reviewer-B-spec`. The two reviewers are **independent** — neither is told the other exists, same context-separation rule as the Standards/Spec split — so one cannot anchor the other.

Prepend the **refutation framing** to every T3 sub-agent prompt, before the axis brief:

> *You are an adversarial reviewer. Your job is to actively find a concrete reason this change is wrong, regresses existing behaviour, or fails to do what it claims — not to confirm it works. Assume there IS a blocker and hunt for it. Only report a finding if you can point to the specific line/behaviour it concerns, and grade it honestly on the severity rubric — refutation framing is about hunting, not about inflating severity; do not invent speculative concerns. If after a genuine adversarial pass you find nothing, say so explicitly and emit an empty findings list.*

Each reviewer (A and B) independently emits its findings (the findings contract below). Step 9 folds them: **T3** — FAIL on any medium/high finding from either reviewer, or a low finding both reviewers raised; lone lows are follow-ups. **T4** — any finding from either reviewer is a FAIL (unchanged).

#### 7c. Docs/tests/prompt-only — single reviewer (`FANOUT_MODE=single`, issue #4733)

Spawn exactly **one** blocking `general-purpose` sub-agent, `reviewer-single`, with `run_in_background: false`. Its prompt carries the Standards brief AND the Spec brief below (both axes, one agent), and asks for the report under two headings, `## Standards` and `## Spec`, so step 8 renders it unchanged. Drop the T3 refutation framing; the smell battery, Hydra checks and the findings contract still apply. Step 9 folds its findings: one reviewer can never trip the both-reviewers rule, so only a medium/high finding FAILs.

**Findings contract (issue #4734 — every reviewer sub-agent, every fan-out mode).** Every prompt carries this block verbatim, after the axis brief:

> *Report every finding as one row of a fenced `json` block titled `findings`. Each row carries a severity, the exact `file:line`, what is wrong, and a concrete fix:*
>
> ```json
> [{"severity": "high|medium|low", "location": "path/to/file.ts:42", "finding": "what is wrong, in one sentence", "fix": "the concrete change that resolves it"}]
> ```
>
> *Grade each row on this rubric, and do not inflate:*
> - *`high` — behaviour regression, data or work loss, or a weakened safety gate (example: a `catch` that now swallows a Redis error the caller relied on).*
> - *`medium` — a spec criterion unmet, or a real bug on a non-critical path (example: an acceptance criterion from the artifact has no implementation).*
> - *`low` — wording, comments, citations, style (example: a doc comment cites the wrong issue number).*
>
> *Use `PR body` as the location for a finding about the PR description. Emit `[]` when you have no findings. After the block, write ONE short paragraph (≤ 80 words) summarising your axis — do not repeat the rows, and do not restate CI state (the parent reports CI once).*
>
> *Class sweep (issue #4735): when you raise a finding, search the whole diff and every touched file for other instances of the same defect class, and list every instance in this round, one row each. Do not leave any for a later round. When there are 3 or more instances, or the inputs are adversarial (parsers, quoting, guards, untrusted strings), recommend the structural fix in `fix` (a tokenizer, a shared helper, a property test), not another point patch.*

Judgement calls that are not defects do not go in the findings list. On T1–T3 a lone `low` finding does not block (step 9), so there is no reason to escalate a nit to `medium` to be heard; it is listed as a follow-up.

**Standards sub-agent prompt** — include:

- `$REVIEW_PACKET` inline (the diff + full changed-file contents), per the shared packet discipline in step 7.0. `FIXED_SHA` is for reference only — the reviewer does NOT run `git diff` / `git show` or an exploratory tool loop.
- The standards-source files the reviewer MAY open by name (one, to cite a specific rule — not read end-to-end): `CLAUDE.md`, `CONTEXT.md`, `docs/adr/*.md`, `docs/agents/*.md`, `.editorconfig` (machine-enforced — note but don't re-check), `tsconfig.json`, any `STYLE.md` / `STANDARDS.md`.
- Brief: *"The diff and changed-file contents are in the packet — judge off it, with no exploratory tool loop (step 7.0 packet discipline). Report every place the diff violates a documented standard as a row in the findings contract, citing the standard (file + the rule) inside the row's `finding`. Leave judgement calls out of the list. Skip anything tooling enforces (typecheck, lint — CI already runs these). Findings block plus one paragraph, under 400 words."*
- **Attributing a failing test (issue #1076):** QA reads CI results via `statusCheckRollup` and must not `gh pr checkout`. If you do need to reproduce a test failure locally inside an isolated worktree, run `npm run test:debug` rather than `npm test` + a re-run-and-grep: it runs the identical flags (including `--test-force-exit`) but writes a TAP stream to `test-debug.tap`, so the per-test `not ok <n> - <name>` lines (which the default reporter drops under force-exit) and the `# pass/# fail` footer are both captured in a single run. The failing suite name is then greppable from the file without a second full-suite invocation.
- **Refactoring-smell battery (Martin Fowler, via upstream `code-review` v1.1).** In addition to the documented standards, scan the diff for these twelve smells and **name each one you find** so the finding is actionable — apply them universally **unless a repo-documented standard explicitly overrides**. Report a smell only where you can point at the specific hunk; do not invent speculative concerns.
  - **Mysterious Name** — function/variable/type names that obscure intent. Fix: rename clearly; if no honest name fits, the design needs rethinking.
  - **Duplicated Code** — identical logic across hunks/files. Fix: extract shared logic into one place and call it.
  - **Feature Envy** — a method accessing another object's data more than its own. Fix: relocate the method onto the object it envies.
  - **Data Clumps** — the same fields/parameters travelling together repeatedly. Fix: bundle into a dedicated type.
  - **Primitive Obsession** — primitives standing in for domain concepts. Fix: a small focused type for the concept.
  - **Repeated Switches** — the same switch/if-cascade on identical types across the codebase. Fix: polymorphism or a shared map.
  - **Shotgun Surgery** — one logical change scattered across many files. Fix: consolidate related changes into one module.
  - **Divergent Change** — one file edited for multiple unrelated reasons. Fix: split so each module changes for one reason.
  - **Speculative Generality** — abstraction added for future needs the spec doesn't require. Fix: delete; inline until a real need emerges.
  - **Message Chains** — long chained calls like `a.b().c().d()`. Fix: hide navigation behind a single method on the origin object.
  - **Middle Man** — a class/function that mostly delegates elsewhere. Fix: call the real target directly.
  - **Refused Bequest** — a subclass ignoring/overriding most inherited behaviour. Fix: replace inheritance with composition.
- Hydra-specific checks the sub-agent must apply:
  - **CONTEXT.md vocabulary** — new identifiers in the diff must either appear in the glossary or be local-scope (test fixtures, private helpers). Flag vocabulary drift.
  - **ADR conformance** — if the diff touches an area governed by an ADR, the change must not contradict it.
  - **CLAUDE.md coding conventions** — `moveItemToLane` lane-mutation discipline (`src/backlog/lanes.ts`), `redis-adapter` / `src/redis/*` access pattern, `eventBus` passed as parameter (not module global), no silent `catch` (every catch logs `console.error` with context OR is annotated `/* intentional: reason */`).
  - **Tier alignment** — the PR body's `Tier: N` line (populated by `hydra-dev` from `/api/tier`) must agree with the artifact's `interfaceImpact` if an artifact is present. `breaking` ⇒ tier ≥ 2.

**Spec sub-agent prompt** — include:

- `$REVIEW_PACKET` inline (the diff + full changed-file contents), per the shared packet discipline in step 7.0. `FIXED_SHA` is for reference only — the reviewer does NOT run `git diff` / `git show` or an exploratory tool loop.
- The artifact JSON (`SPEC_INPUT_JSON`) embedded verbatim, OR the skip reason (`SPEC_SKIPPED_REASON`) — if skipped, this sub-agent reports `"no spec available"` per the upstream `code-review` skill's contract and exits early.
- The PR body (so requirements stated only in the PR description are still visible).
- Brief: *"The artifact and the diff / changed-file contents are in the packet — judge off it, with no exploratory tool loop (step 7.0 packet discipline). Report: (a) requirements the artifact asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for — scope creep (diff touches modules not in `modulesTouched`); (c) invariants the artifact promised to preserve that the diff violates (no corresponding test, or test missing assertion); (d) `interfaceImpact: 'breaking'` claims that lack a corresponding interface-migration commit. Each is a row in the findings contract, quoting the artifact line in its `finding`. Findings block plus one paragraph, under 400 words."*
- Hydra-specific checks the sub-agent must apply:
  - Every `modulesTouched[i].path` is touched in the diff (or noted in the report if absent).
  - No file outside `modulesTouched` is meaningfully changed (test fixtures and trivial type-only imports are not "meaningful").
  - Each `invariants[i]` has corresponding test coverage in the diff.
  - `interfaceImpact: 'breaking'` claims have a corresponding interface-migration commit.

Both sub-agents use the `general-purpose` subagent type. Neither is told the other exists — context separation is the whole point.

### 7.5 Verify every spawned reviewer returned a real result — fail loud on an incomplete fan-out (issue #3789)

Foreground dispatch (step 7's `run_in_background: false`) guarantees each `Agent` call blocks until that reviewer finishes — but the sub-agent can still come back empty: its worktree can be reaped mid-review (this has happened to reviewer sub-agents and to the parent QA agent itself, in the run that filed #3789), it can error out, or return a truncated report. Before step 8 (aggregate) or step 9 (classify), confirm you hold a **real** result for every reviewer you spawned:

The expected set is `$FANOUT_REVIEWERS` from step 6.7:

- `single` (1 spawn): `reviewer-single`, whose report must carry both `## Standards` and `## Spec` (a Spec-skip from step 4/6 is a clean skip). One missing heading = an incomplete fan-out.
- T1/T2 `standard` (2 spawns): a Standards report and a Spec report (or an explicit Spec-skip already accounted for in step 4/6 — that is a clean skip, not a missing result).
- T3/T4 `adversarial` (4 spawns): all of `reviewer-A-standards`, `reviewer-A-spec`, `reviewer-B-standards`, `reviewer-B-spec`.

A "real result" is the reviewer's actual finding text — not a tool error, not an empty/truncated response, not silence. If **any** expected reviewer is missing or non-substantive:

- **Do not** proceed to step 8 or step 9, and never fold a missing reviewer silently into the T3/T4 AND (`aggregateAdversarialReview()`) as an implicit PASS — a verdict built on partial coverage must never look identical to one built on full coverage. This is stricter than "uncertain, lean FAIL": **no verdict at all** is emitted.
- Post a PR comment naming exactly which reviewer(s)/axis are missing, e.g.:
  ```
  > *Automated QA — incomplete review fan-out*

  This review spawned 4 reviewer(s) but only 2 returned a result.

  **Missing:** reviewer-B-standards, reviewer-B-spec

  No verdict is being emitted — a verdict computed from a partial reviewer set would silently claim coverage it does not have (issue #3789).
  ```
- Leave `needs-qa` on the source issue **untouched** — do not strip it, add `ready-for-agent`, or run the FAIL lesson-capture in step 11. A lost reviewer is a review-infrastructure failure, not a code defect, so the next `hydra-qa` dispatch should pick the issue back up and re-run the **full** fan-out from scratch in a fresh worktree.
- Exit the skill here — do not retry the missing reviewer(s) inline in this same run.

### 8. Aggregate — the findings table (issue #4734)

Transcribe every reviewer's `findings` rows into ONE JSON array in a file, adding the two fields the parent knows: `axis` (`standards` or `spec`) and `reviewer` (the spawned name from `$FANOUT_REVIEWERS`, e.g. `reviewer-A-standards`). Copy rows as written: never drop, merge, or re-grade a reviewer's finding. **Fail closed on malformed output:** if a reviewer's `findings` block is missing, unparseable, or not a JSON array, add that reviewer's raw block text to the array as a plain JSON **string** row (not an object). The fold turns every non-object row into a high `reviewer-output-malformed` finding, which FAILs at every tier, T4 included. Write `[]` only when every reviewer explicitly returned `[]`. The file must always be written: a missing, empty, or unparseable file is itself a FAIL, never an empty list. The fold merges the same finding raised by two reviewers itself: rows whose locations reduce to the same canonical key match (`canonicalLocationKey()`). Accepted location formats, all folded to `path:N` (trimmed, lowercased, leading `./` dropped): `path:12`, `path:L12`, `path#L12`, `path L12`, `path:12-18` (range start), and `path:12:5` (column dropped). A bare `path` with no line keys as `path`. Placeholders never merge on their own: the `NON_MERGEABLE_LOCATIONS` list (empty, `(no location)`, `PR body`, `n/a`, `-`, `none`, case-insensitive) and anything that isn't path-like (contains whitespace, or has no `/` or `.`). If reviewer A and reviewer B describe the same defect at different lines, give both rows the same `"key"` string so the both-reviewers rule can see it. Put each axis's summary paragraph in `STANDARDS_SUMMARY` / `SPEC_SUMMARY`. At T3/T4, join the two reviewers' paragraphs with `A:` / `B:` prefixes. When the Spec axis was skipped, set `SPEC_SUMMARY="_Skipped: ${SPEC_SKIPPED_REASON}_"`.

### 9. Classify the review verdict

The fold and the rendered comment both come from `foldReviewFindings()`, so the verdict, the table and the trailer counts cannot disagree:

- **T1–T3** — the severity-gated fold: FAIL iff any finding is `medium`/`high`, or both reviewers raised the same `low` finding. Lone lows → PASS, listed under **Follow-ups (non-blocking)**.
- **T4, or tier unknown (`PR_TIER` empty — fail-closed)** — unchanged any-blocker semantics: every finding blocks. The fold derives each reviewer's verdict from its own rows (`FAIL` iff reviewer A, or B, raised any finding) and folds them with the unchanged `aggregateAdversarialReview()` AND; any other blocking row, including a malformed-output finding, also FAILs.
- **Malformed input, every tier** — missing, empty, unparseable, or non-array findings, and non-object rows, each become a high `reviewer-output-malformed` finding (logged to stderr). There is no path from malformed reviewer output to PASS.

```bash
FINDINGS_FILE=$(mktemp)   # the step-8 JSON array
# ... write the transcribed findings array into "$FINDINGS_FILE" ...
# >>> severity-fold
FOLD_JSON=$(FINDINGS_FILE="$FINDINGS_FILE" PR_TIER_NUM="$PR_TIER_NUM" \
  STANDARDS_SUMMARY="$STANDARDS_SUMMARY" SPEC_SUMMARY="$SPEC_SUMMARY" FANOUT_REASON="$FANOUT_REASON" \
  RED_REQUIRED_JSON="$RED_REQUIRED_JSON" node --no-warnings --experimental-strip-types -e "
  Promise.all([import('node:fs'), import('./scripts/ci/qa-verdict.ts')]).then(([fs, q]) => {
    const e = process.env;
    const tier = e.PR_TIER_NUM === '' || e.PR_TIER_NUM === undefined ? null : Number(e.PR_TIER_NUM);
    // No default: a missing, empty or unparseable file reaches the fold as
    // undefined / the raw text, which it turns into a high malformed finding.
    let findings;
    try { findings = JSON.parse(fs.readFileSync(e.FINDINGS_FILE, 'utf8')); }
    catch (err) {
      console.error('[hydra-qa] findings file missing or unparseable — failing closed:', err.message);
      try { findings = fs.readFileSync(e.FINDINGS_FILE, 'utf8'); } catch (readErr) { console.error('[hydra-qa] findings file unreadable:', readErr.message); findings = undefined; }
    }
    const fold = q.foldReviewFindings({ tier, findings });
    const counts = q.trailerBlockerCounts(fold, JSON.parse(e.RED_REQUIRED_JSON || '[]'));
    const report = q.renderReviewReport({ fold, standardsSummary: e.STANDARDS_SUMMARY, specSummary: e.SPEC_SUMMARY, fanoutReason: e.FANOUT_REASON });
    process.stdout.write(JSON.stringify({ reviewVerdict: fold.reviewVerdict, report, worst: fold.worstFinding, ...counts }));
  }).catch((err) => { console.error('[hydra-qa] foldReviewFindings failed:', err); process.exit(1); });
") || FOLD_JSON=""
rm -f "$FINDINGS_FILE"
REVIEW_VERDICT=$(printf '%s' "$FOLD_JSON" | jq -r '.reviewVerdict // empty' 2>/dev/null)
REVIEW_REPORT=$(printf '%s' "$FOLD_JSON" | jq -r '.report // empty' 2>/dev/null)
BLOCKERS=$(printf '%s' "$FOLD_JSON" | jq -r '.blockers // empty' 2>/dev/null)
MAX_SEVERITY=$(printf '%s' "$FOLD_JSON" | jq -r '.maxSeverity // empty' 2>/dev/null)
WORST_FINDING=$(printf '%s' "$FOLD_JSON" | jq -r '.worst // empty' 2>/dev/null)
if [ -z "$REVIEW_VERDICT" ]; then
  # Fail loud, never silently PASS: a fold failure is treated as a FAIL with one
  # high blocker, and the reviewers' raw reports are posted instead of the table.
  echo "[hydra-qa] ERROR: severity fold failed — failing closed to FAIL" >&2
  REVIEW_VERDICT=FAIL; BLOCKERS=1; MAX_SEVERITY=high
  WORST_FINDING="severity fold failed — see the raw reviewer reports"
  # The ### Findings heading makes this round count toward the step-10 round cap.
  REVIEW_REPORT="### Findings

_Findings fold failed; raw reviewer reports follow._"   # then append the raw reports
fi
# <<< severity-fold
```

There is no separate T4 cross-check. The earlier `REVIEWER_A_VERDICT` / `REVIEWER_B_VERDICT` block was dead: nothing set those variables. `foldReviewFindings()` already derives each reviewer's verdict from its own rows and runs `aggregateAdversarialReview()` over them, and malformed reviewer output becomes a high finding before the fold runs, so a T4 PR can never PASS on it. Step 10's Deep-QA routing reads this `REVIEW_VERDICT`. The trailer's `blockers=` can never be `0` on a FAIL (`trailerBlockerCounts()` counts at least one).

Then feed `REVIEW_VERDICT` into the one-pass CI classifier (unchanged). The CI state is rendered ONCE, by `renderCiSummary()`, and it lists only the **non-green required** checks. The review report never repeats the per-check table:

```bash
node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({classifyVerdict, renderCiSummary}) => {
    const r = classifyVerdict(process.env.REVIEW_VERDICT, JSON.parse(process.env.CHECKS_JSON));
    process.stdout.write(JSON.stringify({verdict: r.verdict, reason: r.reason, checks: renderCiSummary(r)}));
  }).catch((err) => { console.error('[hydra-qa] classifyVerdict failed:', err); process.exit(1); });
" > /tmp/qa-verdict.json
VERDICT=$(jq -r '.verdict' /tmp/qa-verdict.json)
VERDICT_REASON=$(jq -r '.reason' /tmp/qa-verdict.json)
CHECKS_BLOCK=$(jq -r '.checks' /tmp/qa-verdict.json)
```

The posted comment is therefore: the findings table (severity, axis, reviewer, file:line, finding, fix), the follow-ups table when there are any, one short paragraph per axis, the fold reason and the fan-out line (`$REVIEW_REPORT`), then the verdict line and the one CI line (`$CHECKS_BLOCK`), then the trailer.

### 9.5 Render the `QA-Verdict:` trailer (issue #4729 — every tier, every verdict)

Every verdict comment step 10 posts — PR side and issue side, T1–T4, including the step-6.6 `skip-required-failed` path — ends with exactly ONE canonical line that `npm run qa:catch-rate` and later tooling parse (the human header above it is free to drift; this line is not):

```
QA-Verdict: <PASS|FAIL|PASS-pending-CI|FAIL-pending-CI> pr=<N> round=<k> sha=<head12> blockers=<n> max_severity=<high|medium|low|none>
```

- `BLOCKERS` — computed from the findings table, never hand-counted: `trailerBlockerCounts()` returns the fold's blocking rows (a finding both reviewers raised counts once; non-blocking follow-ups never count) plus one `high` blocker per red **required** check. The `skip-required-failed` path sets `BLOCKERS` to the red-required-check count and `MAX_SEVERITY=high`.
- `MAX_SEVERITY` — the worst **blocking** finding on the step-7 rubric (`high` / `medium` / `low`); `high` whenever a required check is red. `none` when `BLOCKERS=0`: a PASS with follow-ups renders `blockers=0 max_severity=none`, so `qa:catch-rate` still counts it as a clean pass.
- `round` — derived, never hand-set: prior `QA-Verdict:` lines naming this PR + 1.

`BLOCKERS`, `MAX_SEVERITY` and `WORST_FINDING` are already set by step 9's fold (the skip path sets them in step 6.6). Render:

The prior comment/review bodies go through a **file**, never an env var — a PR with many long reviews would blow the 128 KiB per-variable exec limit (`E2BIG`). If the render fails, the block retries once with a minimal trailer built in plain shell from values already in hand; if even that does not parse, the verdict still posts, ending with an explicit `QA-Verdict-Error:` line (which `qa:catch-rate` counts) — never silently trailer-less. An empty/unknown head SHA renders the sentinel `sha=unknown`, which the parser accepts and `qaVerdictShaMatches()` never matches.

```bash
HEAD_SHA=$(gh pr view $pr_number --repo gaberoo322/hydra --json headRefOid --jq '.headRefOid')
PRIOR_BODIES_FILE=$(mktemp)
gh pr view $pr_number --repo gaberoo322/hydra --json comments,reviews \
  --jq '[.comments[].body, .reviews[].body]' > "$PRIOR_BODIES_FILE" \
  || echo "[hydra-qa] WARN: prior-bodies fetch failed — round may undercount" >&2
# >>> qa-verdict-trailer
QA_VERDICT_TRAILER=$(VERDICT="$VERDICT" PR="$pr_number" HEAD_SHA="$HEAD_SHA" \
  BLOCKERS="${BLOCKERS:-0}" MAX_SEVERITY="${MAX_SEVERITY:-none}" PRIOR_BODIES_FILE="$PRIOR_BODIES_FILE" \
  node --no-warnings --experimental-strip-types -e "
  Promise.all([import('node:fs'), import('./scripts/ci/qa-verdict.ts')]).then(([fs, {buildQaVerdictTrailer}]) => {
    const e = process.env;
    const prior = JSON.parse(fs.readFileSync(e.PRIOR_BODIES_FILE, 'utf8').trim() || '[]');
    process.stdout.write(buildQaVerdictTrailer({ verdict: e.VERDICT, pr: Number(e.PR), headSha: e.HEAD_SHA,
      blockers: Number(e.BLOCKERS), maxSeverity: e.MAX_SEVERITY, priorBodies: prior }));
  }).catch((err) => { console.error('[hydra-qa] trailer render failed:', err); process.exit(1); });
") || QA_VERDICT_TRAILER=""
QA_TRAILER_RE='^QA-Verdict: (PASS|FAIL|PASS-pending-CI|FAIL-pending-CI) pr=[1-9][0-9]* round=[1-9][0-9]* sha=([0-9a-f]{7,40}|unknown) blockers=[0-9]+ max_severity=(high|medium|low|none)$'
if ! printf '%s\n' "$QA_VERDICT_TRAILER" | grep -Eq "$QA_TRAILER_RE"; then
  echo "[hydra-qa] WARN: trailer render failed — retrying with a minimal trailer" >&2
  QA_SHA=$(printf '%s' "$HEAD_SHA" | tr 'A-F' 'a-f' | cut -c1-12)
  printf '%s' "$QA_SHA" | grep -Eq '^[0-9a-f]{7,12}$' || QA_SHA=unknown
  QA_PRIOR=$(grep -o "QA-Verdict: [A-Za-z-]* pr=${pr_number} round=" "$PRIOR_BODIES_FILE" 2>/dev/null | wc -l | tr -d ' ')
  QA_ROUND=$((${QA_PRIOR:-0} + 1))
  QA_BLOCKERS="${BLOCKERS:-0}"
  printf '%s' "$QA_BLOCKERS" | grep -Eq '^[0-9]+$' || QA_BLOCKERS=1
  case "${MAX_SEVERITY:-}" in high|medium|low) QA_SEV="$MAX_SEVERITY" ;; *) QA_SEV=high ;; esac
  [ "$QA_BLOCKERS" = "0" ] && QA_SEV=none
  QA_VERDICT_TRAILER=$(printf 'QA-Verdict: %s pr=%s round=%s sha=%s blockers=%s max_severity=%s' \
    "$VERDICT" "$pr_number" "$QA_ROUND" "$QA_SHA" "$QA_BLOCKERS" "$QA_SEV")
  if ! printf '%s\n' "$QA_VERDICT_TRAILER" | grep -Eq "$QA_TRAILER_RE"; then
    echo "[hydra-qa] ERROR: minimal trailer also invalid — posting QA-Verdict-Error" >&2
    QA_V=$(printf '%s' "$VERDICT" | tr -cd 'A-Za-z-'); QA_PR=$(printf '%s' "$pr_number" | tr -cd '0-9')
    QA_VERDICT_TRAILER=$(printf 'QA-Verdict-Error: verdict=%s pr=%s reason=%s' \
      "${QA_V:-unknown}" "${QA_PR:-unknown}" "trailer render failed (full and minimal)")
  fi
fi
# <<< qa-verdict-trailer
rm -f "$PRIOR_BODIES_FILE"
# One-line blocker summary for the issue-side pointer (the full review stays on the PR).
BLOCKER_SUMMARY="${BLOCKERS:-0} blocker(s), worst: ${MAX_SEVERITY:-none}${WORST_FINDING:+ — ${WORST_FINDING}}"
```

`WORST_FINDING` is the fold's worst blocking row, `file:line — finding` (≤ 120 chars; empty on a PASS). **Post once:** the full `$REVIEW_REPORT` lives only on the PR; the issue gets a short pointer (verdict, PR link, `$BLOCKER_SUMMARY`, the trailer — ≤ ~800 chars) that keeps its bounce-marker header line so remediation routing and `qa:catch-rate` still see it.

### 10. Verdict routing

**Verdict `PASS`** (both axes pass + all required checks green):
```bash
# Strip needs-qa from the source issue FIRST (issue #974), before any command
# that can abort this branch on a self-authored PR. The PASS verdict is final
# the moment it is computed; the label routing must not be hostage to the
# comment/merge calls below. The old first command here was
# `gh pr review --approve`, which ALWAYS errors on a self-authored PR (shared
# gaberoo322 identity — reference_qa_cannot_self_approve / #848); that abort
# left needs-qa lingering ~1h23m until a LATER autopilot run cleared it — the
# #974 busy-loop (QA-side twin of #846). Use the PR-event-safe `gh issue edit`
# path (NOT the broken `gh pr edit` — feedback_gh_rerun_label_quirk), tolerant
# of an already-cleared label via `|| true`.
#
# Apply `in-progress` as a bridging label in the SAME call (issue #3788 Cause
# 1): a PR is confirmed open at this point (located in step 2), so leaving the
# issue fully label-less between the needs-qa strip and the eventual merge is
# never correct — under CI queue backpressure (single self-hosted runner
# serializing PR CI + deploys) a green, auto-mergeable PR can sit
# `mergeStateStatus: BLOCKED` for the entire queue-wait window, during which
# the source issue was an untriaged-orphan false positive. `in-progress` does
# not key into the #974 redispatch loop (that loop is keyed specifically on a
# lingering `needs-qa` label), so this closes the gap without reintroducing
# #974.
gh issue edit $issue_number --repo gaberoo322/hydra --remove-label "needs-qa" --add-label "in-progress" 2>/dev/null \
  || true  # already cleared (e.g. by a prior auto-close) — expected and non-fatal

# Record the PASS as a COMMENT, not an approval: the shared gaberoo322 identity
# cannot self-approve its own PR (reference_qa_cannot_self_approve / #848), and
# the merge gate is CI required-status-checks, not approvals. This matches the
# T4 Deep-QA PASS-marker path below, which already uses `gh pr comment`.
gh pr comment $pr_number --repo gaberoo322/hydra --body "> *Automated QA — two-axis review*

$REVIEW_REPORT

---

**Verdict:** \`PASS\` — ${VERDICT_REASON}

$CHECKS_BLOCK

${QA_VERDICT_TRAILER}"
# T4 PASS only — post the Deep-QA PASS marker (issue #847, ADR-0020 Slice 1).
# This is the SHA-bound positive proof that the Verifier-Core deep branch ran
# against EXACTLY this head SHA — the counterpart to the FAIL marker in the
# block above. The `deep-qa-gate` required check
# (.github/workflows/deep-qa-gate.yml) verifies a marker matching the PR's
# CURRENT head SHA before a T4 PR may merge; pushing new commits after this
# pass changes the head SHA and forces re-QA (the marker goes stale). Resolve
# the live head SHA at post time (NOT $FIXED_SHA, which is the base ref) and
# render the exact marker line via `renderDeepQaPassMarker` so the literal is
# the single source of truth shared with the gate.
if [ "$PR_TIER" = "4" ]; then
  HEAD_SHA=$(gh pr view $pr_number --repo gaberoo322/hydra \
    --json headRefOid --jq '.headRefOid')
  DEEP_QA_PASS_LINE=$(HEAD_SHA="$HEAD_SHA" node --no-warnings --experimental-strip-types -e "
    import('./scripts/ci/qa-verdict.ts').then(({renderDeepQaPassMarker}) => {
      process.stdout.write(renderDeepQaPassMarker(process.env.HEAD_SHA));
    });
  ")
  gh pr comment $pr_number --repo gaberoo322/hydra --body "> *T4 Verifier-Core deep-QA — PASS proof*

${DEEP_QA_PASS_LINE}

The Verifier-Core deep-QA branch passed against this exact head SHA. The \`deep-qa-gate\` required check verifies this marker before merge; new commits invalidate it and force re-QA."
fi

# Enable auto-merge (squash) rather than a blocking immediate merge: the merge
# gate is CI required-status-checks (feedback_hydra_repo_no_auto_merge), so
# `--auto` lets GitHub squash-merge the instant the checks settle without this
# dispatch blocking on them. needs-qa was already stripped above, so even if
# this call errors the source issue is not left in the #974 busy-loop.
gh pr merge $pr_number --repo gaberoo322/hydra --auto --squash --delete-branch \
  || echo "WARN: failed to enable auto-merge on PR #${pr_number} (non-fatal — needs-qa already cleared; CI is the merge gate)"
```
**If `--auto` is refused, a direct merge goes through the QA merge guard (issue
#4738).** When GitHub refuses to arm auto-merge (e.g. a red non-required check —
PR #4741) and every *required* check is green, do NOT improvise a bare
`gh pr merge --squash`. Run the guard (`qa-merge-guard.ts`), and merge only on exit 0, pinned to the
head the guard just checked, so a push after this verdict can never ride it in:
```bash
GUARD_JSON=$(node --experimental-strip-types scripts/ci/qa-merge-guard.ts --pr "$pr_number" --repo gaberoo322/hydra) \
  && gh pr merge "$pr_number" --repo gaberoo322/hydra --squash --delete-branch \
       --match-head-commit "$(jq -r .headSha <<<"$GUARD_JSON")" \
  || echo "WARN: PR #${pr_number} not merged directly — guard result: ${GUARD_JSON:-none}"
```
A denied guard leaves the PR for the autopilot or `/hydra-review`; QA never
posts a `QA-Override:`.
The needs-qa strip runs first (issue #974), so the label is cleared regardless
of whether the comment or auto-merge calls below it succeed. The issue
auto-closes via `closes #N` in the PR body when the squash-merge lands.

**Verdict `PASS-pending-CI`** (review PASS + at least one check still queued/in_progress):
```bash
# Do NOT approve yet — branch protection will block merge anyway, and we want
# the autopilot poll loop to see the canonical "pending" state.
gh pr comment $pr_number --repo gaberoo322/hydra --body "> *Automated QA — two-axis review (pending CI)*

$REVIEW_REPORT

---

Code review **PASS**. Awaiting CI:

$CHECKS_BLOCK

Verdict: \`PASS-pending-CI\`. Autopilot will re-evaluate once required checks conclude. **The QA subagent has exited — no background wait.**

${QA_VERDICT_TRAILER}"

# Clear needs-qa from the source issue (issue #638) — the diff-review portion
# of QA is complete; what remains is CI polling, which the autopilot does
# directly via `gh pr view --json statusCheckRollup` without re-running this
# skill. Leaving `needs-qa` on the issue caused `signals.needs_qa_orch=True`
# to fire on every autopilot tick (`scripts/autopilot/collect-state.sh:33`
# counts `needs-qa` on issues), and decide.py re-dispatched hydra-qa every
# turn — a busy-loop that burned ~30-65k tokens per tick while the PR sat
# waiting on CI or operator merge.
#
# The PR keeps its own status via the verdict comment above; when CI goes
# green and the PR is merged, `Closes #N` in the PR body auto-closes the
# issue. If CI later FAILS, the autopilot poll loop (which reads
# statusCheckRollup directly, not labels) re-labels the issue
# `ready-for-agent` for retry — the same path as a fresh FAIL verdict.
#
# Apply `in-progress` as a bridging label in the SAME call (issue #3788 Cause
# 1) — same rationale as the PASS branch above: a confirmed-open PR is still
# awaiting CI/merge, so the issue must never sit fully label-less in the
# meantime. `in-progress` is inert with respect to both the #974 redispatch
# loop (keyed on `needs-qa`) and the autopilot's CI-poll re-label-on-FAIL path
# (which sets `ready-for-agent` directly, superseding `in-progress`).
gh issue edit $issue_number --repo gaberoo322/hydra --remove-label "needs-qa" --add-label "in-progress" 2>/dev/null \
  || echo "WARN: failed to clear needs-qa from issue #$issue_number (non-fatal)"
```

**Verdict `FAIL` or `FAIL-pending-CI`** (any axis has hard findings, or a required check has already failed):

Every FAIL is posted as a PR **comment**, never a request-changes review: GitHub rejects a request-changes review on a self-authored PR (the shared identity — same reason PASS never approves), which would drop the verdict and its trailer (issue #4746). Blocking is carried by the labels below, not by a review state.

**Disarm auto-merge FIRST, on every FAIL, every tier (issue #4737).** A PASS arms auto-merge; nothing else ever disarms it, so a later FAIL on a re-review would otherwise merge the moment CI goes green (#4380 merged 4s after its FAIL posted). Both FAIL blocks below therefore open with the same non-fatal disarm call; on a PR with no auto-merge armed it errors, which is logged and ignored. The same rule, read from QA's own record, is the QA merge guard (scripts/ci/qa-merge-guard.ts --pr N): it exits 0 only when the latest QA-Verdict trailer is a PASS at the PR's current head SHA, or the PR only touches docs/research/ or docs/adr/.

For T1 / T2 / T3 (PR_TIER empty/1/2/3) — the universal remediation bounce, capped at the 3rd FAIL round (issue #4735). The round-cap block runs BEFORE this round's comment is posted, so the prior bodies it reads never include the current verdict. On escalate it moves the labels itself: it adds ready-for-human to the issue and the PR, then removes every dev-lane label from the issue. The routing below then posts the escalation summary instead of bouncing. If the decision is unavailable (a gh or node failure), QA bounces as it did before #4735 and logs a warning. (No inline code spans in this paragraph: test/hydra-qa-needs-qa-clear.test.mts reads this section up to the first bash fence.)
```bash
# Disarm any auto-merge a prior PASS armed (issue #4737) — before anything else.
gh pr merge $pr_number --repo gaberoo322/hydra --disable-auto \
  || echo "[hydra-qa] WARN: --disable-auto on PR #${pr_number} failed (non-fatal — likely not armed)" >&2
ROUND_PRIOR_FILE=$(mktemp)
# >>> qa-round-cap
ROUND_ACTION=bounce
QA_ESCALATION_SUMMARY=""
ESC_LABELS_OK=1
ESC_LABEL_NOTE=""
ROUND_JSON=""
# The Skill loader substitutes the BARE issue-number token into this text; it
# never sets a shell variable, so the braced form would render empty (PR #4759).
ESC_ISSUE="$issue_number"
# A CI-only round (the step-6.6 admission-gate skip) reviewed nothing and never
# counts toward the cap.
CURRENT_REVIEWED=true
case "${REVIEW_REPORT:-}" in *"Review skipped by the admission gate"*) CURRENT_REVIEWED=false ;; esac
if gh pr view "$pr_number" --repo gaberoo322/hydra --json comments,reviews \
     --jq '[.comments[].body, .reviews[].body]' > "$ROUND_PRIOR_FILE"; then
  ROUND_JSON=$(ROUND_PRIOR_FILE="$ROUND_PRIOR_FILE" PR="$pr_number" PR_TIER_NUM="$PR_TIER_NUM" VERDICT="$VERDICT" \
    CURRENT_REVIEWED="$CURRENT_REVIEWED" QA_VERDICT_TRAILER="$QA_VERDICT_TRAILER" node --no-warnings --experimental-strip-types -e "
    Promise.all([import('node:fs'), import('./scripts/ci/qa-verdict.ts')]).then(([fs, q]) => {
      const e = process.env;
      const bodies = JSON.parse(fs.readFileSync(e.ROUND_PRIOR_FILE, 'utf8').trim() || '[]');
      const pr = Number(e.PR);
      const tier = e.PR_TIER_NUM === '' || e.PR_TIER_NUM === undefined ? null : Number(e.PR_TIER_NUM);
      const d = q.decideQaRoundAction({ tier, verdict: e.VERDICT, pr, priorBodies: bodies, currentReviewed: e.CURRENT_REVIEWED !== 'false' });
      const summary = d.action === 'escalate'
        ? q.renderQaEscalationSummary({ pr, priorBodies: bodies, currentTrailer: e.QA_VERDICT_TRAILER }) : '';
      process.stdout.write(JSON.stringify({ ...d, summary, labels: q.QA_ESCALATION_LABELS }));
    }).catch((err) => { console.error('[hydra-qa] decideQaRoundAction failed:', err); process.exit(1); });
  ") || ROUND_JSON=""
else
  echo "[hydra-qa] WARN: prior QA verdicts unreadable — round cap not applied" >&2
fi
case "$(printf '%s' "$ROUND_JSON" | jq -r '.action // empty' 2>/dev/null)" in
  escalate) ROUND_ACTION=escalate ;;
  bounce) ;;
  *) echo "[hydra-qa] WARN: round-cap decision unavailable — bouncing (pre-#4735 behaviour)" >&2 ;;
esac
if [ "$ROUND_ACTION" = "escalate" ]; then
  QA_ESCALATION_SUMMARY=$(printf '%s' "$ROUND_JSON" | jq -r '.summary')
  case "$ESC_ISSUE" in
    ''|*[!0-9]*)
      echo "[hydra-qa] ERROR: no issue number to escalate (got '$ESC_ISSUE') — issue labels NOT changed" >&2
      ESC_LABELS_OK=0 ;;
    *)
      # Add first, so the issue is in the operator queue even if a removal fails.
      for l in $(printf '%s' "$ROUND_JSON" | jq -r '.labels.issueAdd[]'); do
        gh api -X POST "repos/gaberoo322/hydra/issues/$ESC_ISSUE/labels" -f "labels[]=$l" >/dev/null \
          || { ESC_LABELS_OK=0; echo "[hydra-qa] ERROR: could not add $l to issue #$ESC_ISSUE" >&2; }
      done
      # The label name goes in the URL path (a DELETE with -f name= wipes ALL
      # labels). A 404 means the label was not on the issue — that is success.
      for l in $(printf '%s' "$ROUND_JSON" | jq -r '.labels.issueRemove[]'); do
        if ! ESC_ERR=$(gh api -X DELETE "repos/gaberoo322/hydra/issues/$ESC_ISSUE/labels/$l" 2>&1 >/dev/null); then
          case "$ESC_ERR" in
            *404*|*"Label does not exist"*) ;;
            *) ESC_LABELS_OK=0; echo "[hydra-qa] ERROR: could not remove $l from issue #$ESC_ISSUE: $ESC_ERR" >&2 ;;
          esac
        fi
      done ;;
  esac
  for l in $(printf '%s' "$ROUND_JSON" | jq -r '.labels.prAdd[]'); do
    gh api -X POST "repos/gaberoo322/hydra/issues/$pr_number/labels" -f "labels[]=$l" >/dev/null \
      || { ESC_LABELS_OK=0; echo "[hydra-qa] ERROR: could not add $l to PR #$pr_number" >&2; }
  done
  if [ "$ESC_LABELS_OK" = "1" ]; then
    ESC_LABEL_NOTE="Labelled \`ready-for-human\` (issue and PR) and removed every dev-lane label; no dev lane will pick this up."
  else
    ESC_LABEL_NOTE="**Label routing FAILED** (see the QA log): add \`ready-for-human\` and remove \`needs-qa\`, \`ready-for-agent\`, \`needs-dev-resume\` and \`in-progress\` by hand, or QA will re-run on this issue."
  fi
fi
# <<< qa-round-cap
rm -f "$ROUND_PRIOR_FILE"
gh pr comment $pr_number --repo gaberoo322/hydra --body "> *Automated QA — two-axis review*

$REVIEW_REPORT

---

**Verdict:** \`${VERDICT}\` — ${VERDICT_REASON}

$CHECKS_BLOCK

${QA_VERDICT_TRAILER}"
# Bounce label (issue #4766): while the PR is OPEN the bounce is
# needs-dev-resume, NOT ready-for-agent — ready-for-agent on an open PR is a
# FRESH dev pick, which opens a duplicate PR instead of resuming the branch;
# the autopilot's durable resume pin (collect-state.sh orch_dev_resume_pick,
# #4518 non-GLM / #4460 GLM variant) owns any open PR. GLM_AUTHORED selects
# only the comment wording below. This is the SAME relabel site step 6.6's
# `skip-required-failed` routes into, so the short-circuit bounce is covered
# too. Name the red required check(s) when CI is what failed.
# Round cap first (issue #4735): an escalated issue is never re-labelled for dev.
BOUNCE_LABEL=$(qa_bounce_label)
if [ "$ROUND_ACTION" = "escalate" ]; then
  gh issue comment $issue_number --repo gaberoo322/hydra --body "> *Automated QA escalated — operator decision needed*

\`${VERDICT}\` on PR #$pr_number — ${BLOCKER_SUMMARY}. ${ESC_LABEL_NOTE}

${QA_ESCALATION_SUMMARY}

${QA_VERDICT_TRAILER}"
elif [ "$BOUNCE_LABEL" = "needs-dev-resume" ]; then
  gh issue edit $issue_number --repo gaberoo322/hydra \
    --remove-label "needs-qa" --add-label "needs-dev-resume"
  if [ "$GLM_AUTHORED" = "1" ]; then
    gh issue comment $issue_number --repo gaberoo322/hydra --body "> *Automated QA failed (GLM-authored PR)*

\`${VERDICT}\` on PR #$pr_number — ${BLOCKER_SUMMARY}. Full review on the PR.${RED_REQUIRED_LIST:+

Red required check(s): ${RED_REQUIRED_LIST}}

Relabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the GLM drainer skips open-PR anchors; the autopilot's pinned forward-fix (issue #4460) owns the retry on this branch.

${QA_VERDICT_TRAILER}"
  else
    gh issue comment $issue_number --repo gaberoo322/hydra --body "> *Automated QA failed (open PR)*

\`${VERDICT}\` on PR #$pr_number — ${BLOCKER_SUMMARY}. Full review on the PR.${RED_REQUIRED_LIST:+

Red required check(s): ${RED_REQUIRED_LIST}}

Relabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the retry on this branch.

${QA_VERDICT_TRAILER}"
  fi
else
  # Not-open fallback (#4766): live read confirmed CLOSED/MERGED — no open
  # PR remains, so a fresh dev pick (not a resume) is the right lane.
  gh issue edit $issue_number --repo gaberoo322/hydra --remove-label "needs-qa" --add-label "ready-for-agent"
  gh issue comment $issue_number --repo gaberoo322/hydra --body "> *Automated QA failed*

\`${VERDICT}\` on PR #$pr_number — ${BLOCKER_SUMMARY}. Full review on the PR.

Returning to ready-for-agent for retry.

${QA_VERDICT_TRAILER}"
fi
```

For **T4** (`PR_TIER == 4`) — the **Deep-QA Remediation Loop** (issue #740). The 1st FAIL bounces exactly like the universal loop; the 2nd consecutive FAIL on the same PR blocks and escalates to the `/hydra-review` pickup set. Derive the action LIVE from the PR's own deep-QA FAIL markers — the PR is the per-attempt ledger:

```bash
# Disarm any auto-merge a prior PASS armed (issue #4737) — before anything else.
gh pr merge $pr_number --repo gaberoo322/hydra --disable-auto \
  || echo "[hydra-qa] WARN: --disable-auto on PR #${pr_number} failed (non-fatal — likely not armed)" >&2

# Collect the PR's prior comment bodies — the durable per-attempt ledger.
# Via a file, not an env var (128 KiB exec limit — issue #4746); reviews are
# included so pre-#4746 FAIL markers posted as request-changes reviews count.
PRIOR_COMMENTS_FILE=$(mktemp)
gh pr view $pr_number --repo gaberoo322/hydra \
  --json comments,reviews --jq '[.comments[].body, .reviews[].body]' > "$PRIOR_COMMENTS_FILE"

# Pure decision: 1st FAIL => bounce, 2nd+ consecutive FAIL => block-and-escalate.
DEEP_QA_JSON=$(PRIOR_COMMENTS_FILE="$PRIOR_COMMENTS_FILE" REVIEW_VERDICT="$REVIEW_VERDICT" \
  node --no-warnings --experimental-strip-types -e "
  Promise.all([import('node:fs'), import('./scripts/ci/qa-verdict.ts')]).then(([fs, {decideDeepQaAction, DEEP_QA_FAIL_MARKER}]) => {
    const prior = JSON.parse(fs.readFileSync(process.env.PRIOR_COMMENTS_FILE, 'utf8').trim() || '[]');
    const d = decideDeepQaAction(process.env.REVIEW_VERDICT, prior);
    process.stdout.write(JSON.stringify({ ...d, marker: DEEP_QA_FAIL_MARKER }));
  }).catch((err) => { console.error('[hydra-qa] decideDeepQaAction failed:', err); process.exit(1); });
")
rm -f "$PRIOR_COMMENTS_FILE"
DEEP_QA_ACTION=$(printf '%s' "$DEEP_QA_JSON" | jq -r '.action')
DEEP_QA_FAILNO=$(printf '%s' "$DEEP_QA_JSON" | jq -r '.failNumber')
DEEP_QA_MARKER=$(printf '%s' "$DEEP_QA_JSON" | jq -r '.marker')

# ALWAYS post the FAIL marker comment so the next pass can count this fail
# (the marker line is the ledger entry). A comment, not a request-changes
# review — GitHub rejects that on a self-authored PR (issue #4746).
gh pr comment $pr_number --repo gaberoo322/hydra --body "> *Automated QA — T4 Verifier-Core deep review*

$REVIEW_REPORT

---

**Verdict:** \`${VERDICT}\` — ${VERDICT_REASON}

${DEEP_QA_MARKER} (fail #${DEEP_QA_FAILNO} on this PR)

$CHECKS_BLOCK

${QA_VERDICT_TRAILER}"

if [ "$DEEP_QA_ACTION" = "block-and-escalate" ]; then
  # 2nd consecutive deep-QA FAIL — block the PR (do NOT re-bounce) and route the
  # SOURCE ISSUE to the /hydra-review pickup set. Same surface as every other
  # ready-for-human escalation; no new operator channel, no new verdict literal.
  gh issue edit $issue_number --repo gaberoo322/hydra \
    --remove-label "needs-qa" --add-label "ready-for-human"
  gh issue comment $issue_number --repo gaberoo322/hydra --body "> *T4 Deep-QA blocked — operator decision needed*

PR #$pr_number failed the Verifier-Core deep-QA gate **twice consecutively** (fail #${DEEP_QA_FAILNO}). Per the Deep-QA Remediation Loop the PR is now **blocked** and routed to the operator instead of bouncing again.

\`${VERDICT}\` — ${BLOCKER_SUMMARY}. Full findings on PR #$pr_number (both passes).

This issue is now on the \`/hydra-review\` pickup set. Resolve by either fixing the Verifier-Core concern and re-running QA, or closing the PR.

${QA_VERDICT_TRAILER}"
else
  # 1st deep-QA FAIL — bounce to a dev agent via the universal remediation
  # loop. Same open-PR rule as the T1-T3 bounce (#4766): the bounce label
  # comes from qa_bounce_label (needs-dev-resume while the PR is open). The
  # deep-QA fail count rides PR-comment markers, not issue labels, so the
  # label change cannot disturb decideDeepQaAction.
  BOUNCE_LABEL=$(qa_bounce_label)
  gh issue edit $issue_number --repo gaberoo322/hydra \
    --remove-label "needs-qa" --add-label "$BOUNCE_LABEL"
  gh issue comment $issue_number --repo gaberoo322/hydra --body "> *T4 Deep-QA failed (1st) — bouncing to dev*

\`${VERDICT}\` on PR #$pr_number — ${BLOCKER_SUMMARY}. Full review on the PR.

Returning to ${BOUNCE_LABEL} for remediation. A second consecutive deep-QA FAIL on this PR will block it and escalate to the operator.

${QA_VERDICT_TRAILER}"
fi
```

### 11. Lesson capture on FAIL (issue #392, refined by #524)

After a FAIL verdict — before returning — record a planner pattern so the
agent-memory write path keeps producing durable rules in
`config/feedback/to-planner.md`. This is the only post-cycle writer to
`hydra:memory:planner:patterns` for Claude-driven QA after #383 deleted
codex-runner.

**Classify each failed criterion** before emitting the cue (issue #524):

- `acceptance-criterion-unmet` — the implementation actually didn't satisfy
  the criterion. The diff is wrong, missing, or contradicts the spec. This
  is the planner-quality signal the friction system is built to surface;
  the existing 3-hit threshold applies.
- `acceptance-criterion-deferred` — the criterion requires post-deploy /
  runtime / manual observation that pre-merge QA *cannot* verify from a
  diff. Marker phrases (case-insensitive): "after Nh post-deploy",
  "manually verify", "manually induce", "manually inducing", "operator
  observes", "operator confirms", "operator verifies", "in production",
  "post-deploy", "production runtime", "production logs", "runtime
  observation". This cue is metadata about the AC's shape, not a defect;
  the auto-escalation threshold is 20+ (much higher than `unmet`) and it
  does NOT auto-promote to `to-planner.md`.

```bash
# One call per failed criterion (the endpoint dedupes on cue).
for failed in "${FAILED_CRITERIA[@]}"; do
  # Classify: deferred-ish text → acceptance-criterion-deferred, else unmet.
  shopt -s nocasematch
  if [[ "$failed" =~ (after\ [0-9]+h\ post-deploy|manually\ verify|manually\ induc|operator\ (observe|confirm|verifie)|in\ production|post-deploy|production\ (runtime|logs)|runtime\ observation) ]]; then
    cue="acceptance-criterion-deferred"
  else
    cue="acceptance-criterion-unmet"
  fi
  shopt -u nocasematch

  curl -fsS -X POST http://localhost:4000/api/memory/subagent-lesson \
    -H 'content-type: application/json' \
    -d "$(jq -n \
      --arg skill "hydra-qa" \
      --arg outcome "qa-fail" \
      --arg cue "$cue" \
      --arg context "PR #${pr_number}: ${failed}" \
      --arg cycleId "hydra-qa-$issue_number-$(date +%s)" \
      '{skill: $skill, outcome: $outcome, cue: $cue, context: $context, cycleId: $cycleId}')" \
    || echo "WARN: lesson capture failed (non-fatal)"
done
```

API failures are non-fatal — log and continue. The endpoint validates inputs
and forwards to `recordPattern()` so the existing auto-promotion
pipeline still applies (with the per-cue threshold from #524). Don't call this
on PASS / PASS-pending-CI (positive QA outcomes currently don't train a memory).

Relay the QA report to the user.

## Post-merge Regression Check — the Outcome Holdback producer (issue #786, ADR-0004 step 4)

Pre-merge QA (sections 1–11) is the **Pre-merge Gate**. This section is the
**Post-merge Regression Check**: the *producer* of the Outcome Holdback events
(`holdback.reverted` / `holdback.cap-reached` / `holdback.revert_failed`) that
`src/digest.ts` has long consumed but nothing produced since the in-process
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
      # Revert/PR-open failed — surface to the digest so the operator sees a
      # warranted revert did not land.
      curl -fsS -X POST http://localhost:4000/api/holdback/revert-failed \
        -H 'content-type: application/json' \
        -d "$(jq -n --arg sha "$merge_sha" --arg r "git revert/PR-open failed" \
              '{commitSha:$sha, reason:$r}')" || true
    fi
    ;;
  cap-reached)
    # Per-day revert cap hit — revert SUPPRESSED, holdback.cap-reached emitted.
    # Do NOT revert; the digest surfaces the suppressed regression. A runaway
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
  `src/digest.ts` consumes. Renaming any leaves the consumer orphaned.
- **Per-day cap precedes any revert.** Once `HYDRA_HOLDBACK_MAX_REVERTS_PER_DAY`
  (default 3) is reached, the producer emits `holdback.cap-reached` and
  suppresses further reverts for the UTC day.
- **No new runtime dependency** (ADR-0005). Events publish via the orchestrator
  event bus; the skill only shells `curl`/`gh`/`git`. Window/cap/TTL are named,
  env-overridable config (defaults in `src/redis/holdback.ts`, documented in
  `config/direction/outcomes.yaml`), never magic literals.

## Why a wrapper, not a re-implementation

The upstream `code-review` skill (`~/.claude/skills/code-review/SKILL.md`) is the contract. We invoke its **process pattern** — pin fixed point, identify spec, spawn parallel Standards + Spec sub-agents (the Standards axis carrying the twelve-smell Fowler battery from v1.1), aggregate verbatim — and layer Hydra-specific concerns on top: the design-concept artifact as the canonical spec source, the verdict classifier from `scripts/ci/qa-verdict.ts`, and the autopilot-friendly single-pass exit.

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the artifact asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other. The accept/reject decision is captured in the Redis `hydra:qa:results:*` keys for analytics; the aggregated PR comment is human-readable.

## Skill files

The canonical source for this skill is `docs/operator-playbooks/hydra-qa.md`. The deployed copy at `~/.claude/skills/hydra-qa/SKILL.md` is **machine-generated** by `scripts/sync-skills.sh` on every master deploy — never edit it by hand.

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
