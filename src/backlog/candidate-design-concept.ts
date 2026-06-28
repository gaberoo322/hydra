// ---------------------------------------------------------------------------
// Candidate Design-Concept Annotation — the per-candidate design-concept block.
// ---------------------------------------------------------------------------
//
// Extracted from `src/anchor-candidates.ts` (issue #2499), mirroring the
// `src/backlog/candidate-scoring.ts` (#2040), `src/backlog/candidate-eligibility.ts`
// (#2066), `src/backlog/merged-refs.ts` (#1880), and
// `src/backlog/work-queue-hygiene.ts` (#1844) extractions that pulled
// co-located concerns out of the same file.
//
// This module owns the design-concept ANNOTATION POLICY for the Candidate Feed
// (issue #628): given an anchor reference and a clock, read the persisted
// design-concept artifact (`hydra:design-concept:{anchorRef}`) and project it
// into the flat `CandidateDesignConcept` block decide.py's
// `design_concept_orch` selector consumes per candidate.
//
// The policy this module owns:
//   - present — artifact exists for the anchor
//   - isFresh — within DESIGN_CONCEPT_MAX_AGE_MS of createdAt
//   - status  — `draft` | `approved` | `stale` | null; `stale` is a DERIVED
//               label (artifact exists but aged out of freshness), so this
//               module decides it, not the store.
//   - gateOk  — `gateCheck(d, now).ok`
//
// Never-throws invariant (ADR-0016): a failing design-concept read degrades to
// the ABSENT_DESIGN_CONCEPT projection rather than throwing — a failing
// annotation must NEVER drop a candidate from the feed. The internal try/catch
// here is the first line of that defence; the feed loop in
// `anchor-candidates.ts` also wraps the injected `loadDesignConcept` dep so an
// injected throwing stub is shielded too.
//
// `loadDesignConceptImpl` is the production reader; it is wired into
// `CandidateFeedDeps.loadDesignConcept` via `resolveDeps` in
// `anchor-candidates.ts`, so it stays the injectable test seam — existing tests
// that stub `loadDesignConcept` keep passing unchanged.

import {
  getDesignConcept,
  type DesignConcept,
  gateCheck,
  isFresh as isDesignConceptFresh,
} from "../design-concept.ts";

// ---------------------------------------------------------------------------
// Per-candidate design-concept annotation (issue #628).
// ---------------------------------------------------------------------------

/**
 * Design-concept annotation surfaced per candidate. decide.py's
 * `design_concept_orch` selector consumes this block:
 *   - present  — artifact exists in `hydra:design-concept:{anchorRef}`
 *   - isFresh  — within DESIGN_CONCEPT_MAX_AGE_MS of createdAt
 *   - status   — `draft` | `approved` | `stale` | null (when absent)
 *   - gateOk   — `gateCheck(d, now).ok`
 */
export interface CandidateDesignConcept {
  present: boolean;
  isFresh: boolean;
  status: "draft" | "approved" | "stale" | null;
  gateOk: boolean;
}

/**
 * The "no artifact" projection. Returned when no design concept exists for an
 * anchor, when the anchor reference is empty, or when any read failure degrades
 * the annotation (the never-drop-a-candidate fallback).
 */
export const ABSENT_DESIGN_CONCEPT: CandidateDesignConcept = {
  present: false,
  isFresh: false,
  status: null,
  gateOk: false,
};

/**
 * Production design-concept reader + projection. Always returns a fully
 * populated block (even when no artifact exists). On any Redis failure returns
 * the "no artifact" projection rather than throwing — a failing annotation
 * must NEVER drop a candidate from the feed.
 */
export async function loadDesignConceptImpl(
  anchorRef: string,
  now: number,
): Promise<CandidateDesignConcept> {
  if (!anchorRef) return ABSENT_DESIGN_CONCEPT;
  try {
    const dc: DesignConcept | null = await getDesignConcept(anchorRef);
    if (!dc) return ABSENT_DESIGN_CONCEPT;
    const fresh = isDesignConceptFresh(dc, now);
    const gate = gateCheck(dc, now);
    return {
      present: true,
      isFresh: fresh,
      // `stale` is a derived label: artifact exists but aged out of freshness.
      status: fresh ? dc.status : "stale",
      gateOk: gate.ok,
    };
  } catch (err: any) {
    console.error(
      `[CandidateFeed] design-concept load failed for "${anchorRef.slice(0, 60)}": ${err.message}`,
    );
    return ABSENT_DESIGN_CONCEPT;
  }
}
