/**
 * Pure 2D layout math for the architecture-graph aggregator (issue #3052).
 *
 * Extracted from `src/aggregators/architecture-graph.ts` so the row-packing
 * algorithm and its tuning constants have a focused, zero-IO home. This leaf
 * grows when dashboard canvas geometry or packing strategy changes; the FS-walk
 * scanner in `architecture-graph.ts` grows when import-parsing logic changes —
 * two independent axes, two files.
 *
 * Design contract:
 * - **Pure**: no filesystem, no network, no Redis, no clock.
 * - **Downward import edge**: `architecture-graph.ts` imports from this leaf
 *   (same pattern as `ov-upload.ts` ← `indexer.ts`).
 * - **Mutation by design**: `computeGroupLayout` MUTATES each node's `x`/`y`
 *   in place — the nodes are the same objects the caller put into `byGroup`.
 *   This is intentional and unchanged from the inline original.
 * - **No upward import**: this leaf does not import from `architecture-graph.ts`.
 *   The `LayoutNode` interface below is the structural minimum the algorithm
 *   reads and writes; the richer `ArchitectureNode` in `architecture-graph.ts`
 *   satisfies it structurally (TypeScript structural typing).
 */

// ---------------------------------------------------------------------------
// Layout types and constants
// ---------------------------------------------------------------------------

/**
 * Structural minimum a node must expose for the layout algorithm.
 * `ArchitectureNode` (from `architecture-graph.ts`) satisfies this structurally
 * — no import required, no circular dependency.
 */
export interface LayoutNode {
  x: number;
  y: number;
}

/** Tunable layout geometry — deterministic row-packing on a ~1400px canvas. */
export interface LayoutConstants {
  NODE_W: number;
  NODE_H: number;
  NODE_GAP_X: number;
  NODE_GAP_Y: number;
  GROUP_PAD: number;
  GROUP_LABEL_H: number;
  COLS_PER_GROUP: number;
  CANVAS_W: number;
  GROUP_GAP: number;
}

/** Default layout geometry. Callers may pass an override into the layout fn. */
export const LAYOUT_DEFAULTS: LayoutConstants = {
  NODE_W: 150,
  NODE_H: 36,
  NODE_GAP_X: 16,
  NODE_GAP_Y: 12,
  GROUP_PAD: 20,
  GROUP_LABEL_H: 28,
  COLS_PER_GROUP: 3,
  CANVAS_W: 1400,
  GROUP_GAP: 40,
};

export type GroupBounds = { x: number; y: number; w: number; h: number };

// ---------------------------------------------------------------------------
// Pure layout algorithm
// ---------------------------------------------------------------------------

/**
 * Pack the bucketed group map onto a bounded 2D canvas (issue #2246).
 *
 * Deterministic dynamic layout: groups sorted by id, row-packed left to right;
 * a group that would overflow the canvas wraps to a new row whose y-offset
 * clears the tallest group of the previous row. Non-overlap holds for ANY
 * derived group count by construction.
 *
 * Pure w.r.t. I/O — no filesystem, clock, or network. It DOES mutate each
 * node's `x`/`y` in place (the nodes are shared with the caller's `byGroup`),
 * exactly as the inline original did, and returns the per-group bounding boxes
 * plus the same mutated node list. Byte-for-byte the coordinates the inline
 * code produced.
 *
 * `T extends LayoutNode` means any superset of `{x, y}` works — including
 * `ArchitectureNode` — without importing it here.
 */
export function computeGroupLayout<T extends LayoutNode>(
  byGroup: Record<string, T[]>,
  layout: LayoutConstants = LAYOUT_DEFAULTS,
): { nodes: T[]; groupBounds: Record<string, GroupBounds> } {
  const {
    NODE_W,
    NODE_H,
    NODE_GAP_X,
    NODE_GAP_Y,
    GROUP_PAD,
    GROUP_LABEL_H,
    COLS_PER_GROUP,
    CANVAS_W,
    GROUP_GAP,
  } = layout;

  const sortedGroupIds = Object.keys(byGroup).sort();
  const groupBounds: Record<string, GroupBounds> = {};
  let cursorX = 0;
  let cursorY = 0;
  let rowMaxH = 0;

  for (const gid of sortedGroupIds) {
    const members = byGroup[gid];
    const cols = Math.min(members.length, COLS_PER_GROUP);
    const rows = Math.ceil(members.length / COLS_PER_GROUP);
    const w = GROUP_PAD * 2 + cols * NODE_W + (cols - 1) * NODE_GAP_X;
    const h = GROUP_PAD * 2 + GROUP_LABEL_H + rows * NODE_H + (rows - 1) * NODE_GAP_Y;

    if (cursorX > 0 && cursorX + w > CANVAS_W) {
      cursorX = 0;
      cursorY += rowMaxH + GROUP_GAP;
      rowMaxH = 0;
    }

    members.forEach((n, i) => {
      const col = i % COLS_PER_GROUP;
      const row = Math.floor(i / COLS_PER_GROUP);
      n.x = cursorX + GROUP_PAD + col * (NODE_W + NODE_GAP_X);
      n.y = cursorY + GROUP_PAD + GROUP_LABEL_H + row * (NODE_H + NODE_GAP_Y);
    });

    groupBounds[gid] = { x: cursorX, y: cursorY, w, h };
    cursorX += w + GROUP_GAP;
    rowMaxH = Math.max(rowMaxH, h);
  }

  const nodes = sortedGroupIds.flatMap((gid) => byGroup[gid]);
  return { nodes, groupBounds };
}
