// ---------------------------------------------------------------------------
// Builder-Health stagnation alert — proactive pattern-detection surface
// (issue #3290, epic #3285, ADR-0028; extracted from src/notify.ts into a
// focused notification leaf per issue #3303).
// ---------------------------------------------------------------------------
//
// The "before the operator notices" half of the Builder-Health Measurement
// Subsystem. The pure detector (`computeStagnation`, #3287) + per-realm panel
// (#3288) already fold each watched signal into an `ok | warming | breach`
// verdict on the scorecard. This emitter turns that verdict into an
// edge-triggered `builder-health.stagnation` notification: it fires EXACTLY
// ONCE when a signal transitions INTO `breach`, suppresses repeats while the
// signal stays breached, and re-arms once it leaves `breach`. A `warming`
// (cold-start) signal never fires — the whole point of the warming state is
// suppression.
//
// The edge is per-(signal, realm) key. The previous-state store is injected
// (`getPrevState` / `setPrevState`) so the heartbeat can back it with a
// process-lifetime in-memory map and tests can drive the transitions
// deterministically. This mirrors the review-pickup edge-trigger chore's
// armed-state seam (#745), scoped down to a plain state map since a single
// tick may fire several independent per-signal edges.
//
// Never throws — a malformed scorecard slot is skipped, and a publish failure
// is logged (fail-loud) but leaves the previous-state UNTOUCHED so the next
// tick re-evaluates the edge (better a re-attempt than a swallowed edge).
//
// This is a focused notification-domain leaf, sibling to `alert-grammar.ts`
// and `cycle-completed-reactor.ts` — NOT the Telegram transport (`../notify.ts`).
// Import direction is one-way: this module imports the aggregators' scorecard
// vocabulary; `src/scheduler/heartbeat.ts` (the only production caller) imports
// `emitStagnationAlerts` / `createInMemoryStagnationStore` from here.

import type { PublishableBus } from "../event-bus-seams.ts";
import type { BuilderHealthScorecard } from "../aggregators/builder-health.ts";
import type {
  StagnationSignalName,
  Realm,
} from "../aggregators/builder-health-stagnation-panel.ts";
import type { StagnationResult } from "../aggregators/builder-health-stagnation.ts";

/** The event-type string carried on the notifications stream for this alert. */
export const BUILDER_HEALTH_STAGNATION_EVENT = "builder-health.stagnation";

/**
 * The per-(signal, realm) previous verdict the edge-trigger compares against.
 * Only the coarse state matters for the edge — `null` means "never sampled".
 */
type StagnationAlertPrevState = "ok" | "warming" | "breach" | null;

/**
 * Injectable previous-state store for the edge-trigger. Keyed by
 * `${signal}:${realm}`. Defaults (in the heartbeat wiring) to a
 * process-lifetime in-memory map; tests inject a deterministic map.
 */
export interface StagnationAlertStateStore {
  get(key: string): StagnationAlertPrevState;
  set(key: string, state: StagnationAlertPrevState): void;
}

/** Injectable deps for {@link emitStagnationAlerts} (all optional). */
export interface EmitStagnationAlertsDeps {
  /** Previous-state store for the per-signal edge. Required by the caller. */
  store: StagnationAlertStateStore;
}

/** One fired alert, returned so the caller/tests can see what happened. */
export interface StagnationAlertFired {
  signal: StagnationSignalName;
  realm: Realm;
  current: number | null;
  baseline: number | null;
  sustainedCycles: number;
}

/**
 * A convenience in-memory {@link StagnationAlertStateStore} backed by a `Map`.
 * The heartbeat holds ONE of these for the process lifetime so the edge-trigger
 * dedupes across ticks (a bounce re-arms — acceptable for an MVP proactive
 * surface; cross-restart dedupe is a deliberate non-goal here).
 */
export function createInMemoryStagnationStore(): StagnationAlertStateStore {
  const map = new Map<string, StagnationAlertPrevState>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, state) => {
      map.set(key, state);
    },
  };
}

/**
 * The not-tier-adjusted caveat carried on every payload (ADR-0028 Decision 2):
 * the stagnation window's tier/backlog composition is exposed, never adjusted
 * out — a shifting cleanup-vs-feature mix is a reader's caveat.
 */
const NOT_TIER_ADJUSTED_CAVEAT =
  "Not tier-adjusted — the window's cleanup-vs-feature mix is exposed, not controlled for (ADR-0028).";

