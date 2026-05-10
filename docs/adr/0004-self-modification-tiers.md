# Self-modification tiers with outcome-holdback for the middle tier

Hydra's modifications to itself are bucketed into four tiers, distinguished by blast radius and merge policy.

- **Tier 0 — Untouchable Core** (operator-only, CI-blocked otherwise). Defined by ADR-0001.
- **Tier 1 — Auto-merge, no holdback.** Prompt-shaped changes whose blast radius is one agent invocation: `config/agents/`, `config/feedback/`. Status quo for the existing prompt-evolution path.
- **Tier 2 — Auto-merge with outcome holdback.** Skills (`.claude/skills/`), anchor selection weights, verification-rule *additions* (not removals), dashboard. PRs ship if CI green, but a watcher monitors **Target Outcomes** for 5 cycles post-merge. If outcomes regress vs pre-merge baseline, the merge is auto-reverted.
- **Tier 3 — Operator review.** Everything else in `src/` (non-core), new agent roles, new skills introducing new capabilities, tool-shape changes. Unbounded blast radius; Hydra proposes via PR, operator merges.

Tier 2 is the tier where Hydra learns from outcomes about its own changes — Tier 1 changes too often (signal-to-noise too low), Tier 3 the operator controls. A global kill switch (operator-toggled Redis flag) pauses Tier-2 auto-merge and forces everything to Tier 3 until cleared.

**Work order dependency:** Tier 2 requires functioning **Target Outcomes** + **Stuckness** instrumentation before it can fire. The build order is: outcomes.yaml + parser → stuckness detector → tier classifier + CI check → Tier 2 holdback/revert → kill switch.

## Considered options

Always-operator-merge for anything in `src/` was considered and rejected: it makes the orchestrator's self-improvement loop too slow to compound. Always-auto-merge if CI green was considered and rejected: CI passes prove the code runs, not that the change helped — and the (3) diagnostic-failure pain point exists precisely because green-CI changes can be silently bad.
