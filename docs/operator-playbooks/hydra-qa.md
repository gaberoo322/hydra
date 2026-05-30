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

The PR body must reference an issue via `Closes #N` / `Fixes #N` / `Refs #N`. Extract the parent issue number, then fetch the artifact:

```bash
PARENT_ISSUE=$(gh pr view $pr_number --repo gaberoo322/hydra --json body \
  --jq '.body' | grep -oiP '(?:closes|fixes|refs)\s*#\K\d+' | head -1)

# anchorRef may be the issue number as a string, or a richer reference;
# the API accepts either. We try the issue number first.
ARTIFACT_JSON=$(curl -fsS --max-time 5 \
  "http://localhost:4000/api/design-concepts/${PARENT_ISSUE}" \
  2>/dev/null || echo "")
```

Decide what to do with the result:

```bash
MODE="${DESIGN_CONCEPT_MODE:-warn}"   # warn (Phase A) | enforce (Phase B/C)
HAS_EXEMPT_LABEL=$(gh pr view $pr_number --repo gaberoo322/hydra \
  --json labels --jq '.labels[].name' | grep -Fxq 'design-concept-exempt' \
  && echo 1 || echo 0)
SPEC_SKIPPED_REASON=""

if [ -n "$ARTIFACT_JSON" ] && echo "$ARTIFACT_JSON" | jq -e '.anchorRef' >/dev/null 2>&1; then
  # Have a real artifact — Spec sub-agent will use it (unless exempt-labelled).
  SPEC_INPUT_JSON="$ARTIFACT_JSON"
elif [ "$HAS_EXEMPT_LABEL" = "1" ]; then
  # Operator override — skip Spec axis with audit log.
  SPEC_SKIPPED_REASON="design-concept-exempt label present (operator override)"
elif [ "$MODE" = "enforce" ]; then
  # Phase B/C — hard fail.
  gh pr review $pr_number --repo gaberoo322/hydra --request-changes --body \
    "> *Automated QA — design-concept artifact required*

This PR cannot be reviewed because the design-concept artifact for issue #${PARENT_ISSUE} is missing.

**To unblock:**
1. Run \`hydra-grill\` on issue #${PARENT_ISSUE} to produce the artifact, OR
2. Apply the \`design-concept-exempt\` label (operator-only — audit-logged) to bypass the Spec axis.

QA mode: \`${MODE}\`. See [epic #437](https://github.com/gaberoo322/hydra/issues/437) for the design-concept gate rollout plan."
  exit 0
else
  # Phase A warn — log and skip Spec axis.
  echo "WARN: design-concept artifact missing for issue #${PARENT_ISSUE} — proceeding in Phase A shadow mode (Standards axis only)."
  SPEC_SKIPPED_REASON="no artifact (Phase A shadow mode — DESIGN_CONCEPT_MODE=${MODE})"
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

### 7. Spawn both sub-agents in parallel (single message, two Agent calls)

**This is the critical step — both `Agent` tool calls MUST be in the same assistant message** so they execute in parallel and do not pollute each other's context. The upstream `review` skill (`~/.claude/skills/review/SKILL.md`) is the contract; do not re-implement its logic — invoke its process pattern.

**Standards sub-agent prompt** — include:

- `FIXED_SHA`, `DIFF_CMD`, `LOG_CMD`.
- The list of standards-source files to read: `CLAUDE.md`, `CONTEXT.md`, `docs/adr/*.md`, `docs/agents/*.md`, `.editorconfig` (machine-enforced — note but don't re-check), `tsconfig.json`, any `STYLE.md` / `STANDARDS.md`.
- Brief: *"Read the standards docs, then read the diff. Report — per file/hunk where relevant — every place the diff violates a documented standard. Distinguish hard violations from judgement calls. Cite the standard (file + the rule). Skip anything tooling enforces (typecheck, lint — CI already runs these). Under 400 words."*
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

Map the two axes into a single review verdict for the classifier (`scripts/ci/qa-verdict.ts`):

- Either axis has a **hard violation / hard finding** → `REVIEW_VERDICT="FAIL"`.
- Both axes pass (no hard findings; judgement calls are advisory) OR Spec was skipped per Phase A / exempt / Tier-1 rules → `REVIEW_VERDICT="PASS"`.

Then:

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
gh pr review $pr_number --repo gaberoo322/hydra --approve --body "> *Automated QA — two-axis review*

$REVIEW_REPORT

---

**Verdict:** \`PASS\` — ${VERDICT_REASON}

$CHECKS_BLOCK"
gh pr merge $pr_number --repo gaberoo322/hydra --squash --delete-branch

# Belt-and-braces (issue #638): the merge above auto-closes the issue via
# `Closes #N` in the PR body, which also removes labels on close — but if
# the merge call fails (branch protection edge case, network blip) the
# issue keeps `needs-qa` and causes the same busy-loop the PASS-pending-CI
# branch fixes. Clearing the label explicitly here makes the post-state
# the same regardless of whether auto-merge succeeded.
gh issue edit $issue_number --repo gaberoo322/hydra --remove-label "needs-qa" 2>/dev/null \
  || true  # already cleared by auto-close — expected and non-fatal
```
Issue auto-closes via `closes #N` in PR body.

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
