# ADR-0009: Redis access goes through typed domain accessors

Status: Accepted
Date: 2026-05-22
Deciders: Operator + Hydra
Issue: TBD (Redis Seam closure epic)

## Context

The orchestrator's Redis access lives on two surfaces today:

1. `src/redis-keys.ts` — a 279-line object exporting ~80 key-shape
   functions for every Redis surface in the codebase.
2. `src/redis/*.ts` — 18 domain Modules (cycle-tracking, scheduler,
   work-queue, reflections, plan-cache, scout-stats, …) that each
   `import { redisKeys } from "../redis-keys.ts"` internally. Issue #269
   split a 1,582-line `redis-adapter.ts` into this family;
   `src/redis-adapter.ts` survives as a 247-line re-export shim.

The split that #269 began was supposed to close — but didn't. 27
production files outside `src/redis/` still import `redis-keys.ts`
directly, then read or write through raw `kv.ts` primitives (`hashSet`,
`expireKey`, scans, etc.). CLAUDE.md asks new code to use adapter
methods, but nothing enforces it — so each new call site takes the
cheap path. As of 2026-05-22 the leak count is rising, not falling: a
recently-stashed branch was adding the 28th caller (`src/anchor-selection/reframe-starvation.ts`).

The Seam at `src/redis/*` is hypothetical, not real: there is one
adapter family on one side, and 27 raw call sites on the other —
two adapters satisfying the same interface (read/write Redis). Per
the architecture vocabulary, *one adapter is a hypothetical seam,
two adapters are a real seam* — today neither outcome is true, and
the cheap path keeps the Seam from closing.

The cost shows up as:

- **Locality.** A key-shape change — extending the **Merge Lock** TTL,
  moving a **Stuckness** counter, adding a TTL refresh on an index —
  has to touch every caller, not one Module. Bugs that hide in the
  implicit composition of key + TTL + index update have no owning
  Module.
- **Test surface.** Tests of the **Pre-merge Gate**, **Stuckness**, and
  **Pattern Memory** end up re-asserting key strings instead of
  asserting behaviour.
- **AI navigability.** When a subagent reads
  `hydra:scheduler:deliberate-stop` it can't follow a single interface
  to learn what writes it, what TTL applies, or what clears it.

## Decision

Close the Seam at `src/redis/*`.

1. **Typed data accessors only.** `src/redis/*` Modules expose
   functions that read or write domain data (`recordCycleCost`,
   `getReframeQueue`, `acquireMergeLock`, …). They do **not** expose
   key generators. TTL, key shape, JSON schema, and index maintenance
   live behind the function.
2. **`src/redis/keys.ts` and `src/redis/kv.ts` are private to the
   family.** `src/redis-keys.ts` moves to `src/redis/keys.ts` in the
   final closure PR. Outside callers — including tests — may not
   import either file.
3. **Streams are an Event Bus concept.** The stream key strings move
   into `src/event-bus.ts`. The Event Bus Module owns its own internal
   alphabet and uses Redis as the implementation. This keeps the new
   rule with an empty allow-list and survives a future transport
   swap.
4. **CI enforcement.** A new `scripts/ci/redis-seam-check.ts` Pre-merge
   Gate job forbids imports of `redis-keys`, `redis/keys`, `redis/kv`,
   and `redis-adapter` from any file outside `src/redis/`. Lands with
   the final closure PR.
5. **`src/redis-adapter.ts` retires** in the final PR; it is a second
   mouth on the same Seam.
6. **Migration is sliced by target Module on the new Seam**, not by
   caller. Six operator-reviewable Tier-3 PRs each complete one piece
   of the Seam:

   1. **Cycle state.** `api/cycles.ts`, `cycle.ts`, the scheduler's
      cycle reads → `src/redis/cycle-tracking.ts`.
   2. **Scheduler counters.** `scheduler.ts`,
      `scheduler-research-floor.ts`, `api/autopilot.ts` →
      `src/redis/scheduler.ts`.
   3. **Anchors & Reframe Queue.** `backlog.ts`, `api/backlog.ts`,
      `anchor-selection/reframe-starvation.ts` →
      `src/redis/work-queue.ts` (or a new `src/redis/anchors.ts` if
      work-queue grows past ~500 lines).
   4. **Scout.** `scout/{stats,calendar-walk,seen-list}.ts`,
      `api/scout.ts` → a new `src/redis/scout.ts`.
   5. **Event Bus stream migration.** Stream key strings move from
      `redis-keys.ts` into `src/event-bus.ts`; cleans `api/events.ts`
      and `api/alerts.ts`.
   6. **Final closure.** Sweeps the misc bootstrap one-offs
      (`index.ts`, `cleanup.ts`, `context-builder.ts`,
      `task-tracker.ts`, `plan-cache.ts`, `metrics.ts`,
      `reflections/reflections.ts`, and the remaining four
      `api/*.ts` callers), moves `src/redis-keys.ts` →
      `src/redis/keys.ts`, retires `src/redis-adapter.ts`, lands the
      lint rule.

