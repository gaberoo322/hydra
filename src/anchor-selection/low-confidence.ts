// ---------------------------------------------------------------------------
// Low-confidence skip — prevent idle-spin loops on dead-on-arrival anchors
// ---------------------------------------------------------------------------

import { incrKey, expireKey } from "../redis-adapter.ts";
import { PERM_SKIP_PREFIX, ABANDONMENT_COUNTER_TTL } from "./constants.ts";

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
  const permSkipKey = PERM_SKIP_PREFIX + ref.replace(/\s+/g, "-").slice(0, 120);
  const count = await incrKey(permSkipKey);
  await expireKey(permSkipKey, ABANDONMENT_COUNTER_TTL);
  console.log(`[AnchorSelection] Marked low-confidence skip for "${ref}" (permSkip=${count})`);
}
