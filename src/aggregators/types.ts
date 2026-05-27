/**
 * Shared types for Dashboard v2 aggregators (issue #616 onwards).
 *
 * Kept separate from `overnight-summary.ts` so the slice-2 aggregators
 * (decision-queue, stuck-items, recent-merges, target-backlog-findings,
 * lessons-overnight) can reuse the same discriminated-string vocabulary
 * without circular imports.
 */

export type HeadroomLevel = "green" | "yellow" | "red" | "unknown";

// ---------------------------------------------------------------------------
// Slice-2 vocabulary (issue #617)
// ---------------------------------------------------------------------------

/**
 * Where a `DecisionItem` originated. The decision-queue aggregator unifies
 * three distinct sources into one list; the `source` discriminator lets the
 * dashboard render a small badge so the operator can see at a glance
 * whether an item came from the overnight decision-queue digest issue,
 * the persistent `ready-for-human` label, or the `needs-info` waiting
 * lane.
 */
export type DecisionItemSource =
  | "operator-decision-queue"
  | "ready-for-human"
  | "needs-info";

/**
 * Why an item is "stuck". Pure classifier output — each bucket has its own
 * age threshold (see `stuck-items.ts`).
 */
export type StuckCategory =
  | "blocked-over-2d"
  | "needs-info-waiting"
  | "pr-with-failed-ci";
