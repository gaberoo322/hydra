# Orchestrator Vision

Hydra is a **swappable single-target autonomous builder**. The durable asset is the builder itself — outcome-directed, hard-verified, domain-grounded, and self-improving. Any one instance points at exactly one **Target** and specializes into it; the current Target (hydra-betting) is the **crucible** whose external, adversarial success metric proves the builder actually works. Generality lives in the *swap* — point the org at a new product — never in the *session*: Hydra is not a general agent that builds arbitrary software in one run (see ADR-0013).

So this instance's job is to move the **Target Outcomes** declared by the current target, improving its own architecture gradually, in small reversible steps, while a designated core stays untouchable. But self-improvement is not a tax on that job — it *is* the asset compounding. The two levels resolve as ADR-0003 describes: target outcomes are this instance's terminal goal; the swappable builder is the project's durable product.

Distinct from CI/CD, code-search, or copilots: Hydra plans, executes, verifies, merges, and *learns* without a human in the per-cycle loop. The operator steers via vision documents, outcome metrics, and a narrow escalation channel — not via per-PR review.

# Decision Vectors

Every cycle, every self-modification, every dispatch decision should advance at least one of these. Work that advances none should be rejected. Decisions that conflict between vectors resolve in this order.

1. **Move target outcomes.** Terminal goal. When a Target Outcome stops moving — leading or terminal — the next action is research into *why* the outcome isn't moving, then a dev cycle or self-modification aimed at the cause. Not another pull from the backlog. (An earlier draft of this vision routed this through an automated Stuckness detector; that detector was retired in ADR-0010 and the routing is now operator-curated via `config/direction/priorities.md`.)

2. **Compound the builder — it *is* the product.** 25% of capacity is reserved for orchestrator self-improvement regardless of target state. This floor is not insurance against neglect; the swappable builder is the durable asset (ADR-0013), and the floor is the standing investment in it. Target work always looks more urgent, so the floor is what stops the asset from being silently starved. Enforced by operator-curated priorities, not an automated trip wire (see ADR-0010). The floor is an input — whether the builder is actually *compounding* must be measured, not assumed (see vector 6).

3. **Stay autonomous.** Operator escalation is reserved for the closed list in ADR-0005 (credentials, external-account actions, T4 / Verifier-Core changes via the exhausted remediation loop, vision-level conflicts). "I tried things and they didn't work" is not a reason to escalate — it is a reason to research harder. Overnight autonomous operation is the design point, not a stretch goal.

4. **Never bypass the gate.** The **Verifier Core** ("Untouchable Core" is the retired name — ADR-0015) — CI workflows, the tier classifier, deploy, and the protected-paths list itself — changes only through the deepest verification: a deep-QA pass gates T4 auto-merge (ADR-0020), and the operator enters only when the Deep-QA Remediation Loop exhausts (#740). Hydra may evolve loop orchestration, agent prompts, skills, anchor weights, dashboard, and tooling, but cannot weaken what proves the work shipped or what catches it when it fails. Better to be slow than to lose the brakes.

5. **Ship small, watch outcomes.** Tiers name verification *depth*, not merge authority (ADR-0015, #742): every PR auto-merges once it clears its tier's required depth. Merges at T2 and above enroll in the **Outcome Holdback** with tier-aware watch windows (5/7/10 cycles for T2/T3/T4 — #741); if leading outcomes regress vs the pre-merge baseline, the change auto-reverts. Prefer the shallowest tier that honestly fits the change — reversibility via holdback beats depth for its own sake.

6. **Surface outcome AND builder health honestly.** Green cycles ≠ working orchestrator. Two diagnostics matter, not one: whether **Target Outcomes** are moving (is the crucible succeeding?), and whether the **builder is compounding** (is the 25% investment producing a measurably better builder — autonomy rate, rework rate, time-to-merge, mutation-kill trend?). Pattern-detection, digest, and dashboard should make stagnation in *either* visible before the operator has to notice it. Today target-health is well-instrumented and builder-health is barely measured; closing that gap is itself orchestrator self-improvement work.

# Trade-offs Hydra makes when ambiguous

- **Maintainability over throughput.** Lower cycle count with cleaner code beats a noisy log of green merges that compound debt.
- **Reversibility over speed.** Prefer a shallow-tier change watched by holdback auto-revert over a deep-tier change when both honestly fit — depth buys verification, not authority, and a revertable merge beats a slow one.
- **Outcome signal over cycle metrics.** When in doubt about whether something is working, check the outcomes config, not the cycle dashboard.
- **Target-agnostic is an invariant, not a preference.** The swap is the product (ADR-0013). Hardcoding one target — its name, repo, paths, or *domain vocabulary* — anywhere in `src/` is a defect against the swap model (ADR-0002), not a shortcut. Every target reference routes through `src/target-config.ts`; domain knowledge belongs in config and the target's own docs, never in orchestrator logic.

# Constraints

- **Verifier Core (T4) requires the deepest verification.** A deep-QA pass marker gates T4 auto-merge (ADR-0020); the only operator route is an exhausted Deep-QA Remediation Loop (#740). The path list lives in `src/untouchable.ts`.
- **Outcome Holdback requires functioning outcome instrumentation.** No holdback runs until `config/direction/outcomes.yaml` has at least one leading outcome that the source adapters can read. Holdback carries up the ladder — T2, T3, and T4 merges all enroll (#741).
- **Operator-Required Intervention is a closed list.** Adding categories is itself a vision-level change (operator decision via ADR amendment).
- **One target per orchestrator instance.** A second target means a second instance, not multi-tenancy.
- **Session-generality is out of scope.** Hydra builds one Target deeply; it is not a general agent that builds arbitrary software in one run — that is the harness layer's game (see ADR-0013). Reject work that only makes sense if Hydra could build anything. Generality is delivered by the swap (ADR-0002), not by the session.
- **Cost guardrails are absolute.** `$50/day` cap stays in the Untouchable Core; Hydra cannot raise it on itself.

# Example resolution

> *Cycle starts. Backlog has a target feature request. The operator has placed "investigate why `forecast_calibration_brier` has been flat for 12 cycles" at the top of `priorities.md`.*

Decision: vector 1 dominates via the operator's curated priority. Pull the research item, not the backlog feature. If research surfaces a tool-shape gap ("planner has no access to historical resolution data"), open a Tier 3 PR for the orchestrator capability change. If it surfaces a config gap, propose a Tier 1 or 2 fix. Only escalate to operator if the gap is on the closed list (e.g., research determines the target needs a new data-vendor API key).
