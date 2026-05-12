// ---------------------------------------------------------------------------
// Kanban queued-lane tier — priority-sorted backlog items
// ---------------------------------------------------------------------------
//
// Uses atomic claim (Lua script) so concurrent Claude Code cycles can't grab
// the same item. GATED by WIP limit (checked inside the Lua script). Drift-
// duplicate items are blocked in Kanban so subsequent cycles fall through to
// other sources.

import { _admin, block } from "../backlog.ts";
import { isAnchorDriftDuplicate } from "./drift-filter.ts";

const { claimNextQueuedItem } = _admin;

export interface KanbanAnchor {
  type: "user-request";
  reference: string;
  whyNow: string;
  context: any;
  description: any;
  // Issue #312: marker so post-merge.ts can distinguish kanban-claimed
  // user-request anchors from work-queue user-request anchors (which never
  // live on the kanban board). Used by isKanbanAnchor() in backlog.ts.
  _fromKanban: true;
}

export interface KanbanResult {
  anchor: KanbanAnchor | null;
  wipBlocked: boolean;
}

/**
 * Try to claim the next queued backlog item. Returns:
 *   - anchor: the claimed item, or null if none claimed (no item, drift, or WIP)
 *   - wipBlocked: true when the atomic claim reports WIP-limit, so the caller
 *     can short-circuit subsequent WIP-gated tiers (active specs).
 */
export async function selectKanbanAnchor(): Promise<KanbanResult> {
  try {
    const claimResult = await claimNextQueuedItem("codex");
    if (claimResult.claimed && claimResult.item) {
      const queuedItem = claimResult.item;
      console.log(`[ControlLoop] Claimed queued backlog item: ${queuedItem.id} (priority ${queuedItem.priority || 0}) — "${queuedItem.title}"`);
      const candidate: KanbanAnchor = {
        type: "user-request",
        reference: queuedItem.title,
        whyNow: `Queued backlog item ${queuedItem.id} (priority ${queuedItem.priority || 0})`,
        context: queuedItem.description || null,
        description: queuedItem.description || null,
        _fromKanban: true,
      };
      // Drift pre-filter (issue #233) — block the kanban item if it's a
      // near-duplicate of a recent cycle so we don't burn planner cost.
      const driftResult = await isAnchorDriftDuplicate(candidate);
      if (driftResult.drift) {
        try {
          await block(
            queuedItem.title,
            `Drift pre-filter: ${Math.round(driftResult.match!.similarity * 100)}% similar to "${driftResult.match!.taskTitle}" from ${driftResult.match!.cycleId}`,
          );
        } catch (err: any) {
          console.error(`[ControlLoop] Failed to block drift-duplicate kanban item: ${err.message}`);
        }
        // Fall through to subsequent sources rather than returning null —
        // a non-duplicate may still be available below.
        return { anchor: null, wipBlocked: false };
      }
      return { anchor: candidate, wipBlocked: false };
    }
    if (claimResult.reason === "wip-limit") {
      console.log(`[ControlLoop] WIP limit reached via atomic claim (${claimResult.count} in-progress)`);
      return { anchor: null, wipBlocked: true };
    }
  } catch (err: any) {
    console.error(`[ControlLoop] Failed to claim queued backlog: ${err.message}`);
  }
  return { anchor: null, wipBlocked: false };
}
