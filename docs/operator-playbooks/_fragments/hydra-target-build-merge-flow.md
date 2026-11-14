# hydra-target-build — Merge flow reference (Steps 7–10)

Read this file when you reach the merge phase of a hydra-target-build execution.
It covers: pre-merge baseline snapshot, the PR-only merge path, deploy
verification (the Target's own CI-owned deploy — never a hand deploy), post-merge
verify, operational-health smoke, worktree cleanup, state sync, friction report,
and the final summary table.

**The build never deploys.** Shipping is: open the PR → the
Target's required CI → the Target's automerge (e.g. an `automerge.yml` that
squash-merges a green, unfenced PR) → the Target's CI run on `main` → its
`deploy` job. The Target's `main` may be branch-protected with PRs required, so
the build never pushes to `main`. `$TARGET_WS` is the **serving tree** that the
Target's deploy job pulls, builds, and restarts from: the build never
fast-forwards it, never checks out or merges in it, never runs tests or builds in
it, and never restarts the Target's service. Every post-merge step below is a
**read** of GitHub state and the live Target — the only writes are to the Target
board, the orchestrator API, and (on regression) a revert PR opened from
`$TARGET_WT`.

### 7. Merge (PR-only — the Target's automerge lands it)

**Close-discipline (ADR-0031 Decision 5 — enforced `Closes #N`).** When this build was anchored on a `$TARGET_GH_REPO` GitHub issue (Step 2 priority 3, the board pick), the Target PR body MUST end with `Closes #<ANCHOR_NUM>` for the issue it resolves. The Target's automerge then closes the issue and removes it from the open board; the issue-close IS the terminal signal, and no separate lane-move step exists. A failing-test / priorities-doc anchor has no issue number, so its PR carries no `Closes` line.

For an anchor carrying a fencing label (`money-critical` / `hold-for-operator`) this link is load-bearing for the operator-review fence itself: the workflow's fence reads the PR's own labels directly but resolves the ANCHOR's labels only through the PR's linked issues, so without the `Closes #<ANCHOR_NUM>` link the workflow's fence cannot see the anchor, and the PR squash-merges on green unreviewed. A resume (Step 0.7) must therefore keep the `Closes` link and mirror the fencing label onto the PR — a `Refs`-only resume PR with no label of its own is invisible to the fence. Verify the link is present in the PR body BEFORE its CI can conclude (i.e. at PR creation), not at merge time; the 7b fence-blind branch below handles the case where it was missed.

The PR body MUST include the self-declared scope captured in Step 3.5:

```markdown
## Self-declared scope

The build picked this task autonomously — these are the files the planner intended to touch:

## Files in scope

$SCOPE_IN_LIST

$SCOPE_JUSTIFICATIONS

Closes #$ANCHOR_NUM   <!-- only when the anchor was a Target board issue; omit for failing-test / priorities-doc anchors -->
```

Just before the PR can merge, capture the **pre-merge health baseline** for the Step 8.6
delta comparison. While the Target baseline is ambiently degraded
(stale data, missing external creds), absolute thresholds cannot tell a
merge-caused regression from the pre-existing state — the snapshot lets the
post-merge check alarm only on what THIS merge changed. Run the mirrored script
from the worktree (synced into the gate dir by Step 0.6). Fail-soft: if the
Target is unreachable, no baseline file is written and Step 8.6 falls back to
absolute thresholds — do NOT branch the cycle on this step's outcome.

**MANDATORY.** Capturing this baseline is NOT optional. Without a
`pmh-baseline.json`, Step 8.6 falls back to absolute thresholds and — against an
ambiently-degraded Target — false-alarms `hydra-target-incident` on every merge,
even for type-only refactors that cannot touch the alarming services (friction
cue `pmh-absolute-threshold-false-alarm-on-pr-automerge-path`). Capture it before
the PR can merge (at the latest right after opening it, before its CI concludes),
while the worktree mirror (Step 0.6) is still present, so Step 8.6 stays in delta mode.

```bash
# Pre-merge health baseline — consumed by Step 8.6 via --baseline. Run it
# before the PR can merge.
npx tsx "$HYDRA_GATE_DIR/scripts/target/post-merge-health.ts" \
  --snapshot-out "$HYDRA_GATE_DIR/pmh-baseline.json"
```

**PR-only merge path.** Push the worktree's feature branch and open
the PR against `main`; never merge locally and never push to `main` (a
branch-protected `main` rejects it, and the serving tree must not be touched):

```bash
cd "${TARGET_WT:?unset - re-run the seam preamble in this Bash call}"
git push -u origin "feature/$CYCLE_ID"
# Body carries the Self-declared scope block above + Closes #$ANCHOR_NUM (board anchors).
PR_URL=$(gh pr create --repo "$TARGET_GH_REPO" --base main --head "feature/$CYCLE_ID" \
  --title "<task title>" --body-file "$PR_BODY_FILE")
PR_NUM="${PR_URL##*/}"
```

Do NOT arm GitHub-native auto-merge and do NOT `gh pr merge` on the happy path:
the Target's own automerge workflow merges a green, unfenced PR. The build's job
is to wait for CI in the foreground (the foreground-wait contract in the main
playbook) and then observe the outcome per 7b.

#### 7b. PR merge completion — already-merged-post-green is SUCCESS, not friction

This subsection covers a Target PR (`$TARGET_GH_REPO`) that CI + the Target's
own automerge workflow (e.g. `automerge.yml` in the target repo) land. It does
NOT apply to the orchestrator (`gaberoo322/hydra`) merge path.

The Target's `main` is typically branch-protected (a required CI check, PRs
required), and its automerge workflow squashes the PR the moment that CI goes
green (it may also dispatch CI on `main`, since a merge made with the workflow
token emits no push event — that main-branch run is what deploys). So by the time this build reaches its
explicit merge step, the PR is very often **already merged** — the squash landed
by `automerge.yml` on the `workflow_run`-success that this build was itself
polling for. That is a benign, expected race: the merge succeeded. Treat it as a
SUCCESS terminal state, never as friction.

