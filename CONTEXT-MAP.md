# Context Map

Where the domain language lives. Read this to find the glossary entries and ADRs relevant to the area you're about to touch — then read those before naming concepts or editing code.

**Layout: multi-context.** The cross-cutting glossary is [`CONTEXT.md`](./CONTEXT.md) (system-wide terms + relationships). Per-domain `CONTEXT.md` files are created **lazily**, co-located with the code, as terms get resolved (via `/grill-with-docs`) — don't pre-create empty ones. Until a domain has its own file, its vocabulary lives in the relevant section of the root glossary, mapped below.

## Cross-cutting glossary

[`CONTEXT.md`](./CONTEXT.md) — read first regardless of domain. Defines: Orchestrator, Target, Target/Orchestrator Vision, Target Outcomes, Untouchable Core, Pre-merge Gate, Merge Lock, Post-merge Regression Check, Modification Tier, Outcome Holdback, Operator-Required Intervention, plus the deep-module Seams below.

## Domain map (code area → glossary terms → decisions)

| Code area | Glossary terms (in `CONTEXT.md`) | Co-located `CONTEXT.md` | Relevant ADRs |
|---|---|---|---|
| `src/host-probe/` | Host-Probe Adapter | _lazy_ | — |
| `src/redis/` | Redis Adapters | _lazy_ | ADR-0009, ADR-0017 |
| `src/schemas/` | Schemas | _lazy_ | ADR-0011, ADR-0022 |
| `src/cost/` | Cost, Subscription Usage Tracker, Quota Weight | _lazy_ | ADR-0021 |
| `src/autopilot/` | Autopilot Run, Autopilot Turn, Autopilot Focus | [`src/autopilot/CONTEXT.md`](./src/autopilot/CONTEXT.md) | ADR-0006, ADR-0007, ADR-0012, ADR-0016 |
| `src/taxonomy/` | Dispatch-Class Taxonomy | _lazy_ | ADR-0012, ADR-0030 |
| `src/scheduler/` | Orchestrator Scheduler (Observability Heartbeat), Housekeeping, Research Floor | _lazy_ | ADR-0012 |
| `src/pattern-memory/` | Pattern Memory | _lazy_ | — |
| `src/reflections/` | Reflections | _lazy_ | ADR-0023 |
| `src/metrics/`, `src/aggregators/` | Cost, Quota Weight | _lazy_ | ADR-0016, ADR-0028, ADR-0039 |
| `src/api/`, `src/api.ts` | — (see `src/api/ENDPOINT-REGISTRY.md`) | n/a | ADR-0011, ADR-0022, ADR-0024 |
| `src/logger.ts` | — | n/a | ADR-0027 |
| `src/target-config.ts` | Target Manifest | n/a | ADR-0002, ADR-0026 |
| ~~`src/knowledge-base/`~~ | ~~Knowledge Base, OpenViking Request Adapter~~ — **RETIRED**, directory deleted | n/a | ADR-0033 |
| ~~`src/anchor-selection/`~~ | ~~Reframe Queue~~ — **RETIRED**, directory deleted; Candidate Feed is the live concept | n/a | ADR-0010, ADR-0036 |
| `src/design-concept.ts`, `src/redis/design-concept.ts` | Design Concept | n/a | ADR-0008, ADR-0018 |
| backlog / GitHub issues | Epic, Roadmap Milestone, Focus Label | n/a | ADR-0003, ADR-0031 |
| self-modification | Modification Tier, Verifier Core, Outcome Holdback | n/a | ADR-0001, ADR-0004, ADR-0005, ADR-0015, ADR-0019, ADR-0020 |

### Non-`src/` areas

ADRs also govern skills, CI, and scripts. These have no `src/` directory to hang off, so they
get their own rows:

| Area | Relevant ADRs |
|---|---|
| `.claude/skills/` + `docs/operator-playbooks/` | ADR-0025, ADR-0029, ADR-0030, ADR-0031, ADR-0035 |
| `.github/workflows/` (Verifier Core) | ADR-0015, ADR-0019, ADR-0020 |
| `scripts/autopilot/` (`decide.py`, `classes.json`) | ADR-0007, ADR-0012, ADR-0029, ADR-0032 |
| `dashboard/` | ADR-0034 |
| `config/direction/`, `config/orchestrator/` | ADR-0003, ADR-0005 |
| `docs/adr/` itself | ADR-0037 |
| `test/`, `scripts/test/` (the suite itself) | ADR-0038 |
| **process / policy** (no code area) | ADR-0002, ADR-0013, ADR-0014, ADR-0024 |

The deep-module discipline is the load-bearing simplicity strategy here: each Seam (Redis Adapters, Schemas, Cost) hides its complexity behind a narrow typed interface so a subagent can use it correctly by reading only the glossary entry — not the implementation. Keep new subsystems to that shape.

## ADRs (system-wide)

[`docs/adr/README.md`](./docs/adr/README.md) is the **complete roster** — every ADR with its
status, its decision in one sentence, and the trigger for reading it. It is ~6 KB; read it in
full, then open only what you need. The tables above are the code-area shortcut into it.

Read the ones the map flags for your area; flag contradictions explicitly rather than silently
overriding (see [`docs/agents/domain.md`](./docs/agents/domain.md)).

**Before writing a new ADR**, read [ADR-0037](./docs/adr/0037-hydra-adrs-are-agent-facing-normative-specs.md):
Hydra ADRs are agent-facing normative specs, so the upstream one-paragraph size target does not
apply — but the three-part write gate does, `Status` is mandatory, and a new row in the roster is
enforced by `test/adr-roster.test.mts`.

## When a term is missing

If the concept you need isn't in any glossary, that's a signal: either you're inventing language the project doesn't use (reconsider), or there's a real gap — resolve it with `/grill-with-docs`, which captures the term as a **`## Glossary delta`** (see below) for the implementing PR to land.

## How a term lands

Glossary and ADR deltas land per the **WRITE contract** in [`docs/agents/domain.md`](./docs/agents/domain.md): a **separate `ubiquitous-language`-labelled PR** carries the glossary/ADR delta — it is **not** bundled into the code PR. Each code PR instead **declares** `Glossary impact:` / `ADR impact:` in its body, naming the term/ADR. This keeps the delta landing through the **Pre-merge Gate** (never edited inline on `master` and left uncommitted — that orphan-on-master state is the failure this contract prevents) while keeping glossary review a separate concern from code review.

`/grill-with-docs`'s generic "edit `CONTEXT.md` inline as terms resolve" instruction is **overridden here** by that contract: grilling emits a `## Glossary delta` block (full term entries in the `grill-with-docs` `CONTEXT-FORMAT.md` shape) for the `ubiquitous-language` PR to land — it does not write the live glossary directly.

Prefer the **co-located** `CONTEXT.md` when the domain has one (less contention on the single root file — the ADR-0014 deep-module direction); fall back to the root glossary only for genuinely cross-cutting terms.
