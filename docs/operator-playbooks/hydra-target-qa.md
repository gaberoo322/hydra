---
name: hydra-target-qa
description: Independent QA verification for Target (hydra-betting) PRs — Standards on every PR, plus Spec + a 2-reviewer adversarial fold on money-critical changes. Bounces hard findings to the reframe queue. No deep-QA remediation loop, no operator escalation.
when_to_use: "When a Target build opens a PR and needs an independent reviewer (today the executor grades its own work), the operator says 'QA the target PR', or hydra-autopilot dispatches Target QA."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Agent(*)
arguments: [pr_ref]
claude_only: true
---

# Hydra Target QA

The Target's first **independent reviewer**. Today the `hydra-target-build`
executor grades its own work — there is no second set of eyes, so
money-critical betting-math and execution paths merge through the same shallow
gate (typecheck + test + emulated merge-on-green) as a copy tweak. This skill
closes that gap with a proportionate, depth-routed QA pass (issue #1055, parent
epic #1052).

It deliberately **does NOT** mirror the Orchestrator's heaviest machinery — the
T1–T4 Modification Tier ladder, Verifier Core, the live-gate invariant, the
deep-QA remediation loop, or per-merge Outcome Holdback. Those exist to stop the
Orchestrator from neutering its own verifier; a Target PR structurally cannot
break the builder, so that apparatus does not apply. What the Target gets here
is an independent reviewer plus an adversarial fold on the dangerous ~10% of
changes — and nothing more.

## Depth routing — the money-critical flag

Verification depth is routed on the **money-critical flag**
(`classifyTargetRisk` in `src/target/money-critical.ts`) — the single
organizing primitive shared by every Target gate. A path is money-critical iff
it touches provider integrations, execution, staking, or bet-math
(`src/lib/providers/`, `src/lib/execution/`, `src/lib/staking/`,
`src/lib/bet-math/` in the **Target** repo).

| Path | Verification depth |
|------|--------------------|
| **safe** (UI / docs / config — ~90% of changes) | a SINGLE independent **Standards** pass |
| **money-critical** (providers / execution / staking / bet-math) | **Standards + Spec + a 2-reviewer adversarial fold** — all must pass |

- **Standards** (every PR) — conventions, tests-present-and-non-empty, no
  silent catch, no unjustified touch of money-critical paths, and — on any
  UI-touching PR — **render-robustness** (see below).
- **Spec** (money-critical only) — diff vs. the design-concept artifact for the
  work item (the lightweight Target artifact from #1056; absent → treat the
  Spec axis as a hard finding so the heavier gate never passes by omission).
- **Adversarial fold** (money-critical only) — TWO independent reviewers, each
  prompted in **refutation framing** (actively find a reason this change is
  wrong / regresses something), neither told the other exists. The change
  passes only if **both** find no real blocker; a single real blocker from
  either is a FAIL.

The pure folding rule is `classifyTargetQaVerdict()` in
`scripts/target/target-qa-verdict.ts` — never re-derive the routing by hand.

## Render-robustness — pages degrade on data gaps, never throw

Every **UI-touching** PR (page/route components, server components, and their
data loaders) must clear the Target's **degrade-never-throw** convention on the
**Standards** axis: a route must **never `500` because of a data state**. When
data is missing, stale, or carries an **unknown enum value**, the page must
render a degraded state — a callout, an empty-state row, or a "data unavailable"
panel — instead of throwing. This is the Target sibling of the Orchestrator's
"never throw from merge/grounding/verification" convention.

- **Recurrence class this catches** — new venues, sports, providers, and other
  enum values **WILL** appear in production data before the UI knows them. A
  loader that trusts the data shape (unchecked enum switch, `.find(...)!`,
  non-null assertion on an optional row) is a latent `500` the first time an
  unexpected value lands. Treat any un-guarded assumption about data
  presence/shape on a render path as a **hard finding**.
- **Exemplar fixes** — Target backlog **item-737** (a missing reconciliation
  checkpoint that `500`ed the route) and **item-738** (an unknown sport key that
  `500`ed the route). Four live production routes `500`ed this way (epic #2732);
  the fixes render a degraded panel instead of throwing.
- **What Standards checks on a UI PR** — for each touched render path, confirm
  the loader/component tolerates: a missing row, an empty result set, a `null`
  or stale value, and an **unrecognized enum/discriminant** — each producing a
  visible degraded state, not an exception. A UI PR that adds or edits a render
  path without this tolerance is a hard finding (FAIL → bounce-to-reframe).

The authoritative statement of this rule lives in the Target repo's
`CLAUDE.md` / `web/AGENTS.md`; this checklist is how QA enforces it on every
UI-touching PR.

## Routing the outcome — bounce, never escalate

A hard finding from **any** consulted axis folds to a `FAIL` verdict whose
action is `bounce-to-reframe`: push the work item to the existing **reframe
queue** (`hydra:anchors:reframe-queue`), which `hydra-target-review` surfaces to
the operator on the next review. There is **NO** new escalation path, **NO**
`ready-for-human`-style operator channel, and **NO** deep-QA remediation loop —
those are the Verifier-Core teeth epic #1052 explicitly declines to mirror for
the Target. A `PASS` verdict's action is `merge`: the Target's normal
merge-on-green path proceeds (this skill never merges directly).

## Process

### 1. Resolve the PR + changed paths

If `$pr_ref` is provided use it; otherwise resolve the PR the current Target
build opened. Collect the changed paths (repo-relative, Target repo):

```bash
# In the Target worktree, or via the PR API.
CHANGED=$(git diff --name-only origin/main...HEAD)
```

### 2. Classify the path

Feed the changed paths to `classifyTargetQaPath()` (or call
`classifyTargetRisk` directly) to decide `safe` vs. `money-critical`. Do NOT
infer the path from a hand-maintained pattern list — the classifier in
`src/target/money-critical.ts` is the single source of truth.

### 3. Run the reviewer sub-agents for the chosen path

- **safe** — one **Standards** reviewer sub-agent. Collect its `PASS` / `FAIL`.
- **money-critical** — run, in parallel independent sub-agents:
  1. **Standards**,
  2. **Spec** (against the design-concept artifact),
  3. **adversarial reviewer A** (refutation framing),
  4. **adversarial reviewer B** (refutation framing, no shared context with A).

  Each returns `PASS` / `FAIL`. A reviewer surfaces a `FAIL` only on a **real
  hard blocker**, not a nit.

### 4. Fold the verdict

Pass the changed paths and the collected reviewer verdicts to
`classifyTargetQaVerdict()`. It returns `{ verdict, path, moneyCritical,
action, reason, matchedPaths }`. The fold is pure and total — a missing
money-critical-only verdict is treated as a FAIL (defensive: an absent reviewer
must never let the heavier gate pass by omission).

### 5. Execute the routing

- `action: "merge"` — report PASS; let the Target merge-on-green path proceed.
- `action: "bounce-to-reframe"` — push the work item to the reframe queue and
  report the finding. Do NOT escalate to the operator and do NOT open a
  remediation loop.

```bash
# Bounce: move the item to the reframe lane (the hydra-target-review pickup set).
hydra backlog move <item-id> reframe
# or, if the item is a free-form work-queue retry:
#   hydra queue add "<title>" -d "reframe: <reason from the verdict>"
```

### 6. Report

Emit the folded `verdict`, the `path` taken, the `reason`, and (on
money-critical) the per-axis reviewer verdicts. The verdict literal is
`PASS` / `FAIL` — there is no tier-pending machinery here (the Target's CI is a
single self-hosted runner with emulated merge-on-green, not the Orchestrator's
multi-check rollup).

## Invariants

- **Depth is routed only by the money-critical flag** — never by PR size, file
  count, or a self-asserted level.
- **The fold lives in one pure function** — `classifyTargetQaVerdict()`,
  unit-tested in `test/target-qa-verdict.test.mts`. The playbook collects
  reviewer verdicts; it does not re-implement the AND/short-circuit logic.
- **FAIL bounces to the reframe queue. Never escalates.** The only operator
  surface is the existing `hydra-target-review` drain of the reframe lane.
- **Render-robustness is a Standards-axis requirement on every UI-touching PR**
  — a render path that can `500` on a missing/stale/unknown-enum data state is a
  hard finding. New venues/sports/enum values arrive in production before the UI
  knows them; the page must degrade, never throw.
- **No deep-QA remediation loop, no Verifier-Core checklist, no Outcome
  Holdback** — those are Orchestrator self-modification-containment gates the
  Target structurally does not need (epic #1052 rationale).

## References

- Issue #1055 — this skill (independent Target QA).
- Parent epic #1052 — selectively converge the Target SDLC with the
  Orchestrator's build-quality machinery.
- `src/target/money-critical.ts` (issue #1053) — the money-critical classifier
  this skill routes on.
- `scripts/target/target-qa-verdict.ts` — the pure verdict fold.
- `scripts/ci/qa-verdict.ts` — the Orchestrator's analogous one-pass verdict
  classifier (the shape this skill mirrors, minus the tier ladder).
- `docs/operator-playbooks/hydra-target-review.md` — drains the reframe queue.
- Issue #2734 / epic #2732 — the render-robustness (degrade-never-throw)
  convention and the four live-`500` routes that motivated it; exemplar fixes
  item-737 (missing reconciliation checkpoint) and item-738 (unknown sport key).
