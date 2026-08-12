---
name: hydra-qa
description: Automated QA verification for Hydra orchestrator PRs — thin wrapper over the upstream `code-review` skill that runs Standards + Spec sub-agents in parallel against the design-concept artifact.
when_to_use: "When the user says 'QA issue #N', 'verify', 'check the PR', or an issue has the needs-qa label."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [issue_number]
claude_only: true
compose_base: _vendor/code-review.md
---

# Hydra QA

> **Compose-seam supersession (issue #3818).** This composed skill vendors the
> upstream `code-review` base's own **"### 4. Spawn both sub-agents in
> parallel"** step below — and this Hydra overlay's own **"### 7. Spawn the
> review sub-agents in parallel"** step, further down this document, REPLACES
> it. **Do NOT execute the base's step 4 spawn instruction.** It is fully
> superseded: the overlay's step 7 already performs the complete fan-out (the
> plain Standards + Spec pair on T1/T2, or the 2-reviewer adversarial fan-out
> on T3/T4) — running both would double-spawn reviewer sub-agents (6 instead
> of 2, issue #3815 AC2). The overlay's step 7 is the ONLY live spawn
> instruction for this composed skill; treat the base's step 4 as historical
> upstream prose to skip over, not something to act on.

> **Blocking-dispatch mandate, restated here (issue #3880 — a #3789/#3827
> recurrence).** When step 7's fan-out runs, **every** `Agent` call that spawns
> a reviewer sub-agent MUST pass `run_in_background: false`. The `Agent` tool
> defaults to background dispatch — a spawn without this flag returns
> immediately, and the parent turn (and this session) can end with no verdict
> posted while reviewers are still running. This is not a new rule; it already
> lives at step 7 below. It failed to hold on 2026-08-05 (issue #3880) even
> though step 7 carried it — the mandate was true but sat ~250 lines past this
> preface, after the base's entire unconstrained "spawn in parallel" body, so a
> dispatch could reach and act on a spawn instruction well before ever reading
> it. Restating it beside the "skip the base's step 4" note puts it where a
> top-down read hits it before any spawn happens. Step 7.5's
> reviewer-completeness check is equally mandatory: never aggregate or emit a
> verdict for a fan-out where any spawned reviewer did not return a real
> result — see step 7.5 below.

<!-- compose-seam-supersede -->

> **Composed skill (ADR-0030 Decision 4 / Option C, issue #3420).** This playbook is the thin Hydra **AFK overlay** on top of the vendored upstream `code-review` base (`docs/operator-playbooks/_vendor/code-review.md`). `scripts/sync-skills.sh` emits `~/.claude/skills/hydra-qa/SKILL.md` as **[upstream code-review base] + [this overlay]**, with the vendored base's `disable-model-invocation: true` **stripped** (it hard-errors under Skill-tool dispatch). The review stage dispatches the *same* upstream `code-review` skill the operator runs, in AFK mode. The Hydra-specific verification depth, verdict classification, and remediation-loop routing below ride on that shared base. The dispatch-class → stage table lives in `hydra-autopilot.md`. **Contract complete (ADR-0030 Decision 5, epsilon #3424):** the standalone `hydra-qa` *fork identity* is retired — it is no longer a bespoke reviewer fork, it **is** the composed `review` stage. The `qa_orch` dispatch *class* and its `decide.py` `make_dispatch(…, "hydra-qa")` string literals (orch + target scope) stay live — they select this composed stage.

Automated QA verification for PRs against the Hydra orchestrator. This skill is a **thin wrapper over the upstream `code-review` skill** (mattpocock/skills; renamed from `review` in v1.1) — it runs two **parallel sub-agents** (Standards + Spec), aggregates their reports verbatim, classifies the verdict in one pass, and exits.

The Spec axis reads the **design-concept artifact** for the issue (Phase A of #437) — produced by `hydra-grill` and persisted at `GET /api/design-concepts/:anchorRef`. The Standards axis reads `CLAUDE.md`, `CONTEXT.md`, `docs/adr/`, and lint configs. The two axes deliberately do not share context.

> **Retired prompt artifact (issue #2556).** A standalone single-agent "Reality Checker" prompt (`AGENT-PROMPT.md`) used to be bundled alongside this skill. It predates the current parallel Standards/Spec fan-out and is **no longer injected by any flow** — the live reviewer prompts are embedded in this playbook (the `code-review`-skill sub-agents above). The stale artifact has been removed; it is not referenced anywhere. Do not re-introduce a separate prompt file: the reviewer prompts live here, in the playbook that `scripts/sync-skills.sh` regenerates the skill from.

> **NEVER end your session waiting on CI, a monitor, or a background process
> (issue #3866).** This skill already never loops waiting on CI by design (the
> four-verdict system below exists exactly to avoid that) — but the rule is
> stated explicitly here because the design was violated in practice: a
> `qa_orch` T4 re-check on PR #3853 posted the Deep-QA PASS marker (step 10's
> T4 branch) and then ended its turn with "I'll wait for the deep-qa-gate
> re-check run to complete" instead of returning. In an unattended dispatch
> nothing resumes you after you stop talking — `reap.py` records the session's
> end as a completion the instant it happens, whatever you did or didn't
> finish. Once you have computed a verdict and executed its step-10 routing
> (comment posted, label transitioned, auto-merge armed or FAIL bounced), you
> are DONE — return immediately. Never emit a final message that describes
> waiting for a check, a gate, or a re-run to finish; the autopilot's own CI
> poll loop (not this skill) is what re-evaluates a `PASS-pending-CI` verdict.

## Tier-aware verification depth (issue #739, ADR-0015)

QA depth ascends with the **Modification Tier** of the PR (`GET /api/tier`, the single tier authority — never self-classified by path):

- **T1 / T2** — exactly **one standard QA pass**: the single parallel Standards + Spec fan-out described below. Behaviour-preserving; nothing in this section changes the T1/T2 path.
- **T3** (core `src/` + demoted infra) — an **adversarial depth gate**: run `hydra-qa` in **refutation framing** (reviewers are prompted to actively *find a reason this change is wrong / regresses something*, not to confirm it), fanned out to **2 independent reviewers**. The change PASSes only if **neither** reviewer surfaces a real blocker; a single real blocker from **either** reviewer is a FAIL.
- **T4** (Verifier Core — `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `.github/workflows/deep-qa-gate.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`) — the **Deep-QA Remediation Loop**: T4 **inherits the full T3 adversarial depth** (the same 2-reviewer refutation fan-out, unchanged) and **adds** on top (a) a **Verifier-Core checklist** the reviewers must run, and (b) the **block-and-escalate teeth** no other tier has. It never weakens or replaces the T3 gate — it is strictly additive. See step 10's T4 branch.

This is **additive verification depth, not a policy change**: the emitted verdict literal (`PASS` / `FAIL` / `PASS-pending-CI` / `FAIL-pending-CI`) is unchanged, and `decide.py`'s `should_auto_merge()` (and INV-007: `qa_verdict != PASS ⇒ hold`) are untouched. Only *how a T3 review verdict is computed* deepens — an AND over two refutation reviewers, folded by `aggregateAdversarialReview()` in `scripts/ci/qa-verdict.ts`. T4's block-and-escalate is likewise **not** a new verdict literal — it routes through the existing `ready-for-human` pickup set (see below).

A T3 FAIL **bounces** the PR back to a dev agent via the universal remediation loop (re-label `ready-for-agent` + comment failing criteria — step 10's FAIL routing), **not** block-and-escalate-to-operator (the Deep-QA Remediation Loop reserves block-and-escalate teeth for T4).

### T4 Verifier-Core checklist + Deep-QA Remediation Loop (issue #740)

A T4 PR edits the **Verifier Core** — the 6 self-referential paths whose change alters *how every other change is verified*. The adversarial reviewers (the same A/B refutation pair as T3) MUST run this checklist in addition to the standard Standards + Spec axes; any item firing is a **hard blocker** (reviewer FAIL):

1. **Live-Gate Invariant (#738 / ADR-0015).** A Verifier-Core change is verified by the **currently-deployed** gate against the diff, **never** by the *proposed* gate. Concretely: the classifier **file LIST** = the PR diff (head-vs-base merge-base), the classifier **LOGIC** = the **BASE ref** (the import-closed `scripts/tier-classify.ts` / `src/tier-classifier.ts` / `src/untouchable.ts` as they exist on the merge base). "Is this a Verifier-Core PR?" is decided with the **BASE-ref** `isVerifierCore` so a PR cannot strip its own path on head to escape classification. A diff that re-routes Verifier-Core PRs back through the **head-tree** classifier is a hard blocker.
2. **No self-admitting gate.** No path in the diff lets the *proposed* gate verify its own admission: e.g. a `ci.yml` job that always exits 0 / is `continue-on-error` for the verification it claims to perform, a tier-classify edit that downgrades the PR's own files, or an `isVerifierCore` change that removes a path the diff itself touches. If the proposed gate would have admitted this very diff *only because of this diff's own change*, FAIL.
3. **`untouchable.ts` path set integrity.** Any edit to `VERIFIER_CORE_PATHS` is justified in the artifact and does not silently shrink the protected set.
4. **Operator-approval intact.** T4 still merges operator-only (`operator-approved` label); the diff must not weaken that requirement (branch protection, auto-merge enablement on T4).

The fired checklist items become the **findings** in the FAIL comment.

**Block-and-escalate on the 2nd consecutive fail.** T4 FAIL routing differs from T3 only at the 2nd fail:

- **1st deep-QA FAIL** → identical to the universal loop: comment findings + bounce the PR to a dev agent (re-label `ready-for-agent`). It never escalates on the first fail.
- **2nd consecutive deep-QA FAIL on the same PR** → **block** the PR (request-changes, do not re-bounce) and add the **source issue** to the `/hydra-review` pickup set: `ready-for-human` label + a structured comment (PR ref, both failing summaries, the fired Verifier-Core checklist items). This is the **existing** operator surface — no new channel, no new verdict literal. (`#745`'s phone-notify hook fires orthogonally when the pickup set goes non-empty.)

**How the fail number is counted.** The bounce path is stateless on the issue (step 10 strips `needs-qa` and adds `ready-for-agent`, resetting any label-carried counter on every bounce). So the count is derived **live** from the **PR** — the durable per-attempt ledger: every T4 deep-QA FAIL comment carries the machine-greppable marker line `Verifier-Core deep-QA: FAIL`. The next pass counts prior markers: `failNumber = priorMarkers + 1`; `failNumber >= 2` ⇒ block-and-escalate, else bounce. There is **no** new Redis key and **no** issue-label counter. "Consecutive" and "total fails on this PR" coincide because a PASS merges the PR and ends the loop. The pure decision rule is `decideDeepQaAction()` in `scripts/ci/qa-verdict.ts`.

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

The Tier-1 auto-bypass (PR diff entirely under `~/.claude/skills/` or `config/` and no associated artifact) also remains in both modes — prompt-only changes never require the artifact.

## Verdict tiers (issue #405)

The skill **never loops waiting on CI**. After the two-axis review it emits exactly one of four verdicts and returns:

| Verdict | Meaning | Autopilot behaviour |
|---|---|---|
| `PASS` | Both axes pass AND every required CI check has concluded successfully. | Approve and merge immediately. |
| `FAIL` | Either axis has hard findings, OR a required check has already failed/errored/timed-out. | Re-label `ready-for-agent`, comment failing criteria. |
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
three signals above, and prints the aggregate catch rate as JSON. This is the
*instrument*, not the *lever* — it imports nothing from `qa-verdict.ts` and
ships no change to `aggregateAdversarialReview()`, `classifyVerdict()`, or any
verdict literal (INV-A/INV-D); running it neither ships nor gates RC2, it only
produces the number RC2's own sequencing gate is waiting on.

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
  --json baseRefName,mergeStateStatus)
FIXED_POINT=$(printf '%s' "$PR_VIEW_JSON" | jq -r '.baseRefName')
# mergeStateStatus (DIRTY ⇒ defer) is read by the reviewer admission gate at
# step 6.6 — fetched here in the SAME gh pr view call, so the gate adds no new
# state surface (INV-G: no new Redis key / label / CI check / API endpoint).
MERGE_STATE_STATUS=$(printf '%s' "$PR_VIEW_JSON" | jq -r '.mergeStateStatus // ""')
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
# Check the PR label first (operator override path), then fall back to the
# parent issue label — hydra-cleanup-scan issues carry design-concept-exempt
# at filing time so QA skips the Spec axis cleanly instead of logging a resolve
# MISS and falling through to Phase A shadow mode (issue #3013).
HAS_EXEMPT_LABEL=$(
  { gh pr view $pr_number --repo gaberoo322/hydra \
      --json labels --jq '.labels[].name' | grep -Fxq 'design-concept-exempt'; } \
  || { [ -n "$PARENT_ISSUE" ] && gh issue view $PARENT_ISSUE --repo gaberoo322/hydra \
      --json labels --jq '.labels[].name' | grep -Fxq 'design-concept-exempt'; } \
  && echo 1 || echo 0
)
SPEC_SKIPPED_REASON=""

if [ "$RESOLVE_FOUND" = "true" ]; then
  # Have a real PERSISTED artifact — unwrap the flat artifact for the Spec
  # sub-agent (unless exempt-labelled).
  SPEC_INPUT_JSON=$(printf '%s' "$RESOLVE_JSON" | jq -c '.concept')
elif [ "$HAS_EXEMPT_LABEL" = "1" ]; then
  # Operator override (PR label) or deterministic-exempt class (issue label —
  # e.g. cleanup-scan findings carry design-concept-exempt at filing time).
  # Skip Spec axis with audit log.
  SPEC_SKIPPED_REASON="design-concept-exempt label present (operator override or deterministic-exempt class)"
elif [ "$MODE" = "enforce" ]; then
  # Phase B/C — hard fail. Surface the resolver's loud, handle-named reason so
  # the operator sees exactly WHERE the artifact was looked for (issue #1450).
  MISS_REASON=$(printf '%s' "$RESOLVE_JSON" | jq -r '.reason // "design-concept artifact missing"' 2>/dev/null || echo "design-concept artifact missing")
  MISS_HANDLE=$(printf '%s' "$RESOLVE_JSON" | jq -r '.handle.redisKey // "(handle unknown)"' 2>/dev/null || echo "(handle unknown)")
  gh pr review $pr_number --repo gaberoo322/hydra --request-changes --body \
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

### 5. Collect current CI state (single GraphQL call, no looping)

```bash
CHECKS_JSON=$(gh pr view $pr_number --repo gaberoo322/hydra --json statusCheckRollup \
  --jq '.statusCheckRollup | map({name: (.name // .context), status: ((.status // "completed") | ascii_downcase), conclusion: (.conclusion | if . == null then null else ascii_downcase end), required: (.isRequired // false)})')
```

GitHub returns `status`/`conclusion` as UPPERCASE enums (`QUEUED`, `COMPLETED`, `SUCCESS`). The `ascii_downcase` calls fold them to the lowercase-canonical tokens the classifier's `PENDING_STATUSES` / `SUCCESS_CONCLUSIONS` sets match (issue #761). The classifier ALSO folds casing internally as defense in depth, so this is belt-and-braces — but keeping the emitted JSON lowercase-canonical makes `CHECKS_JSON` self-describing and matches the documented `CheckStatus` union.

Pass `CHECKS_JSON` to the verdict classifier at the end — not to the sub-agents.

### 6. Tier-1 auto-bypass check

Inspect the diff. If every changed file is under `~/.claude/skills/`, `config/`, or `docs/operator-playbooks/` AND no artifact is present AND no `design-concept-exempt` label, the Spec axis is auto-bypassed (per issue #440 — prompt-only PRs never require the artifact). This is the **only** auto-bypass; Tier ≥ 2 PRs always run the Spec axis (or fail in `enforce` mode).

```bash
CHANGED=$(git diff --name-only "${FIXED_SHA}...HEAD")
TIER1_ONLY=1
while IFS= read -r f; do
  case "$f" in
    .claude/skills/*|config/*|docs/operator-playbooks/*) ;;
    *) TIER1_ONLY=0; break ;;
  esac
done <<< "$CHANGED"

if [ "$TIER1_ONLY" = "1" ] && [ -z "$SPEC_INPUT_JSON" ] && [ -z "$SPEC_SKIPPED_REASON" ]; then
  SPEC_SKIPPED_REASON="Tier-1 auto-bypass (diff is prompt-only and no artifact present)"
fi
```

### 6.5 Resolve the PR's Modification Tier (issue #739)

Classify the diff via the live tier API — the single tier authority. Never infer tier from path patterns.

```bash
CHANGED=$(git diff --name-only "${FIXED_SHA}...HEAD" | paste -sd, -)
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
  (issue #974); `ready-for-agent` is the bridging label that also avoids the
  label-less orphan gap (issue #3788). A deferred PR is, by construction, one
  that cannot merge on this pass, so INV-C holds: every PR that reaches
  auto-merge has been reviewed at full depth.
  ```bash
  gh pr comment $pr_number --repo gaberoo322/hydra --body "> *Automated QA — review deferred*

  ${GATE_REASON}

  No verdict is being emitted — the PR cannot merge on this pass. The full review (including the Verifier-Core fan-out for a T4 PR) runs once the PR is rebased / CI is green. QA has exited; the autopilot re-queues it when the PR is ready."
  gh issue edit $issue_number --repo gaberoo322/hydra \
    --remove-label "needs-qa" --add-label "ready-for-agent" 2>/dev/null \
    || echo "WARN: failed to re-label issue #${issue_number} on defer (non-fatal)"
  exit 0
  ```

- **`skip-required-failed`** (T1/T2/T3 only — T4 routes to `defer`) — the review
  is moot because a required check already failed. Compute the FAIL verdict the
  fold already determines and follow the normal step-10 FAIL routing, spawning
  **zero** reviewers. Set a nominal review verdict (the classifier ignores it
  when `requiredFailed > 0`) and compute `VERDICT` / `VERDICT_REASON` /
  `CHECKS_BLOCK` here, then jump to step 10's FAIL routing for T1/T2/T3 — skip
  step 7 (no spawn), 7.5, 8, and 9 entirely:
  ```bash
  REVIEW_VERDICT="PASS"   # nominal — classifyVerdict ignores it when requiredFailed > 0
  REVIEW_REPORT="_Review skipped by the admission gate (issue #3815): a required CI check already failed, so the review verdict cannot change the FAIL \`classifyVerdict\` returns regardless of the reviewers' finding._"
  node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({classifyVerdict, renderChecksBlock}) => {
    const r = classifyVerdict(process.env.REVIEW_VERDICT, JSON.parse(process.env.CHECKS_JSON));
    process.stdout.write(JSON.stringify({verdict: r.verdict, reason: r.reason, checks: renderChecksBlock(r)}));
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
  # fallback above on a script error). Skip to step 10's FAIL routing for
  # T1/T2/T3 — do not spawn reviewers.
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

#### 7a. T1/T2 — single standard pass (`ADVERSARIAL=0`)

Spawn exactly two parallel sub-agents — the **Standards** and **Spec** axes described below. This is the unchanged pre-#739 behaviour.

#### 7b. T3/T4 — adversarial fan-out (`ADVERSARIAL=1`)

Run the review in **refutation framing** across **2 independent reviewers**. Each reviewer is its own Standards + Spec pair (the same two-axis contract below), so a T3 fan-out spawns **four** `general-purpose` sub-agents in one message: `reviewer-A-standards`, `reviewer-A-spec`, `reviewer-B-standards`, `reviewer-B-spec`. The two reviewers are **independent** — neither is told the other exists, same context-separation rule as the Standards/Spec split — so one cannot anchor the other.

Prepend the **refutation framing** to every T3 sub-agent prompt, before the axis brief:

> *You are an adversarial reviewer. Your job is to actively find a concrete reason this change is wrong, regresses existing behaviour, or fails to do what it claims — not to confirm it works. Assume there IS a blocker and hunt for it. Only report a finding as a hard blocker if you can point to the specific line/behaviour that breaks; do not invent speculative concerns. If after a genuine adversarial pass you find no real blocker, say so explicitly.*

Each reviewer (A and B) independently yields a per-reviewer verdict via the step-9 axis-folding rule. Then aggregate the two reviewers (step 9). **PASS requires both reviewers to find no real blocker; a single real blocker from either reviewer = FAIL.**

**Standards sub-agent prompt** — include:

- `$REVIEW_PACKET` inline (the diff + full changed-file contents), per the shared packet discipline in step 7.0. `FIXED_SHA` is for reference only — the reviewer does NOT run `git diff` / `git show` or an exploratory tool loop.
- The standards-source files the reviewer MAY open by name (one, to cite a specific rule — not read end-to-end): `CLAUDE.md`, `CONTEXT.md`, `docs/adr/*.md`, `docs/agents/*.md`, `.editorconfig` (machine-enforced — note but don't re-check), `tsconfig.json`, any `STYLE.md` / `STANDARDS.md`.
- Brief: *"The diff and changed-file contents are in the packet — judge off it, with no exploratory tool loop (step 7.0 packet discipline). Report — per file/hunk where relevant — every place the diff violates a documented standard. Distinguish hard violations from judgement calls. Cite the standard (file + the rule). Skip anything tooling enforces (typecheck, lint — CI already runs these). Under 400 words."*
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
- Brief: *"The artifact and the diff / changed-file contents are in the packet — judge off it, with no exploratory tool loop (step 7.0 packet discipline). Report: (a) requirements the artifact asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for — scope creep (diff touches modules not in `modulesTouched`); (c) invariants the artifact promised to preserve that the diff violates (no corresponding test, or test missing assertion); (d) `interfaceImpact: 'breaking'` claims that lack a corresponding interface-migration commit. Quote the artifact line for each finding. Under 400 words."*
- Hydra-specific checks the sub-agent must apply:
  - Every `modulesTouched[i].path` is touched in the diff (or noted in the report if absent).
  - No file outside `modulesTouched` is meaningfully changed (test fixtures and trivial type-only imports are not "meaningful").
  - Each `invariants[i]` has corresponding test coverage in the diff.
  - `interfaceImpact: 'breaking'` claims have a corresponding interface-migration commit.

Both sub-agents use the `general-purpose` subagent type. Neither is told the other exists — context separation is the whole point.

### 7.5 Verify every spawned reviewer returned a real result — fail loud on an incomplete fan-out (issue #3789)

Foreground dispatch (step 7's `run_in_background: false`) guarantees each `Agent` call blocks until that reviewer finishes — but the sub-agent can still come back empty: its worktree can be reaped mid-review (this has happened to reviewer sub-agents and to the parent QA agent itself, in the run that filed #3789), it can error out, or return a truncated report. Before step 8 (aggregate) or step 9 (classify), confirm you hold a **real** result for every reviewer you spawned:

- T1/T2 (2 spawns): a Standards report and a Spec report (or an explicit Spec-skip already accounted for in step 4/6 — that is a clean skip, not a missing result).
- T3/T4 (4 spawns): all of `reviewer-A-standards`, `reviewer-A-spec`, `reviewer-B-standards`, `reviewer-B-spec`.

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

### 8. Aggregate

Present both reports under `## Standards` and `## Spec` headings, **verbatim or lightly cleaned** — do not merge or rerank findings. The two axes are deliberately separate so reviewers see them independently. If the Spec axis was skipped, the `## Spec` section reads:

```
## Spec

_Skipped: ${SPEC_SKIPPED_REASON}_
```

End with a one-line summary: total findings per axis, and the worst single issue flagged.

Render the aggregated comment into `$REVIEW_REPORT` for posting.

### 9. Classify the review verdict

**Per-reviewer axis fold** — for each reviewer (a single reviewer for T1/T2, reviewers A and B for T3/T4), map its two axes into one verdict:

- Either axis has a **hard violation / hard finding** → that reviewer's verdict is `FAIL`.
- Both axes pass (no hard findings; judgement calls are advisory) OR Spec was skipped per Phase A / exempt / Tier-1 rules → that reviewer's verdict is `PASS`.

**Tier fold into `REVIEW_VERDICT`:**

- **T1/T2 (`ADVERSARIAL=0`)** — `REVIEW_VERDICT` is the single reviewer's verdict.
- **T3/T4 (`ADVERSARIAL=1`)** — AND the two independent reviewers via `aggregateAdversarialReview()`: PASS iff **both** reviewers are `PASS`; a single `FAIL` from **either** reviewer makes `REVIEW_VERDICT="FAIL"`. This is purely the review-verdict computation — the downstream `classifyVerdict` CI folding and the emitted verdict literal are unchanged.

```bash
if [ "$ADVERSARIAL" = "1" ]; then
  # REVIEWER_A_VERDICT / REVIEWER_B_VERDICT are each "PASS" | "FAIL" from the
  # per-reviewer axis fold above.
  REVIEW_VERDICT=$(node --no-warnings --experimental-strip-types -e "
    import('./scripts/ci/qa-verdict.ts').then(({aggregateAdversarialReview}) => {
      const r = aggregateAdversarialReview(process.env.REVIEWER_A_VERDICT, process.env.REVIEWER_B_VERDICT);
      process.stdout.write(r.reviewVerdict);
    });
  ")
fi
```

Then feed `REVIEW_VERDICT` into the one-pass CI classifier (unchanged):

```bash
node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({classifyVerdict, renderChecksBlock}) => {
    const r = classifyVerdict(process.env.REVIEW_VERDICT, JSON.parse(process.env.CHECKS_JSON));
    process.stdout.write(JSON.stringify({verdict: r.verdict, reason: r.reason, checks: renderChecksBlock(r)}));
  });
" > /tmp/qa-verdict.json
VERDICT=$(jq -r '.verdict' /tmp/qa-verdict.json)
VERDICT_REASON=$(jq -r '.reason' /tmp/qa-verdict.json)
CHECKS_BLOCK=$(jq -r '.checks' /tmp/qa-verdict.json)
```

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

$CHECKS_BLOCK"
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

Verdict: \`PASS-pending-CI\`. Autopilot will re-evaluate once required checks conclude. **The QA subagent has exited — no background wait.**"

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
  || echo "WARN: failed to clear needs-qa from issue #${issue_number} (non-fatal)"
```

**Verdict `FAIL` or `FAIL-pending-CI`** (any axis has hard findings, or a required check has already failed):

For T1 / T2 / T3 (PR_TIER empty/1/2/3) — the universal remediation bounce:
```bash
gh pr review $pr_number --repo gaberoo322/hydra --request-changes --body "> *Automated QA — two-axis review*

$REVIEW_REPORT

---

**Verdict:** \`${VERDICT}\` — ${VERDICT_REASON}

$CHECKS_BLOCK"
gh issue edit $issue_number --repo gaberoo322/hydra --remove-label "needs-qa" --add-label "ready-for-agent"
gh issue comment $issue_number --repo gaberoo322/hydra --body "> *Automated QA failed*

**Failed axis findings:** see PR #$pr_number review comments.

Returning to ready-for-agent for retry."
```

For **T4** (`PR_TIER == 4`) — the **Deep-QA Remediation Loop** (issue #740). The 1st FAIL bounces exactly like the universal loop; the 2nd consecutive FAIL on the same PR blocks and escalates to the `/hydra-review` pickup set. Derive the action LIVE from the PR's own deep-QA FAIL markers — the PR is the per-attempt ledger:

```bash
# Collect the PR's prior comment bodies — the durable per-attempt ledger.
PRIOR_COMMENTS_JSON=$(gh pr view $pr_number --repo gaberoo322/hydra \
  --json comments --jq '[.comments[].body]')

# Pure decision: 1st FAIL => bounce, 2nd+ consecutive FAIL => block-and-escalate.
DEEP_QA_JSON=$(PRIOR_COMMENTS_JSON="$PRIOR_COMMENTS_JSON" REVIEW_VERDICT="$REVIEW_VERDICT" \
  node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({decideDeepQaAction, DEEP_QA_FAIL_MARKER}) => {
    const prior = JSON.parse(process.env.PRIOR_COMMENTS_JSON);
    const d = decideDeepQaAction(process.env.REVIEW_VERDICT, prior);
    process.stdout.write(JSON.stringify({ ...d, marker: DEEP_QA_FAIL_MARKER }));
  });
")
DEEP_QA_ACTION=$(printf '%s' "$DEEP_QA_JSON" | jq -r '.action')
DEEP_QA_FAILNO=$(printf '%s' "$DEEP_QA_JSON" | jq -r '.failNumber')
DEEP_QA_MARKER=$(printf '%s' "$DEEP_QA_JSON" | jq -r '.marker')

# ALWAYS request-changes on the PR and ALWAYS post the FAIL marker comment so the
# next pass can count this fail (the marker line is the ledger entry).
gh pr review $pr_number --repo gaberoo322/hydra --request-changes --body "> *Automated QA — T4 Verifier-Core deep review*

$REVIEW_REPORT

---

**Verdict:** \`${VERDICT}\` — ${VERDICT_REASON}

${DEEP_QA_MARKER} (fail #${DEEP_QA_FAILNO} on this PR)

$CHECKS_BLOCK"

if [ "$DEEP_QA_ACTION" = "block-and-escalate" ]; then
  # 2nd consecutive deep-QA FAIL — block the PR (do NOT re-bounce) and route the
  # SOURCE ISSUE to the /hydra-review pickup set. Same surface as every other
  # ready-for-human escalation; no new operator channel, no new verdict literal.
  gh issue edit $issue_number --repo gaberoo322/hydra \
    --remove-label "needs-qa" --add-label "ready-for-human"
  gh issue comment $issue_number --repo gaberoo322/hydra --body "> *T4 Deep-QA blocked — operator decision needed*

PR #$pr_number failed the Verifier-Core deep-QA gate **twice consecutively** (fail #${DEEP_QA_FAILNO}). Per the Deep-QA Remediation Loop the PR is now **blocked** and routed to the operator instead of bouncing again.

**Fired Verifier-Core checklist items / failing findings:** see the request-changes reviews on PR #$pr_number (both passes).

This issue is now on the \`/hydra-review\` pickup set. Resolve by either fixing the Verifier-Core concern and re-running QA, or closing the PR."
else
  # 1st deep-QA FAIL — bounce to a dev agent via the universal remediation loop.
  gh issue edit $issue_number --repo gaberoo322/hydra \
    --remove-label "needs-qa" --add-label "ready-for-agent"
  gh issue comment $issue_number --repo gaberoo322/hydra --body "> *T4 Deep-QA failed (1st) — bouncing to dev*

**Failed Verifier-Core findings:** see PR #$pr_number review comments.

Returning to ready-for-agent for remediation. A second consecutive deep-QA FAIL on this PR will block it and escalate to the operator."
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
      --arg cycleId "hydra-qa-${issue_number}-$(date +%s)" \
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
