# hydra-qa — REFERENCE (read on demand, not on every QA pass)

This file is the `reference_files:` sidecar of `hydra-qa.md`: it is copied beside `SKILL.md` and read only when a QA pass needs the background below. Nothing here is a step; the steps, the reviewer briefs and the T4 Verifier-Core checklist stay in `hydra-qa.md`. The plumbing is `scripts/qa/{preflight,packet,route,poll}.ts`.

Verification depth, the severity fold, convergent review (class sweep, re-review context, round cap), the verdict literals and the tier table are not described here. Their homes: tier = `GET /api/tier`; depth and reviewer list = preflight `.fanout.mode` / `.fanout.reviewers` (`scripts/qa/preflight.ts`); fold, trailer and round action = the qa-verdict engine (`scripts/ci/qa-verdict.ts`, `src/qa/`, `decideQaRoundAction()`); tier table = `docs/reference.md`.

## `deep-qa-gate` — authoritative commit StatusContext vs advisory CheckRun mirror

The `deep-qa-gate` required CI check (`.github/workflows/deep-qa-gate.yml`) reports through **two** GitHub primitives that share the name `deep-qa-gate`, and the distinction is load-bearing:

- **Commit StatusContext** — the SINGLE authoritative enforcement primitive. The workflow POSTs it on every arm (`POST /repos/{owner}/{repo}/statuses/{sha}`) against the resolved head SHA. A tier-conditional **status** is the right primitive (ADR-0020 Decision 4): it can be set `success` for non-T4 PRs immediately, whereas a required *CheckRun* the workflow never produces for non-T4 PRs would block them forever.
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

Historical: this producer was specified by ADR-0004 step 4.

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

## Slot lifecycle events

Every tool call emits a `subagent_tool_call` event onto `hydra:autopilot:slot-events`. The category classification (a `milestone` is Bash matching `npm run build` or `npm run typecheck`, among others) and the never-propagate-errors contract are described once, in the "Slot lifecycle events" section of `hydra-dev.md`.

### 9.4 Reviewer commit (class A) and class B (ADR-0046 Decision 2)

Run this block before `route`, after a FAIL fold, only when the `reviewer-commits` stage switch in the QA stage config under `config/orchestrator/` is on; inputs are `$PREFLIGHT_JSON` from `preflight`, `$FOLD_JSON`, `$REVIEW_VERDICT` and `$FIXED_SHA`, and `$QA_FIXES` / `$NEW_HEAD` go to the `trailer` phase. The PR head is checked out in a nested `git worktree add --detach` so the session tree stays untouched while the trusted scripts run from a separate master worktree (`$MASTER_WT`), with `HYDRA_REPO_ROOT` pointing the regenerators at the PR worktree and never running PR-authored scripts; the session tree is asserted unchanged on exit. With the switch off the `reviewer-commit` phase answers `none` (`reason=stage-off`) before it reads the diff, the changed paths or the body, and this block changes nothing.

