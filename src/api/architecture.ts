import { Router } from "express";

import { getCycleStatus } from "../cycle.ts";
import {
  scanArchitecture,
  type ArchitectureGraph,
} from "../aggregators/architecture-graph.ts";

// The pure scan lives in src/aggregators/architecture-graph.ts (issue #1411).
// This route owns only the response cache + the live-status overlay; the
// scanner itself is a pure, FS-injectable aggregator with no module globals.
let cachedGraph: ArchitectureGraph | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

async function getArchitectureGraph(): Promise<ArchitectureGraph> {
  if (cachedGraph && Date.now() - cacheTime < CACHE_TTL) return cachedGraph;
  cachedGraph = await scanArchitecture();
  cacheTime = Date.now();
  return cachedGraph;
}

export function createArchitectureRouter(eventBus: any) {
  const router = Router();

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
