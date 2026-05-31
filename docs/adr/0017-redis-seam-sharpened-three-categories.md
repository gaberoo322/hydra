---
status: accepted (amends ADR-0009)
---

# Redis seam sharpened: three access categories + a sanctioned Event Bus raw-wire seam

ADR-0009 closed the Redis Seam with a single rule — *Redis access goes through a typed `src/redis/<domain>.ts` accessor; `keys.ts`/`kv.ts` are private to the family.* That rule is right for the case it was written against (shared domain state with many callers) but it is stated too coarsely and, crucially, **it is not enforced for the access pattern that actually leaks today**: a file imports the *blessed* `redis/connection.ts` and issues raw ioredis commands against it. `redis-seam-check.ts` only forbids `redis-keys`/`redis/keys`/`redis/kv`/`redis-adapter` imports — it never flags raw `getRedisConnection()`. So the Seam is unenforced in exactly the gap where the remaining violations live.

This ADR sharpens ADR-0009 into **three access categories**, each with its own correct shape, and resolves the one open design fork (the slot-events stream wire format) in favour of an explicit second seam on the Event Bus. ADR-0009's core decision — shared domain state goes behind a typed accessor — is unchanged and is Category A below.

## The three categories

| Category | What it is | Two-adapter test | Correct shape |
|---|---|---|---|
| **A — shared domain state** | a hash / zset / kv read or written by 2+ Modules | 2 owners → **real seam** | typed `src/redis/<domain>.ts` accessor (ADR-0009, unchanged) |
| **B — messaging infrastructure** | Redis Streams (`x*`) | n/a — the Module *is* the seam | `src/event-bus.ts` owns stream ops; clients use its interface, never the raw connection |
| **C — module-private state** | a key with exactly one owning Module | 1 owner → **hypothetical seam** | a per-module accessor is shallow ceremony; use a shared deep primitive if the pattern recurs, else keep it inline with fail-loud + a documented owner |

The distinguishing test is ADR-0009's own: *one adapter is a hypothetical seam; two adapters are a real seam.* `task-tracker.ts`'s `hydra:cycle:*` keys were a genuine violation because they had **two** owners (it and `cycle-tracking.ts`) — Category A. `capacity-floor.ts`'s `hydra:capacity:history` has exactly **one** owner — Category C, where a `redis/capacity.ts` would buy no leverage.

## Decisions

1. **Category A is unchanged.** Shared domain state goes behind a typed accessor. This is ADR-0009 and stays.

2. **Category B — the Event Bus is a sanctioned raw-Redis owner, with two interface gaps closed.** `src/event-bus.ts` legitimately calls `getRedisConnection()`/`getRedisSubscriber()` for stream ops; it *is* the Seam for messaging (ADR-0009 point 3 already placed stream keys here). Two methods are added so its clients stop reaching around it to the raw connection:
   - `ensureConsumerGroup(stream, group)` — replaces the raw `xgroup CREATE … MKSTREAM` that `slot-events-bridge.ts` does by hand before `eventBus.consume()`.
   - `publishRaw(stream, fields, { maxlen })` — an explicit **second wire format**: a flat, `event`-discriminated field list with `MAXLEN ~` trimming, distinct from `publish()`'s JSON envelope. This is the slot-events stream. (See decision 3.)

   After this, no file outside `src/redis/*` and `src/event-bus.ts` imports `getRedisConnection`/`getRedisSubscriber`.

3. **The slot-events stream's flat wire format is sanctioned, not migrated (the open fork, resolved (a)).** `SLOT_EVENTS_STREAM` is **co-owned with `on-subagent-stop.sh`** — a shell hook that emits flat fields via `redis-cli`. A bash producer cannot cleanly construct the `publish()` JSON envelope, so the flat format is a *feature*, not debt. The Event Bus owns this format explicitly via `publishRaw()` rather than pretending the stream doesn't exist. Migrating the shell hook onto the envelope (option (b)) was rejected: it touches an external producer contract for no durable gain and would lose the shell-emittable property.

4. **Category C — prefer a shared deep primitive over a single-owner accessor.** `capacity-floor.ts` reimplements `lpush` + `ltrim` + `lrange` + tolerant `JSON.parse` inline, and that bounded-JSON-history pattern recurs across `cycle-metrics`, `dispatches`, `reflections`, `plan-cache`, and the agent-run list. The deepening is one reusable `boundedJsonList(key, max)` primitive in the Redis family (push / read-tolerant / clear) — *deep* because it pays back across N call sites — with `capacity-floor` as its first adapter. A standalone `redis/capacity.ts` is explicitly **not** the answer; it would be three thin wrappers a single caller uses.

5. **Enforcement is extended to the real gap.** `scripts/ci/redis-seam-check.ts` gains a check that flags raw `getRedisConnection()`/`getRedisSubscriber()` imports from any file **outside the sanctioned owners** (`src/redis/*` and `src/event-bus.ts`). Same shrink-only baseline-ratchet mechanism as the existing import check. The fix-path for a flag is named: route through the Event Bus (B), a domain accessor (A), or a shared primitive (C) — **never** add a thin single-owner accessor to satisfy the linter.

## Considered options

- **Leave ADR-0009 as the single coarse rule.** Rejected: it mis-fits B (the seam is the Event Bus interface, not a `redis/` hash-module) and over-applies to C (a single-owner accessor is ceremony the deletion test fails). And it left raw `getRedisConnection()` unenforced, which is where every current violation lives.
- **Migrate `on-subagent-stop.sh` onto the `publish()` envelope (fork option (b)).** Rejected per decision 3 — touches an external shell contract, discards the shell-emittable property, no durable gain.
- **Extract `redis/capacity.ts` (and a `redis/<x>.ts` per single-owner key).** Rejected per decision 4 — shallow ceremony; the leverage is in a shared primitive, not per-module wrappers.
- **Forbid raw `getRedisConnection()` everywhere, no Event Bus carve-out.** Rejected: streams have no typed-hash accessor shape; forcing one would invert ADR-0009 point 3. The Event Bus is the seam; it must own the connection for `x*`.

## Consequences

- `src/event-bus.ts` grows `ensureConsumerGroup()` and `publishRaw()`. `slot-events-bridge.ts` and `pr-lifecycle-bridge.ts` route through them and drop their `redis/connection.ts` imports.
- A `boundedJsonList(key, max)` primitive lands in the Redis family; `capacity-floor.ts` becomes its first adapter. The other inline reimplementations (`cycle-metrics`, `dispatches`, `reflections`, `plan-cache`, agent-run list) are follow-up adopters, not part of the first PR.
- `redis-seam-check.ts` flags raw connection use outside the sanctioned owners, baselined shrink-only. After the migrations above, the baseline is empty (the only remaining raw owner is the sanctioned `event-bus.ts`; `task-tracker.ts` — the other historical raw user — is deleted under ADR-0016 / #792).
- CONTEXT.md gains the access-category vocabulary (A/B/C) if it isn't already implied by the **Redis Adapters** term.
- Blast radius: `event-bus.ts`, the two bridges, `capacity-floor.ts`, and a CI check → **Tier 3** (ADR-0015). Not Verifier Core.

## Related

- ADR-0009 — Redis seam via typed accessors (this ADR amends and sharpens it; Category A *is* ADR-0009).
- ADR-0016 — retires `task-tracker.ts`, removing the other raw-connection user outside the Event Bus.
- ADR-0015 — tier model (each implementation PR is Tier 3).
