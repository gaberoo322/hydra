---
status: accepted
---

# ADR-0039: The dependency graph is a seam Hydra owns; extractors are swappable producers

Hydra builds a module dependency graph of its own `src/` and renders it in two dashboard
panels. The whole system is 1,024 lines:

| Module | Lines | Role |
|---|---|---|
| `src/aggregators/architecture-graph.ts` | 291 | `scanArchitecture()` — extraction + group derivation |
| `src/api/architecture.ts` | 236 | `rankTangledModules()` (Tarjan SCC), 60s cache, route |
| `src/aggregators/repo-graph.ts` | 220 | `getCouplingReport()` — coupling markdown for prompts |
| `src/aggregators/architecture-layout.ts` | 135 | pure 2D packing |
| `dashboard/.../TangledModules.jsx` + `ArchitectureTab.jsx` | 142 | the two surfaces |

Of that, the **extraction loop is ~47 lines** built on a single regex —
`/from\s+["'](\.\.?\/[^"']+?)(?:\.ts)?["']/g`. It misses dynamic `import('./x')`, bare
side-effect `import './x'`, and re-export chains, and it only walks `src/**/*.ts`. The
graph behind both dashboard panels is therefore a known undercount.

Sitting next to a 108k-star third-party tool that does this properly, those 47 lines read
as obvious tech debt. The proposal to replace them with **Graphify** has now arrived
**twice** — #3948 (filed from ADR-0033 Decision 10, closed `wontfix` 2026-08-12) and an
operator grilling session on 2026-08-20. It will arrive a third time. ADR-0033 Decision 7
learned this exact lesson about the retired semantic-search lane: a decision recorded only
as an absence reads as an oversight and invites re-proposal.

The second pass moved the deciding axis, and that move is what this ADR records. The
question is no longer "is Graphify a good tool" — it is good. The question is whether it can
be the **foundation** for a graph capability that must eventually span `~/hydra`,
`~/hydra-betting`, and an open-ended set of future target repos in arbitrary languages.
Measured against that, the answer is no, and the reasons are structural rather than
matters of taste.

## Decision

### Decision 1 — The dependency graph is a seam Hydra owns

Hydra owns an internal seam whose shape is `getGraph(repo) -> ArchitectureGraph`. Every
consumer — `GET /api/architecture`, `TangledModules`, `ArchitectureTab`,
`getCouplingReport()`, and any future dispatch-prompt block — binds to **the seam**, never
to a producer's artifact, CLI, or client library.

This is the load-bearing decision. The alternative posture — build orchestrator
functionality *around* a third-party graph tool — puts a dependency you do not control
inside the control plane, where its release cadence becomes your release cadence. With the
seam, a producer's breaking change costs one adapter.

Do not let a producer's vocabulary leak through the seam. `ArchitectureNode` /
`ArchitectureEdge` are Hydra's types; a producer's node ids, edge-confidence tags, or
artifact schema are translated at the adapter boundary and never surface to consumers.

### Decision 2 — For TypeScript repos the producer is a real resolver, not a regex and not tree-sitter

`~/hydra` and `~/hydra-betting/web` are both fully-typed TypeScript with `tsc --noEmit` in
required CI. For such a repo the TypeScript compiler is a **sound and complete** answer to
"what depends on X" — it resolves `tsconfig` paths, re-export chains, type-only imports,
and dynamic imports exactly.

Replace the 47-line regex with a real resolver behind the seam. Consumers do not change;
`test/aggregator-architecture-graph.test.mts`, `test/api-architecture.test.mts`,
`test/knowledge-base-repo-graph.test.mts` and `test/builder-page.test.mts` already pin the
observable behaviour.

A tree-sitter graph is **strictly weaker than `tsc` for TypeScript** — it parses syntax
without resolving types, which is why Graphify tags its own edges `EXTRACTED` / `INFERRED`
/ `AMBIGUOUS`, and why its TS resolution carries live defects (Graphify #2340: a
`${configDir}` in `tsconfig` `paths` is joined literally, dropping *every* aliased import in
a TS 5.5 monorepo; #2810: distinct same-file symbols collapse after ID normalization — a
regression in the then-current v0.9.45). Trading a lossy regex for a lossy AST parse when a
sound resolver is already installed is settling.

**Do not read this as "no third-party tooling."** It is scoped to the TypeScript case,
where the sound oracle happens to be free.

