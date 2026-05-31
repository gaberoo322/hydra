---
status: accepted
---

# The design-concept canonical-ref invariant lives at the persistence seam

A design-concept artifact is keyed by its `anchorRef`. That ref must be **canonical** (`issue-<N>`) wherever it is used as a key, because the autopilot signal path, the `collect-state.sh` probe, and the slot `anchor` field all read the `issue-<N>` form (issue #736). The invariant — *a design concept is stored under, and only under, its canonical key* — belongs in exactly one place: the persistence seam (`src/redis/design-concept.ts`), where the key is constructed. Callers pass whatever ref form they hold; canonicalization is the accessor's job.

This was previously enforced one layer too high — three `normalizeAnchorRef` calls in the `src/design-concept.ts` domain module (save, get, approve), with the accessor keying raw. The accessor's interface carried an **unstated precondition** ("pass me an already-canonical ref"). The #736 orphaned-artifact bug was precisely a caller — the grill writer — violating that precondition: it persisted under `hydra:design-concept:736` while every reader probed `issue-736`, so `GET /api/design-concepts/736` → 200 but `.../issue-736` → 404, and `design_concept_orch` re-grilled forever.

## Decision

1. **Canonicalize at the seam.** The `anchorRef` parameter is normalized at the entry of every ref-taking accessor function in `src/redis/design-concept.ts` (`saveDesignConceptHash`, `getDesignConceptHash`, `setDesignConceptField`, `removeDesignConceptFromIndex`). After this, the unstated precondition is gone: any ref form a caller holds resolves to the canonical key.

2. **Normalize the parameter, not just `dcHashKey()`.** The accessor uses `anchorRef` in **two** key-shaped positions — the hash key suffix (`dcHashKey`) and the index ZSET member (`zadd(DC_INDEX_KEY, createdAt, anchorRef)`). Both must agree. Normalizing inside `dcHashKey()` alone would canonicalize the hash key while leaving a raw index member, splitting a `"736"` artifact across two index entries. `saveDesignConceptHash` normalizes once and uses the canonical value for both positions.

3. **`normalizeAnchorRef` is a keying concern and lives in the accessor.** Its sole purpose is computing the canonical key — it is used only at keying sites. It moves into `src/redis/design-concept.ts`; `src/design-concept.ts` re-exports it for back-compat and the existing `#736` test. This keeps `src/redis/*` a leaf (it does not import from the domain module) while siting the rule where the key is built — consistent with ADR-0009's "key shape lives behind the accessor function."

4. **The domain module stops normalizing.** `src/design-concept.ts` drops its three `normalizeAnchorRef` calls, and `approveDesignConcept` stops normalizing the same ref twice (it currently normalizes inside `getDesignConcept(anchorRef)` and again at the write site).

## Considered options

- **Deduplicate in the domain layer, keep the accessor raw (status quo, tidied).** Normalize once in the domain and pass the canonical ref down. Rejected: the accessor keeps its unstated precondition, so a future fourth domain function — or any new caller of the accessor — can reintroduce the #736 class of bug. The invariant still has no structural owner.
- **Normalize inside `dcHashKey()` only.** Rejected per decision 2 — corrupts the index member, splitting an artifact across two index entries.
- **Park `normalizeAnchorRef` in a neutral pure-util both layers import.** Considered and rejected as unnecessary indirection: the function is purely a design-concept keying concern with one consumer family. The accessor is its natural home; a shared util would be a home for a generality that does not exist.

## Consequences

- The canonical-ref invariant is enforced once, structurally. The #736 bug — and any future variant where a caller forgets to normalize — becomes impossible regardless of which ref form is supplied.
- **Locality:** the rule is one fact in one place (the accessor), not three domain call sites plus an absent guard at the seam.
- **Test surface:** canonicalization is testable directly against the accessor (`save("736")` → `get("issue-736")` round-trips; the index holds exactly one member), instead of implicitly through the domain layer three times.
- **Backward-compatible:** existing artifacts were written through the current domain normalization, so every input maps to the identical key. No data migration.
- Blast radius: `src/design-concept.ts` + `src/redis/design-concept.ts`, no Verifier-Core paths → **Tier 3** (ADR-0015).
- Implementation tracked in #797.

## Related

- ADR-0008 — the design-concept gate (this artifact is what the gate consumes).
- ADR-0009 / ADR-0017 — Redis seam; the accessor owns key shape. Canonicalizing the ref into its key is part of "key shape lives behind the function" (Category A, shared domain state).
- Issue #736 — the orphaned-artifact bug this invariant prevents.