```bash
# Poll CI to green, then observe the PR's merge state. (The cue fix below does
# NOT depend on who wins the squash race.)
PR_STATE=$(gh pr view "$PR_NUM" --repo "$TARGET_GH_REPO" \
  --json state,mergedAt,mergeStateStatus 2>/dev/null || echo '')
PR_MERGED=$(printf '%s' "$PR_STATE" | jq -r '.state // ""' 2>/dev/null)   # "MERGED" once landed
```

**Resolve the operator-review fence FIRST — all
three branches below read its result.** The fence lookup is predicate-aligned
with the workflow: it resolves the SAME subjects the workflow's own fence
resolves — the PR's OWN labels first (the workflow reads those before anything
else), then every same-repo issue the PR links via `closingIssuesReferences` —
plus the anchor as belt-and-braces. On a Target whose CI applies the fencing
label to the PR itself, the PR-label read is the load-bearing one: the linked
issue AND the anchor can both carry no fencing label while the PR is fenced.

**Timing: the fencing label can land on the PR DURING
the PR's CI run** — the Target's labelling job classifies the diff and labels
the PR inside that same run, so a label read racing an in-flight run mistakes
a not-yet-applied fence for absence. The lookup below is therefore only valid
after that run CONCLUDED — the "poll CI to green" step above it guarantees the
ordering. Never hoist the lookup above the CI poll, and never run it while any
check is still queued or in progress.

```bash
# Fence lookup — FAIL CLOSED and PREDICATE-ALIGNED: branch on gh's exit code,
# never on empty output, and resolve the same subjects the workflow's fence
# resolves — the PR's own labels, every same-repo issue this PR links, and the
# anchor. An issue/anchor-only lookup would merge a PR the workflow withheld.
FENCE_LOOKUP="ok"
FENCED=""
LINKED=""
# The `--jq` argument is single-quoted (no shell expansion), so
# `env.TARGET_GH_REPO` reads the exported env var through gh's own jq engine.
LINKED=$(gh pr view "$PR_NUM" --repo "$TARGET_GH_REPO" \
  --json closingIssuesReferences \
  --jq '.closingIssuesReferences[]
        | select((.repository.owner.login + "/" + .repository.name)
                 == env.TARGET_GH_REPO)
        | .number' 2>/dev/null) || FENCE_LOOKUP="failed"
# The PR's OWN labels: the workflow's fence reads them FIRST, so this read is
# predicate-alignment, not belt-and-braces. The literal label set below
# deliberately mirrors the workflow's own literals so the two fences cannot
# drift apart (a manifest-configurable set would need an ADR-0026 amendment).
if ! PR_LABELS=$(gh pr view "$PR_NUM" --repo "$TARGET_GH_REPO" \
      --json labels --jq '.labels[].name' 2>/dev/null); then
  FENCE_LOOKUP="failed"
else
  PR_HIT=$(printf '%s\n' "$PR_LABELS" \
    | grep -xE 'money-critical|hold-for-operator' || true)
  [ -n "$PR_HIT" ] && FENCED="$FENCED PR #$PR_NUM itself ($PR_HIT)"
fi
# (portable word-split: command substitution splits under both bash and zsh)
for N in $(printf '%s' "$LINKED") ${ANCHOR_NUM:-}; do
  if ! ISSUE_LABELS=$(gh issue view "$N" --repo "$TARGET_GH_REPO" \
        --json labels --jq '.labels[].name' 2>/dev/null); then
    FENCE_LOOKUP="failed"
  else
    HIT=$(printf '%s\n' "$ISSUE_LABELS" \
      | grep -xE 'money-critical|hold-for-operator' || true)
    [ -n "$HIT" ] && FENCED="$FENCED issue #$N ($HIT)"
  fi
done
# Fenced means: $FENCED non-empty (a fencing label on the PR itself, the
# anchor, or any linked issue) OR $FENCE_LOOKUP == "failed" (could not
# confirm — treat as fenced). Empty $LINKED with an empty anchor (a failing-test /
# priorities-doc pick that links no issue) resolves nothing: unfenced,
# mirroring the workflow, which merges a PR with no closingIssuesReferences.
```

