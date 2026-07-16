// ---------------------------------------------------------------------------
// Tick-side builder-health stagnation emit — extracted from the Observability
// Heartbeat (issue #3371, deepen-heartbeat extraction; original emit landed in
// issue #3290, epic #3285, ADR-0028).
// ---------------------------------------------------------------------------
//
// The Observability Heartbeat (`src/scheduler/heartbeat.ts`) is the dumb
// liveness state machine — start/stop lifecycle, lifetime cycle counters, the
// timer handle, and the deliberate-stop discriminant. It is "strictly
// observability-and-counters only" (CONTEXT.md, "Housekeeping").
//
// The per-tick builder-health stagnation emit is a single, self-contained
// side-effect grafted onto the heartbeat's tick: each tick it reads the
// Builder-Health Scorecard and (edge-triggered) publishes a
// `builder-health.stagnation` notification for any signal that transitioned
// INTO `breach`. It is behaviorally non-decisional (ADR-0012) — no policy
// decision, no dispatch, no kanban/work-queue mutation — but STRUCTURALLY it
// dragged a two-domain import chain (the builder-health aggregator + the
// notification bus) plus a process-lifetime edge-state store onto a module
// whose test surface should only cover the liveness state machine.
//
// This module owns that concern as a sibling to the heartbeat, mirroring the
// `status-projection.ts` (issue #2974) extraction axis: a free function taking
// a `Deps` object rather than a class with its own lifecycle. The concern has
// no lifecycle state machine — only a previous-state store — so a free function
// is the lighter, already-precedented shape.
//
// Invariants preserved verbatim from the pre-extraction heartbeat behavior:
//   - fire-and-forget + never-throws: a slow or failing scorecard read (Redis +
//     GitHub fan-out) can never wedge or delay the liveness tick;
//   - edge-triggered per (signal, realm) via a process-lifetime previous-state
//     store; a process bounce re-arms the edge (cross-restart dedupe is a
//     deliberate non-goal, issue #3290);
//   - a bus without a `publish` method is a silent no-op (the tick may run
//     before the event bus is wired);
//   - non-decisional: reads the scorecard and publishes; mutates nothing else.

import { getBuilderHealthScorecard, type BuilderHealthScorecard } from "../aggregators/builder-health.ts";
import {
  emitStagnationAlerts,
  createInMemoryStagnationStore,
  type StagnationAlertStateStore,
} from "../notification/stagnation-alerts.ts";
import type { PublishableBus } from "../event-bus-seams.ts";

/**
 * Injectable dependencies for {@link emitTickStagnationAlerts} (all optional).
 * Each defaults to the real side-effecting implementation, so production calls
 * `emitTickStagnationAlerts(eventBus)` with no deps and a unit test injects a
 * scorecard stub, a deterministic store, or both — no `HeartbeatController`
 * required. Mirrors `StatusProjectionDeps` (issue #2974).
 */
export interface TickStagnationAlertDeps {
  /**
   * Builder-Health Scorecard reader. Defaults to the real
   * `getBuilderHealthScorecard` (a composed Redis + GitHub read). Tests inject a
   * deterministic stub so the tick never touches Redis / GitHub.
   */
  getBuilderHealthScorecard?: () => Promise<BuilderHealthScorecard>;
  /**
   * Process-lifetime previous-state store for the per-signal stagnation edge.
   * Defaults to the module-level singleton (see {@link defaultStore}) so the
   * per-signal edge-trigger dedupe survives across ticks within one process; a
   * bounce re-arms (cross-restart dedupe is a deliberate non-goal, issue #3290).
   * Tests inject a fresh store to drive transitions deterministically.
   */
  store?: StagnationAlertStateStore;
}

/**
 * The process-lifetime edge-state store. Constructed once at module load so the
 * per-(signal, realm) edge dedupes across the 5-minute ticks for the life of
 * the process. A process bounce discards it (re-arming the edge) — the
 * deliberate MVP non-goal. Tests never touch this; they inject their own store
 * via {@link TickStagnationAlertDeps.store}.
 */
const defaultStore: StagnationAlertStateStore = createInMemoryStagnationStore();

/**
 * Read the Builder-Health Scorecard and fire any edge-triggered
 * `builder-health.stagnation` alerts (issue #3290). Called fire-and-forget from
 * the heartbeat's `runScheduledCycle`.
 *
 * Never throws — a scorecard read failure or a bus without a `publish` method
 * is logged (fail-loud) and skipped, so the liveness tick is never wedged or
 * delayed by a slow scorecard read.
 *
 * @param eventBus - the notification bus. A value lacking a `publish` method is
 *   a silent no-op (the tick may run before the bus is wired).
 * @param deps - optional injected scorecard reader + edge-state store.
 */
export async function emitTickStagnationAlerts(
  eventBus: unknown,
  deps: TickStagnationAlertDeps = {},
): Promise<void> {
  const bus = eventBus as Partial<PublishableBus> | null | undefined;
  if (!bus || typeof bus.publish !== "function") return;
  const readScorecard = deps.getBuilderHealthScorecard ?? getBuilderHealthScorecard;
  const store = deps.store ?? defaultStore;
  try {
    const scorecard = await readScorecard();
    await emitStagnationAlerts(scorecard, bus as PublishableBus, { store });
  } catch (err: any) {
    console.error(`[Heartbeat] builder-health stagnation scan failed: ${err?.message ?? err}`);
  }
}