### Decision 3 — Graphify is a candidate *producer*, not a substrate

Graphify is not rejected as a tool. It is rejected as a **foundation**, on four findings
taken at v0.9.48 (2026-08-20):

1. **Pre-1.0 with no stability contract.** Ten releases in the ten days to 2026-08-20;
   branches `v1` … `v8`, i.e. eight major lines in the 4.5 months since 2026-04-03.
   `ARCHITECTURE.md` documents no `graph.json` schema version and no API stability
   guarantee.
2. **Multi-repo — the axis that actually matters here — is its largest open gap.** True
   cross-repo linking exists only as an unmerged community PR (#2134). `merge-graphs`
   unions repos side-by-side and carries a correctness bug (#2873: edges to undeclared
   nodes materialise phantom nodes; external modules fragment per repo). The
   multi-repo questions are open and, in #2703's case, unanswered: #2703, #585, #1177,
   #2702, #1687.
3. **Extension is fork-and-patch, not a plugin system.** `ARCHITECTURE.md` prescribes
   adding an `extract_<lang>(path) -> dict` function inside `extract.py` and registering
   suffixes in dispatch logic. For "many targets in arbitrary languages" that means
   carrying a fork or upstreaming against a fast-moving pre-1.0 project.
4. **Commercial trajectory.** Graphify Labs is a company (graphify.com); #2735 adds
   "governed gateway routing and production graph queries". Apache-2.0 protects the code
   that exists, not the roadmap.

The favourable finding, recorded so it is not lost: Graphify **does** expose a real
programmatic Python surface — `ARCHITECTURE.md` states "the skill orchestrates the library;
the library can be used standalone", with modules passing plain dicts and NetworkX graphs
and no shared state outside `graphify-out/`. That is what makes it viable as a *producer*
behind Decision 1's seam once Decision 6's evidence exists.

### Decision 4 — A third-party producer runs out-of-band against a canonical checkout, never inside a dispatch worktree

Every code-writing dispatch runs in a fresh `git worktree` at a **new absolute path** — a
harness-enforced invariant, not a convention.

Graphify's incremental mode is structurally incompatible with that. Its `manifest.json` and
`cache/stat-index.json` key on **absolute file paths** (#1964, open since 2026-07-17), so
the same repo at a different path reports 100% of files new and 100% deleted, forcing a full
rebuild. Full rebuild is not cheap: #1958 records `detect()` CPU-bound past 35 minutes on a
16k-file monorepo, with the time going to per-path ignore evaluation rather than IO.

Therefore any third-party producer runs **scheduled, out-of-band, against the canonical
checkout at a stable absolute path** (`/home/gabe/hydra`, `/home/gabe/hydra-betting`),
which sidesteps #1964 entirely because the path never changes. The resulting graph is served
as data-plane state from the orchestrator on :4000; dispatches **read** it over HTTP and
never build it. This keeps a non-Node toolchain confined to one host process instead of
every worktree.

Staleness becomes an explicit, measurable property — emit `generatedAt` and derive
unknown / stale / ready per ADR-0034 §5, exactly as `/api/architecture` already does. Never
let a consumer assert freshness it cannot verify.

### Decision 5 — Multi-repo union happens at Hydra's query layer, keyed by repo

The seam is keyed by repo (`getGraph(repo)`). Cross-repo composition — if it is ever needed
— is implemented in Hydra's own query layer over per-repo graphs. Do **not** delegate it to
a producer's cross-repo feature.

This follows from Decision 3 finding 2 (the feature is unmerged and the shipped path is
buggy) and is consistent with ADR-0002: one Target per orchestrator instance, with
additional targets served by additional instances rather than by namespacing inside one.
Per-repo graphs compose; a producer-merged blob does not decompose.

### Decision 6 — A polyglot producer needs a measurement before adoption, not after

ADR-0033 retired OpenViking partly because its value was never measurable. Do not repeat
that.

Before adopting any third-party graph producer, instrument the claim it is supposed to
serve: **split first-CI-failure causes into structural** (unresolved import, broken caller,
signature mismatch) **versus semantic** (policy, state machine, test isolation, prompt
contract). The 2026-08-20 baseline, from the 25 most recent `fix(` commits and 0 reverts in
300 commits, is that the structural bucket is approximately **empty** — the failures were
policy and state-machine errors, wrong premises, test isolation, and dispatch-contract
compliance.

If wiring `getCouplingReport()` into the dispatch prompt does not move that number, a richer
graph will not move it either. A producer is adopted when the structural bucket is
non-trivial **and** a producer demonstrably shrinks it — not because the graph is more
detailed.

### Decision 7 — This decision is revisited only on a named trigger

To stop a fourth ad-hoc re-proposal, the triggers are enumerated. Reopen when **any** holds:

- Hydra takes on a target repo in a language `tsc` cannot analyse, and Decision 6's
  structural bucket is non-trivial for it.
- Graphify reaches 1.0 with a documented `graph.json` schema version, **and** #1964
  (absolute-path manifest) is fixed, **and** cross-repo linking is merged and shipped.
- A structural question is demonstrably blocking work that the seam's TS producer,
  `npm run ast-search`, and `npm run probe-search` together cannot answer — with the
  blocked dispatch cited.

Absent a named trigger, "replace the graph with $TOOL" is answered by this ADR.

## Consequences

**The 47 lines get fixed, and that was always the real debt.** Decision 2 removes the
regex undercount, which improves both dashboard panels, `getCouplingReport()`, and any
future prompt block from one change.

**Graphify would not have retired most of the 1,024 lines anyway.** The other ~977 are
consumers shaped to Hydra's own semantics — path-derived group membership, Tarjan
tangledness ranking, the 60s route cache, ADR-0034's trust contract, the two panels. A
producer swap adds a `graph.json` → `ArchitectureNode` adapter; it deletes none of them.
Anyone arguing debt reduction should price the adapter, the toolchain, and the freshness
contract against the 47 lines removed.

**`getCouplingReport()` has exactly one consumer today** — the `hydra-architecture-scan`
playbook, via a hardcoded absolute path. Wiring it into the `dev_orch` prompt is the cheap
pre-hoc structural context that Decision 6 measures, and it needs no new dependency.

**A non-Node toolchain on the host stays an open ADR-0005 question.** Decision 4 confines
the blast radius to one scheduled host process, but it does not pre-approve the toolchain.
#3948 declined it and #3910 (mise) closed `wontfix`; reversing either is an operator
decision made on its own merits, in its own PR — never as a side effect of adopting a tool.

**Accepted risk.** A sound TS-only graph means non-TS targets have no graph until a producer
is justified. That is deliberate: the first such target is itself a named Decision 7
trigger, and building the polyglot path before there is a polyglot target is the
speculative-generality failure ADR-0013 warns about.

## Alternatives considered

Recorded because ADR-0037 Decision 4 keeps this section for alternatives that would
otherwise be re-proposed — and both of these already have been.

**Adopt Graphify as the substrate and build orchestrator functionality on it.** Rejected —
Decision 3. Its multi-repo capability, which is the specific thing a many-targets future
needs, is unmerged; its incremental mode is defeated by worktree isolation; and a pre-1.0
project with eight major lines in 4.5 months and no schema contract inside the control plane
means its churn becomes Hydra's churn.

**Adopt Cartograph (`sndwrks/cartograph`).** Rejected outright, and more firmly. Assessed
2026-08-20 at 3 days old, 1 star, 20 commits, 1 contributor, requiring a Docker Compose
stack (FastAPI + React + MCP server + Postgres/pgvector), an `ANTHROPIC_API_KEY` billed as
metered console credits rather than subscription, and a `VOYAGE_API_KEY` — with the README's
own worked example at ~$24 to enrich an ~8,000-node repo. That is a structural
re-implementation of the knowledge plane ADR-0033 retired nine days earlier: self-hosted
containers, a vector store, an embedding backend, LLM-generated summaries, an HTTP seam, and
a corpus with a staleness problem. It fails the maintenance gate on its own, and it fails
ADR-0033's reasoning again.

**Keep the regex and do nothing.** Rejected — the undercount is real, it silently weakens
both dashboard panels and the coupling report, and leaving it in place is what makes the
"replace it with $TOOL" proposal recur.

**Leave a vacant socket for a future producer.** ADR-0033 Decision 2 deliberately refused
this for semantic search, and that refusal stands for *that* capability. Decision 1 is not
the same thing: the seam here has live consumers today (`/api/architecture`, both panels,
`getCouplingReport()`), so it is a seam with callers, not an empty socket waiting for a
plug. A seam nothing calls would be the anti-pattern; this one is load-bearing on the day it
lands.
