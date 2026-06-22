# ADR-0024: API versioning & deprecation strategy (registry-first, no migration yet)

Status: Accepted
Date: 2026-06-22
Deciders: Operator + Hydra (via the design-concept artifact for issue #2352)
Related: ADR-0011 (Schemas Seam for request bodies), ADR-0022 (query-param Schemas Seam), ADR-0014 (simplicity discipline), README (data plane)

## Context

The orchestrator data plane (the Express service on port 4000, mounted under
`/api` in `src/api.ts`) has grown to **154 routes across 45 router modules** (as
of `cdb04ab` — the issue's "67+" estimate is already stale; the surface roughly
doubled). All routes live under a single unversioned `/api` prefix. There is:

- **No URL/header versioning** — every route is `/api/<path>`, no `v1`/`v2`.
- **No deprecation path** — there is no convention for marking a route
  experimental, deprecated, or sunset, and no notice period for breaking it.
- **No backward-compatibility policy** — the dashboard, the skill subagents
  (`hydra-dev`, `hydra-qa`, `hydra-autopilot`, …), and `decide.py` all consume
  this surface directly, so a breaking change to any route silently breaks an
  unknown set of consumers.

Two pressures make this worth deciding now rather than later:

1. The **dashboard simplification plan** (19 pages → 4) will reshape the
   `now/*`, `today/*`, `outcomes/*`, `explore/*` surface — exactly the routes
   most likely to be retired or merged. Retiring a route today is an undocumented
   guess about who still calls it.
2. **Schema validation already has two ADRs** (ADR-0011 bodies, ADR-0022
   queries) that pin the *contract* of each route's input. Versioning is the
   missing piece: ADR-0011/0022 say "this is the shape of a valid request to
   this route"; nothing says "this route exists, here is its stability, here is
   how it will be removed."

This is the classic "the surface grew faster than its governance" problem. The
honest framing, per ADR-0014 (simplicity discipline): we do **not** have a
concrete breaking-change need today, so executing a full `v1/` migration now
would be speculative complexity that breaks every consumer for zero present
benefit. What we lack is the *baseline and the policy*, not the migration.

## Decision

**Adopt a registry-first strategy: catalog the surface now, choose the
versioning mechanism to apply *when first needed*, and define the deprecation
policy — but execute no route migration in this ADR.**

### 1. Endpoint Registry (the baseline)

`src/api/ENDPOINT-REGISTRY.md` is the canonical catalog of every endpoint:
method, full path (`/api` + the router's path literal), and a stability column
(`stable` / `experimental` / `deprecated`). It is **descriptive, not
normative** — it records routes, it does not generate or enforce them; adding a
`router.<verb>(...)` registration is still the only way to add an endpoint. The
registry states its extraction methodology and an as-of commit + count so it is
reproducible and its staleness is detectable, not asserted. All 154 current
routes are `stable`; the lifecycle columns exist for the first route to change.

### 2. Versioning mechanism — chosen, deferred in execution

When a breaking change to a live route is first actually needed, version it with
a **`/api/v2/<path>` URL prefix** (the unversioned `/api/<path>` is implicitly
`v1` and is kept serving until its deprecation sunset). Rationale for URL-prefix
over the two alternatives:

- **URL prefix** (`/api/v2/foo`) — chosen. Visible in logs, trivially routable
  in Express (`api.use("/v2", v2Router)`), cache-key-clean, and a consumer
  pins a version by changing a string constant. The cost (path duplication
  during a migration window) is bounded by the deprecation policy below.
- **Query-param versioning** (`?api_version=2`) — rejected: invisible in route
  registration, pollutes every query schema (colliding with the ADR-0022 query
  seam), and is easy to omit silently (defaults to an ambiguous version).
- **Date/Accept-header versioning** (`Accept: …;version=2026-06`) — rejected as
  over-engineered for an internal-first surface (ADR-0014): it is the right tool
  for a large public API with many external integrators, which this is not.

**This mechanism is recorded, not executed.** No `v2` prefix is introduced by
this ADR. The first PR that genuinely needs a breaking change will be the first
to add `/api/v2/...`, and it will cite this ADR.

### 3. Deprecation policy

When a route must be removed or breaking-changed:

1. **stable → deprecated.** Flip the registry stability column to `deprecated`
   with a one-line sunset note (target date or "after consumer X migrates").
   The route keeps working.
2. **Notice period.** A deprecated route is kept serving for **at least one
   dashboard deploy cycle AND until the registry shows no remaining consumer**,
   whichever is longer. Because the consumers are first-party (dashboard,
   skills, `decide.py`), "notice" means migrating those callers, not waiting on
   external integrators.
3. **Migration path.** If a `v2` replacement exists, the deprecated route may
   `302`/proxy to it during the window, or simply coexist; the registry row
   names the replacement.
4. **Sunset.** Once no consumer remains, delete the route and its registry row
   in a single PR that cites the deprecation entry.

### 4. Schemas seam is unchanged

Versioning wraps the **URL/header surface**; it does not touch per-route input
validation. ADR-0011 (request bodies) and ADR-0022 (query params) remain the
source of truth for *what a valid request to a route looks like*. A `v2` route
gets its own `src/schemas/*` schema exactly as a `v1` route does. This ADR adds
no schema-versioning mechanism — a `v2` schema is just a new schema.

### 5. `src/api.ts` stays a thin mount point

Per the `CONTEXT.md` "API routes in sub-routers" convention, `src/api.ts`
registers zero routes today and continues to. A future `v2` lands as
`api.use("/v2", createV2FooRouter())` — still a mount line, no handler logic in
`src/api.ts`.

### 6. Tier classification

This ADR + the registry are **documentation-only (Tier 1)**: two new markdown
files (`docs/adr/0024-api-versioning.md`, `src/api/ENDPOINT-REGISTRY.md`), zero
`.ts` changes, zero behavior change. `npm test` / `tsc` / the build are
unaffected. The eventual `v2`-prefix execution PRs will be Tier 3 (they touch
`src/api/*`), classified live at that time.

## Consequences

### Positive

- **A breaking change is no longer a blind guess.** The registry says which
  routes exist and (incrementally) who consumes them, so the dashboard
  simplification can retire routes with a paper trail.
- **The versioning decision is made once, cheaply.** The next person needing a
  breaking change applies a recorded strategy instead of re-litigating it.
- **No speculative complexity.** No `v2` machinery exists until a real need
  pulls it in (ADR-0014). The cost paid today is two markdown files.
- **The seam boundary is explicit.** Versioning owns the URL surface; Schemas
  (ADR-0011/0022) own the request contract — no overlap, no contradiction.

### Negative

- The registry is **hand-maintained** (regenerated via its documented recipe),
  so it can drift between updates. Mitigation: the as-of commit + count make
  drift detectable; a future phase could wire a CI freshness check (out of
  scope here — that would be a runtime/code change beyond Tier 1).
- Per-route **consumer attribution is deferred** — the registry annotates
  consumers at the router-group level, not per route. Filling the per-route
  consumer column is incremental follow-up.

### Risks accepted

- **Deferring the migration means the unversioned surface persists** until a
  real breaking change arrives. Accepted: paying for `v1/v2` plumbing before a
  need exists is the exact speculative complexity ADR-0014 warns against.
- **A hand-maintained registry can lie** if someone adds a route without
  updating it. Backstop: a reviewer re-runs the extraction recipe when touching
  the API surface; the count mismatch surfaces the drift.

## Alternatives considered

- **Auto-generated OpenAPI spec via a runtime introspection endpoint.**
  Rejected for now: adds a runtime code/dependency surface, exceeding the
  docs-only Tier-1 scope. A worthwhile *later* phase once the registry proves
  the surface is worth machine-describing.
- **Immediate `v1/` URL-prefix migration of all 154 live routes.** Rejected:
  premature — it breaks every dashboard/skill/`decide.py` consumer with no
  migration need yet. This ADR records the chosen strategy; it deliberately
  does not execute it.
- **Per-endpoint stability annotations as code decorators on each route file.**
  Rejected: requires touching every `src/api/*.ts` route (out of docs-only
  scope) and scatters the catalog across 45 files. The single registry markdown
  carries the stability/consumer columns instead.

## Glossary impact

Introduces the term **Endpoint Registry** — the canonical descriptive catalog of
the data-plane HTTP surface (`src/api/ENDPOINT-REGISTRY.md`). It is *not* a
synonym for **data plane** (which is the broader README term for the whole
:4000 service). Promoting "Endpoint Registry" into `CONTEXT.md` is a separate
`ubiquitous-language`-labelled PR per the `docs/agents/domain.md` WRITE
contract, not part of this code PR.