**Decision — the load-bearing branch:**

- **PR is MERGED and CI concluded green** → this is the **already-merged-post-green
  SUCCESS terminal state.** The merge step is COMPLETE. Read `COMMIT_SHA` from the
  merged PR's merge commit (`gh pr view "$PR_NUM" --json mergeCommit --jq
  '.mergeCommit.oid'`) for the metrics/event bookkeeping below.
  - **Explicitly DO NOT POST the `target-automerge-lands-before-explicit-merge`
    cue to `/api/memory/subagent-friction`.** The merge succeeded; recording
    friction here is spurious noise.
  - Fall through to **Step 8.5** (worktree cleanup + branch delete) and **Step 9**
    (state sync: move ITEM_ID to done, `tasksMerged:1` metrics record,
    `cycle:completed` event with `merged:true`, and `/cycle/complete`
    registration) **identically to a build-performed merge.** Nothing is silently
    skipped — the post-merge bookkeeping is the same regardless of who landed the
    squash. The post-merge health steps (7.5 deploy, 8 verify, 8.6 smoke) also
    run as normal; the Step 7 `pmh-baseline.json` you captured before enabling
    auto-merge feeds Step 8.6 in delta mode.
  - The **post-green qualifier is load-bearing**: an already-merged PR whose CI is
    NOT green / still in progress is NOT a clean success — do not silently treat it
    as one. Wait for CI to conclude before classifying the outcome.
  - The **fence qualifier is load-bearing**: a
    merged fenced PR is success ONLY when the operator merged it. A hit on the
    PR's OWN labels, or on any issue among `$LINKED`, means exactly that — the
    workflow's fence reads the PR's own labels first and every linked issue, so
    it held the PR and a human merged it: the fence working, treat as success.
    But a fencing hit on the ANCHOR that is NOT among `$LINKED` means the PR
    never carried the `Closes` link the workflow's fence resolves — and if it
    is not mirrored on the PR's own labels either, the workflow, not an
    operator, merged a fenced PR unreviewed. That is a fence
    breach: report it to the operator as such, and do NOT
    let Step 9's residual close guard close the fenced issue as completed — the
    change landed without the review the fence exists to force.

- **PR is NOT merged, and the fence holds** (the PR itself, any same-repo
  issue it links, or the anchor carries `money-critical` or
  `hold-for-operator` — **or the fence lookup itself failed**) → **STOP: the
  merge is the operator's**. The emulated automerge deliberately skips fenced
  PRs — its run log + step summary say "fenced for operator review" — so
  green-but-unmerged here is the fence working, not merge friction.
  **Detect the fence at the source** (the PR's own labels plus the linked
  issues' labels — the SAME subjects the workflow's own fence resolves, which
  is why the lookup above reads the PR's labels and `closingIssuesReferences`
  and not just the anchor), never by
  scraping workflow logs. **Fail closed: a failed lookup —
  transient API error, rate limit, auth expiry — is indistinguishable from a
  confirmed "not fenced", so it counts as FENCED.** Only a successful label
  read with no fencing label releases the explicit merge.

  When `$FENCED` is non-empty — or the lookup failed — the build's terminal
  state is **green PR open, fenced for operator review** — report the PR
  number and each fencing hit (or the lookup failure) as the final answer and
  stop.
  Specifically:
  - **NEVER merge it yourself, retry the merge, or re-run the workflow.** An
    explicit `gh pr merge` here is exactly the unreviewed merge the fence
    exists to prevent. There is no direct-to-main path at all — the PR is the
    only path any change, fenced or not, may take.
  - **Do NOT remove the fencing label** from the issue or from the PR itself
    — that is the operator's release lever, not the build's (on a Target
    whose CI applies the label, re-running that CI re-applies it anyway —
    removal is not even temporarily effective).
  - **Do NOT delete the remote branch** — deleting it closes the PR and
    discards the operator's review target. Local worktree cleanup (Step 8.5)
    is safe and should still run.
  - **If the only fencing hit is the anchor and `$ANCHOR_NUM` is not among
    `$LINKED`, the fence is blind to this PR** — the PR body lacks the
    `Closes #<ANCHOR_NUM>` link the workflow's fence resolves (the
    close-discipline in Step 7 makes that link mandatory for exactly this
    reason), so the next green workflow run squash-merges it unreviewed the
    moment this handoff ends. Take the one mechanical hold available to the
    build first — mark the PR draft (`gh pr ready --undo`; the workflow's
    merge selector skips drafts) — then add the missing `Closes`
    link to the PR body so the fence can see the anchor, and report both
    actions alongside the fencing label.
  - **A hit on the PR's own labels is never fence-blind**
    — the workflow reads PR labels directly, so it is already holding
    this PR; there is no missing `Closes` link to add and no draft-mark
    remediation to take. Report the PR and the label as the final answer and
    stop.
  - **Skip Steps 7.5, 8, and 8.6 — NOT Step 8.5** (no deploy, no post-merge
    verify, no `merged:true` / done-move): nothing has landed on main, so
    there is nothing to deploy, verify, or mark shipped. The merge and
    everything after it belong to whoever merges. The skip list names its
    steps individually on purpose: a "7.5–8.6" range
    numerically swallows Step 8.5 and contradicts the carve-out in the
    bullet above. Step 8.5 still runs — on an unmerged fenced branch its
    local `git branch -d` simply refuses (branch not merged), which that
    step's own `|| echo warn` already absorbs.

