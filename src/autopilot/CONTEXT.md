# `src/autopilot/` — Autopilot Run module map

**Read this before editing any `run*.ts` file in this directory.** It is the entry point the
[`CONTEXT-MAP.md`](../../CONTEXT-MAP.md) domain map points at for `src/autopilot/`.

This file maps **modules** — which file owns which slice, and how a request traverses them. It does
**not** redefine the vocabulary. The terms **Autopilot Run**, **Autopilot Turn** and **Autopilot
Focus** are defined once in the root [`CONTEXT.md`](../../CONTEXT.md); read those entries for what
the concepts *mean*, and this file for where they *live*. Duplicating the definitions here would
create a second thing to drift.

Relevant decisions: [ADR-0006](../../docs/adr/0006-codex-cli-removed-autopilot-only.md),
[ADR-0007](../../docs/adr/0007-decision-brain-orchestration.md), [ADR-0012](../../docs/adr/0012-autopilot-is-the-single-brain.md).

## Why this file exists

The **Autopilot Run** lifecycle was extracted out of a single `runs.ts` across a series of
focused-sibling splits. Every split left its rationale in the receiving file's docblock, so the
per-file history is well recorded — but there was no document that said *which file to open first*.
The result was navigational debt, not structural debt: the modules are healthy, the map was missing.

