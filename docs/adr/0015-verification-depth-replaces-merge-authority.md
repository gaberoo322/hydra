---
status: accepted (supersedes ADR-0001 and ADR-0004 on the merge-authority question)
---

# Self-modification tiers are verification depth, not merge authority

A **Modification Tier** no longer answers "who merges this PR." It answers a single question: **how much verification a change must clear before it auto-merges.** Every change has an autonomous merge path — "too dangerous to auto-merge" is no longer a steady-state outcome. The operator is never a gate; they are an escalation *destination* reached only when autonomous remediation has been exhausted. This supersedes ADR-0004's authority ladder (Tier 0 operator-only / Tier 3 operator-review) and ADR-0001's "Untouchable Core is operator-modifiable only" premise. ADR-0001's durable decision — the gate is its own module and a change to the gate is verified by the *live* gate, not the proposed one — survives and is strengthened here.

## The tiers (monotonic — depth ascends with blast radius)

| Tier | Scope (blast radius) | Verification depth to auto-merge |
|------|----------------------|----------------------------------|
| **T1 — prompt-shaped** | `config/agents/`, `config/feedback/` | CI green + standard QA pass |
| **T2 — behavior-shaping** | `.claude/skills/`, `dashboard/`, anchor-selection, verification-rule *additions* | T1 + **Outcome Holdback** (post-merge watch → auto-revert) |
| **T3 — core src** | everything else in `src/`, plus `src/grounding.ts`, `src/cost/`, the watchdog scripts, `scripts/deploy.sh` | T2 + raised mutation-kill floor + scope-clean + **adversarial QA** (reviewer prompted to *refute*) |
| **T4 — Verifier Core** | `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts` | T3 + **deep-QA remediation loop** (comment → bounce to dev → 2nd fail = block + notify) + the **live-gate invariant** |

Two principles make T4 — auto-merging the verifier itself — safe rather than circular:

1. **Live-gate invariant.** The verification deciding whether a T4 change may merge runs the *currently-deployed* gate and reviews the *diff* against live behavior. The proposed gate never verifies its own admission. This is the single idea that lets the verifier files auto-merge without a self-reference hole (a malformed `ci.yml` that "always passes" is judged by the old `ci.yml`, which still works).
2. **Remediation loop with teeth.** QA failure anywhere bounces the PR back to a dev agent with the reviewer's comments. The loop is universal; what *scales* with tier is how adversarial/specialized the reviewer is. Only T4 carries block-and-escalate teeth: a **second** failed deep-QA pass blocks the PR and routes it to the operator.

## Escalation surface

The operator has exactly one touchpoint: the `/hydra-review` pickup set (operator-decision queue + `ready-for-human` + stale-blocked). The deepest-tier "2nd deep-QA fail → block" is just one more producer feeding it. A separable mechanism (a hook firing when that set goes non-empty) pushes a phone notification, so the operator learns *when* to run `/hydra-review` rather than polling. Tracked as its own work item, not part of this ADR.

## Kill switch

The ADR-0004 kill switch (formerly "force everything to Tier 3 = operator review") is repurposed as a **manual, operator-only emergency brake**: pause all auto-merge and route every open PR to the `/hydra-review` queue. Default off. It is the one sanctioned reintroduction of operator-as-gate, used for incidents (a bad merge wave, outcome instability, a suspected CI compromise) — not a steady-state mode.

## The shrink

The old Tier-0 "Untouchable Core" was 11 paths conflating two different risks. T4 is **5 paths** — only the self-referential verifier files, where a bad merge disables *future* verification. The other six (`grounding.ts`, `src/cost/`, three watchdog scripts, `deploy.sh`) drop to T3: a bad merge there hurts, but the next PR's still-intact gate can catch and revert the fallout. The term **Untouchable Core** is retired in favor of **Verifier Core**.

## Considered options

- **Keep an operator-only tier (status quo).** Rejected: it is a dead-end with no autonomous path, and it conflated "high blast radius" with "the operator must do this," which is what made "tier" a non-monotonic, misleading name. The operator-as-default-gate is the bottleneck the whole autopilot exists to remove.
- **Auto-merge the verifier with no live-gate invariant.** Rejected: this is the literal circularity hole — a change to `ci.yml` verified by the proposed `ci.yml` can neuter all future verification in one merge.
- **A weighted confidence score per tier.** Rejected in favor of explicit hard gates per tier: deterministic, auditable, and consistent with "hard verification is never an agent claim."

## Live-gate invariant (implementation — issue #738)

A change to the **Verifier Core** is verified by the *currently-deployed*
gate, never by the proposed one. CI realises this in the `tier-gate` job of
`.github/workflows/ci.yml` via `scripts/ci/live-gate.sh`:

1. **The changed-file LIST is always the PR diff** (head vs base). The
   invariant moves only the classifier *logic*, never the file list — you
   judge the PR's files using the old rules.
2. **"Is this a Verifier Core PR?" is decided with the BASE-ref
   `isVerifierCore`** (extracted from `merge-base origin/master HEAD`), so a
   PR cannot remove its own path from `VERIFIER_CORE_PATHS` on its head and
   thereby dodge base-ref treatment.
3. **If yes → classify with base-ref scripts.** The three import-closed
   scripts (`scripts/tier-classify.ts → src/tier-classifier.ts →
   src/untouchable.ts`) are extracted from the base ref into a temp tree and
   run with the workspace's `tsx`. A neutered head classifier (e.g. one that
   returns T1 for `ci.yml`) is still caught, because the base-ref classifier
   — which still works — does the classifying.
4. **If no → run the head-ref classifier exactly as today.** Zero behavior
   change for the ~95% common case.

Base ref = `git merge-base origin/master HEAD`, **not**
`pull_request.base.sha` (which goes stale on rebased PRs) — the same
rebase-safe pattern the `mutation-test` job uses. The verdict semantics
(T4 → `operator-approved` required, pre-#743) are unchanged; only the
*source* of the classifier rules moves from head to base. A regression
fixture (`test/live-gate.test.mts`) exercises the branching — including the
neutered-head case — without a real GitHub PR. The inline comment in
`ci.yml`'s tier-gate job and the header of `live-gate.sh` warn future
editors not to route Verifier Core PRs back through the head-tree
classifier, which would re-open the circularity hole.

## Consequences

- `should_auto_merge()` in `scripts/autopilot/decide.py` collapses: every tier returns a merge path; the `tier == 0 → queue-decision` and `tier == 3 + scope-justification → queue-decision` branches are replaced by tier-scaled gate requirements + the remediation loop. (The stale CLAUDE.md "Tier 3 = operator merges" table is corrected — decide.py already auto-merged most Tier 3.)
- The CI tier-gate stops blocking on an `operator-approved` label and starts asserting the *depth* requirements for the PR's tier.
- T4's live-gate invariant requires CI to run the verifier scripts from the **base** ref, not the PR head — a concrete CI change, not just policy.
- The T4 deep-QA reviewer is the existing `hydra-qa` skill made tier-aware (a Verifier-Core checklist + block-and-escalate teeth), not a separate agent — one QA skill to maintain.
- ADR-0001 status → superseded-in-part (authority premise dies; gate-extraction + live-gate architecture stands). ADR-0004 status → superseded by this ADR. ADR-0005 drops "Tier 0 changes" from its escalation list — tier no longer triggers escalation; only a 2nd-pass QA failure does.
