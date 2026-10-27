# Context Map

Where the domain language lives. Read this to find the glossary entries and ADRs relevant to the area you're about to touch — then read those before naming concepts or editing code.

**Layout: multi-context.** The glossary is **root-only**: [`CONTEXT.md`](./CONTEXT.md) holds every system-wide term + relationship. A co-located `src/<domain>/CONTEXT.md` is a **module map** — a navigational entry point (layering, which file owns what, traps, conventions), never a glossary: it may *use* and link terms, but never defines them. One is written only when a directory has real navigational traps — never by default, never pre-created empty — with [`src/autopilot/CONTEXT.md`](./src/autopilot/CONTEXT.md) as the reference instance. Each domain's vocabulary lives in the relevant section of the root glossary, mapped below.

## Cross-cutting glossary

[`CONTEXT.md`](./CONTEXT.md) — read first regardless of domain. Every term lives here — e.g. Orchestrator, Target, Target/Orchestrator Vision, Target Outcomes, Verifier Core, Pre-merge Gate, Merge Lock, Post-merge Regression Check, Modification Tier, Outcome Holdback, Operator-Required Intervention — plus the deep-module Seams below.

## Domain map (code area → glossary terms → decisions)

| Code area | Glossary terms (in `CONTEXT.md`) | Module map | Relevant ADRs | Reference docs |
|---|---|---|---|---|
| `src/host-probe/` | Host-Probe Adapter | — | — | — |
| `src/redis/` | Redis Adapters | — | ADR-0009, ADR-0017 | [Redis Keys](docs/reference.md#redis-keys), [Event Bus](docs/reference.md#event-bus) |
| `src/schemas/` | Schemas | — | ADR-0011, ADR-0022 | — |
| `src/cost/` | Cost, Subscription Usage Tracker, Quota Weight | [`src/cost/CONTEXT.md`](./src/cost/CONTEXT.md) | ADR-0021, ADR-0042 | — |
| `src/autopilot/` | Autopilot Run, Autopilot Turn | [`src/autopilot/CONTEXT.md`](./src/autopilot/CONTEXT.md) | ADR-0006, ADR-0007, ADR-0012, ADR-0016, ADR-0043 | [Model Tiers](docs/reference.md#model-tiers), [Learning System](docs/reference.md#learning-system-operational) |
| `src/taxonomy/` | Dispatch-Class Taxonomy | — | ADR-0012, ADR-0030 | — |
| `src/glm/`, `scripts/glm/` | — | — | ADR-0032, ADR-0040 | [GLM lane on/off](./docs/operations/glm-lane.md) |
| `src/scheduler/` | Orchestrator Scheduler (Observability Heartbeat), Housekeeping | — | ADR-0012 | [Observability](docs/observability/README.md), [Watchdog](docs/operations/watchdog.md) |
| `src/notification/`, `src/operator-channel/` | Operator Channel, Page, Morning Brief | — | ADR-0045 | — |
| `src/pattern-memory/` | Pattern Memory | — | — | [Ineffective promoted patterns](docs/operations/ineffective-promoted-patterns.md), [Learning System](docs/reference.md#learning-system-operational) |
| `src/reflections/` | Reflections | — | ADR-0023 | — |
| `src/metrics/`, `src/aggregators/` | Cost, Quota Weight | — | ADR-0016, ADR-0028, ADR-0039 | — |
| `src/api/`, `src/api.ts` | — (see `docs/generated/routes.json`) | n/a | ADR-0011, ADR-0022, ADR-0024 | [API Endpoints](docs/reference.md#api-endpoints-port-4000-all-under-api) |
| `src/logger.ts` | — | n/a | ADR-0027 | — |
| `src/target-config.ts` | Target Manifest | n/a | ADR-0002, ADR-0026 | [Target swap runbook](docs/target-swap-runbook.md), [ADR-0002 target swap](docs/reference.md#adr-0002-target-swap-issue-258--259) |
| ~~`src/knowledge-base/`~~ | ~~Knowledge Base, OpenViking Request Adapter~~ — **RETIRED**, directory deleted | n/a | ADR-0033 | — |
| ~~`src/anchor-selection/`~~ | ~~Reframe Queue~~ — **RETIRED**, directory deleted; ~~Candidate Feed~~ retired with it (#3455) | n/a | ADR-0010, ADR-0036 | — |
| `src/design-concept.ts`, `src/redis/design-concept.ts` | Design Concept | n/a | ADR-0008, ADR-0018 | — |
| backlog / GitHub issues | Epic, Focus Label | n/a | ADR-0003, ADR-0031 | [Issue tracker](docs/agents/issue-tracker.md), [Triage labels](docs/agents/triage-labels.md), [Rate-limit handling](docs/reference.md#github-api-rate-limit-handling-issue-3137) |
| self-modification | Modification Tier, Verifier Core, Outcome Holdback | n/a | ADR-0001, ADR-0004, ADR-0005, ADR-0015, ADR-0019, ADR-0020 | [Modification Tiers](docs/reference.md#modification-tiers-issue-243-adr-0001--adr-0004--adr-0015), [Outcome Holdback](docs/reference.md#outcome-holdback--post-merge-regression-check-issue-786-adr-0004-step-4) |

### Non-`src/` areas

ADRs also govern skills, CI, and scripts. These have no `src/` directory to hang off, so they
get their own rows:

| Area | Relevant ADRs | Reference docs |
|---|---|---|
| `docs/operator-playbooks/` | ADR-0025, ADR-0029, ADR-0030, ADR-0031, ADR-0035, ADR-0044 | [Evals](docs/evals.md) |
| `.github/workflows/` (Verifier Core) | ADR-0015, ADR-0019, ADR-0020 | [Quality gates](docs/quality-gates.md) |
| `scripts/autopilot/` (`decide.py`, `classes.json`) | ADR-0007, ADR-0012, ADR-0029, ADR-0032, ADR-0043 | — |
| `dashboard/` | ADR-0034 | [Deploy recipe](docs/reference.md#deploy-recipe) |
| `config/direction/`, `config/orchestrator/` | ADR-0003, ADR-0005 | [Config](docs/reference.md#config-hydraconfig--git-tracked), [Target Outcomes](docs/reference.md#target-outcomes-issue-241-adr-0003--adr-0015) |
| `scripts/sync-skills.sh`, `src/skills/` (skill generation) | ADR-0041 | — |
| `docs/adr/` itself | ADR-0037 | — |
| `test/`, `scripts/test/` (the suite itself) | ADR-0038 | [Process cleanup](docs/operations/process-cleanup.md) |
| **process / policy** (no code area) | ADR-0002, ADR-0013, ADR-0014, ADR-0024, ADR-0046 | [Domain docs](docs/agents/domain.md) |

The deep-module discipline is the load-bearing simplicity strategy here: each Seam (Redis Adapters, Schemas, Cost) hides its complexity behind a narrow typed interface so a subagent can use it correctly by reading only the glossary entry — not the implementation. Keep new subsystems to that shape.

## ADRs (system-wide)

[`docs/adr/README.md`](./docs/adr/README.md) is the **complete roster** — every ADR with its
status, its decision in one sentence, and the trigger for reading it. Read it in
full, then open only what you need. The tables above are the code-area shortcut into it.

Read the ones the map flags for your area; flag contradictions explicitly rather than silently
overriding (see [`docs/agents/domain.md`](./docs/agents/domain.md)).

**Before writing a new ADR**, read [ADR-0037](./docs/adr/0037-hydra-adrs-are-agent-facing-normative-specs.md):
Hydra ADRs are agent-facing normative specs, so the upstream one-paragraph size target does not
apply — but the three-part write gate does, `Status` is mandatory, and a new row in the roster is
enforced by `test/adr-roster.test.mts`.

## When a term is missing

If the concept you need isn't in any glossary, that's a signal: either you're inventing language the project doesn't use (reconsider), or there's a real gap — resolve it with `hydra-grill` (the spec stage, [ADR-0035](./docs/adr/0035-spec-stage-stays-hydra-owned.md)), which captures the term as a **`## Glossary delta`** (see below) for the implementing PR to land.

## How a term lands

Glossary and ADR deltas land per the **WRITE contract** in [`docs/agents/domain.md`](./docs/agents/domain.md): a **separate `ubiquitous-language`-labelled PR** carries the glossary/ADR delta — it is **not** bundled into the code PR. Each code PR instead **declares** `Glossary impact:` / `ADR impact:` in its body, naming the term/ADR. This keeps the delta landing through the **Pre-merge Gate** (never edited inline on `master` and left uncommitted — that orphan-on-master state is the failure this contract prevents) while keeping glossary review a separate concern from code review.

The spec stage's generic "edit `CONTEXT.md` inline as terms resolve" instruction is **overridden here** by that contract: `hydra-grill` emits a `## Glossary delta` block (full term entries in the root `CONTEXT.md`'s existing entry shape — bold term, definition, `_Avoid_` line) for the `ubiquitous-language` PR to land — it does not write the live glossary directly.

A co-located `src/<domain>/CONTEXT.md` is a **module map** — a navigational entry point (layering, which file owns what, traps, conventions), written only when a directory has real navigational traps, never by default. It may *use* and link glossary terms, but never defines them: the glossary is **root-only**, and glossary deltas always target the root `CONTEXT.md` through the `ubiquitous-language` PR above — never a co-located file. [`src/autopilot/CONTEXT.md`](./src/autopilot/CONTEXT.md) is the reference instance.
