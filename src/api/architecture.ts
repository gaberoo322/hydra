import { Router } from "express";

import { getCycleStatus } from "../cycle.ts";
import {
  scanArchitecture,
  type ArchitectureGraph,
} from "../aggregators/architecture-graph.ts";
import type { PingableBus } from "./event-bus-types.ts";

const CACHE_TTL = 60_000;

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

      res.json({ ...graph, status });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
