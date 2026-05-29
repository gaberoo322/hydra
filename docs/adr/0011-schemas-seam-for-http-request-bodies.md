# ADR-0011: HTTP request body validation goes through `src/schemas/*`

Status: Accepted
Date: 2026-05-25
Deciders: Operator + Hydra (via `/improve-codebase-architecture` grilling session)
Issue: TBD (Schemas Seam closure epic)

## Context

The orchestrator's HTTP boundary access lives on two surfaces today:

1. `src/schemas/queue.ts` — a single 43-line zod schema for `POST /api/queue`,
   landed in #562 as the seed for a canonical "every boundary parses through
   `src/schemas/*`" discipline.
2. The other 41 `req.body.<field>` accesses across `src/api/*.ts`
   (cycles, backlog, design-concepts, autopilot, alerts, anchors, …) — each
   handler reads body fields ad-hoc, validates inline with hand-rolled
   `typeof` / falsy checks, and returns its own prose 400 message.

CLAUDE.md asks new code to use `src/schemas/`, but nothing enforces it. As of
2026-05-25 the leak is structural: `src/schemas/` is a hypothetical Seam (one
adapter, prose discipline), and every new endpoint takes the cheap path.

This is the exact dynamic ADR-0009 names for the Redis Adapters Seam
pre-closure: *one adapter is a hypothetical seam, two adapters are a real
seam* — today neither outcome is true, and the cheap path keeps the Seam
from closing.

The cost shows up as:

- **Error-shape inconsistency.** Subagents and clients today pattern-match
  on prose strings (`"reference is required"`, `"bad shape"`, `"missing
  anchorRef"`). The structured `{code: "schema-validation-failed",
  issues: [...]}` shape that `queue.ts` introduced is unreachable from any
  other endpoint, so agents that hit a 400 still have to read prose.
- **Locality.** Payload-shape changes touch the handler, the type
  declaration, the hand-rolled validation block, and the test fixtures
  separately. There's no single Module that owns "what's a valid body."
- **Test surface.** Existing handler tests assert against 400-response
  prose; they re-validate string fragments instead of asserting against
  a typed schema. The interface is not the test surface.
- **AI navigability.** A subagent following `POST /api/design-concepts`
  has to read the handler to learn the body shape; no schema file
  documents it.

## Decision

Close the Seam at `src/schemas/*` for HTTP request bodies.

1. **Scope is HTTP `req.body` only.** Excludes `req.query`, `req.params`,
   Redis read values (owned by **Redis Adapters**), config-file reads,
   and structured subagent outputs (a separate boundary, not the
   HTTP-input surface). Resolved during the 2026-05-25 grilling session:
   the deletion test favours `req.body` (delete the schemas → agents
   pattern-matching on 41 inconsistent 400 shapes break); the leverage
   at `req.query` is marginal (failure mode is conventionally
   TypeScript-caught NaN coercion).
2. **Each `src/schemas/<domain>.ts` exports exactly two things**: a
   `z.object().strict()` schema and the `z.infer<typeof Schema>` type.
   No helper wrapper. No middleware. No `parseRequest(req, Schema)`
   facade. The Module does not import express. Handler code does
   `safeParse` inline and returns `400 {code: "schema-validation-failed",
   issues: result.error.issues}` on failure. The simplicity is
   load-bearing: a wrapper would couple `src/schemas/` to express, hide
   `result.error.issues` (the most useful debugging surface), and trade
   three obvious lines for indirection.
3. **CI enforcement.** A new `scripts/ci/schema-validation-check.ts`
   Pre-merge Gate job forbids `req.body.<field>` access outside a
   parsed-result variable in `src/api/*`. Enforced via a shrink-only
   baseline (`scripts/ci/schema-validation-baseline.json`) listing every
   existing access path at slice-N land time. New violations fail CI;
   the baseline can shrink (via `--write-baseline` after a migration)
   but cannot grow. Mirrors the ADR-0009 `redis-seam-check` mechanic
   exactly.
