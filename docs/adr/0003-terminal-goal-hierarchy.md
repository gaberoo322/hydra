# Target outcomes are terminal; 25% capacity floor for orchestrator self-improvement

The orchestrator's terminal goal is to move the **Target Outcomes** (declared in `config/direction/outcomes.yaml`). Improving the orchestrator's own architecture is instrumental — justified primarily when it compounds into better target outcomes.

**Exception:** 25% of orchestrator capacity is reserved for self-improvement regardless of target state. Without this floor, target work always crowds out builder investment ("important but not urgent"), and the orchestrator's capacity to ship anything degrades silently over time. 25% rather than a smaller number because under-investment in the builder is the most expensive mistake to discover late.

## Enforcement

The 25% self-improvement share is **operator-curated** through `config/direction/priorities.md`. The operator (or `/hydra-target-research` running on the operator's behalf) keeps the priority list weighted so dispatch picks up orchestrator-self-improvement work at roughly the declared rate. The realised share is observable through `capacity-floor.ts` (orchestrator-vs-target cycles in a rolling window) and surfaces on the dashboard.

**Amendment (ADR-0010, 2026-05-23):** The original enforcement mechanism was an automated trip wire: when the **Stuckness** detector fired (no Target Outcome moved favorably for N cycles), autopilot pre-empted the next backlog pull with a research anchor. That mechanism was retired in ADR-0010 because the recorder that populated the outcome-history time series had no production caller post-ADR-0006 (the in-process control loop was gone) — the detector reported all-zero state regardless of actual outcome movement, so the floor never fired and the 25% share was already being enforced (or not) entirely through operator priority-setting. ADR-0010 makes the actual mechanism explicit: priorities, not stuckness.

## Considered options

Pure "target outcomes are everything" was considered and rejected: it produces a system that never improves itself because target work always looks more urgent. Pure "compounding capability is terminal" was considered and rejected: it disconnects the orchestrator from the only feedback signal that proves it's working (the target succeeding).

An automated stuckness-driven trip wire was the original mechanism (#242, #245). It was retired in ADR-0010 — see that ADR for why the in-process design didn't survive the autopilot cut-over.
