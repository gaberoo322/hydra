# Triage labels

Canonical label vocabulary for `gaberoo322/hydra` issues. The `/triage` skill, `hydra-sweep`, `hydra-dev`, and `hydra-qa` all rely on these exact label names.

## Label vocabulary

| Label | Meaning | Who applies |
|---|---|---|
| `needs-triage` | New issue, not yet classified | Auto on issue open |
| `needs-info` | Operator must clarify before agents can pick up | Triage / label-validation workflow / subagents |
| `ready-for-agent` | Fully specified, scoped, ready for autonomous work | `/triage`, operator |
| `in-progress` | Claimed by a subagent (`hydra-dev` or `hydra-target-build`) | Subagent on pickup |
| `needs-qa` | PR open, awaiting `hydra-qa` verification | `hydra-dev` on PR open |
| `blocked` | Depends on another open issue (linked in body) | Triage |
| `ready-for-human` | Subagent gave up after retries; operator must decide | Subagent on terminal failure |
| `wontfix` | Closed without implementation | Operator |
| `target-backlog` | Finding about `~/hydra-betting`, not the orchestrator itself | Triage; `hydra-sweep` queues these to the target work queue |
| `operator-approved` | Tier-0 PR approval marker (see ADR-0004) | Operator only |
| `enhancement` / `bug` / `refactor` | Classification | Triage |
| `hitl-grill` | Agent-proposed idea parked for operator grill-or-dismiss; agents never action this | Agent proposing the idea |

## `ready-for-agent` precondition (issue #396)

Applying `ready-for-agent` enables autonomous subagent pickup. To prevent scope-creep failures from sneaking back in after the deletion of in-cycle `reconcilePlanVsActual()`, the label-validation workflow at `.github/workflows/issue-label-validation.yml` enforces:

- The issue body MUST contain a `## Files in scope` section.

If missing, the workflow:
1. Removes `ready-for-agent` and applies `needs-info`.
2. Posts a comment explaining the fix.

This is a soft enforcer — re-applying the label after editing the issue body is the recovery path. See `docs/agents/issue-tracker.md` for the full convention.

## Transitions (typical happy path)

```
needs-triage → ready-for-agent → in-progress → needs-qa → (close)
                     ↓                              ↓
                blocked / needs-info        ready-for-human
```

## Transitions for `target-backlog`

`target-backlog` issues describe findings about the target project (`~/hydra-betting`), not the orchestrator. `hydra-sweep` and `hydra-target-sweep` consume them differently:

1. `hydra-sweep` reads `target-backlog`-labelled issues and POSTs them to `/api/queue` so the target-side build loop can pick them up.
2. Once queued, the orchestrator-side issue is closed with a comment linking to the queue ID.

The issue body should still describe the finding clearly, but the `Files in scope` precondition does not apply — the target work queue has its own scoping mechanism.

## Auto-promotion to `ready-for-human`

A subagent escalates to `ready-for-human` only for the **closed list** in ADR-0005:
- Credentials or secrets
- External-account actions
- Tier-0 changes (untouchable core)
- Vision-level conflicts

Infrastructure aborts (worktree-isolation failures, harness errors) do NOT escalate to `ready-for-human` — they re-label as `ready-for-agent` so the next dispatch can retry once the infra recovers. See `docs/operator-playbooks/hydra-dev.md` Step 6 for the exact contract.

## `hitl-grill` (issue #4025)

`hitl-grill` is a **terminal park state** for agent-proposed ideas that no agent should ever action. An agent proposing a speculative idea (a possible improvement, a "we could also…" surfaced during another task) applies `hitl-grill` and stops — the idea sits parked until the operator either grills it into real work or dismisses it.

`scripts/autopilot/collect-state.sh` excludes `hitl-grill` from the `untriaged_orphans` triage backstop (issue #2426) by exact-name match, the same mechanism as `ready-for-human` / `needs-info` / `needs-design-concept` / `needs-tickets` — NOT the `wayfinder:*` prefix rule, since `hitl-grill` is a single fixed label, not a family. Without the exclusion, an issue carrying only `hitl-grill` would pin `untriaged_orphans` above zero permanently and cause `sweep_orch` to re-triage the parked idea into an actionable lane every cooldown, draining the very inbox the label exists to hold.

### Two boundaries — do not conflate

- **vs `ready-for-human`** — `ready-for-human` means an agent gave up and the operator must decide *now*; it is also an `INTERVENTION_LABEL` in `src/aggregators/autonomy-classifier.ts`, so parking an idea there would incorrectly degrade the autonomy metric. `hitl-grill` is not an escalation and must never be counted as an intervention.
- **vs the attention feed (#4007)** — ADR-0034 scopes the attention feed to threshold crossings that render their own line item. A speculative idea crosses no threshold. `hitl-grill` and the attention feed are separate surfaces; do not fold them together.

### Exit contract

- **Promotion**: the operator grills the idea into real work. Remove `hitl-grill` and add the appropriate lifecycle label (typically `ready-for-agent`). A promoted issue also needs a `## Files in scope` section per the `ready-for-agent` precondition above — otherwise `issue-label-validation` reverts the label.
- **Dismissal**: the operator closes the issue `not_planned`. `hitl-grill` is retained on the closed issue as a record of why it was parked; it is not removed on dismissal.
