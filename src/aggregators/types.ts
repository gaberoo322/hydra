/**
 * Shared types for Dashboard v2 aggregators (issue #616 onwards).
 *
 * Kept separate from `overnight-summary.ts` so future aggregators
 * (decision-queue, stuck-items, etc. — slices 2+) can reuse the same
 * discriminated-string vocabulary without circular imports.
 */

export type HeadroomLevel = "green" | "yellow" | "red" | "unknown";
