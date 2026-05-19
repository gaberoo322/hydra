// ---------------------------------------------------------------------------
// Unified capacity-floor dispatcher (issue #321)
// ---------------------------------------------------------------------------
//
// Background
//   `selectAnchor()` historically grew two pre-emption mechanisms:
//
//     1. Stuckness-driven research (issue #253 / #245 / ADR-0003 vision
//        vector 1): when a Target Outcome has been stuck for N cycles,
//        pre-empt the kanban tier with a research anchor. This is how the
//        25% self-improvement share is actually enforced in the selector.
//
//     2. Spec capacity-floor (issue #301 / #308): every Nth eligible cycle,
//        pre-empt the kanban tier with the next active-spec task. RETIRED
//        in issue #513 along with the rest of the Specs subsystem.
//
//   They lived as two independent branches in `select.ts`. Each independently
//   stole cycles from kanban; they never saw each other's state. The original
//   #301 issue called this out and asked for a unified `capacity-floors`
//   block. This module is that unification — even though only one floor
//   (stuckness / self-improvement) remains today, the scaffolding is kept
//   so future floors can plug in without re-introducing the stacking bug.
//
// Shape
//   A *declaration*-driven dispatcher. Each floor is described by:
//     - `name`: stable identifier, used for metrics + logs.
//     - `priority`: tiebreak when two floors have identical deficit.
//     - `prepare()`: cheap read of the gauge + readiness predicate. Returns
//       a `FloorReadiness` shape OR `null` when not applicable this cycle.
//     - `buildAnchor()`: called by the dispatcher when this floor wins.
//
//   `dispatchCapacityFloor()` calls every floor's `prepare()` in parallel,
//   picks the floor with the highest positive `deficit` (ties broken by
//   `priority`), invokes `buildAnchor()`, and returns the anchor. If no
//   floor is ready, returns `null` and the caller falls through to the
//   normal priority chain (kanban → failing tests → …).

import { getAllStuckness, type StucknessResult } from "../stuckness.ts";
import { pickStuckOutcome, buildStucknessAnchor } from "./stuckness-routing.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of a floor's readiness check. `deficit > 0` means the floor wants
 * to fire; the dispatcher then picks the floor with the largest deficit.
 *
 *   - `deficit`: cycles-overdue relative to the floor's target cadence. The
 *     dispatcher treats this as a comparable scalar across floors. Zero or
 *     negative means "not starving".
 *   - `share`: realised share of total cycles this floor served over the
 *     rolling window. Surfaced for metrics only; the dispatcher does not
 *     use it directly.
 *   - `targetShare`: declared share for this floor. Surfaced for metrics.
 *   - `payload`: floor-specific data the `buildAnchor()` step needs.
 */
export interface FloorReadiness<P = unknown> {
  deficit: number;
  share: number;
  targetShare: number;
  payload: P;
}

export interface FloorDecl<P = unknown> {
  name: string;
  /** Lower priority = wins ties. */
  priority: number;
  /** Cheap reads only — no anchor build. Return `null` if not applicable. */
  prepare(): Promise<FloorReadiness<P> | null>;
  /** Build the anchor once this floor has been chosen. May write to Redis. */
  buildAnchor(payload: P, eventBus: any): Promise<any>;
  /** Optional: called when this floor was eligible but lost the tiebreak. */
  onPassedOver?(reason: string): Promise<void>;
}

