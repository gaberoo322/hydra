/**
 * Autopilot-tick aggregator (issue #3114; extracted from `src/api/now-page.ts`).
 *
 * Now-page widget data — answers "what is the autopilot doing right now?".
 * Composes three injected sub-reads (scheduler status, current run, discriminated
 * lifecycle) into the {@link AutopilotTickResponse} the `/api/v2/now/autopilot-tick`
 * route ships.
 *
 * # Why a pure leaf
 *
 * Before #3114 this fan-out was inlined in the `/now/autopilot-tick` route
 * handler — a hand-rolled `Promise.allSettled` over three readers, three
 * per-source `console.error` blocks, response-body assembly, and its own
 * `try/catch` 500 — the structural outlier among the five Now-page routes (the
 * other four are thin adapters over pure aggregators). This leaf re-homes the
 * composition so the route becomes a thin `aggregatorRouteNoQuery` adapter like
 * its siblings, and the composition gains a zero-IO test seam.
 *
 * # Design contract — same as cost-burn.ts / service-strip.ts
 *
 *   - Pure aggregator. Every external touchpoint arrives through injected reader
 *     thunks in `deps`; the leaf never imports `getAutopilotStatusSnapshot` and
 *     never performs Redis/snapshot IO. The route owns which-reader-wins +
 *     the shared-snapshot memoization (issue #2673) and hands three resolved
 *     zero-arg thunks in — so the #2673 single-read invariant is preserved by
 *     the route sharing one memoized thunk across the three readers.
 *   - Never throws. Each rejected sub-read degrades via `settledOr` (issue
 *     #916 — the canonical degrade-and-log fold, fail-loud preserved) to a safe
 *     fallback; the aggregator itself never throws.
 *
 * # Load-bearing invariants
 *
 *   - `running` is autopilot **lifecycle** truth (issue #888) — NEVER derived
 *     from the scheduler housekeeping heartbeat (`sched.running`). The heartbeat
 *     is surfaced only as `lastTickAt`.
 */

import type {
  AutopilotTickResponse,
  AutopilotLifecyclePayload,
  AutopilotCurrentRunSchema,
} from "../schemas/now-page.ts";
import type { z } from "zod";
import { settledOr } from "./settle.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type AutopilotCurrentRun = z.infer<typeof AutopilotCurrentRunSchema>;

/**
 * Resolved reader thunks for the autopilot-tick fan-out. All three are
 * zero-arg and already defaulted/resolved by the route (issue #2673: the route
 * shares one memoized snapshot thunk by reference across the three so a single
 * request issues one `getAutopilotStatusSnapshot()` read). The leaf treats them
 * as opaque sub-reads under `Promise.allSettled`.
 */
export interface AutopilotTickDeps {
  /** Scheduler status projected to the shape the tick endpoint needs. */
  readSchedulerStatus: () => Promise<{
    running: boolean;
    lastTickAt: string | null;
  }>;
  /** Current autopilot run, or `null` when no run is `status: running`. */
  readCurrentRun: () => Promise<AutopilotCurrentRun | null>;
  /** Discriminated autopilot lifecycle state (issue #888) — the running truth. */
  readLifecycle: () => Promise<AutopilotLifecyclePayload>;
  /** Clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Compose the autopilot-tick response from the three injected readers.
 *
 * Fans the three sub-reads out under `Promise.allSettled`, degrades each
 * rejected slice via `settledOr` (fail-loud log preserved), then assembles the
 * body. `running` follows `lifecycle.state === "running"` (issue #888), never
 * the scheduler heartbeat.
 */
export async function getAutopilotTick(
  deps: AutopilotTickDeps,
): Promise<AutopilotTickResponse> {
  const clock = deps.now ?? (() => new Date());

  const [schedSettled, runSettled, lifecycleSettled] =
    await Promise.allSettled([
      deps.readSchedulerStatus(),
      deps.readCurrentRun(),
      deps.readLifecycle(),
    ]);

  const sched = settledOr(
    schedSettled,
    { running: false, lastTickAt: null },
    "autopilot-tick/scheduler-status",
  );
  const currentRun = settledOr(
    runSettled,
    null as AutopilotCurrentRun | null,
    "autopilot-tick/current-run",
  );
  const lifecycle = settledOr(
    lifecycleSettled,
    {
      state: "idle",
      runId: null,
      termReason: null,
      endedEpoch: null,
    } as AutopilotLifecyclePayload,
    "autopilot-tick/lifecycle",
  );

  return {
    // `running` is autopilot lifecycle truth (issue #888) — NOT the scheduler
    // housekeeping heartbeat (`sched.running`). The heartbeat is still surfaced
    // as `lastTickAt`.
    running: lifecycle.state === "running",
    lastTickAt: sched.lastTickAt,
    currentRun,
    lifecycle,
    generatedAt: clock().toISOString(),
  };
}
