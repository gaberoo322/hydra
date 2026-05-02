import { Router } from "express";
import { getWorkQueueItems, pushToWorkQueue, getWorkQueueLen, findWorkQueueDuplicate } from "../redis-adapter.ts";

export function createQueueRouter() {
  const router = Router();

  // POST /queue — Queue a work item for the next cycle
  router.post("/queue", async (req, res) => {
    try {
      const { reference, reason, context } = req.body || {};
      if (!reference) {
        return res.status(400).json({ error: "Missing 'reference' field — what should Hydra work on?" });
      }

      // Dedup: fuzzy check if a similar item already exists in the queue
      const matchedRef = await findWorkQueueDuplicate(reference);
      if (matchedRef) {
        console.log(`[WorkQueue] Dedup: rejected "${reference}" (matches existing: "${matchedRef}")`);
        return res.status(409).json({
          error: "Duplicate — a similar item already exists in the queue",
          reference,
          matchedExisting: matchedRef,
        });
      }

      const item = { reference, reason: reason || "queued by operator", context, queuedAt: new Date().toISOString() };
      await pushToWorkQueue(JSON.stringify(item));
      const queueLen = await getWorkQueueLen();
      res.json({ queued: true, item, position: queueLen });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /queue — View queued work items
  router.get("/queue", async (req, res) => {
    try {
      const items = await getWorkQueueItems();
      res.json(items.map((i) => { try { return JSON.parse(i); } catch { return i; } }));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
