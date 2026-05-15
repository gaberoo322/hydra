# Hydra Orchestrator

## Language

**Orchestrator**:
The codebase that runs the control loop, manages agents, and holds state. Distinct from the products it builds.
_Avoid_: Hydra (ambiguous — could mean orchestrator or the whole system), "the system"

**Target**:
The software product the orchestrator is currently building.
_Avoid_: project, app, product (each ambiguous in this codebase)

**Target Vision**:
The prose document declaring what the target product is for and how it wins.
_Avoid_: vision (unqualified)

**Orchestrator Vision**:
The prose document declaring what good autonomous building looks like and the trade-offs the orchestrator makes when ambiguous. Separate from target vision.
_Avoid_: vision (unqualified)

**Target Outcomes**:
The structured config declaring the named metrics the orchestrator optimizes the target against. The contract between target vision prose and orchestrator behavior — if these metrics aren't moving, the prose is fiction.
_Avoid_: metrics, KPIs, success criteria

**Untouchable Core**:
The set of orchestrator files Hydra cannot modify via its own PR pipeline — only the operator can. Protects the merge gate, rollback, watchdog, cost guardrails, and the untouchable list itself.
_Avoid_: protected paths (unless referring specifically to the file pattern), frozen code

**Gate**:
The frozen module owning the merge gate: grounding, verification, scope enforcement, mutation kill-rate, merge lock, rollback. Called from the control loop; cannot be bypassed.
_Avoid_: verification (too narrow)

**Stuckness**:
The orchestrator's diagnostic for silent failure: cycles elapsed since any **Target Outcome** moved favorably and stayed moved. Distinct from cycle failure — green cycles can be stuck.
_Avoid_: blocked (already means something else in the issue tracker), stalled

**Modification Tier**:
The blast-radius classification of a self-modification (Tier 0 Untouchable / 1 auto-merge / 2 auto-merge with outcome holdback / 3 operator review). Determines who merges the PR and whether outcome regression triggers auto-revert. Defined by ADR-0004.
_Avoid_: risk level, severity

**Outcome Holdback**:
The post-merge watch window where a Tier-2 change is monitored against **Target Outcomes**. Regression vs pre-merge baseline triggers auto-revert. Uses leading outcomes only — terminal outcomes are too slow for the watch window.
_Avoid_: canary, soak (overloaded with deploy meanings)

**Design Concept**:
A structured, persisted artifact produced before any code-writing dispatch. Records the agent's understanding of an anchor against the orchestrator's canonical vocabulary: which modules it intends to touch, which invariants it intends to preserve, the Q&A trace that produced that understanding, and any prototype snippets that encoded thorny decisions. The artifact is the ground truth for both dispatch gating and PR-time review. Defined by ADR-0007 (see epic #437).
_Avoid_: design doc (overloaded), plan (informal), spec (overloaded with the multi-task decomposition artifact)

**Operator-Required Intervention**:
The closed list of categories where Hydra escalates to the operator instead of attempting autonomous remedy: credentials/secrets, external-account actions, Tier 0 changes, vision-level conflicts. Everything else Hydra researches and tries. Defined by ADR-0005.
_Avoid_: blocker (overloaded), needs-human (informal)

## Relationships

- An **Orchestrator** builds one **Target** at a time; running a second target means a second orchestrator instance, not multi-tenant inside one
- A **Target** has one **Target Vision** (prose) and one **Target Outcomes** (config)
- The **Orchestrator** has its own **Orchestrator Vision**
- The **Gate** is the only path to merge; **Untouchable Core** includes the **Gate**
- **Stuckness** is computed from **Target Outcomes**, not from cycle status
- A **Design Concept** is the prerequisite for any code-writing dispatch; PR-time review consumes it as ground truth

## Example dialogue

> **Operator:** "Hydra is stuck."
> **Maintainer:** "Stuck how? Cycles are green."
> **Operator:** "Right — green but no **Target Outcomes** moving for 30 cycles. The dashboard is lying."
> **Maintainer:** "OK, so stuckness fired. Autopilot should now either escalate to me, propose an **Orchestrator** self-modification, or research *why* outcomes aren't moving — not pick up the next backlog item."
