# The global reflection buffer is retired; Reflections is per-anchor + by-file only

Status: Accepted
Date: 2026-06-09
Deciders: Operator + Hydra (Learning Context normalization epic #1452)
Issue: #1453 (this delta), parent #1452

## Context

**Reflections** is the Reflexion-style episodic store that records *what failed, why, and what to try differently* after a non-merged cycle outcome. Two surfaces are live and load real episodic narrative into the next dispatch:

- **Per-anchor reflections** (#193) — keyed by anchor (`hydra:reflections:{anchor}`), loaded into the next attempt at the same anchor. Never dropped before another learning block (retry correctness).
- **By-file reflections** (#326) — loaded into any anchor touching the same files.

Alongside these, the codebase still carried a third, **global/type-level reflection buffer**: a single bounded list (`hydra:reflections:buffer`, capped at `MAX_BUFFER_SIZE`) written via `recordReflection`/`pushReflection`, read via `loadRelevantReflections`/`getReflectionBuffer`, consolidated via `consolidateReflections`, and surfaced as the `global-reflections` member of the `LearningContextSource` union (a third Reflections block in `getContext()`). It was also reachable through `GET /api/reflections` with no `anchor` (the `getAllReflections` branch).

That buffer is **dead**: when the Codex CLI control loop was removed ([ADR-0006](./0006-codex-cli-removed-autopilot-only.md)), the producers that fed the global buffer were severed, but the consumers were left in place. Nothing writes to `hydra:reflections:buffer` in the autopilot-only world; `loadGlobalReflectionsBlock` always returns an empty/`miss` block, and the `global-reflections` source is a permanently-empty third Reflections surface that bloats the **Learning Context** trace and the source enumeration without ever contributing context. The same pattern that left `reflectionMatchSource` always `'none'` after the Codex removal (the learning-loop severance documented in the project memory) left this buffer stranded.

## Decision

**The global/type-level reflection buffer is retired. Reflections has exactly two surfaces — per-anchor (#193) and by-file (#326) — and the `LearningContextSource` union has four members (`agent-memory`, `knowledge-base`, `per-anchor-reflections`, `by-file-reflections`), not five.**

Concretely (the code removal is tracked separately under #1454; this ADR records the decision and its ubiquitous-language consequences):

- The global-buffer API (`recordReflection`, `loadRelevantReflections`, `formatReflectionsForPrompt`, `clearReflectionsForAnchor`, `getAllReflections`, `consolidateReflections`, the `GlobalReflection` type, `MAX_BUFFER_SIZE`) and its Redis buffer accessors (`pushReflection`, `getReflectionBuffer`, `replaceReflectionBuffer`, the `hydra:reflections:buffer` key) are deleted. The per-anchor/outcome accessors (`countReflectionKeys`, `getReflectionOutcomes`) stay — they are not the buffer.
- `getContext()` composes four blocks; `loadGlobalReflectionsBlock`, the `global-reflections` union member, and its `LEARNING_DROP_PRIORITY` entry are removed.
- `GET /api/reflections` requires an `anchor` (the no-anchor mode-1 branch is gone); the schema makes `anchor` required.

## Considered options

- **Keep the buffer, re-wire a producer.** Rejected: there is no operator demand for a cross-anchor global episodic surface, and the two real surfaces (per-anchor, by-file) already cover the retry-learning need. Reviving a dead surface to justify its existence is the opposite of the "retire what the Codex removal stranded" cleanup.
- **Leave it dead but in place.** Rejected: a permanently-empty `global-reflections` block lies in the Learning Context source enumeration and the `/api/learning/context-trace` trace, making the composition contract dishonest about how many surfaces exist (the trace is meant to be the honest test surface for "what context a subagent receives", #804).
- **Bundle the glossary/ADR delta into the code-removal PR.** Rejected per the CONTEXT-MAP WRITE contract: ubiquitous-language deltas (glossary, ADRs) ship as their own PR, separate from the code change (#1454).

## Consequences

- The **Learning Context** has four sources, not five; the **Reflections** glossary entry and the learning-surfaces relationships bullet in [`CONTEXT.md`](../../CONTEXT.md) are updated to say Reflections contributes two blocks.
- `GET /api/reflections` is anchor-scoped only; any caller relying on the no-anchor "all reflections" mode must pass an anchor.
- The cleanup reduces the Reflexion surface to exactly what the autopilot-only architecture feeds, removing a source of confusion about which reflection paths are live.

## Glossary delta

In [`CONTEXT.md`](../../CONTEXT.md): the **Learning Context** entry drops `global-reflections` from the `source` enumeration (now four sources); the learning-surfaces relationships bullet states **Reflections** contributes two blocks (`per-anchor-reflections`, `by-file-reflections`), not three. The **Reflections** entry was already per-anchor + by-file and needs no wording change.

## Related

- [ADR-0006](./0006-codex-cli-removed-autopilot-only.md) — the Codex CLI removal that severed the buffer's producers while leaving its consumers (the root of the dead code).
- #193 (per-anchor reflections), #326 (by-file reflections) — the two surviving Reflections surfaces.
- #804 — Learning Context as an ordered list of typed blocks (the honest trace this cleanup keeps honest).
- #1452 (parent epic), #1454 (code removal), #1455 (read normalization).
