# Domain Docs

How the engineering skills (`improve-codebase-architecture`, `diagnose`, `tdd`, `grill-with-docs`, etc.) consume this repo's domain documentation.

## Layout: multi-context

Start at [`../../CONTEXT-MAP.md`](../../CONTEXT-MAP.md):

- **[`CONTEXT-MAP.md`](../../CONTEXT-MAP.md)** (repo root) — the index. Maps each `src/<domain>/` to the glossary terms and ADRs that govern it.
- **[`CONTEXT.md`](../../CONTEXT.md)** (repo root) — the cross-cutting glossary (system-wide terms + relationships). Always read first.
- **`src/<domain>/CONTEXT.md`** — per-domain glossary, created lazily as terms get resolved. Glossary-only — no implementation prose.
- **[`../adr/`](../adr/)** — system-wide architectural decisions. Read the ones touching your area.

## Before exploring, read these

- `CONTEXT-MAP.md`, then the root `CONTEXT.md`, then any co-located `src/<domain>/CONTEXT.md` for the area you're touching.
- The ADRs the map flags for that area.

If a co-located `CONTEXT.md` doesn't exist yet, **proceed silently** — don't flag its absence and don't pre-create it. `/grill-with-docs` creates them lazily when terms actually get resolved.

## Use the glossary's vocabulary

When your output names a domain concept (issue title, refactor proposal, hypothesis, test name), use the term exactly as the glossary defines it; don't drift to the synonyms each entry's `_Avoid_` line lists. If the concept isn't in any glossary, that's a signal — either you're inventing language the project doesn't use (reconsider), or there's a real gap (resolve with `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0009 (Redis seam typed accessors) — but worth reopening because…_

## WRITE contract

When a code change resolves a new term or makes a decision worth recording, open a **separate** `ubiquitous-language`-labelled PR for the glossary/ADR delta — do not bundle it with the code PR. Code-writing subagents declare `Glossary impact` / `ADR impact` in every code PR body.

## Full-suite test flakes are resolved — a fresh-worktree green is trustworthy (issue #1231)

`npm test` runs serial files (`--test-concurrency=1`) and is deterministic-green whether or not OpenViking/Ollama is reachable and regardless of host `HYDRA_AUTOPILOT_*` env. The historically-flaky trio (`test/semantic-dedup.test.mts`, `test/autopilot-args.test.mts`, `test/autopilot-heartbeat.test.mts`) now asserts each function's **contract**, not an environment-specific value, so they no longer depend on OV liveness or a host budget/scope drop-in. Do **not** re-run the stash-and-diff-against-master ritual to "confirm a flake pre-exists" — trust the green. If a Redis-touching test needs a guaranteed-clean keyspace, use the backstop `test/_helpers/redis-db.mts` (`useCleanRedisDb()`) rather than relying on another file's `after()` cleanup.

## The target repo (`~/hydra-betting`)

The **Target** has its own parallel contract that target-dispatched subagents (`hydra-target-build`, `hydra-target-sweep`, `hydra-target-research`) follow — it is *not* this repo's:

- `~/hydra-betting/CONTEXT-MAP.md` — index of per-context glossaries
- `~/hydra-betting/web/src/lib/<context>/CONTEXT.md` — per-context glossary (glossary-only)
- `~/hydra-betting/docs/adr/` + `~/hydra-betting/web/src/lib/<context>/docs/adr/` — system-wide + context-scoped ADRs
- `~/hydra-betting/docs/agents/domain.md` — the canonical target READ + WRITE contract

`hydra-grill` (scope=target) carries the structural READ load — the design-concept artifact already contains the issue-relevant vocabulary before a target build is dispatched. `hydra-target-build` then applies the co-located rule (read any `CONTEXT.md` sibling of an edited file) for residual terms and declares `Glossary impact` / `ADR impact` in every code PR body.
