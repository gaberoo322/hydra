/**
 * Schemas for the autopilot slot-events read endpoint (issue #4510).
 *
 *   GET /api/autopilot/slot-events?last_id=<id>&count=<n> → AutopilotSlotEventsResponse
 *
 * `scripts/autopilot/collect-state.sh`'s `collect_slot_events` used to run a
 * raw `docker exec hydra-redis-1 redis-cli XREAD ...` and hand-parse the
 * plain-text reply through a ~30-line Python regex heuristic — a second,
 * drift-prone re-derivation of the wire format the typed `EventBus` (via
 * `readRaw()`, `src/event-bus.ts`) already owns correctly. This endpoint
 * projects that typed read over HTTP, mirroring the existing
 * `GET /autopilot/board-state` pattern so `collect_slot_events` can become a
 * plain `hydra raw GET` call, matching `collect_orch_board` / `collect_retro`.
 *
 * Response field names (`last_id`, `fields`) are snake_case-preserving,
 * deliberately NOT camelCased: this is a legacy-shape-compat surface —
 * `decide.py`'s cursor (`state.slot_events_last_id`) and the emitted
 * `slot_events_json=<json>` key must stay byte-identical to the pre-existing
 * bash+regex output so no downstream consumer needs to change.
 *
 * Schema discipline mirrors `src/schemas/autopilot-idle.ts` (ADR-0011):
 * `.strict()` objects, `z.infer<>` for canonical types.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Query schema for `GET /api/autopilot/slot-events`. Both params are
 * optional, matching the bash collector's existing env-var-derived defaults
 * (`HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID` defaults to `"0"`,
 * `HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT` defaults to `100`). `count` is bounded
 * to keep a single read from pulling an unbounded slice of the stream.
 */
export const AutopilotSlotEventsQuerySchema = z
  .object({
    last_id: z.string().min(1).default("0"),
    count: z.coerce.number().int().min(1).max(1000).default(100),
  })
  .strict();

export type AutopilotSlotEventsQuery = z.infer<
  typeof AutopilotSlotEventsQuerySchema
>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * One raw stream entry, `{id, fields}` — the exact shape the bash+regex
 * parser used to hand-reconstruct. `fields` is the flat field/value map with
 * every value kept as a raw string (no JSON parsing of any field).
 */
const SlotEventSchema = z
  .object({
    id: z.string(),
    fields: z.record(z.string(), z.string()),
  })
  .strict();

export type SlotEvent = z.infer<typeof SlotEventSchema>;

/**
 * The endpoint's never-throw-200 response shape. A Redis outage or an empty
 * stream both resolve to `{ events: [], last_id: null }` — the same
 * best-effort contract `collect_slot_events` already promised, so a failure
 * here never surfaces as a 5xx that could abort the autopilot turn.
 */
export const AutopilotSlotEventsResponseSchema = z
  .object({
    events: z.array(SlotEventSchema),
    last_id: z.string().nullable(),
  })
  .strict();

export type AutopilotSlotEventsResponse = z.infer<
  typeof AutopilotSlotEventsResponseSchema
>;
