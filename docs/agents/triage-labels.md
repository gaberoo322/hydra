# Triage labels

Canonical label vocabulary for `gaberoo322/hydra` issues. The `/triage` skill, `hydra-sweep`, `hydra-dev`, and `hydra-qa` all rely on these exact label names.

## State labels

An open issue carries exactly one lifecycle state label. The state set, the transition table and the human-hold rule are data in `src/lifecycle/transitions.ts` (ADR-0047 Decision 2), not restated in prose here; `test/lifecycle-vocabulary-drift.test.mts` fails if this table drifts from `OPEN_STATES` / `HUMAN_HOLD_STATES`.

| Label | Meaning | Human-hold |
|---|---|---|
| `needs-triage` | New issue, not yet classified | no |
| `needs-info` | Operator must clarify before agents can pick up | yes |
| `needs-research` | Needs investigation before it can be scoped | no |
| `hitl-grill` | Agent-proposed idea parked for operator grill-or-dismiss; agents never action this | yes |
| `needs-tickets` | Resolved plan awaiting ticket breakdown | no |
| `ready-for-agent` | Fully specified, scoped, ready for autonomous work | no |
| `blocked` | Depends on another open issue (linked in body) | no |
| `in-progress` | Claimed by a subagent (`hydra-dev` or `hydra-target-build`) | no |
| `needs-dev-resume` | Open PR needs a dev fix-forward pass | no |
| `needs-qa` | PR open, awaiting `hydra-qa` verification | no |
| `qa-passed` | QA passed; awaiting merge | no |
| `ready-for-human` | Escalation on the ADR-0005 closed list; operator must decide | yes |
| `parked` | Off-list escalation or capped work, set aside | yes |

Human-hold rule: agents may enter a human-hold state, only the operator exits it.

## Flag labels

Any non-state label is a flag. The ones `ORCH_BOARD_LABELS` (`src/board-labels.ts`) names:

| Label | Meaning |
|---|---|
| `target-backlog` | Routing/exclusion marker for Target work; no sweep consumer, Target work is filed on the Target board |
| `glm-eligible` | Issue the GLM dev-drainer lane may author (ADR-0032) |
| `glm-withhold` | Sticky opt-out: the eligibility sweep must skip this issue |
| `glm-ab-control` | A/B control-arm marker assigned by the randomiser (ADR-0032, #4124) |
| `cleanup-scan` | Mechanical, self-checking dead-code removal (grill-exempt) |
| `needs-design-concept` | Forces a design-concept grill even on a T1-stamped issue |

Other flags in use outside that vocabulary: `wontfix` (closed without implementation), `operator-approved` (Tier-0 PR approval marker, ADR-0004, operator only), and the `enhancement` / `bug` / `refactor` classification labels.

## `ready-for-agent` precondition (issue #396)

Applying `ready-for-agent` enables autonomous subagent pickup. To prevent scope-creep failures from sneaking back in after the deletion of in-cycle `reconcilePlanVsActual()`, the label-validation workflow at `.github/workflows/issue-label-validation.yml` enforces:

- The issue body MUST contain a `## Files in scope` section.

If missing, the workflow:
1. Removes `ready-for-agent` and applies `needs-info`.
2. Posts a comment explaining the fix.

This is a soft enforcer — re-applying the label after editing the issue body is the recovery path. See `docs/agents/issue-tracker.md` for the full convention.

## Transitions

See `src/lifecycle/transitions.ts` (`TRANSITIONS`); the table is data, not prose (ADR-0047 D2).

## Escalation to `ready-for-human`

A subagent escalates to `ready-for-human` only for a reason on the `ADR5_REASONS` enum in `src/lifecycle/reasons.ts` (the closed list in ADR-0005: credentials or secrets, external-account actions, Tier-0 changes, vision-level conflicts). Off-list escalations go to `parked`.

Infrastructure aborts (worktree-isolation failures, harness errors) do NOT escalate to `ready-for-human` — they re-label as `ready-for-agent` so the next dispatch can retry once the infra recovers. See `docs/operator-playbooks/hydra-dev.md` Step 6 for the exact contract.

## `hitl-grill` (issue #4025)

`hitl-grill` is a **terminal park state** for agent-proposed ideas that no agent should ever action. An agent proposing a speculative idea (a possible improvement, a "we could also…" surfaced during another task) applies `hitl-grill` and stops — the idea sits parked until the operator either grills it into real work or dismisses it.

The Turn Snapshot (`src/autopilot/turn-snapshot/orch-board.ts`) excludes `hitl-grill` from the `untriaged_orphans` triage backstop (issue #2426) by exact-name match, the same mechanism as `ready-for-human` / `needs-info` / `needs-tickets` — NOT the `wayfinder:*` prefix rule, since `hitl-grill` is a single fixed label, not a family. Without the exclusion, an issue carrying only `hitl-grill` would pin `untriaged_orphans` above zero permanently and cause `sweep_orch` to re-triage the parked idea into an actionable lane every cooldown, draining the very inbox the label exists to hold. (`needs-design-concept` was removed from this exclusion set by #4096: it is only a parking lane when paired with `ready-for-agent`, and without that pairing the backstop is its sole recovery path.)

### Two boundaries — do not conflate

- **vs `ready-for-human`** — `ready-for-human` means an agent gave up and the operator must decide *now*; it is also an `INTERVENTION_LABELS` entry in `src/aggregators/autonomy-classifier.ts`, so parking an idea there would incorrectly degrade the autonomy metric. `hitl-grill` is not an escalation and must never be counted as an intervention.
- **vs the attention feed (#4007)** — *Superseded by ADR-0034 §8.1 (map #4416, 2026-09-22).* Individual parked ideas are still not feed rows (a speculative idea crosses no threshold), but the **lane as a whole** is feed bucket 5, "Parked ideas over cap": a single aggregate row once the lane holds `≥ HITL_GRILL_CAP` (10) items, showing the three oldest titles and handing off to `/hydra-hitl-grill`. The drain surfaces below are unchanged.

### Exit contract

Two operator surfaces drain the lane, and only these two: the Work page's HITL grill inbox (`/work`, backed by `GET /api/autopilot/hitl-grill`) and the standalone **`/hydra-hitl-grill`** skill (`docs/operator-playbooks/hydra-hitl-grill.md`), which classifies every parked item before asking and can dismiss a moot cluster in one question. Both write through the board routes so the label transitions below happen in one verified round-trip. `/hydra-review` does **not** touch the lane — a parked idea blocks no AFK work, so it is not an operator-attention item.

- **Promotion**: the operator grills the idea into real work. `POST /api/autopilot/board/promote` adds `ready-for-agent` and strips `hitl-grill` in the same write; it refuses a closed, already-ready, blocked, or unscoped issue. A promoted issue needs a `## Files in scope` section per the `ready-for-agent` precondition above — otherwise `issue-label-validation` reverts the label (so `/hydra-hitl-grill`'s "Scope and promote" verdict authors that section first).
- **Dismissal**: the operator closes the issue `not planned` (`POST /api/autopilot/board/close`). `hitl-grill` is retained on the closed issue as the producers' dedup baseline; it is not removed on dismissal.