export interface DispatchResult {
  anchor: any | null;
  /** Name of the floor that won, or null if no floor fired. */
  firedFloor: string | null;
  /** Per-floor readiness snapshot for metrics + logs. */
  evaluations: Array<{
    name: string;
    deficit: number;
    share: number;
    targetShare: number;
    ready: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Declarative capacity-floor configuration. Operators tune cadence via env
 * vars; the *structure* (which floors exist, how they compose) lives in
 * code so it's typed and refactor-safe.
 *
 * Target shares are advisory — they're surfaced in metrics so operators
 * can confirm the realised share matches intent. The dispatcher fires
 * based on cycles-overdue, not on share directly, because share alone
 * doesn't distinguish "haven't served in a while because no work was
 * available" from "haven't served because we keep being shadowed".
 */
export interface CapacityFloorsConfig {
  /** Self-improvement floor (stuckness-driven research). */
  selfImprovement: { targetShare: number };
  /** Rolling window for realised-share computation. */
  windowCycles: number;
}

export const DEFAULT_CAPACITY_FLOORS_CONFIG: CapacityFloorsConfig = {
  selfImprovement: { targetShare: 0.25 }, // ADR-0003 vision vector 1
  windowCycles: 20,
};

/**
 * Build the runtime config from environment variables.
 */
export function loadCapacityFloorsConfig(env: NodeJS.ProcessEnv = process.env): CapacityFloorsConfig {
  const cfg: CapacityFloorsConfig = {
    selfImprovement: { ...DEFAULT_CAPACITY_FLOORS_CONFIG.selfImprovement },
    windowCycles: DEFAULT_CAPACITY_FLOORS_CONFIG.windowCycles,
  };

  const newWindow = parseIntSafe(env.HYDRA_CAPACITY_FLOORS_WINDOW);
  if (newWindow !== null) cfg.windowCycles = newWindow;

  return cfg;
}

function parseIntSafe(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// ---------------------------------------------------------------------------
// Default floor declarations
// ---------------------------------------------------------------------------

interface StucknessPayload {
  row: StucknessResult;
}

/**
 * Stuckness floor declaration. Wraps the existing `pickStuckOutcome` /
 * `buildStucknessAnchor` pair so the selector no longer calls them directly.
 */
export function stucknessFloorDecl(
  cfg: CapacityFloorsConfig = DEFAULT_CAPACITY_FLOORS_CONFIG,
): FloorDecl<StucknessPayload> {
  return {
    name: "self-improvement",
    priority: 2,
    async prepare(): Promise<FloorReadiness<StucknessPayload> | null> {
      let rows: StucknessResult[];
      try {
        rows = await getAllStuckness();
      } catch (err: any) {
        console.error(`[capacity-floors] getAllStuckness failed: ${err.message}`);
        return null;
      }
      const pick = await pickStuckOutcome(rows);
      if (!pick) return null;
      // Deficit for the stuckness floor = how many cycles past its threshold
      // the outcome has been stuck. Always >= 0 because pickStuckOutcome only
      // returns fired outcomes; we floor at 1 so a just-fired outcome still
      // wins against an inert spec floor at deficit 0.
      const deficit = Math.max(1, (pick.cyclesStuck ?? 0) - (pick.threshold ?? 0));
      return {
        deficit,
        share: 0, // Realised share is computed at the dispatcher level.
        targetShare: cfg.selfImprovement.targetShare,
        payload: { row: pick },
      };
    },
    async buildAnchor(payload, eventBus) {
      return await buildStucknessAnchor(payload.row, eventBus);
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Run every floor's `prepare()` step, pick at most one to fire, and return
 * the resulting anchor. The losing floor (if any) is notified via
 * `onPassedOver()` so it can update its own instrumentation.
 *
 * Returns `{anchor: null, firedFloor: null, evaluations: [...]}` when no
 * floor is ready — the selector then falls through to the normal priority
 * chain.
 *
 * Fail-soft: any floor whose `prepare()` throws is logged and skipped; the
 * dispatcher does not abort. This matches the pre-refactor behaviour where
 * stuckness errors fell through to the kanban path.
 */
export async function dispatchCapacityFloor(
  floors: FloorDecl<any>[],
  eventBus: any = null,
): Promise<DispatchResult> {
  // Evaluate readiness in parallel — every prepare() is read-only and cheap.
  const results = await Promise.all(
    floors.map(async (f) => {
      try {
        const r = await f.prepare();
        return { floor: f, readiness: r };
      } catch (err: any) {
        console.error(`[capacity-floors] floor "${f.name}" prepare() failed: ${err.message}`);
        return { floor: f, readiness: null };
      }
    }),
  );

  const evaluations = results.map(({ floor, readiness }) => ({
    name: floor.name,
    deficit: readiness?.deficit ?? 0,
    share: readiness?.share ?? 0,
    targetShare: readiness?.targetShare ?? 0,
    ready: !!readiness && readiness.deficit > 0,
  }));

  const ready = results.filter(
    (r): r is { floor: FloorDecl<any>; readiness: FloorReadiness<unknown> } =>
      !!r.readiness && r.readiness.deficit > 0,
  );

  if (ready.length === 0) {
    return { anchor: null, firedFloor: null, evaluations };
  }

  // Pick winner: highest deficit, ties broken by declared priority (lower
  // priority value wins). This is deterministic across cycles.
  ready.sort((a, b) => {
    if (b.readiness.deficit !== a.readiness.deficit) {
      return b.readiness.deficit - a.readiness.deficit;
    }
    return a.floor.priority - b.floor.priority;
  });
  const winner = ready[0];
  const losers = ready.slice(1);

  // Notify losers BEFORE building the winning anchor so a slow buildAnchor
  // doesn't suppress the metrics write.
  for (const l of losers) {
    if (l.floor.onPassedOver) {
      try {
        await l.floor.onPassedOver(`${winner.floor.name}_won`);
      } catch (err: any) {
        console.error(`[capacity-floors] floor "${l.floor.name}" onPassedOver failed: ${err.message}`);
      }
    }
  }

  const anchor = await winner.floor.buildAnchor(winner.readiness.payload, eventBus);
  console.log(
    `[capacity-floors] fired floor "${winner.floor.name}" ` +
    `(deficit=${winner.readiness.deficit}, ` +
    `evaluations=${JSON.stringify(evaluations)})`,
  );
  return { anchor, firedFloor: winner.floor.name, evaluations };
}

/**
 * Convenience constructor: build the default-config dispatcher with the
 * stock floor. The selector uses this; tests can substitute custom floors
 * via `dispatchCapacityFloor()` directly.
 */
export function defaultCapacityFloors(env: NodeJS.ProcessEnv = process.env): FloorDecl<any>[] {
  const cfg = loadCapacityFloorsConfig(env);
  return [stucknessFloorDecl(cfg)];
}

// ---------------------------------------------------------------------------
// Realised-share metrics
// ---------------------------------------------------------------------------

/**
 * Aggregate the realised share of recent cycles per floor. The dispatcher
 * doesn't write a dedicated history list — it reuses the existing
 * `capacity-floor.ts` cycle-side history (orchestrator vs target) for the
 * self-improvement floor. This avoids a new Redis write on every cycle for
 * a metric that's inherently approximate.
 */
export interface CapacityFloorsSnapshot {
  config: CapacityFloorsConfig;
  floors: Array<{
    name: string;
    targetShare: number;
    /** Realised share over `windowCycles`, or null when no data yet. */
    realisedShare: number | null;
    /** Optional human-readable details (e.g. cyclesSinceServed). */
    details: Record<string, unknown>;
  }>;
}

/**
 * Read the current capacity-floors state for the API surface. Combines the
 * self-improvement realised share from `capacity-floor.ts` (orchestrator
 * vs target cycles over the rolling window) with the declared config.
 *
 * This is intentionally a "thin aggregator over existing surfaces" — the
 * dispatcher already reads these on the hot path; the snapshot is read-only.
 */
export async function getCapacityFloorsSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CapacityFloorsSnapshot> {
  const cfg = loadCapacityFloorsConfig(env);

  // Imported inline to keep this module's import graph small for tests that
  // exercise the pure dispatcher without bringing in Redis-backed history.
  const { getSelfImprovementShare } = await import("../capacity-floor.ts");

  const selfImprovement = await getSelfImprovementShare(cfg.windowCycles).catch(
    (err: any) => {
      console.error(`[capacity-floors] selfImprovement share read failed: ${err.message}`);
      return null;
    },
  );

  return {
    config: cfg,
    floors: [
      {
        name: "self-improvement",
        targetShare: cfg.selfImprovement.targetShare,
        realisedShare: selfImprovement && selfImprovement.windowCount > 0
          ? selfImprovement.share
          : null,
        details: selfImprovement
          ? {
              orchestratorCount: selfImprovement.orchestratorCount,
              targetCount: selfImprovement.targetCount,
              idleCount: selfImprovement.idleCount,
              windowCount: selfImprovement.windowCount,
              floor: selfImprovement.floor,
              floorMet: selfImprovement.floorMet,
            }
          : {},
      },
    ],
  };
}
