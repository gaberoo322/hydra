# ADR-0022: Query-param validation goes through `src/schemas/*` for GET read routes

Status: Accepted
Date: 2026-06-06
Deciders: Operator + Hydra (via `/improve-codebase-architecture` grilling session)
Supersedes: ADR-0011 "Alternatives considered → Scope B" (the `req.query` exclusion)

## Context

ADR-0011 closed the **Schemas** Seam for HTTP request *bodies* and explicitly
scoped `req.query` **out** (§1 "Scope is HTTP `req.body` only"; "Alternatives →
Scope B"), on the reasoning that the query failure mode is conventionally
TypeScript-caught (NaN coercion) and the per-handler migration leverage was
marginal. ADR-0011 named the resolution path: *"If a specific query boundary
surfaces real pain, revisit in a follow-up ADR."*

Two things happened after that:

1. **#909 crossed the line ad hoc.** `src/api/route-helpers.ts::aggregatorRoute`
   `safeParse`s `req.query` against a `src/schemas/*` schema and returns the same
   `400 {code:"schema-validation-failed", issues}` envelope. It is live in 4 v2
   read routers (`now-page`, `today-page`, `outcomes-page`, `explore-page`) plus
   `dispatches`, `autopilot-idle`, `builder-health`, `autopilot-board`, and 5
   query schemas already sit in `src/schemas/*` (`now-page`, `today-page`,
   `retro`, `builder-health`, `autopilot-board`). So query validation already
   exists — but ADR-0011's stated scope still says "req.body only," and
   `scripts/ci/schema-seam-check.ts` deliberately targets `req.body` ONLY and
   *exempts* `req.query`.

2. **Convention-only adoption decayed.** The newer/older routes never adopted
   the seam: ~18 routers still read `req.query` raw — `metrics.ts` worst (7
   `parseInt(req.query.count)` reads, all 8 of the repo's `// @ts-expect-error —
   migrate to proper types` markers), plus `learning`, `reflections`, `anchor`,
   `design-concepts`, `scout`, `agents`, `alerts`, `events`, `capacity`,
   `config`, `cycles`, `misc`, `observability`, `openviking`, `usage`, `backlog`,
   and the `autopilot` log routes.

This is the exact dynamic ADR-0009/ADR-0011 name: *one adapter is a hypothetical
Seam, two adapters are a real Seam — and the lint rule is the mechanism that
converts a hypothetical Seam into a real one.* The query Seam reached "two
adapters" via #909 but **never got its ratchet**, so it decayed back toward a
hypothetical: live code teaches two contradictory query-reading patterns
(`aggregatorRoute`/`safeParse` vs raw `parseInt` + `@ts-expect-error`), and a
handler copying the wrong neighbour is the real cost in an AI-navigated codebase.

The "pain" ADR-0011 asked for has surfaced — not as a runtime bug (a bad
`?count=` silently defaults), but as **pattern divergence + a self-documented
migration TODO that never finished.** That is the trigger to revisit.

## Decision

Bring `req.query` validation **into scope** for GET read routes, on ADR-0011's
own mechanic.

1. **Enforced invariant: every GET handler that reads `req.query` reads it
   through a `src/schemas/*` zod schema** — either via
   `aggregatorRoute(schema, …)` (validate + never-throw-500 isolation, the
   #909 seam) OR via an inline `safeParse(QuerySchema)` where the route's error
   handling is bespoke. **The Seam is the schema, not the wrapper** — mirroring
   ADR-0011's body decision, where the schema is the boundary contract and the
   *response* stays the handler's business. A handler never reads
   `req.query.<field>` directly; it reads typed fields off the parsed result.

2. **One home for the repeated coercion.** `src/schemas/common.ts` exports a
   `countQuerySchema(defaultN)` factory (the `parseInt(req.query.count) || N`
   idiom — the actually-duplicated logic) and a boolean-flag coercion helper
   (the `=== "1" || === "true"` idiom). The existing v2 `count` schemas fold
   onto the factory opportunistically.

3. **Out of scope (accepted exceptions, listed on the baseline):**
   `req.params` (one-off, low volume, conventionally typed); proxy
   pass-through routes that forward the *whole* query string downstream rather
   than reading named fields (e.g. `reflections.ts` building
   `URLSearchParams(req.query)`); and request *bodies* (owned by ADR-0011,
   unchanged).

4. **CI enforcement.** A new `scripts/ci/query-seam-check.ts` — a thin Adapter
   over the shared baseline-ratchet engine `scripts/ci/seam-check-lib.ts`
   (#950), exactly as `schema-seam-check.ts` is — forbids a GET handler segment
   that reads `req.query.<field>` without a `safeParse(req.query…)` in that same
   segment (a segment delegating to `aggregatorRoute(schema, …)` reads no raw
   `req.query.<field>` and so is clean by construction). Enforced via a
   shrink-only `scripts/ci/query-seam-baseline.json`. The job lands in the
   **existing `.github/workflows/schema-seam.yml` sibling workflow — never
   `ci.yml`** (exact-match Verifier Core, ADR-0015), mirroring ADR-0011's
   2026-06-02 amendment and the `coupling-check.yml` precedent.

5. **Migration is sliced per HTTP router** (mirroring ADR-0011's slicing so it
   isn't re-debated per PR), worst-drift first, ratchet lands last:

   1. **`metrics.ts` + `src/schemas/common.ts` foundation.** 7 `count` routes
      (all 8 `@ts-expect-error`s) + the `date` param. `quality-gates` keeps its
      `// AC: never 500` 200-empty fallback via inline `safeParse` (it does NOT
      go through `aggregatorRoute`'s hard 500).
   2. **`learning.ts` + `reflections.ts`.** Learning-surface reads (`limit`,
      `agent`/`reference`/`type`/`files`/`anchor`). The `reflections` whole-query
      proxy line is an accepted exception (§3).
   3. **`anchor.ts` + `capacity.ts` + `scout.ts`.** `limit`/`window` numeric +
      `excludeInFlight`/`excludeMerged` boolean cluster.
   4. **`design-concepts.ts` + `agents.ts` + `openviking.ts` +
      `observability.ts` + `misc.ts`.** Mixed string/numeric reads.
   5. **Singletons:** `alerts`, `events`, `config`, `cycles`, `usage`,
      `backlog`, and the `autopilot.ts` log routes (`limit`/`tail`).
   6. **Closure:** land `query-seam-check.ts` + baseline + the
      `schema-seam.yml` job; ship the `ubiquitous-language` PR broadening the
      **Schemas** glossary entry (drop the "excludes query" caveat).

6. **Tier classification.** Slices 1–5 are **Tier 3** (`src/api/*` +
   `src/schemas/*`; not Verifier Core). Slice 6 is **Tier 3** too — the gate is
   a *sibling* workflow, not `ci.yml`, so it stays auto-mergeable (the whole
   point of the `schema-seam.yml` precedent). The baseline file is enforced by
   the lint script, not the tier-gate.

## Consequences

### Positive

- **One read-route pattern.** `src/api/*` stops teaching two contradictory
  query-reading idioms; a subagent copying a neighbour copies the right one.
- **The `@ts-expect-error — migrate to proper types` markers are deleted** —
  the type is inferred from the schema, not suppressed.
- **Schema = type** for query shapes, as it already is for bodies.
- **AI-navigability:** the query contract for an endpoint lives in a schema
  file, not buried in handler `parseInt` calls.
- **Re-decay is structurally blocked** — the ratchet is the part #909 was
  missing; this closes the loop it left open.

### Negative

- ~7 PRs (6 slices + the `ubiquitous-language` glossary PR).
- **Slices 3–5 are diminishing-returns consistency migrations** of code that is
  already mostly correct (a bad `?force=` or `?window=` already defaults
  sanely). They are migrated for *one-pattern enforceability*, not bug-fixing —
  the honest cost of closing a Seam rather than spot-fixing it. ADR-0011
  accepted the identical trade for bodies.
- One more shrink-only baseline artifact (`query-seam-baseline.json`) joins
  `schema-seam-baseline.json` / `redis-seam-baseline.json`.

### Risks accepted

- **Per-route leverage is marginal** (ADR-0011 was right about that). We accept
  the *consistency + enforceability* value over per-route bug prevention; the
  decay this ADR fixes is a navigability/maintainability cost, not a correctness
  one.
- **The ratchet is a grep, not an AST check** — false negatives if a handler
  destructures `req.query` into a typed local first. Backstop: a code review
  that re-introduces raw query reads in a GET handler is a rejected PR
  regardless of the lint result (same backstop ADR-0011 names).
- **Proxy/whole-query routes need explicit baseline entries** as accepted
  exceptions; missing one would false-positive the gate.

## Alternatives considered

- **Shared `parseCount(req)` coercion helper, no schemas.** Rejected: kills the
  `@ts-expect-error`s cheaply but creates a *third* query pattern (shim-routes
  vs `aggregatorRoute`-routes vs body-seam) and leaves the divergence in place.
  Cheaper today, more divergent forever.
- **Keep ADR-0011 Scope B (do nothing).** Rejected: live code (#909 + 5 query
  schemas) already contradicts the stated scope, and convention-only adoption
  demonstrably decayed — doing nothing buys the same rot again.
- **Grow `aggregatorRoute` with a `fallback`/`onError` param** so 200-on-error
  routes (e.g. `quality-gates`) stay on the wrapper. Rejected: grows the seam
  API for n=1. Enforce the *schema*, not the *wrapper* — bespoke-error routes
  `safeParse` inline and keep their own catch, exactly as ADR-0011 lets body
  routes own their response.
- **Convention only, no ratchet.** Rejected: that is precisely what produced the
  current state. ADR-0011's own thesis (lint rule = the thing that makes a Seam
  real) applies verbatim.
- **Expand scope to `req.params` and GET-with-body.** Rejected: low volume,
  conventionally typed; a separate boundary if pain ever surfaces.

## Related

- ADR-0009 — Redis Adapters Seam. Source of the shrink-only-baseline /
  per-Module-slicing / lint-lands-last closure mechanic this ADR reuses.
- ADR-0011 — Schemas Seam for HTTP request bodies. This ADR supersedes its
  "Scope B" `req.query` rejection; the body scope is unchanged.
- ADR-0015 — Verifier Core / `ci.yml` exact-match. Why the gate lands in the
  `schema-seam.yml` sibling workflow, not `ci.yml`.
- Issue #909 — `aggregatorRoute` query-validation seam (the ad-hoc precedent
  this ADR formalizes).
- Issue #893 — `schema-seam-check` body ratchet (the mechanic this ADR mirrors).
- Issue #950 — shared `seam-check-lib.ts` engine (`query-seam-check` is a thin
  Adapter over it).
- CONTEXT.md term: **Schemas** (scope line broadened by the `ubiquitous-language`
  PR in slice 6).
