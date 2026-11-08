---
name: hydra-qa
description: Automated QA verification for Hydra orchestrator PRs — thin wrapper over the upstream `code-review` skill that runs Standards + Spec sub-agents in parallel against the design-concept artifact.
when_to_use: "When the user says 'QA issue #N', 'verify', 'check the PR', or an issue has the needs-qa label."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [issue_number]
reference_files: [_fragments/hydra-qa-reference.md]
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
> are owned here by steps 1, 7, 8. Base step 3 is **kept**: step 7.0 imports
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
> running. It is hoisted here from step 7 so a top-down read hits it before any
> spawn instruction. Step 7.5's
> reviewer-completeness check is equally mandatory: never aggregate or emit a
> verdict for a fan-out where any spawned reviewer did not return a real
> result — see step 7.5 below.

<!-- compose-seam-supersede -->

> **Composed skill (ADR-0030 Decision 4 / Option C, issue #3420).** This playbook is the thin Hydra **AFK overlay** on top of the vendored upstream `code-review` base (`docs/operator-playbooks/_vendor/code-review.md`). `scripts/sync-skills.sh` emits `~/.claude/skills/hydra-qa/SKILL.md` as **[upstream code-review base] + [this overlay]**, with the vendored base's `disable-model-invocation: true` **stripped** (it hard-errors under Skill-tool dispatch). The review stage dispatches the *same* upstream `code-review` skill the operator runs, in AFK mode. The Hydra-specific verification depth, verdict classification, and remediation-loop routing below ride on that shared base. The dispatch-class → stage table lives in `hydra-autopilot.md`. **Contract complete (ADR-0030 Decision 5, epsilon #3424):** the standalone `hydra-qa` *fork identity* is retired — it is no longer a bespoke reviewer fork, it **is** the composed `review` stage. The `qa_orch` dispatch *class* and its `decide.py` `make_dispatch(…, "hydra-qa")` string literals (orch + target scope) stay live — they select this composed stage.

Automated QA verification for PRs against the Hydra orchestrator. This skill is a **thin wrapper over the upstream `code-review` skill** (mattpocock/skills; renamed from `review` in v1.1) — it runs two **parallel sub-agents** (Standards + Spec), aggregates their reports verbatim, classifies the verdict in one pass, and exits.

The Spec axis reads the **design-concept artifact** for the issue (Phase A of #437) — produced by `hydra-grill` and persisted at `GET /api/design-concepts/:anchorRef`. The Standards axis reads `CLAUDE.md`, `CONTEXT.md`, `docs/adr/`, and lint configs. The two axes deliberately do not share context.

> **NEVER end your session waiting on CI, a monitor, or a background process
> (issue #3866).** The full rule lives ONCE, canonically, in
> `hydra-autopilot.md`'s "Worktree-guard preamble" section — as of issue #4272
> the block prepended verbatim to every `qa_orch` dispatch prompt is the
> **qa_orch blocking-fan-out variant**, not the shared `dev_orch` block, so you
> receive it at dispatch time regardless of this pointer. The variant permits
> exactly the blocking (`run_in_background: false`) reviewer spawns step 7
> below directs — never a background spawn, and never ending your turn with
> any child still running. Once you have computed a verdict and executed its
> step-10 routing, you are DONE — return immediately.

> **Plumbing is scripted (issue #5269, ADR-0046 Decision 7).** The deterministic
> steps are four scripts under `scripts/qa/`; this playbook keeps only the
> judgement (the reviewer briefs, the aggregation, the T4 checklist) and one stub
> per script. **No script holds a verdict rule** — admission, fan-out sizing, the
> fold, the trailer and the round action all come from the qa-verdict engine
> (`scripts/ci/qa-verdict.ts`, `src/qa/`), reached in-process; nothing here
> shells a `node -e` shim into the engine.
>
> | Script | Replaces | Writes |
> |---|---|---|
> | `scripts/qa/preflight.ts` | steps 1–6.7 | nothing (pure read) |
> | `scripts/qa/packet.ts` | steps 7.0 / 7.0a / 7.0b | temp files only |
> | `scripts/qa/route.ts` | steps 9 / 9.5 / 9.6 / 10 | every label and comment (the only writer) |
> | `scripts/qa/poll.ts` | the bounded CI-poll fence | nothing |
>
> **Background that no step reads** — tier-aware depth, the severity-gated fold,
> convergent review, the `deep-qa-gate` StatusContext vs CheckRun, Phase A shadow
> mode, the verdict tiers, the INV-A..INV-G definitions, the Post-merge Regression
> Check and the slot-lifecycle hook — lives in `hydra-qa-reference.md` (sibling of
> this SKILL.md). Read it only when you need that background.

## Tier-aware verification depth

QA depth ascends with the Modification Tier of the PR (`GET /api/tier`, the single tier authority): T1/T2 one standard pass, T3 the two-reviewer refutation fan-out, T4 the same plus the checklist below. Tier-aware depth, the severity-gated fold and convergent review are in `hydra-qa-reference.md` (sibling of this SKILL.md).

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

**How the fail number is counted.** The bounce path is stateless on the issue (step 10 moves the issue through the lifecycle seam to the bounce state — `needs-dev-resume` while the PR is open, `ready-for-agent` otherwise (issue #4766) — resetting any label-carried counter on every bounce). So the count is derived **live** from the **PR** — the durable per-attempt ledger: every T4 deep-QA FAIL comment carries the machine-greppable marker line `Verifier-Core deep-QA: FAIL`. The next pass counts prior markers: `failNumber = priorMarkers + 1`; `failNumber >= 2` ⇒ block-and-escalate, else bounce. There is **no** new Redis key and **no** issue-label counter. "Consecutive" and "total fails on this PR" coincide because a PASS merges the PR and ends the loop. The pure decision rule is `decideDeepQaAction()` in `scripts/ci/qa-verdict.ts`.

## Never end a turn on a pending wait (issue #3953)

A backgrounded wait is **structurally unrecoverable**: end the turn while a
result is still pending and the result is delivered to a session that has
already exited — the only path back is an external `SendMessage` resume. This
generalises the **Blocking-dispatch mandate** to *every* backgrounding
mechanism a QA dispatch can reach — a `Monitor`, a backgrounded bash, a
reviewer spawn missing the flag.

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
node --no-warnings --experimental-strip-types scripts/qa/poll.ts --pr "$pr_number" --iterations 40 --interval 15
# -> {"pending": <n|null>, "settled": <bool>, "iterations": <n>, "checks": [{"name", "state"}]}
# settled=true  => every check is terminal: read the conclusions and post the final verdict.
# settled=false => budget expired (pending=null means gh never answered; never read that as terminal):
#                  post the partial-but-posted verdict below. NEVER re-arm the poll; one bounded budget.
```

**Prefer a partial-but-posted verdict over a pending one.** If the budget
expires, post the verdict the review supports now — `PASS-pending-CI` for a
review-PASS awaiting CI, or the review report with the un-settled state
recorded as of the last poll — never a prose *"I'll wait and post later"*. A
verdict the autopilot can act on beats one only an external resume can finish.

## Process

### 1. Preflight — issue, PR, fixed point, spec, CI, tier, admission, fan-out (steps 1–6.7, one call)

```bash
PF=$(mktemp)
node --no-warnings --experimental-strip-types scripts/qa/preflight.ts --issue $issue_number > "$PF" \
  || { echo "[hydra-qa] ERROR: preflight produced no result — pre-verdict exit, nothing posted" >&2; exit 1; }
pr_number=$(jq -r '.pr.number // empty' "$PF")
jq '{ok, stage, issue, pr: .pr.number, tier: .tier, gate: .gate.action, fanout: .fanout.mode}' "$PF"
```

**Pick-time claim (ADR-0047 D4).** Immediately after the preflight returns `.ok == true` (issue and PR resolved) — before any `defer` / `skip-required-failed` / `admit` branch acts on the issue — open the QA claim (label-free for the qa role; it copies the approved artifact hash and arms the PR-unit caps). `.ok == false` paths claim nothing. Take `<dispatchId>` / `<runId>` from the `hydra-dispatch` sentinel on the first line of your prompt; with no sentinel (operator-interactive) use `interactive-qa-$issue_number-<epoch>` and run `interactive`, and release your own claim after `route` with `--outcome verdict-posted` (a dispatched worker leaves release to reap):

```bash
npx tsx scripts/lifecycle.ts dispatch $issue_number --dispatch <dispatchId> --class qa_orch --run <runId> --pr $pr_number --purpose fresh
```

`claim-held` → log `[hydra-qa] WARN claim held by <existing.dispatchId>` and proceed with the review; `parked:*` → end with a `## Friction Report`, no review (parked is a human-hold state). When the lane head already has a verdict at head SHA and you move on to the next issue, first run `npx tsx scripts/lifecycle.ts release $issue_number --dispatch <dispatchId> --outcome released`, then claim the next — one held claim per dispatchId at any time.

Preflight is **read-only** and fails closed exactly as the old bash did: no tier → `tier.num: null, adversarial: true` (deeper review); a failed admission call → `admit`; a failed fan-out sizing → the tier fan-out; unreadable required contexts → the all-optional mapping tagged in `.degraded`. It prints ONE JSON object. Branch on it:

- **`.ok == false`** (`no-issue` | `no-pr` | `spec-missing-enforce`) — run `route` (below) with the same `--preflight "$PF"` and nothing else: it posts the one stop comment (`.stop`, if any) and ends. Then **stop**; no review runs. In Phase B/C (`DESIGN_CONCEPT_MODE=enforce`) a missing artifact is `spec-missing-enforce`; in Phase A (`warn`, the default) it is a logged skip, not a stop.
- **`.gate.action == "defer"`** — a non-reviewable blocker makes the verdict moot this pass (`mergeStateStatus == DIRTY`, or a T4 PR with a required check already failed). Run `route --preflight "$PF" --defer`: it posts the deferral comment, bounces the issue (not leaving `needs-qa`, issue #974) and emits **no verdict**. Then **stop**.
- **`.gate.action == "skip-required-failed"`** (T1/T2/T3 only) — a required check already failed, so no reviewer can change the FAIL. Run `route --preflight "$PF"` with **no** `--findings`/`--summaries` and spawn **zero** reviewers; it posts the FAIL and routes the bounce.
- **`.gate.action == "admit"`** — the common path: continue at step 7 with `.fanout`.

What the preflight fields mean for the reviewers:

- `.spec.input` is the flat design-concept artifact for the Spec sub-agent; `.spec.skippedReason` is the audit reason when the Spec axis is skipped (`design-concept-exempt` on the PR, `cleanup-scan`/`design-concept-exempt` on the parent issue, the Tier-1 prompt-only bypass, or the Phase A shadow-mode miss). A skip MUST be recorded as an audit line in `specSummary` (step 8).
- `.fanout.mode` sizes the review: `single` → step 7c (one reviewer, both axes; only T1–T3 PRs whose changed-file shape is not `code`); `standard` → step 7a; `adversarial` → step 7b. A T4 PR or a `code` PR always gets the full fan-out for its tier, and so does an unknown tier. `.fanout.reviewers` is the exact list of reviewer names to spawn and to check in step 7.5.
- `.tier.num` is the tier (`null` = classifier unreachable); `.tier.adversarial` is false in `single` mode so the fold reads one reviewer's verdict.

### 5. Collect current CI state — manual fallback only

Preflight already read CI through the engine's `checks` phase (`.checks.list`; `.checks.source` is `branch-protection`, `rollup-only-all-optional` when the required contexts were unreadable, or `null` when the rollup was). `route` refuses to compute a verdict from an unreadable (`null`) read — that is a pre-verdict exit, retried by the next dispatch. The shared fetch below is the standalone equivalent for an ad-hoc run outside `preflight`:

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

### 7. Spawn the review sub-agents in parallel (single message, all Agent calls)

**This is the critical step — all `Agent` tool calls MUST be in the same assistant message** so they execute in parallel and do not pollute each other's context. The upstream `code-review` skill (`~/.claude/skills/code-review/SKILL.md`) is the contract; do not re-implement its logic — invoke its process pattern.

**Every `Agent` call in this step MUST pass `run_in_background: false` (issue #3789).** The `Agent` tool defaults to background dispatch, so the spawning call returns immediately and the turn can end while reviewers are still running — a prose instruction to "wait for every reviewer" does not prevent this (a `qa_orch` dispatch said exactly that and exited anyway, four times in one autopilot run — #3789). `run_in_background: false` makes each spawn itself a **blocking** call, so the message containing all N spawns cannot return control — and the turn cannot end — until every reviewer has produced a result. Never substitute `run_in_background: true` plus a promise to wait; that is the pattern that stalled.

#### 7.0 Build the shared review packet once (issue #3815, root cause 3)

```bash
PK=$(mktemp)
node --no-warnings --experimental-strip-types scripts/qa/packet.ts --preflight "$PF" > "$PK" \
  || { echo "[hydra-qa] ERROR: packet failed (standards catalog unreadable?) — exit before any reviewer is spawned" >&2; exit 1; }
jq '{reviewPacketPath, standardsPacketPath, standardsFound, specInputPath, priorFindings, rereviewDiffBase, degraded}' "$PK"
```

`packet.ts` is a pure read (temp files only). It builds the diff + the full contents of every changed file at HEAD ONCE, appends the re-review context (7.0a) and the informational Merge-danger line (7.0b), and loads `CODING_STANDARDS.md` through the loader. An unreadable catalog exits 1 **before** any reviewer is spawned. In the prompts below: `$REVIEW_PACKET` = the contents of `.reviewPacketPath`; `$STANDARDS_PACKET` = the contents of `.standardsPacketPath` (the Standards-only rule catalog; it is NEVER part of `$REVIEW_PACKET` and the Spec reviewer never receives it); `$SPEC_INPUT_JSON` = the contents of `.specInputPath` (absent when the Spec axis is skipped); `$SPEC_SKIPPED_REASON` = the preflight's `.spec.skippedReason`; `$FIXED_SHA` = the preflight's `.fixedSha`.

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

On a T1–T3 PR whose latest QA verdict was a FAIL with a findings table, `packet.ts` appends the prior findings (and the incremental `git diff <prior sha>..HEAD` when the prior `sha=` is still an ancestor of HEAD) to the packet — `.priorFindings` / `.rereviewDiffBase` are non-empty. This is prompt context only: reviewers still review the FULL diff and changed files, and the engine fold alone decides the verdict. Nothing is filtered or demoted. Every unreadable input means no context: a plain first-pass review.

With re-review context, add this **re-review brief** to every reviewer prompt, after the findings contract:

> *This is a re-review after a FAIL. You still review the FULL diff and changed files. First state fixed/not-fixed for each prior finding; for anything new, prefer medium+ and say why it wasn't visible before. Report every finding in the normal `findings` block and grade it honestly: the verdict comes from the normal findings fold, never from this brief.*

#### 7.0b Merge danger check (issue #5258, ADR-0046 D5 — escalate-only)

The dev declares `Merge danger: <one-way|two-way> — <reason>` in the PR body; the one-way-door detector observes the diff; `packet.ts` compares them and prints `.mergeDanger` (`finding` and `gapLine`). Pass `--packet "$PK"` to `route`: it adds a non-null `finding` to the step-8 map under the synthetic key `merge-danger-check` (`under-declared` is a **medium**, `missing`/`malformed` a **low**, `over-declared` no finding) and appends the `Merge-danger-gap:` line to the verdict comment. Do NOT add `merge-danger-check` to `.fanout.reviewers`, and do not write the row yourself.

#### 7a. T1/T2 — single standard pass (`.fanout.mode` = `standard`)

Spawn exactly two parallel sub-agents — the **Standards** and **Spec** axes described below. This is the unchanged pre-#739 behaviour.

#### 7b. T3/T4 — adversarial fan-out (`.fanout.mode` = `adversarial`)

Run the review in **refutation framing** across **2 independent reviewers**. Each reviewer is its own Standards + Spec pair (the same two-axis contract below), so a T3 fan-out spawns **four** `general-purpose` sub-agents in one message: `reviewer-A-standards`, `reviewer-A-spec`, `reviewer-B-standards`, `reviewer-B-spec`. The two reviewers are **independent** — neither is told the other exists, same context-separation rule as the Standards/Spec split — so one cannot anchor the other.

Prepend the **refutation framing** to every T3 sub-agent prompt, before the axis brief:

> *You are an adversarial reviewer. Your job is to actively find a concrete reason this change is wrong, regresses existing behaviour, or fails to do what it claims — not to confirm it works. Assume there IS a blocker and hunt for it. Only report a finding if you can point to the specific line/behaviour it concerns, and grade it honestly on the severity rubric — refutation framing is about hunting, not about inflating severity; do not invent speculative concerns. If after a genuine adversarial pass you find nothing, say so explicitly and emit an empty findings list.*

Each reviewer (A and B) independently emits its findings (the findings contract below). Step 9 folds them: **T3** — FAIL on any medium/high finding from either reviewer; every low is a follow-up, even one both reviewers raised. **T4** — any finding from either reviewer is a FAIL (unchanged).

#### 7c. Docs/tests/prompt-only — single reviewer (`.fanout.mode` = `single`, issue #4733)

Spawn exactly **one** blocking `general-purpose` sub-agent, `reviewer-single`, with `run_in_background: false`. Its prompt carries the Standards brief AND the Spec brief below (both axes, one agent), and asks for the report under two headings, `## Standards` and `## Spec`, so step 8 renders it unchanged. Drop the T3 refutation framing; the smell battery, Hydra checks and the findings contract still apply. Step 9 folds its findings: only a medium/high finding FAILs.

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

- `$REVIEW_PACKET` inline (the diff + full changed-file contents), per the shared packet discipline in step 7.0. `$FIXED_SHA` is for reference only — the reviewer does NOT run `git diff` / `git show` or an exploratory tool loop.
- The standards-source files the reviewer MAY open by name (one, to cite a specific rule — not read end-to-end): `CLAUDE.md`, `CONTEXT.md`, `docs/adr/*.md`, `docs/agents/*.md`, `.editorconfig` (machine-enforced — note but don't re-check), `tsconfig.json`. `CODING_STANDARDS.md` is already inlined below as `$STANDARDS_PACKET`.
- `$STANDARDS_PACKET` inline (step 7.0) — the Standards-only rule catalog. The Spec reviewer never receives it.
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
  - **Coding standards catalog** — apply every rule in the inlined CODING_STANDARDS.md catalog; a finding's `finding` text begins with the rule ID token (`STD-<AREA>-<NAME>: ...`) or, for a smell, the exact Fowler smell name. Severity follows the rule's own text, defaulting to low when the rule is silent.
  - **Tier alignment** — the PR body's `Tier: N` line (populated by `hydra-dev` from `/api/tier`) must agree with the artifact's `interfaceImpact` if an artifact is present. `breaking` ⇒ tier ≥ 2.

**Spec sub-agent prompt** — include:

- `$REVIEW_PACKET` inline (the diff + full changed-file contents), per the shared packet discipline in step 7.0. `$FIXED_SHA` is for reference only — the reviewer does NOT run `git diff` / `git show` or an exploratory tool loop.
- Do NOT include `$STANDARDS_PACKET` in this prompt — the Spec axis never sees the standards catalog.
- The artifact JSON (`$SPEC_INPUT_JSON`) embedded verbatim, OR the skip reason (`$SPEC_SKIPPED_REASON`) — if skipped, this sub-agent reports `"no spec available"` per the upstream `code-review` skill's contract and exits early.
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

The expected set is the preflight's `.fanout.reviewers`:

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

Transcribe every reviewer's `findings` rows into ONE JSON **object** in a file: keyed by the spawned reviewer name (from the preflight's `.fanout.reviewers`, e.g. `reviewer-A-standards`), each value that reviewer's rows as a JSON array. `route` passes the preflight's `.fanout.reviewers` list to the fold as `spawnedReviewers`, so the coverage of the map is **checked, not assumed** (issue #4758). Each row keeps `axis` (`standards` or `spec`); a row may omit `reviewer` — it inherits its map key. Copy rows as written: never drop, merge, or re-grade a reviewer's finding; rows under a key that is not a spawned reviewer are still counted, never dropped. **Fail closed on malformed output:** a spawned reviewer with NO entry in the map, or whose value is not a JSON array, becomes one high `reviewer-output-malformed` finding naming that reviewer — FAIL at every tier, T4 included, and for an unknown tier. An omitted reviewer is malformed, not clean: write a reviewer's value as `[]` only when that reviewer explicitly returned `[]`, and only an explicit `[]` from EVERY spawned reviewer is a clean PASS. An empty `.fanout.reviewers` list, or a flat array where the fold expected the per-reviewer map, is itself malformed — never a silent PASS. The file must always be written: a missing, empty, or unparseable file is itself a FAIL, never an empty map; a non-object row becomes a high `reviewer-output-malformed` finding carrying the raw row text. The fold merges the same finding raised by two reviewers itself: rows whose locations reduce to the same canonical key match (`canonicalLocationKey()`). Accepted location formats, all folded to `path:N` (one pair of surrounding quotes/backticks and one trailing parenthetical — `src/<module>.ts:12 (buildX)` — stripped first, then trimmed, lowercased, leading `./` dropped): `path:12`, `path:L12`, `path#L12`, `path L12`, `path:12-18` (range start), and `path:12:5` (column dropped). A bare `path` with no line keys as `path`; an extension-less file name such as `Dockerfile:12` is path-like only WITH a line number (`Makefile` alone stays a placeholder). Placeholders never merge on their own: the `NON_MERGEABLE_LOCATIONS` list (empty, `(no location)`, `PR body`, `n/a`, `-`, `none`, case-insensitive) and anything that isn't path-like — the whitespace test applies to the path part after the quote/backtick/parenthetical stripping, and a path with no `/` or `.` needs a `:N` line reference. If reviewer A and reviewer B describe the same defect at different lines, give both rows the same `"key"` string so the fold lists them as one merged row. Put each axis's summary paragraph in the summaries file (`standardsSummary` / `specSummary`). At T3/T4, join the two reviewers' paragraphs with `A:` / `B:` prefixes. When the Spec axis was skipped, set `specSummary` to `_Skipped: <the preflight's .spec.skippedReason>_`.

**Merge danger row (issue #5258):** do not write it yourself — `route --packet "$PK"` merges the packet's non-null `.mergeDanger.finding` into this map under the key `merge-danger-check` (step 7.0b). Never add that key to `.fanout.reviewers`.

### 9. Route the verdict — fold, trailer, round action and every effect (steps 9 / 9.5 / 9.6 / 10, one call)

```bash
FINDINGS_FILE=$(mktemp)    # the step-8 per-reviewer JSON map
SUMMARIES_FILE=$(mktemp)   # {"standardsSummary": "...", "specSummary": "..."}
# ... write the transcribed per-reviewer findings map into "$FINDINGS_FILE" and the two axis paragraphs into "$SUMMARIES_FILE" ...
[ -f "$FINDINGS_FILE" ] || : > "$FINDINGS_FILE"   # a missing file is malformed reviewer output, not a crash
ROUTE_JSON=$(node --no-warnings --experimental-strip-types scripts/qa/route.ts \
  --preflight "$PF" --packet "$PK" --findings "$FINDINGS_FILE" --summaries "$SUMMARIES_FILE") \
  || { echo "[hydra-qa] ERROR: route produced no verdict — pre-verdict exit, one QA-Verdict-Error comment at most, needs-qa untouched" >&2; exit 1; }
rm -f "$FINDINGS_FILE" "$SUMMARIES_FILE"
NEXT=$(printf '%s' "$ROUTE_JSON" | jq -er '.nextStep') || exit 1
```

`route.ts` makes exactly ONE pass through the engine — fold → classify → trailer → round action, in-process — then performs the step-10 effects and prints `{verdict, reason, reviewVerdict, blockers, maxSeverity, worstFinding, trailer, round, deepQa, effects:[{kind, target, ok}], nextStep, degraded}`. `--dry-run` prints the identical plan with zero writes. Findings are bound RAW so a malformed file reaches the fold and fails closed to the high `reviewer-output-malformed` blocker; T1–T3 fold severity-gated, T4 (or an unknown tier) keeps the unchanged any-blocker AND (`aggregateAdversarialReview()`).

- **A non-zero fold / trailer / round-action result is a pre-verdict exit.** `route` exits 1 with at most one `QA-Verdict-Error` comment and `needs-qa` untouched; the next dispatch retries. There is no bash verdict fallback, and no path from a degraded fold or an empty round-action to a PASS. `--defer` is the only path that posts without a verdict.
- **Every verdict comment ends with exactly one canonical trailer line** (the human header above it is free to drift; this line is not): `QA-Verdict: <PASS|FAIL|PASS-pending-CI|FAIL-pending-CI> pr=<N> round=<k> sha=<head12> blockers=<n> max_severity=<high|medium|low|none>`. The `trailer` engine phase derives `round` from the PR thread and owns the fail-closed `QA-Verdict-Error:` line. The full review lives only on the PR; the issue gets a short pointer that keeps its bounce-marker header line.
- **Issue state moves ONLY through the lifecycle seam** (the `advance` verb of `scripts/lifecycle.ts`, ADR-0047 D3, #5317): `route` writes no state label by hand, and a refused seam call exits non-zero rather than editing labels. A `pr-merged` refusal is not an error (reconcile owns it) and ends `route` with exit 0.
- **PASS** comments FIRST (a COMMENT, never an approval — the shared identity cannot self-approve, #848; the seam's `qa-verdict` gate reads the PASS trailer at head), then at T4 posts the SHA-bound Deep-QA PASS marker the engine rendered, then enters `qa-passed` through the seam. A refused entry posts a `QA-Verdict-Error` and defers the issue off `needs-qa` (`nextStep` stays `none`, `degraded` gains `qa-passed-refused`). **PASS-pending-CI** comments and enters `qa-passed` the same way; the reconcile pass reads CI live. **FAIL** disarms auto-merge FIRST on every tier (#4737), comments, then bounces — `needs-dev-resume` while the PR is open (a failed or empty state read defaults there too), `ready-for-agent` only on a confirmed CLOSED/MERGED read; GLM provenance changes comment wording only (#4766). The 3rd reviewed T1–T3 FAIL is PARKED by the seam (`parked`, an off-list escalation per ADR-0047 D6 — never `ready-for-human`; in shadow mode `route` parks explicitly and posts the unified cap-park comment). T4 posts the `.failMarker` comment and block-and-escalates (`ready-for-human`) on the 2nd consecutive deep-QA FAIL.
- **The auto-merge call site stays here, in this playbook** (the QA merge guard's call-site detector pins it). When `nextStep` is `arm-auto-merge` (a PASS), enable auto-merge (squash) — CI is the merge gate, so `--auto` lets GitHub squash-merge the instant the checks settle without this dispatch blocking on them. The issue already left `needs-qa` through the seam, so even if this call errors it is not left in the #974 busy-loop:

```bash
if [ "$NEXT" = "arm-auto-merge" ]; then
  gh pr merge $pr_number --repo gaberoo322/hydra --auto --squash --delete-branch \
    || echo "WARN: failed to enable auto-merge on PR #${pr_number} (non-fatal — issue already in qa-passed; CI is the merge gate)"
fi
```

**A failed disarm is a HARD STOP (operator ruling, PR #5379).** A FAILed PR must never stay auto-merge-armed. `route` disarms first on every FAIL, retries once after a short backoff, and tags a still-failed disarm `disarm-failed` in `.degraded`. Run this check after every `route` call, before anything else:

```bash
if printf '%s' "$ROUTE_JSON" | jq -e '.degraded // [] | index("disarm-failed")' >/dev/null; then
  gh pr merge $pr_number --repo gaberoo322/hydra --disable-auto \
    || echo "[hydra-qa] ERROR: manual --disable-auto on PR #${pr_number} failed" >&2
  ARMED=$(gh pr view $pr_number --repo gaberoo322/hydra --json autoMergeRequest --jq '.autoMergeRequest') || ARMED="unknown"
  [ "$ARMED" = "null" ] && echo "[hydra-qa] disarm-failed: auto-merge now DISARMED on PR #${pr_number} (confirmed autoMergeRequest == null)" \
    || echo "[hydra-qa] ERROR (LOUD): disarm-failed and PR #${pr_number} is STILL auto-merge-armed (autoMergeRequest=${ARMED}) on a FAILed verdict — operator must disarm it" >&2
fi
```

Report the outcome loudly in the verdict output either way.

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
The issue auto-closes via `Closes #N` in the PR body when the squash-merge lands.

### 11. Lesson capture on FAIL (issue #392, refined by #524)

After a FAIL verdict — before returning — record a planner pattern so the
agent-memory write path keeps producing durable rules in
`config/feedback/to-planner.md`. This is the only post-cycle writer to
`hydra:memory:{agent}:patterns` (agent = planner) for Claude-driven QA after #383 deleted
the Codex runner (ADR-0006).

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