- **PR is NOT merged, and the fence lookup SUCCEEDED with no fencing label**
  → give the Target's automerge one more foreground poll to land it, then
  attempt the explicit merge yourself (`gh pr merge "$PR_NUM" --repo
  "$TARGET_GH_REPO" --squash` — a PR merge, never a local `git merge` or a push
  to `main`). **Record
  friction (`target-automerge-lands-before-explicit-merge` or the
  genuine merge-failure cue) ONLY if that explicit merge actually fails.**
  This is the only branch that records the cue — the genuine merge-failure
  signal is preserved; suppression is narrowly the already-merged-post-green
  case, nothing wider. A fenced skip — label match or lookup failure — is not
  friction either — it is the fence working as designed; do not record a cue
  for it. This branch is only reachable because the lookup above SUCCEEDED
  across the PR's own labels, every linked issue AND the anchor — that
  coverage is what makes the
  explicit merge safe. A workflow fence-skip on any linked issue always
  outranks the explicit merge; if the lookup failed, you are in the fenced
  branch above, never here.

### 7.5. Deploy verification — wait for the Target's own deploy

The Target deploys itself: its CI run on `main` (started by the merge's push, or
dispatched by its automerge workflow) runs a `deploy` job after the required
checks pass. This step only **observes** that pipeline. It NEVER fast-forwards,
builds, or tests in `$TARGET_WS`, NEVER runs the Target's deploy script by hand,
and NEVER restarts the Target's service — a hand deploy races the CI-owned one
and mutates the serving tree the deploy job owns.

All probes below are **single-shot reads** (guard-compatible: no loops, no
nested substitution). Re-run a probe as a separate FOREGROUND call roughly every
30s until it settles or a ~20-minute budget expires — never background the wait.

**(a) Merge commit.** Read it from the merged PR (REST):

```bash
PR_REST=$(gh api "repos/$TARGET_GH_REPO/pulls/$PR_NUM")
COMMIT_SHA=$(printf '%s' "$PR_REST" | jq -r '.merge_commit_sha // empty')
MERGED_AT=$(printf '%s' "$PR_REST" | jq -r '.merged_at // empty')
export MERGED_AT
# Empty MERGED_AT => not merged yet: go back to 7b, do not proceed.
```