4. **Migration is sliced per HTTP router**, not per endpoint. Each
   router PR migrates every `POST`/`PATCH` handler in one
   `src/api/<router>.ts` file at once, lands the corresponding
   `src/schemas/<domain>.ts`, and updates the baseline by removing the
   migrated access paths:

   1. **Design Concepts.** `src/api/design-concepts.ts` (3 POST
      handlers: create-or-overwrite, approve, exempt-log append).
      Highest semantic richness (ADR-0008 defines the shape
      exhaustively); subagent-written, so structured errors give the
      writer something to pattern-match on.
   2. **Autopilot lifecycle.** `src/api/autopilot.ts` (`run-start`,
      `turn`, `run-end`). Highest cross-language leverage — pins the
      Python ↔ TS contract whose drift caused the 2026-05-15 silent
      wedge (ADR-0007 §schema-version handshake).
   3. **Backlog mutations.** `src/api/backlog.ts` (7 mutation
      endpoints). High operator-facing surface.
   4. **Cycles mutations.** `src/api/cycles.ts` (5 mutation endpoints).
   5. **Final closure.** Sweeps the remaining routers (alerts, anchors,
      queue's siblings, etc.), lands
      `scripts/ci/schema-validation-check.ts` + the baseline, and adds
      the lint job to `.github/workflows/ci.yml`. Tier 0 because it
      modifies the workflow file.

   The slicing is recorded here so it isn't re-debated each PR.

5. **Tier classification.** Slices 1–4 are **Tier 2** (`src/schemas/*`
   is not in `src/untouchable.ts`; the Outcome Holdback applies as it
   would for any Tier-2 change). Slice 5 (final closure) is **Tier 0**
   because it adds the new CI job to `.github/workflows/ci.yml`. The
   baseline file itself is NOT in the untouchable list — its
   shrink-only invariant is enforced by the lint script, not by the
   tier-gate.

## Consequences

### Positive

- **Single Seam for request-body parsing.** The interface a caller
  learns (`safeParse(req.body)` → tagged union) carries trim, default,
  required-vs-optional, and error shape implicitly. Today none of those
  are uniform across handlers.
- **Structured error contract.** Agents (especially hydra-dev and
  hydra-target-build, which call internal HTTP endpoints from
  subagent code) get a stable `{code, issues[]}` envelope to
  pattern-match on. The pre-merge gate, the dashboard, and external
  tooling all converge on one error vocabulary.
- **Cross-language contract pinned.** Slice 2 (autopilot lifecycle)
  pins the Python ↔ TS payload shapes whose drift produced the
  2026-05-15 silent wedge. A pydantic mirror on the Python side is
  *not* in scope for this ADR — but the TS-side schema becomes the
  reference shape any future Python validation can mirror from.
- **Schema = type.** Every endpoint's body has one source of truth for
  both runtime parsing and compile-time typing. Today the body type
  is hand-typed (`Partial<DesignConceptInput>`) and routinely drifts
  from the actual validation block.
- **CI prevents regression.** The lint rule catches the 42nd leak
  before it merges.
- **Test surface improves.** Existing handler tests that assert
  prose 400 messages get rewritten against the schema's `safeParse`
  shape — the interface IS the test surface.

### Negative

- ~10 schema files get written across `src/schemas/*`. Most will be
  20–60 lines and feel verbose compared to the inline `if (!field)`
  they replace. Acceptable: these are the interfaces the codebase
  will hold against indefinitely.
- ~5 handler test files migrate from prose-fragment asserts to
  structured-issue asserts.
- One more CI baseline file (`schema-validation-baseline.json`) joins
  `redis-seam-baseline.json` as a maintained-but-shrinking artifact.
- Operator review burden — 5 PRs in sequence (4 Tier-2, 1 Tier-0).
  Each is reviewable in isolation; the migration order is fixed so a
  stall partway through leaves the codebase in a coherent intermediate
  state (some routers parsed, the rest still using inline checks +
  the existing baseline).

### Risks accepted

- A future endpoint may want to accept a polymorphic / open-shape
  payload that doesn't fit a `.strict()` object. The escape hatch is
  `z.unknown()` for the open slot (mirroring `queue.ts`'s `context`
  field), not loosening the Module's `.strict()` invariant. We prefer
  that friction over re-opening the Seam.
- The lint rule is a grep, not an AST check. False negatives are
  possible if a handler destructures `req.body` into a typed local
  before reading fields. The ADR is the backstop: a code review that
  re-introduces ad-hoc validation in `src/api/*` is a rejected PR
  regardless of what the lint rule says.
- Future "what's a boundary?" debate may want to expand scope to
  `req.query`, Redis reads, or subagent outputs. Resolution path:
  write another ADR. This ADR's scope is fixed at HTTP `req.body`.

## Alternatives considered

- **Express middleware** (e.g. a `validate(Schema)` decorator that
  parses `req.body` and stuffs the result onto `req`). Rejected:
  couples `src/schemas/*` to express, hides `result.error.issues`
  from the handler (which is the most useful debugging surface), and
  obscures the 400-response shape behind a magic mutation of `req`.
- **`parseRequest(req, Schema)` helper.** Rejected: same coupling
  concern; trades three obvious lines (`safeParse` + early return +
  use `.data`) for indirection. The deletion test fails — delete the
  helper and callers go back to three readable lines. The helper
  earns no leverage.
- **Scope B — include `req.query` and `req.params`.** Rejected: the
  failure mode at query/param boundaries is conventionally
  TypeScript-caught (NaN coercion, undefined property access). The
  leverage is marginal relative to the per-handler migration cost.
  If a specific query boundary surfaces real pain, revisit in a
  follow-up ADR.
- **Scope C — every external-input boundary** (HTTP + Redis reads +
  config-file reads + structured subagent outputs). Rejected: Redis
  read shapes belong inside the **Redis Adapters** Module, not at a
  generic `src/schemas/*` Seam. Subagent JSON outputs (design-concept
  artifact, decide.py state) are a separate boundary with their own
  ownership story. Mixing all three muddies all three.
- **Big-bang single PR.** Rejected: 10 schema files plus ~10 handler
  rewrites plus ~5 test migrations is too much for one Tier-2 review.
  Slicing per-router keeps each PR reviewable and leaves intermediate
  states coherent.
- **Response-body schemas in scope too.** Rejected: response typing
  is a different problem (client-SDK ergonomics, not boundary
  hardening). Doubles the work without addressing the failure mode
  this ADR exists to fix.

## Related

- ADR-0001 — Untouchable Core. The Seam closure is Tier 2/3, not
  Tier 0; this ADR doesn't expand the Untouchable list.
- ADR-0004 — Self-modification tiers (slices 1–4 are Tier 2; slice 5
  is Tier 0).
- ADR-0008 — Design Concept gate. The first slice's schema mirrors
  the Design Concept artifact shape ADR-0008 defines.
- ADR-0009 — Redis Adapters Seam. This ADR adopts ADR-0009's
  closure mechanic verbatim: shrink-only baseline, per-Module
  slicing, lint rule lands in the final PR.
- Issue #562 — zod adoption + `src/schemas/queue.ts` seed PR.
- CONTEXT.md term: **Schemas** (added alongside this ADR).
