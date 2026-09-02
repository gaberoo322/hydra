# ADR-0013: Hydra is a swappable single-target builder; generality lives in the swap

Status: Accepted (Decision 2 amended 2026-09-02 — hydra-betting retired as the crucible, Claw Street Bets adopted as crucible #2; see the **CSB amendment** at the end)
Date: 2026-05-29
Deciders: Operator + Hydra (via a comparative analysis against OpenHarness, deepagents, and oh-my-openagent)
Related: ADR-0001, ADR-0002, ADR-0003, ADR-0005, ADR-0026; CSB founding map #4313 (decision record #4314, amendment ticket #4315, betting mothball #4325)

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

2. **The crucible is not the ceiling.** *(Amended 2026-09-02 — the crucible named here changed; the criterion did not. See the CSB amendment below.)* ~~The current Target (hydra-betting) is chosen~~ A Target is chosen as the crucible because its success metric is external, adversarial, and unforgiving (real money in real markets). That is precisely what forces the "outcomes over green cycles" discipline that keeps the whole design honest. Winning in the crucible *proves the builder works*; it is not the reason the builder exists. Crucible #1 was hydra-betting (2026-05 → 2026-09, retired). Crucible #2 is **Claw Street Bets** (`gaberoo322/claw-street-bets`), whose business metric is trading P&L.

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

- If crucible alpha becomes large and near-term, pressure toward pure (A) (hardcode whatever wins) will be real, and this ADR may be revisited then. But the fork is only ever **(A) pure-specialize vs (B) swappable** — both single-target. "Build any software" (session-general) is never the resolution. *(The first revisit happened 2026-09-02 for the opposite reason — the crucible was lost to a venue ban, not won — and resolved to (B) again; see the CSB amendment.)*

## Related

- **ADR-0001** Untouchable Core & gate extraction — unchanged; the gate/rollback/watchdog/cost core stays operator-only regardless of target.
- **ADR-0002** Single target per orchestrator instance — the mechanism this ADR names "swap-generality."
- **ADR-0003** Terminal-goal hierarchy — reconciled here across two levels; its 25% floor is re-justified, not changed.
- **ADR-0005** Operator escalation is narrow — vision-level conflicts (such as an (A)-vs-(B) revisit) remain operator decisions.
- **ADR-0026** Target Manifest — the per-target facts a swap needs live in the target repo's `.hydra/manifest.json`, which is why the CSB amendment below names only the swap identity and never the target's internals.

## Amendment — Claw Street Bets is the successor crucible (2026-09-02, issue #4315; decided in #4314 on map #4313)

**What changed in the world.** The operator is resident in Washington State, where Kalshi-style event contracts — hydra-betting's venue — are banned. That is a legality fact, not a performance judgement, and it has no revival path short of a fresh decision. hydra-betting also ran to its natural end without demonstrating an edge: 1,180 settled forecasts at Brier 0.2307 against the 0.25 coin-flip baseline, and the paper-LLM A/B (local model vs Sonnet) beat the market on neither arm. So crucible #1 never delivered the outcome that was supposed to prove the builder — the builder was proven on *throughput* (autonomous PR flow, hard-verified merges, self-improvement) but not on the crucible's own metric. Ordinary crypto and stock trading are unaffected by the WA ban.

**Decision 2, as amended.**

- **hydra-betting is retired as the crucible.** Full mothball, repo archived (not deleted), producer timers stopped, Redis snapshotted to `~/hydra-swap-backups/` — the mechanical steps are #4325. Every "betting" reference in this ADR's Context is now historical: the coupling leaks it lists were driven back through the seam (the `scripts/ci/target-coupling-check.ts` ratchet baseline reads "Target state: empty") and the manifest epic (ADR-0026) removed the last built-in target constants. The retired target is never a fallback: an orchestrator instance pointed at `~/claw-street-bets` has no reason to know hydra-betting existed.
- **Claw Street Bets (CSB) is crucible #2.** Autonomous intraday crypto trading — deterministic TA strategies on 5m–1h bars, paper-first, real money at thousands-scale gated behind a **pre-registered graduation bar** that is written into the target's `outcomes.yaml` before the first trade and is not editable by the system being measured. Swap identity: repo `gaberoo322/claw-street-bets`, `HYDRA_TARGET_NAME=claw-street-bets`, workspace `~/claw-street-bets`, manifest `appSubdir: ""` (app at repo root — betting's `web/` nesting caused a family of worktree/`node_modules` incidents, #4175/#4177). Everything else about CSB — venue, universe filter, fill model, strategy roster, graduation numbers, risk invariants — is the target's own business and lives in its vision, `outcomes.yaml`, `.hydra/manifest.json` and `CONTEXT.md`, per Decision 4 and ADR-0026. This ADR deliberately names none of it.
- **The crucible criterion is unchanged and now stated target-neutrally:** a crucible is a Target whose success metric is *external, adversarial, and unforgiving*. CSB qualifies on the same grounds betting did — real money against a live market — with one upgrade: its terminal outcome is a single **business metric**, real-money cumulative P&L net of fees (honestly zero until graduation), backed by leading paper metrics that include the paper-vs-backtest fill divergence betting never measured. "A business" here means the system trades the operator's own capital; there are no customers, and signals-as-a-service / SaaS / copy-trading are out of scope.

**What does NOT change — the fork stays (B).** A crucible that carries a business metric is *not* a step toward (A). The builder remains the durable asset; CSB is the second product it specialises into, and the point of doing it as a *swap* rather than a rewrite is to exercise the seam ADR-0002 and Decision 4 exist for. Concretely:

- ADR-0003's 25% self-improvement floor **survives**, with the same constitutive justification Decision 3 gave it: the floor is the standing investment in the asset. It does not shrink because the new target has a P&L.
- The tiebreaker in Consequences still governs: *does this deepen the swappable-builder asset, or chase session-generality?* Now with a corollary: *does this hardcode CSB where it should read the manifest?* A CSB literal in `src/` is exactly the Decision 4 defect a betting literal was.
- The swap is executed through `docs/target-swap-runbook.md` (ADR-0002) against the Target Manifest (ADR-0026). It is the first swap that exercises the seam for real rather than on the target that shaped it, so any hydra-betting assumption it surfaces — in `src/`, prompts, playbooks, or CI — is a defect to fix at the seam, not a reason to special-case CSB. Repo creation and the swap itself are the first act *after* map #4313 closes; this amendment records the decision, it does not perform the swap.

**Why an amendment and not a superseding ADR.** Decisions 1, 3 and 4 stand verbatim and are cited by number across `src/`, `scripts/ci/`, playbooks and later ADRs (0025, 0026, 0028, 0039). Per ADR-0037 Decision 2 the numbering is stable and a decision is amended in place; only Decision 2's *instance* (which Target is the crucible) changed, so the struck text stays legible above and the rationale lives here.
