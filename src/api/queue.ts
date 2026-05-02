import { Router } from "express";
import { getWorkQueueItems, pushToWorkQueue, getWorkQueueLen } from "../redis-adapter.ts";

export function createQueueRouter() {
  const router = Router();

  // POST /queue — Queue a work item for the next cycle
  router.post("/queue", async (req, res) => {
    try {
      const { reference, reason, context } = req.body || {};
      if (!reference) {
        return res.status(400).json({ error: "Missing 'reference' field — what should Hydra work on?" });
      }

      // Dedup: check if an item with the same reference already exists in the queue
      const existing = await getWorkQueueItems();
      const refLower = reference.toLowerCase().trim();
      const duplicate = existing.some(raw => {
        try {
          const item = JSON.parse(raw);
          return (item.reference || "").toLowerCase().trim() === refLower;
        } catch { return false; }
      });
      if (duplicate) {
        return res.json({ queued: false, reason: "Duplicate — item with same reference already in queue", reference });
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