That is deliberate. **The extraction history in those docblocks is load-bearing and must not be
deleted** — in particular the repeated "no back-compat re-export" precedent (issue #2125) is the
rule the *next* extraction out of this cluster has to follow. The history is not in the wrong form,
it was in the wrong place for a first read. This file is the first read; the docblocks stay.

## Layering

The cluster is an acyclic layered DAG. Read it bottom-up; nothing below depends on anything above.

| Layer | Files | Owns |
|---|---|---|
| Redis seams | `../redis/autopilot-runs.ts`, `../redis/dispatches.ts` | The only code that talks to Redis for run state (see **Redis Adapters** in the root glossary) |
| Pure leaves | `run-result.ts` | The `Ok`/`Err` result spine plus `errRedis` / `numberOrDefault` / `filesChangedCount`. No I/O, no intra-cluster imports — the bottom of the graph |
| | `run-lifecycle-state.ts` | `deriveLifecycleState`, `summarizeTerminationHealth`, `deriveInflightSlotSeed`, `WEDGE_AGE_THRESHOLD_S`. Pure derivation over an already-loaded row |
| | `run-projections.ts` | `isPidAlive`, `fetchTurnsWithJoins`, `projectRunView`, `projectRunDigest` — turn joins and view projection |
| Sweep | `sweep-reader.ts` | The dead-pid sweeper and the readers that pair a load with it (below) |
| I/O coordinators | `runs.ts` | **Write path only** — `startRun` / `endRun` / `recordTurn` |
| | `run-reads.ts` | Composite read path — `getCurrentLifecycle`, `getCurrentRun`, `getRun`, `getRunRow`, `listRuns`, `readInflightSlotSeed`, `getRunDispatchClasses` |
| | `cycle-close.ts` | `recordCycle` — cycle-record close-out and its metrics fan-out |
| | `dispatch-pr-link.ts` | `recordDispatchPr` — links a dispatch to its PR |
| | `outcome-record.ts` | Dispatch-outcome attribution records (see the name-collision warning below) |
| Routes / aggregators | `../api/autopilot-*.ts`, `../aggregators/*` | HTTP surface and dashboard rollups |

There are no cycles, and no dead modules — every file above has live production callers. `runs.ts`
having a single caller is not a smell: it is the write path behind exactly one route, which is what
a write path should look like.

## The two traversals

The write path and the read path are separate journeys through this directory. Knowing which one
you are on tells you which file to open.

**Write** — `POST /api/autopilot/run-start` · `/turn` · `/run-end`
→ `../api/autopilot-lifecycle.ts` → `runs.ts` → `../redis/autopilot-runs.ts`

**Read** — API routes and dashboard aggregators
→ `run-reads.ts` → `sweep-reader.ts` → `run-projections.ts` / `run-lifecycle-state.ts`

The read path is not passive: `sweep-reader.ts` **writes** when it sweeps. `sweepRunIfDead` promotes
a `running` row whose pid is dead to `killed`/`crash` at read time, and `readAndSweepAutopilotRun` /
`readLifecycleState` / `sweepLoadedRow` are the composed readers that pair a Redis load with that
sweep so callers stop replicating the dance inline. The sweep is idempotent — a terminal row is
never re-swept.

Consequence worth internalising: **the dead-pid sweeper is not in `runs.ts`.** `runs.ts` is the write
path and nothing else. Callers that need a swept row must go through `sweep-reader.ts`, and any row
passed to `deriveLifecycleState` must already have been swept.

## Navigational traps

Three things in this directory reliably mislead a reader who greps by name.

### 1. Two unrelated files named `outcome-record.ts`

`src/autopilot/outcome-record.ts` and `src/reflections/outcome-record.ts` share a basename, sit
inside the same concept, and mean different things by the word "outcome". They have zero overlapping
exports, zero import edge between them, no shared store, and neither is barrelled. They were
extracted weeks apart (#3323 and #3321).

| | `src/autopilot/outcome-record.ts` | `src/reflections/outcome-record.ts` |
|---|---|---|
| "Outcome" means | merged / failed / unaccounted — **attribution instrumentation** | the **free-text failure narrative** for the next retry |
| Exports | `resolveDispatchTokens`, `writeDispatchOutcomeRecord`, `upgradeDispatchOutcomeRecord`, `AutopilotDispatchOutcomesFacade`, `OutcomeRecordDeps` | `recordReflectionOutcome`, `RecordReflectionOutcomeResult` |
| Writes to | `../redis/dispatch-outcomes.ts`, feeding `class-stats-math.ts` and outcome-attribution estimation | `recordAnchorReflection` → `../redis/reflections.ts` (the #193 retry-correctness invariant) |
| Sole caller | `cycle-close.ts` | `../api/autopilot-lifecycle.ts` |

This is harmless to the compiler and a live trap for humans and agents — the architecture scan that
prompted this document listed one of the two and missed the other, i.e. an automated reader fell
into exactly the ambiguity it was reporting. **Check the directory, not just the filename.**

### 2. `RUN_TTL_SECONDS` lives in a file whose name does not advertise TTL

The shared 7-day run TTL is exported from `sweep-reader.ts`, not from `runs.ts` and not from a
constants file. It is imported by `runs.ts`, `recommendation-engine.ts` and
`../api/now-recommendations.ts`. It sits with the sweeper because the sweeper is what writes with
it. If you are looking for the run TTL, it is in `sweep-reader.ts`.

### 3. One import edge points *upward* out of `src/reflections/`

`src/reflections/outcome-record.ts` imports `errRedis` / `Ok` / `Err` from `autopilot/run-result.ts`
and the `ReflectionRecordBody` type from `autopilot/schemas.ts`. That is the one edge crossing this
directory boundary in that direction, and it is why `run-result.ts` has importers outside
`src/autopilot/`. Keep it in mind before "tidying" `run-result.ts`'s export surface.

## Conventions for changes here

- **No barrel.** `src/autopilot/` has no `index.ts` and should not gain one. A barrel adds a runtime
  re-export edge across the live control plane and churns call sites for no behaviour gain, and a
  docblock on a barrel is only reachable by someone who already knew to open it. This file is
  reachable from `CONTEXT-MAP.md`, which is where agents are told to start.
- **Follow the no-back-compat-re-export precedent** (#2125) on any further extraction: move the
  symbol and update callers; do not leave a re-export shim behind.
- **Redis only through `src/redis/<domain>.ts`** — enforced by `scripts/ci/redis-seam-check.ts`.
- **Never throw from the lifecycle paths** — return the `Ok`/`Err` result objects from
  `run-result.ts` and let the caller decide how to report.
- **Update this file when you add or move a module here.** A file that is not in the table above is
  invisible to the next reader, which is the failure this document exists to prevent.
