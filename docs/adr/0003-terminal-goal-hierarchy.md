# Target outcomes are terminal; 25% capacity floor for orchestrator self-improvement

The orchestrator's terminal goal is to move the **Target Outcomes** (declared in `config/direction/outcomes.yaml`). Improving the orchestrator's own architecture is instrumental — justified primarily when it compounds into better target outcomes.

**Exception:** 25% of orchestrator capacity is reserved for self-improvement regardless of target state. Without this floor, target work always crowds out builder investment ("important but not urgent"), and the orchestrator's capacity to ship anything degrades silently over time. 25% rather than a smaller number because under-investment in the builder is the most expensive mistake to discover late.

Autopilot enforces the split. When **Stuckness** fires (no target outcome has moved favorably for N cycles), autopilot's next action must be operator escalation, an orchestrator self-modification, or a research cycle into *why* outcomes aren't moving — never another dev cycle on the next backlog item.

## Considered options

Pure "target outcomes are everything" was considered and rejected: it produces a system that never improves itself because target work always looks more urgent. Pure "compounding capability is terminal" was considered and rejected: it disconnects the orchestrator from the only feedback signal that proves it's working (the target succeeding).