**(b) The CI run on `main` that covers the merge.** Runs on `main` created at or
after the merge, excluding PR-event runs. Prefer the run whose `head_sha` is the
merge commit; if back-to-back merges folded it into a later run, the earliest
later run covers it cumulatively.

```bash
gh api "repos/$TARGET_GH_REPO/actions/runs?branch=main&per_page=30" \
  --jq '.workflow_runs[]
        | select(.event != "pull_request" and .created_at >= env.MERGED_AT)
        | "\(.id)\t\(.head_sha)\t\(.name)\t\(.status)\t\(.conclusion)"' \
  > "$HYDRA_GATE_DIR/main-runs.tsv"
RUN_ID=$(awk -F'\t' -v sha="$COMMIT_SHA" '$2==sha {id=$1} END {print id}' "$HYDRA_GATE_DIR/main-runs.tsv")
[ -n "$RUN_ID" ] || RUN_ID=$(awk -F'\t' 'END {print $1}' "$HYDRA_GATE_DIR/main-runs.tsv")
# Empty RUN_ID => no main run yet: re-probe. (The runs API lists newest first,
# so the last row is the earliest run after the merge.)
```

**(c) The run's jobs — checks and deploy.** A job whose name matches `deploy` is
the deploy; every other job is post-merge verification (Step 8).

```bash
gh api "repos/$TARGET_GH_REPO/actions/runs/$RUN_ID/jobs" \
  --jq '.jobs[] | "\(.name)\t\(.status)\t\(.conclusion)"' \
  > "$HYDRA_GATE_DIR/main-jobs.tsv"
DEPLOY_JOB=$(awk -F'\t' 'tolower($1) ~ /deploy/ {print $2 "/" $3}' "$HYDRA_GATE_DIR/main-jobs.tsv")
# DEPLOY_JOB: "completed/success" => deployed; "completed/failure" => deploy
# failed; "completed/cancelled" or "completed/skipped" => superseded or gated
# (re-probe (b) for a later main run); "in_progress/" or "queued/" => re-probe;
# empty => this Target's CI has no deploy job (record "deploy: not CI-owned").
```

**(d) Deployed-SHA marker — optional, generic.** If the Target publishes a
deployed-commit marker at `$TARGET_WEB_URL/deploy-sha.txt`, confirm the running
commit is the merge commit or a descendant of it (a later merge deployed
cumulatively). A Target without the marker (non-200, or not a 40-hex SHA) skips
this check — absence is not a failure.

```bash
DEPLOYED_SHA=$(curl -sf "$TARGET_WEB_URL/deploy-sha.txt" | tr -d '[:space:]' | grep -xE '[0-9a-f]{40}' || true)
git -C "${TARGET_WT:?unset - re-run the seam preamble in this Bash call}" fetch --quiet origin main
if [ -z "$DEPLOYED_SHA" ]; then
  echo "deploy-sha marker: absent — skipping SHA comparison"
elif git -C "${TARGET_WT:?unset - re-run the seam preamble in this Bash call}" merge-base --is-ancestor "$COMMIT_SHA" "$DEPLOYED_SHA"; then
  echo "deploy-sha marker: serving $DEPLOYED_SHA, which contains merge commit $COMMIT_SHA"
else
  echo "DEPLOY DRIFT: serving $DEPLOYED_SHA, which does not contain $COMMIT_SHA"
fi
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$TARGET_WEB_URL/api/health")
[ "$HTTP" != "200" ] && echo "DEPLOY WARNING: /api/health=$HTTP"
```

**Outcomes:**

- **Deploy job succeeded and the marker (if present) contains the merge commit**
  → deployed. Continue to Step 8.
- **Deploy job failed, or DEPLOY DRIFT persists after the deploy job succeeded**
  → deploy failure. Do NOT re-run the deploy script, restart the service, or
  touch `$TARGET_WS`. Record it in the report (run id + failing job) and route
  it to `hydra-target-incident` (the Target incident skill owns
  investigate / fix / revert for deploy failures). If the failure is
  attributable to this merge's diff, open a revert PR per Step 8 so the
  Target's own pipeline redeploys the previous state.
- **Budget expired with the run or deploy still pending** → not a failure: the
  merge landed. Report `deploy: pending (run <id>)` and continue; never re-arm
  the wait or background it.
- A degraded `/api/health` is a warning only.

### 8. Post-merge verify — the main-branch CI run (revert PR on regression)

Post-merge verification is the **non-deploy jobs of the same main-branch CI run**
from Step 7.5(c) — the Target's declared checks re-run on the merged commit. Do
NOT run the test suite in `$TARGET_WS` (the serving tree) and do NOT treat the
PR's pre-merge run as post-merge proof.

