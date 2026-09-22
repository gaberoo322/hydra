/**
 * Schema for the `GET /autopilot/slot-events?last_id=<id>&count=<n>` query
 * (issue #4510).
 *
 * `collect-state.sh`'s `collect_slot_events` used to `docker exec
 * hydra-redis-1 redis-cli XREAD ...` directly and re-derive `{id, fields}`
 * from the plain-text reply via a ~30-line hand-rolled Python regex parser.
 * This schema is the request-validation half of the thin HTTP seam
 * (`src/api/autopilot-slot-events.ts`) that replaces it, following the same
 * Schemas-seam convention as `src/schemas/autopilot-board.ts` /
 * `src/schemas/autopilot-idle.ts` (ADR-0011): a `.strict()` object under
 * `src/schemas/`, with the route importing it rather than declaring its own
 * inline shape.
 *
 * `last_id` defaults to `"0"` and `count` defaults to `100`, mirroring
 * `collect_slot_events`'s existing bash defaults
 * (`HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID` / `HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT`).
 * `count`'s upper bound of 1000 mirrors the stream's own `MAXLEN ~ 1000` cap —
 * reading more than the stream can ever hold is never useful.
 */

import { z } from "zod";

export const SlotEventsQuerySchema = z
  .object({
    last_id: z.string().min(1).default("0"),
    count: z.coerce.number().int().min(1).max(1000).default(100),
  })
  .strict();

export type SlotEventsQuery = z.infer<typeof SlotEventsQuerySchema>;
