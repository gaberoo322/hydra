# ADR-0032: GLM dev-drainer worker lane

Status: Accepted
Date: 2026-07-25
Deciders: Operator + Hydra (wayfinder map #3663, which locked the six decisions transcribed here)
Related: #3685 (epic), #3664 (viability research), #3666–#3671 (the six grilling decisions this ADR transcribes), #3687–#3690 (the sibling build slices this ADR governs), ADR-0012 (autopilot is the single brain — the decision this ADR upholds), ADR-0004 / ADR-0015 (self-modification tiers — the T2/T3 fence), ADR-0005 (operator escalation is narrow — credentials/secrets), ADR-0001 (Verifier Core — the permanently excluded surface)

## Context

The Opus/Fable autopilot loop authors every `dev_orch` PR against Anthropic's subscription quota. When that quota is tapped — the pace-gate's `emergencyStop` / `weeklyEmergencyStop` fires — the loop stops authoring, and a backlog of `ready-for-agent` issues sits idle until quota recovers. The Orchestrator repo is public (#698) and most `dev_orch` issues are shallow, mechanical, well-specified T2/T3 changes whose design is already locked by `design_concept_orch` before a line is written. Those two facts open a **quota-relief** opportunity: shift the *authoring* load of that shallow-issue class onto a **separate, independent quota** while keeping the Opus brain, the design stage, and the merge gate exactly as they are.

z.ai exposes an Anthropic-compatible API (`https://api.z.ai/api/anthropic`) serving GLM-4.7 on its own quota, driven by the same `claude` CLI via a base-URL override. This makes a **worker lane** possible: a dumb, fenced service — a **dev-drainer** — that picks a pre-designed eligible issue and authors the code with GLM while the Opus autopilot continues to be the sole decisional brain.

Wayfinder map #3663 charted the fog. Its grilling decisions closed to terminal verdicts (#3666–#3671), viability research landed (#3664), and this ADR is the design of record transcribing them. It is the **governing record** for the drainer: the four sibling build slices (#3687–#3690) cite it for terminology (`glm-eligible`, `glm-authored`, dev-drainer loop, fail-closed creds, secret-scan preflight) and for the invariants below.

This is a **docs-only, additive T3 change** — a single new `docs/adr/0032-*.md` following the ADR template, touching no Verifier-Core path and no code interface. The drainer machinery itself (labels + collect-state partitioning, the spawn wrapper + secret-scan, the systemd drainer loop, the beachhead report) is built by #3687–#3690, not here. `npm test` and `tsc` stay green because nothing executable changes.

## Definitions

These terms are defined authoritatively here so the sibling slices can cite ADR-0032 rather than redefine them. They are correctly **absent from `CONTEXT.md`** — the glossary is one-line-definition-only (#441); a multi-paragraph defended definition belongs in an ADR, which is what this is.

- **dev-drainer** — a dumb, fenced systemd service that drains the backlog of GLM-eligible issues by authoring their code with GLM. Its loop is: acquire the flock lock → check the kill-switch → check the daily PR cap → pick an eligible issue → claim it → author with a base-URL-overridden `claude` process → run the secret-scan + Verifier-Core/T4 diff preflight → open the PR. It **does not** design, self-select against a scoring engine, or QA — those stay with the brain, `design_concept_orch`, and `qa_orch`.
- **worker lane** — the authoring-only role GLM occupies: it writes code the Opus brain has already decided to build, and its output flows through the identical `qa_orch` + CI merge gate. GLM is a worker, never a brain (Decision 1).
- **glm-eligible** — the **issue-side** eligibility label. An issue carries `glm-eligible` when it is a designed, shallow, in-fence `dev_orch` item the drainer may pick. It lives in the issue / `ready-for-agent` label space.
- **glm-authored** — the **PR-side** provenance label. A PR carries `glm-authored` when the drainer authored it. It lives in the PR / `active_dev_orch` label space. The two label spaces are distinct (Decision 5 / invariant 9).
- **z.ai mechanism** — a **separate** `claude` process launched with `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` and `ANTHROPIC_AUTH_TOKEN` (Decision 2), mapping GLM-4.7 to the Sonnet slot.
- **fail-closed creds** — the credential posture (invariant 7): the auth token has no default, so an absent token aborts the run rather than silently falling back to Anthropic quota.
- **secret-scan preflight** — the output-side diff gate (`scripts/ci/secret-scan.sh`) that aborts *before* `gh pr create` if the diff would leak a secret or touch a fenced-out path (invariant 8).

Terms cited by reference, not redefined here: **Verifier Core** (ADR-0001 / CONTEXT.md — the self-referential files the fence permanently excludes), **Modification Tier** (ADR-0004 / ADR-0015 — the T1–T4 depth ladder the fence is scoped to T2/T3 of), **money-critical / risk-critical surface** (CONTEXT.md — the permanently off-GLM `dev_target` fence), **single-brain** (ADR-0012 — the decision this ADR upholds), **Design Concept** (ADR-0008 — the `design_concept_orch` stage that stays active on eligible issues), **Live-Gate Invariant** (CONTEXT.md — why the Verifier-Core exclusion is a hard fence).

## Decision

The through-line: **GLM is a fenced worker that drains the shallow, pre-designed `dev_orch` backlog on z.ai's independent quota — the Opus autopilot stays the single brain, `design_concept_orch` designs, and the identical `qa_orch` + CI is the merge gate.**

### Decision 1 — GLM is a fenced WORKER, never a brain (ADR-0012 single-brain upheld)

The Opus/Fable autopilot remains the **sole decisional brain**. `design_concept_orch` designs every `glm-eligible` issue before the drainer touches it; GLM only **authors**; the identical `qa_orch` + CI remain the merge gate. The ADR introduces **no second control loop** and **no self-selection or self-QA** — those would recreate the two-control-plane flaw ADR-0012 eliminated.

### Decision 2 — Mechanism: a separate base-URL-overridden `claude` process

Authoring runs in a **separate** `claude` process launched with `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` + `ANTHROPIC_AUTH_TOKEN` (**not** `ANTHROPIC_API_KEY`, **not** the Codex plugin), mapping **GLM-4.7 to the Sonnet slot**. The env is injected via **systemd** from an off-git `EnvironmentFile` — **never `.env.local`** (which reproduces the paper-LLM MODEL-override gotcha where a dotenv silently overrode `ExecStart` flags). Only a base-URL override on a first-party `claude` process shifts authoring load onto z.ai's quota; the Codex-plugin path cannot apply the override, so it would keep burning Anthropic quota (rejected below).

### Decision 3 — Scope fence: `dev_orch` T2/T3, permanently excluding Verifier Core / T4 and all money-critical `dev_target`

The drainer authors **only** `dev_orch` issues at **Modification Tier T2 or T3**, **excluding the Verifier Core and all of T4**, and **excluding all money-critical `dev_target`** work. This is a **permanent standing fence**, not a beachhead-only limit: money-critical paths carry outsized real-world consequence (risk-critical surface) and z.ai offers no training opt-out, so they are permanently off-GLM. The fence is enforced by the secret-scan preflight's Verifier-Core/T4 diff check (invariant 8), not by trust.

### Decision 4 — Operational model: a dumb dev-drainer systemd service

The drainer is a **dumb service**: no self-selection against a scoring engine, no self-QA. The brain designs (via `design_concept_orch`), GLM authors, and the identical `qa_orch` + CI is the merge gate. Its loop is flock → kill-switch → daily-cap → pick → claim → author → preflight → PR.

### Decision 5 — Partition: label provenance + label eligibility + a flock lock namespace

Provenance is carried by the **`glm-authored` PR label**, **not** by a branch-name prefix — the drainer runs in a git worktree, so its PR head branch shares the `worktree-agent-*` prefix that Opus `dev_orch` PRs also use, and a branch-name carve-out cannot discriminate them. Eligibility is carried by the **`glm-eligible` issue label**. Concurrency is a **separate flock lock namespace**, **not** a Redis lock.

### Decision 6 — Governance: concurrency 1, honor only operator `paused`, daily cap, operator keep-or-kill

Concurrency is **exactly 1**, enforced by an **flock lockfile** (kernel auto-release on process death = zero orphan risk). The kill-switch honors **only** the operator `paused` flag and **deliberately ignores** Anthropic `emergencyStop` / `paceState` / `weeklyEmergencyStop` — GLM runs on z.ai's independent quota, so pausing on Anthropic exhaustion would make the drainer sleep exactly when it is most needed. A **daily PR cap** bounds throughput. Keep-or-kill is an **operator judgment** surfaced in `hydra-review` over a ~2-week / ~25-PR window — **not** an auto-flip circuit-breaker (operator preference: maintainability over throughput; blast radius is already bounded by concurrency=1 + daily-cap + identical QA + CI).

## Invariants

The sibling slices (#3687–#3690) build against these. Every term/decision above must match those already-approved sibling concepts verbatim in intent — no drift.

1. **ADR-0032 is the governing record** — #3687/#3688/#3689/#3690 cite it for the drainer's terminology and invariants; the terms defined here are the single source of truth.
2. **Single-brain preserved** — the Opus/Fable autopilot is the sole brain; `design_concept_orch` designs every `glm-eligible` issue; GLM never self-selects or self-QAs; the identical `qa_orch` + CI is the merge gate. No second control loop.
3. **Permanent, named scope fence** — `dev_orch` at T2/T3 only, excluding the Verifier Core and all T4, and excluding all money-critical `dev_target`. A standing fence, not a beachhead limit.
4. **Precise mechanism** — a separate `claude` process via `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` + `ANTHROPIC_AUTH_TOKEN` (not `ANTHROPIC_API_KEY`, not the Codex plugin), GLM-4.7 on the Sonnet slot, env from a systemd `EnvironmentFile` (never `.env.local`).
5. **Concurrency exactly 1 via flock** — kernel auto-release, zero orphan risk; never a Redis enforcement lock. Redis appears only as a non-enforcing heartbeat key.
6. **Kill-switch honors only operator `paused`** — deliberately ignores Anthropic `emergencyStop` / `paceState` / `weeklyEmergencyStop` (the inversion-avoidance decision: GLM runs on z.ai's independent quota).
7. **Fail-closed credentials** — `ANTHROPIC_AUTH_TOKEN` has no default (absent token = abort, no live run); the token value never appears in a log, arg, or PR body; it reaches the process only via an off-git `EnvironmentFile` — never committed, never `ANTHROPIC_API_KEY`.
8. **Two-layer secret fence** — an input-side `permissions.deny` on `.env*` / credential paths (keeps secrets out of z.ai's context) AND an output-side `scripts/ci/secret-scan.sh` diff preflight that aborts before `gh pr create`; a Verifier-Core/T4 diff preflight likewise aborts before PR — so the drainer can never author a fenced-out change.
9. **Provenance by label, not branch name** — `glm-authored` marks drainer PRs (they share the `worktree-agent-*` prefix with Opus `dev_orch` PRs); `glm-eligible` is the issue-side eligibility label. The two label spaces are distinct (`glm-eligible` ↔ issues/`ready-for-agent`, `glm-authored` ↔ PRs/`active_dev_orch`).
10. **z.ai training-interest ambiguity is an accepted risk** — bounded by the money-critical + secrets fence (secrets never read; money-critical never on GLM; the public repo makes `src` exposure a non-issue). Flagged, not a blocker.
11. **Docs-only, additive T3** — a single new `docs/adr/0032-*.md` following the ADR template, touching no Verifier-Core path and no code interface; `npm test` and `tsc` pass (the #3686 acceptance criterion).

## Rejected alternatives

- **A parallel GLM brain / second autopilot session** — rejected (ADR-0012 single-brain). A second brain would create two control planes with no shared source of truth — the exact structural flaw ADR-0012 eliminated. GLM is a fenced authoring-only worker.
- **Delegate to GLM via the Codex plugin (delegate-as-tool)** — rejected (map #3663 out-of-scope). The Codex plugin path cannot apply the `ANTHROPIC_BASE_URL` override, so Opus keeps burning Anthropic quota; it defeats the quota-relief purpose. A separate base-URL-overridden `claude` process is the only mechanism that shifts authoring load onto z.ai.
- **Move money-critical `dev_target` work onto GLM** — rejected. A permanent data + quality fence, not a beachhead-only limit: money-critical paths carry outsized real-world consequence and z.ai offers no training opt-out, so money-critical `dev_target` is permanently off-GLM.
- **Enforce concurrency with a Redis lock (`hydra:glm:drainer:lock`)** — rejected (#3667). A Redis lock has no kernel auto-release, so a crashed drainer orphans it (the `hydra:cycle:active:claude` pain class that already required manual `DEL`). flock is kernel-released on process death = zero orphan risk. Redis appears only as a non-enforcing heartbeat key.
- **Honor Anthropic `emergencyStop` / `paceState` / `weeklyEmergencyStop` in the kill-switch** — rejected (#3670). Those arms pause on Anthropic quota exhaustion, but the drainer's purpose is to author *when* Anthropic is tapped, on z.ai's independent quota. Mirroring them would make the drainer sleep exactly when it is most needed. Only the operator `paused` flag (orthogonal to quota) is honored.
- **An auto-flip circuit-breaker that disables the drainer on a churn / PASS-rate threshold** — rejected (#3671). Keep-or-kill is an operator judgment surfaced in `hydra-review`, not an auto-flip (operator preference: maintainability over throughput). Blast radius is already bounded by concurrency=1 + daily-cap + identical QA + CI; an auto-breaker would add the second control loop the design explicitly avoids.
- **Carry GLM provenance via a branch-name prefix instead of the `glm-authored` label** — rejected (#3666). The drainer runs in a git worktree, so its PR head branch shares the `worktree-agent-*` prefix that Opus `dev_orch` PRs also use; a branch-name carve-out cannot discriminate. The `glm-authored` label is the single robust provenance marker.
- **Use `ANTHROPIC_API_KEY` for the z.ai token, or inject the endpoint via `.env.local`** — rejected (#3664 / #3688). z.ai's Anthropic-compatible endpoint authenticates via `ANTHROPIC_AUTH_TOKEN` (not `_API_KEY`), and `.env.local` reproduces the paper-LLM MODEL-override gotcha where a dotenv silently overrode `ExecStart` flags. Env flows only from an off-git systemd `EnvironmentFile`.
- **Sub-dispatch the `prototype` skill to model any of the decisions** — rejected. There is no hard-logic ambiguity to resolve with throwaway code. ADR-0032 is a pure design-of-record transcribing six already-locked map decisions (#3666–#3671) whose executable shape is fully specified by the four already-approved sibling concepts. A prototype would add nothing to a documentation artifact.

## Consequences

**Gains.** The shallow, pre-designed `dev_orch` backlog drains on z.ai's independent quota, freeing Anthropic subscription quota for the brain's decisional work and unblocking the backlog when Anthropic is tapped — without introducing a second brain, a second control loop, or any change to the design or merge gates.

**Accepted risk.** The z.ai training-legitimate-interest ambiguity — no self-serve training opt-out exists — is **accepted**, bounded by the money-critical + secrets fence: secrets are never read (two-layer fence, invariant 8), money-critical `dev_target` is never on GLM (Decision 3), and the repo is already public (#698) so `src` exposure is a non-issue. This is flagged in the design of record, not a blocker.

**Out of scope.** This ADR records decisions; it builds nothing. The drainer machinery — the `glm-eligible` / `glm-authored` labels + `collect-state.sh` partitioning (#3687), the spawn wrapper + `secret-scan.sh` (#3688), the systemd drainer loop (#3689), and the beachhead report (#3690) — is delivered by the sibling slices this ADR governs. The Orchestrator's Opus autopilot loop, the design stage, and the QA + CI merge gate are unchanged.
