# hydra-qa — REFERENCE (read on demand, not on every QA pass)

This file is the `reference_files:` sidecar of `hydra-qa.md`: it is copied beside `SKILL.md` and read only when a QA pass needs the background below. Nothing here is a step; the steps, the reviewer briefs and the T4 Verifier-Core checklist stay in `hydra-qa.md`. The plumbing is `scripts/qa/{preflight,packet,route,poll}.ts`.

Verification depth, the severity fold, convergent review (class sweep, re-review context, round cap), the verdict literals and the tier table are not described here. Their homes: tier = `GET /api/tier`; depth and reviewer list = preflight `.fanout.mode` / `.fanout.reviewers` (`scripts/qa/preflight.ts`); fold, trailer and round action = the qa-verdict engine (`scripts/ci/qa-verdict.ts`, `src/qa/`); tier table = `docs/reference.md`.

## `deep-qa-gate` — authoritative commit StatusContext vs advisory CheckRun mirror

The `deep-qa-gate` required CI check (`.github/workflows/deep-qa-gate.yml`) reports through **two** GitHub primitives that share the name `deep-qa-gate`, and the distinction is load-bearing:

- **Commit StatusContext** — the SINGLE authoritative enforcement primitive. The workflow POSTs it on every arm (`POST /repos/{owner}/{repo}/statuses/{sha}`) against the resolved head SHA. A commit StatusContext is the right primitive, not a required *CheckRun* (ADR-0020 Decision 4).
- **CheckRun** — an **advisory rollup mirror** only. The `issue_comment` arm also creates a CheckRun named `deep-qa-gate` on the same head SHA, reporting the same state, so the PR checks rollup (`statusCheckRollup`) shows an unambiguous latest result: the `pull_request` arm's own like-named CheckRun is cancelled by the shared concurrency group when the PASS marker fires, and would otherwise linger as a stale rollup entry.

**Invariant — the CheckRun never contradicts the status, and never becomes a second required check.** If the two disagree, the commit status wins. The CheckRun is deliberately not in branch protection: two required checks of the same name is ambiguous. When auditing a `deep-qa-gate` verdict, read the commit status as the truth.

## Spec axis when the artifact is missing (`DESIGN_CONCEPT_MODE`)

The dispatch-side gate (`gateDispatch` in `src/lifecycle/gates.ts`) refuses to dispatch a `needs-design-concept` anchor without an approved artifact. This section covers what QA does at review time when an artifact is still missing:

- **`DESIGN_CONCEPT_MODE=warn` (default)** — a missing artifact logs a warning, the Spec axis is skipped (reports "no artifact"), and QA proceeds with the Standards axis only.
- **`DESIGN_CONCEPT_MODE=enforce`** — a missing artifact fails the PR with the message: `design-concept artifact required; run hydra-grill on the parent issue or attach 'design-concept-exempt' label (operator-only)`.

The mode is read from the shell variable `$DESIGN_CONCEPT_MODE` (default `warn`). In both modes an explicit `design-concept-exempt` label on the PR (operator-only) bypasses the Spec axis with an audit-log comment, and a prompt-only PR diff (`isPromptOnlyChange()`) with no associated artifact bypasses it too.

## Review invariants INV-A..INV-G

The preflight's admission and short-circuit levers obey these invariants:

- **INV-A** — any admission or short-circuit lever is a derivation of `aggregateAdversarialReview()` / `classifyVerdict()` in `scripts/ci/qa-verdict.ts`, never an independent policy.
- **INV-B** — a review may only be **deferred**, never depth-reduced below what the preflight's `.fanout.mode` requires, by any such lever.
- **INV-C** — every PR that reaches auto-merge has been reviewed at the full depth the preflight requires: a deferred or pre-spawn-skipped PR never merges without a real review on a later pass.
- **INV-D** — the emitted verdict literals, `aggregateAdversarialReview()`, `classifyVerdict()`, and `decide.py`'s `should_auto_merge()` (`INV-007`) are untouched by any such lever.
- **INV-E** — every unknown input (an unreachable tier classifier, an unknown `mergeStateStatus`, a gate-script error) fails closed to FULL review depth, never to a skip.
- **INV-F** — the Target's Risk-Critical Surface classification (`classifyTargetQaPath`) is untouched by any orchestrator-side QA-cost lever.
- **INV-G** — no such lever introduces a Redis key, label, CI check or API endpoint.

## Post-merge Regression Check — the Outcome Holdback producer

Historical: this producer was specified by ADR-0004.

