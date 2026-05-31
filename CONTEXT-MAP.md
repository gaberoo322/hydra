# Context Map

Where the domain language lives. Read this to find the glossary entries and ADRs relevant to the area you're about to touch — then read those before naming concepts or editing code.

**Layout: multi-context.** The cross-cutting glossary is [`CONTEXT.md`](./CONTEXT.md) (system-wide terms + relationships). Per-domain `CONTEXT.md` files are created **lazily**, co-located with the code, as terms get resolved (via `/grill-with-docs`) — don't pre-create empty ones. Until a domain has its own file, its vocabulary lives in the relevant section of the root glossary, mapped below.

## Cross-cutting glossary

[`CONTEXT.md`](./CONTEXT.md) — read first regardless of domain. Defines: Orchestrator, Target, Target/Orchestrator Vision, Target Outcomes, Untouchable Core, Pre-merge Gate, Merge Lock, Post-merge Regression Check, Modification Tier, Outcome Holdback, Operator-Required Intervention, plus the deep-module Seams below.

## Domain map (code area → glossary terms → decisions)

| Code area | Glossary terms (in `CONTEXT.md`) | Co-located `CONTEXT.md` | Relevant ADRs |
|---|---|---|---|
| `src/redis/` | Redis Adapters | _lazy_ | ADR-0009 |
| `src/schemas/` | Schemas | _lazy_ | ADR-0011 |
| `src/cost/` | Cost, Subscription Usage Tracker, Quota Weight | _lazy_ | — |
| `src/autopilot/` | Autopilot Run, Autopilot Turn, Autopilot Focus | _lazy_ | ADR-0006, ADR-0007, ADR-0012 |
| `src/scheduler/` | Orchestrator Scheduler (Observability Heartbeat), Research Floor | _lazy_ | ADR-0012 |
| `src/pattern-memory/` | Pattern Memory | _lazy_ | — |
| `src/reflections/` | Reflections | _lazy_ | — |
| `src/knowledge-base/` | Knowledge Base | _lazy_ | — |
| `src/anchor-selection/` | Reframe Queue | _lazy_ | ADR-0010 |
| `src/design-concept.ts` | Design Concept | n/a | ADR-0008 |
| backlog / GitHub issues | Epic, Roadmap Milestone, Focus Label | n/a | ADR-0003 |
| self-modification | Modification Tier, Untouchable Core, Outcome Holdback | n/a | ADR-0001, ADR-0004, ADR-0005 |

The deep-module discipline is the load-bearing simplicity strategy here: each Seam (Redis Adapters, Schemas, Cost) hides its complexity behind a narrow typed interface so a subagent can use it correctly by reading only the glossary entry — not the implementation. Keep new subsystems to that shape.

## ADRs (system-wide)

[`docs/adr/`](./docs/adr/). Read the ones the map flags for your area; flag contradictions explicitly rather than silently overriding (see [`docs/agents/domain.md`](./docs/agents/domain.md)).

## When a term is missing

If the concept you need isn't in any glossary, that's a signal: either you're inventing language the project doesn't use (reconsider), or there's a real gap — resolve it with `/grill-with-docs`, which writes the term into the right `CONTEXT.md` (co-located if the domain has one, else the root glossary).
