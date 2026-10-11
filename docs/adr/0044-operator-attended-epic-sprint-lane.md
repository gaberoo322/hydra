---
status: accepted
---

# ADR-0044: An operator-attended epic sprint may stand in for hydra-qa, but never for CI

The autopilot moves an epic through its slices one at a time, and each slice waits on several things in turn:

- class cooldowns and the pace gate;
- label pickup;
- a `hydra-grill` design concept;
- a dev dispatch, then a separate `hydra-qa` dispatch.

For an epic whose design is already settled in an accepted ADR, most of that wait adds nothing. On 2026-10-07 the operator ran epic #4928 (ADR-0043, six slices) in-session instead: sub-agents built slices in parallel worktrees, an independent read-only reviewer checked each PR, and the operator's standing authorisation was recorded as a `QA-Override:` line before arming auto-merge. Thirteen PRs merged in about 18 hours with every required check green.

Before that run, a `QA-Override:` was a per-PR operator choice made inside `/hydra-review`. ADR-0015 says no PR merges without the verification depth its tier requires. This ADR states when a session-level authorisation may stand in for per-PR QA, so that the lane (`/hydra-epic-sprint`) is a sanctioned path and not a gate bypass.

## Decision

### Decision 1 — The lane exists only for a designed epic with the operator attending

An epic sprint runs only when both of these hold:
- **The epic is designed:** an accepted ADR or approved design concept answers its design questions.
- **The operator is present:** they started the sprint and approved its plan in-session.

Without either, the work goes back to the normal path: `/hydra-wayfinder` or `/hydra-grill` for design, `hydra-autopilot` for unattended work.

### Decision 2 — The sprint authorisation replaces the separate hydra-qa dispatch, not the review

Every PR in the sprint gets an **independent** review: a read-only sub-agent separate from the agent that built the PR. The reviewer re-verifies the evidence against the code being replaced and returns a PASS or FAIL verdict.

- A FAIL is fixed before arming.
- A recorded QA FAIL at the PR's current head (guard reason `verdict-fail`) is never covered by the sprint authorisation. Overriding it stays a per-PR operator choice.
- On PASS, the session posts a `QA-Override:` line through `/hydra-review`'s recipe, which re-runs the QA merge guard and pins the merge to the PR's current head commit. The line's reason cites the sprint authorisation and the review evidence, so `npm run qa:catch-rate` counts it as `overridden`. The override stays auditable; it is never a silent merge.

### Decision 3 — CI, branch protection and the tier ladder are never skipped

The sprint never does any of the following:
- skips or admin-merges past a required check;
- force-pushes, rewrites published history, or pushes to master directly;
- works outside a worktree.

A T4 / Verifier Core PR leaves the lane for Deep-QA (ADR-0015, #740).

Each armed PR is registered for **Outcome Holdback** (`POST /api/holdback/pending`), exactly as the autopilot's `auto-merge` handler does. Sprint merges therefore get the same post-merge regression watch as autopilot merges.

When a required gate cannot pass for a reason the PR itself cannot fix, the PR is restructured. Example: `deep-qa-gate` hits the 300-file diff-API cap, so the bulk fixture changes are split into follow-up PRs. If restructuring isn't possible, the session stops and asks the operator.

### Decision 4 — Inside a sprint, changes to what decide.py reads ship as expand-then-contract PRs, behind a plan-parity corpus

This rule binds the sprint lane only. Within a sprint, a slice that changes what `decide.py` reads or decides is split into two PRs:
- **expand:** adds the new path while keeping the old one as a fallback;
- **contract:** deletes the old path.

Both PRs must reproduce an identical Plan for every distinct `decide()` input captured from the decide test suite. A planted mutation must show the corpus actually detects divergence.

## Consequences

- An attended, designed epic can merge at operator pace rather than autopilot pace. The gates that protect master stay exactly as they are.
- `npm run qa:catch-rate` will show sprint PRs as `overridden`, and that is correct. Reading the override reason tells a sprint override apart from a one-off `/hydra-review` override.
- The lane spends a lot of tokens on sub-agents: about 200–460k per build round and 150–200k per review in #4928. The skill shows the estimate before starting.
- Running slices in parallel creates reconcile work whenever slices share a new module. The skill's plan step lands shared modules first, or names a single owner for each.

## Alternatives considered

- **Keep dispatching hydra-qa for every sprint PR.** Rejected. It puts back the per-PR QA latency the lane exists to remove, and duplicates a review that is already independent.
- **Admin-merge when a required gate is structurally stuck.** Rejected. A gate the PR can't satisfy is a reason to restructure the PR, not to bypass branch protection (CLAUDE.md: "Never bypass the gate").
- **Make the sprint an autopilot class.** Rejected. Decision 2 depends on the operator being present; an unattended version would be self-approval.
