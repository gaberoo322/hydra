# hitl-grill: baseline-ratchet load/write helpers reimplemented outside the already-consolidated seam-check-lib.ts engine

> Parked by /hydra-architecture-scan on 2026-09-21 against the Orchestrator (~/hydra).
> Reason: Worth exploring.
> hitl-grill is a terminal park state: no agent actions this - the operator grills it into real work or dismisses it.

## Problem

scripts/ci/seam-check-lib.ts (368 lines) already generalized the "read a JSON baseline with ENOENT/malformed fallback, then --write-baseline write" ritual for the redis / github / host-probe / schema Seam checks - its own docblock says "Every Seam check used to inline the same machinery four times... This module concentrates the duplicated engine into one Interface." 12 files under scripts/ci/ now import it.

That consolidation never reached the separate baseline-ratchet family that gates skill size, target coupling, and test-typecheck counts. Each hand-rolls its own readFile then JSON.parse then catch-ENOENT-return-default then writeFile(..., null, 2) pair, and the shapes have already diverged:

- scripts/ci/skill-size-ratchet.ts loadBaseline (line 306) returns null on a missing/malformed baseline.
- scripts/ci/target-coupling-check.ts loadBaseline / writeBaselineFile (lines 456, 466) return a typed default object with a note field ("baseline not yet seeded").
- scripts/ci/test-typecheck-check.ts loadBaseline / writeBaselineFile (lines 129, 138) - a third variant of the same idea.
- scripts/ci/test-subject-map.ts has an inline --update-baseline write (lines 341-347) with no shared helper at all.

## Idea (plain English - no interface design)

Extend (or sibling) the seam-check-lib.ts pattern to cover this second baseline-ratchet family - most likely a small generic like loadJsonBaseline less-than T greater-than(path, fallback) plus a matching writeJsonBaseline, so skill-size-ratchet.ts, target-coupling-check.ts, test-typecheck-check.ts, and test-subject-map.ts share one read/write primitive instead of four (going on five) hand-rolled copies with silently-diverging fallback conventions.

## Why parked

Worth exploring, not Strong: the payload SHAPES genuinely differ per check (a bare violations list vs. a bare count vs. a subject-count map), so this isn't a pure "delete 3 copies and import 1" move the way the already-filed architecture-scan issue for readChangedFiles is - it needs a small generic abstraction designed carefully, and this codebase's own seam-check-lib.ts precedent (and its explicit doc-commented "genuinely ignorant of per-seam exemptions" discipline) argues for doing that design deliberately rather than as a mechanical agent dispatch. That judgment call is why this is parked for operator triage rather than filed as needs-triage agent-steering work.

## Files in scope

- scripts/ci/seam-check-lib.ts (the existing consolidated engine to extend or sibling)
- scripts/ci/skill-size-ratchet.ts (loadBaseline, line 306)
- scripts/ci/target-coupling-check.ts (loadBaseline / writeBaselineFile, lines 456-472)
- scripts/ci/test-typecheck-check.ts (loadBaseline / writeBaselineFile, lines 129-138)
- scripts/ci/test-subject-map.ts (inline --update-baseline write, lines 341-347)
