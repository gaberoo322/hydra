# ADR-0031: Target task tracking migrates from Redis to GitHub Issues

Status: Accepted
Date: 2026-07-17
Deciders: Operator + Hydra (wayfinder map #3426, which locked the decision transcribed here)
Related: #3426 (wayfinder map — the decision + destination), #3427 (research — GitHub-Issues rate-limit viability for a machine-driven loop), #3428 (research — consequence-map of dropping the Redis scoring/dedup/suppression engine), #3429 (the MIGRATE keystone decision + accepted costs), #3432 (the spec this ADR governs), ADR-0002 (betting target is the swappable single-target crucible), ADR-0029 (autopilot charts and works wayfinder maps — the map machinery this used), #3059 (strict blocked-by/depends-on board filter the Target inherits), ADR-0004 / ADR-0015 (self-modification tiers)

## Context

The Orchestrator tracks its work as **GitHub Issues** on `gaberoo322/hydra`; the Target (`gaberoo322/hydra-betting`) tracks its work in **Redis** — kanban lanes (`hydra:backlog:*`) plus a scored, OpenViking-semantic-deduped candidate feed (`hydra:anchors:work-queue`) with a suppression cascade. This substrate split has three costs:

- The Target **cannot use the GitHub-native planning skills** (`hydra-wayfinder`, `hydra-prd`, `hydra-epic-close`, native sub-issues + blocked-by) that have measurably improved Orchestrator development — they are fundamentally GitHub-Issues machinery.
- Two tracking substrates violate DRY: the Redis backlog is a large body of Target-only code (lanes, atomic Lua transitions, scoring, suppression, semantic dedup, work-queue hygiene) maintained in parallel with the proven Orchestrator board model.
- The Target autopilot is **dependency-blind** — Redis anchor-selection ignores "blocked by / depends on", so chained work is hand-gated; the Orchestrator board already filters on it (#3059).

A prior grill (the **2026-06-06 SDLC-convergence decision**) set the principle *"converge on build-quality mechanisms, diverge on substrate"* and kept the Target on Redis **specifically for** its scored/ranked/semantic-dedup edge, noting Redis is also GitHub-rate-limit-free. This ADR reverses the **substrate** half of that decision. The mechanism-convergence half stands unchanged.

Wayfinder map #3426 charted the fog. Its three decision tickets closed to terminal verdicts, and this ADR is the design of record transcribing them. Two facts moved the reversal that the 2026-06-06 grill never weighed: (a) the operator chose to **drop the scoring engine regardless of substrate**, which removes the very advantage Redis was kept for; and (b) the Pocock-skill unlock is **GitHub-native and unobtainable on Redis** — plausibly why Orchestrator development outpaced the Target.

This is a docs-only ADR. The net-new machinery (the `scope`-parameterized board read, the `gh`-direct skill writes, the state-collector/dispatch-brain Target branches, the Redis-backlog retirement) is built by the tracer-bullet children of spec #3432, not here.

The migration classifies **T3** (#3385-style trace): it touches `src/` + `scripts/autopilot/` but not `tier-classifier.ts` / `ci.yml` / `untouchable.ts`, so it stays clear of the Verifier Core.

## Decision

The through-line: **the Target tracks work as GitHub Issues on `gaberoo322/hydra-betting`, orch-style label-driven, reusing the Orchestrator's own board machinery — one substrate, one model, no fork.**

### Decision 1 — Migrate the substrate to GitHub Issues (#3429, the keystone)

Target task tracking moves from Redis to GitHub Issues on the Target repo. "Stay on Redis" collapsed to a single honest objection (partial-DRY coupling) and the migrate case carried it: the rate-limit objection is answerable (Decision 6), Redis's decisive advantage was already surrendered (Decision 2), the Pocock unlock only exists on GitHub, and dependency-awareness is a net gain (Decision 5). The destination is a **spec** (#3432), not an in-place change.

### Decision 2 — Drop the scoring / semantic-dedup / suppression engine; go orch-style label-driven (locked premise)

Dispatch simplifies to the Orchestrator's model — pick a `ready-for-agent`, unblocked issue, ordered by priority — **regardless of substrate**. The Redis scored-ranking, OpenViking semantic dedup, and suppression cascade are retired. This is the premise that made the substrate question tractable: with Redis's ranking edge voluntarily given up, the choice reduces to "Pocock-unlock + DRY vs a shared rate-limit budget."

### Decision 3 — One seam: reuse `deriveBoardState`, repo-parameterized (#3432)

The Target board-state is computed by the Orchestrator's **existing, already-repo-parameterized** reader — `deriveBoardState( listOpenIssues({repo}), now, fetchOpenBlockerNumbers({githubRepo}) )` — reused **unchanged**. The board-state endpoint grows a `scope` (`orch` | `target`) parameter. `deriveBoardState` is the pure, already-tested bucketing/staleness/blocker-filter function that now serves both boards. No parallel Target board module is built — the ideal seam count is one, and this is it.

### Decision 4 — Writes via `gh` directly; retire the Target `/backlog` API (operator confirmed)

The Target skills (`hydra-target-build`, `-sweep`, `-discover`, `-research`, `-qa`, `-retro`, `-cleanup`, `-wire-or-retire`) write tracking state via `gh issue create` / `gh issue edit` / `gh api` on the Target repo, mirroring how Orchestrator skills already write — not through a Redis-backed HTTP API. The Target-only `/backlog` API and the `src/backlog` domain are retired. Board labels are the schema: mirror the Orchestrator board-label set and add the Target-specific labels that survive (`money-critical` — the 2-level flag; `reframe` — replaces the Redis reframe-queue; `wire-or-retire`), defined **once** in a single leaf module.

### Decision 5 — Suppression → close-discipline; dedup → lexical; dependency-awareness is a gain (#3428)

The scoring-drop's consequence-map identified three lost behaviors, all replaced under the label model:

- **Merged / shipped-subject suppression** (#882 / #3208) → **enforced `Closes #N` close-discipline** in Target `hydra-dev`, so a merged PR auto-closes its issue and leaves the open board for free. The positive-evidence merged-blob matchers (`merged-refs` / `token-algebra`, already repo-swap-aware) are retained as an **optional reconciler sweep**, not a hot-path gate.
- **OpenViking semantic dedup** → **lexical `gh issue list --search` + the existing discover/grill premise-check** at file time. This is the one capability with no equal-power fallback — a **consciously accepted downgrade**.
- **Dependency-blindness** → the Target **inherits the #3059 strict blocked-by / depends-on filter for free** — a net gain, not a gap.

### Decision 6 — Rate-limit viability and cutover (#3427)

The binding constraint is **pool choice, not request volume**. At the ~15-minute pace-gated cadence, doubling board reads is trivial against the REST pool's ~100× headroom; the risk is the GraphQL pool the running Orchestrator loop already saturates. Therefore a **hard constraint**: Target board reads on the hot path use **REST** (`gh api repos/...`), never `gh --json` / GraphQL, drawing from the separate, underused pool. Cutover is **drain-and-fresh**: Redis backlog items are transient work, not durable data, and the ~243 vestigial `hydra-betting` issue numbers are not migrated. Only currently-actionable items are filed, **throttled under 500 content-creations/hour**. The Redis backlog subsystem is deleted after the Target loop is verified running on the GitHub board, gated on a check that no Orchestrator-self path depends on it.

## Consequences

**Accepted costs (#3429).** (1) **Semantic → lexical dedup** — low practical risk (the premise-check already catches dups-of-shipped-work for the Orchestrator today) but a real downgrade on a self-filing system. (2) **Rate-limit coupling on a money-critical system** — both loops now share one token; the REST-first read constraint (Decision 6) keeps the money-critical Target loop off the Orchestrator's saturated GraphQL pool, and is a requirement, not an optimization.

**Gains.** The full GitHub-native planning-skill ecosystem becomes available to the Target; the two tracking substrates collapse to one proven model; the Target inherits native dependency-aware dispatch (#3059).

**Out of scope.** The Orchestrator's own tracking is unchanged. The substrate-agnostic SDLC-mechanism mirroring (independent QA / design-concept / retro) stands per the 2026-06-06 decision. Building Target *variants* of the planning skills (`hydra-target-wayfinder`, a Target `hydra-prd` / `hydra-epic-close`) is a follow-on epic that this migration unblocks but does not deliver.
