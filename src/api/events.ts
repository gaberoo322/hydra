import { Router } from "express";
import { STREAMS, streamKey } from "../event-bus.ts";

/**
 * Event bus stream routes.
 *
 * Extracted from api/misc.ts as part of issue #268.
 */
export function createEventsRouter(eventBus: any) {
  const router = Router();

  // GET /events/:stream — Read recent events from a stream
  router.get("/events/:stream", async (req, res) => {
    const stream = streamKey(req.params.stream);
    const count = parseInt(String(req.query.count ?? ""), 10) || 10;
    try {
      const events = await eventBus.readRecent(stream, count);
      res.json(events);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /events/publish — Publish events from external sources
  router.post("/events/publish", async (req, res) => {
    try {
      const { type, payload, correlationId } = req.body || {};
      if (!type) {
        return res.status(400).json({ error: "Missing type" });
      }
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type,
        source: "claude-build",
        correlationId: correlationId || null,
        payload: payload || {},
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
