import { Router } from "express";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getCycleStatus } from "../cycle.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const SRC_DIR = resolve(HYDRA_ROOT, "src");

// Group definitions — update these when major architectural boundaries shift
const GROUP_MAP: Record<string, { id: string; label: string; color: string }> = {};
// Group definitions updated in PR-3 (issue #383): the entire "agents" group
// (codex-runner / executor-agent / planner-prompt / preflight) plus the
// control-loop / pipeline-steps / verification / post-merge / holdback /
// gate modules in the "core" and "quality" groups were deleted along with
// the in-process codex control loop. Autopilot subagents own execution
// now and are tracked outside this orchestrator-internal architecture
// graph.
const GROUPS = [
  { id: "core", label: "Core Loop", color: "emerald",
    modules: ["index", "cycle"] },
  { id: "agents", label: "Agents (legacy / stubs)", color: "blue",
    modules: ["context-builder"] },
  { id: "quality", label: "Quality & Verification", color: "amber",
    modules: ["codebase-health", "codebase-analyzer"] },
  { id: "knowledge", label: "Knowledge & Learning", color: "purple",
    modules: ["knowledge-indexer", "learning", "reflections", "agent-memory", "pattern-detector", "prompt-evolution", "repo-map", "grounding", "ov-session"] },
  { id: "state", label: "State & Data", color: "cyan",
    modules: ["redis-adapter", "redis-keys", "event-bus", "task-tracker", "task-machine", "metrics"] },
  { id: "planning", label: "Planning & Research", color: "rose",
    modules: ["research-loop", "project-goals", "anchor-selection", "anchor-scorer", "plan-cache"] },
  { id: "infra", label: "Infrastructure", color: "zinc",
    modules: ["api", "notify", "digest", "cleanup", "instrument", "merge", "prepare-workspace"] },
];

for (const g of GROUPS) {
  for (const m of g.modules) GROUP_MAP[m] = { id: g.id, label: g.label, color: g.color };
}

interface CachedGraph {
  nodes: any[];
  edges: any[];
  groups: any[];
  moduleCount: number;
  edgeCount: number;
  scannedAt: string;
}

let cachedGraph: CachedGraph | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

async function scanArchitecture(): Promise<CachedGraph> {
  if (cachedGraph && Date.now() - cacheTime < CACHE_TTL) return cachedGraph;

  const files = (await readdir(SRC_DIR)).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".d.ts")
  );

  const moduleNames = files.map((f) => f.replace(/\.ts$/, ""));
  const moduleSet = new Set(moduleNames);

  // Parse imports for each module
  const edges: { from: string; to: string }[] = [];
  const inDegree: Record<string, number> = {};
  const outDegree: Record<string, number> = {};
  for (const m of moduleNames) { inDegree[m] = 0; outDegree[m] = 0; }

  const importRe = /from\s+["']\.\/([^"']+?)(?:\.ts)?["']/g;

  for (const file of files) {
    const mod = file.replace(/\.ts$/, "");
    const content = await readFile(resolve(SRC_DIR, file), "utf-8");
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
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

  // Layout: position nodes in groups on a grid
  // Canvas: ~1400px wide, groups arranged in rows
  const GROUP_POSITIONS: Record<string, { x: number; y: number }> = {
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

  const groupBounds: Record<string, { x: number; y: number; w: number; h: number }> = {};

  const nodes = moduleNames.map((mod) => {
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
  const byGroup: Record<string, typeof nodes> = {};
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

  const groupsOut = GROUPS.map((g) => ({
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

  cachedGraph = {
    nodes,
    edges,
    groups: groupsOut,
    moduleCount: moduleNames.length,
    edgeCount: edges.length,
    scannedAt: new Date().toISOString(),
  };
  cacheTime = Date.now();
  return cachedGraph;
}

export function createArchitectureRouter(eventBus: any) {
  const router = Router();

  router.get("/architecture", async (req, res) => {
    try {
      const graph = await scanArchitecture();

      // Overlay live status
      let status = { cycle: "idle", redis: false, schedulerRunning: false };
      try {
        const cycleStatus = await getCycleStatus();
        status.cycle = cycleStatus.status || "idle";
        await eventBus.publisher.ping();
        status.redis = true;
      } catch { /* intentional: status overlay is best-effort */ }

      res.json({ ...graph, status });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
