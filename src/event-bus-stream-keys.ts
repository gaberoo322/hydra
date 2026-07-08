// ---------------------------------------------------------------------------
// Stream-key vocabulary Seam (issue #2989) — the *stream-key* sub-alphabet of
// the Event Bus alphabet (CONTEXT.md).
//
// `src/event-bus.ts` owns the Redis-connected `EventBus` class and the
// consumer-group lifecycle. This module owns the *stream-key* vocabulary that
// was previously co-located there:
//
//   - `STREAMS`          — the live stream set (streams a live consumer reads).
//   - `RETAINED_STREAMS` — back-compat-only names, NO live consumer.
//   - `StreamKey`        — the closed union of `STREAMS` values.
//   - `streamKey()`      — the dynamic `hydra:`-prefix escape hatch.
//   - `CONSUMER_GROUPS`  — the `{ [StreamKey]: group[] }` topology map.
//
// Why a separate file (mirroring `./event-bus-vocabulary.ts`, issue #1985):
// this module has ZERO import-time side effects — it does NOT import
// `./redis/connection.ts` (or anything that transitively calls
// `getRedisConnection()`), so callers that need only the stream-key alphabet
// (`api/events.ts`, `api/autopilot-control.ts`, `notification-consumer.ts`, and
// the scheduler chores) can derive stream names WITHOUT pulling the Redis
// connection into scope at parse/load time. `event-bus.ts` imports the symbols
// BACK from here and re-exports them, so external callers/tests that already
// import them FROM `event-bus.ts` stay zero-diff.
//
// On-wire stream-key strings are byte-identical to the pre-extraction
// `event-bus.ts` definitions — this is a pure type/value relocation, zero
// behaviour change.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stream topology — the Event Bus alphabet (CONTEXT.md).
//
// Stream key shapes live here (not in redis-keys.ts) because the event bus
// IS the owner of these names — every reader/writer goes through the bus,
// not through the key registry. Adding a new stream means adding it here
// AND wiring a publisher/consumer, not just registering a key.
// ---------------------------------------------------------------------------

/**
 * The live stream set — streams a current consumer actually reads. Typed as
 * a frozen `const` map so `StreamKey` (below) is the closed union of values
 * the bus owns; a caller cannot publish to a stream that is not in this set
 * without a compile error.
 */
const STREAMS = {
  NOTIFICATIONS: "hydra:notifications",
  DLQ: "hydra:dlq",
} as const;

/**
 * Streams retained for back-compat only — NO live consumer reads them. Kept
 * as a separate, explicitly-named map (not folded into `STREAMS`) so the
 * advertised live set matches reality, while the names survive for any
 * external listener:
 *
 *   - `CYCLE` — cycle-start events; no in-process bus consumer today.
 *
 * (`TASKS` / `META` were deleted in #1655 — zero producers and zero consumers
 * after the #345 / legacy-pipeline retirements left nothing writing them.)
 *
 * Producing to these is intentionally NOT type-checked against `StreamKey`;
 * a caller that needs one passes the literal explicitly via `RETAINED_STREAMS`.
 */
const RETAINED_STREAMS = {
  CYCLE: "hydra:cycle",
} as const;

/**
 * A stream the bus owns and a live consumer reads. The closed union of
 * `STREAMS` values — `publish()`/`consume()` accept this so callers cannot
 * target a stream the bus does not advertise. `streamKey()` widens to
 * `string` for the dynamic `/events/:stream` surface; that is the one
 * sanctioned escape hatch.
 */
type StreamKey = (typeof STREAMS)[keyof typeof STREAMS];

/** Dynamic stream name lookup for `/events/:stream` and similar surfaces. */
function streamKey(name: string): string {
  return `hydra:${name}`;
}

// Consumer groups — only streams with active consumers.
// META consumer removed in #345 (meta agent deleted); its stream name now
// lives in RETAINED_STREAMS, so it no longer appears here.
const CONSUMER_GROUPS: Record<StreamKey, string[]> = {
  [STREAMS.NOTIFICATIONS]: ["telegram"],
  [STREAMS.DLQ]: ["dlq-processor"],
};

export { STREAMS, RETAINED_STREAMS, streamKey, CONSUMER_GROUPS };
export type { StreamKey };