- All non-deploy jobs `completed/success` → verified.
- A non-deploy job `completed/failure` on the run covering the merge commit,
  while the PR's own CI was green → **regression introduced by the merge** (e.g.
  a semantic conflict with a concurrent merge). Open a **revert PR** from the
  worktree — never push to `main`, never revert in `$TARGET_WS`:

```bash
cd "${TARGET_WT:?unset - re-run the seam preamble in this Bash call}"
git fetch --quiet origin main
git checkout -b "revert/$CYCLE_ID" origin/main
git revert --no-edit "$COMMIT_SHA"     # a squash merge has a single parent
git push -u origin "revert/$CYCLE_ID"
gh pr create --repo "$TARGET_GH_REPO" --base main --head "revert/$CYCLE_ID" \
  --title "revert: <task title> (post-merge regression)" \
  --body "Reverts $COMMIT_SHA: main-branch CI run $RUN_ID failed after merging PR #$PR_NUM."
```

The revert PR goes through the same required CI + automerge + CI-owned deploy as
any other change. Report the regression and the revert PR number.

### 8.6. Post-merge operational-health smoke check (alarm-only)

After the merge has landed and the Target's deploy has been observed (Step 7.5), run the
**alarm-only** operational-health smoke check. Target outcomes can lag the
merge by hours or days, so instead of holding a merge back on an outcome signal,
we let the merge land and then sample fast, merge-attributable operational signals the Target already exposes
(e.g. a Target-side health endpoint — overall status + per-service health
signals). On a regression past a configurable noise floor it
raises a `hydra-target-incident` alarm.

ALARM-ONLY: this step NEVER reverts and NEVER blocks a merge. It observes
post-merge and routes to `hydra-target-incident`, which decides whether to
investigate/fix/revert. The revert-PR path is Step 8 (main-branch CI
regression) only — do NOT add a revert here.

REALM ROUTING (ADR-0025): the watcher dispatches the Target-scoped
`hydra-target-incident`, NOT the Orchestrator's `hydra-incident`. Each
Operate-layer incident skill is single-realm — `hydra-target-incident` operates
only on `$TARGET_WS`, `hydra-incident` only on `~/hydra`. The dispatch
target string lives in `scripts/target/post-merge-health.ts` (the `--dispatch`
spawn); it and this playbook move in lockstep.

Run the **mirrored** script from the worktree (Step 0.6 syncs it
into the SIBLING gate dir `$HYDRA_GATE_DIR`, outside `$TARGET_WT`); do NOT
invoke it from `~/hydra`. This step runs BEFORE the Step 8.5 worktree cleanup,
so the mirror is still present.

```bash
cd "${TARGET_WT:?unset - re-run the seam preamble in this Bash call}"
# --dispatch fires hydra-target-incident on a real regression; omit it for a
# print-only dry-run. --baseline is the Step 7 snapshot: the watcher then alarms
# only on deltas vs that baseline, so ambient pre-existing degradation never
# false-alarms. Freshness-class services (HYDRA_PMH_FRESHNESS_SERVICES) have
# their single ok->soft transition suppressed; any error transition, any
# worsening from a not-ok baseline, and any hard-check ok->degraded still alarm.
npx tsx "$HYDRA_GATE_DIR/scripts/target/post-merge-health.ts" \
  --merge-sha "$COMMIT_SHA" --dispatch \
  --baseline "$HYDRA_GATE_DIR/pmh-baseline.json"
```

Fail-soft: if the Target API is truly unreachable (service restarting, port not
up, non-JSON body), the script logs and exits 0 — an unreachable Target is not a
merge regression and must never look like a build failure. A non-2xx response
that still carries a health JSON body IS a valid sample (the Target health
endpoint answers 503 with a full body when degraded), so a degraded baseline
still yields signal. The exit code is informational only (75 on alarm, 0
otherwise); do NOT branch the cycle on it. Tune the noise floor via the
`HYDRA_PMH_*` env vars documented at the top of
`scripts/target/post-merge-health.ts`.

If the baseline file is missing (Step 7 snapshot skipped or Target down
pre-merge), the watcher falls back to absolute thresholds, and the Target's
ambient degraded services trip them on every merge. Before honoring an
absolute-mode alarm, cross-check it against this build's in-scope diff
(`scopeBoundary.in`, computed in Step 3.5): if EVERY alarming service is a
known-ambient degraded service AND no changed path can reach those services
(type-only refactors, UI-only components, `package.json` config), treat it as a
baseline-miss false positive — omit `--dispatch` for that run and log the
friction cue `pmh-absolute-threshold-false-alarm-on-pr-automerge-path` instead
of spawning `hydra-target-incident`. Any alarming service outside the ambient
set, or any changed path that could reach an alarming service, still dispatches
normally.

