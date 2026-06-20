/**
 * Architecture-graph aggregator (issue #1411, epic #1410; taxonomy deepened
 * in issue #1772).
 *
 * Extracted out of `src/api/architecture.ts` so the module-dependency
 * scanner is a pure function with injectable filesystem deps — testable
 * without spawning the Express server or touching the real `src/` tree.
 *
 * # Design contract (mirrors src/aggregators/overnight-summary.ts)
 *
 * - **Pure aggregator.** No Express, no module-global cache, no side
 *   effects. The only inputs are the `srcDir` to scan and the injectable
 *   `readdir` / `readFile` deps. The 60s response cache that the dashboard
 *   route used to keep is owned by the route caller now, not this scanner —
 *   the pure scan re-derives the graph from the filesystem on every call.
 * - **Deterministic output.** Given the same directory listing and file
 *   contents, the returned nodes / edges / groups / layout are identical.
 *   `scannedAt` is the one non-deterministic field; tests can ignore it.
 * - **FS injection.** `deps.readdir` / `deps.readFile` default to
 *   `node:fs/promises`. The default lister is RECURSIVE (`readdir(dir,
 *   { recursive: true })`) and returns srcDir-relative posix paths; tests
 *   pass stubs that return a synthetic recursive listing + file bodies so
 *   the scanner runs with no real I/O.
 *
 * # Group taxonomy — derived from the filesystem, not maintained by memory
 *
 * Before #1772 the taxonomy was a hard-coded `GROUPS` constant listing
 * individual module names; it drifted as modules were added/retired (ghost
 * entries like `context-builder` survived the #383 control-loop deletion).
 * Group membership is now DERIVED from each module's path:
 *
 * - a module under `src/<dir>/` belongs to group `<dir>` (first path
 *   segment under src/);
 * - a flat top-level `src/<name>.ts` module belongs to the `root` group
 *   ("Top-level") — its location, directly in src/, is the classifier.
 *
 * `GROUP_META` below is DISPLAY metadata only (label + color overrides for
 * group ids whose titlecased directory name reads poorly). It never decides
 * membership, and a `GROUP_META` key with no modules on disk emits no group
 * — only observed, non-empty groups appear in the output. A brand-new
 * `src/<dir>/` self-registers with a deterministic default label (titlecased
 * dir name) and palette color, with ZERO edits to this file.
 *
 * Layout is computed dynamically (deterministic row-packing over the derived
 * group list, sorted by group id) — the former fixed 7-slot
 * `GROUP_POSITIONS` grid assumed a hand-maintained group count.
 */