Pre-merge QA is the **Pre-merge Gate**. The **Post-merge Regression Check** is the *producer* of the Outcome Holdback events (`holdback.reverted` / `holdback.cap-reached` / `holdback.revert_failed`) that the Operator Channel router (`src/operator-channel/route-event.ts`) consumes. It is request-scoped work the autopilot poll loop dispatches *after* a merge: no timer, no sampler, no long-lived loop (ADR-0006, ADR-0010, ADR-0012). The producer logic lives behind the orchestrator service (`src/holdback.ts` + `src/api/holdback.ts`); this skill only drives it over HTTP and performs the `git revert` when told to. Holdback is read-only with respect to merge: the only action it can take is to open a revert PR.

### A. Enrollment belongs to the autopilot

`hydra-qa` runs strictly **pre-merge**: it posts a verdict comment and never merges, so it never holds a confirmed merge SHA. Enrollment is the autopilot `auto-merge` action handler's job (see "holdback enrollment on auto-merge" in `docs/operator-playbooks/hydra-autopilot.md`): it POSTs the merge SHA and tier to `/api/holdback/enroll`, and the server (`enrollHoldback` in `src/holdback.ts`) owns which tiers enroll and answers `{enrolled:false}` for the rest.

### B. Check enrolled merges each poll (the watch)

On each autopilot poll tick, for every still-enrolled merge SHA, call `check`. The service re-samples the leading outcomes, compares against the persisted baseline, enforces the per-day revert cap, emits the holdback.* events, and returns a `decision`:

