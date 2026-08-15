import { Router } from "express";

import { getCycleStatus } from "../cycle.ts";
import {
  scanArchitecture,
  type ArchitectureGraph,
  type ArchitectureNode,
} from "../aggregators/architecture-graph.ts";
import type { PingableBus } from "../event-bus-seams.ts";

const CACHE_TTL = 60_000;

// ---------------------------------------------------------------------------
// Ranked most-tangled modules (issue #4011, ADR-0034 §2 — the /builder page)
// ---------------------------------------------------------------------------

/**
 * One module's tangledness, decomposed into the inputs that produced its rank
 * (ADR-0034 §5.3 — a derived value must explain itself).
 */
export interface TangledModule {
  /** Module id — the srcDir-relative path without `.ts` (matches node ids). */
  id: string;
  /** Display label (mirrors the node's label). */
  label: string;
  /** Derived group id (mirrors the node's group). */
  group: string;
  /** Number of modules importing this one (fan-in). */
  fanIn: number;
  /** Number of modules this one imports (fan-out). */
  fanOut: number;
  /** fanIn + fanOut — the coupling breadth. */
  fanTotal: number;
  /**
   * Size of the dependency cycle (strongly-connected component) this module
   * belongs to; 0 when the module is acyclic. Membership in the largest
   * cycles is the primary ranking input.
   */
  cycleSize: number;
}

/**
 * The aggregator's edge shape ({from, to}), declared structurally here — the
 * aggregator's own `ArchitectureEdge` interface is not exported (and that
 * file is outside #4011's file-scope allowlist).
 */
interface EdgeLike {
  from: string;
  to: string;
}

/**
 * Rank a scanned architecture graph's modules by tangledness for the /builder
 * page's "what should I refactor next" view (issue #4011): membership in the
 * largest dependency cycles first (cycleSize desc), then fan-in + fan-out
 * (fanTotal desc), with the module id as the deterministic tiebreak.
 *
 * Pure function of the existing graph's nodes/edges — no filesystem scan, no
 * new data source, no I/O — so it is unit-testable without spawning Express
 * (test/builder-page.test.mts). Cycle membership is Tarjan strongly-connected
 * components over the edge list; the module graph is small (a few hundred
 * nodes), so the recursive formulation is safe.
 *
 * NB (design-concept #4011): the idiomatic home for this derivation is the
 * `src/aggregators/architecture-graph.ts` pure-aggregator suite, but that
 * file is outside this issue's file-scope allowlist — relocating it there is
 * flagged follow-up cleanup debt.
 */
export function rankTangledModules(
  graph: Pick<ArchitectureGraph, "nodes" | "edges">,
  limit = 25,
): TangledModule[] {
  const fanIn: Record<string, number> = {};
  const fanOut: Record<string, number> = {};
  const adjacency: Record<string, string[]> = {};
  for (const n of graph.nodes) {
    fanIn[n.id] = 0;
    fanOut[n.id] = 0;
    adjacency[n.id] = [];
  }
  for (const e of graph.edges as EdgeLike[]) {
    // Guard against a malformed edge naming an unknown module — the pure
    // scanner never emits one, but the route must never throw on data.
    if (!(e.from in fanOut) || !(e.to in fanIn)) continue;
    fanOut[e.from] += 1;
    fanIn[e.to] += 1;
    adjacency[e.from].push(e.to);
  }

  const cycleSize = stronglyConnectedComponentSizes(graph.nodes, adjacency);

  const ranked: TangledModule[] = graph.nodes.map(
    (n: ArchitectureNode): TangledModule => ({
      id: n.id,
      label: n.label,
      group: n.group,
      fanIn: fanIn[n.id] || 0,
      fanOut: fanOut[n.id] || 0,
      fanTotal: (fanIn[n.id] || 0) + (fanOut[n.id] || 0),
      cycleSize: cycleSize.get(n.id) ?? 0,
    }),
  );

  ranked.sort(
    (a, b) =>
      b.cycleSize - a.cycleSize ||
      b.fanTotal - a.fanTotal ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return ranked.slice(0, limit);
}

/**
 * Tarjan SCC over the graph's nodes/adjacency, returning each module's cycle
 * size — the size of its strongly-connected component when that component is
 * a real cycle (≥ 2 modules), else 0 (acyclic; self-loops cannot occur, the
 * scanner skips `target === mod` edges).
 */
function stronglyConnectedComponentSizes(
  nodes: ArchitectureNode[],
  adjacency: Record<string, string[]>,
): Map<string, number> {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sizes = new Map<string, number>();
  let counter = 0;

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency[v] ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      const size = component.length >= 2 ? component.length : 0;
      for (const m of component) sizes.set(m, size);
    }
  };

  for (const n of nodes) {
    if (!index.has(n.id)) strongconnect(n.id);
  }

  return sizes;
}

/**
 * Injectable deps for the architecture route's response cache.
 *
 * The pure scan lives in src/aggregators/architecture-graph.ts (issue #1411).
 * This route owns only the response cache + the live-status overlay. The cache
 * state lives in the factory closure (issue #1489) — no module globals — so the
 * TTL behavior (hit within 60s, miss after 60s, no caching of scanner errors)
 * is testable by injecting a fake clock and a fake scanner.
 */
export interface ArchitectureRouterDeps {
  /** Returns the architecture graph; defaults to the pure FS scanner. */
  scan?: () => Promise<ArchitectureGraph>;
  /** Monotonic clock in ms; defaults to Date.now. */
  now?: () => number;
}

export function createArchitectureRouter(
  eventBus: PingableBus,
  deps: ArchitectureRouterDeps = {},
) {
  const router = Router();

  const scan = deps.scan ?? (() => scanArchitecture());
  const now = deps.now ?? (() => Date.now());

  // Per-router cache state — closed over, not module-global.
  let cachedGraph: ArchitectureGraph | null = null;
  let cacheTime = 0;

  async function getArchitectureGraph(): Promise<ArchitectureGraph> {
    if (cachedGraph && now() - cacheTime < CACHE_TTL) return cachedGraph;
    // Assign only on success so a scanner error never poisons the cache.
    const graph = await scan();
    cachedGraph = graph;
    cacheTime = now();
    return graph;
  }

  router.get("/architecture", async (req, res) => {
    try {
      const graph = await getArchitectureGraph();

      // Overlay live status
      let status = { cycle: "idle", redis: false, schedulerRunning: false };
      try {
        const cycleStatus = await getCycleStatus();
        status.cycle = cycleStatus.status || "idle";
        await eventBus.publisher.ping();
        status.redis = true;
      } catch { /* intentional: status overlay is best-effort */ }

      // Issue #4011 (ADR-0034 §2, the /builder page): ADDITIVE fields only —
      // the legacy nodes/edges/groups/moduleCount/edgeCount/scannedAt/status
      // shape is unchanged so the still-live Explore › Architecture consumer
      // keeps working unmodified. `generatedAt` aliases `scannedAt` because
      // the ADR-0034 §5 trust seam (usePageItems.derivePageStatus) reads
      // `generatedAt`; the aggregator names its timestamp `scannedAt`.
      res.json({
        ...graph,
        status,
        generatedAt: graph.scannedAt,
        tangledModules: rankTangledModules(graph),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
