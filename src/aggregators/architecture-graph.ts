/**
 * Architecture-graph aggregator (issue #1411, epic #1410).
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
 *   `node:fs/promises`. Tests pass stubs that return a synthetic directory
 *   listing + file bodies so the scanner runs with no real I/O.
 *
 * The group taxonomy (`GROUPS` / `GROUP_MAP`), the canvas layout constants,
 * and the per-group grid positions (`GROUP_POSITIONS`) are module-level
 * constants here — they were closure-scoped inside the route file before.
 */

import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Group taxonomy — update these when major architectural boundaries shift.
// ---------------------------------------------------------------------------

// Group definitions updated in PR-3 (issue #383): the entire "agents" group
// (codex-runner / executor-agent / planner-prompt / preflight) plus the
// control-loop / pipeline-steps / verification / post-merge / holdback /
// gate modules in the "core" and "quality" groups were deleted along with
// the in-process codex control loop. Autopilot subagents own execution
// now and are tracked outside this orchestrator-internal architecture
// graph.
export const GROUPS = [
  { id: "core", label: "Core Loop", color: "emerald",
    modules: ["index", "cycle"] },
  { id: "agents", label: "Agents (legacy / stubs)", color: "blue",
    modules: ["context-builder"] },
  { id: "quality", label: "Quality & Verification", color: "amber",
    modules: ["codebase-health"] },
  { id: "knowledge", label: "Knowledge & Learning", color: "purple",
    modules: ["knowledge-indexer", "learning", "reflections", "agent-memory", "pattern-detector", "prompt-evolution", "repo-map", "grounding", "ov-session"] },
  { id: "state", label: "State & Data", color: "cyan",
    modules: ["redis", "event-bus", "cycle-tracking", "metrics"] },
  { id: "planning", label: "Planning & Research", color: "rose",
    modules: ["research-loop", "project-goals", "anchor-candidates"] },
  { id: "infra", label: "Infrastructure", color: "zinc",
    modules: ["api", "notify", "digest", "cleanup", "instrument", "merge"] },
];

export const GROUP_MAP: Record<string, { id: string; label: string; color: string }> = {};
for (const g of GROUPS) {
  for (const m of g.modules) GROUP_MAP[m] = { id: g.id, label: g.label, color: g.color };
}

// ---------------------------------------------------------------------------
// Layout constants — canvas is ~1400px wide, groups arranged in rows.
// ---------------------------------------------------------------------------

export const GROUP_POSITIONS: Record<string, { x: number; y: number }> = {
  core:      { x: 0, y: 0 },
  agents:    { x: 500, y: 0 },
  quality:   { x: 0, y: 280 },
  knowledge: { x: 500, y: 280 },
  state:     { x: 0, y: 560 },
  planning:  { x: 500, y: 560 },
  infra:     { x: 1000, y: 0 },
};

const NODE_W = 150;
const NODE_H = 36;
const NODE_GAP_X = 16;
const NODE_GAP_Y = 12;
const GROUP_PAD = 20;
const COLS_PER_GROUP = 3;

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

export interface ArchitectureEdge {
  from: string;
  to: string;
}

export interface ArchitectureGroup {
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
   * Directory lister — returns the entry names of `srcDir`. Defaults to
   * `node:fs/promises` `readdir`. Tests inject a stub returning a synthetic
   * file list.
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
 * Scan `srcDir` for `.ts` modules, parse their relative imports into an
 * edge list, and lay the nodes out on a grouped grid.
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
  const importRe = /from\s+["']\.\/([^"']+?)(?:\.ts)?["']/g;

  const srcDir = deps.srcDir ?? resolveDefaultSrcDir();
  const readdir = deps.readdir ?? fsReaddir;
  // Default readFile pins utf-8 so the dep contract is `(path) => Promise<string>`
  // (the bare node:fs/promises readFile returns Buffer | string).
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path, "utf-8"));
  const now = deps.now ?? new Date();

  const files = (await readdir(srcDir)).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".d.ts")
  );

  const moduleNames = files.map((f) => f.replace(/\.ts$/, ""));
  const moduleSet = new Set(moduleNames);

  // Parse imports for each module
  const edges: ArchitectureEdge[] = [];
  const inDegree: Record<string, number> = {};
  const outDegree: Record<string, number> = {};
  for (const m of moduleNames) { inDegree[m] = 0; outDegree[m] = 0; }

  for (const file of files) {
    const mod = file.replace(/\.ts$/, "");
    const content = await readFile(resolve(srcDir, file));
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    importRe.lastIndex = 0;
    while ((match = importRe.exec(content)) !== null) {
      const target = match[1];
      if (moduleSet.has(target) && target !== mod && !seen.has(target)) {
        seen.add(target);
        edges.push({ from: mod, to: target });
        outDegree[mod] = (outDegree[mod] || 0) + 1;
        inDegree[target] = (inDegree[target] || 0) + 1;
      }
    }
  }

  const groupBounds: Record<string, { x: number; y: number; w: number; h: number }> = {};

  const nodes: ArchitectureNode[] = moduleNames.map((mod) => {
    const group = GROUP_MAP[mod] || { id: "other", label: "Other", color: "zinc" };
    return {
      id: mod,
      label: mod.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
      group: group.id,
      inDegree: inDegree[mod] || 0,
      outDegree: outDegree[mod] || 0,
      x: 0,
      y: 0,
    };
  });

  // Compute positions per group
  const byGroup: Record<string, ArchitectureNode[]> = {};
  for (const n of nodes) {
    (byGroup[n.group] ??= []).push(n);
  }

  for (const [gid, members] of Object.entries(byGroup)) {
    const base = GROUP_POSITIONS[gid] || { x: 1000, y: 560 };
    members.forEach((n, i) => {
      const col = i % COLS_PER_GROUP;
      const row = Math.floor(i / COLS_PER_GROUP);
      n.x = base.x + GROUP_PAD + col * (NODE_W + NODE_GAP_X);
      n.y = base.y + GROUP_PAD + 28 + row * (NODE_H + NODE_GAP_Y); // 28 for group label
    });
    const maxCol = Math.min(members.length, COLS_PER_GROUP);
    const maxRow = Math.ceil(members.length / COLS_PER_GROUP);
    groupBounds[gid] = {
      x: base.x,
      y: base.y,
      w: GROUP_PAD * 2 + maxCol * NODE_W + (maxCol - 1) * NODE_GAP_X,
      h: GROUP_PAD * 2 + 28 + maxRow * NODE_H + (maxRow - 1) * NODE_GAP_Y,
    };
  }

  const groupsOut: ArchitectureGroup[] = GROUPS.map((g) => ({
    ...g,
    bounds: groupBounds[g.id] || { x: 0, y: 0, w: 0, h: 0 },
  }));

  // Add "other" group if any modules don't fit
  if (byGroup["other"]) {
    groupsOut.push({
      id: "other", label: "Other", color: "zinc", modules: byGroup["other"].map((n) => n.id),
      bounds: groupBounds["other"] || { x: 1000, y: 560, w: 300, h: 200 },
    });
  }

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
// Default src-dir resolution — mirrors the route's former HYDRA_ROOT logic.
// ---------------------------------------------------------------------------

function resolveDefaultSrcDir(): string {
  const root = process.env.HYDRA_ROOT || resolve(process.env.HOME ?? process.cwd(), "hydra");
  return resolve(root, "src");
}
