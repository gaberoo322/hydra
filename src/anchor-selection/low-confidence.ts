// ---------------------------------------------------------------------------
// Low-confidence skip — prevent idle-spin loops on dead-on-arrival anchors
// ---------------------------------------------------------------------------

import { incrPermSkip } from "../redis/anchors.ts";

/**
 * Called by the control loop when the confidence gate rejects an anchor.
 * Increments the perm-skip counter for codebase-health anchors so
 * selectAnchor() falls through to the work queue on the next cycle
 * instead of returning the same dead-on-arrival anchor repeatedly.
 */
export async function markLowConfidenceSkip(anchor: any): Promise<void> {
  if (anchor?.type !== "codebase-health") return;
  const ref = anchor.reference || "";
  if (!ref) return;
  const count = await incrPermSkip(ref);
  console.log(`[AnchorSelection] Marked low-confidence skip for "${ref}" (permSkip=${count})`);
}