The slicing is recorded here so it isn't re-debated each PR.

## Consequences

### Positive

- Single Seam for Redis access. The interface a caller learns
  (`recordCycleCost(id, {usdMicros, source})`) carries TTL, key shape,
  and index maintenance implicitly. Today it carries none of those.
- Future schema migrations touch one Module, not 27 call sites.
- Test surface improves. Tests use the same accessors as production
  — the interface is the test surface. Awkward setup in tests is the
  signal that the accessor is wrong, not a reason to bypass it.
- AI navigability. A subagent following `recordCycleCost` lands in a
  single Module that documents the storage shape. Today it lands in
  27 different combinations of key + kv primitive.
- CI prevents regression. The lint rule catches the 28th leak before
  it merges.

### Negative

- ~10–20 new accessor functions get written across `src/redis/*`,
  some of them very thin. Acceptable: these functions are the
  interface the codebase will hold against indefinitely.
- ~5–15 test files migrate from raw key writes to accessor calls.
- Operator review burden — six Tier-3 PRs in sequence. Each is
  reviewable in isolation; the migration order is fixed so a stall
  partway through leaves the codebase in a coherent intermediate
  state.
- Python tooling under `scripts/autopilot/*.py` reads Redis directly
  and carries its own key knowledge. Out of scope for this ADR;
  flagged as a follow-up if the Python and TypeScript schemas drift.

### Risks accepted

- A future addition (e.g. a new analytics surface) may want a raw
  scan over many keys that doesn't fit any one Module. The escape
  hatch is to add the accessor on the closest domain Module, not to
  re-open `redis/kv.ts` to outside callers. We prefer that friction
  over re-opening the Seam.
- The lint rule is a grep, not an AST check. False negatives are
  possible if someone re-exports `redisKeys` from a third file. The
  ADR is the backstop: a code review that re-exposes the Seam is a
  rejected PR regardless of what the lint rule says.

## Alternatives considered

- **Key generators only.** Each `src/redis/*.ts` exports its keys;
  callers use them with `kv.ts` primitives. Rejected: doesn't earn
  the Seam. TTL, schema, and read/write composition stay smeared
  across the 27 callers. The deletion test fails — key generators
  carry no useful contract beyond the string they produce.
- **Permitted exception for `src/event-bus.ts`.** Treat stream keys
  as a Redis-domain concept; allow `event-bus.ts` to import
  `redis/keys.ts`. Rejected: streams are an Event Bus concept, not a
  Redis-domain concept. The carve-out grows whenever the bus needs a
  new stream. Moving stream keys into `event-bus.ts` (the chosen
  shape) is cleaner and survives a transport swap.
- **Permitted KV escape hatch for bootstrap.** Allow `src/index.ts`
  to import `redis/kv.ts` for service-startup pokes. Rejected:
  bootstrap doesn't need raw primitives — anything `index.ts` does
  at startup is itself a domain concern that deserves an accessor.
  The full-private rule forces the discipline the Seam exists for.
- **Big-bang single PR.** Rejected: 27 files plus ~15 new accessors
  plus ~10 test migrations is too much for one Tier-3 review.
  Slicing by target Module keeps each PR reviewable and leaves the
  intermediate states coherent.

## Related

- ADR-0001 — Untouchable Core. The Seam closure is Tier 3, not
  Tier 0; this ADR doesn't expand the Untouchable list.
- ADR-0004 — Self-modification tiers (each closure PR is Tier 3).
- Issue #269 — the original `redis-adapter.ts` split that this ADR
  completes.
- CONTEXT.md term: **Redis Adapters** (added alongside this ADR).
