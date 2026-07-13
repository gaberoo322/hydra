import { Router } from "express";
import { STREAMS, streamKey } from "../event-bus-stream-keys.ts";
import { countQuerySchema } from "../schemas/common.ts";
import { PublishEventBodySchema } from "../schemas/events.ts";
import { aggregatorRouteNoQuery, schemaValidationError } from "./route-helpers.ts";
import type { EventReaderBus } from "../event-bus-seams.ts";

/**
 * Event bus stream routes.
 *
 * Extracted from api/misc.ts as part of issue #268.
 */
export function createEventsRouter(eventBus: EventReaderBus) {
  const router = Router();

  // GET /events/:stream — Read recent events from a stream
  //
  // Issue #1863: never-throw-500 isolation via the aggregatorRouteNoQuery seam
  // (route-helpers.ts, #909). `count` keeps its soft-parse (default-on-garbage,
  // no 400) inside `produce`; the `:stream` path param is read off `req`.
  router.get(
    "/events/:stream",
    aggregatorRouteNoQuery("api/events", (req) => {
      const stream = streamKey(String(req.params.stream));
      // ADR-0022: read `count` through the Schemas seam; bad/absent input
      // collapses to the default, preserving the legacy `|| 10` semantics.
      const count = countQuerySchema(10).safeParse(req.query).data?.count ?? 10;
      return eventBus.readRecent(stream, count);
    }),
  );

  // POST /events/publish — Publish events from external sources
  //
  // ADR-0022: validate the external publish body through the Schemas seam
  // (issue #3259). PublishEventBodySchema requires a non-empty `type` (mirroring
  // the prior `if (!type)` guard) and admits optional `payload` / `correlationId`;
  // `.passthrough()` ignores unknown keys. A parse failure returns the canonical
  // 400 `{ code: "schema-validation-failed", issues }` envelope.
  router.post("/events/publish", async (req, res) => {
    const parsed = PublishEventBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    try {
      const { type, payload, correlationId } = parsed.data;
      await eventBus.publish(STREAMS.NOTIFICATIONS, {
        type,
        source: "claude-build",
        correlationId: correlationId ?? null,
        payload: payload ?? {},
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
