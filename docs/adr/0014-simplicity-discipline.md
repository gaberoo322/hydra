# ADR-0014: Simplicity is a measured discipline, not an aesthetic goal

Status: Accepted
Date: 2026-05-29
Deciders: Operator + Claude (session on "how to keep Hydra simpler without over-engineering")
Issue: TBD

## Context

The operator's recurring intuition is that Hydra "keeps getting more complex and unmaintainable," and wants a strategy to keep improving it without over-engineering — capturing complexity in deep modules so it doesn't spread.

A structural look at the codebase contradicts the surface feeling in an important way:

- ~37.6k lines across 171 `src` files, 170 regression tests. Small-to-medium. No god-module — the largest single file is `src/pattern-memory/agent-memory.ts` (~1.3k lines); the largest subsystem (`src/api/`) is ~5k.
- The recent commit history is dominated by **deletion**: "strip dollar machinery", "delete dead research-decision plane", "retire hydra-openai-proxy", "delete vestigial cycle subsystem", "consolidate watchdogs". Hydra is in an aggressive *pruning* phase, not an accretion phase.

So the complexity the operator feels is mostly **not** LOC growth. It is two other things:

1. **Churn cost.** Constant restructuring (multi-PR `PR-N/4` batches, `loop.ts → heartbeat.ts` renames, chores relocated between modules) taxes the human and agent mental model. Nothing sits still long enough to become familiar, which *feels* like rising complexity even when it is net-reducing.
2. **Conceptual residue.** Always-loaded docs (`CLAUDE.md`) and a growing ADR set accreted gravestones — "Specs retired", "Codex removed", "in-process loop deleted". The code was gone but the cognitive load wasn't.

Hydra is also a **self-modifying** system: its own subagents read this codebase to extend it. So complexity has two costs — human maintainability AND agent navigability. An overly complex module degrades the quality of autonomous output directly, which raises the stakes on simplicity relative to a normal codebase.

Treating "simplicity" as a standalone goal is itself an over-engineering trap: it is unfalsifiable, and chasing it invites premature abstraction (a deep module built before the complexity has revealed its shape is just a wrong abstraction with a nice interface) and refactor-for-its-own-sake churn.

## Decision

**Optimize for low change-cost, measured — not for "simple," felt.** Complexity that is *essential* (the autonomous control problem is genuinely hard) is allowed to be deep; the target is *accidental* complexity from churn, conceptual residue, and subsystems that never earned their keep. Five operating rules:

### R1 — Trigger simplification from friction signals, not aesthetics

Refactor where the operator or agents *repeatedly stumble*, evidenced by the friction instrumentation that already exists (`hydra:friction:{skill}:patterns`, promoted lessons, `meta-friction` issues, **Reflections**). Never refactor because code "feels" heavy. This makes simplification work falsifiable and self-prioritizing, and stops cleanup of things that aren't actually hurting.

### R2 — "Deep module" means the interface fits in an agent's working context

A module is deep enough when a subagent can use it **correctly by reading only its public seam** — the `src/redis/<domain>.ts` accessor, the `src/schemas/<domain>.ts` type, the glossary entry in `CONTEXT.md` — without loading the implementation. Hydra already has this pattern (Redis Adapters, Schemas, Cost; thin `src/api.ts` mount point). The unifying strategy is to make every subsystem conform to that one shape: complexity behind a narrow typed Seam doesn't spread, *and* it makes the agents better.

### R3 — Prune docs like code

The conceptual surface is part of the codebase. Always-loaded docs (`CLAUDE.md`) describe **what exists**, not what died — retired-subsystem narration moves to `docs/historical/`, and domain detail pushes down to `CONTEXT-MAP.md` / co-located `src/<domain>/CONTEXT.md` / `docs/reference.md` (see PR #733, the first application of this rule). Co-located `CONTEXT.md` files grow lazily via `/grill-with-docs` — never pre-create empty stubs.

### R4 — Budget the churn

Every rename / move / restructure is a tax on everyone's mental model. Hold each to: *does this reduce future change-cost more than it costs to land + for everyone to re-learn?* Prefer demand-driven cleanup (you touched the area for a real reason, so you tidy what you touched) over speculative whole-subsystem restructures.

### R5 — Higher bar for *new* subsystems than for refactoring existing ones

The historical record (Specs, Codex, the in-process loop — all built, then deleted) shows the dominant complexity source is subsystems that didn't earn their keep, not messy existing code. Before adding a new seam/module/subsystem, justify why an existing deep module can't absorb it. The cheapest complexity to remove is the kind never added.

## Consequences

### Positive

- Simplification becomes answerable ("is friction down where we cut?") instead of a vibe, so effort targets real pain.
- The deep-module/Seam discipline that already protects Redis and HTTP boundaries becomes the explicit, repo-wide default — improving both maintainability and autonomous-output quality.
- Doc bloat and the gravestone problem have a standing rule and a destination (`docs/historical/`, `CONTEXT-MAP.md`), resisting re-inflation.
- R4/R5 brake the churn and new-subsystem accretion that produced the "feels more complex" sensation in the first place.

### Negative / accepted

- These are heuristics, not CI gates — they rely on reviewers (human and agent) actually applying them. Enforcement is cultural, with R3 partly mechanizable later (e.g. a `CLAUDE.md` line-count ceiling check).
- R1 can under-serve genuine pre-emptive cleanup of code that is bad but not yet causing logged friction. Accepted: the bigger risk is over-refactoring, and friction signals catch real pain fast enough.
- R5 can slow legitimately-new capabilities that genuinely warrant their own seam. Accepted: the bar is "justify it," not "forbid it."

## Alternatives considered

- **A complexity metric / CI gate (cyclomatic, file-size caps, dependency-cycle checks).** Rejected as the primary mechanism: metric-chasing optimizes the metric, not change-cost, and invites Goodhart games (splitting a coherent deep module to dodge a line cap directly violates R2). A `CLAUDE.md`-size check is a plausible *future* narrow addition under R3, not the strategy.
- **A standing "simplicity" backlog / dedicated refactor sprints.** Rejected: manufactures churn (violates R4) and decouples cleanup from evidence of pain (violates R1).
- **Do nothing — trust the existing pruning cadence.** Rejected: the pruning is real but undirected, and is itself a churn source. Without R1/R4 the system oscillates between accretion and aggressive-but-unfocused deletion.
- **Aggressively split everything into micro-modules now.** Rejected as textbook over-engineering and a direct violation of R2 (a narrow interface over trivial guts is a shallow module — it adds surface without hiding complexity).

## Related

- ADR-0009 Redis seam typed accessors — the canonical deep-module Seam this ADR generalizes
- ADR-0011 Schemas seam for HTTP request bodies — sibling Seam at the external-input boundary
- ADR-0001 Untouchable Core & gate extraction — the load-bearing paths R5 protects most carefully
- ADR-0006 / ADR-0012 — the Codex and in-process-loop removals that motivate R5
- `CONTEXT-MAP.md` — the multi-context doc index that operationalizes R3
- PR #733 — first application of R3 (CLAUDE.md pruned 246 → 83 lines)
- Operator memory: `feedback_maintainability_over_throughput`, `feedback_lean_claude_md_context_map`