### 8.5. Worktree cleanup

On success, remove the target worktree created in Step 0.6, **prune stale worktree metadata**, THEN delete the merged feature branch — in that order. `git branch -d` fails with "branch ... used by worktree" while the worktree still holds the branch checked out, which is why the delete lives here and not in Step 7 (friction cue: `worktree-held-branch-blocks-local-delete`). The `git worktree prune` between the two is load-bearing: an interrupted remove (or an out-of-band `rm -rf` of `$TARGET_WT`) can leave an orphaned `.git/worktrees/<id>` entry that still claims the branch is in use; prune only drops entries git itself agrees are unused, so it never touches a live worktree. On failure, `scripts/branch-prune.sh` GCs both on the next daily sweep — leaking is acceptable on crash but not on the happy path. The resume arm (Step 0.7) never reaches the merge phase and runs this step as written here.

```bash
git -C "${TARGET_WS:?unset - re-run the seam preamble in this Bash call}" worktree remove --force "$TARGET_WT" 2>&1 || \
  echo "warn: worktree remove failed for $TARGET_WT — branch-prune.sh will GC it later"
# Remove the SIBLING gate dir: the mirror, pmh-baseline.json and build logs are
# disposable. This runs AFTER Step 8.6 has consumed --baseline (order 8.6 → 8.5).
rm -rf "$HYDRA_GATE_DIR"
# Reconcile stale worktree metadata before the branch delete.
git -C "${TARGET_WS:?unset - re-run the seam preamble in this Bash call}" worktree prune 2>&1 || \
  echo "warn: worktree prune failed in $TARGET_WS — branch-prune.sh will reconcile later"
git -C "${TARGET_WS:?unset - re-run the seam preamble in this Bash call}" branch -d "feature/$CYCLE_ID" 2>&1 || \
  echo "warn: branch delete failed for feature/$CYCLE_ID — branch-prune.sh will GC it later"
```

### 9. State sync (critical)

`$TASK_TITLE` (used by the metrics / event / lesson writes below) is the anchor's subject — set it to the board issue's title for a board anchor, otherwise the plan's task title:
```bash
TASK_TITLE="${ANCHOR_SUBJECT:-<task title>}"
```

**Board close-out — `Closes #N` is the sole terminal signal (ADR-0031 Decision 4/5).** Target tracking lives as GitHub Issues on `$TARGET_GH_REPO`; there is no Redis backlog lane and no `POST/PATCH /backlog` write. When the anchor was a board issue, the PR body's `Closes #$ANCHOR_NUM` (Step 7) is what `automerge.yml` reads to close the issue explicitly on merge (GitHub's native auto-close does not fire on the emulated-automerge path; ADR-0031 Decision 5). That close removes the issue from the open board and IS the terminal state-sync; the in-flight signal is the `in-progress` label the Step 2 claim stamped. Completion is also recorded by the metrics record and `cycle:completed` event below.

```bash
# Board anchor: automerge.yml closes the `Closes #$ANCHOR_NUM` issue explicitly
# within seconds of the merge. This block is the residual guard, NOT the
# mechanism: it only runs if this agent survives to Step 9 (one REST read;
# covers merges that bypassed automerge.yml). Never GraphQL here (ADR-0031
# Decision 6).
if [ -n "${ANCHOR_NUM:-}" ]; then
  STATE=$(gh api "repos/$TARGET_GH_REPO/issues/${ANCHOR_NUM}" --jq '.state')
  if [ "$STATE" = "open" ]; then
    gh issue close "$ANCHOR_NUM" --repo "$TARGET_GH_REPO" \
      --reason completed --comment "Closed by merged PR #${PR_NUM} (Closes-linkage fallback)."
  fi
