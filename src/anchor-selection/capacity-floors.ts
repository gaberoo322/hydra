// ---------------------------------------------------------------------------
// Unified capacity-floor dispatcher (issue #321)
// ---------------------------------------------------------------------------
//
// Background
//   `selectAnchor()` historically grew three pre-emption mechanisms — the
//   spec capacity-floor (#301/#308, retired in #513), the stuckness-driven
//   self-improvement floor (#245 / ADR-0003 vision vector 1, retired in
//   ADR-0010), and the reframe-queue floor (#377). Each independently stole
//   cycles from kanban; they never saw each other's state. This dispatcher
//   was unified behind a single seam so future floors plug in cleanly without
//   reintroducing the stacking bug.
//
//   Today only the reframe floor remains. The scaffolding stays because
//   future floors (with non-stuckness triggers) can register here.
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

import {
  getCyclesSinceReframeServed,
  getReframeFloorN,
  recordReframePassedReason,
  recordReframeServed,
  DEFAULT_REFRAME_FLOOR_N,
  hasReframeCandidate,
  selectReframeAnchor,
} from "./reframe.ts";

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
  /** Reframe floor (issue #377) — pre-empt kanban every N cycles when the
   *  reframe queue has work. Cadence default 5. */
  reframe: { targetShare: number; cadenceN: number };
  /** Rolling window for realised-share computation. */
  windowCycles: number;
}

export const DEFAULT_CAPACITY_FLOORS_CONFIG: CapacityFloorsConfig = {
  reframe: { targetShare: 1 / 5, cadenceN: DEFAULT_REFRAME_FLOOR_N }, // issue #377
  windowCycles: 20,
};

/**
 * Build the runtime config from environment variables.
 */
export function loadCapacityFloorsConfig(env: NodeJS.ProcessEnv = process.env): CapacityFloorsConfig {
  const cfg: CapacityFloorsConfig = {
    reframe: { ...DEFAULT_CAPACITY_FLOORS_CONFIG.reframe },
    windowCycles: DEFAULT_CAPACITY_FLOORS_CONFIG.windowCycles,
  };

  // Reframe cadence (issue #377). Honours both the canonical name and the
  // alias that matches the (now-retired) spec floor's naming convention.
  const reframeFromEnv = parseIntSafe(env.HYDRA_REFRAME_FLOOR_N)
    ?? parseIntSafe(env.HYDRA_CAPACITY_FLOOR_REFRAME_N);
  if (reframeFromEnv !== null) cfg.reframe.cadenceN = reframeFromEnv;

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

interface ReframePayload {
  /** Empty — the reframe floor's buildAnchor consumes the queue head at fire
   *  time. The payload exists only to satisfy the FloorDecl generic. */
  marker: "reframe";
}

/**
 * Reframe-queue floor declaration (issue #377). When
 * `cyclesSinceReframeServed >= cadenceN` AND the reframe queue has a
 * candidate, pre-empt kanban with the next reframe item.
 *
 * Behaviour notes:
 *   - `prepare()` runs queue maintenance (idempotent) and checks for any
 *     candidate. Drift-duplicates are NOT excluded at prepare time; they
 *     surface as null returns from buildAnchor and the selector falls
 *     through to the regular priority chain.
 *   - `buildAnchor()` consumes the head item via the existing
 *     `selectReframeAnchor()` so we don't duplicate the prune+pop+drift
 *     logic.
 *   - When buildAnchor returns null (drift duplicate, corrupt item,
 *     concurrent drain), we record the actual outcome so starvation
 *     metrics still account for the cycle.
 */
export function reframeFloorDecl(
  cfg: CapacityFloorsConfig = DEFAULT_CAPACITY_FLOORS_CONFIG,
): FloorDecl<ReframePayload> {
  return {
    name: "reframe",
    priority: 1,
    async prepare(): Promise<FloorReadiness<ReframePayload> | null> {
      const [cyclesSinceServed, candidatePresent] = await Promise.all([
        getCyclesSinceReframeServed(),
        hasReframeCandidate(),
      ]);
      if (!candidatePresent) return null;
      // Respect both the config-resolved cadence and the env-var-only
      // reader so test setups that only set HYDRA_REFRAME_FLOOR_N keep
      // working in isolation.
      const cadence = cfg.reframe.cadenceN || getReframeFloorN();
      const deficit = cyclesSinceServed - cadence;
      return {
        deficit,
        share: cadence > 0 ? Math.min(1, 1 / Math.max(1, cyclesSinceServed + 1)) : 0,
        targetShare: cfg.reframe.targetShare,
        payload: { marker: "reframe" },
      };
    },
    async buildAnchor(_payload, _eventBus) {
      const anchor = await selectReframeAnchor();
      if (anchor) {
        await recordReframeServed();
        await recordReframePassedReason("force_floor");
        return anchor;
      }
      // Queue drained between prepare and buildAnchor, or head was a
      // drift duplicate / corrupt item. Record the outcome so the
      // starvation gauge stays honest — drift/corrupt are normal Redis
      // states, not floor-misfires. The dispatcher will return a null
      // anchor and the selector falls through to the regular chain.
      await recordReframePassedReason("drift_duplicate");
      return null;
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
 * dispatcher does not abort.
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
 * stock floors. The selector uses this; tests can substitute custom floors
 * via `dispatchCapacityFloor()` directly.
 */
export function defaultCapacityFloors(env: NodeJS.ProcessEnv = process.env): FloorDecl<any>[] {
  const cfg = loadCapacityFloorsConfig(env);
  return [reframeFloorDecl(cfg)];
}

// ---------------------------------------------------------------------------
// Realised-share metrics
// ---------------------------------------------------------------------------

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
 * Read the current capacity-floors state for the API surface.
 */
export async function getCapacityFloorsSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CapacityFloorsSnapshot> {
  const cfg = loadCapacityFloorsConfig(env);

  const { getReframeStarvationStats } = await import("./reframe.ts");

  const reframe = await getReframeStarvationStats().catch((err: any) => {
    console.error(`[capacity-floors] reframe starvation read failed: ${err.message}`);
    return null;
  });

  return {
    config: cfg,
    floors: [
      {
        name: "reframe",
        targetShare: cfg.reframe.targetShare,
        realisedShare: null, // Gauge-only.
        details: reframe
          ? {
              cadenceN: cfg.reframe.cadenceN,
              cyclesSinceServed: reframe.cyclesSinceServed,
              lastServedAt: reframe.lastServedAt,
              reasons: reframe.reasons,
            }
          : { cadenceN: cfg.reframe.cadenceN },
      },
    ],
  };
}
