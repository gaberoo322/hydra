import { Router } from "express";
import { STREAMS, streamKey } from "../event-bus.ts";
import { countQuerySchema } from "../schemas/common.ts";

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
    // ADR-0022: read `count` through the Schemas seam; bad/absent input
    // collapses to the default, preserving the legacy `|| 10` semantics.
    const count = countQuerySchema(10).safeParse(req.query).data?.count ?? 10;
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
