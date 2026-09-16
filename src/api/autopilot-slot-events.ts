/**
 * Autopilot slot-events HTTP read surface (issue #4510).
 *
 *   GET /autopilot/slot-events?last_id=<id>&count=<n> → AutopilotSlotEventsResponse
 *
 * `scripts/autopilot/collect-state.sh`'s `collect_slot_events` used to shell
 * out to `docker exec hydra-redis-1 redis-cli XREAD ...` and re-derive the
 * `{id, fields}` wire format via a ~30-line hand-rolled Python regex parser —
 * a second, drift-prone, zero-test-coverage implementation of the exact
 * format the typed `EventBus.readRaw()` (`src/event-bus.ts`) already owns
 * correctly (ADR-0017 Category B). This route projects that typed read over
 * HTTP so the bash collector can become a plain `hydra raw GET` call, the
 * same pattern `collect_orch_board` / `collect_retro` already use.
 *
 * The producer side of `hydra:autopilot:slot-events` (the shell hooks'
 * flat-field `XADD` via `publishRaw()`) is untouched — this route is
 * consumer-side only. The read is a PLAIN `XREAD`, never `XREADGROUP`:
 * `decide.py` owns its own cursor (`state.slot_events_last_id`) rather than a
 * consumer-group position, so this route must not create or advance a group
 * — it cannot collide with the independent `now-pixel-bridge` group
 * `slot-events-bridge.ts` maintains on the same stream.
 *
 * Never-throw-200 contract (CLAUDE.md / issue #4510's design-concept
 * invariants): a Redis outage or an empty stream both resolve to the safe
 * default `{ events: [], last_id: null }` with HTTP 200 — never a 5xx that
 * could abort the autopilot turn. `EventBus.readRaw()` already never throws;
 * this route's own try/catch is belt-and-braces around the query parse and
 * the call site.
 */

import { Router } from "express";

import { AutopilotSlotEventsQuerySchema, type AutopilotSlotEventsResponse } from "../schemas/autopilot-slot-events.ts";
import { schemaValidationError } from "./route-helpers.ts";
import type { EventBus } from "../event-bus.ts";
import { logger } from "../logger.ts";

/** The one production stream this route reads. Hard-coded, never a query
 * param — accepting an arbitrary stream name over HTTP would turn a narrow
 * autopilot-internal read into a general Redis-stream proxy. */
const SLOT_EVENTS_STREAM = "hydra:autopilot:slot-events";

export function createAutopilotSlotEventsRouter(eventBus: EventBus) {
  const router = Router();

  router.get("/autopilot/slot-events", async (req, res) => {
    const parsed = AutopilotSlotEventsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { last_id, count } = parsed.data;

    let body: AutopilotSlotEventsResponse;
    try {
      const read = await eventBus.readRaw(SLOT_EVENTS_STREAM, last_id, count);
      body = { events: read.events, last_id: read.last_id };
    } catch (err: any) {
      // Belt-and-braces: `readRaw()` already never throws, but a route on
      // the never-5xx contract does not trust that at the call site either.
      logger.error(
        { err, stream: SLOT_EVENTS_STREAM },
        "[autopilot/slot-events] readRaw threw despite never-throw contract — degrading to empty",
      );
      body = { events: [], last_id: null };
    }
    return res.status(200).json(body);
  });

  return router;
}
