---
name: hydra-qa
description: Automated QA verification for Hydra orchestrator PRs — thin wrapper over the upstream `review` skill that runs Standards + Spec sub-agents in parallel against the design-concept artifact.
when_to_use: "When the user says 'QA issue #N', 'verify', 'check the PR', or an issue has the needs-qa label."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [issue_number]
claude_only: true
---

# Hydra QA

Automated QA verification for PRs against the Hydra orchestrator. This skill is a **thin wrapper over the upstream `review` skill** (mattpocock/skills) — it runs two **parallel sub-agents** (Standards + Spec), aggregates their reports verbatim, classifies the verdict in one pass, and exits.

The Spec axis reads the **design-concept artifact** for the issue (Phase A of #437) — produced by `hydra-grill` and persisted at `GET /api/design-concepts/:anchorRef`. The Standards axis reads `CLAUDE.md`, `CONTEXT.md`, `docs/adr/`, and lint configs. The two axes deliberately do not share context.

## Tier-aware verification depth (issue #739, ADR-0015)

QA depth ascends with the **Modification Tier** of the PR (`GET /api/tier`, the single tier authority — never self-classified by path):

- **T1 / T2** — exactly **one standard QA pass**: the single parallel Standards + Spec fan-out described below. Behaviour-preserving; nothing in this section changes the T1/T2 path.
- **T3** (core `src/` + demoted infra) — an **adversarial depth gate**: run `hydra-qa` in **refutation framing** (reviewers are prompted to actively *find a reason this change is wrong / regresses something*, not to confirm it), fanned out to **2 independent reviewers**. The change PASSes only if **neither** reviewer surfaces a real blocker; a single real blocker from **either** reviewer is a FAIL.
- **T4** (Verifier Core — `ci.yml`, `deploy.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`) — the **Deep-QA Remediation Loop**: T4 **inherits the full T3 adversarial depth** (the same 2-reviewer refutation fan-out, unchanged) and **adds** on top (a) a **Verifier-Core checklist** the reviewers must run, and (b) the **block-and-escalate teeth** no other tier has. It never weakens or replaces the T3 gate — it is strictly additive. See step 10's T4 branch.

This is **additive verification depth, not a policy change**: the emitted verdict literal (`PASS` / `FAIL` / `PASS-pending-CI` / `FAIL-pending-CI`) is unchanged, and `decide.py`'s `should_auto_merge()` (and INV-007: `qa_verdict != PASS ⇒ hold`) are untouched. Only *how a T3 review verdict is computed* deepens — an AND over two refutation reviewers, folded by `aggregateAdversarialReview()` in `scripts/ci/qa-verdict.ts`. T4's block-and-escalate is likewise **not** a new verdict literal — it routes through the existing `ready-for-human` pickup set (see below).

A T3 FAIL **bounces** the PR back to a dev agent via the universal remediation loop (re-label `ready-for-agent` + comment failing criteria — step 10's FAIL routing), **not** block-and-escalate-to-operator (the Deep-QA Remediation Loop reserves block-and-escalate teeth for T4).

### T4 Verifier-Core checklist + Deep-QA Remediation Loop (issue #740)

A T4 PR edits the **Verifier Core** — the 5 self-referential paths whose change alters *how every other change is verified*. The adversarial reviewers (the same A/B refutation pair as T3) MUST run this checklist in addition to the standard Standards + Spec axes; any item firing is a **hard blocker** (reviewer FAIL):

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
FIXED_POINT=$(gh pr view $pr_number --repo gaberoo322/hydra \
  --json baseRefName --jq '.baseRefName')
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
HAS_EXEMPT_LABEL=$(gh pr view $pr_number --repo gaberoo322/hydra \
  --json labels --jq '.labels[].name' | grep -Fxq 'design-concept-exempt' \
  && echo 1 || echo 0)
SPEC_SKIPPED_REASON=""

if [ "$RESOLVE_FOUND" = "true" ]; then
  # Have a real PERSISTED artifact — unwrap the flat artifact for the Spec
  # sub-agent (unless exempt-labelled).
  SPEC_INPUT_JSON=$(printf '%s' "$RESOLVE_JSON" | jq -c '.concept')
elif [ "$HAS_EXEMPT_LABEL" = "1" ]; then
  # Operator override — skip Spec axis with audit log.
  SPEC_SKIPPED_REASON="design-concept-exempt label present (operator override)"
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

### 7. Spawn the review sub-agents in parallel (single message, all Agent calls)

**This is the critical step — all `Agent` tool calls MUST be in the same assistant message** so they execute in parallel and do not pollute each other's context. The upstream `review` skill (`~/.claude/skills/review/SKILL.md`) is the contract; do not re-implement its logic — invoke its process pattern.

#### 7a. T1/T2 — single standard pass (`ADVERSARIAL=0`)

Spawn exactly two parallel sub-agents — the **Standards** and **Spec** axes described below. This is the unchanged pre-#739 behaviour.

#### 7b. T3/T4 — adversarial fan-out (`ADVERSARIAL=1`)

Run the review in **refutation framing** across **2 independent reviewers**. Each reviewer is its own Standards + Spec pair (the same two-axis contract below), so a T3 fan-out spawns **four** `general-purpose` sub-agents in one message: `reviewer-A-standards`, `reviewer-A-spec`, `reviewer-B-standards`, `reviewer-B-spec`. The two reviewers are **independent** — neither is told the other exists, same context-separation rule as the Standards/Spec split — so one cannot anchor the other.

Prepend the **refutation framing** to every T3 sub-agent prompt, before the axis brief:

> *You are an adversarial reviewer. Your job is to actively find a concrete reason this change is wrong, regresses existing behaviour, or fails to do what it claims — not to confirm it works. Assume there IS a blocker and hunt for it. Only report a finding as a hard blocker if you can point to the specific line/behaviour that breaks; do not invent speculative concerns. If after a genuine adversarial pass you find no real blocker, say so explicitly.*

Each reviewer (A and B) independently yields a per-reviewer verdict via the step-9 axis-folding rule. Then aggregate the two reviewers (step 9). **PASS requires both reviewers to find no real blocker; a single real blocker from either reviewer = FAIL.**

**Standards sub-agent prompt** — include:

- `FIXED_SHA`, `DIFF_CMD`, `LOG_CMD`.
- The list of standards-source files to read: `CLAUDE.md`, `CONTEXT.md`, `docs/adr/*.md`, `docs/agents/*.md`, `.editorconfig` (machine-enforced — note but don't re-check), `tsconfig.json`, any `STYLE.md` / `STANDARDS.md`.
- Brief: *"Read the standards docs, then read the diff. Report — per file/hunk where relevant — every place the diff violates a documented standard. Distinguish hard violations from judgement calls. Cite the standard (file + the rule). Skip anything tooling enforces (typecheck, lint — CI already runs these). Under 400 words."*
- **Attributing a failing test (issue #1076):** QA reads CI results via `statusCheckRollup` and must not `gh pr checkout`. If you do need to reproduce a test failure locally inside an isolated worktree, run `npm run test:debug` rather than `npm test` + a re-run-and-grep: it runs the identical flags (including `--test-force-exit`) but writes a TAP stream to `test-debug.tap`, so the per-test `not ok <n> - <name>` lines (which the default reporter drops under force-exit) and the `# pass/# fail` footer are both captured in a single run. The failing suite name is then greppable from the file without a second full-suite invocation.
- Hydra-specific checks the sub-agent must apply:
  - **CONTEXT.md vocabulary** — new identifiers in the diff must either appear in the glossary or be local-scope (test fixtures, private helpers). Flag vocabulary drift.
  - **ADR conformance** — if the diff touches an area governed by an ADR, the change must not contradict it.
  - **CLAUDE.md coding conventions** — `safeKanban()` discipline, `redis-adapter` / `src/redis/*` access pattern, `eventBus` passed as parameter (not module global), no silent `catch` (every catch logs `console.error` with context OR is annotated `/* intentional: reason */`).
  - **Tier alignment** — the PR body's `Tier: N` line (populated by `hydra-dev` from `/api/tier`) must agree with the artifact's `interfaceImpact` if an artifact is present. `breaking` ⇒ tier ≥ 2.

**Spec sub-agent prompt** — include:

- `FIXED_SHA`, `DIFF_CMD`, `LOG_CMD`.
- The artifact JSON (`SPEC_INPUT_JSON`) embedded verbatim, OR the skip reason (`SPEC_SKIPPED_REASON`) — if skipped, this sub-agent reports `"no spec available"` per the upstream `review` skill's contract and exits early.
- The PR body (so requirements stated only in the PR description are still visible).
- Brief: *"Read the design-concept artifact. Then read the diff. Report: (a) requirements the artifact asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for — scope creep (diff touches modules not in `modulesTouched`); (c) invariants the artifact promised to preserve that the diff violates (no corresponding test, or test missing assertion); (d) `interfaceImpact: 'breaking'` claims that lack a corresponding interface-migration commit. Quote the artifact line for each finding. Under 400 words."*
- Hydra-specific checks the sub-agent must apply:
  - Every `modulesTouched[i].path` is touched in the diff (or noted in the report if absent).
  - No file outside `modulesTouched` is meaningfully changed (test fixtures and trivial type-only imports are not "meaningful").
  - Each `invariants[i]` has corresponding test coverage in the diff.
  - `interfaceImpact: 'breaking'` claims have a corresponding interface-migration commit.

Both sub-agents use the `general-purpose` subagent type. Neither is told the other exists — context separation is the whole point.

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
gh issue edit $issue_number --repo gaberoo322/hydra --remove-label "needs-qa" 2>/dev/null \
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
gh issue edit $issue_number --repo gaberoo322/hydra --remove-label "needs-qa" 2>/dev/null \
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

### A. Enroll at merge time (carries up the ladder — T2/T3/T4)

Immediately after a **PASS** merge (section 10) of an **enrolled** PR, snapshot
the pre-merge baseline of the leading Target Outcomes. Outcome Holdback
**carries up** the monotonic tier ladder (#741, ADR-0015): every tier deeper
than T1 inherits the post-merge watch, so **T2, T3, and T4 merges all enroll**.
**T1 (prompt-shaped) is always exempt** — too low signal-to-noise for a
leading-outcome watch to attribute regressions (ADR-0004 reasoning). The watch
**window length is tier-aware** — deeper blast radius watches at least as long
(`window(T4) >= window(T3) >= window(T2)`) — and is derived server-side from
the `tier` you pass; you do not compute the window in the playbook.

```bash
# $merge_sha = the squash-merge commit SHA on master (gh pr merge prints it,
# or: gh pr view $pr_number --json mergeCommit --jq .mergeCommit.oid).
# $pr_tier   = the tier from the PR's `Tier:` line / the live classifier.
# Enroll T2/T3/T4; skip T1 (prompt-shaped) entirely. The window is tier-aware
# and resolved server-side from `tier` — do NOT pass windowCycles here.
case "$pr_tier" in
  2|3|4)
    curl -fsS -X POST http://localhost:4000/api/holdback/enroll \
      -H 'content-type: application/json' \
      -d "$(jq -n --arg sha "$merge_sha" --argjson pr "$pr_number" --argjson tier "$pr_tier" \
            '{commitSha:$sha, prNumber:$pr, tier:$tier}')" || \
      echo "WARN: holdback enroll failed for ${merge_sha} (non-fatal — merge already landed)"
    ;;
  *)
    : # T1 / unknown — exempt; no enrollment.
    ;;
esac
```

`enroll` is a no-op (returns `{enrolled:false}`) when the tier is T1/unknown
(carry-up exemption, enforced server-side regardless of this guard) OR when no
leading outcome adapter returned data at merge time — recording an all-null
baseline would make every future regression unknowable, so such a merge sits as
"no signal" rather than a false holdback. The **check** mechanism (section B),
the regression threshold, the per-day cap, and the event names are **identical
across all enrolled tiers** — #741 broadens *which* merges enroll and *how long*
each is watched, never *how* the regression check works.

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

The upstream `review` skill (`~/.claude/skills/review/SKILL.md`) is the contract. We invoke its **process pattern** — pin fixed point, identify spec, spawn parallel Standards + Spec sub-agents, aggregate verbatim — and layer Hydra-specific concerns on top: the design-concept artifact as the canonical spec source, the verdict classifier from `scripts/ci/qa-verdict.ts`, and the autopilot-friendly single-pass exit.

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