The `reviewer-commit` phase returns `commit-a`, `commit-b` or `commit-ab` only when ALL of these hold: the stage is `A` or `A+B`; the tier is 1-3; no changed file is Verifier Core; the one-way-door detector says `two-way` (`one-way` and `unknown` both refuse); and EVERY blocking finding of the fold sits in a class-A location (the PR body, or a path `classifyQaFixPath` calls `A`/`AB` that is not listed under the PR body's `## Files out of scope`; and, ONLY at stage `A+B`, a class-`B` test path, i.e. `test/**/*.test.mts` excluding the helpers subdirectory, likewise not out of scope). Under stage `A` a blocking finding at a class-B path is `ineligible-finding` exactly as before. A row located in `src/` (the "branch has no test" form) is never reviewer-fixable: a test edit cannot satisfy its per-row re-verify, so a reviewer who wants the class-B fix locates the coverage finding at the test file. The action is `commit-a` (class-A bucket only), `commit-b` (class-B only) or `commit-ab` (both); `blockingTestPaths[]` / `followUpTestPaths[]` carry the class-B paths, `blockingPaths[]` / `followUpPaths[]` keep their class-A meaning, and a blocking row AT an AB baseline stays in the class-A bucket. One blocking finding anywhere else makes the whole round `none`: nothing is committed, nothing is pushed, and the trailer and route phases run unchanged on the original FAIL. The phase never edits, filters or re-grades a finding.

```bash
QA_FIXES=""
RC_JSON=""
MASTER_WT=""
MASTER_ROOT_DIR=""
SESSION_ROOT=$(git rev-parse --show-toplevel)
SESSION_HEAD=$(git rev-parse HEAD)
SESSION_STATUS=$(git status --porcelain)
# Gate FIRST: a PASS verdict (or any non-FAIL) never reads the diff, the changed paths or the body.
if [ "$REVIEW_VERDICT" = "FAIL" ]; then
  # TRUST: every script below runs from a dedicated detached worktree of $FIXED_SHA (origin/master),
  # NOT from this session tree (whose HEAD is the PR head, i.e. PR-authored code). Fail closed.
  MASTER_ROOT_DIR=$(mktemp -d) && [ -n "$FIXED_SHA" ] && git worktree add --detach "$MASTER_ROOT_DIR/master" "$FIXED_SHA" >/dev/null 2>&1 \
    && MASTER_WT="$MASTER_ROOT_DIR/master" && { [ ! -d "$SESSION_ROOT/node_modules" ] || ln -sfn "$SESSION_ROOT/node_modules" "$MASTER_WT/node_modules"; }
fi
if [ "$REVIEW_VERDICT" = "FAIL" ] && [ -n "$MASTER_WT" ]; then
  RC_JSON=$(printf '%s' "$FOLD_JSON" | jq --argjson pr "$pr_number" --argjson tier "${PR_TIER_NUM:-null}" \
    '{pr: $pr, tier: $tier, blocking: .fold.blocking, followUps: .fold.followUps}' \
    | (cd "$MASTER_WT" && node --no-warnings --experimental-strip-types "$MASTER_WT/scripts/ci/qa-verdict.ts" reviewer-commit)) || RC_JSON=""   # cwd = master: rolloutStage() reads process.cwd() (INV-1)
fi
RC_ACTION=$(printf '%s' "$RC_JSON" | jq -r '.action // "none"')
RC_HAS_A=0; RC_HAS_B=0
case "$RC_ACTION" in commit-a) RC_HAS_A=1 ;; commit-b) RC_HAS_B=1 ;; commit-ab) RC_HAS_A=1; RC_HAS_B=1 ;; esac
if [ "$REVIEW_VERDICT" = "FAIL" ] && { [ "$RC_HAS_A" = 1 ] || [ "$RC_HAS_B" = 1 ]; }; then
  # The head the fold REVIEWED: captured by the step-3 call, never re-read for the checkout.
  REVIEWED_HEAD=$(printf '%s' "$PREFLIGHT_JSON" | jq -r '.pr.headSha // ""')
  HEAD_REF=$(printf '%s' "$PREFLIGHT_JSON" | jq -r '.pr.headRefName')
  RC_OK=1
  CHECKED_OUT=0
  PR_WT=""
  PR_ROOT_DIR=""
  # TRUST: the master worktree ($MASTER_WT, built from $FIXED_SHA above) is the ONLY place scripts run
  # from. The PR is checked out into a SEPARATE worktree and treated as data; the proof, the regenerators
  # and the checks below are invoked by absolute path under MASTER_WT, never from a PR-authored tree.
  ORIG_BODY_FILE=$(mktemp); RC_BODY_FILE=$(mktemp)   # private tempfiles
  BODY_FIX=$(printf '%s' "$RC_JSON" | jq -r '.bodyFix // false')
  RC_BLOCKING_PATHS=$(printf '%s' "$RC_JSON" | jq -r '.blockingPaths[]?')
  RC_FOLLOWUP_PATHS=$(printf '%s' "$RC_JSON" | jq -r '.followUpPaths[]?')
  RC_BLOCKING_TEST_PATHS=$(printf '%s' "$RC_JSON" | jq -r '.blockingTestPaths[]?')
  RC_FOLLOWUP_TEST_PATHS=$(printf '%s' "$RC_JSON" | jq -r '.followUpTestPaths[]?')
  RC_SHAS=""   # sha12 of every reviewer commit made, comma-separated (the PASS trailer's qa-fixes=)
  [ -n "$REVIEWED_HEAD" ] || RC_OK=0
  # Abort if the PR moved while the review ran: never stack a commit on an unreviewed head.
  [ "$RC_OK" = 1 ] && { [ "$(gh pr view $pr_number --repo gaberoo322/hydra --json headRefOid --jq .headRefOid)" = "$REVIEWED_HEAD" ] || RC_OK=0; }
  # Isolation guard: only ever inside this session's own worktree.
  git rev-parse --git-dir | grep -q '\.git/worktrees/' || RC_OK=0
  # Detached checkout of the EXACT reviewed head into a separate worktree.
  if [ "$RC_OK" = 1 ]; then
    PR_ROOT_DIR=$(mktemp -d) && PR_WT="$PR_ROOT_DIR/pr" || RC_OK=0
    git fetch origin "$HEAD_REF" && git worktree add --detach "$PR_WT" "$REVIEWED_HEAD" && CHECKED_OUT=1 || RC_OK=0
  fi
  if [ "$CHECKED_OUT" = 1 ]; then cd "$PR_WT" || RC_OK=0; fi
  # Save the ORIGINAL body so a failed push can restore it.
  [ "$RC_OK" = 1 ] && { gh pr view $pr_number --repo gaberoo322/hydra --json body --jq .body > "$ORIG_BODY_FILE" || RC_OK=0; }
  if [ "$RC_OK" = 1 ]; then
    # Edit step (cwd is the PR worktree). For each blocking row, in order: open the file named in its
    # File:line cell, apply exactly the change its Fix cell names (only paths in RC_BLOCKING_PATHS; a
    # RC_FOLLOWUP_PATHS path is optional), then run the file's own regenerator BY ABSOLUTE PATH from
    # "$MASTER_WT" with HYDRA_REPO_ROOT="$PR_WT" so it rewrites the PR worktree, never the session tree
    # (HYDRA_REPO_ROOT="$PR_WT" "$MASTER_WT/node_modules/.bin/tsx" "$MASTER_WT/scripts/docs/generate-inventories.ts" for docs/generated/,
    # HYDRA_REPO_ROOT="$PR_WT" node "$MASTER_WT/scripts/test/suite-count-check.mjs" --update-baseline --only <files> for test/fixtures/*-baseline.json). When .bodyFix is true,
    # seed "$RC_BODY_FILE" from "$ORIG_BODY_FILE" and ONLY add bullets under "## Files in scope".
    # A row you cannot resolve with a class-A edit aborts: RC_OK=0.
    #
    # Stage ONLY approved class-A paths (never `git add -A`: it would take node_modules and strays).
    [ -z "$RC_BLOCKING_PATHS" ] || { printf '%s\n' "$RC_BLOCKING_PATHS" | xargs git add -- || RC_OK=0; }
    for p in $RC_FOLLOWUP_PATHS; do
      git add -- "$p" 2>/dev/null || true   # intentional: an unedited optional follow-up is not an error
    done
    STAGED=$(git diff --cached --name-only)
    # Every staged file must be an approved path (blocking or optional follow-up).
    [ -z "$STAGED" ] || { printf '%s\n' "$STAGED" | grep -qvxF -f <(printf '%s\n' "$RC_BLOCKING_PATHS" "$RC_FOLLOWUP_PATHS") && RC_OK=0; }
    # Deterministic re-verify: EVERY BLOCKING path must be in the staged diff, so a partial edit cannot flip FAIL to PASS.
    printf '%s\n' "$RC_BLOCKING_PATHS" | grep -v '^$' | grep -qvxF -f <(printf '%s\n' "$STAGED") && RC_OK=0
    # A claimed body fix MUST have changed the body (unconditionally, even when paths are staged).
    BODY_CHANGED=0
    [ "$BODY_FIX" = true ] && ! cmp -s "$ORIG_BODY_FILE" "$RC_BODY_FILE" && BODY_CHANGED=1
    [ "$BODY_FIX" != true ] || [ "$BODY_CHANGED" = 1 ] || RC_OK=0
    # Something must change at all: nothing staged and no body change would flip FAIL to PASS with no fix.
    if [ "$RC_HAS_A" = 1 ] && [ -z "$STAGED" ] && [ "$BODY_CHANGED" != 1 ]; then RC_OK=0; fi
    if [ "$BODY_FIX" = true ]; then
      # A corrected body must be non-empty, keep its Closes-ref, and (INV-6) differ ONLY by bullets added
      # under "## Files in scope": every other section byte-identical.
      { [ -s "$RC_BODY_FILE" ] && grep -Eq 'Closes #[0-9]+' "$RC_BODY_FILE"; } || RC_OK=0
      node --experimental-strip-types "$MASTER_WT/scripts/ci/qa-commit-checks.ts" body-scope-check "$ORIG_BODY_FILE" "$RC_BODY_FILE" || RC_OK=0   # body-scope-check
    fi
    # Per-row re-verify against the NEW (staged) diff: a row with a file:line needs a git diff -U0 hunk
    # touching or adjacent to that line; a row with no line needs its file in the staged set; the
    # "PR body" row is covered by BODY_CHANGED + body-scope-check above. Any miss aborts: RC_OK=0.
    while IFS= read -r ROW_LOC; do
      case "$ROW_LOC" in [Pp][Rr]\ [Bb]ody) continue ;; esac
      # Location parsing is the TS parser (reviewerCommitLocationRef), never a shell re-implementation.
      ROW_REF=$(node --experimental-strip-types "$MASTER_WT/scripts/ci/qa-commit-checks.ts" row-loc "$ROW_LOC") || { RC_OK=0; continue; }
      ROW_FILE=$(printf '%s' "$ROW_REF" | jq -r '.file')
      ROW_LINE=$(printf '%s' "$ROW_REF" | jq -r '.line // empty')
      printf '%s\n' "$RC_BLOCKING_TEST_PATHS" | grep -qxF -- "$ROW_FILE" && continue   # class-B rows are re-verified by the class-B pass below
      if [ -z "$ROW_LINE" ]; then
        printf '%s\n' "$STAGED" | grep -qxF -- "$ROW_FILE" || RC_OK=0
      else
        git diff --cached -U0 -- "$ROW_FILE" | node --experimental-strip-types "$MASTER_WT/scripts/ci/qa-commit-checks.ts" row-hunk-check "$ROW_LINE" || RC_OK=0
      fi
    done < <(printf '%s' "$FOLD_JSON" | jq -r '.fold.blocking[].location')
    # A body-only round stages nothing: it still makes an EMPTY `QA-Fix: A` commit (INV-6), so the push
    # fires `synchronize` and body-reading gates see the corrected body. QA_FIXES is set only from a commit made here.
    if [ "$RC_OK" = 1 ] && [ "$RC_HAS_A" = 1 ]; then
      git commit -q --allow-empty -m "fix(qa): reviewer class-A fixes for PR #$pr_number" -m "QA-Fix: A" || RC_OK=0
      [ "$RC_OK" != 1 ] || RC_SHAS=$(git rev-parse HEAD | cut -c1-12)
    fi
    # Class B (issue #5268, stage A+B only): ONE separate commit ending "QA-Fix: B", never a combined trailer.
    # Edit ONLY the RC_BLOCKING_TEST_PATHS (RC_FOLLOWUP_TEST_PATHS are optional); a baseline a test edit changes
    # (suite-count, test-source-read) is regenerated from "$MASTER_WT" with HYDRA_REPO_ROOT="$PR_WT" and rides in this commit.
    if [ "$RC_OK" = 1 ] && [ "$RC_HAS_B" = 1 ]; then
      # No-weakening: a class-B edit never lowers the test( / it( count of any file it touches (fails closed).
      for p in $RC_BLOCKING_TEST_PATHS $RC_FOLLOWUP_TEST_PATHS; do
        [ -f "$p" ] || continue
        # A reviewer-added NEW test file has no reviewed-head version: its before-count is 0, so there is nothing to lower.
        git cat-file -e "$REVIEWED_HEAD:$p" 2>/dev/null || continue
        BEFORE_FILE=$(mktemp); git show "$REVIEWED_HEAD:$p" > "$BEFORE_FILE" 2>/dev/null || { RC_OK=0; rm -f "$BEFORE_FILE"; continue; }
        node --experimental-strip-types "$MASTER_WT/scripts/ci/qa-commit-checks.ts" case-count-check "$BEFORE_FILE" "$p" || RC_OK=0   # case-count-check
        rm -f "$BEFORE_FILE"
      done
      [ -z "$RC_BLOCKING_TEST_PATHS" ] || { printf '%s\n' "$RC_BLOCKING_TEST_PATHS" | xargs git add -- || RC_OK=0; }
      for p in $RC_FOLLOWUP_TEST_PATHS test/fixtures/suite-count-baseline.json test/fixtures/test-source-read-baseline.json; do
        git add -- "$p" 2>/dev/null || true   # intentional: an unedited optional path / untouched baseline is not an error
      done
      STAGED_B=$(git diff --cached --name-only)
      # Every staged file must be an approved class-B path or a shared (AB) baseline.
      [ -z "$STAGED_B" ] || { printf '%s\n' "$STAGED_B" | grep -qvxF -f <(printf '%s\n' "$RC_BLOCKING_TEST_PATHS" "$RC_FOLLOWUP_TEST_PATHS" test/fixtures/suite-count-baseline.json test/fixtures/test-source-read-baseline.json) && RC_OK=0; }
      printf '%s\n' "$RC_BLOCKING_TEST_PATHS" | grep -v '^$' | grep -qvxF -f <(printf '%s\n' "$STAGED_B") && RC_OK=0
      [ -n "$STAGED_B" ] || RC_OK=0
      # Per-row re-verify of the class-B rows, same deterministic checks as class A (row-loc, row-hunk-check).
      while IFS= read -r ROW_LOC; do
        case "$ROW_LOC" in [Pp][Rr]\ [Bb]ody) continue ;; esac
        ROW_REF=$(node --experimental-strip-types "$MASTER_WT/scripts/ci/qa-commit-checks.ts" row-loc "$ROW_LOC") || continue
        ROW_FILE=$(printf '%s' "$ROW_REF" | jq -r '.file')
        printf '%s\n' "$RC_BLOCKING_TEST_PATHS" | grep -qxF -- "$ROW_FILE" || continue
        ROW_LINE=$(printf '%s' "$ROW_REF" | jq -r '.line // empty')
        if [ -z "$ROW_LINE" ]; then
          printf '%s\n' "$STAGED_B" | grep -qxF -- "$ROW_FILE" || RC_OK=0
        else
          git diff --cached -U0 -- "$ROW_FILE" | node --experimental-strip-types "$MASTER_WT/scripts/ci/qa-commit-checks.ts" row-hunk-check "$ROW_LINE" || RC_OK=0
        fi
      done < <(printf '%s' "$FOLD_JSON" | jq -r '.fold.blocking[].location')
      if [ "$RC_OK" = 1 ]; then
        git commit -q -m "fix(qa): reviewer class-B test fixes for PR #$pr_number" -m "QA-Fix: B" || RC_OK=0
        [ "$RC_OK" != 1 ] || RC_SHAS="${RC_SHAS:+$RC_SHAS,}$(git rev-parse HEAD | cut -c1-12)"
      fi
    fi
  fi
  # Local deterministic proof BEFORE any push, run from the MASTER-BASED session tree against this PR
  # worktree (cwd); the reviewer never hand-judges it. Two proofs, both must pass: base `$REVIEWED_HEAD` proves the new commit alone (INV-7), and base `$FIXED_SHA` (origin/master) reads the switch stage from master, never from the PR tree.
  # A round carrying a class-B commit runs EXACTLY ONE proof, with base $FIXED_SHA: the $REVIEWED_HEAD base's merge-base IS the
  # reviewed head, which already holds the PR's src changes, so every class-B file would pass there and be refused as unproven.
  # The $FIXED_SHA run still evaluates every QA-Fix commit in mergeBase..HEAD (per-commit class/path allowlist, stage read at master).
  # A non-zero proof (a vacuous test: zero ERR_ASSERTION at the merge-base, or a crashing import) aborts: nothing pushed, body restored.
  if [ "$RC_OK" = 1 ] && [ "$RC_HAS_B" = 1 ]; then
    node --experimental-strip-types "$MASTER_WT"/scripts/ci/qa-fix-proof.ts --base "$FIXED_SHA" --head HEAD || RC_OK=0
  elif [ "$RC_OK" = 1 ]; then
    node --experimental-strip-types "$MASTER_WT"/scripts/ci/qa-fix-proof.ts --base "$REVIEWED_HEAD" --head HEAD \
      && node --experimental-strip-types "$MASTER_WT"/scripts/ci/qa-fix-proof.ts --base "$FIXED_SHA" --head HEAD || RC_OK=0
  fi
  # Body BEFORE push, so the synchronize payload carries the corrected body. Only when .bodyFix is true.
  BODY_EDITED=0
  if [ "$RC_OK" = 1 ] && [ "$BODY_FIX" = true ]; then
    gh pr edit $pr_number --repo gaberoo322/hydra --body-file "$RC_BODY_FILE" && BODY_EDITED=1 || RC_OK=0
  fi
  # Plain fast-forward push only. A rejected push (the remote moved) aborts the commit path.
  [ "$RC_OK" = 1 ] && { git push origin "HEAD:refs/heads/$HEAD_REF" || RC_OK=0; }
  if [ "$RC_OK" = 1 ]; then
    NEW_HEAD=$(git rev-parse HEAD)
    [ "$NEW_HEAD" != "$REVIEWED_HEAD" ] && [ -n "$RC_SHAS" ] && QA_FIXES="$RC_SHAS" || RC_OK=0   # every reviewer commit's sha12, comma-separated
  fi
  if [ "$RC_OK" = 1 ]; then
    REVIEW_VERDICT=PASS; VERDICT=PASS-pending-CI; BLOCKERS=0; MAX_SEVERITY=none
    REVIEW_REPORT="${REVIEW_REPORT}

Reviewer-fixed in ${QA_FIXES} (QA-Fix: A / QA-Fix: B): each blocking row above is fixed-by its commit sha12 in ${QA_FIXES}."
    # INV-4: annotate each blocking row of the findings table in $REVIEW_REPORT with
    # "fixed-by ${QA_FIXES}" in its Fix cell; never delete, filter or re-grade a row.
  else
    # Nothing pushed: restore the original body if we changed it. A failed restore is LOUD, never silent.
    [ "$BODY_EDITED" = 1 ] && { gh pr edit $pr_number --repo gaberoo322/hydra --body-file "$ORIG_BODY_FILE" || echo "ERROR: QA body restore FAILED for PR #$pr_number; report it in the verdict comment" >&2; }
    QA_FIXES=""   # the original FAIL stands at the original head
  fi
  # EVERY exit path: return to the session tree, drop the PR worktree (only if one was created) and the tempfiles.
  cd "$SESSION_ROOT" || echo "ERROR: could not return to $SESSION_ROOT" >&2
  if [ "$CHECKED_OUT" = 1 ]; then git worktree remove -f "$PR_WT" || echo "ERROR: could not remove $PR_WT" >&2; fi
  [ -z "$PR_ROOT_DIR" ] || rm -rf "$PR_ROOT_DIR"
  rm -f "$ORIG_BODY_FILE" "$RC_BODY_FILE"
fi
# Drop the master script worktree and assert the session tree was never switched or dirtied.
if [ -n "$MASTER_WT" ]; then git worktree remove -f "$MASTER_WT" || echo "ERROR: could not remove $MASTER_WT" >&2; fi
[ -z "$MASTER_ROOT_DIR" ] || rm -rf "$MASTER_ROOT_DIR"
[ "$(git rev-parse HEAD)" = "$SESSION_HEAD" ] || echo "ERROR: session tree HEAD moved off $SESSION_HEAD" >&2
[ "$(git -C "$SESSION_ROOT" status --porcelain)" = "$SESSION_STATUS" ] || echo "ERROR: session tree status changed during the reviewer commit" >&2
```

A round makes at most one commit ending `QA-Fix: A` and at most one ending `QA-Fix: B`, never a combined trailer; the PASS trailer's `qa-fixes=` names every commit made. A class-B edit may never reduce coverage by deletion (`case-count-check`, fails closed), and the proof is per file: an edit whose file still passes at the merge-base, or whose import crashes there, is unproven and the round commits nothing; `qa-fix-proof.yml` re-runs the same proof on the pushed head and `qa-merge-guard` holds with `qa-fix-proof-not-green` until it is green. The stage switch is flipped only by the operator-merged graduation item that `scripts/qa/commit-graduation.ts` files. A reviewer-commit round is one `round=` like any other and never counts as a FAIL round; the round cap and the T4 2-strike rule are untouched. Bare `PASS` is unreachable on such a round: the verdict is `PASS-pending-CI` at the NEW head, and the autopilot's auto-merge goes through `qa-merge-guard`, which holds with `qa-fix-proof-not-green` until the `qa-fix-proof` workflow is green on that head. The trailer inputs below pass `$QA_FIXES` and the new head SHA explicitly to the `trailer` phase.

### 9.5 Trailer inputs after a reviewer commit

When the reviewer commit above committed, the trailer phase receives the new head and the QA-Fix sha explicitly:

```bash
TRAILER_JSON=$(jq -n --argjson pr "$pr_number" --arg verdict "$VERDICT" \
  --argjson blockers "${BLOCKERS:-0}" --arg severity "${MAX_SEVERITY:-none}" \
  --arg qafix "${QA_FIXES:-}" --arg newhead "${NEW_HEAD:-}" \
  '{pr: $pr, verdict: $verdict, blockers: $blockers, maxSeverity: $severity}
   + (if $qafix != "" then {headSha: $newhead, qaFixes: ($qafix | split(","))} else {} end)' \
  | node --no-warnings --experimental-strip-types scripts/ci/qa-verdict.ts trailer)
```
