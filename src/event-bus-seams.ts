/**
 * Structural seams over the event bus — the narrow interfaces naming only the
 * members a given caller needs from the concrete `EventBus` class
 * (`src/event-bus.ts`). Consumed by the `src/api/` sub-router factories and by
 * the `src/scheduler/` chores that publish notifications (issue #1897, #2998).
 *
 * # Why this is a root-level leaf, not part of `src/event-bus.ts` or `src/api/`
 *
 * These seams describe what a *caller* needs from the bus, so they belong to
 * the event-bus domain — alongside `event-bus-vocabulary.ts` and
 * `event-bus-stream-keys.ts`, the sibling zero-Redis-side-effect leaves. They
 * are NOT inlined into `src/event-bus.ts` because that module imports
 * `getRedisConnection` at top level; a scheduler chore importing a seam type
 * from it would pull the Redis connection into parse-time scope — exactly the
 * zero-import-side-effect hazard the sibling leaves were extracted to avoid.
 * This pure-type leaf keeps that property (issue #2998).
 *
 * # Why structural interfaces, not the concrete `EventBus` class
 *
 * `src/api.ts`'s `createApi(eventBus)` historically passed an implicitly-`any`
 * bus to every sub-router factory, and the factories re-declared the parameter
 * as `eventBus: any` / `_eventBus: any`. Typing the parameter with the concrete
 * `EventBus` class (`src/event-bus.ts`) would force every router test — which
 * constructs partial stubs like `{ publisher: redis }` or
 * `{ publisher: { ping } }` — to either build a full bus or cast `as any`,
 * relocating the very `any` this change removes.
 *
 * Instead we mirror the existing `HoldbackEventBus` seam (`src/holdback.ts`):
 * each interface names ONLY the bus members the routers in that tier actually
 * touch. The real `EventBus` class structurally satisfies all of them, so
 * `createApi(eventBus)` needs no cast; and the partial test stubs keep
 * satisfying the narrowed parameter unchanged.
 *
 * Method (not arrow-property) signatures are used deliberately: TypeScript
 * checks method parameters bivariantly, so the real
 * `EventBus.publish(stream: StreamKey, …)` remains assignable to a seam that
 * declares `publish(stream: string, …)`. This is the same shape `HoldbackEventBus`
 * relies on.
 *
 * These are pure type declarations (no value imports) — no runtime surface,
 * no new dependency (ADR-0005).
 */

/**
 * The narrowest bus a router that only health-checks Redis needs:
 * `eventBus.publisher.ping()`.
 *
 * Consumed by the health and architecture routers (their status overlay pings
 * Redis through the bus's publisher connection).
 */
export interface PingableBus {
  publisher: {
    ping(): Promise<unknown>;
  };
}

/**
 * A bus a router can publish events onto.
 *
 * Consumed by the autopilot router (optional — pause/resume best-effort emit),
 * and forwarded by the scheduler and maintenance routers to the deeper
 * `src/scheduler/` consumers (`heartbeat.start()` / `runHousekeeping()`), which
 * publish on the notifications stream.
 *
 * The `event` shape mirrors `HoldbackEventBus` but admits the optional
 * `correlationId` the `POST /events/publish` handler forwards.
 */
export interface PublishableBus {
  publish(
    stream: string,
    event: {
      type: string;
      source: string;
      payload?: unknown;
      correlationId?: string | null;
    },
  ): Promise<unknown>;
}

/**
 * A bus a router can both publish onto and read recent events back from.
 *
 * Consumed by the events router (`GET /events/:stream` reads, `POST
 * /events/publish` writes).
 */
export interface EventReaderBus extends PublishableBus {
  readRecent(stream: string, count: number): Promise<unknown[]>;
}
