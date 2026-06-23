/**
 * Shared backlog-reconciliation constants (issue #2387).
 *
 * This is a true leaf module: it imports NOTHING from `reconciler.ts`,
 * `stale-escalation.ts`, or any other backlog module. It exists to break the
 * mutual import that previously coupled `reconciler.ts` (which owned
 * `RECONCILE_LANES`) and `stale-escalation.ts` (which imported the constant
 * back from the reconciler that extracted it in issue #2138). Both modules now
 * import `RECONCILE_LANES` from here, so the reconciler ↔ stale-escalation edge
 * is strictly acyclic: the only remaining edge is `reconciler.ts` importing
 * `escalateStaleItems` from `stale-escalation.ts` (unidirectional).
 */

/**
 * Lanes the merge→done reconciler and the stale-claim escalation pass both
 * sweep. `blocked` is deliberately EXCLUDED (reconciler design-concept
 * invariant 3): it is an operator-attention lane — a blocked item with a merged
 * PR still needs its blocker resolved by a human/agent decision, never a silent
 * auto-done. The blocked-item re-escalation chore surfaces merged-but-blocked
 * items instead. `done` is excluded for idempotency.
 */
export const RECONCILE_LANES = ["inProgress", "queued", "backlog"] as const;
