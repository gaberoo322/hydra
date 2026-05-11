import { Router } from "express";
import { redisKeys } from "../redis-keys.ts";

/**
 * Event bus stream routes.
 *
 * Extracted from api/misc.ts as part of issue #268.
 */
export function createEventsRouter(eventBus: any) {
  const router = Router();

  // GET /events/:stream — Read recent events from a stream
  router.get("/events/:stream", async (req, res) => {
    const stream = redisKeys.stream(req.params.stream);
    // @ts-expect-error — migrate to proper types
    const count = parseInt(req.query.count) || 10;
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
      await eventBus.publish(redisKeys.streamNotifications(), {
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