```bash
RESP=$(curl -fsS -X POST http://localhost:4000/api/holdback/check \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg sha "$merge_sha" '{commitSha:$sha}')")
DECISION=$(printf '%s' "$RESP" | jq -r '.decision')
case "$DECISION" in
  revert)
    # A leading outcome regressed past its noise_epsilon AND the per-day cap is
    # not reached. The service already emitted holdback.reverted and cleared
    # the baseline + counted the revert. Perform the actual revert PR now.
    REGRESSED=$(printf '%s' "$RESP" | jq -r '.regressedOutcomes | join(", ")')
    if git -C <worktree> revert --no-edit "$merge_sha" && \
       gh pr create --title "revert: holdback regression on ${merge_sha:0:7}" \
         --body "Outcome Holdback auto-revert. Leading outcomes regressed past noise_epsilon vs the pre-merge baseline: ${REGRESSED}."; then
      : # revert PR opened; the revert PR goes through the normal PR flow
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

- **Server-derived window.** The watch window is derived server-side from the enrolled tier (`src/redis/holdback.ts`); this skill never computes it.
- **Leading outcomes only.** A revert fires only when a `kind: leading` outcome regresses in the **unfavorable** direction by **more than** its `noise_epsilon`. Terminal outcomes never drive a revert (`outcomes.yaml` schema comment; CONTEXT.md).
- **Adapter outage is no-data, not a regression.** A null reading on either side never counts as a regression.
- **Fixed event names + payloads.** The producer emits exactly `holdback.reverted` (`payload.commitSha`, `payload.regressedOutcomes`), `holdback.cap-reached` and `holdback.revert_failed`. `holdback.revert_failed` is a Page, the other two are Morning Brief items (ADR-0045); renaming any orphans the consumer.
- **Per-day cap precedes any revert.** Once `HYDRA_HOLDBACK_MAX_REVERTS_PER_DAY` is reached, the producer emits `holdback.cap-reached` and suppresses further reverts for the UTC day.
- **No new runtime dependency** (ADR-0005). Window, cap and TTL are named, env-overridable config (defaults in `src/redis/holdback.ts`, documented in `config/direction/outcomes.yaml`), never magic literals.

### 9.4 Reviewer commit (class A) and class B (ADR-0046 Decision 2)

`scripts/qa/route.ts` runs the `reviewer-commit` engine phase in-process, between the fold and the trailer, on a reviewed FAIL only, reading the `reviewer-commits` stage at the FIXED point (`git show <fixedSha>:config/orchestrator/qa-rollout.json`, never the session tree). On `commit-a` it PAUSES before any effect: pass 1 returns `nextStep: "reviewer-commit"` plus a `reviewerCommit` plan and writes nothing. Run the effect only then, through `scripts/qa/reviewer-commit.ts` (tested; every input comes from `$ROUTE_JSON.reviewerCommit`, nothing is re-derived). `open` refuses (`.ok` false, a machine-readable `.reason`) when the live head moved off `reviewedHead` or the PR is cross-repository, builds a trusted master worktree from the plan's `fixedSha` plus a detached PR worktree, and prints `prWorktree`, `masterWorktree`, `bodyFile` and `stateFile`. You make the edits by hand: for each blocking row apply exactly the change its Fix cell names inside `prWorktree` (only the plan's paths), then run the file's own regenerator by absolute path from the master worktree with `HYDRA_REPO_ROOT` set to `prWorktree`: `HYDRA_REPO_ROOT=<prWorktree> <masterWorktree>/node_modules/.bin/tsx <masterWorktree>/scripts/docs/generate-inventories.ts` for `docs/generated/`, and `HYDRA_REPO_ROOT=<prWorktree> node <masterWorktree>/scripts/test/suite-count-check.mjs --update-baseline --only <files>` for `test/fixtures/*-baseline.json`. When `bodyFix` is true, edit `bodyFile` and only add bullets under `## Files in scope`. `finish` then stages only approved paths, re-verifies every blocking row, commits class A then class B, runs the proof(s) from the master worktree, edits the body, pushes a plain fast-forward refspec and cleans up; it prints `.ok`, `.newHead`, `.qaFixes` and, on a refusal, `.reason`. The session tree is asserted unchanged on every exit path.

The `reviewer-commit` phase returns `commit-a`, `commit-b` or `commit-ab` only when ALL of these hold: the stage is `A` or `A+B`; the tier is 1-3; no changed file is Verifier Core; the one-way-door detector says `two-way` (`one-way` and `unknown` both refuse); and EVERY blocking finding of the fold sits in a class-A location (the PR body, or a path `classifyQaFixPath` calls `A`/`AB` that is not listed under the PR body's `## Files out of scope`; and, ONLY at stage `A+B`, a class-`B` test path, i.e. `test/**/*.test.mts` excluding the helpers subdirectory, likewise not out of scope). Under stage `A` a blocking finding at a class-B path is `ineligible-finding` exactly as before. A row located in `src/` (the "branch has no test" form) is never reviewer-fixable: a test edit cannot satisfy its per-row re-verify, so a reviewer who wants the class-B fix locates the coverage finding at the test file. The action is `commit-a` (class-A bucket only), `commit-b` (class-B only) or `commit-ab` (both); `blockingTestPaths[]` / `followUpTestPaths[]` carry the class-B paths, `blockingPaths[]` / `followUpPaths[]` keep their class-A meaning, and a blocking row AT an AB baseline stays in the class-A bucket. One blocking finding anywhere else makes the whole round `none`: nothing is committed, nothing is pushed, and `route` runs the ordinary FAIL routing unchanged on the original FAIL. The phase never edits, filters or re-grades a finding.

```bash
RC_PLAN_FILE=$(mktemp); printf '%s' "$ROUTE_JSON" | jq -c '.reviewerCommit' > "$RC_PLAN_FILE"   # private tempfile
OPEN=$(node --no-warnings --experimental-strip-types scripts/qa/reviewer-commit.ts open --plan "$RC_PLAN_FILE" --pr "$pr_number"); rm -f "$RC_PLAN_FILE"
# .ok true: make the edits in .prWorktree (and .bodyFile when bodyFix), then:
FINISH=$(node --no-warnings --experimental-strip-types scripts/qa/reviewer-commit.ts finish --state "$(printf '%s' "$OPEN" | jq -r .stateFile)")
# a hand step you cannot complete: the same script with `abort --state <stateFile>`
```

A round makes at most one commit ending `QA-Fix: A` and at most one ending `QA-Fix: B`, never a combined trailer; the PASS trailer's `qa-fixes=` names every commit made. A class-B edit may never reduce coverage by deletion (`case-count-check`, fails closed), and the proof is per file: an edit whose file still passes at the merge-base, or whose import crashes there, is unproven and the round commits nothing; `qa-fix-proof.yml` re-runs the same proof on the pushed head and `qa-merge-guard` holds with `qa-fix-proof-not-green` until it is green. The stage switch is flipped only by the operator-merged graduation item that `scripts/qa/commit-graduation.ts` files. A reviewer-commit round is one `round=` like any other and never counts as a FAIL round; the round cap and the T4 2-strike rule are untouched.

After `finish`, the playbook re-calls `route` with `--reviewer-fixed` set to `finish`'s `.newHead` when `.ok` is true, else `--reviewer-commit-aborted`; the per-row `fixed-by <sha12>` annotation is `route`'s own (`annotateReviewerFixedReport`), not part of `finish`. Pass 2a re-runs the fold from the same findings files, requires a fresh `commit-a`/`commit-b`/`commit-ab` decision, and walks the first-parent chain from the pushed head back to the reviewed head with one `gh api repos/<repo>/commits/<sha>` read per commit (each message must carry the `QA-Fix:` trailer class the decision names, A before B) plus the live `headRefOid`; any miss is a pre-verdict exit (`QA-Verdict-Error ... reason=reviewer-fixed-unverified`, `needs-qa` untouched) and the next dispatch re-reviews at the new head. Only then does `route` render the verdict PASS-pending-CI, pass `headSha` and `qaFixes` to the trailer phase itself, and annotate each blocking row `fixed-by <sha12>`. Bare `PASS` is unreachable on such a round: `route` never returns `arm-auto-merge` for it, and the autopilot's auto-merge goes through `qa-merge-guard`, which holds with `qa-fix-proof-not-green` until the `qa-fix-proof` workflow is green on that head.
