# ADR-0013: Hydra is a swappable single-target builder; generality lives in the swap

Status: Accepted
Date: 2026-05-29
Deciders: Operator + Hydra (via a comparative analysis against OpenHarness, deepagents, and oh-my-openagent)
Related: ADR-0001, ADR-0002, ADR-0003, ADR-0005

## Context

Hydra has carried two unreconciled self-conceptions:

- **(A) A betting system that happens to be built by AI.** Terminal goal = alpha; the orchestrator is infrastructure in service of one product.
- **(B) A reusable autonomous builder whose proof-of-life is winning at betting.** The durable asset is the *builder*; betting is the dogfood that proves it works.

The codebase and prior ADRs already lean (B) structurally — ADR-0002 commits to a single *swappable* target via `HYDRA_PROJECT_WORKSPACE` (and explicitly to "de-hardcoding the ~20 `hydra-betting` references in `src/`"), and the orchestrator vision lists "target-agnostic over target-specific" as a trade-off — while ADR-0003 states the terminal goal in (A) terms ("move the Target Outcomes"). Because the two levels were never named, ambiguous decisions had no tiebreaker, and the question "should Hydra become a general agent that builds anything?" had no documented answer.

A comparison against three contemporary agent frameworks sharpened the question:

- **OpenHarness** (an open-source Claude Code port), **deepagents** (LangChain's harness-construction library), and **oh-my-openagent** (a multi-model team layered on OpenCode) all occupy the **harness** layer — they make a *worker* more capable and compete on **session-generality** ("one agent builds arbitrary software in one run"). None has a standing control loop, hard-verification-as-merge-gate, self-improvement, domain modeling, or outcome direction. All are domain-agnostic by design.
- Hydra is **not** a harness. It is a control plane one layer above one — it runs *on* Claude Code, and OpenHarness is literally an open clone of the harness Hydra already sits on. Hydra's differentiators — single-target, domain-grounded, hard-verified, self-improving, outcome-directed — are only coherent if it stays **specialized per instance**. Chasing session-generality would force it to discard exactly those differentiators and become a weaker competitor to far better-resourced harness projects.

An audit of `src/` confirmed the architecture already reaches for (B) but does not defend it. The swap seam `src/target-config.ts` exists and most code routes the target through `getTargetWorkspace()` / `getTargetName()`. But there is no enforcement, and coupling has already leaked past the seam into load-bearing logic:

- `src/codebase-analyzer.ts` hardcodes betting-domain vocabulary in analysis logic (`d.includes("kalshi") || d.includes("polymarket")`, `hasKalshiRunner`, `bankroll || pnl`) — the orchestrator's own code-reader "knows" its target is a betting app and would mis-read any other product.
- `src/autopilot/pr-lifecycle-bridge.ts` hardcodes `gaberoo322/hydra-betting` in a default repo list.
- `src/api/health.ts` probes a hardcoded `bettingWeb` systemd service.

## Decision

**Hydra is a swappable single-target autonomous builder. The durable asset is the builder template — outcome-directed, hard-verified, domain-grounded, and self-improving. Generality lives in the *swap*, never in the *session*.**

1. **Two kinds of "general"; we choose one.**
   - *Session-general* — one run builds arbitrary software. This is the **harness layer's** game (deepagents et al.) and is explicitly **out of scope** for Hydra.
   - *Swap-general* — point the org at any one product-with-outcomes and it specializes into it. This **is** Hydra's generality, delivered by ADR-0002's single-swappable-target model.

2. **Betting is the crucible, not the ceiling.** The current Target (hydra-betting) is chosen because its success metric is external, adversarial, and unforgiving (real money in real markets). That is precisely what forces the "outcomes over green cycles" discipline that keeps the whole design honest. Winning at betting *proves the builder works*; it is not the reason the builder exists.

3. **This reconciles — it does not replace — ADR-0002 and ADR-0003.**
   - ADR-0002 (one target per instance) is the **mechanism** of swap-generality.
   - ADR-0003 (target outcomes terminal; 25% self-improvement floor) governs **this instance's** priority resolution and stands unchanged. Restated across the two levels: the *instance's* terminal goal remains "move the Target Outcomes"; the *project's* durable product is the swappable builder. The 25% floor's justification is upgraded from defensive ("the most expensive mistake to discover late") to constitutive: **the builder is the asset, and the floor is the standing investment in it.**

4. **Target-agnosticism becomes a defended invariant.** Hardcoding a target's name, repo, paths, or **domain vocabulary** anywhere in `src/` is a defect against the swap model, not a shortcut. Every target reference routes through `src/target-config.ts`; domain knowledge lives in config and the target's own docs, never in orchestrator logic. The leaks listed above are now defects to be driven back through the seam, and a coupling guardrail — a CI check kept out of the Untouchable Core as a separate workflow — is implied follow-up work.

## Consequences

**Positive**

- Ambiguous decisions get a tiebreaker: *does this deepen the swappable-builder asset, or chase session-generality?* The former wins.
- "Target-agnostic over target-specific" graduates from a soft trade-off to an enforceable invariant.
- The 25% self-improvement floor gains a reason to be **measured** (builder-health: autonomy rate, rework rate, time-to-merge, mutation-kill trend), not merely budgeted. Closing the "target-health is instrumented, builder-health is not" gap is itself orchestrator self-improvement work.

**Costs**

- The existing coupling leaks (`codebase-analyzer.ts`, `pr-lifecycle-bridge.ts`, `api/health.ts`) are reclassified from cosmetic to defects and incur cleanup.
- A standing tension is accepted: deep domain-grounding and target-agnosticism pull against each other. We pay it deliberately because the asset depends on both.

**Risks accepted**

- If betting alpha becomes large and near-term, pressure toward pure (A) (hardcode whatever wins) will be real, and this ADR may be revisited then. But the fork is only ever **(A) pure-specialize vs (B) swappable** — both single-target. "Build any software" (session-general) is never the resolution.

## Related

- **ADR-0001** Untouchable Core & gate extraction — unchanged; the gate/rollback/watchdog/cost core stays operator-only regardless of target.
- **ADR-0002** Single target per orchestrator instance — the mechanism this ADR names "swap-generality."
- **ADR-0003** Terminal-goal hierarchy — reconciled here across two levels; its 25% floor is re-justified, not changed.
- **ADR-0005** Operator escalation is narrow — vision-level conflicts (such as an (A)-vs-(B) revisit) remain operator decisions.