fi
```

Record metrics:
```bash
hydra raw POST /metrics/record "{
  \"cycleId\":\"$CYCLE_ID\",\"source\":\"claude\",
  \"tasksAttempted\":1,\"tasksMerged\":1,\"tasksFailed\":0,
  \"testsBefore\":$TESTS_BEFORE,\"testsAfter\":$TESTS_AFTER,
  \"filesChanged\":$FILES_CHANGED,\"totalDurationMs\":$DURATION_MS,
  \"taskTitle\":\"$TASK_TITLE\",\"anchorType\":\"$ANCHOR_TYPE\",
  \"regressionIntroduced\":false
}"
```

This endpoint routes through the `recordCycle()` coordinator, so the inline merge-time write is a full cycle record (`hydra:cycle:<id>` hash, index membership, scheduler-counter bump). `reap.py` also fires `POST /autopilot/cycle-record` for this `$CYCLE_ID`; the coordinator's idempotency guard prevents double-counting.

Publish event:
```bash
# Carry the merged file paths so the `cycle:completed` reactor can tier-classify
# the cycle's side. $FILES_CHANGED above is the INTEGER COUNT the metrics trend
# consumes; THIS is the string[] path list the side classifier consumes.
FILES_JSON=$(gh pr view "$PR_NUM" --repo "$TARGET_GH_REPO" \
  --json files --jq 'map(.path)' 2>/dev/null || echo '[]')
hydra raw POST /events/publish "{
  \"type\":\"cycle:completed\",\"correlationId\":\"$CYCLE_ID\",
  \"payload\":{\"source\":\"claude\",\"taskTitle\":\"$TASK_TITLE\",\"commitSha\":\"$COMMIT_SHA\",\"merged\":true,\"filesChanged\":$FILES_JSON,\"testDelta\":$((TESTS_AFTER - TESTS_BEFORE))}
}"
```

Complete cycle registration:
```bash
hydra raw POST /cycle/complete "{\"cycleId\":\"$CYCLE_ID\",\"source\":\"claude\",\"status\":\"completed\"}"
```

On failure — lesson capture for shared learning. This is the only post-cycle writer to `hydra:memory:{agent}:patterns` (agent = executor) for Claude-driven builds; the endpoint forwards to `recordPattern()`.
```bash
# Pick the cue that matches the failure mode:
#   verification-failure | no-diff | rollback
CUE="verification-failure"   # change per failure mode
hydra raw POST /memory/subagent-lesson "{
  \"skill\":\"hydra-target-build\",
  \"outcome\":\"$CUE\",
  \"cue\":\"$CUE\",
  \"context\":\"$CYCLE_ID: $TASK_TITLE — <what failed>\",
  \"cycleId\":\"$CYCLE_ID\"
}"
```

API failures: log but don't fail the build. The endpoint is idempotent on
`(skill, outcome, cue)` — multiple calls for the same logical event merge
into one pattern (hit count increments).

### 9.5. Friction Report (ALWAYS, even on success)

The child agent ALSO emits a `## Friction Report` section in its return,
even on a clean merge. Each item is a piece of soft friction the agent
worked around without failing — captured so successor dispatches don't
re-discover it.

**Child-prompt contract (the dispatched BG agent MUST emit this):**

```markdown
## Friction Report

- cue: stale-local-master-ref
  workaround: used origin/master for diff base
  context: git rev-parse origin/master
- cue: vitest-flake-in-foo-spec
  workaround: re-ran the specific suite; passed on second attempt
  context: src/foo/__tests__/foo.spec.ts
```

Rules:
- `cue` MUST be kebab-case, stable across runs.
- `workaround` is exactly one line.
- `context` is exactly one line.
- If no friction worth noting, emit `- (none)`.

**Parent post-flight:**

After the BG returns, parse each `## Friction Report` item and POST to
`/api/memory/subagent-friction`:

```bash
hydra raw POST /memory/subagent-friction "{
  \"skill\":\"hydra-target-build\",
  \"cue\":\"$CUE\",
  \"workaround\":\"$WORKAROUND\",
  \"context\":\"$CONTEXT\",
  \"cycleId\":\"$CYCLE_ID\"
}"
```

Idempotent on `(skill, cue)`. When the same cue crosses the
`PROMOTION_THRESHOLD` (`src/pattern-memory/escalation.ts`), a `meta-friction` GitHub issue is
auto-opened (or comment-bumped). Failure to POST is logged but never
fails the build.

### 10. Report (summary table only)

| Step | Result |
|------|--------|
| Mode | delegated / inline |
| Ground | X tests passing, typecheck status |
| Anchor | task title (anchor type) |
| Plan | scope: N files, M criteria |
| Self-declared scope | N in-scope, M justified out-of-scope |
| Skeptic | approved/skipped (reason) |
| Verify | test count change (before → after) |
| Merge | PR number + merge commit SHA |
| Deploy | main CI run id, deploy job conclusion, deployed-SHA marker match / absent / pending |
| State sync | backlog item moved / not found |