import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { posix, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Group display metadata — label/color overrides only; membership is derived
// from module paths (see header). Keys with no modules on disk emit nothing.
// ---------------------------------------------------------------------------

export const GROUP_META: Record<string, { label: string; color: string }> = {
  root: { label: "Top-level", color: "emerald" },
  api: { label: "API Routes", color: "blue" },
  github: { label: "GitHub", color: "zinc" },
  redis: { label: "Redis Adapters", color: "cyan" },
  "knowledge-base": { label: "Knowledge Base", color: "purple" },
};

/** Deterministic fallback palette for directories without a GROUP_META entry. */
const COLOR_PALETTE = ["emerald", "blue", "amber", "purple", "cyan", "rose", "zinc"];

function titleCase(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Display metadata for a derived group id: the GROUP_META override when one
 * exists, else a deterministic default (titlecased dir name + palette color
 * from a stable char-code hash) so unknown directories self-register.
 */
function groupMetaFor(groupId: string): { label: string; color: string } {
  const meta = GROUP_META[groupId];
  if (meta) return meta;
  let hash = 0;
  for (const ch of groupId) hash = (hash + ch.charCodeAt(0)) % COLOR_PALETTE.length;
  return { label: titleCase(groupId), color: COLOR_PALETTE[hash] };
}

/**
 * Group id for a module id (srcDir-relative path without `.ts`): the first
 * path segment for subdirectory modules, `root` for flat top-level files.
 */
function deriveGroupId(moduleId: string): string {
  const slash = moduleId.indexOf("/");
  return slash === -1 ? "root" : moduleId.slice(0, slash);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArchitectureNode {
  id: string;
  label: string;
  group: string;
  inDegree: number;
  outDegree: number;
  x: number;
  y: number;
}

interface ArchitectureEdge {
  from: string;
  to: string;
}

interface ArchitectureGroup {
  id: string;
  label: string;
  color: string;
  modules: string[];
  bounds: { x: number; y: number; w: number; h: number };
}

export interface ArchitectureGraph {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  groups: ArchitectureGroup[];
  moduleCount: number;
  edgeCount: number;
  scannedAt: string;
}

/**
 * Dependency-injection shape — every filesystem touchpoint of the scanner
 * lives here so tests can stub them and the aggregator stays pure. All
 * fields are optional; defaults wire up `node:fs/promises`.
 */
export interface ArchitectureGraphDeps {
  /**
   * Directory to scan for `.ts` modules. Defaults to
   * `${HYDRA_ROOT || ~/hydra}/src`.
   */
  srcDir?: string;
  /**
   * RECURSIVE directory lister — returns srcDir-relative posix paths of
   * every entry beneath `srcDir` (e.g. `["index.ts", "redis/anchors.ts"]`).
   * Defaults to `node:fs/promises` `readdir(dir, { recursive: true })`.
   * Tests inject a stub returning a synthetic recursive listing.
   */
  readdir?: (dir: string) => Promise<string[]>;
  /**
   * File reader — returns the UTF-8 body of a file. Defaults to
   * `node:fs/promises` `readFile`. Tests inject a stub mapping path → body.
   */
  readFile?: (path: string) => Promise<string>;
  /**
   * Wall-clock anchor for `scannedAt` — defaults to `new Date()`. Exposed so
   * tests can pin the timestamp.
   */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Recursively scan `srcDir` for `.ts` modules, parse their relative imports
 * (`./` and `../`, resolved against the importer's directory) into an edge
 * list, derive group membership from each module's path, and lay the nodes
 * out on a dynamically-packed grouped grid.
 *
 * Pure given the injected `readdir` / `readFile` — no cache, no Express.
 * The route caller owns response caching.
 */
export async function scanArchitecture(
  deps: ArchitectureGraphDeps = {},
): Promise<ArchitectureGraph> {
  // Declared per-call, NOT at module scope: a `/g` regex carries mutable
  // `lastIndex`, and this function `await`s `readFile` mid-loop. A hoisted
  // shared instance would let concurrent cache-miss scans interleave at the
  // await and corrupt each other's match position, silently producing wrong
  // edge sets. A fresh regex per invocation keeps each scan isolated.
  const importRe = /from\s+["'](\.\.?\/[^"']+?)(?:\.ts)?["']/g;

  const srcDir = deps.srcDir ?? resolveDefaultSrcDir();
  const readdir =
    deps.readdir ??
    ((dir: string) => fsReaddir(dir, { recursive: true }) as Promise<string[]>);
  // Default readFile pins utf-8 so the dep contract is `(path) => Promise<string>`
  // (the bare node:fs/promises readFile returns Buffer | string).
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path, "utf-8"));
  const now = deps.now ?? new Date();

  // Sorted for determinism regardless of the lister's traversal order.
  const files = (await readdir(srcDir))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort();

  const moduleNames = files.map((f) => f.replace(/\.ts$/, ""));
  const moduleSet = new Set(moduleNames);

  // Parse imports for each module
  const edges: ArchitectureEdge[] = [];
  const inDegree: Record<string, number> = {};
  const outDegree: Record<string, number> = {};
  for (const m of moduleNames) { inDegree[m] = 0; outDegree[m] = 0; }

  for (const file of files) {
    const mod = file.replace(/\.ts$/, "");
    const importerDir = posix.dirname(mod); // "." for flat top-level modules
    const content = await readFile(resolve(srcDir, file));
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    importRe.lastIndex = 0;
    while ((match = importRe.exec(content)) !== null) {
      // Resolve the `./`/`../` specifier against the importer's directory so
      // path-based ids match (e.g. `../event-bus` from api/foo → event-bus).
      const target = posix.normalize(posix.join(importerDir, match[1]));
      if (target.startsWith("..")) continue; // escapes srcDir — not a module
      if (moduleSet.has(target) && target !== mod && !seen.has(target)) {
        seen.add(target);
        edges.push({ from: mod, to: target });
        outDegree[mod] = (outDegree[mod] || 0) + 1;
        inDegree[target] = (inDegree[target] || 0) + 1;
      }
    }
  }

  const nodes: ArchitectureNode[] = moduleNames.map((mod) => ({
    id: mod,
    label: titleCase(posix.basename(mod)),
    group: deriveGroupId(mod),
    inDegree: inDegree[mod] || 0,
    outDegree: outDegree[mod] || 0,
    x: 0,
    y: 0,
  }));

  // Bucket nodes by derived group — only observed groups exist.
  const byGroup: Record<string, ArchitectureNode[]> = {};
  for (const n of nodes) {
    (byGroup[n.group] ??= []).push(n);
  }

  // Layout is now a pure, separately-testable step (issue #2246): the bucketed
  // group map → node coordinates + group bounding boxes, with no filesystem,
  // clock, or I/O. `scanArchitecture` is a two-step composition: graph
  // extraction (above) → layout (below).
  const { groupBounds } = computeGroupLayout(byGroup);
  const sortedGroupIds = Object.keys(byGroup).sort();

  const groupsOut: ArchitectureGroup[] = sortedGroupIds.map((gid) => ({
    id: gid,
    ...groupMetaFor(gid),
    modules: byGroup[gid].map((n) => n.id),
    bounds: groupBounds[gid],
  }));

  return {
    nodes,
    edges,
    groups: groupsOut,
    moduleCount: moduleNames.length,
    edgeCount: edges.length,
    scannedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pure layout algorithm (issue #2246; extracted from `scanArchitecture`).
//
// Takes the already-bucketed group map and packs the groups onto a bounded 2D
// canvas — no filesystem, no clock, no I/O. The layout constants live here, in
// the only scope that gives them meaning. `scanArchitecture` composes graph
// extraction (parse imports + derive group membership) with this layout step.
//
// SIDE EFFECT, by design and unchanged from the inline original: this MUTATES
// each node's `x`/`y` in place (the nodes are the same objects the caller put
// into `byGroup`). The returned `groupBounds` is the per-group bounding box,
// keyed by group id. Exported for direct unit test — NOT added to a public
// barrel; the on-wire `ArchitectureGraph` shape is unchanged.
// ---------------------------------------------------------------------------

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
 */
export function computeGroupLayout(
  byGroup: Record<string, ArchitectureNode[]>,
  layout: LayoutConstants = LAYOUT_DEFAULTS,
): { nodes: ArchitectureNode[]; groupBounds: Record<string, GroupBounds> } {
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

// ---------------------------------------------------------------------------
// Default src-dir resolution — mirrors the route's former HYDRA_ROOT logic.
// ---------------------------------------------------------------------------

function resolveDefaultSrcDir(): string {
  const root = process.env.HYDRA_ROOT || resolve(process.env.HOME ?? process.cwd(), "hydra");
  return resolve(root, "src");
}
