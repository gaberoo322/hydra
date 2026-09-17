/**
 * Autopilot slot-events HTTP read surface (issue #4510).
 *
 *   GET /autopilot/slot-events?last_id=<id>&count=<n> → { events, last_id }
 *
 * `collect-state.sh`'s `collect_slot_events` used to `docker exec
 * hydra-redis-1 redis-cli XREAD ...` and pipe the plain-text reply through a
 * ~30-line hand-rolled Python regex parser (`re.match(r'^\d+-\d+$', ...)`) to
 * reconstruct `{id, fields}` — re-deriving, in a second language with zero
 * test coverage, the exact wire format `EventBus.readRaw()`
 * (`src/event-bus.ts`) already parses structurally off ioredis's typed XREAD
 * reply. This route is the thin HTTP adapter onto that seam, mirroring the
 * existing `GET /autopilot/board-state` / `GET /autopilot/runs` pattern:
 * `collect_slot_events` now does `hydra raw GET /autopilot/slot-events?...`
 * instead of shelling into Redis directly (ADR-0017 Category B: "the Event
 * Bus owns stream ops; clients use its interface, never the raw connection").
 *
 * Response shape is intentionally snake_case (`last_id`, not `lastId`) —
 * design-concept invariant #5 requires `collect_slot_events`'s emitted
 * `slot_events_json=<json>` to stay byte-identical to today's output, since
 * `decide.py`'s `_unwrap_events_container` already parses exactly this key
 * name. `collect_slot_events` pipes this response straight through with zero
 * reshaping — no python3/regex stage at all.
 *
 * Plain XREAD, never XREADGROUP (invariant #2): `decide.py` owns its own
 * cursor via `state.slot_events_last_id`, so this read creates no
 * consumer-group state and cannot collide with the now-pixel bridge's
 * independent `now-pixel-bridge` group on the same stream.
 *
 * The stream name is hard-coded (not a query param): accepting an arbitrary
 * stream name over HTTP would turn a narrow autopilot-internal read into a
 * general Redis-stream proxy — an unwanted surface widening.
 */

import { Router } from "express";
import { z } from "zod";
import type { EventBus } from "../event-bus.ts";

/** Mirrors the constant every other slot-events consumer/producer declares
 * locally (`slot-events-bridge.ts`, `recommendation-consumer.ts`,
 * `pr-lifecycle-bridge.ts`) — this codebase's established convention for this
 * stream name, rather than a shared cross-file import. */
const SLOT_EVENTS_STREAM = "hydra:autopilot:slot-events";

/** Matches `collect_slot_events`'s existing bash defaults (`HYDRA_AUTOPILOT_
 * SLOT_EVENTS_LAST_ID` default `"0"`, `HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT`
 * default `100`); `count`'s upper bound mirrors the stream's own `MAXLEN ~
 * 1000` cap — reading more than the stream can ever hold is never useful. */
const SlotEventsQuerySchema = z
  .object({
    last_id: z.string().min(1).default("0"),
    count: z.coerce.number().int().min(1).max(1000).default(100),
  })
  .strict();

export function createAutopilotSlotEventsRouter(eventBus: EventBus) {
  const router = Router();

  router.get("/autopilot/slot-events", async (req, res) => {
    const parsed = SlotEventsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const { last_id, count } = parsed.data;
    // readRaw() never throws (design-concept invariant #3) — a Redis outage
    // or empty stream degrades to {events: [], lastId: null} in-process, so
    // this route always answers 200. collect_slot_events has never had a way
    // to surface a 5xx (its old redis-cli/python pipeline degraded silently
    // to the same empty shape on any failure), so this preserves that
    // contract exactly.
    const result = await eventBus.readRaw(SLOT_EVENTS_STREAM, last_id, count);
    return res.json({ events: result.events, last_id: result.lastId });
  });

  return router;
}
