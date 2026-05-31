---
status: accepted
---

# Cycle/task tracking is autopilot-recorded; the in-process task-tracker is retired

Cycle and per-task lifecycle state is **recorded by the autopilot after the fact**, through `src/redis/cycle-tracking.ts`. There is no in-process tracker that *drives* a cycle through stages, holds tasks on dependencies, or runs a state machine. `src/task-tracker.ts` — the module that did all of that — is retired. It was orphaned, not load-bearing: the in-process control loop that called its writers was deleted (ADR-0006; PRs #383/#701), and nothing rewired its callers.

This closes a recurring architecture-review trap: `task-tracker.ts` *looks* deep (a v2 task state machine, a recursive dependency-cascade, evidence chains) and it violates the ADR-0009 Redis seam (raw ioredis + six cycle key strings duplicated from `redis/keys.ts`). The obvious-looking fix — extract a `redis/task-tracker.ts` accessor and fold the cycle keys into `cycle-tracking.ts` — is **wrong**, because the module is dead. The correct fix is deletion, which dissolves the seam violation and the key duplication for free.

## What actually writes cycle state

The autopilot's `recordCycle()` (`src/autopilot/runs.ts`) is the only writer of cycle records. It writes the `hydra:cycle:<id>` hash (`status/startedAt/completedAt/source/total/completed/failed/abandoned`) via `cycle-tracking.ts::initCycleHash`, indexes it with `addCycleToIndex`, and feeds `recordCycleMetrics`. It deliberately does **not**:

- set the `hydra:cycle:active` pointer (cycles are recorded post-hoc, never tracked as a live "running" cycle),
- write the `:agents` / `:costs` sub-keys,
- write any `hydra:task:*` or `hydra:deps:*` keys.

`src/cycle.ts` is the blessed read model over that data (`/api/cycle/status`, `/api/cycle/history`), reading exclusively through the typed accessor. That is the whole live surface.

## Why task-tracker is dead

Applying the deletion test: deleting `task-tracker.ts` does **not** make complexity reappear across its callers, because its writers have no callers and its readers observe state nothing populates.

- **Dead writers (zero callers):** `initCycle` (v1), `initTaskV2` / `transitionTask` (v2 state machine — its caller `post-merge.ts` was deleted), `logAgentRun`, and the entire dependency-cascade (`holdTask` / `releaseByTitle` / `blockDependentsOf` / `checkDependenciesMet` / `recoverHeldTasks`).
- **Vacuous readers:** the cycle watchdog (`getCycleState()` → always `idle` because nothing sets `hydra:cycle:active`), the DLQ `markTaskDone` branch (bails at `!task.cycleId`), the `/tasks/:id` routes and `/cycle/report` (read `hydra:task:*` / pointers nothing writes).
- **One partial reader:** `/cycle/report/:cycleId` reads the autopilot-written cycle hash (real counts) plus always-empty `agents`/`costs` — i.e. it duplicates `cycle.ts`'s read model through the raw seam.

This is the same shape as the Specs retirement (#513): a subsystem already dead in production that the control-loop removal left behind without cleanup.

## Considered options

- **Extract `redis/task-tracker.ts` and fold cycle keys into `cycle-tracking.ts` (the seam-deepening refactor).** Rejected: it lovingly refactors dead code. The seam violation and key duplication are real but evaporate on deletion.
- **Leave it in place as harmless dead code.** Rejected: it actively misleads. It presents a second, raw-Redis owner of `hydra:cycle:*`, a plausible-looking task state machine, and live-but-vacuous API routes and watchdog timers that imply a tracking subsystem exists. Every architecture pass re-investigates it.
- **Delete it and reroute the one partial reader (chosen).** `/cycle/report/:cycleId` serves from `cycle-tracking.ts` (or folds into `/cycle/history`); the vacuous routes, watchdog, DLQ branch, and startup recovery are removed.

## Consequences

- `src/task-tracker.ts` and `src/task-machine.ts` (which exists only to validate `transitionTask`) are deleted.
- `src/index.ts` loses the cycle watchdog `setInterval`, the DLQ `markTaskDone` branch, and the startup `recoverHeldTasks()` call.
- `src/api/cycles.ts` / `src/api/tasks.ts` lose the `task-tracker`-backed routes; `/cycle/report/:cycleId` (if kept) reads through `cycle-tracking.ts`.
- `CYCLE_KEY_TTL` (imported by `src/metrics/record.ts`) relocates; it is the same 7-day value `cycle-tracking.ts` already uses.
- `test/rollback-merged-terminal.test.mts` is deleted — it guards the removed `post-merge.ts → transitionTask` path.
- Residual `hydra:task:*` and `hydra:deps:*` keys become unreferenced; an optional one-shot `redis-cli` sweep (mirroring `scripts/cleanup/retire-specs.sh`) drops them.
- The blast radius is core `src/` + live API routes → **Tier 3** (ADR-0015): CI-green + adversarial QA, normal auto-merge path.