/**
 * Scan the scorecard's stagnation panel and emit a `builder-health.stagnation`
 * notification for each signal/realm that just transitioned INTO `breach`.
 *
 * Edge contract (issue #3290 acceptance criteria):
 *   - fire EXACTLY ONCE on the (ok | warming) -> breach transition per signal;
 *   - never fire while `warming` (cold-start suppression);
 *   - suppress repeats while the signal stays `breach`;
 *   - re-arm once the signal leaves `breach` (so a later re-breach fires again).
 *
 * @returns the alerts that fired this call (empty when nothing transitioned).
 */
export async function emitStagnationAlerts(
  scorecard: BuilderHealthScorecard | null | undefined,
  eventBus: PublishableBus,
  deps: EmitStagnationAlertsDeps,
): Promise<StagnationAlertFired[]> {
  const fired: StagnationAlertFired[] = [];
  const panel = scorecard?.stagnation;
  if (!panel || !panel.signals || typeof panel.signals !== "object") {
    return fired;
  }
  const store = deps.store;

  for (const [signalRaw, realms] of Object.entries(panel.signals)) {
    if (!realms || typeof realms !== "object") continue;
    const signal = signalRaw as StagnationSignalName;
    for (const realm of ["orch", "target"] as const satisfies readonly Realm[]) {
      const verdict = (realms as { orch?: StagnationResult | null; target?: StagnationResult | null })[realm];
      // A dark (null) block has no series — treat it as "unknown", which never
      // fires and never spuriously re-arms a real breach on the other realm.
      if (!verdict || typeof verdict !== "object") continue;
      const state = verdict.state;
      const key = `${signal}:${realm}`;
      const prev = store.get(key);

      if (state === "breach") {
        // Fire only on the edge INTO breach — a signal already breached last
        // tick is suppressed. (warming|ok|null) -> breach is the one edge.
        if (prev !== "breach") {
          const ok = await publishStagnationAlert(eventBus, signal, realm, verdict);
          if (ok) {
            // Only advance the armed-state on a successful publish, so a failed
            // send re-attempts the edge next tick rather than swallowing it.
            store.set(key, "breach");
            fired.push({
              signal,
              realm,
              current: verdict.current,
              baseline: verdict.baseline,
              sustainedCycles: verdict.sustainedCycles,
            });
          }
        }
        // prev === "breach": already alerted — suppress, state unchanged.
      } else {
        // ok | warming — record the (non-breach) state so the next breach is
        // seen as an edge. Warming never fires; it just re-arms.
        store.set(key, state === "warming" ? "warming" : "ok");
      }
    }
  }
  return fired;
}

async function publishStagnationAlert(
  eventBus: PublishableBus,
  signal: StagnationSignalName,
  realm: Realm,
  verdict: StagnationResult,
): Promise<boolean> {
  const current = verdict.current;
  const baseline = verdict.baseline;
  const sustained = verdict.sustainedCycles;
  const dir = current !== null && baseline !== null && current < baseline ? "below" : "above";
  const summary =
    `⚠️ Builder-health stagnation — *${signal}* (${realm}) has drifted ${dir} its own ` +
    `baseline and STAYED there for ${sustained} cycle${sustained === 1 ? "" : "s"}. ` +
    `Current ${fmtNum(current)} vs baseline ${fmtNum(baseline)}. ${NOT_TIER_ADJUSTED_CAVEAT}`;
  try {
    await eventBus.publish(BUILDER_HEALTH_STAGNATION_EVENT_STREAM, {
      type: BUILDER_HEALTH_STAGNATION_EVENT,
      source: "scheduler",
      correlationId: `builder-health-stagnation-${signal}-${realm}`,
      payload: {
        signal,
        realm,
        current,
        baseline,
        sustainedCycles: sustained,
        notTierAdjusted: true,
        summary,
      },
    });
    console.log(
      `[Notify] builder-health.stagnation fired — signal=${signal} realm=${realm} ` +
        `current=${fmtNum(current)} baseline=${fmtNum(baseline)} sustained=${sustained}`,
    );
    return true;
  } catch (err: any) {
    console.error(`[Notify] Failed to publish builder-health.stagnation (${signal}/${realm}):`, err?.message ?? err);
    return false;
  }
}

// The notifications stream key. Imported lazily-free (a plain string constant
// in `event-bus-stream-keys.ts`) to keep this module off the Redis-connection
// import path — but the value is fixed, so inline it as a named constant here
// rather than pulling the whole stream-keys map (which stays out of scope).
const BUILDER_HEALTH_STAGNATION_EVENT_STREAM = "hydra:notifications";

function fmtNum(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  // Keep it readable: integers stay integers, fractions round to 3 places.
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}
